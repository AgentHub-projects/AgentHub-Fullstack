# AgentHub 与真实下游 Agent 传输协议

版本：v1.0  
日期：2026-06-02  
状态：按当前代码实现整理

## 1. 实现依据

本文档描述 AgentHub 后端与真实下游 Agent/Orchestrator 的实际传输协议，依据当前代码实现整理，优先级高于早期设计草案。

主要实现文件：

- `backend/src/modules/hub/services/downstream-orchestrator.service.ts`
- `backend/src/modules/hub/services/event.service.ts`
- `backend/src/modules/hub/types/downstream-orchestrator.types.ts`
- `shared/src/downstream.ts`

## 2. 角色边界

AgentHub 后端负责：

- 接收前端用户消息，创建 `agent_runs`。
- 构造上下文快照并发送给下游 Orchestrator。
- 主动连接真实下游 Orchestrator。
- 接收下游事件，归一化后落库。
- 派生写入 `messages`、`file_changes`、`artifacts`。
- 向前端 WebSocket 广播更新。

真实下游 Agent/Orchestrator 负责：

- 暴露 Socket.IO WebSocket 服务。
- 接收 `session/new`、`session/load`、`session/prompt`、`session/cancel` 等命令。
- 维护真实执行环境和下游 session。
- 协调多个 worker Agent。
- 将文本、文件变更、artifact、git push、run 完成/失败等事件回传给 AgentHub。

## 3. 传输层

AgentHub 是 Socket.IO client，下游 Orchestrator 是 Socket.IO server。

连接地址由环境变量提供：

```env
DOWNSTREAM_ORCHESTRATOR_WS_URL=http://localhost:4000
```

AgentHub 连接方式：

```ts
io(DOWNSTREAM_ORCHESTRATOR_WS_URL, {
  transports: ["websocket"],
  reconnection: false
})
```

AgentHub 向下游发送消息使用 Socket.IO event：

```text
acp:message
```

AgentHub 接收下游消息时监听以下 event：

```text
acp:message
session/event
acp:event
message
```

建议下游统一使用 `acp:message`，并使用 JSON-RPC 2.0 envelope。

## 4. 通用消息 Envelope

推荐格式：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {}
}
```

AgentHub 也兼容简化事件格式：

```json
{
  "type": "message.completed",
  "runId": "agenthub-run-id",
  "seq": 1,
  "payload": {}
}
```

但生产联调建议使用 JSON-RPC request，因为 AgentHub 会在落库后返回 ack。

通用字段：

| 字段 | 方向 | 说明 |
| --- | --- | --- |
| `jsonrpc` | 双向 | 建议固定为 `"2.0"` |
| `id` | 双向 | request/response 关联 id |
| `method` | 双向 | 方法名 |
| `params` | 双向 | 方法参数 |
| `result` | 双向 | 成功响应 |
| `error` | 双向 | 失败响应 |
| `type` | 下游到 AgentHub | 简化事件格式中的事件类型 |
| `runId` | 下游到 AgentHub | AgentHub run id |
| `seq` | 下游到 AgentHub | run 内事件序号 |
| `payload` | 下游到 AgentHub | 事件载荷 |
| `speaker` | 下游到 AgentHub | AgentHub Agent 实例 id |

## 5. 连接初始化

Socket.IO 连接成功后，AgentHub 会发送 `initialize`。

AgentHub -> 下游：

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

下游可以返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentInfo": {
      "name": "real-orchestrator",
      "version": "1.0.0"
    }
  }
}
```

当前实现不会持久化 `initialize` 的 capabilities。联通判断主要依赖后续 `session/new` 或 `session/load` 成功。

## 6. 下游 Session 管理

AgentHub 会按 AgentHub session 复用下游 session。

### 6.1 创建下游 Session

如果当前 AgentHub session 没有可复用的 `downstreamSessionId`，AgentHub 会发送 `session/new`。

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "_meta": {
      "agentId": 1
    },
    "mcpServers": []
  }
}
```

下游必须返回 `result.sessionId`：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "downstream-session-xxx"
  }
}
```

### 6.2 加载下游 Session

如果已有可复用的 `downstreamSessionId`，AgentHub 会发送 `session/load`。

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/load",
  "params": {
    "sessionId": "downstream-session-xxx"
  }
}
```

下游返回：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "downstream-session-xxx",
    "activeRun": {
      "runId": "agenthub-run-id",
      "status": "running"
    }
  }
}
```

`activeRun` 可选。AgentHub 会读取其中的 `runId` 和 `status`，用于断线恢复。

### 6.3 超时

当前实现中，`session/new`、`session/load`、`run/status` 这类 request 默认超时时间为 3000ms。

## 7. 发送任务：session/prompt

用户发送消息后，AgentHub 创建 run，并向下游发送 `session/prompt`。

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "downstream-session-xxx",
    "runId": "agenthub-run-id",
    "agenthubSessionId": "agenthub-session-id",
    "messageId": "agenthub-user-message-id",
    "agentId": 1,
    "promptMode": "bootstrap",
    "prompt": [
      {
        "type": "text",
        "text": "@Frontend 请实现登录页"
      }
    ],
    "mentionedAgentIds": [2, 3],
    "messageContext": {},
    "contextSnapshotId": "context-snapshot-id",
    "orchestratorSystemPrompt": "system prompt...",
    "agents": [
      {
        "agentId": 2,
        "description": "frontend worker"
      }
    ],
    "pins": [],
    "memory": {
      "summary": "",
      "recent": [],
      "retrieved": []
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 下游 session id |
| `agenthubSessionId` | 是 | AgentHub session id |
| `runId` | 是 | AgentHub run id，下游回传事件必须使用这个 id |
| `messageId` | 是 | AgentHub 用户消息 id |
| `agentId` | 是 | 主 Orchestrator Agent 实例 id |
| `promptMode` | 是 | `"bootstrap"` 或 `"incremental"` |
| `prompt` | 是 | 当前用户任务，当前只发送 text part |
| `mentionedAgentIds` | 是 | 用户 @ 或会话成员 Agent 实例 id |
| `messageContext` | 是 | 附件、网页预览、引用上下文等 |
| `contextSnapshotId` | bootstrap 时可有 | AgentHub 上下文快照 id |
| `orchestratorSystemPrompt` | 可选 | Orchestrator 模板系统提示词 |
| `agents` | 可选 | 当前群聊 worker Agent 简介 |
| `pins` | bootstrap 时可有 | pinned 上下文 |
| `memory` | bootstrap 时可有 | 摘要、最近上下文、向量召回上下文 |

`promptMode` 规则：

- `bootstrap`：新下游 session 或需要重新注入上下文时发送，包含上下文。
- `incremental`：复用已有下游 session 时发送，只包含当前消息和 `messageContext`。

当前实现发送 `session/prompt` 后不会等待下游响应，AgentHub 会直接将 run 标记为 `running`。下游后续应通过事件流上报过程和结果。

如果下游随后返回带 `stopReason` 的 JSON-RPC response，AgentHub 会把 run 视为完成：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "stopReason": "end_turn"
  }
}
```

## 8. 下游事件回传：session/event

推荐所有关键事件都使用 JSON-RPC request：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 1,
    "type": "message.completed",
    "speaker": 2,
    "payload": {
      "text": "我已完成前端实现。"
    }
  }
}
```

AgentHub 成功处理后返回 ack：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "result": {
    "ok": true
  }
}
```

处理失败时返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "error": {
    "code": "EVENT_SEQ_OUT_OF_ORDER",
    "message": "EVENT_SEQ_OUT_OF_ORDER"
  }
}
```

### 8.1 事件字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `runId` | 是 | AgentHub run id。当前实现不读取 `agenthubRunId` |
| `seq` | 建议 | run 内事件序号。传了就必须递增 |
| `type` / `eventType` | 是 | 事件类型 |
| `speaker` | 多 Agent 输出时必填 | AgentHub Agent 实例 id |
| `payload` | 是 | 事件载荷 |

`speaker` 可出现在以下位置，AgentHub 会按顺序读取：

1. `params.speaker`
2. `params.payload.speaker`
3. envelope 顶层 `speaker`

## 9. 支持的事件类型

### 9.1 message.delta

流式文本片段。

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 1,
    "type": "message.delta",
    "speaker": 2,
    "payload": {
      "text": "正在分析项目结构..."
    }
  }
}
```

AgentHub 会将同一 run、同一 speaker 的 delta 缓存在内存里，等 `message.completed` 后持久化为 assistant message。

### 9.2 message.completed

完整 Agent 回复。

```json
{
  "jsonrpc": "2.0",
  "id": 1002,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 2,
    "type": "message.completed",
    "speaker": 2,
    "payload": {
      "text": "已完成登录页实现。",
      "parts": []
    }
  }
}
```

`payload.text`、`payload.content`、`payload.message`、`payload.delta` 都可被识别为文本来源，推荐使用 `text`。

可选 `parts` 可携带富文本片段，例如 diff、artifact、link preview 等。

### 9.3 file.change

文件变更快照。

```json
{
  "jsonrpc": "2.0",
  "id": 1003,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 3,
    "type": "file.change",
    "speaker": 2,
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
      "stats": {
        "additions": 1,
        "deletions": 1
      },
      "metadata": {}
    }
  }
}
```

约束：

- `path` 必填。
- 必须至少提供 `patch` 或 before/after content。
- `changeType` 支持：`added`、`modified`、`deleted`、`renamed`。其他值会按 `modified` 处理。
- `oldPath` 可用于 rename。

### 9.4 artifact.upsert

创建或更新 artifact。

```json
{
  "jsonrpc": "2.0",
  "id": 1004,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 4,
    "type": "artifact.upsert",
    "speaker": 2,
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

支持的 `kind`：

```text
markdown
text
html
pdf
docx
pptx
image
archive
log
other
```

### 9.5 artifact.chunk

当前实现中 chunk 做了简化处理，主要用于累加文本内容。

```json
{
  "jsonrpc": "2.0",
  "id": 1005,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 5,
    "type": "artifact.chunk",
    "payload": {
      "artifactKey": "large-log",
      "content": "chunk text"
    }
  }
}
```

### 9.6 artifact.complete

标记 artifact 完成。

```json
{
  "jsonrpc": "2.0",
  "id": 1006,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 6,
    "type": "artifact.complete",
    "speaker": 2,
    "payload": {
      "artifactKey": "preview",
      "final": true
    }
  }
}
```

### 9.7 git.push.completed

用于通知 AgentHub 最新成功 push 的 commit。部署前置检查依赖此事件。

```json
{
  "jsonrpc": "2.0",
  "id": 1007,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 7,
    "type": "git.push.completed",
    "payload": {
      "commitSha": "abcdef1234567890",
      "branch": "main",
      "remoteUrl": "https://github.com/acme/agenthub"
    }
  }
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `commitSha` | 是 | 最新成功 push 的 commit sha |
| `branch` | 否 | 分支名 |
| `remoteUrl` | 否 | 远端仓库 URL |

AgentHub 会写入 session metadata：

- `latestSuccessfulPushCommitSha`
- `latestSuccessfulPushBranch`
- `latestSuccessfulPushRemoteUrl`
- `latestSuccessfulPushRunId`

### 9.8 diff.apply.completed

下游成功应用 Diff 后回传。

```json
{
  "jsonrpc": "2.0",
  "id": 1008,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 8,
    "type": "diff.apply.completed",
    "payload": {
      "fileChangeIds": ["file-change-id"],
      "message": "applied"
    }
  }
}
```

### 9.9 diff.apply.failed

下游应用 Diff 失败或冲突后回传。

```json
{
  "jsonrpc": "2.0",
  "id": 1009,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 9,
    "type": "diff.apply.failed",
    "payload": {
      "fileChangeIds": ["file-change-id"],
      "status": "conflict",
      "message": "patch conflict",
      "conflicts": [
        {
          "path": "src/app/page.tsx"
        }
      ]
    }
  }
}
```

`status` 为 `conflict` 或 `conflicts` 非空时，AgentHub 会将文件变更标记为冲突。

### 9.10 run.completed

run 成功完成。

```json
{
  "jsonrpc": "2.0",
  "id": 1010,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 10,
    "type": "run.completed",
    "payload": {
      "finalMessage": "任务完成。",
      "usage": {
        "inputTokens": 1000,
        "outputTokens": 500
      }
    }
  }
}
```

AgentHub 收到后会将 run 标记为 completed。

### 9.11 run.failed

run 失败。

```json
{
  "jsonrpc": "2.0",
  "id": 1011,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 11,
    "type": "run.failed",
    "payload": {
      "message": "sandbox command failed"
    }
  }
}
```

AgentHub 收到后会将 run 标记为 failed，错误码固定为 `DOWNSTREAM_RUN_FAILED`。

## 10. 兼容 session/update

AgentHub 兼容下游发送 `session/update`，会转换为 `message.delta` 或 `message.completed`。

下游 -> AgentHub：

```json
{
  "jsonrpc": "2.0",
  "id": 2001,
  "method": "session/update",
  "params": {
    "_meta": {
      "agentId": 2
    },
    "update": {
      "text": "流式文本",
      "sessionUpdate": "agent_message_stop"
    }
  }
}
```

处理规则：

- `update.text` 或 `update.content.text` 会作为文本。
- `_meta.agentId` 会作为 `speakerAgentId`。
- `sessionUpdate` 为 `agent_message_stop` 或 `stop` 时，AgentHub 会生成 `message.completed`。

## 11. AgentHub 发给下游的控制命令

### 11.1 取消 run

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "session/cancel",
  "params": {
    "runId": "agenthub-run-id"
  }
}
```

AgentHub 会先把本地 run 标记为 cancelled，再向下游发送 cancel。

### 11.2 应用 Diff

用户点击一键应用 Diff 时，AgentHub 向下游发送：

```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "file/apply_diff",
  "params": {
    "sessionId": "downstream-session-xxx",
    "agenthubSessionId": "agenthub-session-id",
    "runId": "agenthub-run-id",
    "fileChangeIds": ["file-change-id"],
    "changes": [
      {
        "id": "file-change-id",
        "path": "src/app/page.tsx",
        "patch": "@@ ...",
        "beforeContent": "old",
        "afterContent": "new"
      }
    ]
  }
}
```

下游执行后应回传 `diff.apply.completed` 或 `diff.apply.failed`。

### 11.3 上下文增量

当用户 pin 消息、添加成员、删除成员时，AgentHub 会向已有连接发送 `session/context_delta`。

Pin 更新：

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "agenthubSessionId": "agenthub-session-id",
    "type": "pin.updated",
    "messageId": "message-id",
    "partId": "optional-part-id",
    "pinned": true
  }
}
```

成员添加：

```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "agenthubSessionId": "agenthub-session-id",
    "type": "member.added",
    "agentId": 2,
    "description": "frontend worker"
  }
}
```

成员删除：

```json
{
  "jsonrpc": "2.0",
  "id": 24,
  "method": "session/context_delta",
  "params": {
    "sessionId": "downstream-session-xxx",
    "agenthubSessionId": "agenthub-session-id",
    "type": "member.deleted",
    "agentId": 2
  }
}
```

## 12. 断线恢复

AgentHub 不启用 Socket.IO 自动重连。

如果连接断开且当前有 active run，AgentHub 会：

1. 重新连接下游。
2. 使用已有 `downstreamSessionId` 发送 `session/load`。
3. 调用 `run/status`。

AgentHub -> 下游：

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "run/status",
  "params": {
    "runId": "agenthub-run-id"
  }
}
```

下游返回：

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "result": {
    "run": {
      "runId": "agenthub-run-id",
      "status": "running"
    }
  }
}
```

状态处理：

| 下游状态 | AgentHub 行为 |
| --- | --- |
| `completed` / `ready` / `success` | 标记 run completed |
| `failed` / `error` | 标记 run failed |
| 其他值 | 保持 running |

如果无法恢复，AgentHub 会标记 run failed，错误码为 `DOWNSTREAM_DISCONNECTED`。

## 13. 事件序号与幂等

如果下游提供 `seq`：

- AgentHub 要求同一个 run 内按序递增。
- 重复的 `runId + seq` 会被认为是重复事件。
- `message.delta` 对低于当前 expected seq 的旧片段会生成 transient event，不重复持久化。
- 乱序会返回 `EVENT_SEQ_OUT_OF_ORDER`。

建议下游为关键事件提供连续递增的 `seq`。

## 14. 取消后的事件处理

如果 AgentHub 本地 run 已是 `cancelled`：

- 下游继续发送非 `agenthub_backend` 来源事件时，AgentHub 会拒绝。
- 错误为 `RUN_ALREADY_CANCELLED`。

## 15. 最小可联调流程

1. AgentHub 连接下游 Socket.IO server。
2. AgentHub 发送 `initialize`。
3. AgentHub 发送 `session/new`。
4. 下游返回 `result.sessionId`。
5. AgentHub 发送 `session/prompt`。
6. 下游回传 `message.completed`。
7. 下游回传 `file.change`。
8. 下游回传 `artifact.upsert`。
9. 下游回传 `git.push.completed`。
10. 下游回传 `run.completed`。

示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "runId": "agenthub-run-id",
    "seq": 1,
    "type": "message.completed",
    "speaker": 2,
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
    "runId": "agenthub-run-id",
    "seq": 2,
    "type": "file.change",
    "speaker": 2,
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
    "runId": "agenthub-run-id",
    "seq": 3,
    "type": "artifact.upsert",
    "speaker": 2,
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
    "runId": "agenthub-run-id",
    "seq": 4,
    "type": "git.push.completed",
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
    "runId": "agenthub-run-id",
    "seq": 5,
    "type": "run.completed",
    "payload": {
      "finalMessage": "任务完成。"
    }
  }
}
```

## 16. 下游必须满足的要求

真实下游 Orchestrator 至少需要：

- 支持 Socket.IO WebSocket。
- 能响应 `session/new`，返回 `result.sessionId`。
- 能接收 `session/prompt`。
- 回传事件时必须使用 AgentHub 的 `runId`。
- 多 Agent 输出必须提供 `speaker`，值为 AgentHub Agent 实例 id。
- 文件变更必须提供 `path`，且提供 `patch` 或 before/after content。
- 关键事件建议使用 JSON-RPC request，并等待 AgentHub ack。
- 如果要支持部署，完成 push 后必须发送 `git.push.completed`，至少包含 `commitSha`。

建议额外支持：

- `session/load`
- `run/status`
- `session/cancel`
- `file/apply_diff`
- `session/context_delta`

## 17. 当前实现限制

- `initialize` 响应目前不落库。
- `session/prompt` 发送后 AgentHub 不等待下游 accepted 响应，会直接标记 running。
- `artifact.chunk` 当前是简化累加文本，不是完整二进制 chunk 合并协议。
- 真实 worker Agent 调度不在 AgentHub 内完成，由下游 Orchestrator 负责。
- 断线恢复依赖下游支持 `session/load` 和 `run/status`。
