# Deep Bug Hunt — pencil-sync

Multi-agent audit: 16 dimensioned finders + adversarial verification (refutation-lensed verifiers, majority vote). Prior manual-pass claims were seeded in so they faced the same scrutiny.

## Coverage (honest)

- All 16 dimension finders finished → **90 unique candidate findings**.
- Verification was **partial**: 29 claims received adversarial votes; the completeness critic and round-2 targeted re-hunt never started (run was stopped to cap cost).
- Result: a **verified core** + a larger **found-but-unverified** tail. Each finding is labelled accordingly.

## Two prior-pass claims were REFUTED (retracted)

| Claim | Verdict | Reality |
|---|---|---|
| CSS written then state not persisted on later Claude fail ("Bug B") | **0/2 real** | Refuted. |
| Direct-API budget "warn-only, not enforced" | **0/2 real** | A preflight gate (`checkBudget`) runs before the call. The real, narrower issue: the preflight **under-counts** (omits the design-state JSON). |

## Confirmed by adversarial verification (≥2 independent votes)

| Sev | File | Bug | Vote |
|---|---|---|---|
| HIGH | `pen-snapshot.ts` | Deleted/cleared props & tokens never diff | 3/3 |
| HIGH | `pen-to-code.ts` | Fill failures hidden on mixed diffs → false success | 3/3 |
| HIGH | `state-store.ts` | Backup written but never read for recovery → silent wipe | 3/3 |
| HIGH | `pen-to-code.ts:134` | `rgb()` fills pass the fast-path gate but `hexToRgbChannels` can't parse them → silent color drop | 3/3 |
| HIGH | `pen-to-code.ts:74` | Chained RGB replace corrupts colors (A `#224846→#333333`, B `#333333→#444444` double-applies) | 3/3 |
| HIGH | `pen-to-code.ts:14` | `hexToRgbChannels` returns wrong RGB for invalid-length hex (`parseInt` leniency) | 2/2 |
| HIGH | `pen-to-code.ts` | pen-to-code ignores configured provider, always uses Claude CLI | 2/2 |
| MED | `mcp-server.ts:153` | `pencil_apply_fill_changes` returns success-shaped even on zero matches | 2/2 |
| MED | `pen-to-code.ts:187` | `executeClaudeSync` reports success when Claude changed zero files | 2/2 |
| MED | `pen-snapshot.ts` | Newly-added props on existing nodes never diff | 2/2 |
| MED | `pen-snapshot.ts` | Whole-node deletions produce no diff | 2/2 |
| MED | `code-to-pen.ts:142` | Returns success on no-op/unreadable `.pen` | 2/2 |
| MED | `config.ts` | Mappings unvalidated despite zod | 2/2 |
| HIGH | `mcp-server.ts:223` | stdin-EOF orphan (already FIXED) | 2/3 (1 dissent) |

## New HIGH severity — found but NOT yet verified

1. **`settings.provider` is half-wired** (`code-to-pen.ts:48` + `factory.ts`) — the documented field routes to the API path but `createRunner` and env-key population only read legacy `aiProvider`. The documented config always fails.
2. **`pencil_record_sync` never persists the pen snapshot** (`mcp-server.ts:205`) — destroys the design-diff baseline; `pencil_diff_design` then silently reports "no changes" in the MCP workflow.
3. **`batchDesign` ignores MCP `isError`** (`pencil-mcp-client.ts:94`) — server-side design failure reported as a successful sync.
4. **Manual sync ignores `mapping.direction`** (`sync-engine.ts:153`) — can overwrite the authoritative side → silent data loss.
5. **`watcher.stop()` never awaits in-flight sync** — Ctrl+C mid-sync corrupts `.pen`/state and orphans the grace timer + `claude` child.
6. **5-min timeout misclassified as transient** (`claude-runner.ts`) — retried up to ~20 min, records zero tokens.
7. **Concurrent `save()` shares a fixed `.tmp` path** (`state-store.ts:77`) — state-file corruption under parallel mappings.
8. **Auto-merge reports success without verifying any change** + wipes snapshot baseline (`sync-engine.ts:306`).
9. **ReDoS in multi-`**/` globs** (`glob-matcher.ts`) — catastrophic backtracking; the repo's own ReDoS guard test is ineffective.

## Dominant patterns

- **False-success rot** (biggest theme): `err()` never sets `isError`; `batchDesign`/`batchGet` ignore `isError`; `executeClaudeSync`/`autoMerge`/`code-to-pen` return success on no-op or failure.
- **Diff engine only handles modifications** — adds, deletes, new props, type changes, and nested tokens silently skipped.
- **Color fast-path is fragile** — 5+ distinct silent-drop/corruption modes.
- **Security tail** — key exfil via unvalidated `apiBaseUrl` (SSRF); prompt injection from untrusted `.pen` content into a Read/Write/Edit-capable agent; `__proto__` node-id prototype pollution; prompts exposed via argv.

---

## Appendix A — All 90 candidate findings

> Severity and confidence as reported by the finder agents. Unverified unless listed in the verified table above.

### HIGH

- `code-to-pen.ts:48-56, 79-90` + `factory.ts:4-12` — New `provider` field routes to direct-API but `createRunner` only reads legacy `aiProvider`; documented config always fails.
- `pencil-mcp-client.ts:94-99` (→ `code-to-pen.ts:137-162`) — `batchDesign` ignores MCP `isError`; server-side design failure reported as successful sync.
- `sync-engine.ts:153-176` — Manual sync path ignores `mapping.direction`; can overwrite the authoritative side (silent data loss).
- `lock-manager.ts:90-113` (+ `sync-engine.ts:138, 347`) — Auto-merge records direction "both", which `shouldSuppressTrigger` never matches → echo suppression fails → auto-merge budget-burn loop risk.
- `mcp-server.ts:205` — `pencil_record_sync` never persists the pen snapshot → design-diff baseline destroyed → `pencil_diff_design` reports no changes in MCP-only workflow.
- `watcher.ts:139-183, 188-204` — `stop()` never awaits in-flight sync; Ctrl+C mid-sync corrupts `.pen`/state and orphans a grace timer.
- `claude-runner.ts:143-181, 242-245` — Hard 5-min timeout misclassified as transient MCP `tool_timeout` and retried (~20 min total), records zero tokens.
- `state-store.ts:77, 83-84` — Concurrent `save()` calls share a fixed `.tmp` path → state-file corruption / lost atomicity.
- `sync-engine.ts:306-352` — Auto-merge reports success without verifying any change AND wipes the pen snapshot baseline (silent data loss).
- `glob-matcher.ts:9-12, 67, 72` — Catastrophic-backtracking ReDoS in multi-`**/` globs; repo's own ReDoS guard test is ineffective.
- `pen-to-code.ts:134-139, 14-28, 263-264` — `rgb()` fills classified fast-path-eligible but `hexToRgbChannels` cannot parse them (silent drop).
- `pen-to-code.ts:74-119` — Sequential global RGB replacement corrupts/loses colors when one diff's new value equals another diff's old value.

### MEDIUM

- `code-to-pen.ts:106-114` (+ `ai/anthropic.ts:28-45`) — Truncated AI output silently used as the `batch_design` script (hardcoded `maxTokens 4096`, `stop_reason` discarded).
- `pencil-mcp-client.ts:81-92` (→ `code-to-pen.ts:98-102`) — `batchGet` swallows errors / non-JSON, returns empty `{}`; AI generates blind, potentially duplicating design.
- `lock-manager.ts:21-32, 46-70` — Stale-lock auto-release steals a lock from a still-running long sync (no ownership/fencing) → concurrent writes + premature unlock.
- `watcher.ts:147-183` — Grace-window blind spot: legitimate edits whose debounce fires during the lock grace period are dropped as 'locked' with no requeue.
- `mcp-server.ts:231-241` + `shutdown.ts` — MCP fix uses raw `process.exit(0)` with no drain of in-flight tool calls; `ShutdownManager` never wired into the MCP server.
- `mcp-server.ts:24-26` (err helper) — `err()` returns failures without `isError:true`; every caught error reported as a successful MCP tool result.
- `pen-snapshot.ts:155-167` — Newly-added visual props on existing nodes never produce a diff (silent design drift).
- `pen-snapshot.ts:134` — Whole-node deletions in the design produce no diff; stale UI persists in code.
- `watcher.ts:142-159` — `pendingChanges` re-arm delays reverse-direction echoes past the suppression window → spurious reverse sync / oscillation (direction:both).
- `watcher.ts:142-159` — Genuine concurrent code edit during in-flight pen-to-code sync is queued then suppressed as an echo → silently dropped.
- `claude-runner.ts:49-50` — `parseTokenUsage` matches `cache_*_input_tokens` (no word boundary) → cache token count reported as input.
- `claude-runner.ts:49-50, 103-104` — `parseTokenUsage` reads only the first usage block; with `--max-turns 3` later turns are never counted.
- `claude-runner.ts:222-251` — Tokens spent on failed/retried attempts discarded; only final attempt tracked.
- `claude-runner.ts:118-124` — Env stripping incomplete: `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` (and Bedrock/Vertex vars) not removed.
- `claude-runner.ts:95-107, 129-132` — Large prompt as a single `-p` argv element can exceed Linux `MAX_ARG_STRLEN` (128 KiB) → `E2BIG`; stdin is 'ignore', no fallback.
- `mcp-server.ts:32-33, 183-185, 204-205` — Read-modify-write across separate `StateStore` instances → lost updates + same `.tmp` corruption race.
- `state-store.ts:246-251` — `collectFiles` swallows `readdir` errors → transient read failure looks like mass deletion and is persisted.
- `sync-engine.ts:236-251` (+ `code-to-pen.ts:99-114`) — Direct-API budget pre-flight under-counts: estimate omits the full design-state JSON appended to the real prompt.
- `sync-engine.ts:267-273` (+ `pen-to-code.ts:263-264, 309-310`) — Pen-to-code pre-flight skips the budget gate for non-scalar fill changes that route to Claude (budget bypass).
- `ai/anthropic.ts:5-14` — Cost table wrong: Opus 4.8 ~3× overestimated, Haiku 4.5 ~4× underestimated.
- `ai/anthropic.ts:48-52` — `estimateCost` keys on the dated Haiku ID and on `defaultModel`; Haiku alias silently falls back to Sonnet rates.
- `ai/openai-compat.ts:24-43` — Ignores `finish_reason`: truncated/content-filtered completions returned as complete.
- `ai/google.ts:14-23` — Concatenates `systemPrompt` into the user prompt instead of `systemInstruction`, weakening system-level instructions.
- `ai/openai-compat.ts:15-21` — `apiBaseUrl` passed verbatim to the OpenAI client → API key sent to any configured host.
- `glob-matcher.ts:27-36` — POSIX `[!...]` negated character class silently treated as a literal class.
- `glob-matcher.ts:58, 71` — Backslash glob patterns never match (only path side normalized).
- `pen-to-code.ts:14-28` — `hexToRgbChannels` silently wrong for invalid-length / partially-invalid hex.
- `mcp-server.ts:153-170` — `pencil_apply_fill_changes` returns success-shaped even when zero declarations matched / errors populated.
- `pen-to-code.ts:187-202` — `executeClaudeSync` reports success when Claude changes zero files, dropping the diff and advancing state.
- `pen-to-code.ts:83, 287-306` — A color change that normalizes to a no-op is reported as a hard failure and re-triggers every sync.
- `pen-to-code.ts:88-91, 116-118` — Fast-path CSS assumptions too narrow (`--color-` prefix + space-separated RGB) → silent zero-match on typical CSS.
- `setup.ts:44-68` (+ `index.ts:153`) — Interactive `setup` wizard never closes its readline interface → hangs after completion.
- `claude-runner.ts:140-181` — 5-min timeout treated as transient and retried → repeated/overlapping `claude` subprocesses.
- `config.ts:263-271` (+ `factory.ts:7-15`) — Env-var `apiKey` auto-population ignores the new `provider` field.
- `config.ts:252-254` — `mappings` shape check accepts non-arrays, then crashes with cryptic `.map is not a function`.
- `config.ts:236-250` — JSONC cleaner strips comments but not trailing commas → `.jsonc` configs with trailing commas fail to parse.
- `setup.ts:246-254, 114-121` — Non-interactive setup hangs forever on invalid or wrong-case `--direction`.
- `__tests__/mcp-server.test.ts:7-18` — No regression test for the MCP stdin-close orphan fix (`startMcpServer` + handlers untested).
- `__tests__/code-to-pen.test.ts` — Direct-API path (`syncCodeToPenDirect`) and all `src/ai/` runners are completely untested.
- `__tests__/pen-to-code.test.ts` — No test guards the pen-to-code provider asymmetry.
- `__tests__/watcher.test.ts:22-23` — No full sync-loop integration test; watcher tests mock `SyncEngine`; `index.ts` entirely untested.
- `pen-snapshot.ts:173-181` — Prompt injection: untrusted `.pen` text content flows verbatim into the Claude CLI prompt (agent has Read/Write/Edit over the repo).

### LOW

- `code-to-pen.ts:260-264` — `extractScript` regex newline-anchored / first-block-only; non-fenced/inline-fenced output passes prose to `batch_design`.
- `code-to-pen.ts:173-175` — `await disconnect()` in `finally` can override a successful sync with a rejection.
- `mcp-server.ts:18, 39` — Hardcoded `SERVER_VERSION` 0.2.0 in handshake while package is 0.5.1.
- `mcp-server.ts:172-191` — `pencil_invalidate_state` deletes the entire mapping state, contradicting its "clear code-file hashes" contract.
- `pen-snapshot.ts:39, 85, 105-114` — Reusable component definitions double-counted with their ref instances → redundant diffs trip the fill fast-path warning.
- `pen-snapshot.ts:116-124` — `flattenTokens` is shallow: nested theme/variable structures diff as one opaque JSON blob per top-level key.
- `pen-snapshot.ts:139` — First sync after design tokens are introduced emits zero token diffs (newly-present bucket skipped).
- `watcher.ts:100-127` — `penFile` not excluded from the code watcher → a single `.pen` edit can double-trigger both directions.
- `ignored-dirs.ts:1` — Hardcoded `dist`/`.next` in `IGNORED_DIRS` silently drops legitimate source in such paths, no override.
- `watcher.ts:24-43` — No idempotency guard in `start()` — a second `start()` accumulates watchers/listeners, doubling events.
- `claude-runner.ts:140-149` — Timeout resolves the promise before killing; SIGKILL escalation timer untracked → brief double-process + dangling timer.
- `state-store.ts:70, 83-84` — Atomic rename without `fsync` overstates durability (survives SIGKILL, not power loss).
- `state-store.ts:101-102` — Full code tree hashed twice per sync (`detectConflict` + `updateMappingState`).
- `state-store.ts:145-152` — `writeLastRun` is a non-atomic plain write → concurrent runs can corrupt `last-run.json`.
- `sync-engine.ts:103-108, 89-97` — Budget tracked with Claude pricing for non-Claude providers; `runner.estimateCost` ignored for enforcement.
- `ai/google.ts:36-38` — Google cost estimate is a hardcoded flat rate ignoring the model (OpenAI's is an acknowledged placeholder).
- `ai/factory.ts:27-36` — Google catch block too broad; swallows constructor/runtime errors as a missing-dependency message.
- `ai/google.ts:9` — Default model `gemini-1.5-pro` hardcoded, unvalidated, likely deprecated.
- `glob-matcher.ts:37-56` — Unterminated single-token brace collapses to `(?:)` → false-positive matches.
- `watcher.ts:188-204` (+ `sync-engine.ts:197-203`) — `stop()` doesn't await in-flight syncs; `engine.shutdown()` releases locks mid-sync → completing sync re-arms an orphan grace timer after shutdown.
- `config.ts:260-262` — `${VAR}` apiKey expansion silently yields undefined when env var missing → misleading "apiKey is required" error.
- `config.ts:19-29` — `safeMerge` silently drops unknown/mistyped settings keys with no diagnostic.
- `setup.ts:321` — Setup silently coerces budget 0 to 0.5 and accepts negative budgets.
- `setup.ts:218-241` — Setup validates direction but not framework/styling → arbitrary values persisted.
- `shutdown.ts:80-90` (+ `watcher.ts`, `claude-runner.ts`) — In-flight `claude` child orphaned on SIGTERM during watch-mode sync.
- `doctor.ts:36-46, 115-118` — `doctor` reports green for a corrupt/unparseable `.pen` (access-only check).
- `utils.ts:26-34` (+ `pen-snapshot.ts`) — Type-only design-token changes produce no diff (`stableStringify` + `String()` collapse types).
- `__tests__/sync-engine.test.ts:110-116` — No concurrency/race test for the per-mapping sync lock.
- `__tests__/pen-snapshot.test.ts` — Deletion-diff test asymmetry: code-side deletions tested, pen-side node/token deletions neither handled nor tested.
- `pen-snapshot.ts:60, 116-123` — Untrusted `.pen` node id `__proto__` mutates snapshot prototype and silently drops the node (silent data loss).
- `ai/openai-compat.ts:15-20` (+ `config.ts:276-285`) — API key transmitted to an unvalidated `apiBaseUrl` (no https/scheme/host check).
- `claude-runner.ts:95-107` (+ `prompt-builder.ts:44-62`) — Prompt + inlined style-file contents passed via argv → exposed in process table / `/proc` on shared hosts.

### INFO

- `claude-runner.ts:110-112` (dup in `pencil-mcp-client.ts:25-27`) — `mcpConfigPath` `~` expansion uses `String.replace("~", HOME)`: first-occurrence only, `$`-substitution pitfall, bare `~` unhandled.

---

## Appendix B — Verifier verdicts (claim → real votes)

```
1/1  A color change that normalizes to a no-op is reported as a hard failure and re-triggers
2/2  Config mappings not schema-validated despite zod dependency
3/3  Deleted/cleared design props & tokens never produce a diff
3/3  Fill (color) failures hidden on mixed diffs -> false success
1/1  First sync after design tokens are introduced emits zero token diffs
2/2  Fixed 500ms flush sleep is a race
1/1  Google import catch reports misleading install error
2/2  MCP pencil_apply_fill_changes returns success-shaped result even when zero declarations matched
2/3  MCP server never exited on stdin EOF (orphan 100% CPU spin)
1/1  New design nodes explicitly skipped in diff
2/2  Newly-added visual props on existing nodes never produce a diff
0/2  Partial success: CSS written but state not persisted when later Claude call fails  [REFUTED]
2/2  Provider asymmetry: pen-to-code always uses claude CLI, ignores aiProvider
1/1  Reusable component definitions double-counted with ref instances
3/3  Sequential global RGB replacement corrupts/loses colors
3/3  State backup written on every save but never read for recovery
1/1  Unterminated brace drops last alternative silently
2/2  Whole-node deletions in the design produce no diff
0/2  code-to-pen direct-API budget is warn-only, not enforced  [REFUTED]
2/2  code-to-pen returns success:true on no-op or unreadable .pen
2/2  executeClaudeSync reports success when Claude changes zero files
1/1  flattenTokens is shallow: nested structures diff as one opaque JSON blob
1/1  globToRegex recompiled per file per glob (no cache)
2/2  hexToRgbChannels silently produces wrong RGB for invalid-length/partially-invalid hex
1/1  lock-manager is in-memory but documented as file-based
1/1  ref node per-instance overrides discarded during snapshot
3/3  rgb() fills classified fast-path-eligible but hexToRgbChannels cannot parse them
1/1  validatePathWithin symlink bypass (no realpath)
1/1  watch command orphan parity (no stdin-disconnect handling)
```
