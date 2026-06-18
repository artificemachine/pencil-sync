import { readFile, access, readdir } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import type {
  PencilSyncConfig,
  MappingConfig,
  Framework,
  Styling,
  Settings,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import { log } from "./logger.js";
import { validatePathWithin } from "./utils.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeMerge<T>(base: T, overrides?: Partial<T>): T {
  const result = { ...base };
  if (overrides) {
    for (const key of Object.keys(overrides) as (keyof T)[]) {
      if (!DANGEROUS_KEYS.has(key as string) && Object.prototype.hasOwnProperty.call(base, key)) {
        result[key] = overrides[key] as T[keyof T];
      }
    }
  }
  return result;
}

const CONFIG_FILENAMES = [
  "pencil-sync.config.json",
  ".pencil-sync.json",
  "pencil-sync.config.jsonc",
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectFramework(
  projectDir: string,
): Promise<Framework> {
  const checks: [string, Framework][] = [
    ["next.config.js", "nextjs"],
    ["next.config.mjs", "nextjs"],
    ["next.config.ts", "nextjs"],
    ["svelte.config.js", "svelte"],
    ["astro.config.mjs", "astro"],
    ["vue.config.js", "vue"],
    ["vite.config.ts", "react"],
    ["vite.config.js", "react"],
  ];

  for (const [file, framework] of checks) {
    if (await fileExists(join(projectDir, file))) {
      return framework;
    }
  }

  const pkgPath = join(projectDir, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next"]) return "nextjs";
      if (deps["svelte"]) return "svelte";
      if (deps["astro"]) return "astro";
      if (deps["vue"]) return "vue";
      if (deps["react"]) return "react";
    } catch {
      // Malformed package.json — fall through to "unknown"
    }
  }

  return "unknown";
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function detectStyling(projectDir: string): Promise<Styling> {
  const tailwindIndicators = [
    "tailwind.config.js",
    "tailwind.config.ts",
    "tailwind.config.mjs",
    "postcss.config.js",
    "postcss.config.mjs",
    "postcss.config.ts",
  ];
  for (const file of tailwindIndicators) {
    if (await fileExists(join(projectDir, file))) {
      return "tailwind";
    }
  }

  // Scan directory for css-modules and css indicators
  let entries: string[] = [];
  try {
    entries = (await readdir(projectDir)).filter((e) => typeof e === "string") as string[];
  } catch {
    // Unreadable dir — skip file scanning
  }

  if (entries.some((e) => e.endsWith(".module.css"))) {
    return "css-modules";
  }

  const pkg = await readPackageJson(projectDir);
  if (pkg) {
    const deps = { ...(pkg.dependencies as Record<string, unknown>), ...(pkg.devDependencies as Record<string, unknown>) };
    if (deps["tailwindcss"]) return "tailwind";
    if (deps["styled-components"]) return "styled-components";
  }

  if (entries.some((e) => e.endsWith(".css"))) {
    return "css";
  }

  return "unknown";
}

export async function findPenFiles(searchDir: string, maxDepth = 5): Promise<string[]> {
  const results: string[] = [];

  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        await recurse(join(dir, name), depth + 1);
      } else if (name.endsWith(".pen")) {
        results.push("./" + relative(searchDir, join(dir, name)));
      }
    }
  }

  await recurse(searchDir, 0);
  return results;
}

async function findProjectRoot(codeDir: string, configDir: string): Promise<string> {
  // Check codeDir first, then walk up to configDir looking for package.json
  const dirs = [codeDir];
  let current = dirname(codeDir);
  // Walk up but not past the config directory's parent
  const stopAt = dirname(configDir);
  while (current.length >= stopAt.length && current !== dirs[dirs.length - 1]) {
    dirs.push(current);
    current = dirname(current);
  }

  for (const dir of dirs) {
    if (await fileExists(join(dir, "package.json"))) {
      return dir;
    }
  }
  return codeDir;
}

async function resolveMapping(
  mapping: MappingConfig,
  configDir: string,
): Promise<MappingConfig> {
  const resolved = { ...mapping };
  // penFile is a read-only input — it may legitimately live outside the
  // project directory (e.g. a Pencil workspace folder). Resolve to absolute
  // but do not confine it. Only write targets (codeDir, stateFile) need the
  // traversal guard since pencil-sync modifies files under those paths.
  resolved.penFile = resolve(configDir, mapping.penFile);
  resolved.codeDir = validatePathWithin(configDir, mapping.codeDir);

  const projectRoot = await findProjectRoot(resolved.codeDir, configDir);

  if (!resolved.framework) {
    resolved.framework = await detectFramework(projectRoot);
    log.debug(`Auto-detected framework: ${resolved.framework} for ${resolved.id}`);
  }
  if (!resolved.styling) {
    resolved.styling = await detectStyling(projectRoot);
    log.debug(`Auto-detected styling: ${resolved.styling} for ${resolved.id}`);
  }

  return resolved;
}

export async function loadConfig(
  configPath?: string,
): Promise<PencilSyncConfig> {
  let resolvedPath: string | undefined;

  if (configPath) {
    resolvedPath = resolve(configPath);
  } else {
    const cwd = process.cwd();
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(cwd, name);
      if (await fileExists(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `No config file found. Create pencil-sync.config.json or pass --config.`,
    );
  }

  log.debug(`Loading config from ${resolvedPath}`);

  const raw = await readFile(resolvedPath, "utf-8");
  // Strip JSONC comments while preserving string contents
  // Strategy: match strings first, preserve them; then match comments and remove them
  const cleaned = raw.replace(
    /"(?:[^"\\]|\\.)*"|\/\/.*?(?=\n|$)|\/\*[\s\S]*?\*\//gm,
    (match) => {
      // If match starts with a quote, it's a string — preserve it
      if (match.startsWith('"')) {
        return match;
      }
      // Otherwise it's a comment — remove it
      return "";
    },
  );
  const parsed = JSON.parse(cleaned) as Partial<PencilSyncConfig>;

  if (!parsed.mappings || parsed.mappings.length === 0) {
    throw new Error("Config must have at least one mapping.");
  }

  const configDir = dirname(resolvedPath);
  const settings: Settings = safeMerge(DEFAULT_SETTINGS, parsed.settings);

  settings.stateFile = validatePathWithin(configDir, settings.stateFile);

  const mappings = await Promise.all(
    parsed.mappings.map((m) => resolveMapping(m as MappingConfig, configDir)),
  );

  // Validate mapping ID uniqueness
  const ids = mappings.map((m) => m.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate mapping id(s): ${[...new Set(dupes)].join(", ")}`);
  }

  return {
    version: parsed.version ?? 1,
    mappings,
    settings,
  };
}
