import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenUsage } from "../types.js";

// Shared mock functions exposed via hoisted variables for cross-test access
const { anthropicCreate, googleGetGenerativeModel, googleGenerateContent, openaiCreate } = vi.hoisted(() => {
  const anthropicCreate = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Anthropic response" }],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: "end_turn",
  });
  const googleGenerateContent = vi.fn().mockResolvedValue({
    response: {
      text: () => "Generated text",
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    },
  });
  const googleGetGenerativeModel = vi.fn(function () {
    return { generateContent: googleGenerateContent };
  });
  const openaiCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: "OpenAI response" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  return { anthropicCreate, googleGetGenerativeModel, googleGenerateContent, openaiCreate };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: anthropicCreate };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn(function (this: Record<string, unknown>) {
    this.getGenerativeModel = googleGetGenerativeModel;
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.chat = { completions: { create: openaiCreate } };
  }),
}));

const { AnthropicRunner } = await import("../ai/anthropic.js");
const { GoogleRunner } = await import("../ai/google.js");
const { OpenAICompatRunner } = await import("../ai/openai-compat.js");

describe("AnthropicRunner — pricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("smoke: constructs and exposes estimateCost", () => {
    const runner = new AnthropicRunner("key");
    expect(typeof runner.estimateCost).toBe("function");
  });

  it("estimateCost for Opus produces correct rate (not Sonnet rate)", () => {
    const runner = new AnthropicRunner("key", "claude-opus-4-8");
    const tokens: TokenUsage = { input: 1_000_000, output: 1_000_000 };
    const cost = runner.estimateCost(tokens);
    // Opus: $15/1M input + $75/1M output = $90
    expect(cost).toBeCloseTo(90, 0);
  });

  it("Iter 10 — haiku alias 'claude-haiku-4-5' resolves to haiku rates, not sonnet", () => {
    // 'claude-haiku-4-5' (without date suffix) must resolve to haiku pricing.
    // Bug: absent from table → fallback to Sonnet ($3/$15) instead of Haiku ($0.25/$1.25).
    const runner = new AnthropicRunner("key", "claude-haiku-4-5");
    const tokens: TokenUsage = { input: 1_000_000, output: 1_000_000 };
    const cost = runner.estimateCost(tokens);
    // Haiku: $0.25 + $1.25 = $1.50
    // Sonnet fallback would give $3 + $15 = $18 (12x overestimate)
    expect(cost).toBeCloseTo(1.5, 0);
  });

  it("Iter 10 — estimateCost for Opus matches published $15 input / $75 output rates", () => {
    const runner = new AnthropicRunner("key", "claude-opus-4-8");
    const costIn = runner.estimateCost({ input: 1_000_000, output: 0 });
    const costOut = runner.estimateCost({ input: 0, output: 1_000_000 });
    expect(costIn).toBeCloseTo(15, 1);
    expect(costOut).toBeCloseTo(75, 1);
  });
});

describe("GoogleRunner — systemInstruction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleGetGenerativeModel.mockReturnValue({ generateContent: googleGenerateContent });
    googleGenerateContent.mockResolvedValue({
      response: { text: () => "ok", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    });
  });

  it("smoke: constructs and can complete", async () => {
    const runner = new GoogleRunner("key");
    const result = await runner.complete("hello", {});
    expect(result.text).toBe("ok");
  });

  it("Iter 10 — systemPrompt is passed as systemInstruction to getGenerativeModel, not prepended to prompt", async () => {
    const runner = new GoogleRunner("key");
    await runner.complete("user prompt", { systemPrompt: "You are a coding assistant." });

    // getGenerativeModel must be called with systemInstruction
    expect(googleGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ systemInstruction: "You are a coding assistant." }),
    );

    // generateContent must receive only the user prompt (not system+user concatenated)
    const generateArg = googleGenerateContent.mock.calls[0]?.[0] as string;
    expect(generateArg).toBe("user prompt");
    expect(generateArg).not.toContain("You are a coding assistant.");
  });
});

describe("OpenAICompatRunner — finish_reason truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("smoke: constructs with baseURL and completes", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const runner = new OpenAICompatRunner({ apiKey: "k", baseURL: "https://api.example.com/v1" });
    const result = await runner.complete("hello", {});
    expect(result.text).toBe("ok");
  });

  it("Iter 10 — truncated finish_reason 'length' surfaces a warning or error", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "partial respon" }, finish_reason: "length" }],
      usage: { prompt_tokens: 100, completion_tokens: 4096 },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runner = new OpenAICompatRunner({ apiKey: "k" });
      const result = await runner.complete("hello", {});
      // If no throw, must have warned about truncation
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/truncat|length|max_token/i));
      expect(result.text).toBe("partial respon");
    } catch (err) {
      expect((err as Error).message).toMatch(/truncat|length|max_token/i);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
