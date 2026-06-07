# 后端-前端富文本接口

本文档只描述 AgentHub 后端与浏览器前端之间的 HTTP API、DTO 和富文本展示协议。下游 Agent Runtime 的 ACP 接入另见 [后端-下游富文本接口](downstream-rich-text-interface.md)。

相关源码：

- `shared/src/hub.ts`：`HubMessageDto`、`HubMessagePartDto`、`UploadedAttachmentDto`、`SendHubMessageRequest`
- `frontend/app/workbench/rich-text.tsx`：消息 part 渲染入口
- `frontend/app/page.tsx`：发送消息、上传附件、引用、Pin
- `backend/src/modules/hub/services/hub-session.service.ts`：用户消息、附件、引用处理
- `backend/src/modules/hub/controllers/hub-upload.controller.ts`：附件上传与内容访问

## 1. 消息 DTO

前端读取消息时，以 `HubMessageDto` 为准：

```ts
interface HubMessageDto {
  id: string;
  sessionId: string;
  runId?: string | null;
  role: "user" | "assistant" | "agent" | "system" | "tool";
  agentId?: number | null;
  agentName?: string | null;
  parentMessageId?: string | null;
  contentText: string;
  contentJson: Record<string, unknown>;
  parts: HubMessagePartDto[];
  tokenCount: number;
  status: "queued" | "thinking" | "streaming" | "completed" | "failed" | "cancelled";
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}
```

内容分层：

- `contentText`：纯文本摘要，用于复制、搜索、兜底展示和上下文估算。
- `contentJson.parts`：数据库中的结构化富文本片段。
- `parts`：后端 mapper 从 `contentJson.parts` 反序列化后返回给前端的展示数组。

前端渲染规则：

- 如果 `parts` 为空，使用 `contentText` 做基础 Markdown 渲染。
- 如果 `parts` 存在，按 `part.type` 分发到对应组件。
- 未识别类型降级为通用卡片，展示 `title/url/text/metadata` 中可用的信息。

## 2. Part DTO

```ts
type HubMessagePartType =
  | "text"
  | "code"
  | "image"
  | "file"
  | "link_preview"
  | "diff"
  | "artifact"
  | "deploy_status";

interface HubMessagePartDto {
  id: string;
  type: HubMessagePartType | string;
  text?: string;
  language?: string;
  title?: string;
  url?: string;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}
```

公共字段：

- `id`：同一条消息内唯一，用于 Pin、引用和展开预览。
- `type`：决定前端展示组件。
- `text`：文本、代码、短预览或 diff patch。
- `title`：卡片标题、文件名或资源名。
- `url`：可打开的资源地址。
- `language`：代码语言或文件语言。
- `pinned`：后端维护，前端只读展示。
- `metadata`：后端生成或保存的类型专属字段。

## 3. Part 展示规则

### text

```json
{
  "id": "part_1",
  "type": "text",
  "text": "普通文本，支持基础 Markdown。"
}
```

前端按基础 Markdown 展示段落、标题、列表、引用、表格、行内代码、链接和行内图片。

### code

```json
{
  "id": "part_2",
  "type": "code",
  "language": "tsx",
  "text": "export function Button() {\n  return <button>Save</button>;\n}"
}
```

前端显示代码块，支持复制、展开、Pin 和引用。

### image

```json
{
  "id": "attachment_1",
  "type": "image",
  "title": "screenshot.png",
  "url": "https://cdn.example.com/screenshot.png",
  "metadata": {
    "artifactId": "5d3c3f3e-2d7b-4a33-a7d0-000000000001",
    "mimeType": "image/png",
    "sizeBytes": 143200,
    "sha256": "..."
  }
}
```

前端用 `url` 展示图片缩略图，展开后显示大图。`artifactId/sha256/sizeBytes` 是后端对用户上传附件或内部产物生成的只读字段。

### file

```json
{
  "id": "attachment_2",
  "type": "file",
  "title": "requirements.txt",
  "url": "https://cdn.example.com/requirements.txt",
  "text": "fastapi==0.115.0\nuvicorn==0.30.0",
  "metadata": {
    "artifactId": "5d3c3f3e-2d7b-4a33-a7d0-000000000002",
    "mimeType": "text/plain",
    "sizeBytes": 48,
    "sha256": "...",
    "textPreview": "fastapi==0.115.0\nuvicorn==0.30.0"
  }
}
```

前端展示文件名、MIME、大小和打开链接。文本类附件可显示 `text` 预览。`textPreview` 是后端为用户上传的文本类附件生成的只读预览。

### link_preview

```json
{
  "id": "link_1",
  "type": "link_preview",
  "title": "AgentHub 文档",
  "url": "https://example.com/docs",
  "metadata": {
    "description": "AgentHub 的接口说明"
  }
}
```

前端展示标题、描述和 URL。缩略图、站点名、favicon 属于后续展示增强。

### diff

```json
{
  "id": "diff_file-change-id",
  "type": "diff",
  "title": "src/app/page.tsx",
  "language": "tsx",
  "text": "@@ -1 +1 @@\n-old\n+new\n",
  "metadata": {
    "fileChangeId": "file-change-id",
    "path": "src/app/page.tsx",
    "changeType": "modified",
    "patch": "@@ -1 +1 @@\n-old\n+new\n"
  }
}
```

前端在聊天流展示 Diff 摘要卡片，展开后显示 unified diff，并可打开右侧 Diff 面板。当前右侧 Diff 面板已支持 `file.change`；聊天流自动派生 diff part 属于后续补齐项。

### artifact

```json
{
  "id": "artifact_artifact-id",
  "type": "artifact",
  "title": "执行摘要",
  "url": "https://cdn.example.com/artifacts/run-summary.md",
  "metadata": {
    "artifactId": "artifact-id",
    "artifactKey": "run-summary",
    "kind": "markdown",
    "mimeType": "text/markdown; charset=utf-8",
    "storageKind": "remote_url",
    "final": true
  }
}
```

前端在聊天流展示 Artifact 卡片。若有 `metadata.artifactId`，可打开 AgentHub 内部 Artifact 面板；否则使用 `url` 打开远程资源。

### deploy_status

`deploy_status` 是 AgentHub 内部部署服务生成的状态卡片，暂不作为下游富文本接入项。

## 4. 发送消息

接口：

```http
POST /api/sessions/:sessionId/messages
Content-Type: application/json
```

请求体：

```ts
interface SendHubMessageRequest {
  content: string;
  mentionedAgentIds?: number[];
  orchestratorAgentId?: number;
  parentMessageId?: string;
  quotedMessageId?: string;
  references?: Array<{ messageId: string; partId?: string }>;
  attachments?: Array<{ id: string }>;
}
```

示例：

```json
{
  "content": "请基于截图和引用代码继续修改：https://example.com/spec",
  "mentionedAgentIds": [2, 3],
  "orchestratorAgentId": 1,
  "parentMessageId": "message-id",
  "quotedMessageId": "message-id",
  "references": [
    {
      "messageId": "message-id",
      "partId": "part_2"
    }
  ],
  "attachments": [
    {
      "id": "uploaded-attachment-id"
    }
  ]
}
```

后端处理：

- 将 `content` 保存为用户消息 `contentText`。
- 解析三反引号代码块，生成 `text/code` parts。
- 将 `attachments` 加载为 `image/file` parts。
- 从 `content` 提取 URL，生成 `link_preview` parts。
- 将 `references` 写入引用上下文，并用于后续运行。

## 5. 上传附件

接口：

```http
POST /api/sessions/:sessionId/uploads
Content-Type: <file MIME>
X-File-Name: <urlencoded file name>
```

请求体是文件二进制。

响应体：

```ts
interface UploadedAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  textPreview?: string | null;
  createdAt: string;
}
```

示例：

```json
{
  "id": "uploaded-attachment-id",
  "name": "screenshot.png",
  "mimeType": "image/png",
  "sizeBytes": 143200,
  "sha256": "...",
  "url": "https://cdn.example.com/screenshot.png",
  "textPreview": null,
  "createdAt": "2026-06-07T09:00:00.000Z"
}
```

约束：

- 单个附件最大 50MB。
- 单条消息最多 5 个附件。
- 附件必须属于当前 session。
- 附件存储依赖 OSS；未配置 OSS 时上传失败。

## 6. 引用与 Pin

引用：

- `quotedMessageId` 用于兼容单条引用。
- `references` 支持最多 5 条引用。
- `partId` 存在时引用具体 part；不存在时引用整条消息。

Pin：

```http
POST /api/sessions/:sessionId/messages/:messageId/pin
Content-Type: application/json
```

```json
{
  "pinned": true,
  "partId": "part_2"
}
```

不传 `partId` 时表示 Pin 整条消息。

## 7. 前端验收

- 纯文本消息能按基础 Markdown 展示。
- 代码块能高亮、复制、展开。
- 图片附件能显示缩略图并展开预览。
- 文件附件能显示名称、类型、大小和打开链接。
- 网页链接能生成并展示预览卡片。
- 后端生成的 `artifactId/sha256/textPreview` 只作为前端只读字段，不由前端编辑。
