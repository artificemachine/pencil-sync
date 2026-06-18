#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setMcpMode } from "./logger.js";

const SERVER_NAME = "pencil-sync";
const SERVER_VERSION = "0.1.5";

export function createMcpServer(): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}

export async function startMcpServer(): Promise<void> {
  setMcpMode(true);
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Self-invoke when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMcpServer().catch((err) => {
    process.stderr.write(`pencil-sync-mcp: fatal error: ${err}\n`);
    process.exit(1);
  });
}
