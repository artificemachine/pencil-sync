import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PencilSyncConfig, MappingConfig } from "../types.js";

vi.mock("../claude-runner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../claude-runner.js")>();
  return {
    ...original,
    runClaude: vi.fn().mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
      tokenUsage: { input: 1000, output: 200 },
    }),
  };
});

vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("pen-to-code prompt"),
  buildCodeToPenPrompt: vi.fn().mockResolvedValue("code-to-pen prompt"),
  buildConflictPrompt: vi.fn().mockResolvedValue("conflict prompt"),
}));

// Mock pen-snapshot (used directly by pen-to-code.ts and code-to-pen.ts)
// Return a non-fill diff so Claude CLI gets called for pen-to-code syncs
vi.mock("../pen-snapshot.js", () => ({
  snapshotPenFile: vi.fn().mockReturnValue({}),
  diffPenSnapshots: vi.fn().mockReturnValue([
    { nodeId: "t1", nodeName: "title", prop: "content", oldValue: "old", newValue: "new" },
  ]),
  formatDiffForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("../utils.js", () => ({
  getCssStyleFile: vi.fn().mockReturnValue(undefined),
  validatePathWithin: vi.fn().mockImplementation((_base: string, file: string) => file),
}));

const { SyncEngine } = await import("../sync-engine.js");
const { runClaude } = await import("../claude-runner.js");
const { diffPenSnapshots } = await import("../pen-snapshot.js");

const mockedRunClaude = vi.mocked(runClaude);
const mockedDiffPenSnapshots = vi.mocked(diffPenSnapshots);

describe("SyncEngine", () => {
  let dir: string;
  let mapping: MappingConfig;
  let config: PencilSyncConfig;
  let engine: InstanceType<typeof SyncEngine>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "app.tsx"), "content");
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };

    config = {
      version: 1,
      mappings: [mapping],
      settings: {
        debounceMs: 2000,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 0.5,
        conflictStrategy: "prompt",
        stateFile: join(dir, ".state.json"),
        logLevel: "error",
      },
    };

    engine = new SyncEngine(config);
    await engine.initialize();
  });

  afterEach(async () => {
    engine.shutdown();
    vi.clearAllMocks();
    mockedDiffPenSnapshots.mockReturnValue([
      { nodeId: "t1", nodeName: "title", prop: "content", oldValue: "old", newValue: "new" },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  describe("syncMapping", () => {
    it("syncs pen-to-code on pen-changed trigger", async () => {
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("syncs code-to-pen on code-changed trigger", async () => {
      // Change code file so conflict detector sees a code change
      await writeFile(join(dir, "code", "app.tsx"), "modified");
      const result = await engine.syncMapping(mapping, "code-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("rejects when lock is held", async () => {
      engine.getLockManager().acquire("test");
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("locked");
      engine.getLockManager().forceRelease("test");
    });

    it("ignores pen-changed for code-to-pen mapping", async () => {
      const codeOnly = { ...mapping, direction: "code-to-pen" as const };
      const result = await engine.syncMapping(codeOnly, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("ignores code-changed for pen-to-code mapping", async () => {
      const penOnly = { ...mapping, direction: "pen-to-code" as const };
      const result = await engine.syncMapping(penOnly, "code-changed");
      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("respects manual direction override", async () => {
      const result = await engine.syncMapping(mapping, "manual", "pen-to-code");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("budget enforcement", () => {
    it("tracks cumulative spend", async () => {
      expect(engine.getCumulativeSpendUsd()).toBe(0);

      await engine.syncMapping(mapping, "pen-changed");
      // 1000 input * $3/MTok + 200 output * $15/MTok = $0.003 + $0.003 = $0.006
      expect(engine.getCumulativeSpendUsd()).toBeGreaterThan(0);
    });

    it("blocks sync when budget exhausted", async () => {
      // Budget large enough for the first sync's pre-flight estimate to pass,
      // but exhausted by its actual spend ($1.05 from the mock below) so the
      // second sync is blocked by cumulative exhaustion (not the pre-flight gate).
      config.settings.maxBudgetUsd = 0.5;
      const lowBudgetEngine = new SyncEngine(config);
      await lowBudgetEngine.initialize();

      mockedRunClaude.mockResolvedValueOnce({
        success: true,
        stdout: "Done",
        stderr: "",
        exitCode: 0,
        tokenUsage: { input: 100_000, output: 50_000 },
      });
      await lowBudgetEngine.syncMapping(mapping, "pen-changed");

      // Force-release lock so second sync isn't blocked by grace period
      lowBudgetEngine.getLockManager().forceRelease(mapping.id);

      // Second sync should be blocked by budget, not lock
      const result = await lowBudgetEngine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Budget");

      lowBudgetEngine.shutdown();
    });

    it("reports remaining budget", () => {
      expect(engine.getRemainingBudgetUsd()).toBe(0.5);
    });
  });

  describe("lock manager integration", () => {
    it("sets lastSyncDirection after successful sync", async () => {
      await engine.syncMapping(mapping, "pen-changed");

      const lm = engine.getLockManager();
      // After pen-to-code sync, code-changed should be suppressed
      expect(lm.shouldSuppressTrigger("test", "code-changed")).toBe(true);
    });
  });

  /** Rebuild engine with a non-interactive conflict strategy to avoid stdin blocking. */
  async function withStrategy(strategy: "pen-wins" | "code-wins" | "auto-merge") {
    config.settings.conflictStrategy = strategy;
    engine = new SyncEngine(config);
    await engine.initialize();
  }

  describe("conflict resolution", () => {
    // For conflict tests we need both pen AND code to have changed since last state.
    // We initialize state, then change both files before triggering sync.
    async function setupConflict() {
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");
    }

    it("pen-wins strategy syncs pen-to-code on conflict", async () => {
      await withStrategy("pen-wins");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("code-wins strategy syncs code-to-pen on conflict", async () => {
      await withStrategy("code-wins");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "code-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("auto-merge strategy calls Claude with conflict prompt", async () => {
      await withStrategy("auto-merge");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("both");
      expect(result.filesChanged.length).toBeGreaterThan(0);
      expect(mockedRunClaude).toHaveBeenCalled();
    });

    it("auto-merge passes MCP tools when mcpConfigPath is set", async () => {
      config.settings.mcpConfigPath = "/path/to/mcp.json";
      await withStrategy("auto-merge");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);

      // Find the runClaude call for auto-merge (not the initial pen-to-code sync)
      const autoMergeCall = mockedRunClaude.mock.calls.find(
        (call) => call[0].allowedTools?.includes("mcp__pencil__batch_get"),
      );
      expect(autoMergeCall).toBeDefined();
      expect(autoMergeCall![0].mcpConfigPath).toBe("/path/to/mcp.json");
      expect(autoMergeCall![0].allowedTools).toContain("mcp__pencil__batch_design");

      // Clean up
      delete config.settings.mcpConfigPath;
    });

    it("auto-merge returns error when Claude fails", async () => {
      await withStrategy("auto-merge");

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 1000, output: 200 },
      });
      mockedRunClaude.mockResolvedValueOnce({
        success: false, stdout: "", stderr: "API overloaded", exitCode: 1,
        tokenUsage: { input: 500, output: 0 },
      });

      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Auto-merge failed");
    });

    it("conflict is only triggered for direction=both mappings", async () => {
      const penOnlyMapping = { ...mapping, direction: "pen-to-code" as const };
      config.mappings = [penOnlyMapping];
      await withStrategy("pen-wins");

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "x" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "new code");

      const result = await engine.syncMapping(penOnlyMapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("manual trigger with auto direction", () => {
    it("syncs pen-to-code when only pen changed", async () => {
      await withStrategy("pen-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "new" }] }));

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("syncs code-to-pen when only code changed", async () => {
      await withStrategy("code-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "code", "app.tsx"), "changed code");

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("defaults to pen-to-code when neither changed", async () => {
      await withStrategy("pen-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("pre-flight budget estimate", () => {
    it("blocks sync when estimated input cost exceeds remaining budget", async () => {
      config.settings.maxBudgetUsd = 0.001;
      await withStrategy("pen-wins");

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 50_000, output: 10_000 },
      });
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Budget");
    });

    it("allows fill-only pen-to-code fast path when budget is exhausted", async () => {
      config.settings.maxBudgetUsd = 0.001;
      await withStrategy("pen-wins");

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 50_000, output: 10_000 },
      });
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const fillOnlyDiff = [
        { nodeId: "btn1", nodeName: "submitBtn", prop: "fill", oldValue: "#00ff00", newValue: "#ff0000" },
      ];
      // Called once during preflight and again in syncPenToCode.
      mockedDiffPenSnapshots
        .mockReturnValueOnce(fillOnlyDiff)
        .mockReturnValueOnce(fillOnlyDiff);

      const result = await engine.syncMapping(mapping, "pen-changed");
      // No CSS file configured — zero-match returns failure, but Claude should not be called.
      expect(result.success).toBe(false);
      // First sync uses Claude, second fill-only sync should not.
      expect(mockedRunClaude).toHaveBeenCalledTimes(1);
    });

    it("blocks when projected output cost pushes the estimate over budget", async () => {
      // Prompt is tiny (mocked), so input-only cost would clear this budget;
      // only the projected output cost can push it over. This guards against a
      // generation slipping past a check that weighed the prompt alone.
      config.settings.maxBudgetUsd = 0.0001;
      const engine2 = new SyncEngine(config);
      await engine2.initialize();

      // Trigger a code-to-pen sync (code changed, pen unchanged → no conflict).
      await writeFile(join(dir, "code", "app.tsx"), "modified");

      const result = await engine2.syncMapping(mapping, "code-changed");

      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds remaining budget");
      expect(mockedRunClaude).not.toHaveBeenCalled();

      engine2.shutdown();
    });
  });

  describe("non-interactive mode", () => {
    it("skips user prompt and defaults to skip when stdin is not a TTY", async () => {
      // Use "prompt" strategy (default) which triggers askUser
      config.settings.conflictStrategy = "prompt";
      engine = new SyncEngine(config);
      await engine.initialize();

      // Setup conflict
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);
      const beforeSkipState = engine.getStateStore().getMappingState(mapping.id);
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");

      // Mock stdin.isTTY = false (non-interactive)
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      try {
        const result = await engine.syncMapping(mapping, "pen-changed");
        // Should succeed (skip) without hanging on readline
        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.filesChanged).toEqual([]);
        const afterSkipState = engine.getStateStore().getMappingState(mapping.id);
        expect(afterSkipState).toEqual(beforeSkipState);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      }
    });
  });

  describe("executor injection", () => {
    it("propagates its executor to pen-to-code direction (unit)", async () => {
      const fakeExecutor = {
        run: vi.fn().mockResolvedValue({
          success: true, stdout: "done", stderr: "", exitCode: 0,
          tokenUsage: { input: 100, output: 20 },
        }),
      };

      // RED: SyncEngine doesn't accept an executor yet — fakeExecutor.run will not be called
      const injectedEngine = new SyncEngine(config, undefined, fakeExecutor as any);
      await injectedEngine.initialize();

      await injectedEngine.syncMapping(mapping, "pen-changed");

      expect(fakeExecutor.run).toHaveBeenCalled();
      expect(mockedRunClaude).not.toHaveBeenCalled();

      injectedEngine.shutdown();
    });

    it("uses injected executor for auto-merge (unit + state machine: conflict detected → auto-merge → resolved)", async () => {
      const fakeExecutor = {
        run: vi.fn().mockResolvedValue({
          success: true, stdout: "merged", stderr: "", exitCode: 0,
          tokenUsage: { input: 100, output: 50 },
        }),
      };

      config.settings.conflictStrategy = "auto-merge";
      // RED: SyncEngine doesn't accept an executor yet — autoMergeConflict calls runClaude
      const autoEngine = new SyncEngine(config, undefined, fakeExecutor as any);
      await autoEngine.initialize();

      // Initialize state via first sync
      await autoEngine.syncMapping(mapping, "pen-changed");
      autoEngine.getLockManager().forceRelease(mapping.id);

      // Change both files to create conflict
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");

      // Reset counts before the assertion window (auto-merge call only)
      fakeExecutor.run.mockClear();
      mockedRunClaude.mockClear();

      const result = await autoEngine.syncMapping(mapping, "pen-changed");

      expect(fakeExecutor.run).toHaveBeenCalled();
      expect(mockedRunClaude).not.toHaveBeenCalled();
      // State machine: conflict resolved successfully
      expect(result.success).toBe(true);
      expect(result.direction).toBe("both");

      autoEngine.shutdown();
      config.settings.conflictStrategy = "prompt"; // restore
    });

    it("default executor (no injection): SyncEngine still uses runClaude (regression)", async () => {
      // Uses default LocalClaudeExecutor — runClaude must still be called
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(mockedRunClaude).toHaveBeenCalled();
    });

    it("chaos: injected executor failure in auto-merge preserves error path", async () => {
      const failingExecutor = {
        run: vi.fn().mockResolvedValue({
          success: false, stdout: "", stderr: "API overloaded", exitCode: 1,
        }),
      };

      config.settings.conflictStrategy = "auto-merge";
      const autoEngine = new SyncEngine(config, undefined, failingExecutor as any);
      await autoEngine.initialize();

      await autoEngine.syncMapping(mapping, "pen-changed");
      autoEngine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");

      failingExecutor.run.mockClear();
      mockedRunClaude.mockClear();

      const result = await autoEngine.syncMapping(mapping, "pen-changed");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Auto-merge failed");

      autoEngine.shutdown();
      config.settings.conflictStrategy = "prompt"; // restore
    });

    it("SyncEngine(config) with default executor completes full sync flow (E2E smoke)", async () => {
      // No executor injected — proves the default wiring works end to end
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
      expect(result.mappingId).toBe("test");
    });
  });
});

describe("SyncEngine — last-run.json integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-lastrun-engine-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "app.tsx"), "content");
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("integration: syncMapping writes last-run.json after successful sync", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const lastRunPath = join(dir, ".pencil-sync", "last-run.json");

    const localMapping: MappingConfig = {
      id: "lr-test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };

    const localConfig: PencilSyncConfig = {
      version: 1,
      mappings: [localMapping],
      settings: {
        debounceMs: 0,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 1.0,
        conflictStrategy: "pen-wins",
        stateFile,
        logLevel: "error",
      },
    };

    const eng = new SyncEngine(localConfig);
    await eng.initialize();

    const result = await eng.syncMapping(localMapping, "pen-changed");
    expect(result.success).toBe(true);

    const lastRunExists = await access(lastRunPath).then(() => true).catch(() => false);
    expect(lastRunExists).toBe(true);

    eng.shutdown();
  });
});

describe("SyncEngine — onEvent callback", () => {
  let dir: string;
  let mapping: MappingConfig;
  let config: PencilSyncConfig;
  let engine: InstanceType<typeof SyncEngine>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-onevent-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "app.tsx"), "content");
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));

    mapping = {
      id: "m1",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "pen-to-code",
    };

    config = {
      version: 1,
      mappings: [mapping],
      settings: {
        debounceMs: 0,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 10,
        conflictStrategy: "prompt",
        stateFile: join(dir, ".pencil-sync", "state.json"),
        logLevel: "error",
      },
    };

    engine = new SyncEngine(config);
    await engine.initialize();
    mockedRunClaude.mockResolvedValue({ success: true, stdout: "Done", stderr: "", exitCode: 0, tokenUsage: { input: 100, output: 50 } });
  });

  afterEach(async () => {
    engine.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("handler is called with success event after syncMapping completes", async () => {
    const events: Array<{ type: string; success?: boolean; mappingId: string }> = [];
    engine.onEvent((ev) => events.push(ev));

    await engine.syncMapping(mapping, "pen-changed");

    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev.mappingId).toBe("m1");
    expect(ev.success).toBe(true);
  });

  it("handler is called with error event when sync fails", async () => {
    mockedRunClaude.mockResolvedValueOnce({ success: false, stdout: "", stderr: "fail", exitCode: 1, tokenUsage: { input: 0, output: 0 } });
    const events: Array<{ type: string; success?: boolean; mappingId: string }> = [];
    engine.onEvent((ev) => events.push(ev));

    await engine.syncMapping(mapping, "pen-changed");

    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev.mappingId).toBe("m1");
    expect(ev.success).toBe(false);
  });

  it("chaos: handler that throws does not crash syncMapping", async () => {
    engine.onEvent(() => { throw new Error("handler boom"); });

    await expect(engine.syncMapping(mapping, "pen-changed")).resolves.toBeDefined();
  });
});
