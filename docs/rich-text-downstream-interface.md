# AgentHub 富文本接口文档索引

原先的富文本接口说明已拆分为两个边界清楚的文档，避免把“后端与前端交互”和“后端与下游交互”混在一起。

## 文档入口

- [后端-前端富文本接口](frontend-rich-text-interface.md)
  - HTTP API、DTO、上传附件、引用、Pin、前端收到的 `parts` 渲染规则。
  - 包含 `artifactId`、`sha256`、`textPreview` 等 AgentHub 后端生成并返回给前端的只读字段。

- [后端-下游富文本接口](downstream-rich-text-interface.md)
  - ACP/Socket.IO 接入、`session/prompt` 文本拼接、下游通过 `session/update` 回传消息和结构化更新。
  - 下游资源类 part 统一 URL 化；下游不生成后端内部产物字段，也不提供 artifact 去重字段。

## 边界原则

- 前端文档描述 AgentHub 后端返回给浏览器的数据，以及浏览器调用后端的 HTTP 接口。
- 下游文档描述 AgentHub 后端和下游 Agent Runtime 之间的协议。
- 后端内部字段可以返回给前端或作为下游只读上下文，但不能要求下游生成。
