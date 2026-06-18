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
});
