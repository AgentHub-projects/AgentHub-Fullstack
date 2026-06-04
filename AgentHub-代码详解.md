# AgentHub 代码详解

> 本文档基于实际代码逻辑分析，不依赖注释和文档。所有行为描述均直接从代码中推导。

---

## 1. 项目总览

### 1.1 项目定位

AgentHub 是一个**多 Agent 协作平台**。用户创建会话（群聊模式），添加 AI Agent 作为参与者，发送消息后由 Orchestrator（编排器）自动协调各 Agent 依次回复，类似微信群聊的多角色对话。

核心场景：

- 用户发起一个需求 → Orchestrator 分析任务 → 分派给 Frontend Agent / Backend Agent / Reviewer Agent → 各 Agent 依次产出代码、产物、文件变更
- 过程中支持产物预览（HTML/PDF/PPTX/图片）、代码 Diff 审查、沙箱文件编辑、Vercel 部署

### 1.2 技术栈

| 层    | 技术                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 包管理  | pnpm 10.0.0 (workspace monorepo)                                                                          |
| 共享类型 | TypeScript 纯类型包 `@agenthub/shared`                                                                        |
| 后端   | NestJS 11 (CommonJS), Express, Socket.IO 4.8, Prisma 6.8, PostgreSQL + pgvector, Redis (ioredis), 阿里云 OSS |
| 前端   | Next.js 15.3, React 19, Socket.IO Client 4.8, Ant Design 5.24 (已安装但代码中未使用)                                |
| 下游协议 | ACP (Agent Communication Protocol) over Socket.IO, JSON-RPC 2.0 格式                                        |

### 1.3 Monorepo 包结构

```
agenthub-fullstack/
├── shared/          @agenthub/shared  — 纯类型定义，无运行时依赖
├── backend/         @agenthub/backend  — NestJS 服务器，端口 3001
├── frontend/        @agenthub/frontend — Next.js 应用，端口 3000
├── docs/            — 设计文档和参考文档
└── examples/        — demo-data.json
```

**依赖关系**: `frontend` → `shared` ← `backend`（shared 是叶子包，两端各依赖它）

### 1.4 启动流程

```
# 开发模式（并行启动前后端）
pnpm dev
  → shared: tsc (不包含 dev 脚本)
  → backend: tsx watch src/main.ts (监听端口 3001)
  → frontend: next dev (监听端口 3000)

# 构建
pnpm build
  → shared: tsc -p tsconfig.json
  → backend: tsc -p tsconfig.build.json
  → frontend: next build
```

### 1.5 前端代理配置

前端 `next.config.ts` 将以下路径代理到后端：

```
/api/:path*       → http://localhost:3001/api/:path*
/socket.io/:path* → http://localhost:3001/socket.io/:path*
```

这意味着前端在开发环境不需要直接配置 API 地址，所有 `/api` 和 WebSocket 请求都被 Next.js 开发服务器转发到后端。

---

## 2. 核心数据模型 (Prisma Schema)

### 2.1 枚举类型 (8 个)

| 枚举                  | 值                                                                           | 用途          |
| ------------------- | --------------------------------------------------------------------------- | ----------- |
| `SessionStatusDb`   | active, archived, deleted                                                   | 会话生命周期      |
| `MessageRoleDb`     | user, assistant, agent, system, tool                                        | 消息角色        |
| `RunStatusDb`       | queued, context_building, connecting, running, completed, failed, cancelled | Agent 运行状态机 |
| `AgentStatusDb`     | enabled, disabled, offline, error                                           | Agent 实例状态  |
| `MessageStatusDb`   | queued, thinking, streaming, completed, failed, cancelled                   | 消息生成状态      |
| `ArtifactKindDb`    | markdown, text, html, pdf, docx, pptx, image, archive, log, other (10 种)    | 产物类型        |
| `StorageKindDb`     | inline_text, oss_object, remote_url                                         | 产物存储方式      |
| `FileChangeTypeDb`  | added, modified, deleted, renamed                                           | 文件变更类型      |
| `ContextItemKindDb` | message, artifact, file_change, run_summary, manual_pin                     | 上下文条目类型     |

### 2.2 数据表 (19 个)

#### Provider — LLM 提供者

```
id (自增主键), name (唯一), createdAt, updatedAt
```

最简单的表，仅存储 LLM 提供者的名称。

#### User — 用户

```
id (UUID), username (唯一), password_hash (scrypt), status, lastLoginAt, createdAt, updatedAt
```

用户认证。密码使用 `scrypt` 算法哈希，格式为 `"scrypt${salt}${hex}"`。

#### AgentTemplate — Agent 模板

```
id (自增), name, description, providerId (FK → Provider),
systemPrompt (长文本), promptConfig (JSON), defaultCapabilities (JSON),
defaultModelConfig (JSON), metadata (JSON), status (AgentStatusDb),
createdAt, updatedAt
```

模板定义了一个 Agent 的"蓝图"：系统提示词、工具能力、模型配置。一个模板可以实例化出多个 Agent。

关系：与 Agent 一对多，与 Provider 多对一。

#### BuildSession / BuildMessage — 构建器会话

```
BuildSession: id (UUID), status, context (JSON), agentTemplateId (FK → AgentTemplate, 可空), createdAt, updatedAt
BuildMessage: id (UUID), buildSessionId (FK → BuildSession), role, content, createdAt
```

用于 Agent 模板的对话式创建流程（Builder）。用户通过多轮对话描述想要的 Agent，LLM 收集信息后创建模板。

#### Agent — Agent 实例

```
id (自增), templateId (FK → AgentTemplate, 必填), name (唯一),
providerId (FK → Provider), description, isDefaultOrchestrator (bool),
status (AgentStatusDb), createdAt, updatedAt
```

模板的具体实例化。`isDefaultOrchestrator` 标记默认的编排器 Agent。

关系：与 SessionAgent 一对多（通过多对多关联表），与 Message、AgentRun、AgentEvent 一对多。

#### Session — 会话

```
id (UUID), title, status (SessionStatusDb), isPinned, projectId (FK → Project, 可空),
metadata (JSON), createdAt, updatedAt
```

核心实体。一个"对话"或"群聊"。metadata 存储运行时信息，如 `mode`（direct/group）、`orchestratorAgentId`、`memberAgentIds`、`sandboxWorkspace`、`latestSuccessfulPushCommitSha` 等。

关系：级联删除到 SessionAgent、Message、AgentRun、ContextSnapshot、AgentEvent、Artifact、FileChange、ContextItem、ContextEmbedding、ContextUpdateJob、LongTermSummary、Deployment。

#### Project — 项目

```
id (UUID), name, githubUrl, defaultBranch ("main"), status, metadata (JSON), createdAt, updatedAt
```

GitHub 项目绑定信息。metadata 中可能存储 `vercelProjectId`。

#### Deployment — 部署

```
id (UUID), sessionId (FK → Session), projectId (FK → Project),
triggerMessageId (FK → Message, 可空), commitSha, status,
deployServiceJobId, url, errorMessage, metadata (JSON),
createdAt, updatedAt, completedAt
```

Vercel 部署记录。通过 Vercel REST API 创建和追踪。

#### SessionAgent — 会话-代理关联表

```
sessionId + agentId (复合主键), participantRole ("member"/"orchestrator"/"direct"/"deleted"),
source ("mention"/"manual_add"/"default_orchestrator"/"manual_delete"), createdAt
```

多对多关联表，记录 Agent 在会话中的参与关系和角色。

#### Message — 消息

```
id (UUID), sessionId (FK → Session), runId (可空), role (MessageRoleDb),
agentId (FK → Agent, 可空), parentMessageId (自引用 FK, 可空),
contentText, contentJson (JSON), tokenCount, status (MessageStatusDb),
isPinned, createdAt, updatedAt
```

消息的 contentJson 存储结构化内容（`parts` 数组），contentText 存储纯文本摘要。

#### ContextSnapshot — 上下文快照

```
id (UUID), sessionId (FK → Session), runId (可空), version, tokenBudget,
tokenCount, selectedItemIds (数组), snapshotJson (JSON), promptText, createdAt
```

每次 Agent 运行前生成的上下文快照，记录当时选中的上下文条目和合成的 prompt 文本。

#### AgentRun — 运行记录

```
id (UUID), sessionId (FK → Session), orchestratorAgentId,
userMessageId (FK → Message, 可空), assistantMessageId (FK → Message, 可空),
contextSnapshotId (FK → ContextSnapshot, 可空), status (RunStatusDb),
downstreamSessionId, downstreamRunId, errorCode, errorMessage,
usageJson (JSON), startedAt, completedAt, createdAt, updatedAt
```

记录一次 Agent 编排运行的完整生命周期。

关系：级联删除到 AgentEvent、Artifact、FileChange。

#### AgentEvent — 代理事件

```
id (UUID), sessionId, runId (FK → AgentRun), seq (序号),
source, eventType, visibility ("public"/"private"),
speakerAgentId (FK → Agent, 可空), speakerName,
payload (JSON), occurredAt, persistedAt
```

从下游 Orchestrator 接收的结构化事件。复合唯一约束 `(runId, seq)` 保证幂等。

#### Artifact — 产物

```
id (UUID), sessionId, runId (FK → AgentRun, 可空),
producingEventId (可空), artifactKey (runId 内唯一),
kind (ArtifactKindDb), title, mimeType,
storageKind (StorageKindDb), storageUri, textContent,
sha256, sizeBytes (BigInt), version, final (bool),
metadata (JSON), createdAt, updatedAt
```

Agent 产出的文件/文档/图片等。每次更新 version 递增。

关系：与 ArtifactVersion 一对多（保留历史版本）。

#### FileChange — 文件变更

```
id (UUID), sessionId, runId, artifactId (可空), producingEventId (可空),
path, oldPath, changeType (FileChangeTypeDb), language,
beforeContent, beforeSha256, beforeTruncated,
afterContent, afterSha256, afterTruncated,
patch, stats (JSON), metadata (JSON), createdAt
```

记录 Agent 对文件的修改（类似 git diff），支持 apply 操作。

#### ContextItem — 上下文条目

```
id (UUID), sessionId (FK → Session), sourceType, sourceId,
kind (ContextItemKindDb), text, tokenCount, importance,
pinned, metadata (JSON), createdAt
```

在 Agent 上下文中使用的管理条目，由 HubContextService 管理和检索。

#### ContextEmbedding — 向量嵌入 (pgvector)

```
id (UUID), contextItemId (FK → ContextItem), model, embedding (1536 维向量), createdAt
(唯一约束: contextItemId + model)
```

存储上下文条目的向量嵌入，用于语义检索。使用 pgvector 的 cosine 距离（`<=>` 运算符）查询。

#### ContextUpdateJob — 上下文更新任务

```
id (UUID), sessionId, status (pending/running/completed/failed),
inputSnapshot (JSON), output, error, createdAt
```

追踪上下文压缩/更新的异步任务状态。

#### LongTermSummary — 长期摘要

```
id (UUID), sessionId, seq, content, tokenCount, createdAt
```

短期缓冲压缩后生成的长期摘要链，按 seq 排序还原完整记忆。

---

## 3. Shared 类型契约

`@agenthub/shared` 包是前端和后端之间的类型契约层。由三个源文件组成，通过 `index.ts` 统一导出。

### 3.1 hub.ts — 核心 DTO 和请求接口

定义了约 47 个类型，包括：

**字符串联合类型（用作枚举）**：

- `HubSessionStatus` — `"active" | "archived" | "deleted"`
- `HubRunStatus` — 7 种运行状态
- `HubMessageRole` — 5 种消息角色
- `HubEventType` — 18 种事件类型（从 `run.created` 到 `context.updated`）
- `HubArtifactKind` — 10 种产物类型
- `HubMessagePartType` — 8 种消息部件类型（text/code/image/file/link_preview/diff/artifact/deploy_status）

**核心 DTO**：

- `AgentTemplateDto` / `AgentInstanceDto` — Agent 模板和实例
- `HubSessionDto` — 会话（含 `isPinned`、`lastRun`、`metadata`）
- `SessionDetailDto` — 会话完整详情（含 messages、runs、events、artifacts、fileChanges、context）
- `HubMessageDto` — 消息（含 `parts: HubMessagePartDto[]`，从 contentJson 反序列化）
- `HubRunDto` — 运行记录
- `HubEventDto` — 事件（seq 用于去重排序）
- `HubArtifactDto` / `HubFileChangeDto` — 产物和文件变更
- `HubContextSnapshotDto` — 上下文快照

**请求/响应对象**：

- `CreateHubSessionRequest` — 支持 `mode: "direct"|"group"`，direct 模式一对一直聊，group 模式需指定 orchestrator 和 member 模板
- `SendHubMessageRequest` — 发送消息（含 mentionedAgentIds、references、attachments）
- `FrontendRealtimeEnvelope` — WebSocket 实时推送的标准化信封

### 3.2 downstream.ts — 下游协议类型

定义 AgentHub 后端与下游 Orchestrator 之间的通信契约：

- `DownstreamInitializeParams` — ACP 初始化参数
- `DownstreamPromptInput` — 发送给下游的 prompt（含 sessionId、runId、prompt 部件、mentionedAgentIds、orchestratorSystemPrompt、pins、memory、agents 列表等）
- `DownstreamPromptMemory` — 结构化记忆（summary + recent + retrieved）
- `DownstreamPromptMode` — `"bootstrap" | "incremental"`

### 3.3 builder.ts — 构建器类型

定义 Agent 模板构建器（对话式创建流程）的类型：

- 会话 CRUD：`BuildSessionDto`、`BuildSessionListItemDto`、`BuildMessageDto`
- 请求：`StartBuildRequest`、`SendBuildMessageRequest`、`ConfirmBuildRequest`
- 草稿模型：`BuildTemplateDraft`（含 name、description、systemPrompt、defaultProvider、tools）

---

## 4. 后端架构

### 4.1 入口与模块注册

#### main.ts — 启动引导

```
dotenv/config → reflect-metadata → NestFactory.create(AppModule) →
enableCors({ origin: true, credentials: true }) →
setGlobalPrefix("api") →
listen(127.0.0.1, PORT ?? 3001)
```

关键点：

- 调用 `dotenv/config` 将 `.env` 文件加载到 `process.env`
- CORS 完全开放（`origin: true` + `credentials: true`），适合本地开发
- 全局路由前缀 `/api`，所以所有控制器路由实际路径为 `/api/xxx`

#### AppModule → HubModule

`AppModule` 仅导入 `HubModule`，不做其他事情。所有功能集中在 `HubModule` 中。

#### HubModule — 功能注册中心

注册了 **12 个控制器** 和 **13 个提供者**：

控制器：

- `AuthController` — 认证
- `DownstreamController` — 下游代理接入（公开路由）
- `HubHealthController` — 健康检查
- `HubAgentController` — Agent 管理
- `HubArtifactController` — 产物查询
- `HubUploadController` — 文件上传
- `HubSessionController` — 会话核心 CRUD + 消息 + 部署
- `HubSandboxController` — 沙箱连接
- `SandboxCallbackController` — 沙箱文件变更回调（公开路由）
- `ProjectController` — 项目管理
- `BuilderController` — Agent 模板构建器
- `AgentTemplateController` — 模板 CRUD

关键提供者：

- `{ provide: APP_GUARD, useClass: AgentHubAuthGuard }` — 全局认证守卫
- `HubRealtimeGateway` — Socket.IO 实时网关
- 所有服务（见下文）

---

### 4.2 认证体系

#### 密码哈希 (auth.utils.ts)

使用 **scrypt** 算法：

```
hashPassword(password, salt?):
  salt = salt || crypto.randomBytes(16)
  key = scryptSync(password, salt, 64)  // 成本参数 N=2^14, r=8, p=1
  return "scrypt${salt.toString('hex')}${key.toString('hex')}"

verifyPassword(password, storedHash):
  解析 "scrypt{salt}{hash}" 格式
  重新 hash，使用 timingSafeEqual 常量时间比较
```

#### AuthSessionService — Redis 会话管理

使用 ioredis 连接到 `REDIS_URL`（默认 `redis://localhost:6379`）：

```
login(username, password):
  1. prisma.user.findUnique({ where: { username } })
  2. verifyPassword(password, user.passwordHash)
  3. 生成 32 字节随机 hex token
  4. redis.set("agenthub:session:{token}", JSON({ userId, username }), "EX", 604800)
  5. 更新 user.lastLoginAt
  6. 返回 { token, user }

authenticateCookie(cookieHeader):
  1. 从 Cookie 中提取 "agenthub_session" 的值
  2. redis.get("agenthub:session:{token}")
  3. 解析 JSON → 刷新 TTL (EXPIRE 604800)
  4. 返回 { userId, username } 或 null

logout(cookieHeader):
  redis.del("agenthub:session:{token}")
```

Redis 采用懒连接（`lazyConnect: true`），失败时静默处理错误。`maxRetriesPerRequest: 1` 防止阻塞。

#### AgentHubAuthGuard — 全局认证守卫

```
canActivate(context):
  1. 检查 @PublicRoute() 装饰器 → 如果是公开路由，直接放行
  2. 检查非 HTTP 上下文（WebSocket/RPC）→ 直接放行
  3. 检查路径是否以 /api/downstream/ 开头 → 直接放行（下游代理无需认证）
  4. authSessions.authenticateCookie(cookie) → 成功则放行
  5. 否则抛出 UnauthorizedException("AUTH_REQUIRED")
```

Cookie 名称为 `agenthub_session`，httponly，SameSite=lax，路径 `/`，有效期 7 天。

---

### 4.3 服务层 (13 个服务)

#### 4.3.1 PrismaService

继承 `PrismaClient`，实现 `OnModuleInit` 和 `OnModuleDestroy`：

```
onModuleInit():
  this.$connect()
  执行原始 SQL: CREATE EXTENSION IF NOT EXISTS pgcrypto
  执行原始 SQL: CREATE EXTENSION IF NOT EXISTS vector

onModuleDestroy():
  this.$disconnect()
```

自动在应用启动时创建 pgcrypto 和 pgvector 数据库扩展。

#### 4.3.2 AgentRegistryService — Agent 模板/实例管理

实现 `OnModuleInit` → `seedDefaults()` 初始化种子数据：

**种子数据（硬编码 ID）**：

- 4 个 Provider: "claude-code"、"open-code"
- 4 个模板: 主 Orchestrator (id=1)、Frontend Agent (id=2)、Backend Agent (id=3)、Review Agent (id=4)
- 4 个 Agent 实例: main-orchestrator (id=1, isDefaultOrchestrator=true)、frontend-agent (id=2)、backend-agent (id=3)、review-agent (id=4)

每个模板/Agent 都有详细的系统提示词和能力定义。

**关键方法**：

```
listAgents(): 按 isDefaultOrchestrator DESC, createdAt ASC 排序，排除 disabled 的 Agent

createAgentFromTemplate(sessionId, templateId, provider?, name?, participantRole?):
  1. 验证模板存在且未 disabled
  2. resolveProviderId（如果未指定则使用模板默认值）
  3. nextAgentName(baseName) 生成唯一名称（"Name 2", "Name 3"...）
  4. 创建 Agent 记录
  5. 创建 SessionAgent 关联
  6. 如果是 member 角色，追加到 session.metadata.memberAgentIds

deleteAgent(id):
  1. 禁止删除 orchestrator 或 direct 角色
  2. 软删除：Agent.status = "disabled"，SessionAgent.role = "deleted"
  3. 从 session.metadata 中移除 ID

syncAgentIdSequence():
  执行 SELECT setval('agents_id_seq', (SELECT MAX(id) FROM agents))
  防止手动设置 ID 后序列冲突
```

#### 4.3.3 AgentTemplateService — 模板 CRUD

```
create(input):
  resolveProviderId(input.defaultProvider)
  规范化 tools（去重，最多 12 个）
  创建 AgentTemplate，将 tools 同时写入 defaultCapabilities 和 promptConfig.tools

update(id, input):
  部分更新 name/description/provider/systemPrompt/tools

delete(id):
  软删除：status = "disabled"
```

#### 4.3.4 BuilderService — LLM 驱动的 Agent 模板构建器

通过多轮对话帮助用户创建 Agent 模板。配置 LLM：

```
API_KEY: process.env.SUMMARY_API_KEY
BASE_URL: process.env.SUMMARY_BASE_URL
MODEL: process.env.CONTEXT_SUMMARY_MODEL || "deepseek-chat"
```

**BUILDER_SYSTEM_PROMPT** — 硬编码的系统提示（约 100 行），指示 LLM 逐步收集 5 个字段：

1. 名称
2. 描述
3. 系统提示词
4. 工具列表
5. 模型提供者

LLM 回复格式为 JSON：

```
{
  "text": "对人说话的文本",
  "options": ["选项1", "选项2", ...],  // 供用户点击选择
  "draft": { name, description, systemPrompt, defaultProvider, tools }
}
```

**关键方法**：

```
startBuild(input):
  1. 创建 BuildSession + 第一条 user BuildMessage
  2. chatLLM() 获取初始回复
  3. 保存 assistant BuildMessage
  4. 返回 buildId + 两条消息

sendMessage(buildId, input):
  1. 验证会话 isActive
  2. 保存 user BuildMessage
  3. 构建对话历史
  4. chatLLM() 获取回复
  5. normalizeBuilderAssistantReply() 规范化回复
  6. extractContext() 提取收集到的字段
  7. 更新 BuildSession.context

confirmBuild(buildId, input):
  1. 验证会话 isActive
  2. templates.create(input) 创建 AgentTemplate
  3. 更新 BuildSession 状态为 "completed"

chatLLM(buildId, systemPrompt, messages):
  如果配置了 API_KEY + BASE_URL:
    POST {BASE_URL}/chat/completions, 非流式
  否则: mockReply() 模拟回复

mockReply(_buildId, messages):
  根据对话轮次逐步返回模拟回复:
    轮次 1-2: 问名称
    轮次 3-4: 问描述
    轮次 5-6: 问系统提示词
    轮次 7-8: 问工具
    轮次 9-10: 问提供者
    之后: 生成 draft
```

**导出的纯函数**：

- `parseBuilderAssistantContent(content)` — 解析 JSON 为 `{ text, options, draft }`
- `normalizeBuilderAssistantReply(content, messages)` — 如果有 draft，调用 `normalizeDraftForConversation` 丰富草稿
- `normalizeDraftForConversation(draft, messages)` — 检查描述/系统提示是否直接复用了用户选项，如果是则生成更详细的模拟版本

#### 4.3.5 HubSessionService — 会话核心编排

这是后端最大的服务之一（8 个注入依赖），负责会话的完整生命周期。

**依赖注入**: PrismaService, HubRealtimeGateway, HubContextService, HubEventService, DownstreamOrchestratorService, AgentRegistryService, DeploymentService, SandboxService

**创建会话**：

```
createSession(input):
  mode 为 "direct":
    → 创建 Session + 一个 direct 角色的 Agent
    → metadata: { mode: "direct", directAgentId }
  mode 为 "group":
    → 创建 Session + orchestrator Agent + 每个 member 模板的 Agent
    → metadata: { mode: "group", orchestratorAgentId, memberAgentIds }
```

**发送消息 — 核心流程**：

```
sendMessage(sessionId, input):
  1. 验证 content 非空、attachments < 6、references < 6
  2. assertSessionWritable (活跃 + 无运行中)
  3. parseDeploymentCommand(content) — 检测 "deploy"/"vercel"/"publish"/"上线"/"发布" 等关键词
  4. resolveSessionOrchestrator — direct 模式用 directAgentId，group 模式用 orchestratorAgentId
  5. resolveMentions — 检查文本和 mentionedAgentIds，解析 @提及的 Agent
  6. loadAttachmentParts — 从 DB 加载已上传的附件部件
  7. buildLinkPreviewParts — 从 URL 获取 Open Graph 元数据（最多 5 个）
  8. loadReferenceBlocks — 加载引用消息的内容
  9. 创建 Message (role: "user")，contentJson 包含 parts 数组
  10. recordContextItem — 记录上下文
  11. 创建 AgentRun (status: "queued")
  12. upsertSessionAgent — 将提及的 Agent 加入会话
  13. deriveTitle — 自动生成/更新会话标题
  14. 广播 session update
  15. 如果是部署命令:
    → deployment.start() 异步执行
    → 完成后标记 run 为 completed/failed
    → 返回
  16. 否则:
    → downstream.startRun() 异步执行
    → 返回 session + message + run DTO
```

**回复消息**：

```
regenerateFromMessage(sessionId, messageId):
  1. 找到触发目标消息的用户消息（userMessageId 或 role="user" 的前一条）
  2. 提取原始 content/references/attachments
  3. 使用相同参数调用 sendMessage()
```

**置顶消息/部件**：

```
pinMessage(sessionId, messageId, input):
  input.partId 存在 → context.setMessagePartPinned()
  否则 → context.setMessagePinned()
  触发 context.updated 事件 + 通知下游 pin 更新
```

**文件变更应用**：

```
applyFileChange(sessionId, fileChangeId):
  1. 验证文件变更存在且属于该会话
  2. downstream.applyFileChanges() — 通过 ACP 发送 file/apply_diff
  3. 触发 diff.apply.requested 事件
```

**辅助函数**：

- `deriveTitle(session)`: 从第一条用户消息的前 40 个字符生成标题
- `parseDeploymentCommand(content)`: 正则匹配 "deploy|vercel|publish|上线|发布|部署"
- `referencedPartText(part)`: 将部件序列化为可引用的文本

#### 4.3.6 HubContextService — 上下文管理

负责 Agent 运行时上下文的所有操作，包括 token 预算管理、短期缓冲压缩、向量嵌入和检索、以及快照构建。

**配置（环境变量）**：

```
CONTEXT_TOKEN_BUDGET: 9000（总预算）
CONTEXT_RECENT_TOKEN_BUDGET: 4800（近期消息预算）
CONTEXT_RETRIEVAL_LIMIT: 8（检索条数）
CONTEXT_EMBEDDING_MODEL: "text-embedding-3-small"
CONTEXT_SUMMARY_MODEL: 摘要模型
SUMMARY_API_KEY / SUMMARY_BASE_URL
```

**Token 估算**：

```
estimateTokens(text):
  return Math.max(1, Math.ceil(text.length / 4))
```

简单的字符/4 估算，不做真实 tokenization。

**短期缓冲压缩**：
内存中维护 `Map<sessionId, { events: string[], tokenCount: number }>`。

```
appendShortTermBuffer(sessionId, text):
  追加到 buffer
  如果 events.length >= 20 或 tokenCount >= 2000:
    compressShortTerm(sessionId, buffer) 触发压缩

compressShortTerm(sessionId, buffer):
  1. 连接所有事件文本
  2. invokeSummaryLLM(text) — 调用 LLM 做摘要（"用中文总结以下群聊记录（200 字以内）"）
  3. 如果 LLM 调用失败，回退到 text.slice(0, 4000)
  4. 创建 LongTermSummary 记录
  5. 重置缓冲区
```

**向量检索**：

```
recallByPgvector(sessionId, queryText, limit):
  1. createEmbedding(queryText) — 调用 embeddings API
  2. 原始 SQL: SELECT ci.* FROM context_items ci
     JOIN context_embeddings ce ON ce.context_item_id = ci.id
     WHERE ci.session_id = $1
     ORDER BY ce.embedding <=> $2::vector  -- cosine 距离
     LIMIT $3
  3. 如果 pgvector 不可用 → 词法搜索回退：
     - 分割查询词
     - 获取最近 80 条 context_items
     - 计算 TF 风格分数
     - 按分数排序取 top limit

persistEmbedding(contextItemId, sessionId, text):
  计算 embedding → INSERT INTO context_embeddings ON CONFLICT DO UPDATE
  静默吞下 pgvector 缺失的错误
```

**快照构建**：

```
buildSnapshot(input):
  1. 创建 ContextUpdateJob (status: running)
  2. 收集置顶项（最多 20 个 ContextItem where pinned=true）
  3. 收集近期消息（最后 24 条 Message）
  4. recallByPgvector 检索语义相关项
  5. loadSummaryChain 获取长期摘要
  6. selectWithinBudget — 在 token 预算内贪婪选择
  7. renderContextPrompt — 合成 prompt 文本
  8. 创建 ContextSnapshot 记录
  9. 更新 job 为 completed
```

`selectWithinBudget` 按顺序贪婪选择：优先置顶项 → 近期消息 → 检索结果 → 摘要，每个项目必须适配剩余预算且未被选中。

`renderContextPrompt` 构建的结构化提示：

```
## 会话摘要
...长期摘要

## 已提及的代理
...

## 置顶关键消息
...

## 最近对话
...

## 检索到的相关信息
...
```

#### 4.3.7 HubEventService — 事件处理核心

接收下游 Orchestrator 发来的事件，进行去重排序、持久化、并触发副作用（创建消息、文件变更、产物等）。

**内存状态**：

```
messageBuffers: Map<runId, Map<speakerKey, { messageId, contentText }>>
artifactPartBuffers: Map<runId, Map<speakerKey, HubMessagePartDto[]>>
runSeqWatermarks: Map<runId, number>
```

**事件接收**：

```
append(input):
  1. 检查 run 是否已被取消（对非 background/非 cancel 事件拒绝）
  2. 加载 speaker agent（从 speakerAgentId 查 DB）
  3. nextSeq(runId) 计算预期序号 = MAX(DB max seq, 内存 watermark) + 1
  4. 如果提供了 input.seq → 检查重复（同 seq 已存在 → 返回已有事件）
  5. message.delta 且 seq < expectedSeq 且服务器已有 → 接受为瞬态事件
  6. 如果 seq > expectedSeq → 抛出 EVENT_SEQ_OUT_OF_ORDER
  7. message.delta → 创建瞬态（不持久化）DTO → 应用副作用 → 标记水位线 → 返回
  8. file.change → 验证 payload（必须有 path 和 patch 或 before/after content）
  9. 持久化到 DB
  10. 应用副作用 → 标记 seq → 广播
```

**副作用调度 applySideEffects(event)**：

```
message.delta:
  → upsertMessageBuffer 追加文本到内存缓冲区
  → 通过 WebSocket 广播

message.completed:
  → persistCompletedMessage 将缓冲区持久化为 Message
  → 更新 AgentRun.assistantMessageId
  → 记录 context item

file.change:
  → 持久化 FileChange
  → 广播 file_change
  → 记录 context item

diff.apply.*:
  → 更新 FileChange 的 metadata（applyStatus/applyConflicts）
  → 广播

artifact.upsert:
  → ArtifactStorageService.upsertArtifact()
  → 广播 artifact
  → attachArtifactPart 追加到助手消息

artifact.chunk:
  → ArtifactStorageService.storeChunk()
  → 广播

artifact.complete:
  → ArtifactStorageService.completeArtifact()
  → 广播 + context item + 追加到消息

git.push.completed:
  → 更新 session.metadata (latestSuccessfulPushCommitSha, branch, remoteUrl, runId)
  → 广播 session update

run.completed / run.failed / run.cancelled:
  → 清理内存缓冲区（messageBuffers, artifactPartBuffers, runSeqWatermarks）
```

**瞬态事件处理**：
`message.delta` 事件被标记为 "瞬态" — 不立即持久化到 DB。它们通过 WebSocket 实时推送给前端，但在 `message.completed` 到来之前不作为 Message 记录。这减少了数据库写入，同时保持 UI 实时更新。

**Speaker 归属优先级**：

```
1. event.payload.speaker
2. event.payload.speakerAgentId
3. event.speakerAgentId
```

#### 4.3.8 AcpConnection — JSON-RPC 封装

基于 EventEmitter 的纯 JSON-RPC 2.0 客户端封装。不关心 ACP 会话语义，只提供基础原语。

```
构造函数(socket, timeoutMs = 3000):
  存储 socket（需有 emit/on/disconnect/connected 属性）
  分配递增 ID 计数器
  注册 "acp:message" 事件监听

request(method, params, timeoutMs?):
  id = this.nextId++
  创建 Promise + 超时定时器
  存储到 this.pending: Map<id, { resolve, reject, timer }>
  socket.emit("acp:message", { jsonrpc: "2.0", id, method, params })
  返回 Promise

respond(id, result):
  socket.emit("acp:message", { jsonrpc: "2.0", id, result })

respondError(id, code, message):
  socket.emit("acp:message", { jsonrpc: "2.0", id, error: { code, message } })

notify(method, params):
  socket.emit("acp:message", { jsonrpc: "2.0", method, params })  // 无 id

onNotification(handler):
  注册通知处理回调 → 返回清理函数

close():
  设置 closing = true
  socket.disconnect()
  rejectAll() — 拒绝所有待处理的 Promise

handleEnvelope(envelope):
  如果 envelope.id 匹配 pending 请求 → resolve/reject
  否则 → 转发给所有 notification handlers
```

#### 4.3.9 DownstreamOrchestratorService — 下游编排管理

最大的服务（约 1050 行），管理到下游 Orchestrator 的 Socket.IO 连接生命周期。

**状态**：`connections: Map<sessionId, ConnectionRecord>` — 按会话 ID 索引的连接。

**功能开关（环境变量）**：

```
DOWNSTREAM_ENABLE_SESSION_LOAD: 启用会话加载/恢复（默认关闭）
DOWNSTREAM_ENABLE_CONTEXT_DELTA: 启用上下文增量通知（默认关闭）
DOWNSTREAM_ENABLE_FILE_APPLY_DIFF: 启用文件 diff 应用（默认关闭）
```

**启动运行**：

```
startRun(input):
  1. 更新 AgentRun status = "connecting"
  2. 附加 run.status 事件
  3. 如果未配置 DOWNSTREAM_ORCHESTRATOR_WS_URL → simulateRun()（模拟模式）
  4. 否则:
    a. 如果启用 session load → 查找可重用的 downstreamSessionId
    b. ensureConnection() 建立 ACP 连接
    c. 如果是新会话 → createBootstrapSnapshot() 创建引导上下文快照
    d. buildPromptInput() 构建 prompt
    e. 发送 session/prompt 通知
    f. 更新 AgentRun status = "running"
    g. 附加 run.status 事件
  5. 错误时 → failRun()
```

**连接管理**：

```
ensureConnection(sessionId, downstreamUrl, agent, options):
  1. 如果已有连接 → 直接复用
  2. 创建 Socket.IO 客户端:
     io(downstreamUrl, {
       transports: ["websocket"],  // 仅 WebSocket，无 HTTP 长轮询
       reconnection: false          // 禁用自动重连
     })
  3. waitForSocket(socket) — 等待 connect 事件或 15 秒超时
  4. 创建 AcpConnection 实例
  5. 创建 ConnectionRecord（含 sessionId, socket, acp, 状态 Promise 等）
  6. 设置 disconnect 处理器:
     → 如果有 activeRun → recoverActiveRunAfterDisconnect
     → 否则 → closeConnection
  7. 发送 initialize 通知 (protocolVersion: "1", capabilities: {})
  8. 如果有 downstreamSessionId → 发送 session/load
     否则 → 发送 session/new
  9. 设置空闲断开计时器 (idleTimer)
```

**处理下游事件**：

```
handleDownstreamEvent(sessionId, envelope):
  如果 method === "session/update":
    提取 text 和 sessionUpdate
    如果 text 存在 → events.append(message.delta)
    如果 sessionUpdate === "agent_message_stop" → events.append(message.completed)
    发送回执（respond 或 respondError）

  如果 method === "session/event":
    提取 runId, eventType, payload
    检查 run 是否已取消
    events.append(event) → 处理副作用
    如果 run.completed → markRunCompleted()
    如果 run.failed → markRunFailed()
    发送回执
```

**断线恢复**：

```
recoverActiveRunAfterDisconnect(input):
  1. 重新 ensureConnection (带上 sessionId)
  2. readRecoveredRunStatus → 发送 run/status ACP 请求
  3. 根据下游返回状态:
    completed → markRunCompleted()
    failed → markRunFailed()
    running → 附加 "recovered" 状态事件，继续等待事件
```

**模拟模式**：

```
simulateRun(input):
  当 DOWNSTREAM_ORCHESTRATOR_WS_URL 未配置时使用
  生成模拟事件：run.status → member agent message.completed → file.change → artifact → run.completed
  使用硬编码的模拟数据（每个 Agent 返回预设的回复文本和代码示例）
```

#### 4.3.10 ArtifactStorageService — 产物存储

**存储方式**：

- `inline_text` — 文本直接存 DB 的 textContent 字段
- `oss_object` — 二进制/大文件上传到阿里云 OSS，存 storageUri
- `remote_url` — 外部 URL 引用

**OSS 上传**：

```
uploadToOss(sessionId, runId, artifactKey, data, mimeType):
  需要 ALIYUN_OSS_* 环境变量
  构建对象 key: {prefix}/{sessionId}/{runId}/{timestamp}-{safeKey}
  ossClient.put(key, data, { mime, headers })
  返回 { uri: "oss://{bucket}/{key}", sha256 } 或 null
```

**产物生命周期**：

```
upsertArtifact(input):
  根据 (runId, artifactKey) 查找或创建 Artifact
  binary: base64 解码 → uploadToOss → storageKind: "oss_object"
  inline_text: 直接存储到 textContent
  remote_url: 存储 storageUri
  递增 version 号
  记录 ArtifactVersion

storeChunk(input):
  增量追加模式 — 将文本追加到现有 artifact.textContent
  递增 version
  如果 artifact 不存在 → 回退到 upsertArtifact

completeArtifact(input):
  设置 artifact.final = true
  递增 version
```

**内容获取**：

```
getContent(artifactId):
  inline_text → 返回 body + Content-Type
  OSS → 返回 302 重定向到签名 URL（600 秒过期）
  其他 → 302 重定向到 storageUri
```

#### 4.3.11 DeploymentService — Vercel 部署管理

**配置**：

```
VERCEL_TOKEN: Vercel API 令牌
VERCEL_TEAM_ID: Vercel 团队 ID（可选）
VERCEL_DEPLOY_ENV_KEYS: 同步到 Vercel 的环境变量名（逗号分隔）
```

**部署流程**：

```
start(sessionId, _input):
  1. 验证：session 已绑定 project、有 commit sha、有 Vercel token
  2. 创建 system Message（"部署排队中"）
  3. 创建 Deployment 记录
  4. 异步 runDeployJob(deploymentId)

runDeployJob(deploymentId):
  1. parseGithubRepository(githubUrl) — 解析 GitHub 仓库 owner/repo
  2. ensureVercelProject — 查找或创建 Vercel 项目
  3. syncVercelEnv — 同步环境变量到 Vercel
  4. POST /v13/deployments:
     { name, gitSource: { type: "github", repo, ref } }
  5. 规范化状态 → updateDeployment
  6. pollJob 轮询

pollJob(deploymentId, vercelDeploymentId, startedAt):
  1. 检查超时：Date.now() - startedAt > 30 分钟 → markFailed
  2. GET /v13/deployments/:id → 获取 readyState
  3. READY → completed
  4. ERROR/CANCELED/DELETED → failed
  5. 其他 → running + setTimeout(3000) 持续轮询

syncDeploymentMessage(deploymentId):
  每次状态变更 → 更新 triggerMessage 的 contentJson (deploy_status 部件)
  → 广播 message update
```

#### 4.3.12 SandboxService — 沙箱编辑器集成

**令牌签发** (HMAC-SHA256)：

```
connect(sessionId, agentId):
  1. 验证 project 绑定 + 沙箱配置
  2. 验证 agent 在会话中
  3. 构建令牌 payload:
     { iss: "agenthub", typ: "sandbox", sub: agentId,
       sessionId, projectId, agentId, workspaceId, branch,
       iat, exp: now + 15min }
  4. signToken(payload) → "{base64url(json)}.{base64url(hmac)}"
  5. 缓存 workspaceId + branch 到 session.metadata
  6. 返回 { token, sandboxBaseUrl, workspaceId, branch }

signToken(payload):
  body = base64url(JSON.stringify(payload))
  signature = base64url(HMAC-SHA256(secret, body))
  return "{body}.{signature}"
```

**沙箱回调**：

```
recordFileChangeFromSandbox(input, authorization, callbackSecret):
  1. authenticateSandboxCallback — Bearer token 或共享密钥验证
  2. 验证 token scope 匹配 (sessionId, agentId, workspaceId)
  3. 创建新的 AgentRun
  4. events.append(file.change) — 将沙箱编辑作为文件变更事件
  5. events.append(run.completed) — 标记运行完成
  6. 缓存 workspace info 到 session.metadata
```

---

### 4.4 控制器层 (12 个控制器)

#### HubSessionController — 路由前缀 `sessions`

| 方法     | 路径                                     | 功能                               |
| ------ | -------------------------------------- | -------------------------------- |
| GET    | `/`                                    | 列出会话（支持 q 搜索 + includeArchived）  |
| POST   | `/`                                    | 创建会话                             |
| GET    | `/:sessionId`                          | 获取会话详情（含消息、运行、事件、产物、文件变更）        |
| GET    | `/:sessionId/diff-context`             | 获取 diff 上下文（baseRef、targetRef 等） |
| PATCH  | `/:sessionId`                          | 更新会话（标题/置顶）                      |
| POST   | `/:sessionId/archive`                  | 归档会话                             |
| DELETE | `/:sessionId`                          | 删除会话（软删除）                        |
| POST   | `/:sessionId/project`                  | 绑定/解绑项目                          |
| POST   | `/:sessionId/messages`                 | 发送消息                             |
| POST   | `/:sessionId/messages/:mid/pin`        | 置顶消息/部件                          |
| POST   | `/:sessionId/messages/:mid/regenerate` | 重新生成回复                           |
| POST   | `/:sessionId/participants`             | 添加参与者                            |
| POST   | `/:sessionId/runs/:rid/cancel`         | 取消运行                             |
| GET    | `/:sessionId/events`                   | 列出事件（最多 1000 条）                  |
| GET    | `/:sessionId/artifacts`                | 列出产物                             |
| GET    | `/:sessionId/file-changes`             | 列出文件变更                           |
| POST   | `/:sessionId/file-changes/:fid/apply`  | 应用文件变更                           |
| GET    | `/:sessionId/deployments/preflight`    | 部署预检                             |
| POST   | `/:sessionId/deployments`              | 发起部署                             |

#### 其他控制器

- **HubSandboxController**: `GET /sessions/:id/sandbox/agents` + `POST /sessions/:id/sandbox/connect`
- **HubAgentController**: `GET/POST /agents`, `GET /agents/:id/detail`, `PATCH/DELETE /agents/:id`
- **ProjectController**: `GET/POST /projects`, `PATCH/DELETE /projects/:id`
- **HubArtifactController**: `GET /artifacts/:id/content`, `GET /artifacts/:id/versions`
- **HubUploadController**: `POST /sessions/:id/uploads`, `GET /uploads/:id/content` (公开)
- **SandboxCallbackController**: `POST /sandbox/file-changes` (公开)
- **DownstreamController**: `GET /downstream/agents/:agentId/config` (公开)
- **AuthController**: `GET /auth/me`, `POST /auth/login`, `POST /auth/logout` (公开)
- **HubHealthController**: `GET /health` (公开)
- **BuilderController**: 构建器会话 CRUD (`/agent-templates/build`)
- **AgentTemplateController**: 模板 CRUD (`/agent-templates`)

---

### 4.5 WebSocket 网关 — HubRealtimeGateway

**配置**：

```typescript
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  path: "/socket.io"
})
```

**客户端连接管理**：

```
handleConnection(client):
  从 client.handshake.headers.cookie 提取 cookie
  authSessions.authenticateCookie(cookie)
  如果认证失败 → emit "auth.required" + disconnect
  如果认证成功 → emit "realtime.ready"
  追踪 client → sessions 映射

handleDisconnect(client):
  清理 clientSessions 追踪
  递减 sessionSubscriberCounts
```

**房间订阅**：

```
session.subscribe(client, { sessionId }):
  client.join("session:{sessionId}")
  追踪订阅
  emit "session.subscribed"

session.unsubscribe(client, { sessionId }):
  client.leave("session:{sessionId}")
  清理追踪
```

**广播方法**：

```
emitEvent(event) → to("session:{sessionId}").emit("hub:event", ...) + emit("run.event", ...)
emitSession(session) → emit("hub:session", ...)
emitMessage(message) → emit("hub:message", ...)
emitArtifact(sessionId, artifact) → emit("hub:artifact", ...)
emitFileChange(sessionId, fileChange) → emit("hub:file_change", ...)
emitContext(sessionId, context) → emit("hub:context", ...)
```

**订阅者查询**：

```
hasSessionSubscribers(sessionId): boolean
```

供 DownstreamOrchestratorService 查询房间是否有活跃监听器，避免无意义的广播。

---

### 4.6 映射器 — hub.mappers.ts

将 Prisma 返回的原始数据库行（Record<string, any>）转换为类型化的 DTO。所有映射器都是纯函数。

关键映射器：

- `mapSession(row)` — 从 `row.metadata` 和 `row.runs[0]` 提取 `isPinned` 和 `lastRun`
- `mapMessage(row)` — 调用 `messageParts()` 从 contentJson 反序列化 `parts` 数组
- `mapAgent(row)` — 从 `row.template.capabilities` 读取能力列表
- `mapEvent(row)` — BigInt seq 转 Number
- `mapArtifact(row)` — BigInt sizeBytes 转 Number

`messageParts(contentJson, contentText)` 核心逻辑：

```
1. 如果 contentJson.parts 存在 → 从数组中提取，逐个 normalizeMessagePart
2. 否则 → 回退为单个文本部件 { id: "part_1", type: "text", text: contentText }
```

---

### 4.7 工具函数

#### message-parts.ts

```
parseMessageParts(contentText):
  用正则扫描代码围栏 (```...```)
  代码块作为 "code" 类型部件
  其余作为 "text" 类型部件

buildLinkPreviewParts(contentText):
  提取 URL（最多 5 个）
  对每个 URL: fetch + 解析 <meta og:title/og:description>
  每个创建 "link_preview" 部件
  3 秒超时

messageJsonWithParts(base, contentText, extraParts):
  合并 parseMessageParts 结果 + base.parts + extraParts
  去重
```

#### downstream-orchestrator.utils.ts

```
waitForSocket(socket):
  Promise.race([
    new Promise(resolve => socket.once("connect", resolve)),
    new Promise((_, reject) => socket.once("connect_error", reject)),
    new Promise((_, reject) => setTimeout(reject, 15000))
  ])
```

---

## 5. 前端架构

### 5.1 入口与布局

#### layout.tsx

纯 HTML 骨架：

```tsx
<html lang="zh-CN">
  <body>{children}</body>
</html>
```

导入两个全局样式表：`globals.css` 和 `workbench/workbench.css`。

#### page.tsx — WorkbenchPage（2397 行）

整个应用的主入口。"use client" 组件，包含 47 个 useState 声明、10 个 useEffect、约 25 个业务逻辑函数。

**初始化流程**：

```
useEffect(() => { checkAuth() }, [])

checkAuth():
  getAuthState() → 如果未认证 → 展示登录表单
  如果已认证 → bootstrap()

bootstrap():
  并行调用:
    listAgents()
    listAgentTemplates()
    listSessions()
    listProjects()
  加载第一个 session（如果有）
```

**WebSocket 连接**：

```
useEffect(() => {
  if (!openSessionIds.length) return
  const cleanup = connectHubSocket(openSessionIds, {
    onEvent: (envelope) => { 更新 workspace detail.events }
    onSession: (envelope) => { 更新 workspace detail.session }
    onMessage: (envelope) => { 更新 workspace detail.messages }
    onArtifact: (envelope) => { 更新 workspace detail.artifacts }
    onFileChange: (envelope) => { 更新 workspace detail.fileChanges }
  })
  return cleanup  // 组件卸载时断开连接
}, [openSessionIds])
```

**消息发送**：

```
handleSend():
  1. 如果无内容且无附件 → return
  2. 构建 SendHubMessageRequest:
    - content: composer 文本
    - mentionedAgentIds: 从 @提及解析
    - parentMessageId: 当前回复目标
    - references: 构建引用列表
    - attachments: 上传的附件 ID
  3. sendSessionMessage(activeSessionId, request)
  4. 更新 workspace detail（追加消息和运行）
  5. 清空 composer
  6. 刷新 session 列表
```

**Workspace 状态管理**：
每个打开的 session 维护一个 workspace 对象：

```
workspaces: Map<sessionId, {
  detail: SessionDetailDto | null
  composer: string
  attachments: UploadedAttachmentDto[]
  replyTargets: { messageId, partId? }[]
  inspectorTab: "files" | "diff" | "artifacts"
}>
```

**47 个状态变量分类**：

- 认证状态：authChecked, authenticated, authUsername, authPassword, authError, authSubmitting
- 数据列表：sessions, projects, agents, templates
- UI 状态：sessionSearch, mentionMatch, activeMentionIndex, sending, cancellingRunId
- 弹窗控制：groupDialogOpen, projectDialogOpen, editDialogOpen, inviteDialogOpen, deleteConfirmOpen, contextMenu
- 表单草稿：projectNameDraft, projectGithubUrlDraft, createMode, directTemplateId, groupTitle, orchTemplateId, memberTemplates
- 布局：inspectorCollapsed, sessionRailCollapsed, openedFilePath
- 产物查看器：activeArtifactViewerId, activePartViewer

**UI 结构（三栏布局）**：

```
<div className="agenthubShell">
  <aside className="sessionRail">    <!-- 300px -->
    - 搜索框
    - Session 列表
    - 项目绑定器
    - 群组成员摘要
    - 新建会话按钮
  </aside>

  <section className="conversationPane">  <!-- 1fr -->
    - 会话头部（标题/重命名/部署按钮）
    - 置顶关键消息区
    - 时间线（ConversationItems: 消息 + RunThread）
    - 底部编辑区（文本框/@提及菜单/文件上传/发送按钮）
  </section>

  <aside className="inspector">  <!-- 360px -->
    - Tab: 文件(沙箱编辑)/Diff/产物
    - 可折叠到 56px
  </aside>
</div>
```

---

### 5.2 Workbench 子组件

#### timeline.tsx — 消息时间线

导出三个组件：

**TimelineMessage**：

- `message.role === "user"` → `<UserMessage>`（显示 "你"、时间、Pin/Reply/Regenerate/Copy 按钮）
- 否则 → `<AgentReplyBlock>`（Agent 头像+名称、回复内容、状态标签）

**RunThread**：

- 接收 run + events + fileChanges + artifacts + messages
- 判断持久化回复 vs 实时流式块：
  - 非 running 且有 assistant message → `messageToReplyBlock`
  - 否则 → `buildAgentReplyBlocks(events)` 实时构建流式块
- 渲染：
  - `<RunOutputLinks>` — 如果有 fileChanges 或 artifacts，显示打开 Diff/Artifacts 面板的按钮
  - `<RunStatusPill>` — 正在运行时显示动画进度条 + 阶段标签 + 实时计时器（setInterval 1000ms）
  - `<RunFailureBlock>` — 失败时显示错误信息

**RunBadge**：运行状态图标（LoadingOutlined/CheckCircleFilled/CloseCircleFilled）

#### inspector.tsx — 右侧检查面板

**DiffPanel**：

- 管理 selectedId 和 expandedFileIds 状态
- 显示 `<DiffBranchContext>`（baseRef → targetRef + 项目信息）
- 文件列表（路径、增减行数统计、应用按钮）
- 每文件展开后：`<UnifiedDiffView>` → `<UnifiedDiffLines>`
- `<UnifiedDiffLines>`: 将 diff 行按 hunk (`@@` 标记) 分组，每组可折叠
- 应用操作：`handleApplyFileChange(change)` → API 调用 → 更新元数据

**FilePanel**（沙箱文件编辑器）：

- 状态：agents, selectedAgentId, connection, treeItems, file, draft, loading
- 流程：`listSandboxAgents()` → 选择 Agent → `connectSandbox()` → `listSandboxTree()` → 浏览文件树 → `readSandboxFile()` → 编辑 draft → `saveSandboxFile()`
- 使用 `requestSandboxJson` 认证（Bearer token + sandboxBaseUrl）
- 显示：Agent 选择器、目录面包屑、文件树、代码编辑器、保存按钮

**ArtifactPanel**：

- 产物列表（图标、标题、类型、版本、操作按钮）
- 展开 → `<ArtifactViewerLayer>`（全屏覆盖层，支持预览/代码两种模式，版本切换）
- 预览模式分发：image → `<img>`，pdf/html → `<iframe>`，docx/pptx → Office Online 嵌入或幻灯片分页预览，默认 → `<RichText>`

**ArtifactViewerLayer**：

- 全屏覆盖层（背景点击关闭）
- 源码模式：textarea 编辑器，支持 "引用选区" 和 "引用修改继续对话"
- 预览模式：`<ArtifactPreview>` 按类型分发
- 版本历史栏：加载 `listArtifactVersions`，版本选择器

**InlineDiff / InlineArtifact**：在时间线中嵌入 diff/artifact 预览。

#### rich-text.tsx — 富文本渲染

**RichText**：

- 输入文本 → `parseMarkdownBlocks(text)` → 逐块渲染
- 块类型分发：heading (h2/h3), code, ul, ol, quote, table, paragraph

**MessageParts**：

- 如果无 parts → `<RichText text={fallbackText}>`
- 否则遍历 parts，按类型分发：
  - `text` → `<RichText>`
  - `code` → `<CodeBlock>`（折叠的 `<details>` 元素，含语言标签、行数、Copy/Pin/Reference 按钮）
  - `deploy_status` → `<DeployStatusPart>`（状态图标 + 详情）
  - `link_preview` → `<LinkPreviewPart>`（标题 + 描述 + URL）
  - `image` → `<ImagePart>`（img 标签）
  - `file` → `<FilePart>`（MIME 类型 + 大小）
  - `diff` → `<DiffPart>`（路径 + changeType + patch，链接到右侧面板）
  - `artifact` → `<ArtifactPart>`（artifactId，链接到查看器）
  - 未知类型 → 通用 card 展示

**CodeBlock** 的关键交互：
所有操作按钮都调用 `handleSummaryAction()` → `event.preventDefault()` + `event.stopPropagation()` → 防止 `<details>` 元素被关闭。

**MessagePartViewerLayer**：
全屏查看器，按类型分发详细预览：

- image → `<img>` 或 fallback text
- file → 图片预览（image mime）/ iframe（pdf/html）/ pre（文本）
- diff → 解析 unified patch 或构建 before/after 对比
- link_preview → 详情卡片
- deploy_status → 状态详情
- code → pre 代码块

---

### 5.3 Lib 工具模块

#### agenthub-api.ts — API 客户端（481 行）

**核心请求函数**：

```
requestJson<T>(path, init?):
  URL: API_BASE_URL + path (默认 "http://localhost:3001/api")
  credentials: "include"
  Content-Type: application/json
  返回 ApiResult<T> = { ok: true, data } | { ok: false, error }

requestSandboxJson<T>(connection, path, init?):
  URL: connection.sandboxBaseUrl + path
  Authorization: Bearer {connection.token}
```

**认证**：3 个函数（getAuthState, loginWithCredentials, logoutAuthSession）
**会话**：10 个函数（CRUD + 消息 + 上传）
**消息**：2 个函数（pin, regenerate）
**运行**：1 个函数（cancel）
**文件变更**：1 个函数（apply）
**沙箱**：5 个函数（agents, connect, tree, read, save）
**部署**：2 个函数（start, preflight）
**Agent**：4 个函数（list, create, update, delete）
**模板**：4 个函数（list, create, update, delete）
**构建器**：6 个函数（list, start, send, confirm, getSession, getMessages）
**项目**：4 个函数（list, create, update, delete）
**产物**：2 个函数（contentUrl, listVersions）

**WebSocket 连接**：

```
connectHubSocket(sessionIds, handlers):
  io({
    path: "/socket.io",
    transports: ["websocket", "polling"],  // 先 WebSocket，回退到轮询
    reconnectionAttempts: 5,
    withCredentials: true
  })

  连接成功 → 对每个 sessionId emit "session.subscribe"

  监听事件:
    hub:event → handlers.onEvent(envelope)
    hub:session → handlers.onSession(envelope)
    hub:message → handlers.onMessage(envelope)
    hub:artifact → handlers.onArtifact(envelope)
    hub:file_change → handlers.onFileChange(envelope)

  连接错误 → handlers.onState("unavailable")

  返回 cleanup 函数（断开 socket）
```

#### workbench/diff.ts — 文本对比

```
buildFileTreeRows(changes):
  将扁平的 HubFileChangeDto[] 转为层级 FileTreeRow[]
  自动创建中间目录行，按路径排序
  识别文件类型变更

buildDiffLines(change):
  如果有 patch → parseUnifiedPatch(patch)
  否则 → diffText(beforeContent, afterContent)

parseUnifiedPatch(patch):
  逐行解析 git unified diff 格式:
    @@ -old,count +new,count @@ → meta 行
    ---, +++, diff --git, index → meta 行
    + 开头 → add 行
    - 开头 → remove 行
    \ No newline → meta 行
    其他 → context 行

diffText(before, after):
  LCS (Longest Common Subsequence) 算法, DP 矩阵方法
  如果 before.length * after.length > 20000 → 回退到 naive 方法
  根据 LCS 结果生成 add/remove/context DiffLine 序列
```

**LCS 算法细节**：
构建 `(before.length + 1) x (after.length + 1)` 的 DP 矩阵，回溯路径生成 diff 行。
性能保护：行数乘积超过 20000 时直接返回 "全部删除 before 行 + 全部添加 after 行"。

#### workbench/markdown.ts — Markdown 解析器

自实现的简易 Markdown 解析器（不依赖 remark/marked 等外部库）：

```
parseMarkdownBlocks(text):
  按行分割
  逐行识别:
    代码围栏: ```lang ... ```      → code 块
    标题: # ~ ####                 → heading 块
    引用: > ...                    → quote 块
    表格: |...|\n|---|...          → table 块
    无序列表: - / *
    有序列表: 1. 2. ...
    其他连续行                      → paragraph 块
```

表格检测：检查 separator 行是否包含 `:---:` 模式。
列表合并：连续的列表行合并为一个块。
段落合并：多行文本用空格连接，遇到空行或另一个块类型时结束。

#### workbench/mentions.ts — @提及处理

```
findActiveMention(text, caret):
  从光标位置向前找最后一个 @
  确保 @ 前是空格或行首
  确保查询字符串是字母/数字/下划线/连字符
  返回 { start, end, query } 或 null

filterMentionCandidates(agents, query):
  按 agent.name 或 agent.id 前缀匹配过滤

filterInviteTemplates(templates, query):
  fuzzyIncludes 多 token 匹配 name/description/id
  fuzzyIncludes: 逐个字符子序列匹配 ("frt" 匹配 "frontend")

parseMentionedAgentIds(text, agents):
  提取所有 @name 或 @id 模式
  返回匹配的 Agent ID 列表
```

#### workbench/timeline.ts — 对话构建

```
buildConversationItems(detail):
  1. 排序 messages, runs, events, fileChanges, artifacts
  2. 按 runId 分组 events, fileChanges, artifacts
  3. 跳过已附加到消息 parts 的 artifact（attachedMessageArtifactIds）
  4. 每个 run:
    - 查找关联的 user message
    - 收集 run 的消息、events、fileChanges、artifacts
    - 只有有内容或 running/failed 的 run 才显示
  5. 添加未被任何 run 认领的 standalone messages
  6. 全部排序 → ConversationItem[]

buildAgentReplyBlocks(events, agents):
  处理 message.delta 事件（过滤非 public 可见性）
  相同 speaker 的连续 delta 合并（除非 append === false）
  返回 AgentReplyBlockModel[]

runStageLabel(run, events):
  根据 run.status 和最新 event 类型返回中文阶段描述:
    queued → "等待调度"
    context_building → "准备资料"
    connecting → "连接 Orchestrator"
    running → 检查 event 类型 ("正在思考"/"正在生成回复"/"调用工具"/...)
```

#### workbench/format.ts — 格式化与排序

**格式化函数**：

- `formatElapsed(seconds)` → "Xs" 或 "Xm Ys"
- `formatTime(value)` → zh-CN 小时:分钟
- `initials(name)` → 前 2 个大写字符
- `agentColor(seed)` → hash 算法从 6 色调色板取色

**文件变更状态**：

- `fileChangeApplyStatus(change)` → "queued"|"applied"|"failed"|"conflict"
- 从 change.metadata.applyStatus 读取

**会话解析**：

- `isRunning(status)` → 状态为 queued/context_building/connecting/running
- `sessionMode(session)` → metadata.mode 或 directAgentId 判断
- `buildGroupTitle(templateIds, templates)` → 从模板名生成群组标题

**排序函数**（全部 sort 函数族）：按时间戳排序，pinned 优先。

#### workbench/session-tabs.ts — Tab 状态管理

纯状态管理（Reducer 风格，无 React 状态）：

```
SessionTabsState { openIds, activeId, unreadIds }

openSessionTab(state, sessionId)    → 加入 openIds
activateSessionTab(state, sessionId) → 打开 + 设为 active + 清除 unread
closeSessionTab(state, sessionId)   → 移除 + 切换 activeId + 清理 unread
markSessionTabUpdated(state, sessionId) → 非 active 的 open tab 标记 unread
```

#### workbench/artifact-preview.ts — 产物预览模式选择

```
chooseArtifactPreviewMode(artifact):
  image                              → "image"
  pdf                                → "pdf"
  html (textContent)                 → "html-inline"
  html (storageUri)                  → "html-url"
  docx (http/https URL)              → "docx-office"
  docx                               → "docx-fallback"
  pptx (metadata.slides)             → "pptx-slides"
  pptx (http/https URL)              → "pptx-office"
  pptx                               → "pptx-fallback"
  text                               → "text"
  storageUri                         → "uri"
  else                               → "empty"
```

### 5.4 Agent Template Builder 页面

独立页面 `/agent-templates/build`（426 行）。

**三栏布局**：

- 历史栏：构建会话列表 + 新建按钮
- 对话栏：用户/助手消息 + 选项卡片（用户可点击选择）+ 输入框
- 预览栏：模板草稿卡片（名称/提供者/工具/描述/系统提示词）+ 确认按钮

**状态机**：

```
新建 → startBuild(description) → 返回 options + text
用户回复 → sendBuildMessage(text) → 更新 options + text + draft
Draft 完整 → confirmDraft() → 创建 AgentTemplate
```

**latestAssistantState 解析**：
从最后一条 assistant message 的 JSON content 中提取 options 数组和 draft 对象。如果 session.context 也有字段，则合并。

---

## 6. 核心数据流

### 6.1 HTTP 请求流

```
客户端 fetch("/api/xxx")
  ↓
Next.js 代理 (/api/* → localhost:3001)
  ↓
NestJS HTTP 适配器 (Express)
  ↓
AgentHubAuthGuard.canActivate()
  ├─ @PublicRoute() → 放行
  ├─ /api/downstream/* → 放行
  ├─ Cookie 认证  → 放行
  └─ 其他 → 401 UNAUTHORIZED
  ↓
控制器方法
  ↓
服务方法
  ├─ Prisma 查询/写入
  ├─ mapper 转换 (DB row → DTO)
  ├─ WebSocket 广播 (emitSession/emitMessage/emitEvent)
  └─ 下游通知 (DownstreamOrchestratorService)
  ↓
JSON 响应
```

### 6.2 WebSocket 上行流（客户端实时推送）

```
客户端 Socket.IO 连接 → /socket.io
  ↓ Cookie 认证
HubRealtimeGateway.handleConnection()
  ↓ 发送 "realtime.ready"
客户端 emit "session.subscribe"
  ↓
Gateway 加入 "session:{sessionId}" 房间
  ↓ 发送 "session.subscribed"
服务通过 Gateway 方法广播:
  emitEvent()    → "hub:event" + "run.event"
  emitSession()  → "hub:session"
  emitMessage()  → "hub:message"
  emitArtifact() → "hub:artifact"
  emitFileChange() → "hub:file_change"
  ↓
客户端收到 → 更新 workspace state
```

### 6.3 WebSocket 下行流（下游 ACP 协议）

```
用户发送消息 → HubSessionService.sendMessage()
  ↓
创建 AgentRun (status: "queued")
  ↓
DownstreamOrchestratorService.startRun()
  ├─ 未配置下游 URL → simulateRun() 模拟模式
  └─ 已配置:
    ↓ ensureConnection()
    Socket.IO 客户端 → 下游 Orchestrator 服务器
    ↓ ACP JSON-RPC:
    initialize → session/new → session/prompt
    ↓
    下游返回事件（通过 acp:message）:
    ↓ handleDownstreamEvent()
    HubEventService.append()
    ├─ 去重 (seq 幂等)
    ├─ 排序 (seq 严格递增)
    ├─ 持久化 (AgentEvent 表)
    ├─ 副作用:
    │  ├─ message.delta → 内存缓冲 → WS 广播
    │  ├─ message.completed → 创建 Message → WS 广播
    │  ├─ file.change → 创建 FileChange → WS 广播
    │  ├─ artifact.upsert/complete → Artifact 存储 → WS 广播
    │  └─ run.completed/failed → 清理缓冲区 + 标记完成
    └─ HubRealtimeGateway 广播到前端房间
```

### 6.4 消息发送完整链路

```
用户输入 → Composer (textarea)
  ↓ handleSend()
  1. 构建 SendHubMessageRequest:
    ├─ content (文本)
    ├─ mentionedAgentIds (@提及解析)
    ├─ parentMessageId (回复目标)
    ├─ references (引用消息/部件)
    └─ attachments (上传的文件)
  ↓
sendSessionMessage(sessionId, request)
  ↓ POST /api/sessions/:id/messages
HubSessionController.sendMessage()
  ↓
HubSessionService.sendMessage()
  1. 验证 (内容非空、会话可写)
  2. 部署命令检测 (parseDeploymentCommand)
  3. 解析 @提及 + 加载附件 + 链接预览
  4. 创建 Message (role: "user")
  5. 记录 ContextItem
  6. 创建 AgentRun (status: "queued")
  7. deriveTitle (自动标题)
  8. WebSocket 广播 session update
  ↓
  跳过下游（部署命令） 或 downstream.startRun()
  ↓ 下游返回事件流
  前端通过 WebSocket 实时接收:
    hub:event → 更新 events
    hub:message → 追加/更新 messages
    hub:artifact → 追加 artifacts
    hub:file_change → 追加 fileChanges
```

### 6.5 认证流

```
POST /api/auth/login { username, password }
  ↓
AuthController.login()
  ↓
AuthSessionService.login(username, password):
  1. prisma.user.findUnique({ username })
  2. verifyPassword(password, user.passwordHash)
     └─ scrypt 重新 hash + timingSafeEqual 比较
  3. 生成 32 字节随机 token
  4. redis.set("agenthub:session:{token}", JSON({ userId, username }), EX=604800)
  5. 更新 user.lastLoginAt
  6. 返回 { token, user }
  ↓
Controller 设置 httpOnly Cookie:
  name: "agenthub_session"
  value: token
  sameSite: "lax"
  path: "/"
  maxAge: 604800 秒 (7 天)
  ↓
后续请求自动携带 Cookie
  ↓
AgentHubAuthGuard.canActivate():
  authSessions.authenticateCookie(cookie):
    1. 解析 Cookie → 提取 token
    2. redis.get("agenthub:session:{token}")
    3. 解析 JSON
    4. redis.expire(token, 604800) ← 刷新 TTL
    5. 返回 { userId, username } 或 null
```

### 6.6 部署流

```
POST /api/sessions/:id/deployments
  ↓
HubSessionController.startDeployment()
  ↓
DeploymentService.start(sessionId, _input):
  1. 验证:
    ├─ session.projectId 存在
    ├─ session.metadata.latestSuccessfulPushCommitSha 存在
    ├─ VERCEL_TOKEN 配置
    └─ project.metadata.vercelProjectId 或可创建
  2. 创建 system Message (deploy_status: "queued")
  3. 创建 Deployment 记录
  ↓
异步 runDeployJob(deploymentId):
  1. parseGithubRepository(url) → { owner, repo }
  2. ensureVercelProject:
    ├─ 有 vercelProjectId → 复用
    └─ 无 → POST /v11/projects (新建 Vercel 项目)
            → syncVercelEnv (同步环境变量)
            → 持久化 vercelProjectId
  3. POST /v13/deployments { name, gitSource }
  4. pollJob 轮询:
    ├─ GET /v13/deployments/:id
    ├─ readyState:
    │  ├─ READY → completed (含 URL)
    │  ├─ ERROR/CANCELED/DELETED → failed
    │  └─ 其他 → setTimeout(3000) 继续轮询
    └─ 超过 30 分钟 → failed (超时)
  ↓
每次状态变更:
  syncDeploymentMessage()
    → 更新 Message.contentJson (deploy_status 部件)
    → WebSocket 广播 message update
```

### 6.7 沙箱文件编辑流

```
前端 FilePanel:
  1. listSandboxAgents(sessionId) → 获取 Agent 分支列表
  2. 选择 Agent → connectSandbox(sessionId, { agentId })
     ↓
  后端 SandboxService.connect():
    1. 验证 project 绑定 + 沙箱配置
    2. 验证 agent 在会话中
    3. signToken({
         iss: "agenthub",
         typ: "sandbox",
         exp: now + 15min,
         sessionId, projectId, agentId, workspaceId, branch
       })
    4. 返回 { token, sandboxBaseUrl, workspaceId, branch }
  ↓
  前端:
  3. listSandboxTree(connection, "/") → 文件树
  4. readSandboxFile(connection, path) → 文件内容 → draft
  5. 用户编辑 draft
  6. saveSandboxFile(connection, { path, content, baseSha })
  ↓
  沙箱服务保存文件 → 触发回调
  ↓
POST /api/sandbox/file-changes (Bearer token 认证)
  ↓
SandboxService.recordFileChangeFromSandbox():
  1. verifyToken → 验证 scope
  2. 创建 AgentRun
  3. events.append(file.change)
  4. events.append(run.completed)
  5. 缓存 workspace info → session.metadata
  6. WebSocket 广播
```

---

## 7. 环境变量与配置

### 7.1 后端环境变量

| 变量                                  | 默认值                      | 用途                           |
| ----------------------------------- | ------------------------ | ---------------------------- |
| `PORT`                              | 3001                     | 服务端口                         |
| `DATABASE_URL`                      | (必填)                     | PostgreSQL 连接                |
| `REDIS_URL`                         | `redis://localhost:6379` | Session 缓存                   |
| `OPENAI_API_KEY`                    | (可空)                     | 种子数据中的 LLM 配置                |
| `SUMMARY_API_KEY`                   | (可空)                     | 上下文摘要 LLM                    |
| `SUMMARY_BASE_URL`                  | (可空)                     | 摘要 LLM 端点                    |
| `CONTEXT_SUMMARY_MODEL`             | `deepseek-chat`          | 摘要模型名                        |
| `CONTEXT_TOKEN_BUDGET`              | 9000                     | 上下文 token 总预算                |
| `CONTEXT_RECENT_TOKEN_BUDGET`       | 4800                     | 近期消息预算                       |
| `CONTEXT_RETRIEVAL_LIMIT`           | 8                        | 向量检索返回数                      |
| `CONTEXT_EMBEDDING_MODEL`           | `text-embedding-3-small` | 嵌入模型                         |
| `DOWNSTREAM_ORCHESTRATOR_WS_URL`    | (可空)                     | 下游 Orchestrator 地址（缺省使用模拟模式） |
| `DOWNSTREAM_ENABLE_SESSION_LOAD`    | (可空)                     | 启用会话恢复                       |
| `DOWNSTREAM_ENABLE_CONTEXT_DELTA`   | (可空)                     | 启用上下文增量通知                    |
| `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` | (可空)                     | 启用文件 diff 应用                 |
| `AGENTHUB_SANDBOX_BASE_URL`         | (可空)                     | 沙箱服务地址                       |
| `AGENTHUB_SANDBOX_TOKEN_SECRET`     | (可空)                     | 沙箱令牌 HMAC 密钥                 |
| `AGENTHUB_SANDBOX_CALLBACK_SECRET`  | (可空)                     | 沙箱回调共享密钥                     |
| `VERCEL_TOKEN`                      | (可空)                     | Vercel API 令牌                |
| `VERCEL_TEAM_ID`                    | (可空)                     | Vercel 团队 ID                 |
| `VERCEL_DEPLOY_ENV_KEYS`            | (可空)                     | 同步到 Vercel 的环境变量（逗号分隔）       |
| `ALIYUN_OSS_REGION`                 | (可空)                     | OSS 区域                       |
| `ALIYUN_OSS_BUCKET`                 | (可空)                     | OSS Bucket                   |
| `ALIYUN_OSS_ACCESS_KEY_ID`          | (可空)                     | OSS AccessKey                |
| `ALIYUN_OSS_ACCESS_KEY_SECRET`      | (可空)                     | OSS Secret                   |
| `ALIYUN_OSS_PUBLIC_DOMAIN`          | (可空)                     | OSS 公网域名（回退签名 URL）           |

### 7.2 前端配置

**next.config.ts**：

- `transpilePackages: ["@agenthub/shared"]` — 编译 monorepo 共享包
- 代理重写：
  - `/api/:path*` → `http://localhost:3001/api/:path*`
  - `/socket.io/:path*` → `http://localhost:3001/socket.io/:path*`

**tsconfig.json**：

- 路径别名：`@agenthub/shared` → `../shared/src/index.ts`（直接引用源文件）

**API 基础 URL**：

- `agenthub-api.ts` 中硬编码 `http://localhost:3001/api`
- 但实际运行时被 Next.js 代理拦截，走客户端相对路径

### 7.3 功能开关汇总

| 开关                                      | 效果                                                   |
| --------------------------------------- | ---------------------------------------------------- |
| `DOWNSTREAM_ORCHESTRATOR_WS_URL` 未配置    | 使用内置 mock orchestrator 模拟 Agent 回复                   |
| `DOWNSTREAM_ENABLE_SESSION_LOAD` 未设置    | 每次运行创建新的下游会话，不复用                                     |
| `DOWNSTREAM_ENABLE_CONTEXT_DELTA` 未设置   | pin/member 变更不通过 ACP 通知下游                            |
| `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` 未设置 | applyFileChange 不发送 file/apply_diff 到下游              |
| `SUMMARY_API_KEY` 未设置                   | BuilderService 使用 mockReply，ContextService 摘要回退到截断文本 |
| `ALIYUN_OSS_*` 未配置                      | 产物仅支持 inline_text 存储                                 |
| `VERCEL_TOKEN` 未配置                      | 部署功能不可用（preflight 返回 missing）                        |
| `AGENTHUB_SANDBOX_*` 未配置                | 沙箱编辑功能不可用                                            |

---

## 附录：关键文件路径索引

| 文件                                                                    | 行数    | 说明        |
| --------------------------------------------------------------------- | ----- | --------- |
| `backend/src/main.ts`                                                 | ~20   | 入口        |
| `backend/src/modules/app.module.ts`                                   | ~15   | 根模块       |
| `backend/src/modules/hub/hub.module.ts`                               | ~60   | 注册中心      |
| `backend/prisma/schema.prisma`                                        | ~250  | 数据模型      |
| `backend/src/modules/hub/services/hub-session.service.ts`             | ~600  | 会话编排      |
| `backend/src/modules/hub/services/downstream-orchestrator.service.ts` | ~1050 | 下游连接      |
| `backend/src/modules/hub/services/event.service.ts`                   | ~400  | 事件处理      |
| `backend/src/modules/hub/services/context.service.ts`                 | ~350  | 上下文管理     |
| `backend/src/modules/hub/services/deployment.service.ts`              | ~300  | Vercel 部署 |
| `backend/src/modules/hub/services/builder.service.ts`                 | ~300  | 模板构建器     |
| `backend/src/modules/hub/services/sandbox.service.ts`                 | ~200  | 沙箱集成      |
| `backend/src/modules/hub/controllers/hub.controller.ts`               | ~600  | 所有控制器     |
| `backend/src/modules/hub/gateways/hub-realtime.gateway.ts`            | ~100  | WebSocket |
| `backend/src/modules/hub/mappers/hub.mappers.ts`                      | ~200  | 数据映射      |
| `shared/src/hub.ts`                                                   | ~300  | 核心类型      |
| `shared/src/downstream.ts`                                            | ~40   | 下游类型      |
| `shared/src/builder.ts`                                               | ~50   | 构建器类型     |
| `frontend/app/page.tsx`                                               | ~2397 | 工作台主页     |
| `frontend/app/workbench/timeline.tsx`                                 | ~383  | 消息时间线     |
| `frontend/app/workbench/inspector.tsx`                                | ~1046 | 右侧面板      |
| `frontend/app/workbench/rich-text.tsx`                                | ~904  | 富文本渲染     |
| `frontend/lib/agenthub-api.ts`                                        | ~481  | API 客户端   |
| `frontend/lib/workbench/diff.ts`                                      | ~128  | LCS 对比    |
| `frontend/lib/workbench/markdown.ts`                                  | ~120  | MD 解析     |
| `frontend/lib/workbench/timeline.ts`                                  | ~176  | 对话构建      |
| `frontend/app/agent-templates/build/page.tsx`                         | ~426  | 构建器页面     |
