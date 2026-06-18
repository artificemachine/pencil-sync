import { runClaude } from "./claude-runner.js";
import type { ClaudeRunOptions } from "./claude-runner.js";
import type { ClaudeRunResult } from "./types.js";

// Type aliases — evolve independently of Claude-specific types when a second executor ships
export type ExecutorRunOptions = ClaudeRunOptions;
export type ExecutorResult = ClaudeRunResult;

export interface Executor {
  run(options: ExecutorRunOptions): Promise<ExecutorResult>;
}

export class LocalClaudeExecutor implements Executor {
  run(options: ExecutorRunOptions): Promise<ExecutorResult> {
    return runClaude(options);
  }
}

export const localClaudeExecutor: Executor = new LocalClaudeExecutor();
