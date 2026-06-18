# pencil-sync — Gemini CLI Context

Node.js/TypeScript CLI synchronization tool.

## Stack
- Node.js, TypeScript, chokidar
- Test Runner: `vitest`

## Operational Rules
- Ensure file watching logic is regression tested.

## Workspace Conventions
- `CHANGELOG.md` is append-only and required per commit.
- `shux` task lifecycle management.
- `.pen` files are plaintext JSON (not encrypted) — safe to read/parse directly. See `docs/PEN-FORMAT.md`.
