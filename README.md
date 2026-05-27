# AgentHub Fullstack

AgentHub IM-style multi-agent coding workbench — monorepo with NestJS backend, Next.js frontend, shared TypeScript contracts, and a downstream JSON-RPC adapter layer.

## Quickstart (empty DB)

```bash
# 1. Start PostgreSQL
cd backend
docker compose up -d

# 2. Install deps (from repo root)
pnpm install

# 3. Run migrations
cd backend
pnpm prisma:migrate

# 4. Seed default agent definitions
pnpm prisma:seed

# 5. Start backend (default port 3001)
pnpm dev

# 6. Start frontend (separate terminal, port 3000 by Next.js default)
cd frontend
pnpm dev
```

After startup, open `http://localhost:3000` — the workbench polls `GET /api/session/current` and connects to the WebSocket on port 3001.

## Environment Variables

### Root (.env)

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Node environment |
| `VITE_API_BASE_URL` | `http://localhost:3000` | Frontend API base (used by Next.js at build time as `NEXT_PUBLIC_API_BASE_URL`) |
| `PORT` | `3000` | Backend listen port |

### Backend (`backend/.env`)

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3001` | No | Backend listen port |
| `DATABASE_URL` | `postgresql://agenthub:agenthub@localhost:5432/agenthub?schema=public` | Yes (for Prisma) | PostgreSQL connection string |
| `AGENT_COMMAND` | `claude` | No | CLI command to invoke for real agent runs |
| `MOCK_AGENT` | (unset) | No | Set to `true` for deterministic local fixtures without real Claude CLI |
| `AGENTHUB_TEST_REPO_PATH` | `D:\agent\AgentHub-Test` | No | Path to test repository for worktree operations |

## OSS / pgvector Fallback Notes

- **Database**: The Prisma schema targets PostgreSQL 16. No pgvector extension is required — the current schema uses no vector embeddings. If future versions add RAG/embedding features, a `pgvector` extension or an in-process embedding provider (e.g. `@xenova/transformers`) can be added as an opt-in fallback.
- **Mock orchestrator**: When `MOCK_AGENT=true`, the backend uses an in-process `MockOrchestrator` that speaks the full JSON-RPC 2.0 North protocol without any external downstream dependency. No API keys or cloud services are required for the demo.
- **InMemory transport**: The downstream adapter defaults to an in-memory transport pair. Swap to `SocketIOTransport` when connecting to a real orchestrator — the `bootstrapDownstream()` function in `backend/src/modules/downstream.bootstrap.ts` is the single-line change point.
- **Offline mode**: The backend starts successfully even without a database connection. `PrismaService` logs a warning and continues — non-DB endpoints (health, stubs) remain functional.

## AI Collaboration Record

This project was built by a multi-agent team operating on the Multica platform:

| Issue | Agent | Scope |
|---|---|---|
| AGE-1 | 架构师 (Architect) | Project scaffolding, pnpm workspace, shared types |
| AGE-2 | 架构师 (Architect) | Architecture design and issue decomposition |
| AGE-3 | Backend Agent | NestJS hub API: session CRUD, agent runner, WebSocket gateway |
| AGE-4 | Frontend Agent | Next.js workbench UI with IM-style chat, agent roster, inspector panel |
| AGE-5 | Backend Agent | Downstream adapter: JSON-RPC transport, north-adapter, session-manager, mock orchestrator |
| AGE-6 | Backend Agent | Event/artifact/context fact source: durable repos, durable fact source services |
| AGE-7 | fullstack-e2e Agent | E2E verification, demo data, README runbook, integration tests |
| AGE-12 | Review Agent | Code review and rework tracking |

**AI-authored ratio**: All source code under `backend/src/`, `backend/test/`, `frontend/app/`, `frontend/lib/`, `frontend/test/`, `shared/src/`, and configuration files was authored by AI agents (NestJS, Next.js, Prisma schema, TypeScript types, tests). Human review was performed on architectural decisions and final acceptance.

**Tools used**: Claude (Anthropic) via local CLI and Multica platform SDK. NestJS 11, Next.js 15, Prisma 6, Socket.IO 4, Vitest 3, pnpm 10.

## Architecture

```
┌──────────────┐     HTTP/WS      ┌──────────────┐    JSON-RPC 2.0    ┌──────────────────┐
│  Next.js FE  │ ◄──────────────► │  NestJS BE   │ ◄───────────────► │  Downstream       │
│  (port 3000) │   REST + Socket  │  (port 3001) │   North protocol   │  Orchestrator     │
└──────────────┘                  └──────────────┘                    └──────────────────┘
                                        │
                                   ┌────┴────┐
                                   │ Prisma  │
                                   │  (PG)   │
                                   └─────────┘
```

### Workspace Packages

| Package | Path | Description |
|---|---|---|
| `@agenthub/shared` | `shared/` | TypeScript contracts shared by frontend and backend |
| `@agenthub/backend` | `backend/` | NestJS hub API, WebSocket gateway, downstream adapter |
| Frontend | `frontend/` | Next.js workbench UI |

### Backend Modules

- **Controllers**: `SessionController` (run/cancel/current), `StubController` (agents, conversations, pinned context, artifacts, code-apply), `HealthController`, `FactSourceController`
- **Services**: `SessionService`, `AgentRunner`, `PrismaService`, `EventStoreService`, `ArtifactService`, `ContextService`, `WorktreeService`, `RunStateService`, `FactSourceRepository`, `PrismaFactSourceRepository`, `MemoryFactSourceRepository`
- **Realtime**: `AgentEventsGateway` — Socket.IO gateway emitting `agent:event`, `session:event`, `AgentEvent`
- **Downstream**: `NorthAdapter` (JSON-RPC client), `DownstreamSessionManager`, `MockOrchestrator`, `InMemoryTransport`/`SocketIOTransport`, `PrismaPersistence`
- **Filters**: `AllExceptionsFilter` — global error boundary

### Frontend Pages

- `/` — Workbench: IM-style chat, agent roster, session inspector, diff tree, artifact preview
- Direct mode: single-agent prompt → run
- Group mode: multi-agent with @mentions

## Commands

```bash
pnpm install          # Install all workspace dependencies
pnpm build            # Build shared types + backend
pnpm typecheck        # TypeScript type checking across workspaces
pnpm test             # Run all vitest suites
pnpm lint             # TypeScript compiler checks
```

Backend-specific:

```bash
cd backend
pnpm dev                  # Start dev server with hot reload
pnpm prisma:generate      # Generate Prisma client
pnpm prisma:migrate       # Run pending migrations
pnpm prisma:seed          # Seed default agent definitions
pnpm test                 # Run backend vitest suites
```

## Demo Data

Load `demo/demo-data.json` for mock orchestrator fixture data covering:

- **Direct-agent flow**: Single Claude Code prompt → streamed text_delta events → completion
- **Multi-agent group flow**: Orchestrator + Frontend + Backend + Review agents with @mentions, group rendering, agent roster selection
- **Cancel flow**: Mid-stream cancellation via `POST /api/agent-runs/:runId/cancel`
- **Downstream protocol**: Full JSON-RPC 2.0 initialize → session/new → session/prompt → session/event → ack cycle

Agent roster and seed data in `demo/demo-data.json` match the backend `prisma/seed.ts` defaults and the frontend `AGENT_DIRECTORY` constant.

## 3-Minute Demo Script

### Minute 1: Empty DB Startup (30s setup + 30s verify)

```bash
# Terminal 1: Infrastructure
cd backend && docker compose up -d
cd backend && pnpm prisma:migrate && pnpm prisma:seed

# Terminal 2: Backend
cd backend && pnpm dev
# Verify: curl http://localhost:3001/api/health → {"ok":true,...}

# Terminal 3: Frontend
cd frontend && pnpm dev
# Open http://localhost:3000
```

**Checkpoint**: Workbench renders offline empty state. "后端连接失败" banner may show before the first poll cycle completes. Socket badge shows `connecting` → `connected`.

### Minute 2: Direct-Agent Run (MOCK_AGENT=true)

1. Set `MOCK_AGENT=true` in `backend/.env`, restart backend.
2. In the workbench, verify mode is "Direct" and agent "Claude Code" (CC) is selected.
3. Keep default prompt: "帮我写一个前后端分离的架构的todolist系统。"
4. Click **Run**.
5. Observe:
   - Status bar: Session → Run → Stream steps light up
   - Messages pane: "Claude Code · done" with mock-generated text
   - Raw Event Stream: `agent_thinking` → `text_delta` × 3 → `agent_completed` → `done`
   - Inspector: Contract fields populate with real `SessionDto` values
   - Diff File Tree: empty (mock agent does not emit code_diff)
   - Artifact Preview: empty (mock agent does not emit preview_card)

**Checkpoint**: Real end-to-end flow confirmed — frontend POST /api/session/run → backend mock agent runner → Socket events → frontend renders merged messages.

### Minute 3: Group Mode + Inspection

1. Click **Group** mode toggle.
2. Observe: agent roster shifts — Orchestrator, Frontend, Backend, Review auto-selected.
3. Click **Run** (mock agent re-runs with group config).
4. Observe:
   - @Agent Menu shows 4 selected agents
   - Mention buttons insert `@AgentName` into prompt
   - Team Status panel shows agent roles
   - Raw Event Stream groups events by agentId

**Wrap up**:
- Switch back to Direct mode, toggle agents.
- Open `demo/demo-data.json` and point to the downstream protocol flow for the full JSON-RPC cycle.
- Run `pnpm test` to show passing test suites (backend + frontend).

---

## Test Suites

| Suite | File | Coverage |
|---|---|---|
| Hub API | `backend/test/hub-api.spec.ts` | Session run/cancel/current REST endpoints |
| WebSocket flow | `backend/test/websocket-flow.spec.ts` | Socket.IO event emission and subscription |
| Stub controller | `backend/test/stub.controller.spec.ts` | Stub endpoints (agents, conversations, etc.) |
| Adapter stub | `backend/test/adapter-stub.spec.ts` | StubController with Prisma integration |
| Agent runner | `backend/test/agent-runner.spec.ts` | Mock agent execution and output |
| Downstream wiring | `backend/test/downstream-wiring.spec.ts` | North protocol JSON-RPC lifecycle |
| Downstream session | `backend/test/downstream-session-manager.spec.ts` | Session bind/prompt/cancel/error |
| North adapter | `backend/test/north-adapter.spec.ts` | JSON-RPC client request/response/error |
| Session service | `backend/test/session.service.spec.ts` | Service layer unit tests |
| Prisma schema | `backend/test/prisma-schema.spec.ts` | Schema model validation |
| Artifact/context | `backend/test/artifact-context.spec.ts` | Artifact and context service tests |
| Fact source | `backend/test/fact-source.service.spec.ts` | Durable fact source repository |
| Exception filter | `backend/test/all-exceptions.filter.spec.ts` | Global error boundary |
| Worktree service | `backend/test/worktree.service.spec.ts` | Git worktree management |
| Frontend smoke | `frontend/test/workbench-smoke.spec.ts` | Initial state, type contracts, inspector fields |

Run all: `pnpm test` from repo root, or `cd backend && pnpm test` / `cd frontend && pnpm test`.
