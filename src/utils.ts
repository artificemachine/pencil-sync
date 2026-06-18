import { resolve, relative, isAbsolute, sep } from "node:path";
import type { MappingConfig } from "./types.js";

export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the first .css file in a mapping's styleFiles list.
 */
export function getCssStyleFile(mapping: MappingConfig): string | undefined {
  return (mapping.styleFiles ?? []).find((f) => f.endsWith(".css"));
}

/**
 * Validate that a resolved file path stays within the base directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 * Returns the resolved absolute path, or throws if traversal detected.
 */
/**
 * Serialize any value to a canonical JSON string with sorted keys.
 * Scalars (string, number) are returned as-is for compatibility with
 * persisted snapshots that predate complex-value support.
 * Non-serializable values (circular refs, bigint) fall back to String().
 */
export function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    return String(value);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function validatePathWithin(basePath: string, filePath: string): string {
  const resolvedBase = resolve(basePath);
  const resolvedFull = resolve(basePath, filePath);
  const rel = relative(resolvedBase, resolvedFull);

  // ".."+sep or exact ".." catches parent traversal; isAbsolute catches cross-drive escapes on Windows
  // Plain startsWith("..") is too broad — it rejects valid names like "..theme/"
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: "${filePath}" resolves outside of "${basePath}"`);
  }

  return resolvedFull;
}
