import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockCallTool, MockClient, MockStdioTransport } = vi.hoisted(() => {
  const mockCallTool = vi.fn();
  const MockClient = vi.fn(function (this: Record<string, unknown>) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.callTool = mockCallTool;
  });
  const MockStdioTransport = vi.fn();
  return { mockCallTool, MockClient, MockStdioTransport };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}));

const { PencilMcpClient } = await import("../pencil-mcp-client.js");

describe("PencilMcpClient — Iteration 3 error propagation", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-mcp-client-"));
    configPath = join(dir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { pencil: { command: "echo", args: [] } } }),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("smoke", () => {
    it("PencilMcpClient constructs without throwing", () => {
      expect(() => new PencilMcpClient(configPath)).not.toThrow();
    });

    it("batchDesign resolves on success", async () => {
      mockCallTool.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      const client = new PencilMcpClient(configPath);
      await client.connect();
      await expect(client.batchDesign("Insert()")).resolves.toBeUndefined();
    });
  });

  describe("unit — isError propagation", () => {
    it("batchDesign throws on isError result", async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "Error: element not found" }],
        isError: true,
      });

      const client = new PencilMcpClient(configPath);
      await client.connect();

      await expect(client.batchDesign("invalid script")).rejects.toThrow(/batch_design failed/);
    });

    it("batchGet throws on isError instead of returning empty state", async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "Error: permission denied" }],
        isError: true,
      });

      const client = new PencilMcpClient(configPath);
      await client.connect();

      await expect(client.batchGet()).rejects.toThrow(/batch_get failed/);
    });
  });

  describe("contract — isError is the failure signal", () => {
    it("batchGet with isError: true must throw, not return {}", async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "gone" }],
        isError: true,
      });
      const client = new PencilMcpClient(configPath);
      await client.connect();
      await expect(client.batchGet(["screen1"])).rejects.toThrow();
    });

    it("batchDesign with no isError (or isError: false) does not throw", async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "success" }],
        isError: false,
      });
      const client = new PencilMcpClient(configPath);
      await client.connect();
      await expect(client.batchDesign("Update()")).resolves.toBeUndefined();
    });
  });

  describe("chaos — non-JSON batchGet", () => {
    it("batchGet with non-JSON text throws instead of returning {}", async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "not json at all" }],
      });
      const client = new PencilMcpClient(configPath);
      await client.connect();
      await expect(client.batchGet()).rejects.toThrow();
    });
  });
});
