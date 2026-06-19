import OpenAI from "openai";
import type { AIRunner, RunOptions, AIRunResult } from "./runner.interface.js";
import type { TokenUsage } from "../types.js";

export interface OpenAICompatConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}

export class OpenAICompatRunner implements AIRunner {
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: OpenAICompatConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
    this.defaultModel = config.defaultModel ?? "gpt-4o";
  }

  async complete(prompt: string, options: RunOptions): Promise<AIRunResult> {
    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens ?? 4096,
      messages: [
        ...(options.systemPrompt
          ? [{ role: "system" as const, content: options.systemPrompt }]
          : []),
        { role: "user" as const, content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const usage: TokenUsage | undefined = response.usage
      ? {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens,
        }
      : undefined;

    return { text, usage };
  }

  estimateCost(tokens: TokenUsage): number {
    // Conservative placeholder — actual rate varies by provider and model
    return (tokens.input / 1_000_000) * 1.0 + (tokens.output / 1_000_000) * 2.0;
  }
}
