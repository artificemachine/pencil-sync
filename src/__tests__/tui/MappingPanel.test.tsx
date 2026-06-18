import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { MappingPanel } from "../../tui/MappingPanel.js";
import { App } from "../../tui/App.js";
import type { MappingConfig, MappingState } from "../../types.js";

afterEach(() => cleanup());

const baseMapping: MappingConfig = {
  id: "my-mapping",
  penFile: "./design.pen",
  codeDir: "./src",
  codeGlobs: ["**/*.tsx"],
  direction: "both",
};

const baseState: MappingState = {
  mappingId: "my-mapping",
  penHash: "abc123",
  codeHashes: { "src/App.tsx": "def456", "src/Button.tsx": "ghi789" },
  lastSyncTimestamp: Date.now() - 5000, // 5s ago
  lastSyncDirection: "pen-to-code",
};

describe("MappingPanel", () => {
  it("smoke: renders without throwing", () => {
    expect(() => render(<MappingPanel mapping={baseMapping} state={null} />)).not.toThrow();
  });

  it("renders mapping id in output", () => {
    const { lastFrame } = render(<MappingPanel mapping={baseMapping} state={baseState} />);
    expect(lastFrame()).toContain("my-mapping");
  });

  it("renders last sync time when state present", () => {
    const { lastFrame } = render(<MappingPanel mapping={baseMapping} state={baseState} />);
    // Should show "Xs ago" style relative time
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/ago|last sync/i);
  });

  it("renders 'not yet synced' when state is null", () => {
    const { lastFrame } = render(<MappingPanel mapping={baseMapping} state={null} />);
    expect(lastFrame()).toContain("not yet synced");
  });

  it("renders direction", () => {
    const { lastFrame } = render(<MappingPanel mapping={baseMapping} state={baseState} />);
    expect(lastFrame()).toContain("pen-to-code");
  });
});

describe("App", () => {
  it("smoke: renders with empty mappings without throwing", () => {
    const config = { version: 1, mappings: [], settings: { debounceMs: 2000, model: "sonnet", maxBudgetUsd: 0.5, conflictStrategy: "prompt" as const, stateFile: ".pencil-sync/state.json", logLevel: "info" as const } };
    const states: Record<string, MappingState | undefined> = {};
    expect(() => render(<App config={config} states={states} />)).not.toThrow();
  });

  it("renders one MappingPanel per mapping in config", () => {
    const config = {
      version: 1,
      mappings: [
        { ...baseMapping, id: "mapping-a" },
        { ...baseMapping, id: "mapping-b", penFile: "./b.pen", codeDir: "./lib" },
      ],
      settings: { debounceMs: 2000, model: "sonnet", maxBudgetUsd: 0.5, conflictStrategy: "prompt" as const, stateFile: ".pencil-sync/state.json", logLevel: "info" as const },
    };
    const states: Record<string, MappingState | undefined> = {};
    const { lastFrame } = render(<App config={config} states={states} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mapping-a");
    expect(frame).toContain("mapping-b");
  });

  it("chaos: StateStore has no mappings state — all panels render 'not yet synced'", () => {
    const config = {
      version: 1,
      mappings: [baseMapping],
      settings: { debounceMs: 2000, model: "sonnet", maxBudgetUsd: 0.5, conflictStrategy: "prompt" as const, stateFile: ".pencil-sync/state.json", logLevel: "info" as const },
    };
    const states: Record<string, MappingState | undefined> = {};
    const { lastFrame } = render(<App config={config} states={states} />);
    expect(lastFrame()).toContain("not yet synced");
  });
});
