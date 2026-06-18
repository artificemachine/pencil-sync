#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setMcpMode } from "./logger.js";
import { loadConfig } from "./config.js";
import { StateStore, hashCodeDir, diffHashes } from "./state-store.js";
import { detectConflict } from "./conflict-detector.js";
import { snapshotPenFile, diffPenSnapshots } from "./pen-snapshot.js";
import { readFile } from "node:fs/promises";
import { extractErrorMessage } from "./utils.js";

const SERVER_NAME = "pencil-sync";
const SERVER_VERSION = "0.1.5";

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

async function loadConfigAndState(configPath: string, mappingId: string) {
  const config = await loadConfig(configPath);
  const mapping = config.mappings.find((m) => m.id === mappingId);
  if (!mapping) throw new Error(`Mapping '${mappingId}' not found in config`);
  const store = new StateStore(config.settings.stateFile);
  await store.load();
  const previousState = store.getMappingState(mappingId);
  return { config, mapping, store, previousState };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "pencil_get_config",
    "Load and return the pencil-sync configuration for the given config file path.",
    { configPath: z.string().describe("Absolute path to pencil-sync.config.json") },
    async ({ configPath }) => {
      try {
        const config = await loadConfig(configPath);
        return ok(config);
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  server.tool(
    "pencil_diff_design",
    "Diff the current .pen file snapshot against the last synced state for a mapping. Returns the list of changed design properties.",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping to diff"),
    },
    async ({ configPath, mappingId }) => {
      try {
        const { mapping, previousState } = await loadConfigAndState(configPath, mappingId);
        const penRaw = await readFile(mapping.penFile, "utf-8");
        const snapshot = snapshotPenFile(mapping.penFile, penRaw);
        if (snapshot === null) {
          return err("Pen file contains invalid JSON — cannot parse design snapshot");
        }
        const oldSnapshot = previousState?.penSnapshot ?? {};
        const diffs = diffPenSnapshots(oldSnapshot, snapshot);
        return ok({ diffs, mappingId });
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  server.tool(
    "pencil_diff_code",
    "Diff the current code directory file hashes against the last synced state for a mapping. Returns the list of changed code files.",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping to diff"),
    },
    async ({ configPath, mappingId }) => {
      try {
        const { mapping, previousState } = await loadConfigAndState(configPath, mappingId);
        const currentHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
        const storedHashes = previousState?.codeHashes ?? {};
        const changedFiles = diffHashes(storedHashes, currentHashes);
        return ok({ changedFiles, mappingId });
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  server.tool(
    "pencil_detect_conflict",
    "Detect whether both the .pen file and code files have changed since the last sync for a mapping.",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping to check"),
    },
    async ({ configPath, mappingId }) => {
      try {
        const { mapping, previousState } = await loadConfigAndState(configPath, mappingId);
        const conflictInfo = await detectConflict(mapping, previousState);
        return ok(conflictInfo);
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  return server;
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
