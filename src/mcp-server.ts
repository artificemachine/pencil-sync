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
import { buildPenToCodePrompt, buildCodeToPenPrompt } from "./prompt-builder.js";
import { applyFillChanges } from "./pen-to-code.js";
import { readFile } from "node:fs/promises";
import { extractErrorMessage } from "./utils.js";
import type { PenDiffEntry, SyncDirection } from "./types.js";

const SERVER_NAME = "pencil-sync";
const SERVER_VERSION = "0.2.0";

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

  const penDiffEntrySchema = z.object({
    nodeId: z.string(),
    nodeName: z.string(),
    prop: z.string(),
    oldValue: z.union([z.string(), z.number()]),
    newValue: z.union([z.string(), z.number()]),
  });

  server.tool(
    "pencil_build_prompt",
    "Build the full sync prompt for a host agent to apply design changes to code (pen-to-code) or code changes to design (code-to-pen).",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping"),
      direction: z.enum(["pen-to-code", "code-to-pen"]).describe("Sync direction"),
      diffs: z.array(penDiffEntrySchema).optional().describe("Design property diffs (for pen-to-code)"),
      changedFiles: z.array(z.string()).optional().describe("Changed code files (for code-to-pen)"),
    },
    async ({ configPath, mappingId, direction, diffs, changedFiles }) => {
      try {
        const { mapping } = await loadConfigAndState(configPath, mappingId);
        let prompt: string;
        if (direction === "pen-to-code") {
          prompt = await buildPenToCodePrompt(mapping, undefined, diffs as PenDiffEntry[] | undefined);
        } else if (direction === "code-to-pen") {
          prompt = await buildCodeToPenPrompt(mapping, changedFiles ?? []);
        } else {
          return err(`Invalid direction: ${String(direction)}. Must be 'pen-to-code' or 'code-to-pen'.`);
        }
        return ok({ prompt, direction, mappingId });
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  server.tool(
    "pencil_apply_fill_changes",
    "Apply deterministic color (fill) changes directly to CSS variable files without needing LLM assistance.",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping"),
      fills: z.array(penDiffEntrySchema).describe("Fill property diffs to apply"),
    },
    async ({ configPath, mappingId, fills }) => {
      try {
        const { mapping } = await loadConfigAndState(configPath, mappingId);
        const fillResult = await applyFillChanges(mapping, fills as PenDiffEntry[]);
        return ok({ filesChanged: fillResult.filesChanged, errors: fillResult.errors });
      } catch (e) {
        return err(extractErrorMessage(e));
      }
    },
  );

  server.tool(
    "pencil_record_sync",
    "Record that a sync has completed by updating the state store with current file hashes. Call this after the host agent has applied all edits.",
    {
      configPath: z.string().describe("Absolute path to pencil-sync.config.json"),
      mappingId: z.string().describe("ID of the mapping"),
      direction: z.enum(["pen-to-code", "code-to-pen", "both"]).describe("The sync direction that was applied"),
      filesChanged: z.array(z.string()).describe("List of files that were changed"),
    },
    async ({ configPath, mappingId, direction, filesChanged }) => {
      try {
        const { mapping, store } = await loadConfigAndState(configPath, mappingId);
        await store.updateMappingState(mapping, direction as SyncDirection);
        return ok({ ok: true, mappingId, direction, filesChanged });
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
