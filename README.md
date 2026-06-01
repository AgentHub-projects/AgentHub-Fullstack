# AgentHub — 多 Agent 协作平台

基于 IM 群聊范式的多 Agent 协作平台。用户像使用微信/飞书一样，通过新建群聊、@Agent 的方式与不同 AI Agent 交互，由下游 Orchestrator 自动协调分工，多个 Agent 像群聊成员一样依次回复。

## 架构

```
用户发消息 → REST POST /api/sessions/:id/messages
  → 后端落库 → 构建上下文（增量摘要链 + 向量召回）
  → 推送到下游 Orchestrator（WS 长连接）
  → 下游回推 JSON 帧（带 speaker AgentId）
  → 后端持久化 + WebSocket 实时推前端
```

- **后端**：NestJS + PostgreSQL + Prisma + Socket.IO + pgvector
- **前端**：Next.js 15 + React 19 + Ant Design + Socket.IO Client
- **包管理**：pnpm monorepo（`@agenthub/shared`、`@agenthub/backend`、`@agenthub/frontend`）

## 项目结构

```
AgentHub-Fullstack/
├── backend/             # NestJS 后端
│   ├── prisma/          # 数据库 Schema、迁移和 seed
│   └── src/modules/hub/ # 核心 Hub 模块（REST、WebSocket、上下文、下游连接）
│       ├── controllers/ # HTTP API 控制器
│       ├── gateways/    # Socket.IO 实时推送
│       ├── mappers/     # Prisma 模型到 DTO 的映射
│       ├── services/    # 会话、事件、上下文、Agent、artifact 等业务服务
│       ├── types/       # 模块内共享类型
│       └── utils/       # 模块内纯工具函数
├── frontend/            # Next.js 前端
│   ├── app/
│   │   ├── page.tsx        # 工作台入口和状态编排
│   │   ├── globals.css     # 全局变量和基础元素样式
│   │   └── workbench/      # 工作台展示组件和工作台样式
│   └── lib/
│       ├── agenthub-api.ts # REST + WebSocket API 客户端
│       └── workbench/      # diff、Markdown、mention、排序格式化等纯函数
├── shared/              # 前后端共享 TypeScript 类型契约
│   └── src/             # hub、downstream、builder 契约分文件导出
├── docs/
│   ├── design/          # 设计文档
│   └── reference/       # 协议、数据库等参考文档
└── examples/            # demo/mock 数据
```

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 9
- PostgreSQL >= 15（需安装 pgvector 扩展）

### 环境变量

```bash
# backend/.env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agenthub
REDIS_URL=redis://localhost:6379

# 初始用户由 seed 创建：账号 admin；真实密码只放本地 .env，不提交仓库
AGENTHUB_ADMIN_PASSWORD=change-me

# 可选：真实下游 Orchestrator 地址（不配置则使用 mock 模式）
DOWNSTREAM_ORCHESTRATOR_WS_URL=ws://localhost:4000

# 可选：Embedding 模型配置（兼容 OpenAI 格式）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
CONTEXT_EMBEDDING_MODEL=text-embedding-3-small

# 可选：摘要模型配置
SUMMARY_API_KEY=sk-xxx
SUMMARY_BASE_URL=https://api.deepseek.com/v1
CONTEXT_SUMMARY_MODEL=deepseek-chat

# 可选：部署服务
DEPLOY_SERVICE_URL=http://localhost:4001
DEPLOY_SERVICE_API_KEY=change-me
```

### 安装与启动

```bash
# 安装依赖
pnpm install

# 初始化数据库
cd backend
npx prisma migrate dev
npx prisma generate
cd ..

# 启动后端（端口 3001）
cd backend
pnpm build
node dist/src/main.js

# 新终端：启动前端（端口 3000）
cd frontend
pnpm dev
```

打开 `http://localhost:3000`，新建群聊，选择 Agent，发送消息即可。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/me` | 查询登录状态 |
| POST | `/api/auth/login` | 登录，写入 7 天 Redis-backed Cookie session |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/agents` | 列出 Agent 实例 |
| GET | `/api/agents/:id/detail` | Agent 详情，含 `agent`、`template`、下游最小可执行 `config` |
| POST | `/api/agents` | 从模板创建会话内 Agent 实例 |
| PATCH | `/api/agents/:id` | 更新实例名称、描述、provider |
| DELETE | `/api/agents/:id` | 逻辑删除 Agent 实例 |
| GET | `/api/agent-templates` | 列出 Agent 模板 |
| POST | `/api/agent-templates` | 创建 Agent 模板 |
| PATCH | `/api/agent-templates/:id` | 更新 Agent 模板 |
| DELETE | `/api/agent-templates/:id` | 停用 Agent 模板 |
| GET | `/api/downstream/agents/:agentId/config` | 下游公开配置接口；无鉴权，按 `agentId` 参数校验 |
| GET | `/api/artifacts/:id/content` | 获取产物内容 |
| GET | `/api/sessions` | 列出会话 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 会话详情（含消息、事件、产物） |
| PATCH | `/api/sessions/:id` | 重命名、全局置顶 |
| POST | `/api/sessions/:id/archive` | 归档会话并关闭下游连接 |
| DELETE | `/api/sessions/:id` | 逻辑删除会话 |
| POST | `/api/sessions/:id/messages` | 发送消息 |
| POST | `/api/sessions/:id/messages/:mid/pin` | Pin/Unpin 消息 |
| POST | `/api/sessions/:id/messages/:mid/regenerate` | 基于用户消息重新生成 |
| POST | `/api/sessions/:id/participants` | 添加 Agent 到群聊 |
| POST | `/api/sessions/:id/runs/:rid/cancel` | 取消 Run |
| POST | `/api/sessions/:id/uploads` | 上传消息附件，最大 50MB |
| GET | `/api/sessions/:id/events` | 列出事件 |
| GET | `/api/sessions/:id/artifacts` | 列出产物 |
| GET | `/api/sessions/:id/file-changes` | 列出文件变更 |
| POST | `/api/sessions/:id/file-changes/:fid/apply` | 请求下游执行一键应用 Diff |
| POST | `/api/sessions/:id/deployments` | 手动触发当前项目最新成功 push commit 的部署 |
| GET/POST/PATCH/DELETE | `/api/projects` | 项目 GitHub 地址绑定所需的最小 CRUD |

## 核心概念

### 增量摘要链

长期对话历史通过增量压缩管理：短期事件 buffer 达到阈值（20 个事件或 2000 token）时，自动调 LLM 压缩为不可变的长期摘要片段存入 `long_term_summaries` 表。每次向 Orchestrator 推送时附上完整摘要链，保证下游始终拥有上下文。

### 向量召回

用户消息通过 embedding 模型生成向量，利用 pgvector 从 `context_embeddings` 表召回语义相关的历史消息和 pinned 内容，注入到上下文快照中。

### Agent 管理

- `provider` 字段标识底层实例类型：字符串，`"claude-code"` 或 `"open-code"`
- 前端调用 `GET /api/agents/:id/detail` 读取实例详情和 `config`
- 下游运行时调用公开的 `GET /api/downstream/agents/:agentId/config` 获取最小可执行配置
- 群聊参与者通过 `POST /api/sessions/:id/participants` 动态添加；删除是逻辑删除，历史消息不物理删除

## 开发命令

```bash
# 构建 shared 契约
pnpm --filter @agenthub/shared build

# 构建后端
pnpm --filter @agenthub/backend build

# 类型检查
cd backend && npx tsc -p tsconfig.json --noEmit
cd frontend && npx tsc -p tsconfig.json --noEmit

# 数据库迁移
cd backend && npx prisma migrate dev

# 运行测试
pnpm test
```
