# Changelog

All notable changes to pencil-sync will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-03-16

### Added
- `pencil-sync sync --dry-run` / `-n` — preview what would change without writing any files
- GitHub Actions CI: test matrix on Node 20 + 22 (`.github/workflows/ci.yml`)
- GitHub Actions Security: ShipGuard SAST gate pinned to `==0.3.2` (`.github/workflows/security.yml`)
- Docker: healthcheck (`node dist/index.js --version` every 60s)
- Docker: memory limit 512M / CPU limit 1.0 in `docker-compose.yml`
- `docs/` directory; moved `REVIEW.md` and `SOUL.md` from repo root

### Fixed
- Dockerfile `|| true` on Claude CLI install — container could start silently broken; build now fails explicitly
- Docker container ran as root — switched to `USER node` (UID 1000); Linux hosts must `chown -R 1000:1000` the project dir
- `.superharness/` directory incorrectly tracked in git — contained machine-specific absolute paths; untracked and gitignored
- `extractErrorMessage()` utility extracted to `utils.ts` — removes 5 inline repetitions of `instanceof Error` guard
- Duplicate `shouldPersist` boolean in `SyncEngine` — extracted to named constant

### Added (core features)
- Bidirectional sync between `.pen` design files and frontend code via Claude CLI
- `pencil-sync init` — generate a starter config
- `pencil-sync sync` — one-time sync with optional direction override (`pen-to-code` / `code-to-pen`)
- `pencil-sync watch` — continuous file watcher with debounce and sync-loop prevention
- `pencil-sync status` — show last sync time, direction, and tracked file count per mapping
- Color fast path: direct CSS variable replacement for fill/color changes (no Claude call)
- Budget enforcement: token usage parsed from Claude CLI `--verbose`, blocks when `maxBudgetUsd` exceeded
- Conflict detection and resolution strategies: `prompt`, `pen-wins`, `code-wins`, `auto-merge`
- MCP integration: optional Pencil MCP server for structured `.pen` read/write
- Exponential backoff retry for transient MCP server errors
- Atomic state writes with `.tmp`+rename and checksum verification
- Path traversal prevention and prototype pollution guards in config loading
- JSONC config support (comments in JSON config files)
- Docker support
- 308 tests across 18 test files (Vitest)

## [0.1.2] — 2026-03-26

### Fixed
- CI: replace `--fail-on high` with `--severity high` in ShipGuard Security workflow — `--fail-on` is not a valid flag (caused exit code 2 on every run)

### Chore
- CLAUDE.md: protect against accidental deletion of youtube-model-feeder source project

## [0.1.3] — 2026-03-26

### Chore
- Add `AGENTS.md` scaffold (agent protocol compliance)
- Update `package-lock.json` lockfile

## [Unreleased]

### Fixed
- Budget pre-flight now projects output-token cost (3× input, conservative), not just input — a large generation can no longer slip past `maxBudgetUsd`
- Claude CLI token usage falls back to a length-based estimate (with a warning) when `--verbose` output can't be parsed, instead of silently recording zero spend and disabling budget enforcement entirely

### Documentation
- Add `docs/AUDIT-2026-06-12.md` — full v0.1.3 project audit (build, tests, security, architecture, correctness, CI). Flags the `.pen` encryption/reader contradiction, budget-bypass gaps, dual glob engines, and in-memory lock manager

## [0.1.4] - 2026-06-12

### Refactor
- Share one ignored-directory list (`IGNORED_DIRS` / `IGNORED_GLOBS`) between watcher and state-hasher; adds `.next` to the skip set, closing the drift where build output was hashed but not watched (P2-E)
- Replace POSIX-only `validatePathWithinDirectory` in config.ts with the cross-platform `validatePathWithin` from utils.ts; removes the duplicate function and fixes path-traversal guard on Windows (P2-D)
- 322 tests passing (6 new tests added across ignored-dirs and config suites)
- 2026-06-12: fix(pen-to-code): report color fast-path no-ops instead of silent success (P2-C)

- 2026-06-12: fix(budget): refresh model pricing table and warn on unknown-model fallback
- 2026-06-12: fix(sync): unify glob matching so watcher and hasher agree on patterns (P2-B)
- 2026-06-12: chore(tooling): add ESLint flat config with typescript-eslint
- 2026-06-12: chore(tooling): measure coverage and enforce thresholds (v8 provider, lines≥81%)
- 2026-06-12: chore(release): bump to v0.1.5 (fast-path fix, glob unification, ESLint, coverage)
- 2026-06-12: chore: ignore .serena/, .hablatone, coverage/ in .gitignore
- 2026-06-18: docs(plan): add iteration plan for Executor interface refactor (Option A)

- 2026-06-18: refactor(executor): add Executor interface and LocalClaudeExecutor wrapping runClaude

- 2026-06-18: refactor(sync): route pen-to-code and code-to-pen through injected Executor

- 2026-06-18: refactor(sync): SyncEngine owns a single Executor and injects it into both directions
- 2026-06-18: feat(mcp): route logger output to stderr in MCP mode
- 2026-06-18: feat(mcp): add pencil-sync-mcp binary with MCP stdio server skeleton
- 2026-06-18: feat(mcp): add pencil_get_config, pencil_diff_design, pencil_diff_code, pencil_detect_conflict tools
- 2026-06-18: feat(mcp): add pencil_build_prompt, pencil_apply_fill_changes, pencil_record_sync tools
- 2026-06-18: chore(release): bump version to 0.2.0 — MCP server feature (minor)
