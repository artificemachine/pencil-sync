# NOTE: Paid AI providers on hold — default to the Max-plan executor

Decision + rationale for parking paid API providers (MiniMax, DeepSeek) on the
`artificemachine_web` mapping, plus recommendations for pencil-sync so the
zero-cost path is the obvious default. Companion to
[`ARCH-claude-cli-subprocess-path.md`](./ARCH-claude-cli-subprocess-path.md).

Date: 2026-06-19.

---

## Decision

Paid hosted-model providers are **on hold** for this project. Sync runs on the
existing **Claude subscription**, not a metered API key:

- **Interactive** `/pencil-sync` (inside Claude Code) → the running session is the AI. $0.
- **Headless** `pencil-sync sync` → with no `aiProvider` set, code-to-pen takes the
  **Claude-CLI executor** path (subscription-backed). $0. See the companion ARCH doc.

No MiniMax or DeepSeek calls are made.

## What changed (consumer config)

`artificemachine_web/pencil-sync.config.json` `settings` before:

```jsonc
"model": "MiniMax-Text-01",
"aiProvider": "openai-compatible",
"apiKey": "${MINIMAX_API_KEY}",
"apiBaseUrl": "https://api.minimaxi.chat/v1"
```

after:

```jsonc
"model": "claude-sonnet-4-6"
// aiProvider / apiKey / apiBaseUrl removed
```

Removing `aiProvider` is the documented switch to the executor path
(`code-to-pen.ts:47-54`). `model` now names a Claude model so the spawned
`claude` CLI uses it.

## Why

- **MiniMax billing was blocking it anyway.** The key authenticates on the
  international domain (`api.minimaxi.chat`) but the account is out of quota:
  `429 Token Plan usage limit reached (2056)`. On the China domain
  (`api.minimax.chat`) the same key returns a misleading `401 invalid api key
  (2049)` — a region/domain mismatch, not a bad key.
- **No reason to pay.** The operator already has a Claude subscription; both the
  interactive and executor paths consume it at $0. A separate per-token API key
  adds cost and a second failure surface (auth, region, quota) for no benefit here.

## How to re-enable a provider later

Paste one of these back into `settings` (and restore an env var with the key):

```jsonc
// MiniMax (international domain — note minimaxi, not minimax)
"aiProvider": "openai-compatible",
"apiKey": "${MINIMAX_API_KEY}",
"apiBaseUrl": "https://api.minimaxi.chat/v1",
"model": "MiniMax-Text-01"

// DeepSeek
"aiProvider": "openai-compatible",
"apiKey": "${DEEPSEEK_API_KEY}",
"apiBaseUrl": "https://api.deepseek.com/v1",
"model": "deepseek-chat"
```

MiniMax also needs the account topped up (the `2056` quota error) before it will
actually complete a sync.

## Recommendations for pencil-sync

1. **Make the subscription path the documented default.** The README presents
   `aiProvider` as the way to do code-to-pen; in practice the cheapest correct
   default for a Claude Code user is *no* `aiProvider` (executor path). Lead with
   that; treat paid API providers as an opt-in for headless/CI without a local
   Claude login.
2. **Explicit provider selector.** Inferring "executor vs API" from the *presence*
   of `aiProvider` is implicit. A `provider: "claude-cli" | "<api>"` field states
   intent and makes "use my subscription, not an API" a first-class choice.
3. **Validate credentials at config load (dry ping).** A one-shot auth check would
   have surfaced the MiniMax `401`/`429` as a clear setup error instead of a
   mid-sync failure. Include the region hint (`minimax.chat` vs `minimaxi.chat`)
   in the error text — that domain mismatch produced a misleading "invalid api key".
4. **Don't present `costUsd` as spend under a subscription.** `MODEL_PRICING` is an
   API-rate estimate; on the executor/subscription path the operator is not billed
   per token. Label it "estimated API-equivalent" or suppress it when the executor
   path is active, so the budget warning isn't mistaken for real charges.
5. **Document the env-interpolation + region gotchas** (`config.ts:259` expands
   `${VAR}`; wrong regional domain → `2049`). Both cost real debugging time here.

## Net

Sync stays fully functional on the Claude subscription at $0. Paid providers are
parked, not deleted — re-enable in one block when there's a reason (e.g. headless
CI without a local Claude login, and a funded account).
