# Plan: pencil-sync project directory, doctor, and setup wizard

### 1. Scope summary

Three coordinated improvements to pencil-sync's project structure and onboarding. **Feature 1** replaces the flat `.pencil-sync-state.json` file with a `.pencil-sync/` per-project directory holding `state.json` and `last-run.json` (the result of the most recent sync), with automatic migration from the old flat file on first load. **Feature 2** adds a `pencil-sync doctor` command that runs six preflight checks and exits 0/1 with a printed checklist. **Feature 3** adds a `pencil-sync setup` interactive wizard that asks seven questions, auto-detects framework and styling, writes the config, creates the directory, runs doctor, and runs a dry-run sync to prove the setup works.

Explicitly not built: TUI/ncurses interface, multi-mapping wizard (one mapping per setup run), CI/CD check in doctor, remote config, Windows `cmd.exe` readline compatibility, internationalization.

Smallest v1: Iteration 1 alone (directory migration) is independently shippable.

---

### 2. Prerequisites

**No new runtime dependencies.** All features use Node.js stdlib only: `node:readline`, `node:child_process`, `node:fs/promises`, `node:path`.

**Existing code areas touched:**

| File | Why |
|------|-----|
| `src/types.ts` | `DEFAULT_SETTINGS.stateFile` changes from `".pencil-sync-state.json"` to `".pencil-sync/state.json"` |
| `src/state-store.ts` | `mkdir -p` on load/save, migration logic, new `writeLastRun()` method |
| `src/sync-engine.ts` | Call `stateStore.writeLastRun(result)` after every completed sync |
| `src/config.ts` | Add `detectStyling()` and `findPenFiles()` alongside existing `detectFramework()` |
| `src/index.ts` | Register `doctor` command; replace `init` with `setup` (keep `init` as hidden alias) |

**New files:**

- `src/doctor.ts` — exported `runDoctor(configPath?)` function
- `src/setup.ts` — exported `runSetup(io?)` function with injectable `WizardIO`

**Risks:**

- Migration fires only when `.pencil-sync/state.json` is absent AND the old `.pencil-sync-state.json` exists at the config root — must not touch custom `stateFile` paths.
- `readline` hangs in non-TTY environments (CI, piped stdin) — wizard must check `process.stdin.isTTY` and exit cleanly if false.
- `claude --version` on PATH may differ by install method; use `execFile` with a short timeout rather than `which`.
- `detectStyling` scanning `package.json` for `styled-components` must handle missing or malformed `package.json` gracefully.

---

### 3. Iterations

---

#### Iteration 1 — `.pencil-sync/` directory, migration, and last-run.json

**Goal:** Replace the flat state file with a structured `.pencil-sync/` directory, auto-migrate existing projects on first load, and write `last-run.json` after every sync.

**Shippable on its own?** Yes — purely internal, no CLI surface change.

**Source references:**
- `src/state-store.ts:22-105` — `StateStore` class: `load()`, `save()`, `updateMappingState()` — understand the atomic write pattern before adding `mkdir` and migration
- `src/types.ts:109-117` — `DEFAULT_SETTINGS` object — the single line to change
- `src/sync-engine.ts:155-165` — where `updateMappingState()` is called after sync — insertion point for `writeLastRun()`

**Files touched:**
- `src/types.ts` (modified)
- `src/state-store.ts` (modified)
- `src/sync-engine.ts` (modified)
- `src/__tests__/state-store.test.ts` (modified — new migration + last-run tests)

**Commit message:**
`feat(project-dir): replace flat state file with .pencil-sync/ directory`

**TDD cycle:**
- RED:
  - `test_statestore_creates_pencil_sync_dir_on_first_load` — `StateStore.load()` on a fresh temp dir creates `.pencil-sync/` directory
  - `test_statestore_migrates_old_flat_file_to_new_location` — old `.pencil-sync-state.json` at configDir root is moved to `.pencil-sync/state.json`; old file is gone after load
  - `test_statestore_migration_skipped_when_new_file_already_exists` — if `.pencil-sync/state.json` exists, old flat file (if present) is left untouched
  - `test_statestore_migration_skipped_for_custom_state_path` — when stateFile is not the default path, migration does not run
  - `test_statestore_save_creates_dir_if_missing` — `save()` succeeds even if `.pencil-sync/` was deleted between load and save
  - `test_write_last_run_writes_json_to_pencil_sync_dir` — `writeLastRun(result)` creates `.pencil-sync/last-run.json` with `SyncResult` fields
  - `test_write_last_run_overwrites_previous_result` — second `writeLastRun()` call replaces first
  - `test_sync_engine_writes_last_run_after_successful_sync` — after `syncMapping()` with a fake executor, `last-run.json` is present in `.pencil-sync/`
- GREEN:
  - Change `DEFAULT_SETTINGS.stateFile` to `".pencil-sync/state.json"`
  - In `StateStore.load()`: `await mkdir(dirname(this.stateFilePath), { recursive: true })` before attempting to read; then check if `stateFilePath` matches default pattern, if so look for old flat file at `join(dirname(this.stateFilePath), '..', '.pencil-sync-state.json')`, if found and new file absent: `await rename(oldPath, this.stateFilePath)`
  - In `StateStore.save()`: same `mkdir` guard before the tmp write
  - Add `writeLastRun(result: SyncResult): Promise<void>` — writes `JSON.stringify(result)` to `join(dirname(this.stateFilePath), 'last-run.json')`
  - In `SyncEngine.syncMapping()`: after `updateMappingState()` call, add `await this.stateStore.writeLastRun(result)`
- REFACTOR:
  - Extract `ensureDir()` private helper used by both `load()` and `save()`
  - Extract `oldFlatStatePath()` private method that computes old path — keeps migration logic readable

**Test pyramid for this iteration:**
- Smoke: `new StateStore('.pencil-sync/state.json')` — no throw; `.pencil-sync/` dir exists after `load()`
- Unit: 8 tests listed above across `state-store.test.ts`; 1 integration test in `sync-engine.test.ts`
- Integration: 1 test — `SyncEngine.syncMapping()` with fake executor writes `last-run.json` at correct path
- State machine: 2 tests — migration fires (old exists, new absent) vs. skipped (new exists)
- Contract: 1 test — `last-run.json` content is valid `SyncResult` JSON with `success`, `direction`, `mappingId`, `filesChanged` fields
- Regression: 2 tests — existing `StateStore` load/save round-trip with new path; existing `sync-engine` tests still pass
- Chaos: 2 tests — `load()` when `.pencil-sync/` dir is read-only returns graceful error; `writeLastRun()` with unserializable result falls back without throwing
- E2E: N/A
- Performance: N/A
- TDD Parity: 100% — `writeLastRun`, `ensureDir`, migration branch all covered
- Coverage delta: +2% → ~84%

**Acceptance criteria:**
- [ ] `DEFAULT_SETTINGS.stateFile` is `".pencil-sync/state.json"`
- [ ] `StateStore.load()` creates `.pencil-sync/` if absent
- [ ] Old `.pencil-sync-state.json` is automatically moved to `.pencil-sync/state.json` on first load
- [ ] `.pencil-sync/last-run.json` is written after every successful sync
- [ ] All existing tests still pass

**Estimated effort:** M

**Blocked by:** None

---

#### Iteration 2 — `pencil-sync doctor`

**Goal:** Add a `doctor` CLI command that runs six preflight checks and exits 0 (all pass) or 1 (any fail), printing a readable checklist.

**Shippable on its own?** Yes — pure addition, no existing behavior changes.

**Source references:**
- `src/config.ts:152-219` — `loadConfig()` — called by doctor for check (b); understand what errors it throws
- `src/state-store.ts:171-230` — `hashCodeDir()`, `diffHashes()` — used for check (e)
- `src/index.ts:37-253` — existing CLI structure — where to add the new command

**Files touched:**
- `src/doctor.ts` (new)
- `src/index.ts` (modified — register `doctor` command)
- `src/__tests__/doctor.test.ts` (new)

**Commit message:**
`feat(doctor): add pencil-sync doctor preflight command`

**TDD cycle:**
- RED:
  - `test_doctor_check_a_passes_when_claude_on_path` — runDoctor() returns result with check `claude_on_path: true` when `claude --version` exits 0
  - `test_doctor_check_a_fails_when_claude_not_found` — when execFile throws ENOENT, `claude_on_path: false`
  - `test_doctor_check_b_passes_for_valid_config` — valid config file → `config_valid: true`
  - `test_doctor_check_b_fails_for_missing_config` — missing config → `config_valid: false`, error message captured
  - `test_doctor_check_c_passes_when_pen_file_exists` — accessible `.pen` file → `pen_file_accessible: true` per mapping
  - `test_doctor_check_c_fails_when_pen_file_missing` — ENOENT → `pen_file_accessible: false`
  - `test_doctor_check_d_passes_when_code_dir_exists` — accessible dir → `code_dir_accessible: true`
  - `test_doctor_check_e_passes_when_globs_match_files` — codeDir with matching files → `globs_match: true`
  - `test_doctor_check_e_fails_when_no_files_match` — empty codeDir → `globs_match: false`
  - `test_doctor_check_f_passes_when_budget_positive` — `maxBudgetUsd: 0.5` → `budget_positive: true`
  - `test_doctor_check_f_fails_when_budget_zero` — `maxBudgetUsd: 0` → `budget_positive: false`
  - `test_doctor_returns_true_when_all_pass` — all checks passing → return value is `true`, exit code 0
  - `test_doctor_returns_false_when_any_fail` — one check failing → return value is `false`, exit code 1
- GREEN:
  - Create `src/doctor.ts`:
    - `interface DoctorResult { checks: DoctorCheck[]; allPassed: boolean }`
    - `interface DoctorCheck { label: string; passed: boolean; detail?: string }`
    - `runDoctor(configPath?: string): Promise<DoctorResult>` — runs all 6 checks, collects results, prints checklist via `log`, returns result
    - Check (a): `execFile('claude', ['--version'], { timeout: 3000 })` wrapped in try/catch
    - Check (b): `loadConfig(configPath)` wrapped in try/catch
    - Checks (c–f): per-mapping, using `access()`, `hashCodeDir()`
    - Check (f): `settings.maxBudgetUsd > 0`
  - In `index.ts`: add `.command("doctor").description("Run preflight checks").action(...)` that calls `runDoctor()` and exits with code
- REFACTOR:
  - Extract `checkClaudeBinary()` helper for testability
  - Extract `checkMapping(mapping, settings)` for per-mapping checks (c/d/e)

**Test pyramid for this iteration:**
- Smoke: `pencil-sync doctor --help` exits 0; `runDoctor()` importable without error
- Unit: 13 tests listed above in `doctor.test.ts`; all using temp dirs + mocked `execFile`
- Integration: 1 test — `runDoctor()` with a real config file and real temp directory trees
- State machine: N/A
- Contract: 1 test — `DoctorResult` shape: `{ checks: Array<{ label, passed }>, allPassed: boolean }`
- Regression: 1 test — existing `sync`, `watch`, `status` commands still appear in `--help` output
- Chaos: 2 tests — doctor with corrupt config JSON returns `config_valid: false` (not throw); doctor with unreadable codeDir returns `code_dir_accessible: false`
- E2E: 1 test — run doctor against a fully configured temp project, all 6 checks pass, returns `true`
- Performance: N/A
- TDD Parity: 100% — `runDoctor`, `checkClaudeBinary`, `checkMapping` all covered
- Coverage delta: +3% → ~87%

**Acceptance criteria:**
- [ ] `pencil-sync doctor` appears in `pencil-sync --help`
- [ ] Doctor prints a checklist with `[✓]` / `[✗]` per check and a reason for failures
- [ ] `runDoctor()` returns `true` when all 6 checks pass
- [ ] Exit code is 0 when all pass, 1 when any fail
- [ ] Each check is labeled clearly: "Claude CLI on PATH", "Config valid", "pen file accessible (mapping-id)", "Code directory accessible (mapping-id)", "Globs match files (mapping-id)", "Budget > 0"

**Estimated effort:** S

**Blocked by:** None (can run in parallel with Iteration 1)

---

#### Iteration 3 — Auto-detection helpers: `detectStyling()` and `findPenFiles()`

**Goal:** Add two pure-function helpers that the setup wizard (Iteration 4) depends on: one to auto-detect the styling system, one to find `.pen` files recursively.

**Shippable on its own?** Yes — pure addition to `src/config.ts`, used by wizard but useful standalone.

**Source references:**
- `src/config.ts:43-70` — `detectFramework()` — exact pattern to follow for `detectStyling()`
- `src/types.ts:4` — `Styling` type: `"tailwind" | "css-modules" | "styled-components" | "css" | "unknown"`

**Files touched:**
- `src/config.ts` (modified — add `detectStyling()`, `findPenFiles()`)
- `src/__tests__/config.test.ts` (modified — add tests for new helpers)

**Commit message:**
`feat(detect): add detectStyling() and findPenFiles() auto-detection helpers`

**TDD cycle:**
- RED:
  - `test_detectStyling_returns_tailwind_when_tailwind_config_exists` — `tailwind.config.js` present → `"tailwind"`
  - `test_detectStyling_returns_tailwind_for_tailwind_config_ts` — `tailwind.config.ts` → `"tailwind"`
  - `test_detectStyling_returns_css_modules_when_module_css_exists` — any `*.module.css` in dir → `"css-modules"`
  - `test_detectStyling_returns_styled_components_when_in_package_json` — `dependencies.styled-components` present → `"styled-components"`
  - `test_detectStyling_returns_css_when_css_file_exists` — `*.css` but no tailwind/modules → `"css"`
  - `test_detectStyling_returns_unknown_for_empty_dir` — empty dir → `"unknown"`
  - `test_detectStyling_priority_tailwind_beats_css_modules` — both present → `"tailwind"` (tailwind checked first)
  - `test_findPenFiles_returns_empty_for_dir_with_no_pen_files` — no `.pen` files → `[]`
  - `test_findPenFiles_finds_pen_file_in_root` — `design.pen` in root → `["./design.pen"]` (relative)
  - `test_findPenFiles_finds_pen_files_recursively` — `./screens/home.pen`, `./screens/settings.pen` → both returned
  - `test_findPenFiles_ignores_node_modules` — `.pen` file inside `node_modules/` → not returned
  - `test_findPenFiles_ignores_pencil_sync_dir` — `.pen` file inside `.pencil-sync/` → not returned
- GREEN:
  - `detectStyling(projectDir: string): Promise<Styling>` — checks in priority order: tailwind config, module.css, styled-components in package.json, any .css → returns first match or `"unknown"`
  - `findPenFiles(searchDir: string, maxDepth = 5): Promise<string[]>` — recursive readdir, skips `node_modules`, `.pencil-sync`, hidden dirs, max depth guard, returns relative paths
- REFACTOR:
  - Extract `readPackageJson(dir)` helper shared with future needs (returns `null` if absent/malformed, not throw)

**Test pyramid for this iteration:**
- Smoke: `import { detectStyling, findPenFiles } from "../config.js"` — no throw
- Unit: 12 tests listed above in `config.test.ts` using temp dirs
- Integration: N/A — pure file-system functions, no cross-module dependencies
- State machine: N/A
- Contract: 1 test — `detectStyling` return value is always a member of the `Styling` union
- Regression: 1 test — `detectFramework()` behavior unchanged (existing tests pass)
- Chaos: 2 tests — `detectStyling` with unreadable `package.json` returns `"unknown"` (not throw); `findPenFiles` with a symlink loop does not hang (maxDepth guard)
- E2E: N/A
- Performance: N/A
- TDD Parity: 100% — both new exports fully covered
- Coverage delta: +2% → ~89%

**Acceptance criteria:**
- [ ] `detectStyling()` correctly identifies tailwind, css-modules, styled-components, css, and unknown from fixture directories
- [ ] `findPenFiles()` recursively finds `.pen` files while skipping `node_modules` and `.pencil-sync/`
- [ ] Both functions handle missing/corrupt `package.json` without throwing
- [ ] `detectFramework()` existing behavior unchanged

**Estimated effort:** S

**Blocked by:** None

---

#### Iteration 4 — `pencil-sync setup` interactive wizard

**Goal:** Replace the dumb `init` command with a seven-question interactive wizard that auto-detects framework/styling, writes config, creates `.pencil-sync/`, runs doctor, and proves setup works via dry-run sync.

**Shippable on its own?** Yes — complete user-facing feature closing the full onboarding path.

**Source references:**
- `src/config.ts` — `detectFramework()`, `detectStyling()` (Iteration 3), `findPenFiles()` (Iteration 3), `loadConfig()`, `CONFIG_FILENAMES`
- `src/doctor.ts` — `runDoctor()` (Iteration 2) — called at end of wizard
- `src/index.ts:139-177` — current `init` command to be replaced
- `src/types.ts:1-6` — `Framework`, `Styling`, `SyncDirection`, `ConflictStrategy` union types — wizard choices

**Files touched:**
- `src/setup.ts` (new)
- `src/index.ts` (modified — replace `init` with `setup`, keep `init` as hidden alias)
- `src/__tests__/setup.test.ts` (new)

**Commit message:**
`feat(setup): add interactive pencil-sync setup wizard`

**TDD cycle:**
- RED:
  - `test_wizardio_ask_returns_default_on_empty_input` — `WizardIO.ask("Name?", "myapp")` with user pressing Enter → `"myapp"`
  - `test_wizardio_ask_returns_user_input` — user types `"myproject"` → `"myproject"`
  - `test_wizard_skips_pen_file_search_and_prompts_manual_when_no_pen_found` — empty dir → prompts for manual path
  - `test_wizard_offers_numbered_choices_when_pen_files_found` — 2 `.pen` files found → prompt lists them with `[1]` `[2]` + manual option
  - `test_wizard_selects_pen_file_by_number` — user enters `"1"` → first found `.pen` file selected
  - `test_wizard_uses_detected_framework_as_default` — detectFramework returns `"nextjs"` → wizard default is `"nextjs"`
  - `test_wizard_uses_detected_styling_as_default` — detectStyling returns `"tailwind"` → wizard default is `"tailwind"`
  - `test_wizard_writes_config_json_with_all_fields` — completing wizard writes valid `pencil-sync.config.json`
  - `test_wizard_creates_pencil_sync_directory` — `.pencil-sync/` exists after wizard completes
  - `test_wizard_calls_doctor_after_writing_config` — `runDoctor` is called once after config is written
  - `test_wizard_runs_dry_run_sync_after_doctor_passes` — after doctor passes, wizard calls `syncEngine.syncMapping()` with `dryRun: true`
  - `test_wizard_aborts_dry_run_when_doctor_fails` — when doctor returns `false`, dry-run is skipped and error shown
  - `test_wizard_exits_cleanly_in_non_tty_mode` — `process.stdin.isTTY === false` → wizard prints error and exits without hanging
  - `test_wizard_refuses_to_run_if_config_exists_and_user_declines_overwrite` — config exists, user enters `"n"` → aborts, config unchanged
  - `test_wizard_overwrites_config_when_user_confirms` — config exists, user enters `"y"` → new config written
- GREEN:
  - Create `src/setup.ts`:
    - `interface WizardIO { ask(q: string, defaultVal?: string): Promise<string>; print(msg: string): void }`
    - `createReadlineIO(): WizardIO` — real stdin readline implementation
    - `runSetup(io?: WizardIO): Promise<void>` — orchestrates all 7 prompt steps
    - Helper: `askChoice(io, question, choices)` — displays numbered list, validates input is 1..N or "m" for manual
    - Helper: `detectStylingLabel(styling)` — maps internal key to display name
    - Calls `runDoctor(configPath)` after writing config; if passes, runs `SyncEngine.syncMapping()` with `dryRun: true` on first mapping
  - In `index.ts`: replace `init` action with `() => runSetup()`; add hidden `setup` alias using `.alias("setup")` or register both; add `isTTY` guard at top of action
- REFACTOR:
  - Extract `promptPenFile(io, searchDir)` — encapsulates search + numbered choice + manual fallback
  - Extract `promptStyling(io, detected)` and `promptFramework(io, detected)` — for symmetry and testability

**Test pyramid for this iteration:**
- Smoke: `pencil-sync setup --help` exits 0; `pencil-sync init --help` still exits 0 (alias preserved)
- Unit: 15 tests listed above in `setup.test.ts` using injectable `WizardIO` mock
- Integration: 2 tests — full wizard flow against real temp dir (happy path + config-exists path)
- State machine: 2 tests — wizard state: `doctor_passed → dry_run` vs `doctor_failed → abort`
- Contract: 2 tests — written `pencil-sync.config.json` is parseable by `loadConfig()`; `.pencil-sync/` directory exists after wizard
- Regression: 2 tests — `pencil-sync init` still works as alias; `pencil-sync status` unaffected by setup changes
- Chaos: 2 tests — wizard with unwritable directory returns error (not throw); wizard where dry-run sync fails prints failure but exits 0 (setup itself succeeded)
- E2E: 1 test — full wizard run in temp dir with fake `.pen` file, mocked IO providing all inputs, ending with `last-run.json` written by dry-run
- Performance: N/A
- TDD Parity: 90% — `runSetup`, `WizardIO`, `askChoice`, `promptPenFile` covered; `createReadlineIO` is untested (real readline, excluded by design)
- Coverage delta: +3% → ~92%

**Acceptance criteria:**
- [ ] `pencil-sync setup` (and `pencil-sync init` as alias) launches the wizard
- [ ] Wizard auto-detects framework and styling and shows them as defaults
- [ ] Wizard finds and lists `.pen` files recursively, with numbered selection and manual fallback
- [ ] `pencil-sync.config.json` is written with all user-supplied and auto-detected values
- [ ] `.pencil-sync/` directory is created during wizard
- [ ] Wizard runs `pencil-sync doctor` and reports results inline
- [ ] Wizard runs a dry-run sync and reports the files that would change
- [ ] Wizard exits cleanly in non-TTY mode with an actionable error message
- [ ] `WizardIO` interface is injectable for testing (no real stdin required)

**Estimated effort:** M

**Blocked by:** Iterations 2 and 3

---

### 4. Test inventory summary

| Iter | Smoke | Unit | Integration | State machine | Contract | Regression | Chaos | E2E | Performance | TDD Parity | Coverage Δ |
|------|-------|------|-------------|---------------|----------|------------|-------|-----|-------------|------------|------------|
| 1 | 1 | 8 | 1 | 2 | 1 | 2 | 2 | 0 | 0 | 100% | +2% → ~84% |
| 2 | 1 | 13 | 1 | 0 | 1 | 1 | 2 | 1 | 0 | 100% | +3% → ~87% |
| 3 | 1 | 12 | 0 | 0 | 1 | 1 | 2 | 0 | 0 | 100% | +2% → ~89% |
| 4 | 1 | 15 | 2 | 2 | 2 | 2 | 2 | 1 | 0 | 90% | +3% → ~92% |

---

### 5. End-to-end definition of done

**All acceptance criteria across all iterations:**
- `DEFAULT_SETTINGS.stateFile` is `".pencil-sync/state.json"`; migration from flat file runs automatically on first load
- `.pencil-sync/last-run.json` is written after every sync
- `pencil-sync doctor` exits 0 when all 6 checks pass, 1 when any fail, with a readable checklist
- `pencil-sync setup` / `pencil-sync init` launch the interactive wizard
- Wizard auto-detects framework + styling, finds `.pen` files, writes config, creates `.pencil-sync/`, runs doctor, runs dry-run
- Wizard is injectable for tests via `WizardIO`; no real stdin needed in test suite
- `npm run build && npm test` green across all test files

**Demo script (manual end-to-end):**
```bash
mkdir /tmp/my-app && cd /tmp/my-app
mkdir src && touch design.pen
echo '{ "dependencies": {} }' > package.json
touch tailwind.config.js
pencil-sync setup
# → detects tailwind, offers design.pen, asks 7 questions
# → writes pencil-sync.config.json
# → creates .pencil-sync/
# → runs doctor (6 checks)
# → runs dry-run sync
pencil-sync doctor
# → all checks pass, exit 0
cat .pencil-sync/last-run.json
# → dry-run SyncResult JSON
```

**Test command:**
```bash
npm run build && npm test
```

Test files that must be green:
- `src/__tests__/state-store.test.ts`
- `src/__tests__/doctor.test.ts`
- `src/__tests__/config.test.ts`
- `src/__tests__/setup.test.ts`
- `src/__tests__/sync-engine.test.ts`
- `src/__tests__/logger.test.ts`
- `src/__tests__/mcp-server.test.ts`
- `src/__tests__/pen-to-code.test.ts`
- `src/__tests__/code-to-pen.test.ts`
- `src/__tests__/executor.test.ts`

---

### 6. Out of scope

- **`pencil-sync unlink` / cleanup command** — removes `.pencil-sync/` and config; low demand, adds destructive surface
- **Multi-mapping wizard** — one `setup` run creates one mapping only; multiple mappings can be added by editing the config manually
- **Windows `cmd.exe` readline** — readline in cmd.exe has known issues; deferred until Windows support is explicitly required
- **Doctor check for MCP config** — checking that `mcpConfigPath` exists is useful but niche; deferred with the MCP feature set
- **Doctor check for budget remaining** — session-level spend is in-memory only; persistent spend tracking would require a separate store
- **`.pencil-sync/` in `.gitignore` auto-append** — too invasive; the wizard will print a reminder message instead
- **`pencil-sync setup --non-interactive`** — flag-driven headless setup; useful for CI but uncertain demand; deferred

---

### 7. Open questions

1. **`pencil-sync init` fate**: the plan keeps it as a hidden alias to `setup`. If you prefer a hard removal (breaking change, bump to 0.3.0), say so before implementation starts — the plan assumes backward compat.

2. **`last-run.json` in MCP mode**: the MCP `pencil_record_sync` tool calls `updateMappingState()` but not `writeLastRun()`. Should it also write `last-run.json`? The plan leaves it as CLI-only for now.
