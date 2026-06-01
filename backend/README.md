# AgentHub Backend

NestJS backend for AgentHub's message gateway, persistence, realtime push, context snapshot, and downstream Orchestrator bridge.

## Responsibility Boundary

This backend does not implement agent-to-agent scheduling. It receives user messages from the frontend, persists the message and run state, builds an AgentHub context snapshot, forwards the task plus `mentionedAgentIds` to the downstream Orchestrator, then persists and broadcasts downstream events back to the frontend.

Message flow:

```text
Frontend POST /api/sessions/:id/messages
  -> PostgreSQL message/run/context_snapshot
  -> Downstream Orchestrator session/prompt
  -> downstream session/event frames
  -> agent_events + derived messages/artifacts/file_changes
  -> Socket.IO push to frontend
```

When `DOWNSTREAM_ORCHESTRATOR_WS_URL` is not configured, the backend uses the built-in mock Orchestrator path. That path emits `message.delta`, `file.change`, `artifact.upsert`, `message.completed`, and `run.completed`, so the frontend and persistence flow can be demonstrated without a real Agent runtime.

## Stack

- NestJS 11
- Prisma 6
- PostgreSQL 15+ with pgvector
- Socket.IO for frontend realtime and downstream bridge
- Optional Aliyun OSS for binary artifacts
- OpenAI-compatible APIs for embeddings and summaries

## Environment

Create `backend/.env`:

```env
PORT=3001
DATABASE_URL=postgresql://agenthub:agenthub@localhost:5432/agenthub?schema=public
REDIS_URL=redis://localhost:6379

# Seed 会创建账号 admin；真实密码只放本地 .env。
AGENTHUB_ADMIN_PASSWORD=change-me

# Optional. If omitted, the built-in mock Orchestrator is used.
DOWNSTREAM_ORCHESTRATOR_WS_URL=http://localhost:4000/acp

# Optional context retrieval.
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
CONTEXT_EMBEDDING_MODEL=text-embedding-3-small

# Optional summary model. Falls back to simple truncation when omitted.
SUMMARY_API_KEY=sk-...
SUMMARY_BASE_URL=https://api.deepseek.com/v1
CONTEXT_SUMMARY_MODEL=deepseek-chat

# Optional binary artifact storage.
ALIYUN_OSS_REGION=oss-cn-hangzhou
ALIYUN_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
ALIYUN_OSS_BUCKET=your-bucket
ALIYUN_OSS_ACCESS_KEY_ID=...
ALIYUN_OSS_ACCESS_KEY_SECRET=...
ARTIFACT_OSS_PREFIX=agenthub/artifacts

# Optional deployment service. AgentHub polls this service every 3 seconds.
DEPLOY_SERVICE_URL=http://localhost:4001
DEPLOY_SERVICE_API_KEY=change-me
```

## Local Setup

From the repository root:

```powershell
pnpm install
```

Start PostgreSQL with pgvector:

```powershell
cd backend
docker compose up -d
```

Apply migrations and seed default Agent templates/instances:

```powershell
pnpm prisma:migrate
pnpm prisma:seed
```

Start the backend:

```powershell
pnpm dev
```

Health check:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
```

## Useful Commands

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm prisma:generate
pnpm prisma:migrate
pnpm prisma:seed
```

From the repository root, the current full build check is:

```powershell
pnpm acceptance
```

## Main API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend health check |
| `GET` | `/api/auth/me` | Read login state |
| `POST` | `/api/auth/login` | Login and create a Redis-backed Cookie session |
| `POST` | `/api/auth/logout` | Logout and clear the session |
| `GET` | `/api/agents` | List Agent instances |
| `GET` | `/api/agents/:agentId/detail` | Read Agent instance detail plus executable downstream `config` |
| `POST` | `/api/agents` | Create a session-owned Agent instance from a template |
| `PATCH` | `/api/agents/:agentId` | Update instance name, description, or provider |
| `DELETE` | `/api/agents/:agentId` | Logically delete an Agent instance |
| `GET` | `/api/agent-templates` | List Agent templates |
| `POST` | `/api/agent-templates` | Create an Agent template |
| `PATCH` | `/api/agent-templates/:templateId` | Update an Agent template |
| `DELETE` | `/api/agent-templates/:templateId` | Disable an Agent template |
| `GET` | `/api/downstream/agents/:agentId/config` | Public downstream config endpoint; validates `agentId` but does not require frontend auth |
| `GET` | `/api/sessions` | List sessions |
| `POST` | `/api/sessions` | Create a session |
| `GET` | `/api/sessions/:sessionId` | Load session snapshot |
| `PATCH` | `/api/sessions/:sessionId` | Rename or pin a session |
| `POST` | `/api/sessions/:sessionId/archive` | Archive a session and close its downstream connection |
| `DELETE` | `/api/sessions/:sessionId` | Logically delete a session |
| `POST` | `/api/sessions/:sessionId/messages` | Persist user message and start a run |
| `POST` | `/api/sessions/:sessionId/messages/:messageId/pin` | Pin/unpin a message |
| `POST` | `/api/sessions/:sessionId/messages/:messageId/regenerate` | Regenerate from the source user message |
| `POST` | `/api/sessions/:sessionId/uploads` | Upload an attachment before sending a message |
| `POST` | `/api/sessions/:sessionId/runs/:runId/cancel` | Cancel a run |
| `GET` | `/api/sessions/:sessionId/events` | Replay persisted events |
| `GET` | `/api/sessions/:sessionId/artifacts` | List artifacts |
| `GET` | `/api/sessions/:sessionId/file-changes` | List file changes |
| `POST` | `/api/sessions/:sessionId/file-changes/:fileChangeId/apply` | Ask downstream to apply a file change |
| `POST` | `/api/sessions/:sessionId/deployments` | Trigger deployment for the latest successful pushed commit |
| `GET` | `/api/projects` | List active projects |
| `POST` | `/api/projects` | Create a project binding target |
| `PATCH` | `/api/projects/:projectId` | Update project metadata |
| `DELETE` | `/api/projects/:projectId` | Logically delete a project |
| `GET` | `/api/artifacts/:artifactId/content` | Read or redirect artifact content |
| `GET` | `/api/artifacts/:artifactId/versions` | List artifact versions |

Frontend-facing routes are protected by the `agenthub_session` cookie. The downstream config route is intentionally public for the local downstream runtime and relies on parameter validation instead of a shared secret.

## Realtime Events

Frontend clients subscribe with Socket.IO:

```text
event: session.subscribe
body: { "sessionId": "<session-id>" }
```

The backend emits:

- `hub:event` for normalized run events
- `hub:session` for session metadata updates
- `hub:artifact` for artifact upserts/completion
- `hub:file_change` for file snapshots/diffs
- `hub:context` for context snapshots

The database remains the source of truth. Refreshing the frontend should rebuild the timeline from REST snapshots and persisted `agent_events`.
