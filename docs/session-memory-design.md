# Session Memory 设计方案

## 1. 现状

当前上下文系统的核心管线：

```
Agent 事件 → HubEventService.append()
               ├── 持久化 event/message/fileChange
               ├── context.recordContextItem()  → contextItem 表 + embedding
               └── context.appendShortTermBuffer()
                     │
                     ├── 缓冲 < 20条事件 / 2000 tokens → 不触发
                     └── 缓冲满了 → compressShortTerm(LLM)
                                      │
                                      └── LongTermSummary（纯文本，seq 有序链）
```

上下文快照构建（`buildSnapshot`）：
```
pinned items → recent 24 messages → vector recall → LongTermSummary chain
                                                         ↓
                                                   renderContextPrompt()
```

问题：
- `LongTermSummary` 是纯文本，"关键任务、决策、产出和未解决问题" 混在一起
- 无结构 → LLM 输出质量不稳定，信息密度低
- seq 递增链 → 多条摘要拼接后冗长，token 效率差

## 2. 目标

- 改造现有的 `compressShortTerm`，只改 LLM prompt 和存储格式
- 一套 LLM 调用，输出结构化 JSON，upsert 到一张表
- context snapshot 中替代 LongTermSummary，作为高质量结构化摘要
- **不暴露给前端，纯后端内部机制**（与 Claude Code 的 Session Memory 一致：由 Fork Agent 后台维护，用于 /resume 和压缩）

## 3. 方案：改造 compressShortTerm → buildSessionMemory

### 3.1 管线变化

```
改前：
  shortTermBuffer → compressShortTerm(LLM) → LongTermSummary（纯文本追加）

改后：
  shortTermBuffer → buildSessionMemory(LLM) → SessionMemory（结构化 upsert）
                                                   │
                                                   └── renderMemorySummary() → contextSnapshot.summary
```

**只有一次 LLM 调用**，触发条件不变。改动点：
1. LLM prompt：从"输出中文摘要"改为"输出结构化 JSON"
2. 存储：从 `LongTermSummary`（seq 追加）改为 `SessionMemory`（upsert 合并）
3. 加载：`buildSnapshot` 读 SessionMemory 渲染，替代 `loadSummaryChain`

### 3.2 数据模型

新增 `SessionMemory` 表（后续废弃 `LongTermSummary`）：

```prisma
model SessionMemory {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @unique @db.Uuid
  session     Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  title       String?            // 任务标题
  status      String?            // 当前进度
  files       Json               // [{path, description, changeType}]
  errors      Json               // [{message, solution, resolved}]
  lessons     String?            // 经验教训
  workLog     Json               // [{timestamp, summary}]

  version     Int      @default(1)
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())
}
```

### 3.3 LLM Prompt 改造

```diff
- 旧：
- "请用中文将以下 Agent 群聊记录压缩为简洁摘要（200字以内），
-  保留关键任务、决策、产出和未解决问题。"

+ 新：
+ "根据以下 Agent 工作记录，更新结构化工作笔记。输出 JSON（不要 markdown 包裹）：
+ {
+   \"title\": \"一句话任务标题\",
+   \"status\": \"当前进度状态\",
+   \"files\": [{\"path\": \"文件路径\", \"description\": \"变更说明\", \"changeType\": \"modified\"}],
+   \"errors\": [{\"message\": \"错误描述\", \"solution\": \"解决方式\", \"resolved\": false}],
+   \"lessons\": \"经验教训（无新内容则为 null）\",
+   \"workLog\": [{\"summary\": \"本轮工作摘要\"}]
+ }"
```

### 3.4 写入策略：upsert 合并

不再是 seq 递增追加，而是读出现有 record，合并后写回：

```
buildSessionMemory(sessionId):
  1. 短期缓冲文本 → LLM → 结构化 JSON
  2. 读出现有 SessionMemory record（如有）
  3. 合并：
     - title / status / lessons → 覆盖
     - files / errors → path/message 相同则更新，否则追加
     - workLog → 追加到头部，保留最近 20 条
  4. upsert 写回 DB
```

## 4. 上下文快照集成

`buildSnapshot()` 改动：

```diff
- const longTermSummaries = await this.loadSummaryChain(sessionId);
- const summaryText = longTermSummaries.map(s => s.content).join("\n");
+ const memory = await this.prisma.sessionMemory.findUnique({ where: { sessionId } });
+ const summaryText = memory ? renderMemorySummary(memory) : "";
```

`renderMemorySummary()` 将结构化数据渲染为纯文本：

```
任务：{title}
状态：{status}
涉及文件：
  - {path} ({changeType}): {description}
错误与解决：
  - {message} → {solution} {resolved ? "✅" : "⚠️ 未解决"}
经验：{lessons}
```

结构化约束让 LLM 输出更稳定，渲染后 < 500 tokens，始终在 snapshot 预算内。

## 5. 触发时机

保持现有机制不变：

| 条件 | 行为 |
|---|---|
| 缓冲事件数 ≥ 20 | 触发 LLM → buildSessionMemory |
| 缓冲 token ≥ 2000 | 触发 LLM → buildSessionMemory |
| 更新完成 | 重置短期缓冲 |

## 6. 重启时的记忆加载

```
buildSnapshot(sessionId):
  1. Session Memory                ← 当前状态摘要，体积小，始终加载
  2. Pinned context items          ← 用户置顶
  3. Recent 24 messages            ← 最近对话
  4. Vector retrieval (pgvector)   ← 语义召回
```

Session Memory 提供 situational awareness，历史细节由 context items + vector retrieval 补充。不再需要 LongTermSummary 链拼接。

## 7. 迁移

1. 新增 `SessionMemory` 表（保留 `LongTermSummary`，不删）
2. `compressShortTerm` → `buildSessionMemory`，改 prompt + 改存储
3. `buildSnapshot` 读 `SessionMemory` 替代 `loadSummaryChain`
4. 稳定后删除 `LongTermSummary` 表和相关代码

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `backend/prisma/schema.prisma` | 新增 SessionMemory 模型 |
| `shared/src/hub.ts` | 新增 SessionMemoryDto 类型 |
| `backend/.../services/context.service.ts` | compressShortTerm → buildSessionMemory；buildSnapshot 改读 SessionMemory |
