import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings } from "../types.js";

const { MockAnthropicRunner, MockOpenAICompatRunner } = vi.hoisted(() => {
  const MockAnthropicRunner = vi.fn(function (this: Record<string, unknown>) {
    this.complete = vi.fn();
    this.estimateCost = vi.fn().mockReturnValue(0);
  });
  const MockOpenAICompatRunner = vi.fn(function (this: Record<string, unknown>) {
    this.complete = vi.fn();
    this.estimateCost = vi.fn().mockReturnValue(0);
  });
  return { MockAnthropicRunner, MockOpenAICompatRunner };
});

vi.mock("../ai/anthropic.js", () => ({ AnthropicRunner: MockAnthropicRunner }));
vi.mock("../ai/openai-compat.js", () => ({ OpenAICompatRunner: MockOpenAICompatRunner }));
vi.mock("../ai/google.js", () => ({
  GoogleRunner: vi.fn(function (this: Record<string, unknown>) {
    this.complete = vi.fn();
    this.estimateCost = vi.fn().mockReturnValue(0);
  }),
}));

const { createRunner } = await import("../ai/factory.js");

const BASE: Settings = {
  debounceMs: 2000,
  model: "claude-sonnet-4-6",
  maxBudgetUsd: 0.5,
  conflictStrategy: "prompt",
  stateFile: "/tmp/state.json",
  logLevel: "error",
  apiKey: "test-api-key",
};

describe("createRunner — Iteration 4 provider resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockAnthropicRunner.mockClear();
    MockOpenAICompatRunner.mockClear();
  });

  describe("smoke — existing behavior unchanged", () => {
    it("creates AnthropicRunner when aiProvider is 'anthropic'", async () => {
      const runner = await createRunner({ ...BASE, aiProvider: "anthropic" });
      expect(runner).toBeDefined();
      expect(MockAnthropicRunner).toHaveBeenCalledOnce();
    });

    it("throws when neither provider nor aiProvider is set", async () => {
      await expect(createRunner({ ...BASE, apiKey: undefined })).rejects.toThrow();
    });
  });

  describe("unit — settings.provider resolution", () => {
    it("resolves engine from settings.provider when aiProvider is unset", async () => {
      // RED: currently ignores settings.provider and throws "settings.aiProvider is required"
      const runner = await createRunner({
        ...BASE,
        provider: "anthropic",
        aiProvider: undefined,
      });
      expect(runner).toBeDefined();
      expect(MockAnthropicRunner).toHaveBeenCalledOnce();
    });

    it("provider takes precedence over aiProvider when both are set", async () => {
      // RED: currently uses aiProvider ("openai-compatible"), ignoring provider
      await createRunner({
        ...BASE,
        provider: "anthropic",
        aiProvider: "openai-compatible",
      });
      expect(MockAnthropicRunner).toHaveBeenCalledOnce();
      expect(MockOpenAICompatRunner).not.toHaveBeenCalled();
    });
  });

  describe("contract — provider/aiProvider precedence", () => {
    it("provider=openai-compatible selects OpenAICompatRunner", async () => {
      await createRunner({
        ...BASE,
        provider: "openai-compatible",
        aiProvider: undefined,
        apiBaseUrl: "https://api.openai.com/v1",
      });
      expect(MockOpenAICompatRunner).toHaveBeenCalledOnce();
    });
  });

  describe("chaos — apiKey missing with provider set", () => {
    it("throws a clear error when provider is set but apiKey is missing", async () => {
      await expect(
        createRunner({ ...BASE, provider: "anthropic", aiProvider: undefined, apiKey: undefined }),
      ).rejects.toThrow(/apiKey/i);
    });
  });
});
