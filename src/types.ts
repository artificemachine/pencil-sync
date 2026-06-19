export type SyncDirection = "both" | "pen-to-code" | "code-to-pen";
export type ConflictStrategy = "prompt" | "pen-wins" | "code-wins" | "auto-merge";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type Framework = "nextjs" | "react" | "vue" | "svelte" | "astro" | "unknown";
export type Styling = "tailwind" | "css-modules" | "styled-components" | "css" | "unknown";

export interface MappingConfig {
  id: string;
  penFile: string;
  codeDir: string;
  codeGlobs: string[];
  penScreens?: string[];
  framework?: Framework;
  styling?: Styling;
  direction: SyncDirection;
  /** Files containing design tokens (CSS variables, Tailwind config) — inlined into prompts */
  styleFiles?: string[];
}

export type AIProvider = "anthropic" | "openai-compatible" | "google";

/**
 * Explicit engine selector. "claude-cli" forces the subscription-backed executor
 * path even if aiProvider is also set. When omitted, the engine is inferred:
 * aiProvider set → hosted API; aiProvider unset → claude-cli.
 */
export type SyncProvider = "claude-cli" | AIProvider;

export interface Settings {
  debounceMs: number;
  model: string;
  maxBudgetUsd: number;
  conflictStrategy: ConflictStrategy;
  stateFile: string;
  logLevel: LogLevel;
  mcpConfigPath?: string;
  /**
   * Explicit engine: "claude-cli" uses the local claude binary (subscription);
   * "anthropic" / "openai-compatible" / "google" calls the hosted API.
   * Omitting this field falls back to the legacy inference rule.
   */
  provider?: SyncProvider;
  /** When set, code-to-pen uses direct API calls instead of Claude CLI subprocess */
  aiProvider?: AIProvider;
  /** API key for the selected aiProvider */
  apiKey?: string;
  /** Base URL override for openai-compatible providers (DeepSeek, MiniMax, etc.) */
  apiBaseUrl?: string;
}

export interface PencilSyncConfig {
  version: number;
  mappings: MappingConfig[];
  settings: Settings;
}

export interface PenNodeSnapshot {
  [nodeId: string]: Record<string, string | number>;
}

export interface MappingState {
  mappingId: string;
  penHash: string;
  codeHashes: Record<string, string>;
  lastSyncTimestamp: number;
  lastSyncDirection: SyncDirection;
  penSnapshot?: PenNodeSnapshot;
}

export interface SyncState {
  version: number;
  mappings: Record<string, MappingState>;
}

export interface SyncResult {
  success: boolean;
  skipped?: boolean;
  dryRun?: boolean;
  direction: SyncDirection;
  mappingId: string;
  filesChanged: string[];
  error?: string;
  warnings?: string[];
  tokenUsage?: TokenUsage;
  penSnapshot?: PenNodeSnapshot;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export type TuiSyncEvent = {
  type: "sync" | "error" | "warning" | "conflict";
  mappingId: string;
  message: string;
  timestamp: number;
  success?: boolean;
};

export type McpErrorType =
  | "malformed_response"
  | "server_unavailable"
  | "tool_timeout"
  | "server_crash";

export interface ClaudeRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  tokenUsage?: TokenUsage;
  /** True when tokenUsage is a length-based fallback estimate, not parsed from the CLI. */
  tokenUsageEstimated?: boolean;
  mcpError?: McpErrorType;
}

export interface ConflictInfo {
  mappingId: string;
  penChanged: boolean;
  codeChanged: boolean;
  changedCodeFiles: string[];
}

export interface PenDiffEntry {
  nodeId: string;
  nodeName: string;
  prop: string;
  oldValue: string | number;
  newValue: string | number;
}

export interface FillChangeResult {
  filesChanged: string[];
  errors: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  debounceMs: 2000,
  model: "claude-sonnet-4-6",
  maxBudgetUsd: 0.5,
  conflictStrategy: "prompt",
  stateFile: ".pencil-sync/state.json",
  logLevel: "info",
  mcpConfigPath: undefined,
  provider: undefined,
  aiProvider: undefined,
  apiKey: undefined,
  apiBaseUrl: undefined,
};
