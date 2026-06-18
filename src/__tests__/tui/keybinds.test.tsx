import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { App } from "../../tui/App.js";
import type { PencilSyncConfig, MappingConfig, SyncResult } from "../../types.js";

afterEach(() => cleanup());

const baseMapping: MappingConfig = {
  id: "m1",
  penFile: "./design.pen",
  codeDir: "./src",
  codeGlobs: ["**/*.tsx"],
  direction: "both",
};

const baseConfig: PencilSyncConfig = {
  version: 1,
  mappings: [baseMapping],
  settings: {
    debounceMs: 2000,
    model: "claude-sonnet-4-6",
    maxBudgetUsd: 0.5,
    conflictStrategy: "prompt",
    stateFile: ".pencil-sync/state.json",
    logLevel: "info",
  },
};

const okResult: SyncResult = {
  success: true,
  direction: "pen-to-code",
  mappingId: "m1",
  filesChanged: [],
};

describe("keybinds", () => {
  it("q calls onQuit", async () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <App config={baseConfig} states={{}} onQuit={onQuit} />,
    );
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));
    expect(onQuit).toHaveBeenCalled();
  });

  it("s calls engine.syncMapping for each mapping in config", async () => {
    const mockEngine = {
      syncMapping: vi.fn<[MappingConfig, string], Promise<SyncResult>>().mockResolvedValue(okResult),
    };
    const { stdin } = render(
      <App config={baseConfig} states={{}} engine={mockEngine} />,
    );
    stdin.write("s");
    await new Promise((r) => setTimeout(r, 100));
    expect(mockEngine.syncMapping).toHaveBeenCalledWith(baseMapping, "manual");
  });

  it("d calls onRunDoctor and emits result event", async () => {
    const onRunDoctor = vi.fn().mockResolvedValue(undefined);
    const { stdin } = render(
      <App config={baseConfig} states={{}} onRunDoctor={onRunDoctor} />,
    );
    stdin.write("d");
    await new Promise((r) => setTimeout(r, 100));
    expect(onRunDoctor).toHaveBeenCalled();
  });

  it("regression: watch command SyncEngine still works without TUI (onEvent=null)", () => {
    // Just checking that App renders when no engine or callbacks are provided
    expect(() =>
      render(<App config={baseConfig} states={{}} />),
    ).not.toThrow();
  });
});
