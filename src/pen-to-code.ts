import { readFile, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import { type Executor, localClaudeExecutor } from "./executor.js";
import { buildPenToCodePrompt } from "./prompt-builder.js";
import { snapshotPenFile, diffPenSnapshots } from "./pen-snapshot.js";
import { getCssStyleFile, validatePathWithin } from "./utils.js";
import type { PenDiffEntry, FillChangeResult, MappingConfig, Settings, SyncResult, MappingState, PenNodeSnapshot } from "./types.js";
import { hashCodeDir, diffHashes } from "./state-store.js";

/**
 * Convert a hex color (#RRGGBB, #RRGGBBAA, or shorthand #RGB/#RGBA) to space-separated RGB channels.
 * Returns e.g. "34 72 70" for "#224846", or "" if invalid.
 */
function hexToRgbChannels(hex: string): string {
  let clean = hex.replace(/^#/, "");

  // Expand shorthand: #RGB → #RRGGBB, #RGBA → #RRGGBBAA
  if (clean.length === 3 || clean.length === 4) {
    clean = clean.split("").map(c => c + c).join("");
  }

  // Take first 6 chars (ignore alpha if present)
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "";
  return `${r} ${g} ${b}`;
}

function recordError(result: FillChangeResult, msg: string, level: "warn" | "error" = "warn"): void {
  result.errors.push(msg);
  log[level](msg);
}

/**
 * Apply fill (color) changes directly to CSS files by replacing variable values.
 * This is a deterministic fast path that doesn't need Claude CLI.
 *
 * Strategy: For each fill change, find all CSS variable declarations whose value
 * matches the OLD RGB and replace with the NEW RGB. This updates ALL theme blocks.
 *
 * Returns structured FillChangeResult with both filesChanged and errors.
 */
export async function applyFillChanges(
  mapping: MappingConfig,
  fillDiffs: PenDiffEntry[],
): Promise<FillChangeResult> {
  const result: FillChangeResult = { filesChanged: [], errors: [] };

  const cssFile = getCssStyleFile(mapping);
  if (!cssFile) {
    recordError(result, "No CSS file in styleFiles — cannot apply fill changes directly");
    return result;
  }

  let cssPath: string;
  try {
    cssPath = validatePathWithin(mapping.codeDir, cssFile);
  } catch (err) {
    recordError(result, `Invalid CSS file path: ${err}`);
    return result;
  }

  let css: string;
  try {
    css = await readFile(cssPath, "utf-8");
  } catch (err) {
    recordError(result, `Failed to read CSS file ${cssPath}: ${err}`, "error");
    return result;
  }

  let modified = false;

  for (const diff of fillDiffs) {
    const oldRgb = hexToRgbChannels(String(diff.oldValue));
    const newRgb = hexToRgbChannels(String(diff.newValue));

    if (!oldRgb || !newRgb) {
      recordError(result, `Could not convert hex values for ${diff.nodeName}.fill: ${diff.oldValue} → ${diff.newValue}`);
      continue;
    }

    if (oldRgb === newRgb) continue;

    // Replace ALL occurrences of the old RGB value in CSS variable declarations.
    // Pattern: "--color-SOMETHING: <oldRgb>;" → "--color-SOMETHING: <newRgb>;"
    // This catches the value in :root, [data-theme="monokai"], [data-theme="nord"], etc.
    const pattern = new RegExp(
      `(--color-[\\w-]+:\\s*)${escapeRegex(oldRgb)}(\\s*;)`,
      "g",
    );

    // Detect color collision — multiple distinct variable names sharing the same RGB value
    const allMatches = [...css.matchAll(pattern)];
    const matchedVarNames = new Set(
      allMatches.map(m => {
        const varDecl = m[1].trim();
        return varDecl.replace(/:\s*$/, "");
      }),
    );

    if (matchedVarNames.size > 1) {
      log.warn(
        `Color collision: RGB "${oldRgb}" matches ${matchedVarNames.size} different variables: ${[...matchedVarNames].join(", ")}. All will be replaced with "${newRgb}".`,
      );
    }

    const newCss = css.replace(pattern, `$1${newRgb}$2`);

    if (newCss !== css) {
      const matchCount = allMatches.length;
      const varList = [...matchedVarNames].join(", ");
      log.info(`  ✓ ${diff.nodeName}.fill: replaced "${oldRgb}" → "${newRgb}" in ${matchCount} declaration(s) [${varList}]`);
      css = newCss;
      modified = true;
    } else {
      recordError(result, `${diff.nodeName}.fill: old RGB "${oldRgb}" not found in ${cssFile}`);
    }
  }

  if (modified) {
    await writeFile(cssPath, css);
    log.success(`Updated ${cssFile} with color changes`);
    result.filesChanged.push(cssFile);
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True for scalar hex (#rrggbb, #rgb) or rgb(...) strings — fast-path eligible. */
function isScalarColorValue(val: string | number): boolean {
  if (typeof val === "number") return false;
  const s = val.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) || /^rgb\(/.test(s);
}

/** Apply fill changes directly and return the full FillChangeResult. */
async function executeFillFastPath(
  mapping: MappingConfig,
  fillDiffs: PenDiffEntry[],
): Promise<FillChangeResult> {
  log.info(`Applying ${fillDiffs.length} color change(s) directly (no Claude CLI needed)`);
  return applyFillChanges(mapping, fillDiffs);
}

/** Delegate non-fill changes to the executor. Returns changed files or a partial-failure result. */
async function executeClaudeSync(
  mapping: MappingConfig,
  settings: Settings,
  otherDiffs: PenDiffEntry[],
  priorFilesChanged: string[],
  penSnapshot: PenNodeSnapshot,
  executor: Executor = localClaudeExecutor,
): Promise<SyncResult> {
  log.info(`Sending ${otherDiffs.length} non-color change(s) to Claude CLI`);

  const beforeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
  const prompt = await buildPenToCodePrompt(mapping, undefined, otherDiffs);
  log.debug(`Prompt length: ${prompt.length} chars`);

  const result = await executor.run({
    prompt,
    model: settings.model,
    cwd: mapping.codeDir,
  });

  if (!result.success) {
    const errorPrefix = result.mcpError
      ? `Claude sync failed (MCP error: ${result.mcpError})`
      : "Claude sync failed for non-color changes";
    log.error(`${errorPrefix}: ${result.stderr.slice(0, 200)}`);
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: priorFilesChanged,
      error: `Claude CLI failed for text/typography changes: ${result.stderr.slice(0, 300)}`,
      tokenUsage: result.tokenUsage,
      penSnapshot,
    };
  }

  const afterHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
  const claudeFiles = diffHashes(beforeHashes, afterHashes);
  const fileSet = new Set<string>(priorFilesChanged);
  for (const f of claudeFiles) fileSet.add(f);
  const allFiles = Array.from(fileSet);

  log.success(`Pen-to-code sync complete: ${allFiles.length} file(s) updated`);

  return {
    success: true,
    direction: "pen-to-code",
    mappingId: mapping.id,
    filesChanged: allFiles,
    tokenUsage: result.tokenUsage,
    penSnapshot,
  };
}

export async function syncPenToCode(
  mapping: MappingConfig,
  settings: Settings,
  previousState?: MappingState,
  dryRun = false,
  executor: Executor = localClaudeExecutor,
): Promise<SyncResult> {
  log.sync("pen-to-code", mapping.id, "Starting design → code sync");

  let penRaw: string;
  try {
    penRaw = await readFile(mapping.penFile, "utf-8");
  } catch (err) {
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      error: `Failed to read .pen file: ${err}`,
    };
  }

  const snapshot = snapshotPenFile(mapping.penFile, penRaw);
  const oldSnapshot = previousState?.penSnapshot ?? {};

  // null = parse failure (corruption); {} = valid file with no tracked nodes
  if (snapshot === null) {
    log.warn("Pen file could not be parsed — preserving previous state");
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      error: "Pen file contains invalid JSON",
      penSnapshot: oldSnapshot,
    };
  }

  const diffs = diffPenSnapshots(oldSnapshot, snapshot);

  if (diffs.length === 0 && Object.keys(oldSnapshot).length > 0) {
    log.info("No visual property changes detected in .pen file, skipping sync");
    return {
      success: true,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      penSnapshot: snapshot,
    };
  }

  log.info(`Detected ${diffs.length} property change(s) in .pen design`);
  for (const d of diffs) {
    log.info(`  ${d.nodeName}.${d.prop}: ${d.oldValue} → ${d.newValue}`);
  }

  // Fast-path only handles scalar hex/rgb fills. Complex fills (gradients,
  // images, fill arrays stored as canonical JSON strings) route to Claude.
  const fillDiffs = diffs.filter((d) => d.prop === "fill" && isScalarColorValue(d.newValue) && isScalarColorValue(d.oldValue));
  const otherDiffs = diffs.filter((d) => d.prop !== "fill" || !isScalarColorValue(d.newValue) || !isScalarColorValue(d.oldValue));

  if (dryRun) {
    const wouldChange: string[] = [];
    const cssFile = getCssStyleFile(mapping);
    if (fillDiffs.length > 0 && cssFile) wouldChange.push(cssFile);
    if (otherDiffs.length > 0) {
      log.info(`[dry-run] Would send ${otherDiffs.length} non-color change(s) to Claude CLI`);
    }
    log.info(`[dry-run] Would change ${wouldChange.length} file(s): ${wouldChange.join(", ") || "(none)"}`);
    return {
      success: true,
      dryRun: true,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: wouldChange,
      penSnapshot: snapshot,
    };
  }

  let fillFilesChanged: string[] = [];
  let fillWarnings: string[] = [];

  if (fillDiffs.length > 0) {
    const fillResult = await executeFillFastPath(mapping, fillDiffs);
    fillFilesChanged = fillResult.filesChanged;
    fillWarnings = fillResult.errors;

    for (const w of fillWarnings) {
      log.warn(`Fill change issue: ${w}`);
    }

    // Zero-match with no other work = failure
    if (fillFilesChanged.length === 0 && otherDiffs.length === 0) {
      return {
        success: false,
        direction: "pen-to-code",
        mappingId: mapping.id,
        filesChanged: [],
        error: `Color fast-path matched zero CSS declarations. Unmatched fill change(s): ${fillWarnings.join("; ") || "no CSS variable found for the changed fill"}`,
        penSnapshot: snapshot,
      };
    }
  }

  if (otherDiffs.length > 0) {
    return executeClaudeSync(mapping, settings, otherDiffs, fillFilesChanged, snapshot, executor);
  }

  const uniqueFiles = [...new Set(fillFilesChanged)];
  log.success(`Pen-to-code sync complete (fast path): ${uniqueFiles.length} file(s) updated`);

  return {
    success: true,
    direction: "pen-to-code",
    mappingId: mapping.id,
    filesChanged: uniqueFiles,
    ...(fillWarnings.length > 0 ? { warnings: fillWarnings } : {}),
    penSnapshot: snapshot,
  };
}
