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

# Optional. If omitted, the built-in mock Orchestrator is used.
DOWNSTREAM_ORCHESTRATOR_WS_URL=http://115.33.108.104:31056/acp

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
| `GET` | `/api/agents` | List Agent instances |
| `GET` | `/api/agent-templates` | List Agent templates |
| `GET` | `/api/sessions` | List sessions |
| `POST` | `/api/sessions` | Create a session |
| `GET` | `/api/sessions/:sessionId` | Load session snapshot |
| `POST` | `/api/sessions/:sessionId/messages` | Persist user message and start a run |
| `POST` | `/api/sessions/:sessionId/messages/:messageId/pin` | Pin/unpin a message |
| `POST` | `/api/sessions/:sessionId/runs/:runId/cancel` | Cancel a run |
| `GET` | `/api/sessions/:sessionId/events` | Replay persisted events |
| `GET` | `/api/sessions/:sessionId/artifacts` | List artifacts |
| `GET` | `/api/sessions/:sessionId/file-changes` | List file changes |
| `GET` | `/api/artifacts/:artifactId/content` | Read or redirect artifact content |

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
