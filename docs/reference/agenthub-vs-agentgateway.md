# AgentHub Backend 与 AgentGateway 对接契约

本文描述 AgentHub 后端当前与 `D:\agent\AgentGateway` 的对接方式。项目尚未真实上线，因此不保留旧协议兼容；正式契约统一为 ACP 标准顶层字段 + AgentHub 业务字段放入 `_meta`。

## 1. 当前原则

- `session/prompt` 顶层只发送 `sessionId`、`prompt`、`_meta`。
- AgentHub 自定义字段不再散落在顶层，统一放入 `_meta`。
- 给 Agent 阅读的上下文会渲染进 `prompt[0].text`。
- 下游回传事件必须带 `_meta.runId`，否则 AgentHub 拒绝落库（返回 `RUN_ID_REQUIRED`）。
- speaker 归属使用 `_meta.agentId`，不从 `params.speaker`、`payload.speaker` 或顶层 `speaker` 推断。
- AgentHub 发送 `initialize`、`session/new`、`session/prompt` 均使用 JSON-RPC **request**（带 `id`）。
- AgentHub 发送 `session/cancel`、`file/apply_diff`、`session/context_delta` 使用 JSON-RPC **notification**（无 `id`）。
- `session/context_delta`、`file/apply_diff` 是预留能力，默认关闭；后续下游兼容后再打开。

## 2. 能力开关

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `DOWNSTREAM_ENABLE_CONTEXT_DELTA` | 关闭 | 开启后发送成员变更、pin 更新等 `session/context_delta`。 |
| `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF` | 关闭 | 开启后允许向下游发送 `file/apply_diff`。 |

关闭状态下：

- 已有 `downstreamSessionId` 时不会发送 `session/new`，断线后的下一轮通过 `session/prompt.sessionId` 直接恢复下游 session。
- `session/context_delta` 不会发送，成员和 pin 信息通过下一次 prompt 上下文传递。
- `file/apply_diff` 会返回 `DOWNSTREAM_APPLY_NOT_SUPPORTED`，避免前端显示已排队但下游没有执行。

## 3. AgentHub → AgentGateway

### 3.1 initialize

连接 Socket.IO `/acp` 后，AgentHub 先发送 ACP 初始化 request：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": {
        "readTextFile": false,
        "writeTextFile": false
      },
      "terminal": false
    }
  }
}
```

下游返回的 capabilities 不应再声明已删除的加载能力；如果仍保留兼容字段，应返回禁用状态。

### 3.2 session/new

默认每条新连接创建下游 session。`_meta.agentId` 必须是字符串，匹配 AgentGateway 当前 `session.MetaString()` 的解析方式。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "_meta": {
      "agentId": "1",
      "agenthubSessionId": "<agenthub-session-id>"
    },
    "mcpServers": []
  }
}
```

期望响应：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "<downstream-session-id>"
  }
}
```

### 3.3 复用下游 Session

旧加载接口已删除。AgentHub 断线后如已有 `downstreamSessionId`，会在新连接上先发送 `initialize`，再直接发送 `session/prompt`，其中 `sessionId` 使用旧下游 session id。

### 3.4 session/prompt

正式顶层结构：

```json
{
  "jsonrpc": "2.0",
  "method": "session/prompt",
  "params": {
    "sessionId": "<downstream-session-id>",
    "prompt": [
      {
        "type": "text",
        "text": "# AgentHub Request (bootstrap)\n\n## Session Context\n...\n\n## Current User Request\n..."
      }
    ],
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "<agenthub-session-id>",
      "runId": "<agenthub-run-id>",
      "messageId": "<user-message-id>",
      "orchestratorAgentId": "1",
      "mentionedAgentIds": ["2", "3"],
      "contextSnapshotId": "<context-snapshot-id>",
      "promptMode": "bootstrap",
      "orchestratorSystemPrompt": "...",
      "agents": [
        { "agentId": 2, "description": "前端成员描述" }
      ],
      "pins": [],
      "memory": {
        "summary": "",
        "recent": [],
        "retrieved": []
      }
    }
  }
}
```

说明：

- `promptMode` 为 `"bootstrap"` 或 `"incremental"`。
- bootstrap prompt 会把上下文快照、可用 worker、当前消息上下文和用户请求渲染进 `prompt[0].text`。
- incremental prompt 只渲染当前请求和本轮消息上下文。
- 下游如果只理解 ACP 标准 PromptRequest，也能通过 `prompt` 文本拿到足够业务上下文。
- 下游如果需要结构化追踪信息，读取 `_meta`。

禁止再发送这些顶层字段：

- `runId`
- `agenthubSessionId`
- `messageId`
- `agentId`
- `mentionedAgentIds`
- `messageContext`
- `promptMode`
- `contextSnapshotId`
- `orchestratorSystemPrompt`
- `agents`
- `pins`
- `memory`

### 3.5 session/cancel

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "<downstream-session-id>",
    "runId": "<agenthub-run-id>",
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "<agenthub-session-id>",
      "runId": "<agenthub-run-id>"
    }
  }
}
```

### 3.6 session/context_delta（可选）

仅当 `DOWNSTREAM_ENABLE_CONTEXT_DELTA=true` 时发送。用于 pin、成员新增、成员删除等轻量上下文变更。

```json
{
  "jsonrpc": "2.0",
  "method": "session/context_delta",
  "params": {
    "sessionId": "<downstream-session-id>",
    "type": "member.added",
    "agentId": 2,
    "description": "前端成员描述",
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "<agenthub-session-id>"
    }
  }
}
```

### 3.7 file/apply_diff（可选）

仅当 `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF=true` 时发送。离线 apply diff 复用已保存的下游 `sessionId`，不会发送旧加载请求。

```json
{
  "jsonrpc": "2.0",
  "method": "file/apply_diff",
  "params": {
    "sessionId": "<downstream-session-id>",
    "fileChangeIds": ["<file-change-id>"],
    "changes": [
      {
        "id": "<file-change-id>",
        "path": "src/app.ts",
        "patch": "@@ ..."
      }
    ],
    "_meta": {
      "source": "agenthub",
      "agenthubSessionId": "<agenthub-session-id>",
      "runId": "<agenthub-run-id>"
    }
  }
}
```

## 4. AgentGateway → AgentHub

### 4.1 session/update

用于文本流式输出。`_meta.runId` 必填，`_meta.agentId` 用于 speaker 归属。

`_meta` 读取优先级：`params._meta` > `params.update._meta`。推荐将 `_meta` 放在 `params` 顶层。

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/update",
  "params": {
    "_meta": {
      "runId": "<agenthub-run-id>",
      "agentId": "2"
    },
    "update": {
      "text": "阶段性回复文本",
      "sessionUpdate": "agent_message_stop"
    }
  }
}
```

AgentHub 行为：

- 收到 `text` 后生成 `message.delta`。
- `sessionUpdate` 为 `"agent_message_stop"` 或 `"stop"` 时生成 `message.completed`。
- 缺少 `_meta.runId` 时响应 `RUN_ID_REQUIRED`，不落库。

### 4.2 session/event

用于结构化事件，例如文件变更、artifact、git push、run 终态等。`params._meta.runId` 必填。

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "session/event",
  "params": {
    "type": "artifact.upsert",
    "payload": {
      "artifactKey": "run-summary",
      "kind": "markdown",
      "title": "执行摘要",
      "content": "# Summary"
    },
    "_meta": {
      "runId": "<agenthub-run-id>",
      "agentId": "2"
    }
  }
}
```

AgentHub ack：

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "result": { "ok": true }
}
```

错误示例：

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "error": {
    "code": "RUN_ID_REQUIRED",
    "message": "RUN_ID_REQUIRED"
  }
}
```

### 4.3 不支持的旧格式

项目未上线，不保留旧格式兼容。当前代码中 `session/event` 处理路径强制要求：

1. `method` 必须是 `"session/event"`，否则事件被丢弃（`"session/update"` 除外）。
2. `_meta.runId` 必填，缺失即返回 `RUN_ID_REQUIRED`。
3. `_meta.agentId` 为 speaker 唯一来源。

以下格式**已不再有效**：

```json
{
  "type": "message.completed",
  "runId": "<agenthub-run-id>",
  "speaker": 2,
  "payload": { "text": "..." }
}
```

以下 JSON-RPC 格式也**不再有效**（`runId` 和 `speaker` 在 `params` 顶层而不是 `_meta` 中）：

```json
{
  "method": "session/event",
  "params": {
    "runId": "<agenthub-run-id>",
    "speaker": 2,
    "type": "message.completed",
    "payload": { "text": "..." }
  }
}
```

必须改为 `_meta.runId` 和 `_meta.agentId`。详见 §4.2。

## 5. 当前兼容矩阵

| ACP 方法 | 默认状态 | 方向 | 角色 | 说明 |
|---|---|---|---|---|
| `initialize` | 启用 | AgentHub → 下游 | **Request** | 每次新连接后固定发送，等待响应。 |
| `session/new` | 启用 | AgentHub → 下游 | **Request** | 默认建新下游 session，等待返回 `sessionId`。 |
| `session/prompt` | 启用 | AgentHub → 下游 | **Request** | 顶层只含 `sessionId`、`prompt`、`_meta`；已有 session 直接靠该字段恢复。 |
| `session/cancel` | 启用 | AgentHub → 下游 | **Notification** | 带 `sessionId`、`runId` 和 `_meta`。 |
| `session/context_delta` | 可选 | AgentHub → 下游 | **Notification** | `DOWNSTREAM_ENABLE_CONTEXT_DELTA=true` 后启用。 |
| `session/update` | 入站启用 | 下游 → AgentHub | Request | 需要 `_meta.runId`，可带 `_meta.agentId`。 |
| `session/event` | 入站启用 | 下游 → AgentHub | Request | 需要 `_meta.runId`，可带 `_meta.agentId`。 |
| `file/apply_diff` | 可选 | AgentHub → 下游 | **Notification** | `DOWNSTREAM_ENABLE_FILE_APPLY_DIFF=true` 后启用，复用已有 `sessionId`。 |

## 6. 下游后续需要补齐

- AgentGateway 或 Agent sandbox 在 `session/update` 中透传 `_meta.runId`。
- 结构化事件统一发 `session/event`，并把 run/speaker 放入 `_meta`。
- 若要启用实时成员/pin 更新，实现 `session/context_delta`。
- 若要启用一键应用 diff，实现 `file/apply_diff`。
