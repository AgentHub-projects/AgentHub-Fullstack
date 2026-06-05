# AgentHub 与真实下游 Agent 传输协议

版本：v2.0
日期：2026-06-04
状态：基于当前代码实现，与 `agenthub-vs-agentgateway.md` 互为补充

## 1. 实现依据

本文档描述 AgentHub 后端与真实下游 Agent/Orchestrator 的 ACP（Agent Communication Protocol）传输协议，依据当前代码实现整理。

关键实现文件：

- `backend/src/modules/hub/services/downstream-orchestrator.service.ts` — 连接生命周期、prompt 分发、事件处理、断线恢复
- `backend/src/modules/hub/services/acp-connection.ts` — JSON-RPC 2.0 传输层封装（request/respond/notify 原语）
- `backend/src/modules/hub/services/event.service.ts` — 事件持久化与副作用
- `shared/src/downstream.ts` — 下游协议共享类型定义

## 2. 角色边界

AgentHub 后端负责：

- 接收前端用户消息，创建 `agent_runs`。
- 构造上下文快照并渲染为 prompt 文本。
- 作为 Socket.IO client 主动连接下游 Orchestrator。
- 发送 `initialize`、`session/new`、`session/prompt`、`session/cancel` 等 ACP 消息。
- 接收下游 `session/event`、`session/update` 事件，归一化后落库。
- 将事件派生为 `messages`、`file_changes`、`artifacts`，并推送前端 WebSocket。

下游 Agent/Orchestrator 负责：

- 暴露 Socket.IO WebSocket 服务。
- 响应 `initialize`、`session/new`、`session/prompt`（JSON-RPC request）。
- 接收 `session/cancel`（JSON-RPC notification）。
- 维护真实执行环境和下游 session。
- 将事件通过 `session/event` 或 `session/update` 回传给 AgentHub。

## 3. 传输层

AgentHub 是 Socket.IO **client**，下游 Orchestrator 是 Socket.IO **server**。

连接地址：

```env
DOWNSTREAM_ORCHESTRATOR_WS_URL=http://localhost:4000
```

AgentHub 连接方式：

```ts
io(DOWNSTREAM_ORCHESTRATOR_WS_URL, {
  transports: ["websocket"],
  reconnection: false   // 不启用 Socket.IO 自动重连
})
```

**唯一的消息通道**：所有 ACP 消息通过 Socket.IO event `acp:message` 双向传输。

```text
acp:message   ← 双向，AgentHub 与下游之间唯一使用的 Socket.IO event
```

AgentHub 不监听 `session/event`、`acp:event`、`message` 等 event 名称。下游所有回复、请求、事件均通过 `acp:message` 发送。

## 4. 通用消息 Envelope

所有消息使用 **JSON-RPC 2.0** 格式，通过 `acp:message` 传输。

### 4.1 消息角色

AgentHub 根据消息是否有 `id` 区分 request 和 notification：

| 角色 | 有 `id`？ | 语义 |
| --- | --- | --- |
| **Request** | 是 | 期望对方返回 JSON-RPC response（`result` 或 `error`），有超时计时 |
| **Notification** | 否 | 单向发送，不等待响应 |

AgentHub 发送的消息分类：

| 方法 | 角色 | 说明 |
| --- | --- | --- |
| `initialize` | **Request** | 连接初始化，等待响应 |
| `session/new` | **Request** | 创建下游 session，等待返回 `sessionId` |
| `session/prompt` | **Request** | 发送用户任务；已有 session 通过 `sessionId` 直接恢复 |
| `session/cancel` | **Notification** | 取消运行，不等待响应 |
| `session/context_delta` | **Notification** | 上下文增量变更（pin、成员），不等待响应 |
| `file/apply_diff` | **Notification** | 应用文件差异，不等待响应 |

### 4.2 Request（带 id，期望响应）

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {}
}
```

下游必须返回 `result` 或 `error`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "sessionId": "downstream-session-xxx" }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": "SESSION_NEW_FAILED", "message": "session creation failed" }
}
```

**超时**：默认 3000ms（通过 `RECOVERY_TIMEOUT_MS` 配置），超时后 Agenthub 以 `{METHOD}_TIMEOUT` 错误拒绝。`id` 为自动递增整数（从 1 开始）。

### 4.3 Notification（无 id，不等待响应）

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "method": "session/prompt",
  "params": {
    "sessionId": "downstream-session-xxx",
    "prompt": [{"type": "text", "text": "..."}],
    "_meta": { ... }
  }
}
```

下游不应返回任何响应，也无需处理 `id` 字段。

### 4.4 下游向 AgentHub 发送事件

下游向 AgentHub 发送事件使用 **JSON-RPC request**（带 `id`），AgentHub 处理后会返回 ack。

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": { ... }
}
```

AgentHub ack（成功）：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "result": { "ok": true }
}
```

AgentHub error（失败）：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "error": { "code": "RUN_ID_REQUIRED", "message": "RUN_ID_REQUIRED" }
}
```

### 4.5 已废弃的格式

以下简化事件格式（无 `method` 字段）**已不再支持**：

```json
{
  "type": "message.completed",
  "runId": "agenthub-run-id",
  "seq": 1,
  "speaker": 2,
  "payload": { "text": "..." }
}
```

原因是当前代码中 `session/event` 处理路径的 `_meta.runId` 必填，简化格式无法提供 `_meta`。下游必须使用带 `method: "session/event"` 或 `method: "session/update"` 的标准 JSON-RPC 格式。

### 4.6 Envelope 字段

| 字段 | 方向 | 说明 |
| --- | --- | --- |
| `jsonrpc` | 双向 | 固定 `"2.0"` |
| `id` | 双向 | 整数，request 必须带，notification 不带。AgentHub 响应匹配依赖此字段 |
| `method` | 双向 | ACP 方法名，如 `session/event`、`session/update` 等 |
| `params` | 双向 | 方法参数 |
| `result` | 双向 | 成功响应载荷 |
| `error` | 双向 | 失败响应，格式为 `{ code, message }` 或 string |

## 5. 连接初始化

Socket.IO 连接成功后，AgentHub 立即发送 `initialize`（request）。

### 5.1 initialize

AgentHub -> 下游（request）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false
    }
  }
}
```

下游需返回初始化结果；`agentCapabilities.loadSession` 不应声明为 `true`，如保留字段则返回 `false`。AgentHub 每次新建连接都会先等待 `initialize` 成功，再继续 `session/new` 或 `session/prompt`。

### 5.2 事件处理注册

连接建立后，AgentHub 通过 `AcpConnection.onNotification()` 注册处理器，监听下游通过 `acp:message` 发来的 `session/update` 和 `session/event` 通知。

处理规则：

- 如果收到带 `id` 的消息，且该 `id` 匹配 AgentHub 的某个 pending request → 作为该 request 的 response 处理（见 4.2）。
- 否则 → 转发给通知处理器，由 `handleDownstreamEvent()` 统一处理（见第 8 节）。

## 6. 下游 Session 管理

AgentHub 按 AgentHub session 粒度管理下游 session。同一下游 session 可被多次 `session/prompt` 复用。

### 6.1 创建下游 Session（session/new）

当没有可复用的 `downstreamSessionId` 时，AgentHub 发送 `session/new`（request）。

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "_meta": {
      "agentId": "1",
      "agenthubSessionId": "agenthub-session-id"
    },
    "mcpServers": []
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_meta.agentId` | string | Orchestrator Agent 实例 id（转为字符串） |
| `_meta.agenthubSessionId` | string | AgentHub session id |
| `mcpServers` | array | 当前固定为空数组 |

下游必须返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "downstream-session-xxx",
    "sandbox": {
      "baseUrl": "http://localhost:4100",
      "workspaceId": "workspace-xxx",
      "agentBranches": {
        "2": "agent-2"
      }
    }
  }
}
```

`result.sessionId` 必填。AgentHub 保存该 id 用于后续 `session/prompt` 和 `session/cancel`。
`result.sandbox` 可选；提供时 AgentHub 会把 `agenthubSessionId -> 下游沙箱地址/workspace/Agent 分支` 映射写入 Redis，前端文件面板据此直连下游文件 API。缺少可用 sandbox 时会清理旧映射。

### 6.2 复用下游 Session

旧加载接口已删除。AgentHub 如果已有可复用的 `downstreamSessionId`，会在新连接上先发送 `initialize`，然后直接发送 `session/prompt`，其中 `params.sessionId` 使用该旧下游 session id。

如果下游在 `session/prompt` 响应中返回 `SESSION_NOT_FOUND`，AgentHub 会回退到 `session/new` 并用 bootstrap prompt 恢复上下文。

### 6.3 超时

`initialize` 和 `session/new` 的默认超时为 3000ms。超时后 AgentHub 会以 `INITIALIZE_TIMEOUT` 或 `SESSION/NEW_TIMEOUT` 拒绝。

## 7. 发送任务：session/prompt

用户发送消息后，AgentHub 创建 run，构造上下文快照，然后向下游发送 `session/prompt`（**request**）。

### 7.1 Payload 结构

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "downstream-session-xxx",
    "prompt": [
      {
        "type": "text",
        "text": "# AgentHub Request (bootstrap)\n\n## Session Context\n...\n\n## Current User Request\n@Frontend 请实现登录页"
      }
    ],
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id",
      "runId": "agenthub-run-id",
      "messageId": "agenthub-user-message-id",
      "orchestratorAgentId": "1",
      "mentionedAgentIds": ["2", "3"],
      "contextSnapshotId": "context-snapshot-id",
      "promptMode": "bootstrap",
      "orchestratorSystemPrompt": "system prompt for orchestrator...",
      "agents": [
        { "agentId": 2, "description": "前端成员描述" }
      ],
      "pins": [],
      "memory": {
        "summary": "长期摘要文本",
        "recent": [],
        "retrieved": []
      }
    }
  }
}
```

**顶层字段（遵循 ACP 标准）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 下游 session id |
| `prompt` | array | ACP 标准 prompt parts，当前固定为单个 `{ type: "text", text: "..." }` |

**`_meta` 字段（AgentHub 业务扩展）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | 固定 `"agenthub"` |
| `agenthubSessionId` | string | AgentHub session id |
| `runId` | string | AgentHub run id，下游回传事件时必须使用此 id |
| `messageId` | string | AgentHub 用户消息 id |
| `orchestratorAgentId` | string | 主 Orchestrator Agent 实例 id（转字符串） |
| `mentionedAgentIds` | string[] | 用户 @ 的 Agent 实例 id（均为字符串） |
| `contextSnapshotId` | string\|null | AgentHub 上下文快照 id（bootstrap 时有） |
| `promptMode` | string | `"bootstrap"` 或 `"incremental"` |
| `orchestratorSystemPrompt` | string | Orchestrator 模板系统提示词（仅 bootstrap） |
| `agents` | array | 当前群聊 worker Agent 简介（仅 bootstrap） |
| `pins` | array | Pinned 上下文（仅 bootstrap） |
| `memory` | object | `{ summary, recent, retrieved }` 记忆数据（仅 bootstrap） |

**禁止**将这些字段放在 `params` 顶层。所有 AgentHub 自定义字段必须放入 `_meta`。

### 7.2 promptMode

- `bootstrap`：首次连接或重连后的第一条消息。`prompt[0].text` 包含完整上下文（会话上下文、可用 worker、pins、记忆、当前用户请求等）。渲染格式：

  ```
  # AgentHub Request (bootstrap)
  ## Session Context
  ...（上下文快照渲染文本）
  ## Mentioned Agents
  - agent-name (agentId)
  ## Available Worker Agents
  - agentId: description
  ## Current Message Context
  { ... JSON ... }
  ## Current User Request
  ...
  ```

- `incremental`：复用已有下游 session 的后续消息。`prompt[0].text` 只包含当前用户请求和本轮消息上下文。

### 7.3 发送流程

1. AgentHub 更新 run 状态为 `connecting`。
2. 建立 / 复用下游连接，完成握手。
3. 如果是 bootstrap，构建上下文快照并渲染 prompt。
4. 调用 `acp.notify("session/prompt", promptInput)` 发送 notification。
5. **不等待下游响应**，直接将 run 标记为 `running`。
6. 下游通过 `session/event` 事件流回传过程和结果。

## 8. 下游事件回传

下游向 AgentHub 报告事件有两种方式：

| 方式 | 方法 | 用途 |
| --- | --- | --- |
| `session/update` | 流式文本 + agent_message_stop | 实时文本流式输出 |
| `session/event` | 结构化事件 | 文件变更、artifact、git push、run 终态等 |

### 8.1 session/event（推荐）

下游 -> AgentHub：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "type": "message.completed",
    "seq": 1,
    "payload": {
      "text": "我已完成前端实现。"
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

**必填规则**：

| 字段 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `method` | envelope 顶层 | **是** | 必须为 `"session/event"`（或完全不设置 `method` 以兼容旧格式） |
| `runId` | `params._meta.runId` | **是** | 必须精确匹配 AgentHub 下发的 run id，否则被拒绝（`RUN_ID_REQUIRED`） |
| `type` | `params.type` | **是** | 事件类型，也可用 `params.eventType` 作为 fallback |
| `seq` | `params.seq` | 建议 | run 内单调递增的事件序号，传了就必须递增 |
| `agentId` | `params._meta.agentId` | 多 Agent 时必填 | AgentHub Agent 实例 id，用于 speaker 归属 |
| `payload` | `params.payload` | 是 | 事件载荷，也可用整个 `params` 作为 fallback |

**关键约束**：

- 如果 envelope 顶层 `method` 存在且**不是** `"session/event"` 或 `"session/update"`，事件会被**直接丢弃**。
- AgentHub 读取 runId 的路径：`params._meta.runId`（不是 `params.runId`，不是顶层 `runId`）。
- AgentHub 读取 speaker 的路径：`params._meta.agentId`（不是 `params.speaker`，不是 `params.payload.speaker`，不是顶层 `speaker`）。
- 去掉 `_meta` 中的 `runId` 或 `agentId` 的事件不会被持久化。

**AgentHub 处理流程**：

1. 提取 `_meta.runId`（缺失 → `RUN_ID_REQUIRED`）。
2. 检查该 run 是否已被 cancel（已取消 → `RUN_ALREADY_CANCELLED`）。
3. 提取 `params.type`（缺失 → `EVENT_TYPE_REQUIRED`）。
4. 提取 `params.seq`（若有则校验递增，重复 → 静默跳过，乱序 → `EVENT_SEQ_OUT_OF_ORDER`）。
5. 调用 `events.append()` 持久化事件。
6. 如果是 `run.completed` → 标记 run completed。
7. 如果是 `run.failed` → 标记 run failed，错误码 `DOWNSTREAM_RUN_FAILED`。
8. 返回 ack `{ ok: true }` 或 error。

### 8.2 session/update（流式文本）

下游 -> AgentHub：

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/update",
  "params": {
    "update": {
      "text": "阶段性回复文本",
      "sessionUpdate": "agent_message_stop",
      "_meta": {
        "runId": "agenthub-run-id",
        "agentId": "2"
      }
    }
  }
}
```

AgentHub 读取 `_meta` 时的优先级：

1. `params._meta`（**推荐位置**）
2. `params.update._meta`（兼容位置）

处理规则：

- `update.text` 或 `update.content.text` → 产生 `message.delta`，缓存在内存 buffer 中。
- `sessionUpdate` 为 `"agent_message_stop"` 或 `"stop"` → 产生 `message.completed`，将 buffer 内容持久化到 `messages` 表。
- `_meta.runId` 必填（缺失 → `RUN_ID_REQUIRED`）。
- `_meta.agentId` 用于 speaker 归属（缺失 → speaker 默认用 `"agent"` 字符串，speakerAgentId 为 `undefined`）。

示例：普通 delta（非 stop）：

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/update",
  "params": {
    "update": {
      "text": "正在分析项目结构...",
      "_meta": {
        "runId": "agenthub-run-id",
        "agentId": "2"
      }
    }
  }
}
```

## 9. 支持的事件类型

所有事件类型通过 `session/event` 发送，AgentHub 在 `event.service.ts` 中处理。

### 9.1 message.delta

流式文本片段，仅缓存在内存，不持久化到数据库。

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    },
    "type": "message.delta",
    "seq": 1,
    "payload": {
      "text": "正在分析项目结构..."
    }
  }
}
```

### 9.2 message.completed

完整 Agent 回复，持久化到 `messages` 表。

```json
{
  "jsonrpc": "2.0",
  "id": 1002,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    },
    "type": "message.completed",
    "seq": 2,
    "payload": {
      "text": "已完成登录页实现。",
      "parts": []
    }
  }
}
```

文本识别优先级（按此顺序读取，取第一个非空值）：

1. `payload.text`
2. `payload.content`
3. `payload.message`
4. `payload.delta`

可选 `payload.parts` 可携带富文本片段（diff、artifact 引用、链接预览等）。

### 9.3 file.change

文件变更快照，持久化到 `file_changes` 表。

```json
{
  "jsonrpc": "2.0",
  "id": 1003,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    },
    "type": "file.change",
    "seq": 3,
    "payload": {
      "path": "src/app/page.tsx",
      "changeType": "modified",
      "language": "tsx",
      "before": {
        "content": "old code",
        "sha256": "before-sha",
        "truncated": false
      },
      "after": {
        "content": "new code",
        "sha256": "after-sha",
        "truncated": false
      },
      "patch": "@@ -1 +1 @@\n-old\n+new\n",
      "stats": { "additions": 1, "deletions": 1 },
      "metadata": {}
    }
  }
}
```

约束：

- `path` 必填。
- 必须提供 `patch` 或 before/after content 至少其中之一。
- `changeType` 支持：`added`、`modified`、`deleted`、`renamed`。其他值按 `modified` 处理。
- `oldPath` 用于 rename 场景。

### 9.4 artifact.upsert

创建或更新 artifact。调用 `ArtifactStorageService.upsertArtifact()`。

```json
{
  "jsonrpc": "2.0",
  "id": 1004,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    },
    "type": "artifact.upsert",
    "seq": 4,
    "payload": {
      "artifactKey": "preview",
      "kind": "html",
      "title": "预览页",
      "mimeType": "text/html",
      "content": "<main>Hello</main>",
      "final": true,
      "metadata": {}
    }
  }
}
```

支持的 `kind` 枚举值：

```
markdown    text       html       pdf        docx
pptx        image      archive    log        other
```

### 9.5 artifact.chunk

流式 artifact 内容片段。当前实现为简化文本累加。

```json
{
  "jsonrpc": "2.0",
  "id": 1005,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id"
    },
    "type": "artifact.chunk",
    "seq": 5,
    "payload": {
      "artifactKey": "large-log",
      "content": "chunk text"
    }
  }
}
```

### 9.6 artifact.complete

标记 artifact 完成，调用 `completeArtifact()`。

```json
{
  "jsonrpc": "2.0",
  "id": 1006,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    },
    "type": "artifact.complete",
    "seq": 6,
    "payload": {
      "artifactKey": "preview",
      "final": true
    }
  }
}
```

### 9.7 git.push.completed

Git push 成功通知。AgentHub 将此信息写入 session metadata，部署流程依赖此数据。

```json
{
  "jsonrpc": "2.0",
  "id": 1007,
  "method": "session/event",
  "params": {
    "_meta": {
      "runId": "agenthub-run-id"
    },
    "type": "git.push.completed",
    "seq": 7,
    "payload": {
      "commitSha": "abcdef1234567890",
      "branch": "main",
      "remoteUrl": "https://github.com/acme/agenthub"
    }
  }
}
```

AgentHub 写入 session 的 metadata 字段：

- `latestSuccessfulPushCommitSha`
- `latestSuccessfulPushBranch`
- `latestSuccessfulPushRemoteUrl`
- `latestSuccessfulPushRunId`

### 9.8 diff.apply.requested

Diff 应用已排队（状态变更事件）。

```json
{
  "jsonrpc": "2.0",
  "id": 1008,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "diff.apply.requested",
    "seq": 8,
    "payload": {
      "fileChangeIds": ["file-change-id"]
    }
  }
}
```

### 9.9 diff.apply.completed

Diff 应用成功。

```json
{
  "jsonrpc": "2.0",
  "id": 1009,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "diff.apply.completed",
    "seq": 9,
    "payload": {
      "fileChangeIds": ["file-change-id"],
      "message": "applied"
    }
  }
}
```

### 9.10 diff.apply.failed

Diff 应用失败或冲突。

```json
{
  "jsonrpc": "2.0",
  "id": 1010,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "diff.apply.failed",
    "seq": 10,
    "payload": {
      "fileChangeIds": ["file-change-id"],
      "status": "conflict",
      "message": "patch conflict",
      "conflicts": [{ "path": "src/app/page.tsx" }]
    }
  }
}
```

当 `status` 为 `"conflict"` 或 `conflicts` 非空时，对应的文件变更记录被标记为冲突状态。

### 9.11 run.completed

Run 成功完成。

```json
{
  "jsonrpc": "2.0",
  "id": 1011,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "run.completed",
    "seq": 11,
    "payload": {
      "finalMessage": "任务完成。",
      "usage": { "inputTokens": 1000, "outputTokens": 500 }
    }
  }
}
```

AgentHub 收到后将 run 标记为 `completed`。

### 9.12 run.failed

Run 失败。

```json
{
  "jsonrpc": "2.0",
  "id": 1012,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "run.failed",
    "seq": 12,
    "payload": {
      "message": "sandbox command failed",
      "code": "SANDBOX_ERROR"
    }
  }
}
```

AgentHub 收到后将 run 标记为 `failed`，错误码默认 `DOWNSTREAM_RUN_FAILED`。

## 10. AgentHub 发给下游的控制命令

### 10.1 取消 run（session/cancel）

AgentHub -> 下游（notification）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "downstream-session-xxx",
    "runId": "agenthub-run-id",
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id",
      "runId": "agenthub-run-id"
    }
  }
}
```

AgentHub 会先将本地 run 状态更新为 `cancelled`，再发送此 notification。

### 10.2 应用 Diff（file/apply_diff）

由环境变量 `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` 控制，**默认关闭**。启用后复用已有下游 `sessionId`，不会发送旧加载请求。

AgentHub -> 下游（notification）：

```json
{
  "jsonrpc": "2.0",
  "method": "file/apply_diff",
  "params": {
    "sessionId": "downstream-session-xxx",
    "fileChangeIds": ["file-change-id"],
    "changes": [
      {
        "id": "file-change-id",
        "path": "src/app/page.tsx",
        "patch": "@@ ..."
      }
    ],
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id",
      "runId": "agenthub-run-id"
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `sessionId` | 下游 session id |
| `fileChangeIds` | file_change 记录的 id 列表 |
| `changes` | 变更详情数组，每项包含 `id`、`path`，以及 `patch`、`beforeContent`、`afterContent` |

下游执行后应回传 `diff.apply.completed` 或 `diff.apply.failed`。

关闭时，AgentHub 会返回 `DOWNSTREAM_APPLY_NOT_SUPPORTED` 错误。

### 10.3 上下文增量（session/context_delta）

由环境变量 `DOWNSTREAM_ENABLE_CONTEXT_DELTA` 控制，**默认关闭**。用于通知下游发生 pin、成员变更等轻量上下文变化。

AgentHub -> 下游（notification）：

**Pin 更新**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "type": "pin.updated",
    "messageId": "message-id",
    "partId": "optional-part-id",
    "pinned": true,
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id"
    }
  }
}
```

**成员添加**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "type": "member.added",
    "agentId": 2,
    "description": "前端成员描述",
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id"
    }
  }
}
```

**成员删除**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "type": "member.deleted",
    "agentId": 2,
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "agenthub-session-id"
    }
  }
}
```

## 11. 能力开关

以下环境变量控制可选下游能力，均为默认关闭：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOWNSTREAM_ENABLE_CONTEXT_DELTA` | `false` | 开启后发送 `session/context_delta`（pin、成员变更） |
| `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` | `false` | 开启后允许发送 `file/apply_diff` |

取值：`"1"`、`"true"`、`"yes"`（不区分大小写）均视为开启。

关闭时的行为：

- 已有下游 `sessionId` 时复用该 id 直接发送 `session/prompt`；没有时发送 `session/new`。
- `session/context_delta` 不发送，成员和 pin 信息通过下一次 prompt 上下文传递。
- `file/apply_diff` 返回 `DOWNSTREAM_APPLY_NOT_SUPPORTED`。

## 12. 连接空闲管理

- 下游连接空闲 1 小时后自动断开（`IDLE_TIMEOUT_MS = 3600000`）。
- 有 active run 时不会断开（每 1 分钟重检一次）。
- 有前端 WebSocket 订阅者时不会断开。
- 每次 `session/prompt`、`session/cancel`、`session/event`、`session/update` 等消息收发都会重置空闲计时器。

## 13. 断线恢复

AgentHub 不启用 Socket.IO 自动重连。

如果下游连接断开且当前有 active run（状态为 `queued`、`context_building`、`connecting` 或 `running`），AgentHub 会直接标记 run failed，错误码 `DOWNSTREAM_DISCONNECTED`。

后续用户再次发送消息时，AgentHub 会重新建立 Socket.IO 连接，发送 `initialize`，并用已有 `downstreamSessionId` 直接发送 `session/prompt`。

## 14. 事件序号与幂等

- `seq` 为 `params.seq` 中的 run 内单调递增事件序号。
- `runId + seq` 组合用于去重：重复的 seq 会被静默跳过。
- 乱序 seq（低于 expected）会返回 `EVENT_SEQ_OUT_OF_ORDER`。
- `message.delta` 对低于 expected seq 的旧片段仅生成 transient event，不重复持久化。

## 15. 取消后的事件处理

如果 AgentHub 本地 run 已经处于 `cancelled` 状态：

- 下游继续发来的事件会被拒绝，返回 `RUN_ALREADY_CANCELLED`。
- 但 `agenthub_backend` 来源的事件（AgentHub 自己生成的）不受影响。

## 16. 错误码

| 错误码 | 场景 |
| --- | --- |
| `RUN_ID_REQUIRED` | 事件缺少 `_meta.runId` |
| `EVENT_TYPE_REQUIRED` | 事件缺少 `params.type` |
| `EVENT_SEQ_OUT_OF_ORDER` | seq 乱序 |
| `RUN_ALREADY_CANCELLED` | run 已取消 |
| `DOWNSTREAM_DISCONNECTED` | 下游断线且无法恢复 |
| `DOWNSTREAM_RUN_FAILED` | 下游上报 run.failed |
| `DOWNSTREAM_PROMPT_FAILED` | 发送 prompt 失败 |
| `DOWNSTREAM_SESSION_ID_MISSING` | session/new 未返回 sessionId |
| `DOWNSTREAM_APPLY_NOT_SUPPORTED` | file/apply_diff 功能未开启 |
| `DOWNSTREAM_SESSION_NOT_FOUND` | apply diff 时找不到下游 session |
| `{METHOD}_TIMEOUT` | request 超时（如 `SESSION/NEW_TIMEOUT`） |
| `CONNECTION_CLOSED` | 连接关闭 |

## 17. 最小可联调流程

1. AgentHub 连接下游 Socket.IO server。
2. AgentHub 发送 `initialize`（notification）。
3. AgentHub 发送 `session/new`（request）。
4. 下游返回 `{ result: { sessionId: "..." } }`。
5. AgentHub 发送 `session/prompt`（notification）。
6. 下游回传 `session/event`（message.completed）。
7. 下游回传 `session/event`（file.change）。
8. 下游回传 `session/event`（artifact.upsert）。
9. 下游回传 `session/event`（git.push.completed）。
10. 下游回传 `session/event`（run.completed）。

完整 JSON 示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id", "agentId": "2" },
    "type": "message.completed",
    "seq": 1,
    "payload": {
      "text": "我会负责前端实现。"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1002,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id", "agentId": "2" },
    "type": "file.change",
    "seq": 2,
    "payload": {
      "path": "src/app/page.tsx",
      "changeType": "modified",
      "language": "tsx",
      "before": {
        "content": "export default function Page(){ return null; }",
        "truncated": false
      },
      "after": {
        "content": "export default function Page(){ return <main>Hello</main>; }",
        "truncated": false
      }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1003,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id", "agentId": "2" },
    "type": "artifact.upsert",
    "seq": 3,
    "payload": {
      "artifactKey": "preview",
      "kind": "html",
      "title": "预览页",
      "mimeType": "text/html",
      "content": "<main>Hello</main>",
      "final": true
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1004,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "git.push.completed",
    "seq": 4,
    "payload": {
      "commitSha": "abcdef1234567890",
      "branch": "main",
      "remoteUrl": "https://github.com/acme/agenthub"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1005,
  "method": "session/event",
  "params": {
    "_meta": { "runId": "agenthub-run-id" },
    "type": "run.completed",
    "seq": 5,
    "payload": {
      "finalMessage": "任务完成。"
    }
  }
}
```

## 18. 下游必须满足的要求

真实下游至少需要：

- 支持 Socket.IO WebSocket，在 `acp:message` event 上收发 JSON-RPC 2.0 消息。
- 响应 `initialize` request。
- 响应 `session/new` request，返回 `result.sessionId`。
- 响应 `session/prompt` request。
- 回传事件时使用 `session/event` 或 `session/update`，且 `_meta.runId` 必须精确匹配 AgentHub 下发的 run id。
- 多 Agent 输出必须在 `_meta.agentId` 中提供 AgentHub Agent 实例 id（转为字符串）。
- 文件变更必须提供 `path` 和 `patch` 或 before/after content。
- 如果要支持部署，完成 git push 后必须发送 `git.push.completed`，至少包含 `commitSha`。

建议额外支持：

- `session/cancel`
- `file/apply_diff`（与 `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` 配合）
- `session/context_delta`（与 `DOWNSTREAM_ENABLE_CONTEXT_DELTA` 配合）

## 19. 当前实现限制

- `initialize` 为 request，AgentHub 会等待响应。
- `session/prompt` 使用 request 发送；AgentHub 只等待短窗口错误响应，随后依靠下游事件推进 run。
- 只有 `_meta.runId` 被读取作为 run id，不再兼容顶层 `runId` 或 `params.runId`。
- 只有 `_meta.agentId` 被读取作为 speaker，不再兼容 `params.speaker`、`payload.speaker` 或顶层 `speaker`。
- `artifact.chunk` 当前为简化文本累加，不是完整二进制 chunk 合并协议。
- 真实 worker Agent 调度由下游 Orchestrator 负责，不在 AgentHub 内完成。
- Mock 模式下 `DOWNSTREAM_ORCHESTRATOR_WS_URL` 未配置时，AgentHub 自动生成模拟事件覆盖 message.completed、file.change、artifact.upsert、run.completed。
