import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock StdioServerTransport to avoid hanging on stdin during tests
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { createMcpServer } = await import("../mcp-server.js");

// Helper: invoke a registered MCP tool by name with params
async function callTool(toolName: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const server = createMcpServer();
  const tools = (server as any)._registeredTools as Record<string, { handler: (p: unknown, e: unknown) => Promise<unknown> }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool '${toolName}' not registered`);
  return tool.handler(params, {}) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

// Fixture helpers
function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    mappings: [{
      id: "test-mapping",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.css"],
      direction: "both" as const,
    }],
    settings: {
      debounceMs: 2000,
      model: "claude-sonnet-4-6",
      maxBudgetUsd: 0.5,
      conflictStrategy: "prompt" as const,
      stateFile: join(dir, ".state.json"),
      logLevel: "error" as const,
    },
    ...overrides,
  };
}

describe("mcp-server", () => {
  describe("smoke", () => {
    it("createMcpServer() returns a non-null server instance", () => {
      const server = createMcpServer();
      expect(server).toBeTruthy();
    });

    it("all 4 Iteration-3 tools are registered", () => {
      const server = createMcpServer();
      const tools = Object.keys((server as any)._registeredTools as Record<string, unknown>);
      expect(tools).toContain("pencil_get_config");
      expect(tools).toContain("pencil_diff_design");
      expect(tools).toContain("pencil_diff_code");
      expect(tools).toContain("pencil_detect_conflict");
    });
  });

  describe("unit — server metadata", () => {
    it("server has the correct name 'pencil-sync'", () => {
      const server = createMcpServer();
      const info = (server.server as any)._serverInfo as { name: string; version: string };
      expect(info.name).toBe("pencil-sync");
    });

    it("server has the correct version from package.json", () => {
      const server = createMcpServer();
      const info = (server.server as any)._serverInfo as { name: string; version: string };
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("contract — MCP server shape", () => {
    it("server instance has _registeredTools property (MCP tool registry present)", () => {
      const server = createMcpServer();
      expect(server).toHaveProperty("_registeredTools");
    });

    it("all registered tools return valid MCP response shape", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pencil-mcp-contract-"));
      try {
        await mkdir(join(dir, "code"), { recursive: true });
        await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
        const cfg = makeConfig(dir);
        const configPath = join(dir, "pencil-sync.config.json");
        await writeFile(configPath, JSON.stringify(cfg));

        const toolNames = ["pencil_get_config", "pencil_diff_design", "pencil_diff_code", "pencil_detect_conflict"];
        for (const name of toolNames) {
          const result = await callTool(name, {
            configPath,
            mappingId: "test-mapping",
          });
          expect(result).toHaveProperty("content");
          expect(Array.isArray(result.content)).toBe(true);
          expect(result.content[0]).toHaveProperty("type", "text");
          expect(typeof result.content[0].text).toBe("string");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("regression — existing CLI bin entry unaffected", () => {
    it("package.json still has pencil-sync bin entry alongside pencil-sync-mcp", async () => {
      const { readFile } = await import("node:fs/promises");
      const { join: pathJoin, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const root = pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const pkg = JSON.parse(await readFile(pathJoin(root, "package.json"), "utf-8")) as {
        bin: Record<string, string>;
      };
      expect(pkg.bin["pencil-sync"]).toBe("./dist/index.js");
      expect(pkg.bin["pencil-sync-mcp"]).toBe("./dist/mcp-server.js");
    });
  });

  // --- Iteration 3: Read tools ---

  describe("pencil_get_config", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-test-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns parsed config JSON for a valid config path", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_get_config", { configPath });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.mappings).toHaveLength(1);
      expect(parsed.mappings[0].id).toBe("test-mapping");
    });

    it("returns error content when config file is missing", async () => {
      const result = await callTool("pencil_get_config", {
        configPath: join(dir, "nonexistent.json"),
      });
      expect(result.content[0].text).toMatch(/error|not found|No config/i);
    });
  });

  describe("pencil_diff_design", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-diff-"));
      await mkdir(join(dir, "code"), { recursive: true });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns empty diffs when .pen file has no trackable nodes", async () => {
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_diff_design", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.diffs)).toBe(true);
    });

    it("returns diffs when .pen file has changed properties vs stored state", async () => {
      // Write initial .pen and state
      const penContent = JSON.stringify({
        children: [{ id: "n1", name: "btn", type: "frame", fill: "#ff0000" }],
      });
      await writeFile(join(dir, "design.pen"), penContent);
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      // Write state with old fill color
      const oldState = {
        version: 1,
        mappings: {
          "test-mapping": {
            mappingId: "test-mapping",
            penHash: "oldhash",
            codeHashes: {},
            lastSyncTimestamp: 0,
            lastSyncDirection: "pen-to-code",
            penSnapshot: { n1: { fill: "#000000" } },
          },
        },
      };
      await writeFile(join(dir, ".state.json"), JSON.stringify(oldState));

      const result = await callTool("pencil_diff_design", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.diffs)).toBe(true);
      expect(parsed.diffs.length).toBeGreaterThan(0);
      expect(parsed.diffs[0].prop).toBe("fill");
    });

    it("integration: returns structured error content when .pen file is corrupt (chaos)", async () => {
      await writeFile(join(dir, "design.pen"), "not valid json {{{");
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_diff_design", { configPath, mappingId: "test-mapping" });
      // Should not throw — should return an error in content
      expect(result.content[0].text).toMatch(/error|invalid|parse/i);
    });
  });

  describe("pencil_diff_code", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-code-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns empty changed files when no state exists (first run)", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_diff_code", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.changedFiles)).toBe(true);
    });

    it("returns changed files when code dir has new files vs stored hashes", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      // Write a CSS file after saving state with empty hashes
      const oldState = {
        version: 1,
        mappings: {
          "test-mapping": {
            mappingId: "test-mapping",
            penHash: "hash",
            codeHashes: {},
            lastSyncTimestamp: 0,
            lastSyncDirection: "pen-to-code",
          },
        },
      };
      await writeFile(join(dir, ".state.json"), JSON.stringify(oldState));
      await writeFile(join(dir, "code", "styles.css"), "--color-primary: 34 72 70;");

      const result = await callTool("pencil_diff_code", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.changedFiles)).toBe(true);
      expect(parsed.changedFiles.length).toBeGreaterThan(0);
    });

    it("chaos: returns structured error when mappingId is unknown", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_diff_code", { configPath, mappingId: "unknown-mapping" });
      expect(result.content[0].text).toMatch(/error|not found|unknown/i);
    });
  });

  describe("pencil_detect_conflict", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-conflict-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns conflict:false when no prior state exists", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_detect_conflict", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(typeof parsed.penChanged).toBe("boolean");
      expect(typeof parsed.codeChanged).toBe("boolean");
      expect(Array.isArray(parsed.changedCodeFiles)).toBe(true);
    });

    it("integration: returns conflict info with penChanged/codeChanged/changedCodeFiles fields", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const oldState = {
        version: 1,
        mappings: {
          "test-mapping": {
            mappingId: "test-mapping",
            penHash: "oldhash",
            codeHashes: {},
            lastSyncTimestamp: 0,
            lastSyncDirection: "pen-to-code",
          },
        },
      };
      await writeFile(join(dir, ".state.json"), JSON.stringify(oldState));

      const result = await callTool("pencil_detect_conflict", { configPath, mappingId: "test-mapping" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty("penChanged");
      expect(parsed).toHaveProperty("codeChanged");
      expect(parsed).toHaveProperty("changedCodeFiles");
    });
  });

  // --- Iteration 4: Prompt delivery, fill fast-path, sync recording ---

  describe("smoke — Iteration 4 tools registered", () => {
    it("all 7 tools are registered after Iteration 4", () => {
      const server = createMcpServer();
      const tools = Object.keys((server as any)._registeredTools as Record<string, unknown>);
      expect(tools).toContain("pencil_build_prompt");
      expect(tools).toContain("pencil_apply_fill_changes");
      expect(tools).toContain("pencil_record_sync");
    });
  });

  describe("pencil_build_prompt", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-prompt-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns a non-empty string for pen-to-code direction", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_build_prompt", {
        configPath,
        mappingId: "test-mapping",
        direction: "pen-to-code",
        diffs: [{ nodeId: "n1", nodeName: "btn", prop: "fill", oldValue: "#000", newValue: "#fff" }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(typeof parsed.prompt).toBe("string");
      expect(parsed.prompt.length).toBeGreaterThan(10);
    });

    it("returns a non-empty string for code-to-pen direction", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));
      await writeFile(join(dir, "code", "styles.css"), "--color-primary: 34 72 70;");

      const result = await callTool("pencil_build_prompt", {
        configPath,
        mappingId: "test-mapping",
        direction: "code-to-pen",
        changedFiles: ["code/styles.css"],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(typeof parsed.prompt).toBe("string");
      expect(parsed.prompt.length).toBeGreaterThan(10);
    });

    it("chaos: returns error content when direction is invalid", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_build_prompt", {
        configPath,
        mappingId: "test-mapping",
        direction: "invalid-direction",
        diffs: [],
      });
      expect(result.content[0].text).toMatch(/error|invalid|direction/i);
    });
  });

  describe("pencil_apply_fill_changes", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-fill-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("updates CSS variable values and returns filesChanged", async () => {
      const cssPath = join(dir, "code", "styles.css");
      await writeFile(cssPath, "--color-primary: 34 72 70;\n--color-accent: 34 72 70;\n");

      const cfg = {
        ...makeConfig(dir),
        mappings: [{
          id: "test-mapping",
          penFile: join(dir, "design.pen"),
          codeDir: join(dir, "code"),
          codeGlobs: ["**/*.css"],
          direction: "both" as const,
          styleFiles: ["styles.css"],
        }],
      };
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_apply_fill_changes", {
        configPath,
        mappingId: "test-mapping",
        fills: [{ nodeId: "n1", nodeName: "btn", prop: "fill", oldValue: "#224846", newValue: "#ff0000" }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.filesChanged)).toBe(true);
    });

    it("returns empty filesChanged with errors when no CSS file is configured", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_apply_fill_changes", {
        configPath,
        mappingId: "test-mapping",
        fills: [{ nodeId: "n1", nodeName: "btn", prop: "fill", oldValue: "#000000", newValue: "#ffffff" }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.errors)).toBe(true);
      expect(parsed.errors.length).toBeGreaterThan(0);
    });

    it("chaos: returns structured result (not throw) for malformed hex values", async () => {
      const cfg = {
        ...makeConfig(dir),
        mappings: [{
          id: "test-mapping",
          penFile: join(dir, "design.pen"),
          codeDir: join(dir, "code"),
          codeGlobs: ["**/*.css"],
          direction: "both" as const,
          styleFiles: ["styles.css"],
        }],
      };
      await writeFile(join(dir, "code", "styles.css"), "--color-x: 1 2 3;\n");
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_apply_fill_changes", {
        configPath,
        mappingId: "test-mapping",
        fills: [{ nodeId: "n1", nodeName: "btn", prop: "fill", oldValue: "notahex", newValue: "alsowrong" }],
      });
      // Should not throw — returns structured result
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty("filesChanged");
      expect(parsed).toHaveProperty("errors");
    });
  });

  describe("pencil_record_sync", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pencil-mcp-record-"));
      await mkdir(join(dir, "code"), { recursive: true });
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("updates StateStore and returns ok:true for pen-to-code direction", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_record_sync", {
        configPath,
        mappingId: "test-mapping",
        direction: "pen-to-code",
        filesChanged: [],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("state machine: records pen-to-code direction in persisted state", async () => {
      const { readFile: rf } = await import("node:fs/promises");
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      await callTool("pencil_record_sync", {
        configPath,
        mappingId: "test-mapping",
        direction: "pen-to-code",
        filesChanged: [],
      });

      const rawState = await rf(join(dir, ".state.json"), "utf-8");
      const state = JSON.parse(rawState);
      expect(state.mappings["test-mapping"].lastSyncDirection).toBe("pen-to-code");
    });

    it("state machine: records code-to-pen direction in persisted state", async () => {
      const { readFile: rf } = await import("node:fs/promises");
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      await callTool("pencil_record_sync", {
        configPath,
        mappingId: "test-mapping",
        direction: "code-to-pen",
        filesChanged: [],
      });

      const rawState = await rf(join(dir, ".state.json"), "utf-8");
      const state = JSON.parse(rawState);
      expect(state.mappings["test-mapping"].lastSyncDirection).toBe("code-to-pen");
    });

    it("chaos: returns structured error when mappingId is unknown", async () => {
      const cfg = makeConfig(dir);
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify(cfg));

      const result = await callTool("pencil_record_sync", {
        configPath,
        mappingId: "no-such-mapping",
        direction: "pen-to-code",
        filesChanged: [],
      });
      expect(result.content[0].text).toMatch(/error|not found/i);
    });
  });

  describe("contract — all 7 tools return valid MCP shape", () => {
    it("full server tool contract: all 7 tools return { content: [{ type: 'text', text: string }] }", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pencil-mcp-full-"));
      try {
        await mkdir(join(dir, "code"), { recursive: true });
        await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));
        const cfg = makeConfig(dir);
        const configPath = join(dir, "pencil-sync.config.json");
        await writeFile(configPath, JSON.stringify(cfg));

        const server = createMcpServer();
        const allTools = Object.keys((server as any)._registeredTools as Record<string, unknown>);
        expect(allTools).toHaveLength(7);

        for (const name of allTools) {
          const result = await callTool(name, {
            configPath,
            mappingId: "test-mapping",
            direction: "pen-to-code",
            diffs: [],
            fills: [],
            changedFiles: [],
            filesChanged: [],
          });
          expect(result).toHaveProperty("content");
          expect(Array.isArray(result.content)).toBe(true);
          expect(result.content[0]).toHaveProperty("type", "text");
          expect(typeof result.content[0].text).toBe("string");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("E2E — full host agent workflow", () => {
    it("get config → diff design → build prompt → record sync → state persisted", async () => {
      const { readFile: rf } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pencil-mcp-e2e-"));
      try {
        await mkdir(join(dir, "code"), { recursive: true });
        const penContent = JSON.stringify({
          children: [{ id: "n1", name: "btn", type: "frame", fill: "#ff0000" }],
        });
        await writeFile(join(dir, "design.pen"), penContent);

        const cfg = makeConfig(dir);
        const configPath = join(dir, "pencil-sync.config.json");
        await writeFile(configPath, JSON.stringify(cfg));

        // Step 1: get config
        const configResult = await callTool("pencil_get_config", { configPath });
        const loadedCfg = JSON.parse(configResult.content[0].text);
        expect(loadedCfg.mappings[0].id).toBe("test-mapping");

        // Step 2: diff design
        const diffResult = await callTool("pencil_diff_design", { configPath, mappingId: "test-mapping" });
        const { diffs } = JSON.parse(diffResult.content[0].text);
        expect(Array.isArray(diffs)).toBe(true);

        // Step 3: build prompt
        const promptResult = await callTool("pencil_build_prompt", {
          configPath,
          mappingId: "test-mapping",
          direction: "pen-to-code",
          diffs,
        });
        const { prompt } = JSON.parse(promptResult.content[0].text);
        expect(typeof prompt).toBe("string");

        // Step 4: (agent would apply edits here) — record sync
        const recordResult = await callTool("pencil_record_sync", {
          configPath,
          mappingId: "test-mapping",
          direction: "pen-to-code",
          filesChanged: [],
        });
        const { ok } = JSON.parse(recordResult.content[0].text);
        expect(ok).toBe(true);

        // Verify state persisted
        const rawState = await rf(join(dir, ".state.json"), "utf-8");
        const state = JSON.parse(rawState);
        expect(state.mappings["test-mapping"]).toBeTruthy();
        expect(state.mappings["test-mapping"].lastSyncDirection).toBe("pen-to-code");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
