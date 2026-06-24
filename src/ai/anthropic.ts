import Anthropic from "@anthropic-ai/sdk";
import type { AIRunner, RunOptions, AIRunResult } from "./runner.interface.js";
import type { TokenUsage } from "../types.js";

const INPUT_COST_PER_1M: Record<string, number> = {
  "claude-sonnet-4-6": 3.0,
  "claude-haiku-4-5-20251001": 0.25,
  "claude-haiku-4-5": 0.25,
  "claude-opus-4-8": 15.0,
};
const OUTPUT_COST_PER_1M: Record<string, number> = {
  "claude-sonnet-4-6": 15.0,
  "claude-haiku-4-5-20251001": 1.25,
  "claude-haiku-4-5": 1.25,
  "claude-opus-4-8": 75.0,
};

export class AnthropicRunner implements AIRunner {
  private client: Anthropic;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = defaultModel;
  }

  async complete(prompt: string, options: RunOptions): Promise<AIRunResult> {
    const model = options.model || this.defaultModel;

    const response = await this.client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 4096,
      ...(options.systemPrompt && { system: options.systemPrompt }),
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const usage: TokenUsage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };

    return { text, usage };
  }

  estimateCost(tokens: TokenUsage): number {
    const inRate = INPUT_COST_PER_1M[this.defaultModel] ?? 3.0;
    const outRate = OUTPUT_COST_PER_1M[this.defaultModel] ?? 15.0;
    return (tokens.input / 1_000_000) * inRate + (tokens.output / 1_000_000) * outRate;
  }
}
