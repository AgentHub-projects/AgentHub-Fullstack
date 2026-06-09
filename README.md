# AgentHub

> Your AI agents, collaborating in one workspace.

**AgentHub** 是一个多 Agent 协作工作台。创建一个 Session，@ 提及你的 Agent，它们会自主协作完成任务 — 你可以在同一界面实时查看运行过程、编辑文件和审查变更。

---

## 特性

- **多 Agent 协作** — 群聊模式下，Orchestrator 自动分配任务给 Worker Agent，你只需 @ 指定目标
- **实时可见** — Socket.IO 实时流式推送消息、事件、产物和文件变更，运行过程完全透明
- **在线编辑** — Inspector 文件面板直连下游沙箱，在线编辑代码并即时接收 Diff 回传
- **变更审查** — Agent 输出的文件修改以 Diff 形式实时展示
- **长期记忆** — pgvector 向量检索 + 摘要链压缩，确保 Agent 始终拥有完整上下文

## 快速开始

```bash
# 1. 启动数据库
cd backend && docker compose up -d

# 2. 配置环境变量
cp backend/.env.example backend/.env
# 填写 AGENTHUB_ADMIN_PASSWORD、DOWNSTREAM_ORCHESTRATOR_WS_URL、OPENAI_API_KEY 等

# 3. 安装 & 初始化
pnpm install
cd backend
npx prisma migrate dev && npx prisma generate
cd ..

# 4. 启动
pnpm --filter @agenthub/backend dev     # 后端 :3001
pnpm --filter @agenthub/frontend dev    # 前端 :3000
```

打开 `http://localhost:3000`，用 `admin` 和 `.env` 中配置的密码登录。

## 架构

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│          Next.js 15 · React 19 · Ant Design      │
│              Socket.IO Client                    │
└─────────────────────┬───────────────────────────┘
                      │ HTTP + WebSocket
┌─────────────────────▼───────────────────────────┐
│                   Backend                        │
│     NestJS · Prisma · PostgreSQL (pgvector)      │
│              Socket.IO · Redis                   │
│         ┌──────────────┐                        │
│         │  Context Svc  │                        │
│         │  Embedding   │  Token Budget │
│         │  Summary     │  Retrieval    │
│         └──────────────┘                        │
└─────────────────────┬───────────────────────────┘
                      │ ACP over WebSocket
┌─────────────────────▼───────────────────────────┐
│            Downstream Orchestrator               │
│     Agent 调度 · Sandbox 管理 · 事件回流           │
└─────────────────────────────────────────────────┘
```

| 层 | 技术栈 |
|---|---|
| Frontend | Next.js 15, React 19, Ant Design, Socket.IO Client |
| Backend | NestJS, Prisma, PostgreSQL (pgvector), Redis, Socket.IO |
| Shared | TypeScript DTO 契约 (`@agenthub/shared`) |
| Downstream | ACP 协议 over WebSocket，Claude Code / Open Code |

## 项目结构

```
AgentHub-Fullstack/
├── shared/src/          # 前后端共享类型 (hub.ts, builder.ts)
├── backend/             # NestJS 后端 :3001
│   ├── prisma/          # 数据库 Schema 与迁移
│   └── src/modules/hub/
│       ├── controllers/ # HTTP API
│       ├── services/    # 业务服务
│       ├── gateways/    # Socket.IO 推送
│       └── auth/        # Cookie 认证
├── frontend/            # Next.js 前端 :3000
│   ├── app/workbench/   # 工作台组件
│   └── lib/workbench/   # 工具库 (diff, markdown, sandbox ...)
└── package.json         # pnpm workspace
```

## 开发

```bash
# 构建
pnpm --filter @agenthub/shared build
pnpm --filter @agenthub/backend build
pnpm --filter @agenthub/frontend build

# 类型检查
pnpm acceptance

# 数据库
cd backend
npx prisma migrate dev
npx prisma generate
```
