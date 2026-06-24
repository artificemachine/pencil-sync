import { log } from "./logger.js";
import { stableStringify } from "./utils.js";
import type { PenNodeSnapshot, PenDiffEntry } from "./types.js";

interface PenNode {
  id?: string;
  name?: string;
  type?: string;
  fill?: unknown;       // string | gradient object | image | array of fills
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  cornerRadius?: unknown; // number | [top, right, bottom, left]
  children?: PenNode[];
  [key: string]: unknown;
}

const TRACKED_PROPS = ["fill", "content", "fontSize", "fontWeight", "fontFamily", "cornerRadius"] as const;

function flattenPenNodes(
  node: PenNode,
  snapshot: PenNodeSnapshot,
  reusableMap: Map<string, PenNode>,
  visited: Set<string>,
): void {
  // Resolve ref nodes by looking up the reusable target
  if (node.type === "ref" && typeof node.ref === "string") {
    const target = reusableMap.get(node.ref);
    if (!target || !node.id) {
      log.debug(`ref node "${node.id ?? "(no id)"}" points to missing target "${node.ref}" — skipping`);
      return;
    }
    if (visited.has(node.ref)) {
      log.warn(`Circular ref detected at "${node.id}" → "${node.ref}" — skipping`);
      return;
    }
    // Resolve props from the reusable target, using the instance's id/name
    const resolved: PenNode = { ...target, id: node.id, name: node.name ?? target.name };
    flattenPenNodes(resolved, snapshot, reusableMap, new Set([...visited, node.ref]));
    return;
  }

  if (node.id) {
    const props: Record<string, string | number> = {};
    if (node.name) props.name = node.name;
    if (node.type) props.type = node.type;
    for (const prop of TRACKED_PROPS) {
      const val = node[prop];
      if (val !== undefined && val !== null) {
        // Scalars stored as-is; complex values (objects/arrays) canonicalized
        // to a stable JSON string so diffs survive key-order differences.
        props[prop] = (typeof val === "string" || typeof val === "number")
          ? val
          : stableStringify(val);
      }
    }
    // Require at least name/type + one visual property to be worth tracking
    if (Object.keys(props).length > 1) {
      snapshot[node.id] = props;
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      flattenPenNodes(child, snapshot, reusableMap, visited);
    }
  }
}

/**
 * Returns a snapshot of tracked visual properties, or null if the file couldn't be parsed.
 * An empty object {} means "valid file, no tracked nodes" — distinct from null (corruption).
 */
export function snapshotPenFile(penFile: string, raw: string): PenNodeSnapshot | null {
  try {
    const pen = JSON.parse(raw);
    const snapshot: PenNodeSnapshot = {};

    // First pass: collect all reusable component definitions by id
    const reusableMap = new Map<string, PenNode>();
    collectReusable(pen.children ?? [], reusableMap);

    // Second pass: flatten the tree, resolving ref nodes
    for (const child of (pen.children ?? [])) {
      flattenPenNodes(child, snapshot, reusableMap, new Set());
    }

    // Capture document-level design tokens under reserved keys prefixed with '/'.
    // Node ids cannot contain '/' (Pencil spec), so no collision is possible.
    if (pen.variables && typeof pen.variables === "object") {
      snapshot["/variables"] = flattenTokens(pen.variables as Record<string, unknown>);
    }
    if (pen.themes && typeof pen.themes === "object") {
      snapshot["/themes"] = flattenTokens(pen.themes as Record<string, unknown>);
    }

    return snapshot;
  } catch (err) {
    log.error(`Failed to parse .pen file: ${err}`);
    return null;
  }
}

function collectReusable(nodes: PenNode[], map: Map<string, PenNode>): void {
  for (const node of nodes) {
    if (node.reusable && node.id) {
      map.set(node.id, node);
    }
    if (node.children && Array.isArray(node.children)) {
      collectReusable(node.children, map);
    }
  }
}

function flattenTokens(tokens: Record<string, unknown>): Record<string, string | number> {
  const flat: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(tokens)) {
    flat[key] = (typeof val === "string" || typeof val === "number")
      ? val
      : stableStringify(val);
  }
  return flat;
}

const TOKEN_KEYS = new Set(["/variables", "/themes"]);

export function diffPenSnapshots(
  oldSnap: PenNodeSnapshot,
  newSnap: PenNodeSnapshot,
): PenDiffEntry[] {
  const diffs: PenDiffEntry[] = [];

  // Iterate the union so deletions (present in old, absent in new) are detected,
  // not just modifications. A cleared/removed prop is emitted with newValue "".
  const nodeIds = new Set([...Object.keys(oldSnap), ...Object.keys(newSnap)]);

  for (const nodeId of nodeIds) {
    const oldProps = oldSnap[nodeId];
    const newProps = newSnap[nodeId];

    if (TOKEN_KEYS.has(nodeId)) {
      // Design token bucket — diff every key, not just TRACKED_PROPS.
      // Skip first-ever token snapshot (no prior bucket) to avoid flooding the
      // initial sync; once a bucket exists, detect added/changed/removed keys.
      if (!oldProps) continue;
      const newTokens = newProps ?? {};
      const tokenKeys = new Set([...Object.keys(oldProps), ...Object.keys(newTokens)]);
      for (const tokenKey of tokenKeys) {
        const oldVal = oldProps[tokenKey];
        const newVal = newTokens[tokenKey];
        if (oldVal === undefined && newVal !== undefined) {
          diffs.push({ nodeId, nodeName: nodeId, prop: tokenKey, oldValue: "", newValue: newVal });
        } else if (oldVal !== undefined && newVal === undefined) {
          diffs.push({ nodeId, nodeName: nodeId, prop: tokenKey, oldValue: oldVal, newValue: "" });
        } else if (oldVal !== undefined && newVal !== undefined && String(oldVal) !== String(newVal)) {
          diffs.push({ nodeId, nodeName: nodeId, prop: tokenKey, oldValue: oldVal, newValue: newVal });
        }
      }
      continue;
    }

    // Brand-new node (absent from old snapshot): intentionally skipped — generating
    // code for a wholly new design element is out of scope for the diff path.
    // See docs/AUDIT-deep-bug-hunt.md.
    if (!oldProps) continue;

    const nodeName = String((newProps ?? oldProps).name ?? nodeId);

    for (const prop of TRACKED_PROPS) {
      const oldVal = oldProps[prop];
      const newVal = newProps ? newProps[prop] : undefined;
      if (oldVal === undefined && newVal === undefined) continue;
      if (oldVal === undefined && newVal !== undefined) {
        // Prop newly added on an existing node
        diffs.push({ nodeId, nodeName, prop, oldValue: "", newValue: newVal });
      } else if (oldVal !== undefined && newVal === undefined) {
        // Prop cleared, or whole node deleted (newProps absent)
        diffs.push({ nodeId, nodeName, prop, oldValue: oldVal, newValue: "" });
      } else if (oldVal !== undefined && newVal !== undefined && String(oldVal) !== String(newVal)) {
        diffs.push({ nodeId, nodeName, prop, oldValue: oldVal, newValue: newVal });
      }
    }
  }

  return diffs;
}

export function formatDiffForPrompt(diffs: PenDiffEntry[]): string {
  if (diffs.length === 0) return "";

  const lines = diffs.map(d =>
    `- **${d.nodeName}** (${d.nodeId}): \`${d.prop}\` changed from \`${d.oldValue}\` → \`${d.newValue}\``
  );

  return `\n## Design Changes Detected\n\n${lines.join("\n")}\n`;
}

