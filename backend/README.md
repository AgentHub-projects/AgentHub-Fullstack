# AgentHub Backend P0

NestJS backend for the AgentHub P0 flow.

## Scripts

- `pnpm --filter @agenthub/backend dev`
- `pnpm --filter @agenthub/backend build`
- `pnpm --filter @agenthub/backend typecheck`
- `pnpm --filter @agenthub/backend test`
- `pnpm --filter @agenthub/backend prisma:migrate`

## P0 env

- `PORT`: defaults to `3001`
- `AGENT_COMMAND`: defaults to `claude`
- `MOCK_AGENT=true`: writes deterministic TypeScript sample files instead of invoking Claude
- `AGENTHUB_TEST_REPO_PATH`: defaults to `D:\agent\AgentHub-Test`
- `DATABASE_URL`: used by Prisma migrations
- `AGENTHUB_OSS_BUCKET` / `AGENTHUB_OSS_REGION` / `AGENTHUB_OSS_ENDPOINT`: reserved for OSS artifact storage. Until an OSS adapter is bundled, artifacts are written to the local filesystem fallback and the response metadata includes the fallback reason.
- `AGENTHUB_ARTIFACT_DIR`: optional local artifact fallback directory; defaults to the OS temp directory.
- `AGENTHUB_PGVECTOR_ENABLED=true`: opts into pgvector-backed context search when paired with `DATABASE_URL`. Until a pgvector adapter is bundled, context search returns deterministic local ranking and includes the fallback reason.

## Local Claude Code validation

The real agent path directly invokes the local Claude Code CLI; it does not use an Anthropic SDK or API integration.

1. Install and authenticate Claude Code on the machine running the backend.
2. Verify the CLI is available:
   ```powershell
   Get-Command claude
   ```
3. Unset `MOCK_AGENT` or leave it undefined.
4. Keep `AGENT_COMMAND=claude`, or set `AGENT_COMMAND` to another local wrapper command if needed.
5. Start the backend and run a session. The run emits an `agent_thinking` event and writes `mode`, `command`, and `cwd` evidence to `agent.log` before spawning the CLI.
