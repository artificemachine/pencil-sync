# pencil-sync

Bidirectional sync between Pencil.dev `.pen` design files and frontend code via the Claude CLI.

## Identity

## This Project
- What: pencil-sync
- Stack: Node/TypeScript/Docker
- Status: active

## Guardrails
- Never edit `.env`, credentials, or secrets.
- Never push directly to `main` — always use a feature branch and PR.
- `.pen` files are plaintext JSON (Pencil's documented developer format) — safe to `Read`/`Grep`/`JSON.parse` directly. Prefer the Pencil MCP for structured *writes* (code-to-pen), not because of encryption. See `docs/PEN-FORMAT.md`.
- Run `npm run build && npm test` before any commit.
- Installation decoupling: once installed (e.g., via `npm link` or to `~/.local/bin`), the binary must NEVER depend on the local repository path for execution or data. All paths must be relative to the install root or use standard system config paths (`~/.config`).

## Cross-Agent Protocol
- Run `shux contract` before starting work to see tasks, statuses, and next-task suggestion.
- Run `shux context <task-id>` to load handoff and decisions for the active task.
- Run `shux recall <keywords>` to search past handoffs and ledger.
- Write a handoff via `shux handoff-write` and update task status via `shux task status` before stopping.
- Never read or edit `.superharness/` YAML files directly — always use `shux` CLI (SQLite is the source of truth).

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm run dev          # Compile in watch mode (tsc --watch)
npm test             # Run all tests (Vitest, single pass)
npm run test:watch   # Tests in interactive watch mode
npm start            # Run CLI (node dist/index.js)
npm run watch        # Start file watcher (node dist/index.js watch)
npm run sync         # One-time sync (node dist/index.js sync)
npm link             # Install pencil-sync globally on PATH

# CLI (after npm link or npm run build)
pencil-sync init     # Generate pencil-sync.config.json
pencil-sync sync     # One-time sync run
pencil-sync watch    # Start watching for file changes
```

## Tech Stack

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js >= 20
- **Testing:** Vitest
- **Key deps:** chokidar (file watching), commander (CLI), chalk + ora (output)

## Project Structure

```
src/
  index.ts             CLI entry point (commander)
  sync-engine.ts       Orchestrates pen→code and code→pen sync
  pen-to-code.ts       Reads .pen snapshots, applies color fast path or spawns Claude
  code-to-pen.ts       Detects code changes, spawns Claude to update .pen
  pen-reader.ts        PenReader interface + JsonPenReader for .pen snapshot reading
  claude-runner.ts     Spawns Claude CLI, parses token usage
  prompt-builder.ts    Builds prompts from templates + snapshots
  config.ts            Loads and validates pencil-sync.config.json
  conflict-detector.ts Detects concurrent edits
  state-store.ts       Persists sync state (hashes, snapshots)
  lock-manager.ts      File-based locking
  watcher.ts           Chokidar file watcher
  logger.ts            Chalk-based logger
  types.ts             Shared types and defaults
prompts/               Prompt templates (pen-to-code, code-to-pen, conflict-resolve)
```

## Conventions

- `.pen` files are plaintext JSON — read/parse directly; see `docs/PEN-FORMAT.md` for the schema
- All imports use `.js` extensions (ESM resolution)
- Config merging uses `safeMerge()` to prevent prototype pollution
- Budget tracking via token parsing from Claude CLI `--verbose` stderr

## Superharness Delegation Rules

### Trigger Phrase: contract today
When the user says `contract today`, do this sequence:
1. Read `.superharness/contract.yaml`.
2. Summarize contract id, status, and all tasks with owner/status.
3. If any task is `todo` or `in_progress` and owner is `codex-cli`, you MUST ask exactly:
   "I detected owner is codex-cli. Do you want to delegate `<task_id>` now?"
4. Do not use generic alternatives like "Want me to tackle...".
5. If user says yes:
   - set that task status to `in_progress` (if needed),
   - create/update `.superharness/handoffs/<DATE>-<TASK_ID>.yaml` addressed to `codex-cli`,
   - append one line to `.superharness/ledger.md`,
   - return the exact Codex kickoff command.

### Delegation Execution (Claude -> Codex)
When delegating to Codex, use:
`bash $(git rev-parse --show-toplevel)/../superharness/scripts/delegate-to-codex.sh --project $(git rev-parse --show-toplevel) --task <TASK_ID>`

### Output Contract (Strict)
For `contract today`, if at least one `todo` or `in_progress` task has `owner: codex-cli`, the final line of your response MUST be exactly:
`I detected owner is codex-cli. Do you want to delegate <task_id> now?`
Use the first matching `<task_id>` by priority/order in the contract.

### Unified `contract today` Output (Codex + Claude)
For `contract today`, output must be identical in structure to Codex and Claude:
1. Header: `Contract <id> — <created date>`
2. Full task table/list: include ALL tasks from contract (no truncation), each with `id/title`, `status`, `owner`.
3. If any `todo` or `in_progress` task has owner `codex-cli`, end with exactly:
   `I detected owner is codex-cli. Do you want to delegate <task_id> now?`
4. If no `codex-cli` task is actionable, do not ask that delegation question.
5. Never replace this with generic alternatives.

### contract today Status Format (Mandatory)
For `contract today`, in the Status column you MUST print emoji + text:
- done -> `✅ done`
- in_progress -> `🟡 in_progress`
- todo -> `🔲 todo`
- failed -> `❌ failed`
- stale -> `⚠️ stale`

Do not output plain status text without emoji.

### Trigger Phrase: delegate &lt;TASK_ID&gt; / contract delegate &lt;TASK_ID&gt;
When the user says `delegate <TASK_ID>` or `contract delegate <TASK_ID>`:
1. Read `.superharness/contract.yaml`.
2. Find the task matching `<TASK_ID>`. If not found, respond: "Task `<TASK_ID>` not found in contract."
3. If task `owner` is not `codex-cli`, respond: "Task `<TASK_ID>` is owned by `<owner>`, not codex-cli. Delegation skipped."
4. If task status is `done`, respond: "Task `<TASK_ID>` is already done. Nothing to delegate."
5. Otherwise, execute delegation immediately (no confirmation prompt needed):
   - Set task status to `in_progress` in `.superharness/contract.yaml`.
   - Create/update `.superharness/handoffs/<DATE>-<TASK_ID>.yaml` addressed to `codex-cli`.
   - Append one line to `.superharness/ledger.md`.
   - Return the exact Codex kickoff command.

### delegate Output Contract (Strict)
For `delegate <TASK_ID>` or `contract delegate <TASK_ID>`, output must be:
1. One line: `Delegating <task_id> — <task title>`
2. Confirmation of files written (handoff path, ledger line).
3. Final line: the exact Codex kickoff command:
   `bash $(git rev-parse --show-toplevel)/../superharness/scripts/delegate-to-codex.sh --project $(git rev-parse --show-toplevel) --task <TASK_ID>`

### Canonical contract today Output (Highest Priority)
This section overrides any conflicting `contract today` formatting guidance above.
- Output header exactly: `Contract <id> — <created date>`
- Output next line exactly: `Goal: <goal>`
- Render a Unicode box-drawing table (not markdown) with columns in this exact order:
  1. `ID`
  2. `Title`
  3. `Status`
  4. `Owner`
- Include ALL tasks from contract (no truncation).
- Render one task per single-line row; never wrap/split a task across multiple lines.
- If content exceeds width, truncate with `...` rather than wrapping.
- Add a full horizontal separator line between every task row (Claude-style readability).
- Status must be emoji + text:
  - `done` -> `✅ done`
  - `in_progress` -> `🟡 in_progress`
  - `todo` -> `🔲 todo`
  - `failed` -> `❌ failed`
  - `stale` -> `⚠️ stale`
- If any task is `todo` or `in_progress` and owner is `codex-cli`, the final line MUST be exactly:
  `I detected owner is codex-cli. Do you want to delegate <task_id> now?`
  Use the first matching task in contract order.

