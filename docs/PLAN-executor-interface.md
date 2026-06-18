# PLAN — Executor Interface (Option A)

> Host-agnostic seam: make the sync engine depend on an `Executor` abstraction
> instead of importing `runClaude` directly. Behavior-preserving — the only
> implementation on day one is `LocalClaudeExecutor`, which wraps the existing
> `runClaude`. Full bidirectional code ↔ pencil.dev sync is unchanged.

## 1. Scope summary

Extract an `Executor` interface that owns "given a prompt + options, perform the
transform and return a result." Today that work is the `runClaude` function in
`src/claude-runner.ts`, which spawns the `claude` CLI. The three call sites
(`pen-to-code.ts`, `code-to-pen.ts`, `sync-engine.ts`) currently import
`runClaude` directly, hardwiring the engine to the Claude CLI. This refactor
inverts that: call sites depend on an injected `Executor`, and
`LocalClaudeExecutor` is the default implementation delegating to `runClaude`.

**NOT being built:** no second executor (API, host-delegated), no MCP server, no
change to sync direction logic, prompts, conflict detection, state store, or
budget/pricing. Pricing helpers (`estimateCost`, `MODEL_PRICING`,
`estimateInputTokens`) stay in `claude-runner.ts` — they are Claude-specific and
move only when a second executor needs them.

**Smallest possible v1:** `Executor` interface + `LocalClaudeExecutor` wired into
all three call sites via a default parameter, with existing tests green.

**Source design:** this conversation (Option A discussion). No prior design doc.

## 2. Prerequisites

- **Dependencies:** none new. Uses existing TypeScript/Vitest setup.
- **Code areas touched:**
  - `src/claude-runner.ts` — `runClaude`, `ClaudeRunOptions`, `ClaudeRunResult` (source of the wrapped behavior; not modified, only wrapped).
  - `src/executor.ts` — **new** interface + `LocalClaudeExecutor`.
  - `src/pen-to-code.ts` — call site at `syncPenToCodeViaClaude` (~line 157).
  - `src/code-to-pen.ts` — call site (~line 49).
  - `src/sync-engine.ts` — auto-merge call site (~line 289); owns executor construction.
  - `src/__tests__/{pen-to-code,code-to-pen,sync-engine}.test.ts` — currently `vi.mock("../claude-runner.js")`; must stay green.
- **Risks:**
  - Existing tests mock `../claude-runner.js` directly. Default-param injection means `LocalClaudeExecutor` still calls the mocked `runClaude`, so they should pass unchanged — must verify, not assume.
  - Coverage thresholds in `vitest.config.ts` (lines 81 / functions 83 / branches 77 / statements 80). New `executor.ts` must carry its own tests or thresholds drop.

## 3. Iterations

#### Iteration 1 — Executor interface + LocalClaudeExecutor

**Goal:** Introduce `src/executor.ts` with the `Executor` interface and a `LocalClaudeExecutor` that delegates `run()` to the existing `runClaude`, fully unit-tested. No call sites changed yet.

**Shippable on its own?** Yes — new module with tests, no behavior change to the engine. It is exercised by its own unit tests (not dead code), and nothing else imports it yet, so the build and all existing tests stay green.

**Source references:**
- `src/claude-runner.ts` — read `runClaude`, `ClaudeRunOptions`, `ClaudeRunResult` to mirror the exact signature the interface must preserve.

**Files touched:**
- `src/executor.ts` (new)
- `src/__tests__/executor.test.ts` (new)

**Commit message:**
`refactor(executor): add Executor interface and LocalClaudeExecutor wrapping runClaude`

**TDD cycle:**
- RED (failing tests to write first):
  - `src/__tests__/executor.test.ts::LocalClaudeExecutor.run delegates to runClaude with the same options` — mocks `../claude-runner.js`, asserts `runClaude` called once with the passed options.
  - `src/__tests__/executor.test.ts::LocalClaudeExecutor.run returns the runClaude result unchanged` — asserts the resolved `ExecutorResult` is the `ClaudeRunResult` from the mock, byte-for-byte.
- GREEN (minimal implementation):
  - Define `interface Executor { run(options: ExecutorRunOptions): Promise<ExecutorResult>; }`.
  - Alias `ExecutorRunOptions = ClaudeRunOptions` and `ExecutorResult = ClaudeRunResult` (re-export from `executor.ts`) so future executors can evolve them without touching call sites.
  - `class LocalClaudeExecutor implements Executor { run(o) { return runClaude(o); } }`.
  - Export a shared `const localClaudeExecutor = new LocalClaudeExecutor()` as the default singleton.
- REFACTOR: None — module is minimal.

**Test pyramid for this iteration:**
- Smoke: import `executor.ts`; instantiate `LocalClaudeExecutor` without throwing.
- Unit: 2 (delegation, passthrough result).
- Integration: N/A — no cross-component wiring yet.
- State machine: N/A — no FSM.
- Contract: 1 — assert `LocalClaudeExecutor` structurally satisfies `Executor` (typecheck-level test: assign to `Executor` typed const).
- Regression: N/A — pure addition.
- Chaos: N/A — failure paths are `runClaude`'s, covered by `claude-runner.test.ts`.
- E2E: N/A.
- Performance: N/A.
- TDD Parity: 100% — `Executor`, `LocalClaudeExecutor`, `localClaudeExecutor` all introduced with direct tests.
- Coverage: +1% (new file fully covered).

**Acceptance criteria (binary):**
- [ ] `src/executor.ts` exports `Executor`, `LocalClaudeExecutor`, `localClaudeExecutor`, `ExecutorRunOptions`, `ExecutorResult`.
- [ ] `npm test` green; no existing test modified.
- [ ] `npm run build` succeeds with no type errors.

**Estimated effort:** S
**Blocked by:** None

---

#### Iteration 2 — Wire pen-to-code and code-to-pen through the executor

**Goal:** Both pen→code and code→pen paths call the transform through an injected `Executor` (default `localClaudeExecutor`) instead of importing `runClaude`.

**Shippable on its own?** Yes — behavior is identical (default executor wraps `runClaude`); the two directions still sync exactly as before.

**Source references:**
- `src/pen-to-code.ts` — `syncPenToCodeViaClaude` call site (~line 157); note it passes NO MCP options.
- `src/code-to-pen.ts` — call site (~line 49); note it conditionally passes `allowedTools` + `mcpConfigPath`.

**Files touched:**
- `src/pen-to-code.ts` (modified)
- `src/code-to-pen.ts` (modified)
- `src/__tests__/pen-to-code.test.ts` (modified — add executor-injection assertion)
- `src/__tests__/code-to-pen.test.ts` (modified — add executor-injection assertion)

**Commit message:**
`refactor(sync): route pen-to-code and code-to-pen through injected Executor`

**TDD cycle:**
- RED (failing tests to write first):
  - `pen-to-code.test.ts::syncPenToCode uses the injected executor for non-color changes` — pass a fake `Executor`, assert its `run` is called and `runClaude` is not.
  - `code-to-pen.test.ts::syncCodeToPen uses the injected executor` — fake executor, assert called.
  - `code-to-pen.test.ts::syncCodeToPen forwards MCP allowedTools and mcpConfigPath to the executor` — assert the options object reaching the fake executor includes the MCP fields when `mcpConfigPath` is set.
- GREEN:
  - Add `executor: Executor = localClaudeExecutor` parameter to the relevant functions in both modules.
  - Replace `runClaude(opts)` with `executor.run(opts)`.
  - Drop the direct `runClaude` import (keep type imports if needed).
- REFACTOR:
  - "Extract MCP-options helper" — the `...(mcpConfigPath && { allowedTools, mcpConfigPath })` block is duplicated in both call sites; collapse into one helper if it reads cleaner. Else "None".

**Test pyramid for this iteration:**
- Smoke: both modules import and run with the default executor (existing happy-path tests).
- Unit: 3 new (pen injection, code injection, MCP-forwarding).
- Integration: 2 — pen-to-code and code-to-pen each exercised end to end with a fake executor returning a success result, asserting `SyncResult` shape unchanged.
- State machine: N/A.
- Contract: 1 — fake executor must satisfy `Executor`; assert options forwarded match `ExecutorRunOptions`.
- Regression: 1 — existing `vi.mock("../claude-runner.js")` tests still pass (default executor path), proving no behavior change.
- Chaos: 1 — injected executor resolves `{ success: false, mcpError: "server_unavailable" }`; assert error mapping in `SyncResult` is identical to today.
- E2E: N/A — full watcher path covered in iteration 3.
- Performance: N/A.
- TDD Parity: 100% — new parameter on each function has a direct test.
- Coverage: +2%.

**Acceptance criteria (binary):**
- [ ] Neither `pen-to-code.ts` nor `code-to-pen.ts` imports `runClaude` as a value (only `executor.run`).
- [ ] Default-parameter call (no executor passed) produces byte-identical `SyncResult` to pre-refactor for the success and `mcpError` cases.
- [ ] MCP `allowedTools` + `mcpConfigPath` reach the executor only when `mcpConfigPath` is set.
- [ ] `npm test` green; `npm run build` clean.

**Estimated effort:** S
**Blocked by:** Iteration 1

---

#### Iteration 3 — Engine owns one executor, threads it to all call sites

**Goal:** `SyncEngine` constructs a single `Executor` and passes it to `syncPenToCode`, `syncCodeToPen`, and its own auto-merge call, so there is one injection point for the whole engine.

**Shippable on its own?** Yes — completes the seam; default remains `localClaudeExecutor`, behavior unchanged.

**Source references:**
- `src/sync-engine.ts` — auto-merge `runClaude` call site (~line 289) and the constructor; this is where the single executor instance lives and is threaded down.

**Files touched:**
- `src/sync-engine.ts` (modified)
- `src/__tests__/sync-engine.test.ts` (modified)

**Commit message:**
`refactor(sync): SyncEngine owns a single Executor and injects it into both directions`

**TDD cycle:**
- RED (failing tests to write first):
  - `sync-engine.test.ts::SyncEngine uses an injected executor for auto-merge` — construct engine with a fake executor, trigger conflict auto-merge, assert fake `run` called, `runClaude` not.
  - `sync-engine.test.ts::SyncEngine propagates its executor to pen-to-code and code-to-pen` — assert the same fake executor instance is the one used by both direction calls.
- GREEN:
  - Add optional `executor: Executor` to the `SyncEngine` constructor (default `localClaudeExecutor`); store on instance.
  - Replace the auto-merge `runClaude(...)` with `this.executor.run(...)`.
  - Pass `this.executor` into `syncPenToCode` / `syncCodeToPen` calls.
- REFACTOR:
  - "Remove now-unused `runClaude` import from `sync-engine.ts`" (keep `estimateCost`, `estimateInputTokens`, `MODEL_PRICING` — still used).

**Test pyramid for this iteration:**
- Smoke: `new SyncEngine(config)` constructs with default executor; one `sync()` happy path.
- Unit: 2 (auto-merge injection, propagation).
- Integration: 1 — full `sync()` run with a fake executor across a pen→code then conflict→auto-merge flow, asserting the same executor handled every transform.
- State machine: 1 — conflict path (`detected → auto-merge → resolved`) still transitions identically with injected executor.
- Contract: N/A — covered in iterations 1–2.
- Regression: 1 — existing `sync-engine.test.ts` `vi.mock` suite passes unchanged.
- Chaos: 1 — injected executor fails auto-merge; assert the existing `Auto-merge failed: …` error path is preserved.
- E2E: 1 — CLI-level `sync` run (existing harness) completes green with the default executor, proving the wired-up binary still works end to end.
- Performance: N/A.
- TDD Parity: 100% — constructor param + propagation both tested.
- Coverage: +1%.

**Acceptance criteria (binary):**
- [ ] `sync-engine.ts` no longer imports `runClaude` as a value.
- [ ] `SyncEngine` exposes an optional constructor `executor` param defaulting to `localClaudeExecutor`.
- [ ] All three transform paths (pen→code, code→pen, auto-merge) use the engine's single executor instance.
- [ ] `npm test` green; `npm run build` clean; coverage thresholds still met.

**Estimated effort:** S
**Blocked by:** Iteration 2

## 4. Test inventory summary

| Iter | Smoke | Unit | Integration | State machine | Contract | Regression | Chaos | E2E | Performance | TDD Parity | Coverage Δ |
|------|-------|------|-------------|---------------|----------|------------|-------|-----|-------------|------------|------------|
| 1    | 1     | 2    | 0           | 0             | 1        | 0          | 0     | 0   | 0           | 100%       | +1% → ~82% |
| 2    | 1     | 3    | 2           | 0             | 1        | 1          | 1     | 0   | 0           | 100%       | +2% → ~84% |
| 3    | 1     | 2    | 1           | 1             | 0        | 1          | 1     | 1   | 0           | 100%       | +1% → ~85% |

## 5. End-to-end definition of done

- All acceptance criteria across iterations 1–3 met (deduplicated): `Executor`/`LocalClaudeExecutor` exist and are tested; no production module imports `runClaude` as a value except `executor.ts`; `SyncEngine` owns one injectable executor threaded to all three transform paths; behavior byte-identical for success, `mcpError`, and auto-merge-fail cases; coverage thresholds still met.
- **Demo script (proves the whole refactor is behavior-preserving):**
  1. `npm run build && npm test` → green.
  2. `git grep -n "runClaude(" src/` → matches only inside `src/claude-runner.ts` and `src/executor.ts`.
  3. Run a real one-time sync against a fixture mapping (`npm start sync` or `node dist/index.js sync`) → completes and produces the same `SyncResult` output as before the refactor.
- **Green command at the end:**
  `npm test` (Vitest), covering: `src/__tests__/executor.test.ts`, `src/__tests__/pen-to-code.test.ts`, `src/__tests__/code-to-pen.test.ts`, `src/__tests__/sync-engine.test.ts`, `src/__tests__/claude-runner.test.ts`, `src/__tests__/dry-run.test.ts`, `src/__tests__/partial-success.test.ts`.

## 6. Out of scope

- **Second executor (API / host-delegated):** deferred — no concrete host workflow demands it yet (Option B/C). The seam makes it a new class with zero call-site churn.
- **MCP server mode:** deferred — separate entry point and control-flow model; build only when a host workflow needs on-demand sync.
- **Moving budget/pricing out of `claude-runner.ts`:** deferred — Claude-specific; relocate only when a non-Claude executor needs cost tracking.
- **Renaming `ClaudeRunResult`/`ClaudeRunOptions` to neutral names:** deferred — aliased now to avoid churn; rename when a second executor justifies it.

## 7. Open questions

- Injection style: default-parameter (chosen here, minimal churn, keeps existing `vi.mock` tests green) vs. constructor-only DI on `SyncEngine` with explicit threading. Plan assumes default-parameter at the function level plus a single owned instance on `SyncEngine`. Confirm this is acceptable, or state a preference for strict constructor DI (more churn, no module-level default singleton).
