# AgentHub — 多 Agent 协作工作台

基于 Session 工作台范式的多 Agent 协作平台。用户创建单聊/群聊会话，绑定 GitHub 项目，通过 @Agent 与多个 AI Agent 交互。平台自动编排下游 Agent 运行，实时推送消息、产物、文件变更到前端。内置 Sandbox 文件编辑、Diff 审查、Artifact 管理和 Vercel 一键部署。

## 架构

```
用户发送消息 → POST /api/sessions/:id/messages
  → 后端创建 Run → 构建上下文 → 推送到下游 Orchestrator
  → 下游 Agent 运行 → 回流消息/事件/产物/文件变更
  → 后端持久化 + WebSocket 实时推前端（session / message / event / artifact / file_change）
```

- **后端**：NestJS 11 + PostgreSQL（pgvector） + Prisma + Socket.IO + Redis
- **前端**：Next.js 15 + React 19 + Ant Design + Socket.IO Client
- **包管理**：pnpm monorepo（`@agenthub/shared`、`@agenthub/backend`、`@agenthub/frontend`）

## 项目结构

```
AgentHub-Fullstack/
├── backend/                # NestJS 后端 (port 3001)
│   ├── prisma/             # 数据库 Schema、迁移和 seed
│   ├── docker-compose.yml  # PostgreSQL + pgvector
│   └── src/
│       └── modules/
│           └── hub/
│               ├── auth/           # 认证（session、guard、cookie）
│               ├── controllers/   # HTTP API 控制器
│               │   ├── hub-session.controller.ts    # 会话/消息/部署
│               │   ├── hub-agent.controller.ts      # Agent 实例
│               │   ├── hub-artifact.controller.ts   # 产物内容
│               │   ├── hub-upload.controller.ts     # 附件上传
│               │   ├── hub-sandbox.controller.ts    # 下游沙箱映射
│               │   ├── hub-health.controller.ts     # 健康检查
│               │   ├── auth.controller.ts           # 登录/登出
│               │   ├── project.controller.ts        # 项目管理
│               │   ├── agent-template.controller.ts # Agent 模板
│               │   ├── builder.controller.ts        # 模板构建器
│               │   └── downstream.controller.ts     # 下游配置
│               ├── gateways/     # Socket.IO 实时推送
│               ├── mappers/      # Prisma 模型到 DTO 映射
│               ├── services/     # 业务服务（Session、Agent、下游沙箱映射、Deployment 等）
│               ├── types/        # 下游编排类型
│               └── utils/        # 工具函数
├── frontend/               # Next.js 前端 (port 3000)
│   ├── app/
│   │   ├── page.tsx              # 工作台主页（单聊/群聊双模式）
│   │   ├── globals.css           # 全局样式
│   │   ├── workbench/
│   │   │   ├── inspector.tsx     # 检查面板（文件/审查/Artifacts）
│   │   │   ├── timeline.tsx      # 对话时间线
│   │   │   └── rich-text.tsx     # 富文本消息展示
│   │   └── agent-templates/
│   │       └── build/
│   │           └── page.tsx      # Agent 模板构建器
│   └── lib/
│       ├── agenthub-api.ts       # REST + WebSocket API 客户端
│       └── workbench/
│           ├── timeline.ts       # 对话项构建
│           ├── format.ts         # 排序、格式化
│           ├── mentions.ts       # @提及解析
│           ├── session-tabs.ts   # 多标签页管理
│           ├── artifact-preview.ts # 产物预览
│           ├── diff.ts           # Diff 处理
│           ├── markdown.ts       # Markdown 渲染
│           └── types.ts          # 类型定义
├── shared/                 # 前后端共享 TypeScript 类型契约
│   └── src/
│       ├── hub.ts           # Session、Message、Agent 等 DTO
│       ├── downstream.ts    # 下游编排协议
│       └── builder.ts       # 模板构建器协议
├── docs/                   # 设计和参考文档
│   ├── design/
│   └── reference/
└── examples/               # demo/mock 数据
```

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 10
- Docker Compose（用于启动 PostgreSQL + pgvector）

### 1. 启动数据库

```bash
cd backend
docker compose up -d
```

这会启动 PostgreSQL 16 + pgvector 扩展，端口 5432，默认凭据 `agenthub:agenthub`。

### 2. 配置环境变量

```bash
# 复制 backend/.env.example 并填写
cp backend/.env.example backend/.env
```

`backend/.env` 核心变量说明：

```bash
# 服务端口
PORT=3001

# 管理员密码（seed 脚本会创建 admin 账号）
AGENTHUB_ADMIN_PASSWORD=change-me

# Redis（用于 cookie session 存储）
REDIS_URL=redis://localhost:6379

# 数据库
DATABASE_URL=postgresql://agenthub:agenthub@localhost:5432/agenthub?schema=public

# 下游编排器（可选，留空使用内置 Mock）
DOWNSTREAM_ORCHESTRATOR_WS_URL=

# OpenAI / 兼容 API（用于上下文嵌入和摘要）
OPENAI_API_KEY=
OPENAI_BASE_URL=

# 摘要模型（可选，不填则回退使用 OPENAI_API_KEY）
SUMMARY_API_KEY=
SUMMARY_BASE_URL=
CONTEXT_SUMMARY_MODEL=deepseek-chat

# 阿里云 OSS（产物存储，可选）
ALIYUN_OSS_REGION=
ALIYUN_OSS_ENDPOINT=
ALIYUN_OSS_BUCKET=
ALIYUN_OSS_ACCESS_KEY_ID=
ALIYUN_OSS_ACCESS_KEY_SECRET=

# Vercel 部署（可选）
VERCEL_TOKEN=
VERCEL_TEAM_ID=
VERCEL_DEPLOY_ENV_KEYS=
```

### 3. 安装与启动

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

打开 `http://localhost:3000`，使用 `admin` 账号和 `.env` 中配置的密码登录。

## 核心概念

### Session 工作台

每个 Session 是一个独立的协作工作区，支持两种模式：

- **单聊**（direct）：一个 Agent 直接接受用户任务，适合代码生成、文件编辑等场景
- **群聊**（group）：Orchestrator 协调多个 Worker Agent，用户在输入框 @Agent 指定目标

Session 绑定 GitHub 项目后才能发送消息。工作台左侧为会话列表，中间为对话时间线，右侧 Inspector 面板支持文件编辑、Diff 审查和产物浏览。

### 消息系统

- **消息结构**：消息包含 `contentText`（纯文本）和 `parts`（结构化片段，支持 code/diff/artifact/image/deploy_status 等类型）
- **Pin / Reply**：可 Pin 整条消息或某个 part 为"关键消息"；回复消息时支持引用多条消息或片段
- **附件**：支持上传文件作为消息附件（最大 50MB，每条消息最多 5 个附件）
- **重新生成**：可基于某条用户消息触发重新生成

### 下游沙箱编辑

下游在 `session/new` 返回沙箱地址、workspace 和 Agent 分支映射。AgentHub 后端只把该映射保存到 Redis，Inspector 的「文件」面板读取映射后直连下游沙箱文件 API。编辑保存后由下游通过通用 ACP `session/event:file.change` 回传 Diff。

### Diff 审查

Agent 运行时输出的文件变更（diff patch）实时推送到「审查」面板。面板展示文件名、变更类型、状态（pending / applied）和 diff 内容。用户可点击「应用 Diff」将变更写入 Agent 工作区。

### Artifact 产物

Agent 输出的长文本、代码片段、图片等结构化产物。产物以版本管理，可通过上下文菜单引用到输入框，也可在 Viewer 中编辑后发起修改请求。

### 上下文管理

- **短期事件 buffer**：近期消息和事件缓存在上下文快照中
- **向量召回**：用户消息通过 embedding 模型生成向量，利用 pgvector 检索语义相关的历史消息和 pinned 内容
- **摘要链**：历史对话压缩为长期摘要片段，确保下游始终拥有上下文

### Agent 管理

- `provider` 字段标识底层类型：`"claude-code"` 或 `"open-code"`
- Agent 从模板实例化，模板定义 `defaultProvider`、`defaultCapabilities` 等
- 前端调用 `GET /api/agents/:id/detail` 读取实例和下游配置
- 下游运行时调用公开的 `GET /api/downstream/agents/:agentId/config` 获取最小可执行配置
- 群聊成员动态管理，支持右键编辑/删除

### Vercel 部署

会话绑定 GitHub 项目后，可在工具栏点击「部署到 Vercel」一键触发 Production 部署。部署前通过 preflight 检查项目绑定、push commit 和 Vercel 配置状态。

### Agent 模板构建器

通过多轮 LLM 对话引导用户创建 Agent 模板。构建助手依次收集名称、描述、System Prompt、工具集和 Provider，最终生成可实例化的模板。

## API 接口

### 认证

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/auth/me` | 公开 | 查询当前登录状态 |
| POST | `/api/auth/login` | 公开 | 登录，写入 Redis-backed Cookie（7 天有效） |
| POST | `/api/auth/logout` | 公开 | 登出，清除 Cookie 和 Redis 会话 |

### 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 公开 | 服务健康检查 |

### 会话（Session）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions?q=&includeArchived=` | 列出会话，支持搜索 |
| POST | `/api/sessions` | 创建单聊或群聊会话 |
| GET | `/api/sessions/:id` | 会话详情（含消息、事件、产物、文件变更） |
| GET | `/api/sessions/:id/diff-context` | Diff 审查范围信息 |
| PATCH | `/api/sessions/:id` | 重命名、置顶 |
| POST | `/api/sessions/:id/archive` | 归档会话并关闭下游连接 |
| DELETE | `/api/sessions/:id` | 逻辑删除会话 |

### 消息与运行

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sessions/:id/messages` | 发送消息，触发 Agent 运行 |
| POST | `/api/sessions/:id/messages/:mid/pin` | Pin / Unpin 消息或消息片段 |
| POST | `/api/sessions/:id/messages/:mid/regenerate` | 基于用户消息重新生成 |
| POST | `/api/sessions/:id/participants` | 添加 Agent 到群聊 |
| POST | `/api/sessions/:id/runs/:rid/cancel` | 取消 Run |

### 附件上传

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sessions/:id/uploads` | 上传消息附件，最大 50MB |
| GET | `/api/uploads/:id/content` | 获取上传内容（公开访问） |

### 下游沙箱映射

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/:id/sandbox/agents` | 列出 Redis 映射中的可编辑 Agent 及其分支 |
| POST | `/api/sessions/:id/sandbox/connect` | 返回前端直连下游沙箱所需的地址、workspace、branch 和 latestRunId |

### 文件变更与部署

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/:id/file-changes` | 列出文件变更 |
| POST | `/api/sessions/:id/file-changes/:fid/apply` | 请求下游一键应用 Diff |
| GET | `/api/sessions/:id/events` | 列出会话事件 |
| GET | `/api/sessions/:id/artifacts` | 列出会话产物 |
| GET | `/api/sessions/:id/deployments/preflight` | Vercel 部署前置条件检查 |
| POST | `/api/sessions/:id/deployments` | 触发 Vercel Production 部署 |

### 产物

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/artifacts/:id/content` | 获取产物内容（内联或 OSS 重定向） |
| GET | `/api/artifacts/:id/versions` | 列出产物版本历史 |

### Agent 实例

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents` | 列出所有 Agent 实例 |
| GET | `/api/agents/:id/detail` | Agent 详情（含模板和下游配置） |
| GET | `/api/agents/:id/prompt` | 获取 Agent system prompt |
| POST | `/api/agents` | 从模板创建 Agent 并加入会话 |
| PATCH | `/api/agents/:id` | 更新 Agent 名称、描述、provider |
| DELETE | `/api/agents/:id` | 逻辑删除 Agent |

### Agent 模板

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agent-templates` | 列出所有模板 |
| GET | `/api/agent-templates/:id` | 获取单个模板 |
| POST | `/api/agent-templates` | 创建模板 |
| PATCH | `/api/agent-templates/:id` | 更新模板 |
| DELETE | `/api/agent-templates/:id` | 软删除模板 |

### 模板构建器（Builder）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agent-templates/build` | 列出构建会话 |
| POST | `/api/agent-templates/build/start` | 开始 Agent 模板构建会话 |
| GET | `/api/agent-templates/build/:buildId` | 获取构建会话详情 |
| GET | `/api/agent-templates/build/:buildId/messages` | 获取构建会话消息 |
| POST | `/api/agent-templates/build/:buildId/messages` | 发送构建对话消息 |
| POST | `/api/agent-templates/build/:buildId/confirm` | 确认构建并创建模板 |

### 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 列出活跃项目 |
| POST | `/api/projects` | 创建项目（绑定 GitHub 仓库） |
| PATCH | `/api/projects/:id` | 更新项目信息 |
| DELETE | `/api/projects/:id` | 软删除项目 |

### 下游配置

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/downstream/agents/:agentId/config` | 公开 | 下游 Agent 最小可执行配置 |

## 开发命令

```bash
# 构建 shared 契约
pnpm --filter @agenthub/shared build

# 构建后端
pnpm --filter @agenthub/backend build

# 开发模式启动
cd backend && pnpm dev    # tsx watch 热重载
cd frontend && pnpm dev   # Next.js 热更新

# 类型检查
pnpm --filter @agenthub/backend typecheck
pnpm --filter @agenthub/frontend typecheck

# 全量构建 + 类型检查
pnpm acceptance

# 数据库迁移
cd backend
npx prisma migrate dev
npx prisma generate
npx prisma seed

# Mock Orchestrator（用于本地开发）
cd backend && pnpm mock:orchestrator

# 运行测试
pnpm test
```
