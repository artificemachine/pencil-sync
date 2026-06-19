# ARCH: The Claude CLI Subprocess Path (code-to-pen via local `claude`)

How pencil-sync drives a `code-to-pen` sync by **spawning the local `claude` CLI** as a
child process, instead of calling a hosted model API. This is the path that lets a sync
run on a **Claude subscription (Max/Pro)** rather than pay-per-token API billing.

Audience: pencil-sync maintainers + operators choosing between the two AI engines.
All code references are to `src/` at v0.5.1.

---

## 1. Why this path exists

`code-to-pen` has two engines, selected at runtime:

```ts
// src/code-to-pen.ts:47-54
if (settings.aiProvider) {
  return syncCodeToPenDirect(...);        // hosted API (Anthropic / OpenAI-compat / Google) — API key, per-token billing
}
return syncCodeToPenViaExecutor(...);      // spawn local `claude` CLI — subscription-backed, no API key
```

The **direct** path needs an API key and bills per token. The **executor** path shells
out to the `claude` binary already installed and authenticated on the machine. If that
binary is logged in via a **Max/Pro subscription**, the sync consumes the subscription —
no separate API spend. That is the entire value proposition of this path: reuse the seat
the operator already pays for.

Selection rule: **leave `aiProvider` unset** (and omit `apiKey`/`apiBaseUrl`) in the
config's `settings` to route through the executor. Setting `aiProvider` opts back into
the hosted-API path.

---

## 2. Call chain

```
SyncEngine (executor = localClaudeExecutor by default — sync-engine.ts:58)
  └─ syncCodeToPen(...)                              code-to-pen.ts
       └─ syncCodeToPenViaExecutor(...)              code-to-pen.ts:171
            └─ executor.run(opts)                    executor.ts (LocalClaudeExecutor)
                 └─ runClaude(opts)                  claude-runner.ts:208  (retry wrapper)
                      └─ runOnce(opts)               claude-runner.ts:92   (the spawn)
                           └─ spawn("claude", args)  claude-runner.ts:126
```

The executor is injected into `SyncEngine` and defaults to `localClaudeExecutor`
(`sync-engine.ts:54-58`), so no configuration is required to get the Claude executor —
it is the default when `aiProvider` is absent.

---

## 3. The spawn — exact mechanics (`claude-runner.ts:92-130`)

```ts
const args = [
  "-p", prompt,
  "--model", model,
  "--output-format", "text",
  "--verbose",
  "--max-turns", "3",
  "--allowedTools", options.allowedTools ?? "Edit,Write,Read,Glob,Grep",
];
if (options.mcpConfigPath) {
  const mcpPath = options.mcpConfigPath.startsWith("~/")
    ? options.mcpConfigPath.replace("~", process.env["HOME"] ?? "~")
    : options.mcpConfigPath;
  args.push("--mcp-config", mcpPath);
}

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;            // strip markers that block a nested CLI session
delete cleanEnv.CLAUDE_CODE_SESSION;

const proc = spawn("claude", args, {
  cwd: cwd ?? process.cwd(),
  env: cleanEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Key points:

- **`claude` is resolved from `PATH`** — no absolute path. The operator's installed CLI
  is what runs, with its existing auth.
- **`-p` (print/non-interactive)** runs one headless turn set; `--max-turns 3` bounds the
  agent loop; output is plain `text`.
- **Env stripping is essential.** `CLAUDECODE` / `CLAUDE_CODE_SESSION` are deleted so the
  child does not think it is nested inside a parent Claude Code session and refuse to
  start. This is what makes the spawn work when pencil-sync is itself launched from a
  Claude Code session.
- **`cwd` is the mapping's `codeDir`** (`code-to-pen.ts:186`), so the CLI's relative file
  reads resolve against the code project.

---

## 4. MCP wiring for code-to-pen (`code-to-pen.ts:183-191`)

When `mcpConfigPath` is set, the executor call adds the Pencil MCP tools to the
allowlist and passes the MCP config through:

```ts
const result = await executor.run({
  prompt,
  model: settings.model,
  cwd: mapping.codeDir,
  ...(settings.mcpConfigPath && {
    allowedTools:
      "Edit,Write,Read,Glob,Grep,mcp__pencil__batch_get,mcp__pencil__batch_design," +
      "mcp__pencil__set_variables,mcp__pencil__get_screenshot",
    mcpConfigPath: settings.mcpConfigPath,
  }),
});
```

So the spawned `claude` opens **its own** Pencil MCP connection (via `--mcp-config`) and
performs the edit itself using `batch_design` / `set_variables`. pencil-sync does not
parse or apply a script in this path; it delegates the whole edit to the agent, then
diffs the `.pen` file before/after (`code-to-pen.ts:178`, `208-227`) to decide
`filesChanged`.

The `~/` prefix in `mcpConfigPath` is expanded against `$HOME` before being passed
(`claude-runner.ts:110-112`).

---

## 5. Reliability machinery

- **Timeout:** `CLAUDE_TIMEOUT_MS = 300_000` (5 min). On expiry: `SIGTERM`, then `SIGKILL`
  after 5 s (`claude-runner.ts:88`, `137-146`).
- **Retries:** `runClaude` retries up to `DEFAULT_MAX_RETRIES = 3` with exponential
  backoff, but **only when `mcpConfigPath` is set and only for transient MCP errors**
  (`server_unavailable`, `tool_timeout`, `server_crash` — `claude-runner.ts:78-86`,
  `208-246`). Non-MCP failures and `malformed_response` are not retried.
- **Output caps:** stdout/stderr buffered to a 10 MB ceiling (`claude-runner.ts:134`).
- **Token accounting:** parsed from `--verbose` stderr (`parseTokenUsage`,
  `claude-runner.ts:44-59`); if unparseable on a successful run, falls back to a
  length-based estimate so budget tracking is never silently zeroed
  (`claude-runner.ts:168-175`).
- **Cost:** `MODEL_PRICING` covers `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`,
  `claude-opus-4-6`, `claude-opus-4-8` (`claude-runner.ts:17-22`). Note this cost is an
  **API-rate estimate for budgeting/telemetry**; under a subscription the operator is not
  billed per token, so the recorded `costUsd` is informational, not actual spend.

---

## 6. Billing: how the subscription is (and isn't) used

The subprocess uses **whatever auth the local `claude` CLI already has**:

- **Subscription (Max/Pro):** if `claude` is logged in via subscription, the sync runs on
  that seat. No API key, no per-token charge. This is the intended use.
- **API key leakage caveat (important):** the env clean only deletes `CLAUDECODE` and
  `CLAUDE_CODE_SESSION`. It does **not** strip `ANTHROPIC_API_KEY`. If that var is present
  in the environment pencil-sync inherits, the spawned CLI may authenticate via the API
  (per-token billing) instead of the subscription — silently defeating the cost saving.
  To guarantee subscription billing: ensure `claude` is subscription-authenticated and
  that `ANTHROPIC_API_KEY` is **not** set in the environment that launches pencil-sync.

---

## 7. The single-connection caveat (still unverified for this path)

`AUDIT-2026-06-12` / the consuming project's audit noted that the Pencil app historically
accepted **one MCP socket at a time**, which broke the old subprocess approach when a
parent Claude Code session already held the connection.

Empirically (consumer-side validation, 2026-06-19): pencil-sync's **direct-path**
`PencilMcpClient` connected to `~/.pencil/socket/pencil-desktop.sock` successfully
*alongside* a live Claude Code session (got its own client id, `batch-get` returned ok).
So the single-connection limit did **not** reproduce for one extra client.

However, that test exercised the **direct** path's client, not the **executor** path.
The executor path spawns a full `claude` agent that opens *its own* Pencil MCP — a
distinct second client. Whether two independent `claude`-CLI Pencil MCP clients can
coexist with an editor session is **not yet proven**. This is the one open risk before
recommending the executor path for unattended/watch use.

---

## 8. How to enable it on a consuming project

In the project's `pencil-sync.config.json`, under `settings`:

```jsonc
{
  "settings": {
    // remove or null these three to take the executor path:
    // "aiProvider": "...",
    // "apiKey": "...",
    // "apiBaseUrl": "...",
    "model": "claude-sonnet-4-6",        // or claude-opus-4-8, etc. (must be a MODEL_PRICING key for accurate budget telemetry)
    "mcpConfigPath": "~/.config/pencil-sync/mcp.json"
  }
}
```

Then run `pencil-sync sync -d code-to-pen`. With `DEBUG=pencil-sync:*` the executor path
prints `Spawning: claude -p ...` (`claude-runner.ts:116`) — the presence of that line (vs.
`Calling <provider> API`) is the quickest way to confirm which engine ran.

Reminder: this is also the **only** way to run a sync on a Claude subscription. There is
no way to bill a raw hosted-API call to a Max/Pro plan; the plan is reachable only
*through* the `claude` CLI or an interactive Claude Code session.

---

## 9. Direct API vs. Claude CLI subprocess — trade-offs

| Dimension | Direct API (`aiProvider` set) | Claude CLI subprocess (`aiProvider` unset) |
|---|---|---|
| Billing | Per-token API key | Subscription (if CLI logged in via Max/Pro) |
| Who applies the edit | pencil-sync runs `batch_design` itself | spawned `claude` agent applies it |
| Pencil connection | one in-process `PencilMcpClient` (verified to coexist) | a second `claude`-owned MCP client (coexistence unverified) |
| Startup cost | low (HTTP) | higher (cold CLI + agent loop, ≤5 min cap) |
| Determinism | single completion, you control the script | agentic, up to 3 turns |
| Failure modes | HTTP/auth/quota (e.g. 401/429) | spawn errors, CLI auth, MCP transient errors (retried) |
| Provider choice | Anthropic / OpenAI-compat / Google | Claude only |

---

## 10. Recommendations for pencil-sync

1. **Strip `ANTHROPIC_API_KEY` from the child env (or make it explicit).** Add it to the
   `delete cleanEnv.*` block in `runOnce`, or expose a `settings.subscriptionOnly` flag
   that does so, so operators can guarantee subscription billing. Today the leakage is
   silent (§6).
2. **Add a connection-coexistence test for the executor path** (§7): spawn `claude` with
   `--mcp-config` while a separate Pencil MCP client holds the socket, assert success.
   This is the remaining unknown that blocks recommending the path for `watch` mode.
3. **Document the engine-selection rule** (`aiProvider` set ⇒ API, unset ⇒ CLI) in the
   README's settings section; it is currently only discoverable from
   `code-to-pen.ts:47-54`.
4. **Clarify `costUsd` semantics under subscription** — label it an API-rate estimate so
   the budget warning (`code-to-pen.ts:112`) is not mistaken for real subscription spend.
5. **Surface the chosen engine in non-debug logs** — a one-line `Engine: claude-cli` /
   `Engine: <provider> API` at INFO level would remove the need for `DEBUG=*` to tell
   which path ran.

---

## Appendix — file/line index

| What | Location |
|---|---|
| Engine selection | `src/code-to-pen.ts:47-54` |
| Executor sync impl | `src/code-to-pen.ts:171-` |
| Executor interface + default | `src/executor.ts` (`localClaudeExecutor`) |
| Default executor injected | `src/sync-engine.ts:54-58` |
| Retry wrapper | `src/claude-runner.ts:208-249` |
| The spawn | `src/claude-runner.ts:92-130` |
| Args + `~` expansion | `src/claude-runner.ts:95-114` |
| Env stripping | `src/claude-runner.ts:118-121` |
| Timeout / kill | `src/claude-runner.ts:88, 137-146` |
| MCP allowlist for code-to-pen | `src/code-to-pen.ts:187-190` |
| Cost table | `src/claude-runner.ts:17-22` |
