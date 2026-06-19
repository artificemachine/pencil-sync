import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { type Executor, localClaudeExecutor } from "./executor.js";
import { buildCodeToPenPrompt } from "./prompt-builder.js";
import { hashFile } from "./state-store.js";
import type { PenReader } from "./pen-reader.js";
import { JsonPenReader } from "./pen-reader.js";
import type { MappingConfig, Settings, SyncResult } from "./types.js";
import { createRunner } from "./ai/factory.js";
import { PencilMcpClient } from "./pencil-mcp-client.js";

const defaultPenReader = new JsonPenReader();

export async function syncCodeToPen(
  mapping: MappingConfig,
  settings: Settings,
  changedFiles: string[],
  penReader: PenReader = defaultPenReader,
  dryRun = false,
  executor: Executor = localClaudeExecutor,
): Promise<SyncResult> {
  log.sync("code-to-pen", mapping.id, `Starting code → design sync (${changedFiles.length} files changed)`);

  if (changedFiles.length === 0) {
    log.info("No changed code files to sync");
    return {
      success: true,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
    };
  }

  if (dryRun) {
    log.info(`[dry-run] Would sync ${changedFiles.length} code file(s) → .pen design`);
    log.info(`[dry-run] Would change: ${mapping.penFile}`);
    return {
      success: true,
      dryRun: true,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [mapping.penFile],
    };
  }

  // Resolve engine: explicit provider field wins; fall back to legacy inference
  const useApi =
    settings.provider !== "claude-cli" &&
    (settings.provider != null ? settings.provider : settings.aiProvider) != null;

  if (useApi) {
    const engine = settings.provider ?? settings.aiProvider;
    log.info(`Engine: ${engine} API (model: ${settings.model})`);
    return syncCodeToPenDirect(mapping, settings, changedFiles, penReader);
  }

  // Executor path — spawns local claude CLI, uses subscription auth ($0)
  log.info(`Engine: claude-cli (model: ${settings.model})`);
  return syncCodeToPenViaExecutor(mapping, settings, changedFiles, penReader, executor);
}

async function syncCodeToPenDirect(
  mapping: MappingConfig,
  settings: Settings,
  changedFiles: string[],
  penReader: PenReader,
): Promise<SyncResult> {
  if (!settings.mcpConfigPath) {
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error: "settings.mcpConfigPath is required when aiProvider is set",
    };
  }

  let runner;
  try {
    runner = await createRunner(settings);
  } catch (err) {
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error: `Failed to create AI runner: ${err}`,
    };
  }

  const pencilClient = new PencilMcpClient(settings.mcpConfigPath);

  try {
    await pencilClient.connect();

    // Fetch current design state to give the AI context
    const currentState = await pencilClient.batchGet(mapping.penScreens);
    const stateJson = JSON.stringify(currentState, null, 2);

    const basePrompt = await buildCodeToPenPrompt(mapping, changedFiles);
    const prompt = `${basePrompt}\n\n## Current Design Node State\n\`\`\`json\n${stateJson}\n\`\`\`\n\nReturn ONLY the batch_design JavaScript snippet — no explanation, no markdown outside the code.`;

    log.debug(`Calling ${settings.aiProvider} API (model: ${settings.model})...`);

    const { text, usage } = await runner.complete(prompt, {
      model: settings.model,
      maxTokens: 4096,
      systemPrompt:
        "You are a design-sync assistant for Pencil.dev. " +
        "Given code changes and the current design node state, produce a batch_design JavaScript snippet " +
        "that updates the .pen file to match the code. Use Insert(), Update(), Replace(), Delete(), Move(). " +
        "Return only the JavaScript — no markdown fences, no explanation.",
    });

    if (usage) {
      const costUsd = runner.estimateCost(usage);
      log.debug(`Token usage: ${usage.input} in / ${usage.output} out (API-rate estimate: ~$${costUsd.toFixed(4)})`);
      if (costUsd > settings.maxBudgetUsd) {
        log.warn(`Estimated API cost $${costUsd.toFixed(4)} exceeds budget $${settings.maxBudgetUsd} — this is an API-rate estimate; actual billing depends on your plan`);
      }
    }

    const script = extractScript(text);
    if (!script) {
      return {
        success: false,
        direction: "code-to-pen",
        mappingId: mapping.id,
        filesChanged: [],
        error: "AI returned an empty script",
        tokenUsage: usage,
      };
    }

    const beforeHash = await hashFile(mapping.penFile);
    await pencilClient.batchDesign(script);

    // Brief wait for Pencil to flush the file write
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    let penChanged = false;
    let penSnapshot;
    try {
      const penRaw = await readFile(mapping.penFile, "utf-8");
      const afterHash = createHash("sha256").update(penRaw).digest("hex");
      penChanged = beforeHash !== afterHash;
      penSnapshot = await penReader.readSnapshot(mapping.penFile) ?? undefined;
    } catch {
      log.warn("Could not read .pen file after batch_design — design may still have been updated");
    }

    log.success(`Code-to-pen sync complete for ${mapping.id} (${settings.aiProvider})`);

    return {
      success: true,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: penChanged ? [mapping.penFile] : [],
      tokenUsage: usage,
      penSnapshot,
    };
  } catch (err) {
    const error = `Direct AI sync failed for ${mapping.id}: ${err}`;
    log.error(error);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error,
    };
  } finally {
    await pencilClient.disconnect();
  }
}

async function syncCodeToPenViaExecutor(
  mapping: MappingConfig,
  settings: Settings,
  changedFiles: string[],
  penReader: PenReader,
  executor: Executor,
): Promise<SyncResult> {
  const beforeHash = await hashFile(mapping.penFile);

  const prompt = await buildCodeToPenPrompt(mapping, changedFiles);
  log.debug(`Prompt length: ${prompt.length} chars`);

  const result = await executor.run({
    prompt,
    model: settings.model,
    cwd: mapping.codeDir,
    ...(settings.mcpConfigPath && {
      allowedTools: "Edit,Write,Read,Glob,Grep,mcp__pencil__batch_get,mcp__pencil__batch_design,mcp__pencil__set_variables,mcp__pencil__get_screenshot",
      mcpConfigPath: settings.mcpConfigPath,
    }),
  });

  if (!result.success) {
    const errorPrefix = result.mcpError
      ? `Code-to-pen sync failed (MCP error: ${result.mcpError}) for ${mapping.id}`
      : `Code-to-pen sync failed for ${mapping.id}`;
    log.error(`${errorPrefix}: ${result.stderr.slice(0, 200)}`);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error: result.stderr.slice(0, 500),
      tokenUsage: result.tokenUsage,
    };
  }

  let penChanged: boolean;
  let penSnapshot;
  try {
    const penRaw = await readFile(mapping.penFile, "utf-8");
    const afterHash = createHash("sha256").update(penRaw).digest("hex");
    penChanged = beforeHash !== afterHash;
    const snapshot = await penReader.readSnapshot(mapping.penFile);
    if (snapshot === null) {
      log.error("Pen file could not be parsed after sync");
      return {
        success: false,
        direction: "code-to-pen",
        mappingId: mapping.id,
        filesChanged: penChanged ? [mapping.penFile] : [],
        error: "Pen file contains invalid JSON after code-to-pen sync",
        tokenUsage: result.tokenUsage,
      };
    } else {
      penSnapshot = snapshot;
    }
  } catch (err) {
    const error = `Failed to read .pen file after code-to-pen sync: ${err}`;
    log.error(error);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error,
      tokenUsage: result.tokenUsage,
    };
  }

  log.success(`Code-to-pen sync complete for ${mapping.id}`);

  return {
    success: true,
    direction: "code-to-pen",
    mappingId: mapping.id,
    filesChanged: penChanged ? [mapping.penFile] : [],
    tokenUsage: result.tokenUsage,
    penSnapshot,
  };
}

function extractScript(text: string): string {
  // Strip ```js ... ``` or ``` ... ``` code fences if present
  const fenced = text.match(/```(?:js|javascript|typescript)?\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : text).trim();
}
