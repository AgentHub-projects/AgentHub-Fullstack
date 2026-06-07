# 后端-下游富文本接口

本文档只描述 AgentHub 后端与下游 Agent Runtime 之间的 ACP/Socket.IO 接入协议。浏览器前端 HTTP API 另见 [后端-前端富文本接口](frontend-rich-text-interface.md)。

相关源码：

- `shared/src/downstream.ts`：`DownstreamPromptInput`
- `shared/src/hub.ts`：`HubMessagePartDto`
- `backend/src/modules/hub/services/downstream-orchestrator.service.ts`：ACP 连接、`session/prompt`、`session/update` 处理

## 1. 协议总览

AgentHub 后端通过 Socket.IO 连接下游，并使用 JSON-RPC 2.0 风格 ACP 方法。

连接建立流程：

1. `initialize`
2. `session/load` 或 `session/new`
3. `session/prompt`

当前下游约定：

- 后端只通过 `session/prompt.params.prompt[0].text` 给下游传递本轮任务和上下文。
- 附件、网页预览、引用不作为独立结构化入参传给下游，而是拼成 prompt 文本。
- 图片、文件、网页和 artifact 都使用 URL。
- 下游业务回传使用 `session/update`，返回消息文本、一个富文本 part 或一个结构化更新。
- 下游不传 AgentHub 后端内部产物字段，也不传任何 artifact 去重字段。
- 下游不传 `deploy_status`。
- 不使用 `artifact.chunk`、`artifact.complete`。

## 2. 后端发给下游：session/prompt

后端发送的 ACP 请求形态如下：

```json
{
  "jsonrpc": "2.0",
  "id": "acp-auto-id",
  "method": "session/prompt",
  "params": {
    "sessionId": "downstream-session-id",
    "prompt": [
      {
        "type": "text",
        "text": "# AgentHub Request (incremental)\n\n## Current Message Context\n用户本轮消息包含以下资源，请按 URL 获取需要的内容：\n\n图片：页面截图\nurl: https://cdn.example.com/screenshot.png\nmimeType: image/png\nsizeBytes: 143200\n\n文件：需求附件.pdf\nurl: https://cdn.example.com/spec.pdf\nmimeType: application/pdf\nsizeBytes: 204800\n\n网页预览：需求文档\nurl: https://example.com/spec\ndescription: 页面修改需求\n\n引用：1. assistant:frontend-agent\n被引用的消息或 part 文本\n\n## Current User Request\n请根据截图和需求文档修改页面"
      }
    ],
    "_meta": {
      "source": "agenthub",
      "agentId": "1",
      "runId": "agenthub-run-id",
      "mentionedAgentIds": ["2", "3"]
    }
  }
}
```

关键字段：

- `params.sessionId`：下游自己的 session id。
- `params.prompt`：当前固定为一个 text part，完整上下文和用户请求都在 `text` 里。
- `_meta.runId`：本轮 AgentHub run id；下游回传必须原样带回。
- `_meta.agentId`：本轮调度下游的 AgentHub agent id。
- `_meta.mentionedAgentIds`：本轮目标或提及的 Agent。
- 不传 `agenthubSessionId`、`messageId`、`contextSnapshotId` 等 AgentHub 后端内部业务 ID。

## 3. prompt 文本结构

当前 prompt 文本由后端拼接，结构如下：

```text
# AgentHub Request (incremental)

## Session Context
历史摘要或上下文快照

## Mentioned Agents
- frontend-agent (2)
- backend-agent (3)

## Available Worker Agents
- 2: 前端实现 Agent
- 3: 后端实现 Agent

## Current Message Context
用户本轮消息包含以下资源，请按 URL 获取需要的内容：

图片：页面截图
url: https://cdn.example.com/screenshot.png
mimeType: image/png
sizeBytes: 143200

文件：需求附件.pdf
url: https://cdn.example.com/spec.pdf
mimeType: application/pdf
sizeBytes: 204800

网页预览：需求文档
url: https://example.com/spec
description: 页面修改需求

引用：1. assistant:frontend-agent
被引用的消息或 part 文本

## Current User Request
请根据截图和需求文档修改页面
```

约定：

- `Current Message Context` 是提示词文本，不是下游 API 的独立 JSON 参数。
- 下游只需要读取 prompt 里的 URL、标题、类型、可选 MIME 和大小信息。
- 后端内部产物字段不会作为下游输入传递。

## 4. 下游回传消息：session/update

下游使用 `session/update` 返回助手消息，并通过 `sessionUpdate` 区分增量片段和最终落库时机。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "text": "正在分析页面结构..."
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "sessionUpdate": "agent_message_stop",
      "text": "已完成分析。\n\n```tsx\nexport default function Page() {}\n```"
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

要求：

- `params._meta.runId` 必填。
- `params._meta.agentId` 建议传 AgentHub agent id。
- `update.sessionUpdate` 必填，取值为 `agent_message_chunk` 或 `agent_message_stop`。
- `agent_message_chunk` 表示增量片段；后端记录并按增量时机转发给前端。
- `agent_message_stop` 表示当前助手消息结束；后端在这个时机落库完整 assistant 消息，并转发最终消息给前端。
- 下游转发到前端的时机与后端落库/记录时机一致，不绕过后端持久化链路。
- run 完成由 `session/prompt` 的 JSON-RPC result `stopReason` 触发。

## 5. 下游回传富文本 parts

富文本 part 放在 `session/update.params.update.parts` 里。每次回传只放一个 part。

### link_preview

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "parts": [
        {
          "type": "link_preview",
          "title": "参考文档",
          "url": "https://example.com/docs"
        }
      ]
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

### image

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "parts": [
        {
          "type": "image",
          "title": "页面截图",
          "url": "https://cdn.example.com/images/screenshot.png"
        }
      ]
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

### file

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "parts": [
        {
          "type": "file",
          "title": "需求附件.pdf",
          "url": "https://cdn.example.com/files/spec.pdf",
          "metadata": {
            "mimeType": "application/pdf",
            "sizeBytes": 204800
          }
        }
      ]
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

### artifact

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "update": {
      "parts": [
        {
          "type": "artifact",
          "title": "执行摘要",
          "url": "https://cdn.example.com/artifacts/run-summary.md"
        }
      ]
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

字段规则：

- 下游必须传 `type`。
- 下游不要传 `id`；后端标准化为前端 `HubMessagePartDto` 时生成 part id。
- `image/file/link_preview/artifact` 必须有 `url`。
- `title` 建议传，便于前端展示卡片标题。
- `mimeType`、`sizeBytes` 只作为可选展示字段。
- 只有真实 agent 输出才传 `update.text`；不要为了卡片补说明性文字。
- 纯 `parts` 回传不带 `sessionUpdate`；后端收到后直接落库为富文本消息，并转发给前端。
- 下游不要传 AgentHub 后端内部产物字段。
- 下游不要传 artifact 去重字段；默认不会重复上报。
- 禁止下游传二进制、base64 或大段内联文件内容。
- `deploy_status` 暂不对下游开放。

当前实现备注：

- 后端当前已消费 `text/sessionUpdate/_meta`；`agent_message_stop` 是完整消息落库和最终转发时机。
- `update.parts` 是富文本下游接入的目标字段；实现时应标准化为前端 `HubMessagePartDto`，落库后通过实时通道转发给前端。

## 6. 下游结构化更新：session/update

结构化更新同样使用 `session/update`，通过 `update.type` 标识更新类型。

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "runId": "agenthub-run-id",
    "update": {
      "type": "file.change",
      "speaker": "2",
      "payload": {}
    },
    "_meta": {
      "source": "downstream",
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

要求：

- 必须能解析到 `runId`。
- `update.type` 必填。
- `update.speaker` 或 `_meta.agentId` 建议传 AgentHub agent id。
- 下游默认已完成去重，不需要额外去重字段。

## 7. file.change

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "downstream-session-id",
    "runId": "agenthub-run-id",
    "update": {
      "type": "file.change",
      "speaker": "2",
      "payload": {
        "path": "src/app/page.tsx",
        "changeType": "modified",
        "language": "tsx",
        "before": {
          "content": "old",
          "truncated": false
        },
        "after": {
          "content": "new",
          "truncated": false
        },
        "patch": "@@ -1 +1 @@\n-old\n+new\n",
        "stats": {
          "additions": 1,
          "deletions": 1
        }
      }
    },
    "_meta": {
      "runId": "agenthub-run-id",
      "agentId": "2"
    }
  }
}
```

要求：

- `path` 必填。
- `patch` 或 `before/after content` 至少提供一种。
- `changeType` 支持 `added/modified/deleted/renamed`；未知值按 `modified` 处理。
- 文件变更用于右侧 Diff 面板；聊天流自动派生 diff part 属于后续补齐项。

## 8. run 终态

run 终态保持和当前代码一致，不通过下游 `session/update` 结构化更新上报。

完成由 `session/prompt` 的 JSON-RPC result 触发：

```json
{
  "jsonrpc": "2.0",
  "id": "acp-auto-id",
  "result": {
    "stopReason": "end_turn"
  }
}
```

失败由 JSON-RPC error 或连接错误触发：

```json
{
  "jsonrpc": "2.0",
  "id": "acp-auto-id",
  "error": {
    "code": "DOWNSTREAM_RUN_FAILED",
    "message": "依赖安装失败"
  }
}
```

取消由 AgentHub 后端取消流程处理。下游收到取消后停止当前任务即可，不需要额外上报取消更新。

## 9. 下游验收

- `session/prompt.params.prompt[0].text` 中包含用户请求、引用、附件 URL 和网页 URL。
- 下游输入中不包含 AgentHub 后端内部产物字段。
- 文本消息按 `agent_message_chunk` / `agent_message_stop` 区分增量转发和最终落库。
- `session/update.params.update.parts` 每次只包含一个 part。
- `session/update.params.update.parts[0]` 中的资源类 part 都带 `url`。
- 纯 `parts` 回传收到后直接落库为富文本消息，并转发给前端。
- 下游不传 artifact 去重字段，默认不会重复上报。
- `file.change` 通过 `session/update.params.update` 回传。
- run 完成通过 `session/prompt` 的 JSON-RPC result `stopReason` 触发。
- 不传 `deploy_status`。
- 缺少 `runId` 的业务回传会被后端拒绝。
