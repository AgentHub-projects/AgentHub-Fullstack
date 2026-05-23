# AgentHub Fullstack

AgentHub fullstack workspace.

## Workspace

- `shared`: P0 TypeScript contracts shared by frontend and backend.

## Commands

```powershell
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Root scripts dispatch to workspace packages with `--if-present`, so packages can add commands incrementally.
