import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIRunner, RunOptions, AIRunResult } from "./runner.interface.js";
import type { TokenUsage } from "../types.js";

export class GoogleRunner implements AIRunner {
  private genAI: GoogleGenerativeAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "gemini-1.5-pro") {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.defaultModel = defaultModel;
  }

  async complete(prompt: string, options: RunOptions): Promise<AIRunResult> {
    const modelName = options.model || this.defaultModel;
    const model = this.genAI.getGenerativeModel({ model: modelName });

    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();
    const meta = result.response.usageMetadata;

    const usage: TokenUsage | undefined = meta
      ? {
          input: meta.promptTokenCount ?? 0,
          output: meta.candidatesTokenCount ?? 0,
        }
      : undefined;

    return { text, usage };
  }

  estimateCost(tokens: TokenUsage): number {
    return (tokens.input / 1_000_000) * 3.5 + (tokens.output / 1_000_000) * 10.5;
  }
}
