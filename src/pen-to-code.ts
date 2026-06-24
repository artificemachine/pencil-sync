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
function hexToRgbChannels(color: string): string {
  const s = color.trim();

  // rgb()/rgba() form, e.g. "rgb(34, 72, 70)" or "rgba(34,72,70,0.5)".
  // isScalarColorValue admits these, so the converter must handle them too —
  // otherwise they pass the fast-path gate and are silently dropped.
  const rgbMatch = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgbMatch) {
    const [r, g, b] = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((n) => parseInt(n, 10));
    if ([r, g, b].some((n) => n > 255)) return "";
    return `${r} ${g} ${b}`;
  }

  let clean = s.replace(/^#/, "");

  // Expand shorthand: #RGB → #RRGGBB, #RGBA → #RRGGBBAA
  if (clean.length === 3 || clean.length === 4) {
    clean = clean.split("").map(c => c + c).join("");
  }

  // Only full 6- or 8-digit hex is valid after expansion. Reject other lengths
  // (e.g. 5- or 7-digit) instead of letting parseInt silently coerce a wrong RGB.
  if ((clean.length !== 6 && clean.length !== 8) || !/^[0-9a-fA-F]+$/.test(clean)) {
    return "";
  }

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

  // Build a replacement map keyed on the ORIGINAL RGB channels, then apply it in a
  // single pass. Sequential per-diff replacement cascades — one diff's output can
  // become another diff's input (A:#224846→#333333 then B:#333333→#444444 would
  // double-apply). A single keyed pass over the original CSS prevents that.
  const rgbMap = new Map<string, string>();
  const diffByOld = new Map<string, PenDiffEntry>();
  for (const diff of fillDiffs) {
    const oldRgb = hexToRgbChannels(String(diff.oldValue));
    const newRgb = hexToRgbChannels(String(diff.newValue));

    if (!oldRgb || !newRgb) {
      recordError(result, `Could not convert hex values for ${diff.nodeName}.fill: ${diff.oldValue} → ${diff.newValue}`);
      continue;
    }
    if (oldRgb === newRgb) continue;

    const prior = rgbMap.get(oldRgb);
    if (prior !== undefined && prior !== newRgb) {
      recordError(result, `Conflicting fill changes both target RGB "${oldRgb}" (${prior} vs ${newRgb}); keeping the first.`);
      continue;
    }
    rgbMap.set(oldRgb, newRgb);
    diffByOld.set(oldRgb, diff);
  }

  if (rgbMap.size > 0) {
    // Match "--color-NAME: <r> <g> <b>;" across every theme block (:root, [data-theme=...]).
    const pattern = /(--color-[\w-]+:\s*)(\d{1,3} \d{1,3} \d{1,3})(\s*;)/g;
    const matched = new Set<string>();
    const newCss = css.replace(pattern, (full, prefix: string, channels: string, suffix: string) => {
      const repl = rgbMap.get(channels);
      if (repl === undefined) return full;
      matched.add(channels);
      return `${prefix}${repl}${suffix}`;
    });

    if (newCss !== css) {
      css = newCss;
      modified = true;
    }

    for (const [oldRgb, newRgb] of rgbMap) {
      const name = diffByOld.get(oldRgb)?.nodeName ?? "fill";
      if (matched.has(oldRgb)) {
        log.info(`  ✓ ${name}.fill: replaced "${oldRgb}" → "${newRgb}"`);
      } else {
        recordError(result, `${name}.fill: old RGB "${oldRgb}" not found in ${cssFile}`);
      }
    }
  }

  if (modified) {
    await writeFile(cssPath, css);
    log.success(`Updated ${cssFile} with color changes`);
    result.filesChanged.push(cssFile);
  }

  return result;
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
  priorWarnings: string[] = [],
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

  if (claudeFiles.length === 0) {
    log.warn("Claude exited successfully but changed no files");
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: priorFilesChanged,
      error: "Claude CLI reported success but made no file changes despite pending diffs",
      tokenUsage: result.tokenUsage,
      penSnapshot,
    };
  }

  const fileSet = new Set<string>(priorFilesChanged);
  for (const f of claudeFiles) fileSet.add(f);
  const allFiles = Array.from(fileSet);

  log.success(`Pen-to-code sync complete: ${allFiles.length} file(s) updated`);

  return {
    success: true,
    direction: "pen-to-code",
    mappingId: mapping.id,
    filesChanged: allFiles,
    ...(priorWarnings.length > 0 ? { warnings: priorWarnings } : {}),
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

  // pen-to-code only drives the local claude CLI. If settings.provider is explicitly
  // set to a hosted API provider, return a clear error rather than silently spawning claude.
  if (settings.provider != null && settings.provider !== "claude-cli") {
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      error: `pen-to-code does not support provider '${settings.provider}'. Only 'claude-cli' is supported for design → code sync.`,
    };
  }

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
    return executeClaudeSync(mapping, settings, otherDiffs, fillFilesChanged, snapshot, fillWarnings, executor);
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
