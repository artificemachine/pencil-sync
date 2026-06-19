# Multi-Provider AI Runner Architecture

Provider-agnostic design for pencil-sync's AI layer, enabling Anthropic, Gemini, DeepSeek, MiniMax, and OpenAI to be swapped via config.

---

## Structure

```
pencil-sync
├── pencil-mcp-client.ts     ← provider-agnostic, talks to Pencil MCP
└── ai/
    ├── runner.interface.ts  ← AIRunner interface
    ├── anthropic.ts         ← @anthropic-ai/sdk
    ├── openai-compat.ts     ← @openai/openai — covers DeepSeek, MiniMax, OpenRouter
    └── google.ts            ← @google/generative-ai — covers Gemini
```

The MCP client layer is completely provider-agnostic — it calls the Pencil MCP binary regardless of which AI provider generates the `batch_design` script. Only the AI runner needs adapters.

---

## Provider Mapping

| Tool / Provider | Runner | How |
|---|---|---|
| Claude Code / Anthropic | `anthropic.ts` | `ANTHROPIC_API_KEY` |
| Gemini CLI / Gemini | `google.ts` | `GOOGLE_API_KEY` via `@google/generative-ai` |
| OpenCode + DeepSeek | `openai-compat.ts` | `DEEPSEEK_API_KEY`, base URL `api.deepseek.com` |
| OpenCode + MiniMax | `openai-compat.ts` | `MINIMAX_API_KEY`, base URL `api.minimax.chat/v1` |
| Codex CLI / OpenAI | `openai-compat.ts` | `OPENAI_API_KEY`, default base URL |

DeepSeek and MiniMax both expose OpenAI-compatible REST APIs. One `openai-compat.ts` runner covers all three by swapping `baseURL` and `apiKey` from config. No separate SDK needed per provider.

---

## Config Schema

```json
"settings": {
  "aiProvider": "anthropic" | "openai-compatible" | "google",
  "model": "deepseek-coder",
  "apiKey": "${DEEPSEEK_API_KEY}",
  "apiBaseUrl": "https://api.deepseek.com"
}
```

`apiBaseUrl` is only required for `openai-compatible` providers. Anthropic and Google use their SDK defaults.

---

## AIRunner Interface

```typescript
interface AIRunner {
  complete(prompt: string, options: RunOptions): Promise<string>;
  estimateCost(tokens: TokenUsage): number;
}
```

`complete()` returns the generated `batch_design` JavaScript. `estimateCost()` enables budget enforcement. Every provider implements these two methods; pencil-sync does not care which provider answers.

---

## Dependencies

```json
"@modelcontextprotocol/sdk": "^1.x",
"@anthropic-ai/sdk": "^0.x",
"openai": "^4.x",
"@google/generative-ai": "^0.x"
```

Only the SDK matching the configured provider needs to be reachable at runtime. Others can be optional peer dependencies.
