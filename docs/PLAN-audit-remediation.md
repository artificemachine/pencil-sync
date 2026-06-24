# Implementation Plan — pencil-sync audit remediation

> Input contract for `/plan-implement`. Source: `docs/AUDIT-deep-bug-hunt.md`.
> Two clusters are already shipped on branch `fix/diff-completeness-and-color-fastpath`
> (diff-completeness in `pen-snapshot.ts`, color fast-path in `pen-to-code.ts`); this plan
> covers what remains.

## 1. Scope summary

Remediate the confirmed correctness, data-integrity, lifecycle, and config defects surfaced by the deep bug hunt. The dominant theme is **false success** (failures reported as clean syncs) and **silent data loss**. NOT building: new features, the multi-provider feature surface beyond making the *existing* config coherent, brand-new-node diffing (deliberate skip), or prompt-injection sandboxing (design decision, deferred).

**Smallest possible v1:** Iterations 1–3 only (stop the sync pipeline from reporting false success). Everything else is incremental hardening.

**Scope decision:** covers every verified finding (≥2 votes) plus the high-confidence new HIGHs. Long tail (lows/info, unverified mediums, prompt-injection) deferred to §6.

**Source design doc:** `docs/AUDIT-deep-bug-hunt.md`.

> Coverage baseline NOT measured (573 tests / 32 files, no `--coverage` run). All Coverage Δ values are estimates (`est.`).

## 2. Prerequisites

- **Dependencies:** none new. `zod@^4` (already a dep) used in Iter 5. `vitest` present.
- **Code areas touched:** `src/pen-to-code.ts`, `src/code-to-pen.ts`, `src/pencil-mcp-client.ts`, `src/mcp-server.ts`, `src/config.ts`, `src/state-store.ts`, `src/watcher.ts`, `src/sync-engine.ts`, `src/claude-runner.ts`, `src/glob-matcher.ts`, `src/ai/*.ts`, `src/types.ts`, plus `src/__tests__/*`.
- **Risks:** (a) Iters 2–4 change MCP/result semantics — host agents that ignored `isError` will now see failures; (b) Iter 4 provider wiring may reveal the direct-API path was never exercised; (c) Iter 8 lifecycle changes interact with `ShutdownManager` ordering; (d) no measured coverage baseline.

## 3. Iterations

### Iteration 1 — Honest pen-to-code results (no false success)

**Goal:** syncPenToCode stops reporting success when a fill matched zero CSS declarations on a mixed diff, and when Claude exits 0 but edits zero files while diffs existed.

**Shippable on its own?** Yes — pure result-honesty change in one module.

**Source references:**
- `src/pen-to-code.ts` (syncPenToCode L205-324, executeClaudeSync L150-203) — current routing/return shape
- `docs/AUDIT-deep-bug-hunt.md` — "Fill failures hidden on mixed diffs" (3/3), "executeClaudeSync reports success when Claude changes zero files" (2/2)

**Files touched:**
- `src/pen-to-code.ts` (modified)
- `src/__tests__/pen-to-code.test.ts` (modified)

**Commit message:**
`fix(pen-to-code): surface fill zero-match and Claude no-op as warnings/failure instead of false success`

**TDD cycle:**
- RED:
  - `pen-to-code.test.ts::mixed diff carries fill warnings into the final result`
  - `pen-to-code.test.ts::Claude success with zero file changes and pending diffs is not reported as success`
- GREEN:
  - Thread `fillWarnings` from executeFillFastPath into executeClaudeSync's returned `warnings`.
  - In executeClaudeSync, if `claudeFiles.length === 0` and inbound diffs were non-empty → return failure.
- REFACTOR: extract `mergeWarnings(result, warnings)` helper; otherwise None.

**Test pyramid:**
- Smoke: module imports; existing syncPenToCode happy path green.
- Unit: 2 new + fast-path-only success path unchanged.
- Integration: N/A — single module, executor mocked.
- State machine: N/A.
- Contract: N/A.
- Regression: 2 (per finding).
- Chaos: no-op/zero-match degenerate executor output.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: 100%.
- Coverage: est. +1%.

**Acceptance criteria (binary):**
- [ ] Mixed color+text diff where the color old-RGB is absent → `result.warnings` non-empty.
- [ ] Executor exits success, zero files changed, diffs existed → `result.success === false`.
- [ ] All previously-passing pen-to-code tests still pass.

**Estimated effort:** S
**Blocked by:** None

### Iteration 2 — MCP tool error signaling (isError)

**Goal:** pencil-sync MCP tools return `isError: true` on failure, and pencil_apply_fill_changes reports failure when zero declarations matched or errors are populated.

**Shippable on its own?** Yes.

**Source references:**
- `src/mcp-server.ts` (err L24-26; ok L20-22; apply_fill_changes L153-170)
- AUDIT — "err() never sets isError" (2/2), "pencil_apply_fill_changes success-shaped on zero matches" (2/2)

**Files touched:**
- `src/mcp-server.ts` (modified)
- `src/__tests__/mcp-server.test.ts` (modified)

**Commit message:**
`fix(mcp): set isError on tool failures and report apply_fill_changes zero-match as error`

**TDD cycle:**
- RED:
  - `mcp-server.test.ts::err() result carries isError true`
  - `mcp-server.test.ts::apply_fill_changes with no matched declarations returns isError`
- GREEN:
  - `err()` returns `{ content: [...], isError: true }`.
  - apply_fill_changes: if `filesChanged.length === 0 && errors.length > 0` → return via `err(...)`.
- REFACTOR: None.

**Test pyramid:**
- Smoke: createMcpServer() builds.
- Unit: 2 new + a success-path tool returns no isError.
- Integration: N/A.
- State machine: N/A.
- Contract: 1 — CallToolResult shape (`isError` only on failure).
- Regression: 2.
- Chaos: unknown mappingId, unmatched fill.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: 100%.
- Coverage: est. +1%.

**Acceptance criteria (binary):**
- [ ] Every tool catch-path result has `isError === true`.
- [ ] Successful tool results have no `isError` (or `false`).
- [ ] apply_fill_changes zero-match → `isError === true`.

**Estimated effort:** S
**Blocked by:** None

### Iteration 3 — Pencil MCP client + code-to-pen failure propagation

**Goal:** PencilMcpClient surfaces server-side tool errors (isError) instead of swallowing them, and code-to-pen reports failure on no-op/unreadable .pen.

**Shippable on its own?** Yes.

**Source references:**
- `src/pencil-mcp-client.ts` (batchDesign L94-99, batchGet L81-92) — read full file first
- `src/code-to-pen.ts` (syncCodeToPenDirect L63-176, post-write read L142-159)
- AUDIT — "batchDesign ignores MCP isError" (HIGH), "batchGet swallows errors → {}" (MED), "code-to-pen success on no-op/unreadable" (2/2)

**Files touched:**
- `src/pencil-mcp-client.ts` (modified)
- `src/code-to-pen.ts` (modified)
- `src/__tests__/code-to-pen.test.ts` (modified)
- `src/__tests__/pencil-mcp-client.test.ts` (new if none)

**Commit message:**
`fix(code-to-pen): propagate Pencil MCP tool errors and treat no-op/unreadable .pen as failure`

**TDD cycle:**
- RED:
  - `pencil-mcp-client.test.ts::batchDesign throws on isError result`
  - `pencil-mcp-client.test.ts::batchGet throws/propagates on isError instead of returning {}`
  - `code-to-pen.test.ts::unreadable .pen after batch_design → result.success false`
  - `code-to-pen.test.ts::pen unchanged after batch_design (no-op) → result.success false`
- GREEN:
  - batchDesign/batchGet inspect `result.isError` → throw descriptive error.
  - code-to-pen: read failure → failure; `penChanged === false` → failure/explicit no-change.
- REFACTOR: extract `assertNotMcpError(result, toolName)`.

**Test pyramid:**
- Smoke: client constructs; code-to-pen imports.
- Unit: 4 new.
- Integration: 1 — code-to-pen → mocked client error path.
- State machine: N/A.
- Contract: 1 — client treats `isError` as the failure signal.
- Regression: 3.
- Chaos: isError result, non-JSON batchGet, unreadable file.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +3%.

**Acceptance criteria (binary):**
- [ ] batch_design isError → code-to-pen result.success false.
- [ ] batch_get isError/non-JSON → not silently treated as empty state.
- [ ] No-op or unreadable .pen post-write → result.success false.

**Estimated effort:** M
**Blocked by:** None

### Iteration 4 — Provider config coherence

**Goal:** The documented `settings.provider` field is honored everywhere (runner creation, env-key population), and pen-to-code respects a configured non-Claude provider or fails clearly instead of silently using the Claude CLI.

**Shippable on its own?** Yes.

**Source references:**
- `src/code-to-pen.ts` (engine resolution L47-61), `src/ai/factory.ts` (createRunner L4-41), `src/config.ts` (env-key population L263-271), `src/types.ts` (provider/aiProvider L20-49)
- `src/pen-to-code.ts` (executeClaudeSync — confirm no provider branch)
- AUDIT — "provider field half-wired" (HIGH), "provider asymmetry pen-to-code" (2/2), "env apiKey population ignores provider" (HIGH)

**Files touched:**
- `src/ai/factory.ts`, `src/config.ts`, `src/code-to-pen.ts`, `src/pen-to-code.ts`, `src/types.ts` (modified)
- `src/__tests__/config.test.ts`, `src/__tests__/pen-to-code.test.ts`, `src/__tests__/ai-factory.test.ts` (new)

**Commit message:**
`fix(provider): honor settings.provider in runner + env-key resolution; pen-to-code errors clearly on unsupported provider`

**TDD cycle:**
- RED:
  - `ai-factory.test.ts::createRunner resolves engine from settings.provider when aiProvider is unset`
  - `config.test.ts::env apiKey auto-populated from provider when aiProvider unset`
  - `pen-to-code.test.ts::configured non-Claude provider → pen-to-code returns a clear error`
- GREEN:
  - factory + config read `settings.provider ?? settings.aiProvider`.
  - pen-to-code: non-claude-cli provider → typed error, no claude spawn.
- REFACTOR: extract `resolveEngine(settings)` shared by factory/config/code-to-pen.

**Test pyramid:**
- Smoke: config loads with `provider`; factory builds a runner.
- Unit: 3 new + `resolveEngine` precedence table (~4).
- Integration: 1 — config → code-to-pen engine selection.
- State machine: N/A.
- Contract: 1 — provider/aiProvider precedence.
- Regression: 3.
- Chaos: provider set but apiKey missing → clear error.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥85%.
- Coverage: est. +3%.

**Acceptance criteria (binary):**
- [ ] `provider: "anthropic"` with no `aiProvider` → direct-API path runs, env key resolves.
- [ ] Non-claude provider + pen-to-code → explicit error, no `claude` spawn.
- [ ] Precedence `provider ?? aiProvider` covered by tests.

**Estimated effort:** M
**Blocked by:** Iteration 3

### Iteration 5 — Config validation & parsing hardening (zod)

**Goal:** Config validated with a zod schema (mappings + settings); non-array `mappings` and malformed values produce clear errors; JSONC trailing commas parse; missing `${VAR}` / unknown keys reported.

**Shippable on its own?** Yes.

**Source references:**
- `src/config.ts` (loadConfig L210-305, safeMerge L19-29, JSONC clean L236-250, env expand L260-271)
- `src/types.ts` (MappingConfig L7-18, Settings L29-49)
- AUDIT — "mappings unvalidated" (2/2), "mappings non-array crash" (HIGH), "JSONC trailing commas" (MED), "${VAR} missing → misleading error" (LOW), "safeMerge drops unknown keys" (LOW), "`__proto__` node id / token key" (LOW — add key guard)

**Files touched:**
- `src/config.ts`, `src/types.ts` (modified)
- `src/__tests__/config.test.ts` (modified)

**Commit message:**
`fix(config): validate mappings/settings with zod, parse JSONC trailing commas, report missing env vars`

**TDD cycle:**
- RED:
  - `config.test.ts::mapping missing codeGlobs → descriptive validation error (not TypeError)`
  - `config.test.ts::mappings non-array → clear error`
  - `config.test.ts::jsonc with trailing comma parses`
  - `config.test.ts::${VAR} unset → explicit "env var X not set" error`
  - `config.test.ts::unknown settings key → warning surfaced`
- GREEN:
  - zod schemas; parse after JSONC strip; readable error mapping.
  - extend JSONC cleaner to strip trailing commas; warn on undefined `${VAR}`; collect unknown keys.
- REFACTOR: replace ad-hoc checks with schema where subsumed; keep prototype-pollution guard.

**Test pyramid:**
- Smoke: a valid config still loads.
- Unit: 5 new + schema edge cases (~4).
- Integration: N/A.
- State machine: N/A.
- Contract: 1 — config schema is the contract.
- Regression: 5.
- Chaos: non-array mappings, trailing comma, `__proto__` key rejected.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +2%.

**Acceptance criteria (binary):**
- [ ] Missing/mistyped mapping field → readable error naming the field.
- [ ] `mappings: 5` → clear error, no `.map` crash.
- [ ] `.jsonc` with trailing comma loads.
- [ ] Unset `${VAR}` → explicit message.

**Estimated effort:** M
**Blocked by:** None

### Iteration 6 — State store durability & recovery

**Goal:** On corruption, recover from `.backup` before falling back to empty; concurrent saves use a unique temp path.

**Shippable on its own?** Yes.

**Source references:**
- `src/state-store.ts` (load L27-68, save/backup L71-211, tmp path L77)
- `src/__tests__/state-recovery.test.ts` (esp. L93-130 — "remove backup" comment that revealed the gap)
- AUDIT — "backup never read" (3/3), "concurrent save shares fixed .tmp" (HIGH), "writeLastRun non-atomic" (LOW), "symlink traversal" (LOW — add realpath check)

**Files touched:**
- `src/state-store.ts` (modified); `src/__tests__/state-store.test.ts`, `state-recovery.test.ts` (modified)

**Commit message:**
`fix(state-store): recover from .backup on corruption; unique temp path per save to prevent concurrent corruption`

**TDD cycle:**
- RED:
  - `state-recovery.test.ts::corrupt state with valid .backup recovers from backup (not empty)`
  - `state-recovery.test.ts::corrupt state and corrupt backup falls back to empty`
  - `state-store.test.ts::two concurrent save() calls do not corrupt the state file`
- GREEN:
  - load(): on failure, try `.backup` (parse+checksum) before empty.
  - save(): tmp path `${stateFilePath}.${pid}.${counter}.tmp`; clean own tmp only.
- REFACTOR: extract `readValidatedState(path)`.

**Test pyramid:**
- Smoke: load/save round-trip.
- Unit: 3 new + checksum/migration green.
- Integration: 1 — corruption→recovery cycle.
- State machine: N/A.
- Contract: 1 — persisted file always has valid checksum.
- Regression: 2.
- Chaos: truncated primary, truncated backup, parallel writers, mid-write kill.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +2%.

**Acceptance criteria (binary):**
- [ ] Corrupt primary + valid backup → recovered state equals backup.
- [ ] Two concurrent saves → file remains valid JSON with valid checksum.
- [ ] Existing recovery tests updated to reflect real backup-fallback behavior.

**Estimated effort:** M
**Blocked by:** None

### Iteration 7 — Watcher & runner lifecycle correctness

**Goal:** Shutdown awaits in-flight syncs; the 5-minute Claude timeout is terminal (not retried as transient); the spawned claude child is killed on shutdown.

**Shippable on its own?** Yes.

**Source references:**
- `src/watcher.ts` (stop L188-204, debounced sync L139-183), `src/sync-engine.ts` (shutdown L398-400, finally L197-203)
- `src/claude-runner.ts` (timeout L140-181, isTransientMcpError L80-88, retry L211-251)
- `src/shutdown.ts`, `src/index.ts` (watch L40-61)
- AUDIT — "watcher.stop never awaits" (HIGH), "5-min timeout misclassified transient → ~20min" (HIGH), "orphaned claude child on SIGTERM" (LOW), "timeout untracked SIGKILL timer" (LOW)

**Files touched:**
- `src/watcher.ts`, `src/claude-runner.ts`, `src/sync-engine.ts` (modified); `src/__tests__/{watcher,claude-runner,watcher-resilience}.test.ts` (modified)

**Commit message:**
`fix(lifecycle): await in-flight sync on stop, treat Claude timeout as terminal, kill child on shutdown`

**TDD cycle:**
- RED:
  - `claude-runner.test.ts::a hard timeout is not retried (terminal, not transient)`
  - `watcher.test.ts::stop() awaits an in-flight sync before resolving`
  - `claude-runner.test.ts::SIGKILL escalation timer is cleared on process exit`
- GREEN:
  - Tag timeout results non-transient; exclude from retry.
  - Track in-flight sync promise; `stop()` awaits it (bounded).
  - Track child PID; kill on shutdown; track/clear SIGKILL timer.
- REFACTOR: extract `activeSync` tracking in Watcher.

**Test pyramid:**
- Smoke: watcher start/stop; runner happy path.
- Unit: 3 new + retry-classification table.
- Integration: 1 — watcher stop during a mocked long sync.
- State machine: 1 — lock acquire→release→grace unaffected by new await.
- Contract: N/A.
- Regression: 2.
- Chaos: timeout, SIGTERM mid-sync, child ignoring SIGTERM.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +2%.

**Acceptance criteria (binary):**
- [ ] Hard timeout → exactly one attempt, no retry.
- [ ] `stop()` does not resolve until the in-flight sync settles.
- [ ] No dangling timers/processes after shutdown.

**Estimated effort:** L
**Blocked by:** None

### Iteration 8 — Glob matcher hardening (ReDoS + correctness)

**Goal:** Eliminate catastrophic backtracking on multi-`**/` globs; support POSIX `[!...]` negation and backslash paths; reject unterminated braces; cache compiled regexes.

**Shippable on its own?** Yes.

**Source references:**
- `src/glob-matcher.ts` (buildRegexSource L1-64, matches L70-73)
- `src/__tests__/glob-matcher.test.ts` (incl. the ineffective ReDoS guard test)
- AUDIT — "ReDoS multi-**/" (HIGH), "[!...] negation literal" (MED), "backslash patterns never match" (MED), "unterminated brace → (?:)" (LOW), "no cache" (LOW)

**Files touched:**
- `src/glob-matcher.ts` (modified), `src/__tests__/glob-matcher.test.ts` (modified)

**Commit message:**
`fix(glob): linear-time matching for nested **, POSIX negation, backslash + brace handling, regex cache`

**TDD cycle:**
- RED:
  - `glob-matcher.test.ts::pathological **/ glob matches in bounded time (<50ms) on a long non-match`
  - `glob-matcher.test.ts::[!abc] negates`
  - `glob-matcher.test.ts::backslash glob normalized and matches`
  - `glob-matcher.test.ts::unterminated brace is rejected/escaped, not collapsed to (?:)`
- GREEN:
  - Collapse consecutive `**/`; atomic/non-backtracking construction.
  - `[!...]` → `[^...]`; normalize backslashes in the pattern; unterminated brace literal.
  - Memoize `globToRegex` in a Map.
- REFACTOR: extract `normalizeGlob()`.

**Test pyramid:**
- Smoke: existing matches() cases pass.
- Unit: 4 new + glob→expected matrix.
- Integration: N/A.
- State machine: N/A.
- Contract: N/A.
- Regression: 1 — previously-ineffective ReDoS guard now bounds time.
- Chaos: adversarial nested-`**` + deep non-match.
- E2E: N/A.
- Performance: 1 — pathological pattern < 50ms.
- TDD Parity: ≥85%.
- Coverage: est. +1%.

**Acceptance criteria (binary):**
- [ ] Pathological `**/`×N on a non-match returns < 50ms.
- [ ] `[!abc]`, backslash patterns, unterminated braces behave per tests.
- [ ] Repeated matches() reuse a cached RegExp.

**Estimated effort:** M
**Blocked by:** None

### Iteration 9 — Conflict & MCP record-path data integrity

**Goal:** Manual sync cannot silently overwrite the authoritative side; auto-merge verifies a real change before success without wiping the snapshot baseline; pencil_record_sync persists the pen snapshot.

**Shippable on its own?** Yes.

**Source references:**
- `src/sync-engine.ts` (manual path L153-176, autoMerge L306-352, persist L180-185), `src/mcp-server.ts` (pencil_record_sync L193-218; contrast sync-engine L182)
- `src/state-store.ts` (updateMappingState penSnapshot param L96-114)
- AUDIT — "manual sync ignores mapping.direction" (HIGH), "auto-merge success without verifying + wipes snapshot" (HIGH), "record_sync never persists penSnapshot" (HIGH), "pencil_invalidate_state wipes whole state" (LOW)

**Files touched:**
- `src/sync-engine.ts`, `src/mcp-server.ts` (modified); `src/__tests__/{sync-engine,mcp-server}.test.ts` (modified)

**Commit message:**
`fix(sync): guard manual direction against authoritative overwrite; verify auto-merge; persist snapshot in record_sync`

**TDD cycle:**
- RED:
  - `sync-engine.test.ts::manual sync against a one-directional mapping does not overwrite the authoritative side without override`
  - `sync-engine.test.ts::auto-merge with zero applied edits → not reported success, snapshot baseline preserved`
  - `mcp-server.test.ts::pencil_record_sync persists penSnapshot so next pencil_diff_design sees prior baseline`
- GREEN:
  - Manual path respects `mapping.direction` unless explicit `force`.
  - auto-merge verifies a change before success; on no change, do not overwrite snapshot.
  - record_sync snapshots the .pen and passes it to updateMappingState.
- REFACTOR: share `snapshotCurrentPen(mapping)` between engine and MCP server.

**Test pyramid:**
- Smoke: engine sync happy path; record_sync returns ok.
- Unit: 3 new.
- Integration: 1 — record_sync → diff_design baseline round-trip.
- State machine: 1 — conflict branches (pen-wins/code-wins/auto-merge/skip).
- Contract: N/A.
- Regression: 3.
- Chaos: auto-merge no-op, manual wrong-direction.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +2%.

**Acceptance criteria (binary):**
- [ ] Manual sync in the non-authoritative direction is blocked or requires `force`.
- [ ] Auto-merge with no edits → result.success false, snapshot unchanged.
- [ ] After record_sync, diff_design uses the persisted snapshot (not empty).

**Estimated effort:** M
**Blocked by:** Iteration 2

### Iteration 10 — AI provider cost & output correctness

**Goal:** Correct the Anthropic price table and Haiku alias; honor Google systemInstruction; respect finish_reason/maxTokens truncation; validate apiBaseUrl (SSRF guard).

**Shippable on its own?** Yes.

**Source references:**
- `src/ai/anthropic.ts` (prices L5-14, estimateCost L48-52), `src/ai/google.ts` (systemPrompt L14-23, cost L36-38), `src/ai/openai-compat.ts` (finish_reason L24-43, baseURL L15-21)
- `src/config.ts` (apiBaseUrl warning L276-285)
- AUDIT — anthropic price table (MED), Haiku alias→Sonnet (MED), google systemInstruction (MED), finish_reason ignored (MED), apiBaseUrl SSRF (MED/LOW), google flat cost (LOW), google default model (LOW)

**Files touched:**
- `src/ai/anthropic.ts`, `src/ai/google.ts`, `src/ai/openai-compat.ts`, `src/config.ts` (modified); `src/__tests__/ai-runners.test.ts` (new)

**Commit message:**
`fix(ai): correct anthropic pricing + haiku alias, use google systemInstruction, handle truncation, validate apiBaseUrl`

**TDD cycle:**
- RED:
  - `ai-runners.test.ts::anthropic estimateCost matches published Opus/Haiku rates`
  - `ai-runners.test.ts::haiku alias resolves to haiku rates (not sonnet)`
  - `ai-runners.test.ts::google runner passes systemInstruction, not concatenated prompt`
  - `ai-runners.test.ts::openai-compat truncated finish_reason surfaces a warning/error`
  - `config.test.ts::non-https/internal apiBaseUrl is rejected or warned`
- GREEN:
  - Single pricing source-of-truth keyed by canonical+alias ids.
  - SDK systemInstruction; check finish_reason; validate apiBaseUrl scheme/host.
- REFACTOR: centralize model-id normalization.

**Test pyramid:**
- Smoke: each runner constructs.
- Unit: 5 new.
- Integration: N/A (SDKs mocked).
- State machine: N/A.
- Contract: 1 — pricing table keys cover configured models.
- Regression: 4.
- Chaos: truncated completion, hostile baseURL.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: ≥80%.
- Coverage: est. +3%.

**Acceptance criteria (binary):**
- [ ] Opus/Haiku cost estimates within rounding of published rates.
- [ ] Haiku alias → Haiku rates.
- [ ] Google call uses systemInstruction.
- [ ] Truncated output → surfaced, not silently executed.
- [ ] Non-https/internal apiBaseUrl → rejected or explicitly warned.

**Estimated effort:** M
**Blocked by:** Iteration 4

## 4. Test inventory summary

| Iter | Smoke | Unit | Integration | State machine | Contract | Regression | Chaos | E2E | Performance | TDD Parity | Coverage Δ (est.) |
|------|-------|------|-------------|---------------|----------|------------|-------|-----|-------------|------------|------------|
| 1 | 1 | 3 | 0 | 0 | 0 | 2 | 1 | 0 | 0 | 100% | +1% |
| 2 | 1 | 3 | 0 | 0 | 1 | 2 | 1 | 0 | 0 | 100% | +1% |
| 3 | 1 | 4 | 1 | 0 | 1 | 3 | 1 | 0 | 0 | 80% | +3% |
| 4 | 1 | 5 | 1 | 0 | 1 | 3 | 1 | 0 | 0 | 85% | +3% |
| 5 | 1 | 7 | 0 | 0 | 1 | 5 | 1 | 0 | 0 | 80% | +2% |
| 6 | 1 | 3 | 1 | 0 | 1 | 2 | 1 | 0 | 0 | 80% | +2% |
| 7 | 1 | 4 | 1 | 1 | 0 | 2 | 1 | 0 | 0 | 80% | +2% |
| 8 | 1 | 5 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 85% | +1% |
| 9 | 1 | 3 | 1 | 1 | 0 | 3 | 1 | 0 | 0 | 80% | +2% |
| 10 | 1 | 5 | 0 | 0 | 1 | 4 | 1 | 0 | 0 | 80% | +3% |

## 5. End-to-end definition of done

**Deduplicated acceptance criteria:** all per-iteration boxes checked; full suite green; build clean; no new ESLint errors; changelog appended per iteration.

**Single E2E demo (manual):** With a `direction: "both"` mapping and a `--color-*` Tailwind CSS file: (1) change two chained fills + a text node + delete a node in the `.pen`; `pencil-sync sync` → colors correct (no cascade), text updated, deletion surfaced, no false-success log. (2) Corrupt `state.json`, run again → recovers from `.backup`. (3) Configure `provider: "openai-compatible"` with a bad `apiBaseUrl` → clear rejection, no key sent. (4) `Ctrl+C` mid-sync → clean shutdown, no orphaned `claude`.

**Green command at the end:**
`npx vitest run` — all 32+ files including: `pen-snapshot.test.ts`, `pen-to-code.test.ts`, `code-to-pen.test.ts`, `pencil-mcp-client.test.ts`, `mcp-server.test.ts`, `config.test.ts`, `state-store.test.ts`, `state-recovery.test.ts`, `watcher.test.ts`, `watcher-resilience.test.ts`, `claude-runner.test.ts`, `glob-matcher.test.ts`, `sync-engine.test.ts`, `ai-factory.test.ts` (new), `ai-runners.test.ts` (new). Then `npm run build`.

## 6. Out of scope (deferred)

- **Brand-new-node diffing** — deliberate skip; needs a design decision on first-sync flooding. (AUDIT, LOW)
- **Prompt injection from `.pen` content** — requires sandboxing/allowlist design. (MED)
- **Cross-process / file-based locking** — in-memory lock fine for single-process; fix the doc drift instead. (INFO)
- **fsync durability for power-loss** — atomic-rename adequate for the threat model. (LOW)
- **argv prompt exposure / `~` expansion edge cases** — niche shared-host concern. (LOW/INFO)
- **`prompt-builder.ts` argv `E2BIG` on Linux** — niche; revisit on reports. (MED)
- **doctor/setup wizard UX** (budget coercion, framework validation, readline hang, non-interactive loop) — separate "CLI UX" plan. (LOW/MED)

## 7. Open questions

1. **Mixed-diff fill failure (Iter 1):** fail the whole sync, or succeed with warnings? Planned: *warnings*.
2. **Manual direction (Iter 9):** block outright, or allow behind explicit `--force`? Planned: `--force`.
