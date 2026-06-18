# MCP Server for pencil-sync

### 1. Scope summary

Build a host-agnostic MCP server entry point (`pencil-sync-mcp`) so Claude Code, Codex CLI, OpenCode, and Gemini CLI can all use pencil-sync as a toolkit — the host agent provides the LLM, pencil-sync provides design-diff primitives and state persistence.

Explicitly **not** built here: a UI, authentication, remote transport (stdio only), multi-project routing, or any change to the existing CLI daemon.

Smallest v1: a stdio MCP server with 6 tools that a host agent can use to understand what changed, get the prompt, apply deterministic color changes, and record the sync result.

Source design discussion: session context (Executor interface refactor + host-agnostic design discussion).

---

### 2. Prerequisites

**New dependencies:**
- `@modelcontextprotocol/sdk` ^1.x (runtime) — provides `McpServer`, `StdioServerTransport`
- `zod` ^3.x (runtime) — MCP SDK 1.x uses zod for tool parameter schemas

**Existing modules touched:**
- `src/logger.ts` — must not write to stdout in MCP mode (JSON-RPC uses stdout)
- `src/config.ts` — `loadConfig()` called by MCP tools
- `src/state-store.ts` — `StateStore`, `hashCodeDir`, `diffHashes`
- `src/conflict-detector.ts` — `detectConflict`
- `src/pen-to-code.ts` — `syncPenToCode`, `applyFillChanges` (private — needs export)
- `src/pen-snapshot.ts` — `snapshotPenFile`, `diffPenSnapshots`
- `src/prompt-builder.ts` — `buildPenToCodePrompt`, `buildCodeToPenPrompt`
- `src/types.ts` — `PencilSyncConfig`, `MappingConfig`, `SyncResult`
- `package.json` — add second `bin` entry, new deps

**Risks:**
- `applyFillChanges` is not exported from `pen-to-code.ts` — must export it in Iteration 4.
- MCP SDK stdio transport behavior on Node.js ≥20 ESM — needs a smoke test that actually connects before claiming green.
- zod version alignment with whatever `@modelcontextprotocol/sdk` peer-requires.

---

### 3. Iterations

---

#### Iteration 1 — Logger stderr routing

**Goal:** Add `setMcpMode()` so all logger output goes to stderr (never stdout) when running as an MCP server — prerequisite for clean JSON-RPC on stdout.

**Shippable on its own?** Yes — purely additive to logger, no behavior change in CLI mode.

**Source references:**
- `src/logger.ts:1-67` — current implementation; `console.log` on lines 28, 33, 53, 63 all write to stdout

**Files touched:**
- `src/logger.ts` (modified)
- `src/__tests__/logger.test.ts` (new)

**Commit message:**
`feat(mcp): route logger output to stderr in MCP mode`

**TDD cycle:**
- RED:
  - `src/__tests__/logger.test.ts::test_setMcpMode_redirects_debug_to_stderr` — after `setMcpMode(true)`, a `log.debug(...)` call must not write to stdout
  - `src/__tests__/logger.test.ts::test_setMcpMode_redirects_info_to_stderr` — same for `log.info`
  - `src/__tests__/logger.test.ts::test_setMcpMode_redirects_success_to_stderr` — same for `log.success`
  - `src/__tests__/logger.test.ts::test_setMcpMode_redirects_sync_to_stderr` — same for `log.sync`
  - `src/__tests__/logger.test.ts::test_mcpMode_false_keeps_stdout` — after `setMcpMode(false)`, `log.info` still uses stdout
  - `src/__tests__/logger.test.ts::test_warn_and_error_already_stderr_unaffected` — `log.warn` and `log.error` use stderr in both modes
- GREEN:
  - Add module-level `let mcpMode = false`
  - Export `setMcpMode(enabled: boolean): void` — sets the flag
  - In each `console.log(...)` call inside `log.debug/info/success/sync`, wrap with: `if (mcpMode) process.stderr.write(formatted + "\n"); else console.log(...)`
  - `log.warn` and `log.error` already use `console.warn`/`console.error` (stderr) — no change needed
- REFACTOR:
  - Extract a private `emit(level, formatted)` helper to avoid the `if (mcpMode)` branch in every method

**Test pyramid for this iteration:**
- Smoke: `import { setMcpMode, log } from "../logger.js"` — no throw
- Unit: 6 tests as listed above; spy on `process.stdout.write` and `process.stderr.write` to assert routing
- Integration: N/A — pure module, no cross-component boundary
- State machine: N/A
- Contract: N/A
- Regression: 1 test — CLI mode (default) produces identical stdout output as before the change
- Chaos: N/A
- E2E: N/A
- Performance: N/A
- TDD Parity: 100% — `setMcpMode` is the only new export
- Coverage delta: +1% → ~82%

**Acceptance criteria:**
- [ ] `setMcpMode(true)` causes `log.debug`, `log.info`, `log.success`, `log.sync` to write to stderr, not stdout
- [ ] `setMcpMode(false)` (the default) leaves existing stdout behavior unchanged
- [ ] `log.warn` and `log.error` write to stderr in both modes
- [ ] All existing 363 tests still pass

**Estimated effort:** S

**Blocked by:** None

---

#### Iteration 2 — MCP server skeleton and bin entry

**Goal:** A runnable `pencil-sync-mcp` binary that starts an MCP stdio server, registers server metadata, and cleanly handles connection — no tools yet.

**Shippable on its own?** Yes — minimal but functional; host agents can connect and enumerate 0 tools.

**Source references:**
- N/A — new file modeled on `@modelcontextprotocol/sdk` README patterns

**Files touched:**
- `package.json` (modified — add `@modelcontextprotocol/sdk`, `zod`, second `bin` entry)
- `tsconfig.json` (check — `include` may need `src/mcp-server.ts`)
- `src/mcp-server.ts` (new)
- `src/__tests__/mcp-server.test.ts` (new)

**Commit message:**
`feat(mcp): add pencil-sync-mcp binary with MCP stdio server skeleton`

**TDD cycle:**
- RED:
  - `src/__tests__/mcp-server.test.ts::test_createMcpServer_returns_server_instance` — `createMcpServer()` returns a non-null object
  - `src/__tests__/mcp-server.test.ts::test_mcp_server_has_correct_name` — server name is `"pencil-sync"`
  - `src/__tests__/mcp-server.test.ts::test_mcp_server_has_correct_version` — version matches `package.json`
- GREEN:
  - `npm install @modelcontextprotocol/sdk zod`
  - Create `src/mcp-server.ts`:
    - Export `createMcpServer(): McpServer` — constructs `new McpServer({ name: "pencil-sync", version: "0.1.5" })`
    - Export `startMcpServer(): Promise<void>` — calls `setMcpMode(true)`, creates server and transport, calls `server.connect(new StdioServerTransport())`
  - Add to `package.json`: `"pencil-sync-mcp": "./dist/mcp-server.js"` under `bin`, `@modelcontextprotocol/sdk` and `zod` in `dependencies`
  - Add shebang and self-invoke guard: `if (process.argv[1] === fileURLToPath(import.meta.url)) startMcpServer()`
- REFACTOR:
  - Extract version constant from `package.json` import to avoid duplication

**Test pyramid for this iteration:**
- Smoke: `import { createMcpServer } from "../mcp-server.js"` — no throw, returns instance
- Unit: 3 tests (name, version, returns instance)
- Integration: N/A — transport connection not testable without a live client
- State machine: N/A
- Contract: 1 test — `server.name === "pencil-sync"` matches MCP protocol expectation
- Regression: 1 test — existing CLI `dist/index.js` bin entry still compiles and exports `main`
- Chaos: N/A
- E2E: N/A
- Performance: N/A
- TDD Parity: 100% — both exports (`createMcpServer`, `startMcpServer`) have tests
- Coverage delta: +1% → ~83%

**Acceptance criteria:**
- [ ] `npm run build` succeeds with no type errors
- [ ] `node dist/mcp-server.js` starts without throwing before any client connects
- [ ] `package.json` has `"pencil-sync-mcp": "./dist/mcp-server.js"` in `bin`
- [ ] `@modelcontextprotocol/sdk` and `zod` appear in `dependencies`
- [ ] All existing tests still pass

**Estimated effort:** S

**Blocked by:** Iteration 1

---

#### Iteration 3 — Read tools: config, diff, conflict

**Goal:** Four MCP tools that give a host agent complete situational awareness: what is configured, what changed in the design, what changed in code, and whether there is a conflict.

**Shippable on its own?** Yes — read-only tools are safe to ship without the recording tool.

**Source references:**
- `src/config.ts` — `loadConfig()` signature and return type
- `src/state-store.ts:22-90` — `StateStore.load()`, `getMappingState()`, `hashCodeDir`, `diffHashes`
- `src/conflict-detector.ts` — `detectConflict(mapping, previousState)` return type
- `src/pen-snapshot.ts` — `snapshotPenFile`, `diffPenSnapshots` signatures
- `src/types.ts` — `PenDiffEntry`, `ConflictInfo`, `MappingConfig`

**Files touched:**
- `src/mcp-server.ts` (modified — register 4 tools)
- `src/__tests__/mcp-server.test.ts` (modified — add tool tests)

**Commit message:**
`feat(mcp): add pencil_get_config, pencil_diff_design, pencil_diff_code, pencil_detect_conflict tools`

**TDD cycle:**
- RED (8 tests):
  - `test_pencil_get_config_returns_config_json` — tool returns parsed config for a valid config file path
  - `test_pencil_get_config_error_on_missing_file` — tool returns error content when file missing
  - `test_pencil_diff_design_returns_diffs` — tool returns `PenDiffEntry[]` for a mapping with a changed .pen file
  - `test_pencil_diff_design_empty_when_no_change` — returns empty array when .pen unchanged
  - `test_pencil_diff_code_returns_changed_files` — tool returns list of changed code files
  - `test_pencil_diff_code_empty_when_no_change` — returns empty list when no code change
  - `test_pencil_detect_conflict_conflict_true` — returns `{ conflict: true, penChanged, codeChanged, changedCodeFiles }` when both sides changed
  - `test_pencil_detect_conflict_no_conflict` — returns `{ conflict: false }` when only one side changed
- GREEN:
  - Register each tool in `createMcpServer()` using `server.tool(name, desc, zodSchema, handler)`
  - `pencil_get_config`: zod `{ configPath: z.string() }` → `loadConfig(configPath)`; serialize to JSON text
  - `pencil_diff_design`: zod `{ configPath, mappingId }` → load config, load state, snapshot + diff .pen
  - `pencil_diff_code`: zod `{ configPath, mappingId }` → load config, load state, `hashCodeDir`, `diffHashes` vs stored hashes
  - `pencil_detect_conflict`: zod `{ configPath, mappingId }` → load config, load state, call `detectConflict`; return typed JSON
  - Tests use temp dirs with staged fixture files (same pattern as existing tests)
- REFACTOR:
  - Extract `loadConfigAndState(configPath, mappingId)` helper — all 3 mapping tools do the same two loads

**Test pyramid for this iteration:**
- Smoke: all 4 tool names appear in `server.listTools()` result
- Unit: 8 tests as listed
- Integration: 2 tests — `pencil_diff_design` and `pencil_detect_conflict` exercise real `StateStore.load()` + file I/O with temp dirs
- State machine: N/A
- Contract: 2 tests — tool responses conform to `{ content: [{ type: "text", text: string }] }` MCP shape
- Regression: 1 test — no existing exported symbol was renamed or removed
- Chaos: 2 tests — `pencil_diff_design` with corrupt .pen returns structured error (not a throw); `pencil_diff_code` with unreadable code dir returns structured error
- E2E: N/A
- Performance: N/A
- TDD Parity: 100% — all 4 tools have unit + contract + at least one chaos test
- Coverage delta: +4% → ~87%

**Acceptance criteria:**
- [ ] `pencil_get_config`, `pencil_diff_design`, `pencil_diff_code`, `pencil_detect_conflict` all appear in `server.listTools()`
- [ ] Each tool returns valid MCP tool response shape `{ content: [{ type: "text", text: string }] }`
- [ ] Corrupt or missing inputs return error text inside `content[0].text`, never throw to the transport
- [ ] All existing tests still pass

**Estimated effort:** M

**Blocked by:** Iteration 2

---

#### Iteration 4 — Prompt delivery, fill fast-path, and sync recording

**Goal:** Three MCP tools that complete the agent workflow: get the prompt to apply changes, apply deterministic fill changes directly, and record the sync result in state.

**Shippable on its own?** Yes — together with Iteration 3, this closes the full bidirectional sync loop for any host agent.

**Source references:**
- `src/prompt-builder.ts` — `buildPenToCodePrompt`, `buildCodeToPenPrompt` signatures
- `src/pen-to-code.ts:44-128` — `applyFillChanges` (currently private — must be exported)
- `src/state-store.ts:86-end` — `StateStore.updateMappingState()` signature
- `src/types.ts` — `SyncDirection`, `PenNodeSnapshot`

**Files touched:**
- `src/pen-to-code.ts` (modified — export `applyFillChanges`)
- `src/mcp-server.ts` (modified — register 3 new tools)
- `src/__tests__/mcp-server.test.ts` (modified — add tool tests)
- `src/__tests__/pen-to-code.test.ts` (modified — regression test for the new export)

**Commit message:**
`feat(mcp): add pencil_build_prompt, pencil_apply_fill_changes, pencil_record_sync tools`

**TDD cycle:**
- RED (9 tests):
  - `test_pencil_build_prompt_pen_to_code_returns_string` — tool returns non-empty prompt string for a pen-to-code request
  - `test_pencil_build_prompt_code_to_pen_returns_string` — same for code-to-pen
  - `test_pencil_build_prompt_includes_diff_context` — prompt content references the mapping's design diffs
  - `test_pencil_apply_fill_changes_updates_css` — tool writes updated CSS variable values and returns `filesChanged`
  - `test_pencil_apply_fill_changes_empty_when_no_css_file` — returns `{ filesChanged: [], errors: [...] }` when no CSS file configured
  - `test_pencil_apply_fill_changes_chaos_corrupt_hex` — returns structured error (not throw) when hex value is malformed
  - `test_pencil_record_sync_updates_state_store` — calling tool updates `StateStore` and returns `{ ok: true }`
  - `test_pencil_record_sync_pen_to_code_direction` — state correctly records pen-to-code direction
  - `test_pencil_record_sync_code_to_pen_direction` — state correctly records code-to-pen direction
  - Regression: `test_applyFillChanges_export_is_backward_compatible` — confirms the now-exported function works identically to existing tests
- GREEN:
  - Export `applyFillChanges` from `pen-to-code.ts`
  - Register `pencil_build_prompt`: zod `{ configPath, mappingId, direction: z.enum(["pen-to-code","code-to-pen"]), diffs?: z.array(...) }` → call `buildPenToCodePrompt` or `buildCodeToPenPrompt`; return prompt string
  - Register `pencil_apply_fill_changes`: zod `{ configPath, mappingId, fills: z.array(...) }` → load config, call `applyFillChanges(mapping, fills)`; return `{ filesChanged, errors }`
  - Register `pencil_record_sync`: zod `{ configPath, mappingId, direction, filesChanged: z.array(z.string()) }` → load config, load state, call `stateStore.updateMappingState(mapping, direction)`; return `{ ok: true }`
- REFACTOR:
  - None — the GREEN code is already factored through the existing helpers

**Test pyramid for this iteration:**
- Smoke: all 3 new tool names appear in `server.listTools()` (total: 7 tools)
- Unit: 9 tests as listed
- Integration: 2 tests — `pencil_apply_fill_changes` exercises real CSS file I/O; `pencil_record_sync` exercises real `StateStore` write
- State machine: 2 tests — `pencil_record_sync` correctly transitions mapping state from initial → synced (pen-to-code) and initial → synced (code-to-pen)
- Contract: 1 test — all 7 tools return `{ content: [{ type: "text", text: string }] }` (full server contract check)
- Regression: 1 test — `applyFillChanges` export does not break existing pen-to-code behavior
- Chaos: 2 tests — `pencil_build_prompt` with missing prompt template files returns error content; `pencil_record_sync` with invalid mappingId returns structured error
- E2E: 1 test — simulate a complete host agent workflow: `pencil_get_config` → `pencil_diff_design` → `pencil_build_prompt` → (agent applies edits) → `pencil_record_sync` → state persisted
- Performance: N/A
- TDD Parity: 100% — all 3 new tools have unit + integration + chaos
- Coverage delta: +3% → ~90%

**Acceptance criteria:**
- [ ] `pencil_build_prompt` returns the full prompt string a host agent needs to make code changes
- [ ] `pencil_apply_fill_changes` correctly rewrites CSS variable values in temp fixtures
- [ ] `pencil_record_sync` persists the sync direction and timestamp to `StateStore`
- [ ] E2E workflow test (get config → diff → prompt → record) passes end-to-end
- [ ] `npm run build && npm test` both green
- [ ] `applyFillChanges` export does not regress any existing pen-to-code test

**Estimated effort:** M

**Blocked by:** Iteration 3

---

### 4. Test inventory summary

| Iter | Smoke | Unit | Integration | State machine | Contract | Regression | Chaos | E2E | Performance | TDD Parity | Coverage delta |
|------|-------|------|-------------|---------------|----------|------------|-------|-----|-------------|------------|----------------|
| 1 | 1 | 6 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 100% | +1% → ~82% |
| 2 | 1 | 3 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 100% | +1% → ~83% |
| 3 | 1 | 8 | 2 | 0 | 2 | 1 | 2 | 0 | 0 | 100% | +4% → ~87% |
| 4 | 1 | 9 | 2 | 2 | 1 | 1 | 2 | 1 | 0 | 100% | +3% → ~90% |

---

### 5. End-to-end definition of done

**All acceptance criteria across all iterations:**
- `setMcpMode(true)` routes all log output to stderr
- `pencil-sync-mcp` binary starts without error on Node.js >=20
- 7 MCP tools registered: `pencil_get_config`, `pencil_diff_design`, `pencil_diff_code`, `pencil_detect_conflict`, `pencil_build_prompt`, `pencil_apply_fill_changes`, `pencil_record_sync`
- All tools return valid MCP response shape; errors surface as structured text, never as transport throws
- Full bidirectional workflow (design diff → prompt → agent edits → record) is covered by the E2E test
- `npm run build && npm test` green with coverage >= existing thresholds

**Demo script (manual end-to-end):**
1. `npm run build`
2. Register pencil-sync-mcp as an MCP server in Claude Code config pointing to `dist/mcp-server.js`
3. Open a Claude Code session, confirm `pencil_get_config` is available in tool list
4. Call `pencil_diff_design` on a fixture mapping — confirm it returns a `PenDiffEntry[]` JSON
5. Call `pencil_build_prompt` — confirm the returned text is a valid prompt referencing the diffs
6. Call `pencil_apply_fill_changes` with a color diff — confirm the CSS fixture file was updated
7. Call `pencil_record_sync` — confirm state file updated on disk

**Test command:**
```bash
npm run build && npm test
```

Explicit test files that must be green:
- `src/__tests__/logger.test.ts`
- `src/__tests__/mcp-server.test.ts`
- `src/__tests__/pen-to-code.test.ts`
- `src/__tests__/code-to-pen.test.ts`
- `src/__tests__/sync-engine.test.ts`
- `src/__tests__/executor.test.ts`

---

### 6. Out of scope

- **Remote/SSE transport** — stdio-only for v1; HTTP+SSE deferred until a host agent needs it (uncertain demand)
- **MCP server auth** — no auth in v1; server is a local binary invoked by the host agent directly
- **`pencil_watch` tool** — file watching via MCP deferred; host agents can trigger syncs manually
- **`pencil_estimate_cost` tool** — budget estimation deferred; Claude-specific, not useful for Codex/Gemini
- **Auto-config discovery** — MCP tools require explicit `configPath` param; walking up the directory tree to find `pencil-sync.config.json` deferred to a follow-up

---

### 7. Open questions

1. **`applyFillChanges` export**: `pen-to-code.ts` currently keeps it private. Iteration 4 exports it. If that creates an unwanted public API surface, the MCP tool can instead re-implement the fill substitution inline (40 lines). Decision: export it — the function is stable and tested; inlining would be duplication.

2. **zod peer version**: `@modelcontextprotocol/sdk` may peer-require a specific zod version. If it conflicts with the project's existing zod (none currently), pin to whatever the SDK requires. No action needed before Iteration 2 since `npm install` will surface this immediately.
