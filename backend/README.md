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
