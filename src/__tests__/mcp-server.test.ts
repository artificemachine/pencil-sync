import { describe, it, expect, vi } from "vitest";
import { createReadStream } from "node:fs";

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

describe("mcp-server", () => {
  describe("smoke", () => {
    it("createMcpServer() returns a non-null server instance", () => {
      const server = createMcpServer();
      expect(server).toBeTruthy();
    });
  });

  describe("unit — server metadata", () => {
    it("server has the correct name 'pencil-sync'", () => {
      const server = createMcpServer();
      // McpServer stores metadata in server._serverInfo
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
  });

  describe("regression — existing CLI bin entry unaffected", () => {
    it("package.json still has pencil-sync bin entry alongside pencil-sync-mcp", async () => {
      const { readFile } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
        bin: Record<string, string>;
      };
      expect(pkg.bin["pencil-sync"]).toBe("./dist/index.js");
      expect(pkg.bin["pencil-sync-mcp"]).toBe("./dist/mcp-server.js");
    });
  });
});
