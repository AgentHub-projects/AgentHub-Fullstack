# AgentHub 技术设计文档

版本：v0.1  
日期：2026-05-26  
定位：从零设计的工程实现方案，面向前后端、数据库、下游 Agent 协议对接。

## 1. 目标与边界

### 1.1 目标

AgentHub 是一个 Web 化的多 Agent 协作平台。第一版目标是完成：

- 前端工作台：对标 Codex 桌面端的信息结构，支持会话、流式输出、任务时间线、diff、Markdown、PDF、DOCX 等产物只读展示。
- 后端平台层：管理 session、message、agent run、event、artifact、file change、context 等状态，并将下游 Agent 的流式输出持久化后转发给前端。
- 两类 WebSocket：
  - 前端 WebSocket：后端向浏览器实时推送 session/run/event/artifact/context 状态。
  - 下游 Agent WebSocket：AgentHub 主动连接云端沙箱里的 Agent/Orchestrator，发送任务与历史上下文，接收流式输出、文件变更和 artifact。
- 上下文维护：同一个 session 内，后端用轻量 LLM 和 pgvector 实时维护轻量上下文。优先级为 pin > 最近 N 轮上下文 > pgvector 召回 > 结构化摘要。
- PostgreSQL 持久化：数据库作为唯一事实源，支持刷新页面后完整回放会话和任务过程。

### 1.2 明确不做

- 不实现下游 Agent 调度、工具调用、代码执行、沙箱文件系统操作。
- 第一版不做 diff 接受、拒绝、回滚、编辑和前端直连沙箱。
- 第一版按单用户、单后端实例设计，不做账号体系、权限体系、多租户、Redis 广播或横向扩展。
- 后端可以同时连接多个下游 Agent 实例，但由单个后端进程管理这些连接。

### 1.3 核心假设

- 下游 Agent 运行在真实云端沙箱环境中，可以修改沙箱内代码文件。
- 下游 Agent 会通过流式消息发送文本、推理过程、工具事件、file diff、patch、Markdown、PDF、DOCX 等 artifact。
- AgentHub 对下游 Agent 采用 ACP 思路，但先实现 JSON over WSS 的工程子集，后续可以升级到完整 ACP 二进制 MessageHeader。
- 上下文 LLM 与 embedding 均使用 OpenAI-compatible API。

## 2. Multica 参考与取舍

### 2.1 Multica 三层架构

Multica 的核心是“Web 控制面 + 后端任务队列 + Agent Daemon 运行时”。

- 前端：Next.js Web 应用，用户创建 issue/chat/task，通过 REST 写入后端，通过 WebSocket 接收实时任务状态和 agent 消息。
- 后端：Go API 服务，负责 workspace、agent、runtime、task、chat、message、artifact 等持久化；对前端提供 REST/WS；对 daemon 提供注册、心跳、任务领取、进度上报等接口。
- Agent Daemon：本地运行时，检测本机 Claude Code、Codex、Copilot CLI、OpenCode 等 agent CLI；从后端领取任务，创建隔离工作目录，启动 agent CLI，并把过程消息批量上报给后端。

Multica 的设计重点是把 agent 运行时从 Web 后端里分离出来。Daemon 是“执行器”，后端是“控制面和事实源”，前端是“观察和操作入口”。

### 2.2 对 AgentHub 的映射

AgentHub 不需要本地 Agent Daemon，因为执行发生在云端沙箱。对应关系如下：

| Multica | AgentHub 第一版 |
| --- | --- |
| Next.js 前端 | Web Workbench 前端 |
| Go 后端 | AgentHub 后端平台层 |
| Agent Daemon | Downstream Agent Bridge，由后端主动 WSS 连接下游 Agent |
| 本地 CLI 和工作目录 | 云端沙箱 Agent/Orchestrator 和真实文件系统 |
| daemon HTTP claim/report | 下游 WSS `run.start` / stream events / ack |
| task message timeline | run event timeline |
| runtime registry | agent instance registry |

### 2.3 值得借鉴的点

- 前端不要直接相信流式内存态，所有实时事件都应能从数据库回放。
- 任务过程要拆成稳定事件类型，例如 queued、running、message、artifact、completed、failed。
- 浏览器通过 WS 收实时事件，但创建会话、发送消息、读取历史仍走 REST。
- 下游执行器输出不要直接绑定 UI，要先归一化为平台事件，再由前端渲染。
- 前端 UI 可以参考 Multica 的 `ChatWindow`、`ChatMessageList`、`TaskStatusPill`、`useRealtimeSync`：发送消息先 optimistic update，运行中显示 live timeline，完成后由持久化 assistant message 接管。

### 2.4 不照搬的点

- 不做 daemon 主动注册和轮询领取任务。你的要求是 AgentHub 主动连接下游 Agent 地址。
- 不做 workspace、多用户、团队、issue 看板、agent teammate 等产品形态。
- 第一版不引入 Redis。单后端内直接用数据库事务加内存连接表即可。

参考资料：

- Multica 仓库：https://github.com/multica-ai/multica
- Multica CLI 与 Daemon 文档：https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md
- ACP 文档：https://acp.agentunion.cn/introduction/
- ACP LLM 完整说明：https://agentunion.cn/introduction/llms-full.txt

## 3. 总体架构

```mermaid
flowchart LR
  U["Browser Workbench"] <-->|"REST + Frontend WS"| B["AgentHub Backend"]
  B <-->|"SQL + pgvector"| DB[("PostgreSQL")]
  B <-->|"OpenAI-compatible Chat + Embedding"| LLM["Context LLM"]
  B -->|"WSS: run.start + context"| A1["Cloud Sandbox Agent 1"]
  A1 -->|"WSS stream: events, diff, artifacts"| B
  B -->|"WSS"| A2["Cloud Sandbox Agent 2"]
  A2 -->|"WSS stream"| B
  A1 --> FS1["Sandbox Files"]
  A2 --> FS2["Sandbox Files"]
```

### 3.1 后端职责

后端是平台事实源和协议桥接层：

- 接收用户消息，创建 session message 和 agent run。
- 在 run 启动前构造 context snapshot，并发送给下游 Agent。
- 主动连接一个或多个下游 Agent 实例。
- 接收下游流式消息，按 `run_id + seq` 幂等落库。
- 归一化 artifact、file diff、tool event、assistant delta。
- 实时广播给前端。
- 在消息、artifact、file change 变化后维护结构化摘要、context item 和向量索引。

### 3.2 前端职责

前端是只读工作台和交互入口：

- 会话列表、会话主时间线、运行状态、Agent 状态。
- Composer 发送用户任务。
- 中央区域展示聊天与 agent 过程。
- 右侧 inspector 展示 diff、artifact、文档、运行日志。
- 从 REST 拉历史快照，从 WS 接增量事件。

### 3.3 下游 Agent 职责

下游 Agent/Orchestrator 是执行者：

- 接收 `run.start`，读取任务、上下文和约束。
- 在云端沙箱真实执行代码修改、命令、分析等动作。
- 将过程和结果以协议事件流发送给 AgentHub。
- 文件内容可以留在沙箱内，第一版需要发送用于展示和持久化的 before/after 文件快照；patch 可选，用于提升 diff 展示效果。

### 3.4 后端与下游 Agent 对接分层

后端与下游 Agent 的对接不要直接写成一个巨大的 WebSocket 处理器。建议拆成以下层次：

```mermaid
flowchart TB
  R["RunService"] --> C["ContextSnapshotBuilder"]
  R --> M["DownstreamSessionManager"]
  M --> B["DownstreamAgentBridge"]
  B --> A["ProtocolAdapter"]
  A --> T["TransportClient"]
  T <-->|"Socket.IO / WSS"| D["Downstream Agent"]
  A --> N["EventNormalizer"]
  N --> I["EventIngestService"]
  I --> DB[("PostgreSQL")]
  I --> W["Frontend RealtimeGateway"]
```

- `TransportClient`：只负责连接、重连、收发原始帧。第一版至少支持 Socket.IO JSON-RPC profile，后续可加原生 WSS profile。
- `ProtocolAdapter`：把具体下游协议转成 AgentHub 内部统一命令和事件。
- `DownstreamSessionManager`：维护 AgentHub session 与下游 session 的绑定，决定调用 `session/new` 还是 `session/load`。
- `EventNormalizer`：把下游 frame 归一化为 `agent_events` 可以落库的事件。
- `EventIngestService`：唯一负责落库、幂等、派生 artifact/file change/message、广播前端。

落库操作全部放在 AgentHub 后端。下游 Agent 只负责执行和上报事件，不允许直接写 AgentHub 数据库。

## 4. 后端模块拆分

### 4.1 API 层

- `SessionController`
  - 创建 session、读取 session、列出 session。
  - 发送用户消息并启动 agent run。
- `RunController`
  - 查询 run 列表、run 详情、run events。
  - 取消 run 可以预留接口，第一版可返回未实现。
- `ArtifactController`
  - 查询 artifact 列表、详情、二进制内容、渲染结果。
- `AgentController`
  - 配置 agent 实例 endpoint、名称、能力、启停状态。
- `ContextController`
  - 查询当前 session context、context snapshot、pin 列表。

### 4.2 核心服务

- `SessionService`
  - 管理 session、message、pin。
  - 用户消息落库后触发 run 创建。
- `RunService`
  - run 状态机管理：queued -> connecting -> running -> completed/failed/cancelled。
  - 绑定 user message、assistant message、context snapshot、downstream run id。
- `DownstreamAgentBridge`
  - 主动连接下游 Agent。
  - 不直接写数据库，只负责连接生命周期、请求发送、响应等待和断线通知。
  - 对外暴露 `initializeAgent`、`ensureDownstreamSession`、`startPrompt`、`cancelPrompt`。
- `ProtocolAdapter`
  - 屏蔽下游协议差异。
  - 第一版重点实现 `north-socketio-jsonrpc` profile：Socket.IO path `/socket.io`、namespace `/acp`、event `acp:message`、JSON-RPC 2.0。
  - 后续可并行支持 `agenthub-wss-json` profile。
- `DownstreamSessionManager`
  - 维护 `session_id + agent_id + agent_instance_id` 到下游 `sessionId` 的映射。
  - 新 session 首次发送任务时调用 `session/new`。
  - 已有绑定时优先调用 `session/load`，再调用 `session/prompt`。
- `EventIngestService`
  - 负责事件幂等、序号检查、落库、派生写入 artifact/file change/message delta。
  - 成功落库后广播前端 WS。
- `ArtifactService`
  - 处理 artifact 元数据、chunk、OSS object、render。
  - Markdown 直接存 text；PDF/DOCX/image/archive 上传到阿里云 OSS；DOCX 后端转 HTML；PDF 前端渲染。
- `ContextService`
  - 写入 context item、生成 embedding、pgvector 召回。
  - 维护 session summary。
  - run 启动前生成 context snapshot。
- `RealtimeGateway`
  - 管理前端 WebSocket 连接、session 订阅和事件推送。
  - 支持 `since_seq` 回放，避免刷新或短线丢事件。
- `OpenAICompatibleClient`
  - 封装 chat completions 和 embeddings。

### 4.3 状态机

`agent_runs.status`：

- `queued`：后端已创建 run，等待构造上下文。
- `context_building`：正在读取 pin/recent/vector/summary。
- `connecting`：正在连接下游 Agent。
- `running`：下游 Agent 已确认开始执行。
- `completed`：正常结束。
- `failed`：下游错误、协议错误或连接异常。
- `cancelled`：用户取消，第一版可预留。

### 4.4 Agent 对接核心对象

后端内部建议统一成以下对象，避免业务层直接依赖 Socket.IO 或 WSS 细节：

```ts
type DownstreamProfile = "north-socketio-jsonrpc" | "agenthub-wss-json";

interface DownstreamAgentConfig {
  agentId: string;
  instanceId?: string;
  endpointUrl: string;
  profile: DownstreamProfile;
  cwd: string;
  auth?: {
    type: "none" | "bearer";
    tokenRef?: string;
  };
  meta?: {
    agentId?: string;
    agentGroupId?: string;
    sandboxCwd?: string;
    leaderTemplateSelector?: string;
    sandboxTemplateSelector?: string;
  };
}

interface NormalizedAgentEvent {
  runId: string;
  sessionId: string;
  seq: number;
  type: string;
  visibility: "public" | "debug" | "internal";
  payload: Record<string, unknown>;
  occurredAt?: string;
}
```

业务层只和 `NormalizedAgentEvent` 交互。具体下游发的是 JSON-RPC、Socket.IO event，还是原生 WSS frame，都由 adapter 处理。

## 5. 前端工作台设计

### 5.1 信息架构

对标 Codex 桌面端，同时参考 Multica 前端的聊天流和任务时间线组织方式，做成 Web Workbench：

- 左侧：session 列表、Agent 实例状态、搜索入口。
- 中央：当前 session 的消息流和 run timeline。
- 右侧：Artifact Inspector，显示当前选中的 diff、文件、Markdown、PDF、DOCX、日志。
- 底部：composer，发送任务、选择目标 Agent。

第一版不要照搬 Multica 的 workspace、issue、team、inbox 信息架构。AgentHub 的主体验应围绕“一个 session 内的用户任务、Agent 执行流、文件变更、artifact 结果”展开。

### 5.2 页面状态

- 初次进入 session：
  - REST 拉 session、messages、active run、artifacts。
  - 建立前端 WS，发送 `session.subscribe`。
  - 如果有 active run，带 `since_seq` 拉缺失事件。
- 流式输出：
  - `message.delta` 合并到当前 assistant block。
  - `tool.call/tool.result` 进入可折叠运行日志。
  - `file.change` 更新 diff 文件树。
  - `artifact.upsert/chunk/complete` 更新右侧 inspector。
- 刷新恢复：
  - 页面只依赖 REST 快照和 DB event 回放，不依赖内存。

### 5.3 Diff 展示

第一版只读：

- 左侧文件树按 path 聚合 file changes。
- 中间支持 unified diff，后续可加 split diff。
- 支持新增、删除、修改、重命名状态。
- hunk 支持定位、折叠、复制 patch。
- patch 解析失败时展示原始 patch 文本。

### 5.4 文档与 artifact 渲染

- Markdown：前端使用安全 Markdown 渲染，支持 GFM、代码块、表格。
- PDF：后端存储在阿里云 OSS，前端通过 `/api/artifacts/:id/content` 由后端鉴权后代理或签名跳转读取。
- DOCX：后端用转换器生成安全 HTML，存入 `artifact_renders`；前端展示转换结果，同时提供原始文件只读下载接口。
- 图片：第一版可展示 PNG/JPEG/WebP。
- 大文本日志：虚拟滚动，避免卡顿。

### 5.5 Multica 前端参考点

Multica 前端可以作为交互参考，重点参考以下模式：

- `ChatWindow`：把 session、message、pending task、agent 状态集中到一个工作区入口，发送消息时先做 optimistic update，避免用户发送后界面空白。
- `ChatMessageList`：主消息流只展示用户真正关心的内容；Agent 过程以 live timeline 嵌入 assistant 区域，完成后由持久化消息接管展示，避免同一内容重复出现。
- `TaskStatusPill`：运行中用紧凑状态条表达 queued/running/failed/completed，不把状态信息做成大卡片。
- `useRealtimeSync`：WebSocket 事件先写入前端查询缓存，关键状态再 invalidate 让数据库快照兜底。长 run 的 `task:message` 类事件应直接追加缓存，避免每个 delta 都触发 refetch。
- Markdown 渲染、附件列表、复制按钮、失败消息折叠等细节可以参考，但视觉风格需要重新设计，避免直接复刻 Multica 的产品壳。

对应到 AgentHub：

| Multica 前端概念 | AgentHub UI 概念 |
| --- | --- |
| `ChatWindow` | Session Workbench |
| `pendingTask` | active agent run |
| `task:message` live timeline | `run.event` live timeline |
| `TaskStatusPill` | Run status strip |
| `AttachmentList` | Artifact strip / Inspector entry |
| `useRealtimeSync` | `useSessionRealtime` + query cache event reducer |

### 5.6 AgentHub 前端组件拆分

建议第一版拆成以下组件：

- `SessionRail`：左侧 session 列表、运行中状态点、更新时间。
- `AgentPicker`：选择目标 Agent 实例，显示在线、离线、错误状态。
- `SessionWorkbench`：当前 session 容器，负责 REST 初始加载和 WS 订阅。
- `MessageTimeline`：用户消息、assistant 消息、active run timeline。
- `RunStatusStrip`：紧凑展示 queued、context_building、connecting、running、completed、failed。
- `RunTimeline`：展示 `message.delta`、`tool.call`、`tool.result`、`file.change`、`artifact.*`。
- `ArtifactInspector`：右侧详情区，按 tab 展示 Diff、Preview、Logs、Context。
- `DiffViewer`：基于 before/after 快照生成 unified diff；如果下游提供 patch，则优先使用 patch。
- `DocumentPreview`：Markdown/PDF/DOCX/image 只读预览。
- `Composer`：输入任务、选择 Agent、发送、停止。

### 5.7 前端状态策略

前端使用“REST 快照 + WS 增量 + 查询缓存 reducer”：

1. 进入 session 时，REST 拉取 `session detail`、`messages`、`runs`、`artifacts`、`file_changes`。
2. 建立 WS 后发送 `session.subscribe`，附带本地最后看到的 `seq`。
3. 收到 `run.event` 后，按 `runId + seq` 去重写入本地缓存。
4. `message.delta` 只更新当前 active assistant block。
5. `file.change` 更新文件树和 diff 缓存。
6. `artifact.*` 更新 inspector 列表和预览状态。
7. `run.completed/run.failed` 后 invalidate 当前 session 快照，确保与数据库最终状态一致。

这个策略参考 Multica 的实时同步做法，但要保留 AgentHub 的事件事实源：刷新页面后，UI 必须能完全从 PostgreSQL 重建。

## 6. REST API 初稿

### 6.1 Session

```http
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/{sessionId}
PATCH /api/sessions/{sessionId}
DELETE /api/sessions/{sessionId}
```

发送用户消息并启动 run：

```http
POST /api/sessions/{sessionId}/messages
Content-Type: application/json

{
  "content": "请实现登录页",
  "agentId": "uuid",
  "pinnedArtifactIds": [],
  "clientRequestId": "optional-idempotency-key"
}
```

返回：

```json
{
  "messageId": "uuid",
  "runId": "uuid",
  "status": "queued"
}
```

### 6.2 Run 和 Event

```http
GET /api/sessions/{sessionId}/runs
GET /api/runs/{runId}
GET /api/runs/{runId}/events?afterSeq=0&limit=500
POST /api/runs/{runId}/cancel
```

### 6.3 Artifact

```http
GET /api/sessions/{sessionId}/artifacts
GET /api/artifacts/{artifactId}
GET /api/artifacts/{artifactId}/content
GET /api/artifacts/{artifactId}/render
GET /api/runs/{runId}/file-changes
```

### 6.4 Agent

```http
GET  /api/agents
POST /api/agents
PATCH /api/agents/{agentId}
POST /api/agents/{agentId}/probe
```

### 6.5 Context

```http
GET /api/sessions/{sessionId}/context
GET /api/runs/{runId}/context-snapshot
POST /api/messages/{messageId}/pin
DELETE /api/messages/{messageId}/pin
```

## 7. 前端 WebSocket 协议

连接：

```text
GET /ws/frontend
```

第一版单用户可以不做复杂鉴权。生产环境至少加一个固定 bearer token 或同源 cookie。

### 7.1 客户端消息

订阅 session：

```json
{
  "type": "session.subscribe",
  "requestId": "req-1",
  "payload": {
    "sessionId": "uuid",
    "afterSeq": 0
  }
}
```

取消订阅：

```json
{
  "type": "session.unsubscribe",
  "requestId": "req-2",
  "payload": {
    "sessionId": "uuid"
  }
}
```

心跳：

```json
{
  "type": "ping",
  "requestId": "req-3",
  "payload": {}
}
```

### 7.2 服务端消息

ACK：

```json
{
  "type": "ack",
  "requestId": "req-1",
  "payload": {
    "ok": true
  }
}
```

Run 事件：

```json
{
  "type": "run.event",
  "sessionId": "uuid",
  "runId": "uuid",
  "seq": 12,
  "payload": {
    "eventType": "message.delta",
    "visibility": "public",
    "data": {
      "role": "assistant",
      "text": "正在分析项目结构..."
    }
  }
}
```

Artifact 更新：

```json
{
  "type": "artifact.updated",
  "sessionId": "uuid",
  "runId": "uuid",
  "seq": 23,
  "payload": {
    "artifactId": "uuid",
    "kind": "markdown",
    "title": "实现说明.md",
    "final": false
  }
}
```

上下文更新提示：

```json
{
  "type": "context.updated",
  "sessionId": "uuid",
  "payload": {
    "summaryVersion": 5,
    "itemCount": 38
  }
}
```

错误：

```json
{
  "type": "error",
  "requestId": "req-1",
  "payload": {
    "code": "SESSION_NOT_FOUND",
    "message": "session not found"
  }
}
```

## 8. 下游 Agent WebSocket 协议初稿

### 8.1 设计原则

- AgentHub 主动连接下游 Agent endpoint，endpoint 可以是 Socket.IO namespace，也可以是原生 WSS。
- 采用 ACP 的会话通信思想：session、参与方、消息、流式输出。
- 第一版优先兼容 `north-acp-client(1).md` 里的 Socket.IO JSON-RPC 协议，同时保留 AgentHub 原生 WSS JSON envelope 作为更清晰的长期协议。
- 每个 run 内由下游 Agent 维护递增 `seq`，AgentHub 以 `runId + seq` 幂等落库。
- 下游 Agent 不直接操作 AgentHub 数据库，只通过协议上报事件。

### 8.2 协议 profile

第一版后端实现两个协议层概念：

| profile | 用途 | 传输 | 状态 |
| --- | --- | --- | --- |
| `north-socketio-jsonrpc` | 兼容当前下游 North ACP Client 文档 | Socket.IO `/acp` namespace + `acp:message` event + JSON-RPC 2.0 | 第一版优先实现 |
| `agenthub-wss-json` | AgentHub 自定义长期协议草案 | 原生 WSS + JSON envelope | 可作为 mock 和后续演进 |

当前下游文档定义了这些 JSON-RPC 方法：

- `initialize`
- `session/new`
- `session/load`
- `session/list`
- `session/prompt`
- `session/cancel`

该文档没有完整定义流式输出、文件快照、artifact 的通知事件。因此 AgentHub 需要在 `north-socketio-jsonrpc` adapter 中补充一个统一事件入口：下游通过 JSON-RPC request `session/event` 上报流式事件，AgentHub 响应 JSON-RPC result 作为 ack。低价值日志可以用 notification，但关键事件必须带 `id`。

### 8.3 North Socket.IO JSON-RPC profile

连接：

```text
Socket.IO path: /socket.io
Socket.IO namespace: /acp
event: acp:message
```

初始化：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1
  }
}
```

新建下游 session：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/workspace",
    "mcpServers": [],
    "_meta": {
      "agentId": "<agent-id>",
      "sandboxCwd": "/workspace",
      "leaderTemplateSelector": "agent",
      "sandboxTemplateSelector": "sandbox"
    }
  }
}
```

已有绑定时加载下游 session：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/load",
  "params": {
    "sessionId": "<downstream-session-id>",
    "cwd": "/workspace",
    "mcpServers": []
  }
}
```

发送 prompt：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/prompt",
  "params": {
    "sessionId": "<downstream-session-id>",
    "messageId": "<agenthub-message-id>",
    "prompt": [
      {
        "type": "text",
        "text": "用户当前任务"
      }
    ],
    "_meta": {
      "agentId": "<agent-id>",
      "agenthubRunId": "<agenthub-run-id>",
      "agenthubSessionId": "<agenthub-session-id>",
      "contextSnapshotId": "<context-snapshot-id>"
    }
  }
}
```

取消：

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "<downstream-session-id>"
  }
}
```

下游流式事件统一入口：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "session/event",
  "params": {
    "sessionId": "<downstream-session-id>",
    "agenthubSessionId": "<agenthub-session-id>",
    "agenthubRunId": "<agenthub-run-id>",
    "seq": 10,
    "type": "file.change",
    "visibility": "public",
    "payload": {}
  }
}
```

AgentHub 收到后完成落库，再返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "result": {
    "ackSeq": 10
  }
}
```

### 8.4 AgentHub WSS JSON profile

```text
wss://{agent-host}/acp/v1/ws
```

AgentHub 配置每个 Agent 实例：

```json
{
  "agentId": "uuid",
  "name": "codex-sandbox-agent",
  "endpointUrl": "wss://agent.example.com/acp/v1/ws",
  "authType": "bearer",
  "capabilities": ["code_edit", "shell", "diff", "artifact"]
}
```

### 8.5 通用 envelope

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "msg-uuid",
  "type": "run.start",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "agentId": "agent-uuid",
  "seq": 1,
  "timestamp": "2026-05-26T12:00:00.000Z",
  "payload": {}
}
```

字段说明：

- `id`：单条 frame id，用于 ack 和排障。
- `type`：消息类型。
- `sessionId`：AgentHub session id。
- `runId`：AgentHub run id。
- `agentId`：AgentHub 侧 agent id。
- `seq`：下游发往 AgentHub 的 run 内序号。AgentHub 发给下游的控制消息可以不带 seq。
- `payload`：具体消息体。

### 8.6 握手

AgentHub -> Agent：

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "hello-1",
  "type": "agenthub.hello",
  "timestamp": "2026-05-26T12:00:00.000Z",
  "payload": {
    "agentHubId": "agenthub-single-user",
    "supportedVersions": ["0.1"],
    "accepts": ["message.delta", "file.change", "artifact.upsert", "artifact.chunk", "artifact.complete"],
    "ackMode": "per_event"
  }
}
```

Agent -> AgentHub：

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "hello-ack-1",
  "type": "agent.hello_ack",
  "timestamp": "2026-05-26T12:00:01.000Z",
  "payload": {
    "agentName": "codex-sandbox-agent",
    "agentVersion": "0.1.0",
    "capabilities": ["code_edit", "shell", "diff", "markdown", "pdf", "docx"],
    "sandbox": {
      "id": "sandbox-123",
      "workspaceRoot": "/workspace/project",
      "readonlyToAgentHub": true
    }
  }
}
```

### 8.7 启动 run

AgentHub -> Agent：

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "run-start-1",
  "type": "run.start",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "agentId": "agent-uuid",
  "timestamp": "2026-05-26T12:00:02.000Z",
  "payload": {
    "task": {
      "messageId": "message-uuid",
      "content": "请实现登录页",
      "attachments": []
    },
    "context": {
      "snapshotId": "context-snapshot-uuid",
      "tokenBudget": 32000,
      "messages": [
        {
          "role": "user",
          "content": "历史用户消息"
        }
      ],
      "pinned": [],
      "retrieved": [],
      "summary": {
        "goals": [],
        "decisions": [],
        "constraints": [],
        "files": []
      }
    },
    "outputPolicy": {
      "sendDiff": true,
      "sendArtifacts": true,
      "sendBinaryArtifacts": true,
      "maxInlineBytes": 65536
    }
  }
}
```

Agent -> AgentHub：

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "evt-1",
  "type": "run.started",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 1,
  "timestamp": "2026-05-26T12:00:03.000Z",
  "payload": {
    "downstreamRunId": "agent-run-abc",
    "workspaceRoot": "/workspace/project"
  }
}
```

### 8.8 流式文本

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "evt-2",
  "type": "message.delta",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 2,
  "timestamp": "2026-05-26T12:00:04.000Z",
  "payload": {
    "role": "assistant",
    "channel": "final",
    "text": "我先检查项目结构。"
  }
}
```

推理或内部过程：

```json
{
  "type": "message.delta",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 3,
  "payload": {
    "role": "assistant",
    "channel": "analysis",
    "text": "需要先定位登录相关文件。",
    "visibility": "debug"
  }
}
```

前端默认只展示 `visibility = public` 或未设置 visibility 的内容。`debug/internal` 放入运行日志。

### 8.9 工具事件

```json
{
  "type": "tool.call",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 4,
  "payload": {
    "toolCallId": "tool-1",
    "tool": "shell",
    "input": {
      "cmd": "ls"
    }
  }
}
```

```json
{
  "type": "tool.result",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 5,
  "payload": {
    "toolCallId": "tool-1",
    "status": "success",
    "output": "package.json\nsrc\n"
  }
}
```

### 8.10 文件变更快照

```json
{
  "type": "file.change",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 10,
  "payload": {
    "path": "src/pages/login.tsx",
    "oldPath": null,
    "changeType": "modified",
    "language": "tsx",
    "before": {
      "content": "import React from 'react'\n\nexport default function Login() {\n  return <div>Login</div>\n}\n",
      "encoding": "utf8",
      "sha256": "before-sha256",
      "truncated": false
    },
    "after": {
      "content": "import React from 'react'\nimport { Button } from './ui/button'\n\nexport default function Login() {\n  return <Button>Login</Button>\n}\n",
      "encoding": "utf8",
      "sha256": "after-sha256",
      "truncated": false
    },
    "patch": "@@ -1,5 +1,6 @@\n import React from 'react'\n+import { Button } from './ui/button'\n",
    "stats": {
      "additions": 4,
      "deletions": 0
    }
  }
}
```

`changeType` 取值：`added`、`modified`、`deleted`、`renamed`。`before` 和 `after` 是第一版主要持久化内容；`patch` 可选。大文件允许设置 `truncated=true`，但必须提供 `sha256`，方便后续和沙箱直连能力对齐。

### 8.11 Artifact

小文本 artifact：

```json
{
  "type": "artifact.upsert",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 11,
  "payload": {
    "artifactKey": "implementation-plan",
    "kind": "markdown",
    "title": "实现说明.md",
    "mimeType": "text/markdown",
    "contentMode": "inline",
    "content": "# 实现说明\n\n已完成登录页。",
    "final": true,
    "metadata": {
      "path": "docs/implementation.md"
    }
  }
}
```

二进制或大文件 artifact 分片：

```json
{
  "type": "artifact.upsert",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 12,
  "payload": {
    "artifactKey": "report-docx",
    "kind": "docx",
    "title": "报告.docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "contentMode": "chunked",
    "final": false
  }
}
```

```json
{
  "type": "artifact.chunk",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 13,
  "payload": {
    "artifactKey": "report-docx",
    "chunkIndex": 0,
    "encoding": "base64",
    "data": "UEsDBBQAAAA..."
  }
}
```

```json
{
  "type": "artifact.complete",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 14,
  "payload": {
    "artifactKey": "report-docx",
    "sha256": "hex",
    "sizeBytes": 120034
  }
}
```

### 8.12 完成、失败和 ACK

完成：

```json
{
  "type": "run.completed",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 99,
  "payload": {
    "finalMessage": "已完成实现，主要变更见右侧 diff。",
    "usage": {
      "inputTokens": 12000,
      "outputTokens": 3000
    }
  }
}
```

失败：

```json
{
  "type": "run.failed",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "seq": 100,
  "payload": {
    "code": "AGENT_ERROR",
    "message": "sandbox command failed",
    "retryable": false
  }
}
```

AgentHub ACK：

```json
{
  "protocol": "agenthub.acp",
  "version": "0.1",
  "id": "ack-14",
  "type": "ack",
  "sessionId": "session-uuid",
  "runId": "run-uuid",
  "timestamp": "2026-05-26T12:00:10.000Z",
  "payload": {
    "ackSeq": 14,
    "ok": true
  }
}
```

### 8.13 断线策略

第一版建议：

- 连接中断时，后端将 run 标记为 `failed`，错误码为 `DOWNSTREAM_DISCONNECTED`。
- 如果下游支持恢复，可以扩展 `run.resume`：
  - AgentHub 发送 `run.resume`，携带 `lastAckSeq`。
  - 下游从 `lastAckSeq + 1` 重放事件。
- 所有下游事件必须允许重复发送，AgentHub 通过 `unique(run_id, seq)` 幂等去重。

## 9. 上下文维护设计

### 9.1 数据来源

上下文由四类内容组成：

1. Pin：用户主动 pin 的消息、artifact、文件变更或上下文条目。
2. 最近 N 轮：当前 session 最近对话和重要 run 结果，按 token 截断。
3. pgvector 召回：对当前用户 prompt 做 embedding，在同 session 的 context items 中召回相关历史。
4. 结构化摘要：轻量 LLM 维护的 session memory。

### 9.2 Context item

每条 message、artifact、file change、run summary 都可以生成一个 `context_items`：

- `kind = message`：用户或 assistant 消息。
- `kind = artifact`：artifact 标题、摘要、关键内容。
- `kind = file_change`：文件路径、变更摘要、patch 简述。
- `kind = run_summary`：一次 run 的结果总结。
- `kind = manual_pin`：用户手动加入的长期上下文。

每个 context item 异步生成 embedding，写入 `context_embeddings`。

### 9.3 Summary 结构

`session_contexts.summary_json` 建议结构：

```json
{
  "goals": ["当前 session 要完成的目标"],
  "constraints": ["用户明确限制和偏好"],
  "decisions": ["已经确定的工程决策"],
  "files": [
    {
      "path": "src/pages/login.tsx",
      "summary": "登录页入口，最近被修改"
    }
  ],
  "openQuestions": ["尚未解决的问题"],
  "agentFindings": ["Agent 发现的重要事实"]
}
```

### 9.4 实时维护策略

- 用户消息落库：
  - 立即创建 `context_items(kind=message)`。
  - 异步生成 embedding。
  - 触发 summary debounce 更新。
- 下游 artifact/file change 落库：
  - 生成简短描述，创建 context item。
  - 对 patch 不直接全量 embedding，大 patch 先压缩为摘要。
- run 完成：
  - 写入 assistant final message。
  - 生成 `run_summary` context item。
  - 调用轻量 LLM 更新 `session_contexts`。

### 9.5 Run 启动前上下文组装

输入：

- `sessionId`
- 当前用户消息
- token budget，例如 32000

算法：

1. 加载 pin items，按创建时间和手动排序加入上下文。
2. 加载最近 N 轮 messages，去掉已经在 pin 中的内容，按 token budget 截断。
3. 对当前用户消息生成 query embedding，在 `context_embeddings` 中按 session 过滤召回。
4. 去重召回项，过滤已经在 pin/recent 中出现的 item。
5. 加载结构化摘要，作为低优先级压缩记忆加入。
6. 如果超预算，按优先级裁剪：先裁 summary，再裁 vector recall，再裁 recent，pin 尽量不裁。
7. 写入 `context_snapshots`，并把 snapshot 发送给下游 Agent。

推荐默认预算：

- 总预算：32000 tokens。
- pin：最多 12000。
- recent：最多 12000。
- vector recall：最多 6000。
- summary：最多 2000。

这不是硬切分。实际实现应先按优先级填充，再整体截断。

## 10. 数据库 DDL

以下 DDL 可直接在 PostgreSQL 执行。要求安装 pgvector 扩展。

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE session_status AS ENUM ('active', 'archived', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_role AS ENUM ('user', 'assistant', 'agent', 'system', 'tool');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE run_status AS ENUM ('queued', 'context_building', 'connecting', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('enabled', 'disabled', 'offline', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE connection_status AS ENUM ('connecting', 'connected', 'closed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE artifact_kind AS ENUM ('markdown', 'text', 'html', 'pdf', 'docx', 'image', 'archive', 'log', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE storage_kind AS ENUM ('inline_text', 'oss_object', 'remote_url');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE file_change_type AS ENUM ('added', 'modified', 'deleted', 'renamed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE context_item_kind AS ENUM ('message', 'artifact', 'file_change', 'run_summary', 'manual_pin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  endpoint_url text NOT NULL,
  protocol_profile text NOT NULL DEFAULT 'north-socketio-jsonrpc',
  auth_type text NOT NULL DEFAULT 'none',
  auth_secret_ref text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status agent_status NOT NULL DEFAULT 'enabled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  instance_key text NOT NULL,
  endpoint_url text NOT NULL,
  status agent_status NOT NULL DEFAULT 'offline',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  sandbox jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, instance_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Untitled Session',
  status session_status NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_agents (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid,
  role message_role NOT NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  parent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  content_text text NOT NULL DEFAULT '',
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count integer NOT NULL DEFAULT 0,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid,
  version integer NOT NULL DEFAULT 1,
  token_budget integer NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  selected_item_ids uuid[] NOT NULL DEFAULT '{}',
  snapshot_json jsonb NOT NULL,
  prompt_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  user_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  context_snapshot_id uuid REFERENCES context_snapshots(id) ON DELETE SET NULL,
  status run_status NOT NULL DEFAULT 'queued',
  downstream_session_id text,
  downstream_run_id text,
  error_code text,
  error_message text,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_run_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_snapshots_run_id_fkey'
  ) THEN
    ALTER TABLE context_snapshots
      ADD CONSTRAINT context_snapshots_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS downstream_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  endpoint_url text NOT NULL,
  status connection_status NOT NULL DEFAULT 'connecting',
  connected_at timestamptz,
  closed_at timestamptz,
  close_code integer,
  close_reason text,
  last_ack_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS downstream_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  downstream_session_id text NOT NULL,
  cwd text NOT NULL DEFAULT '/workspace',
  protocol_profile text NOT NULL DEFAULT 'north-socketio-jsonrpc',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  loaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, agent_id, agent_instance_id)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  source text NOT NULL DEFAULT 'downstream_agent',
  event_type text NOT NULL,
  visibility text NOT NULL DEFAULT 'public',
  payload jsonb NOT NULL,
  occurred_at timestamptz,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  producing_event_id uuid REFERENCES agent_events(id) ON DELETE SET NULL,
  artifact_key text,
  kind artifact_kind NOT NULL,
  title text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_kind storage_kind NOT NULL DEFAULT 'inline_text',
  storage_uri text,
  text_content text,
  sha256 text,
  size_bytes bigint,
  version integer NOT NULL DEFAULT 1,
  final boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, artifact_key)
);

CREATE TABLE IF NOT EXISTS artifact_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  encoding text NOT NULL DEFAULT 'base64',
  data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS artifact_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  render_kind text NOT NULL,
  storage_kind storage_kind NOT NULL DEFAULT 'inline_text',
  storage_uri text,
  html_content text,
  text_content text,
  status text NOT NULL DEFAULT 'ready',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, render_kind)
);

CREATE TABLE IF NOT EXISTS file_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  producing_event_id uuid REFERENCES agent_events(id) ON DELETE SET NULL,
  path text NOT NULL,
  old_path text,
  change_type file_change_type NOT NULL,
  language text,
  before_content text,
  before_sha256 text,
  before_truncated boolean NOT NULL DEFAULT false,
  after_content text,
  after_sha256 text,
  after_truncated boolean NOT NULL DEFAULT false,
  patch text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_contexts (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary_version integer NOT NULL DEFAULT 0,
  summary_text text NOT NULL DEFAULT '',
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id uuid,
  kind context_item_kind NOT NULL,
  text text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  importance integer NOT NULL DEFAULT 0,
  pinned boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_item_id uuid NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model text NOT NULL,
  dims integer NOT NULL DEFAULT 1536,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_item_id, model)
);

CREATE TABLE IF NOT EXISTS context_update_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, is_pinned) WHERE is_pinned = true;
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created ON agent_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_downstream_sessions_session_agent ON downstream_sessions(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_seq ON agent_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_events_session_persisted ON agent_events(session_id, persisted_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_updated ON artifacts(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_changes_run_path ON file_changes(run_id, path);
CREATE INDEX IF NOT EXISTS idx_context_items_session_kind ON context_items(session_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_items_pinned ON context_items(session_id, pinned) WHERE pinned = true;
CREATE INDEX IF NOT EXISTS idx_context_embeddings_session ON context_embeddings(session_id);
CREATE INDEX IF NOT EXISTS idx_context_embeddings_vector
  ON context_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

说明：

- 二进制 artifact 第一版直接上传阿里云 OSS。`artifacts.storage_kind = 'oss_object'`，`storage_uri` 使用 `oss://juzi05/{objectKey}`，数据库不保存最终 bytea 内容。
- `artifact_chunks` 只作为下游分片上报时的临时暂存。`artifact.complete` 校验 sha256 后，后端合并并上传 OSS，成功后可以删除对应 chunks。
- `context_embeddings.embedding` 默认 `vector(1536)`，建议第一版 embedding 模型固定为 1536 维。如果实际模型维度不同，需要调整 DDL。
- `agent_events` 是回放和实时推送的核心表，必须保证 `run_id + seq` 唯一。

## 11. 关键实现流程

### 11.1 用户发送消息

1. 前端调用 `POST /api/sessions/{id}/messages`。
2. 后端写入 user message。
3. 后端创建 `agent_runs(status=queued)`。
4. 后端创建 `context_update_jobs`，并把用户消息写成 context item。
5. 后端异步启动 run。
6. 前端通过 WS 收到 `run.created` 或 `run.event`。

### 11.2 启动下游 Agent

1. `RunService` 把 run 状态改成 `context_building`。
2. `ContextService` 生成 context snapshot。
3. `RunService` 把 run 状态改成 `connecting`。
4. `DownstreamSessionManager` 查询 `downstream_sessions`，没有绑定则通过 adapter 调用 `session/new`，已有绑定则调用 `session/load`。
5. `DownstreamAgentBridge` 建立到 Agent 的 Socket.IO 或 WSS 连接，并调用 `initialize` 或 hello。
6. 对 `north-socketio-jsonrpc` profile，调用 `session/prompt`；对 `agenthub-wss-json` profile，发送 `run.start`。
7. 收到首个 `run.started` 或 `session/prompt` 成功响应后，run 状态改成 `running`。

### 11.3 接收下游事件

1. 下游发送 frame。
2. `ProtocolAdapter` 做最小协议校验，并归一化为 `NormalizedAgentEvent`。
3. `EventIngestService` 在事务中写入 `agent_events`，以 `run_id + seq` 幂等去重。
4. 根据 event type 派生写入：
   - `message.delta` -> 更新 assistant message buffer。
   - `file.change` -> 写 `file_changes`，以 before/after 快照为主，patch 可选。
   - `artifact.*` -> 写 `artifacts`、`artifact_chunks`，完成后上传 OSS 并更新 `storage_uri`。
   - `run.completed` -> 更新 run、assistant final message、usage。
5. 事务提交后向前端广播。
6. 对 JSON-RPC request 返回 result 作为 ack；对 WSS profile 发送 `ack` frame。

### 11.4 Run 完成后

1. `ContextService` 创建 run summary context item。
2. 对新增 context items 生成 embedding。
3. 轻量 LLM 更新 `session_contexts.summary_json`。
4. 前端收到 `context.updated`。

## 12. 实施拆分

### Phase 1：数据库与后端基础

- 建立 DDL 和 migration。
- 实现 Session/Message/Run/Agent/Artifact 基础 CRUD。
- 实现 `agent_events` 写入和回放。
- 前端先能创建 session、发送消息、看历史事件。

### Phase 2：前端 WebSocket 与工作台

- 实现 `/ws/frontend`。
- 前端 session subscribe、事件合并、断线重连。
- 搭出三栏 Workbench：session rail、timeline、artifact inspector。
- 参考 Multica 实现 optimistic send、active run 状态条、live run timeline、完成后 DB 快照兜底的查询缓存同步策略。

### Phase 3：下游 Agent 对接

- 实现 `DownstreamAgentBridge`。
- 实现 `north-socketio-jsonrpc` adapter：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/event` ack。
- 实现 `DownstreamSessionManager` 和 `downstream_sessions` 绑定。
- 写一个 mock downstream agent 用于联调。
- 把 message delta、tool event、file change snapshot、artifact 端到端打通。

### Phase 4：artifact 和 diff 渲染

- Diff 文件树与 unified diff。
- Markdown 渲染。
- PDF 内容接口和前端 viewer，二进制内容从 OSS 读取。
- DOCX 后端转换 HTML。
- artifact chunk 合并、sha256 校验、阿里云 OSS 上传和 `storage_uri` 回写。

### Phase 5：上下文系统

- context item 生成。
- embedding 写入 pgvector。
- vector recall。
- summary 维护。
- run.start 携带 context snapshot。

### Phase 6：工程收口

- 错误态、重试策略、日志、基础测试。
- mock agent e2e。
- 协议文档固定为版本 `0.1`。
- 补充课题演示数据。

## 13. 配置项

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/agenthub

CONTEXT_LLM_BASE_URL=https://api.openai.com/v1
CONTEXT_LLM_API_KEY=sk-...
CONTEXT_LLM_MODEL=gpt-4.1-mini
CONTEXT_EMBEDDING_MODEL=text-embedding-3-small
CONTEXT_EMBEDDING_DIMS=1536
CONTEXT_TOKEN_BUDGET=32000

FRONTEND_WS_PATH=/ws/frontend
DOWNSTREAM_CONNECT_TIMEOUT_MS=10000
DOWNSTREAM_FRAME_MAX_BYTES=10485760

ALIYUN_OSS_REGION=oss-cn-hangzhou
ALIYUN_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
ALIYUN_OSS_BUCKET=juzi05
ALIYUN_OSS_PUBLIC_DOMAIN=https://juzi05.oss-cn-hangzhou.aliyuncs.com
ALIYUN_OSS_ACCESS_KEY_ID=...
ALIYUN_OSS_ACCESS_KEY_SECRET=...
ARTIFACT_OSS_PREFIX=agenthub/artifacts
ARTIFACT_MAX_UPLOAD_BYTES=52428800
```

## 14. 风险与决策

### 14.1 ACP 兼容性

ACP 正式文档强调 HTTPS/WSS/SSE、JSON 消息、WSS 下可包含二进制 MessageHeader。第一版建议先实现 JSON envelope，以便尽快和下游对接。等下游协议稳定后，再增加完整 ACP header 适配层。

### 14.2 二进制 artifact

第一版直接使用阿里云 OSS 存储 PDF/DOCX/image/archive 等二进制 artifact。PostgreSQL 只保存 artifact 元数据、sha256、size、`storage_kind` 和 `storage_uri`。建议 object key 结构：

```text
agenthub/artifacts/{sessionId}/{runId}/{artifactId}/{filename}
```

后端读取 artifact 内容时有两种方式：

- 默认：后端代理读取 OSS，再返回给前端，权限边界最简单。
- 可选：后端生成短期签名 URL，前端直接读取 OSS，适合大文件预览。

AccessKey 和 Secret 必须通过环境变量或部署平台密钥配置注入，不写入代码、DDL 或提交历史。

### 14.3 上下文实时维护

不要在每个 delta 上调用 LLM。建议按 message、artifact complete、run completed 触发更新，并做 debounce。embedding 可以更实时，summary 适合延迟几秒更新。

### 14.4 多 Agent 实例

单后端可以同时维护多个下游连接，但第一版不要做复杂调度。用户发送消息时显式选择 Agent；如果未选择，则用默认启用 Agent。

## 15. 第一版验收标准

- 创建 session 后可以发送任务给指定下游 Agent。
- 后端能主动连接下游 Agent WSS，并发送包含历史上下文的 `run.start`。
- 下游 Agent 的 stream event 全部持久化到 `agent_events`。
- 前端刷新后能恢复消息流、run timeline、diff 和 artifact。
- Markdown/PDF/DOCX 至少能只读展示。
- pgvector 召回参与 run.start context snapshot。
- session summary 会在 run 完成后更新。
- 一个后端可配置并连接多个 Agent 实例。
