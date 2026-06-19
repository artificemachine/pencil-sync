# pencil-sync MCP Client Redesign

Proposed architecture to fix the Claude CLI subprocess conflict that blocks all `code-to-pen` sync.

---

## Problem: Current Architecture

```
pencil-sync → Claude CLI subprocess → Pencil MCP binary → Pencil socket
                     ↑ conflict
              Claude Code already holds the Pencil MCP connection
```

The Pencil app accepts only one MCP WebSocket connection at a time. When pencil-sync spawns a Claude CLI subprocess, the parent Claude Code session already holds that connection. Every `code-to-pen` run fails.

---

## Solution: pencil-sync as its Own MCP Client

```
pencil-sync ─── @modelcontextprotocol/sdk ──► Pencil MCP binary ──► Pencil socket
     │
     └── @anthropic-ai/sdk ──► Claude API (direct, no subprocess)
```

pencil-sync owns both connections. No conflict with Claude Code. No Claude CLI subprocess.

---

## What Changes

| Current | New |
|---|---|
| `claude-runner.ts` spawns `claude` CLI with `--mcp-config` | Removed entirely for `code-to-pen` |
| Claude CLI internally calls `batch_get` / `batch_design` | `pencil-mcp-client.ts` calls them directly via MCP SDK |
| Anthropic API reached indirectly through CLI auth | `@anthropic-ai/sdk` calls API directly with `ANTHROPIC_API_KEY` |
| `~` expansion bug in shell arg | Gone — Node resolves paths natively |
| Single-connection conflict | Gone — pencil-sync owns its own connection |

---

## New Files

### `pencil-mcp-client.ts`

Wraps `@modelcontextprotocol/sdk` with a `StdioClientTransport` pointed at the Pencil MCP binary path from config. Exposes typed wrappers for `batch_get` and `batch_design`.

### `anthropic-runner.ts`

Replaces `claude-runner.ts` for the `code-to-pen` path. Uses `@anthropic-ai/sdk` to call the Anthropic API directly with `ANTHROPIC_API_KEY`. Handles streaming, token tracking, and budget enforcement.

---

## New `code-to-pen` Flow

1. pencil-sync detects code file changes (via hash diff against state store)
2. `pencil-mcp-client.ts` calls `batch_get` to read current Pencil node state
3. `anthropic-runner.ts` calls Claude API with: current node state + code diff + prompt template
4. Claude returns `batch_design` JavaScript
5. `pencil-mcp-client.ts` calls `batch_design` with the generated script
6. State store updates pen file hash

---

## What This Fixes

- No subprocess MCP connection conflict
- No `~` path expansion bug (Node resolves paths natively)
- Faster — no CLI spawn overhead, direct API streaming
- Debuggable — MCP calls are traceable in Node
- Works regardless of whether Claude Code is open

## What Remains a Structural Limit

- `clamp()` / `svh` / dynamic CSS values still need manual mapping
- Multi-color inline text still requires splitting into two Pencil nodes
- Content collection changes still need a trigger mechanism
- Responsive breakpoints still require separate Pencil frames per viewport

---

## Dependencies to Add

```json
"@modelcontextprotocol/sdk": "^1.x",
"@anthropic-ai/sdk": "^0.x"
```

## Config Change

`ANTHROPIC_API_KEY` required in `.env`. The `mcpConfigPath` setting remains — used by `pencil-mcp-client.ts` to locate the Pencil MCP binary path, not passed to Claude CLI.
