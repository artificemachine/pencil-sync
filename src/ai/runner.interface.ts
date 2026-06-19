import type { TokenUsage } from "../types.js";

export interface RunOptions {
  model: string;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AIRunResult {
  text: string;
  usage?: TokenUsage;
}

export interface AIRunner {
  complete(prompt: string, options: RunOptions): Promise<AIRunResult>;
  estimateCost(tokens: TokenUsage): number;
}
