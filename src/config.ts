import { readFile, access, readdir } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { z } from "zod";
import type {
  PencilSyncConfig,
  MappingConfig,
  Framework,
  Styling,
  Settings,
  SyncDirection,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

const VALID_DIRECTIONS: SyncDirection[] = ["both", "pen-to-code", "code-to-pen"];
import { log } from "./logger.js";
import { validatePathWithin } from "./utils.js";

const DIRECTION_VALUES = ["both", "pen-to-code", "code-to-pen"] as const;

const MappingInputSchema = z
  .object({
    id: z.string({ message: "mapping.id is required" }),
    penFile: z.string({ message: "mapping.penFile is required" }),
    codeDir: z.string({ message: "mapping.codeDir is required" }),
    codeGlobs: z.array(z.string(), {
      message: "mapping.codeGlobs is required",
    }),
    direction: z.enum(DIRECTION_VALUES, {
      error: () => ({
        message: "mapping.direction must be 'both', 'pen-to-code', or 'code-to-pen'",
      }),
    }),
  })
  .passthrough();

const ConfigInputSchema = z.object({
  version: z.number().optional(),
  mappings: z
    .array(MappingInputSchema, {
      message: "Config.mappings is required.",
    })
    .min(1, "Config must have at least one mapping."),
});

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

  if (!VALID_DIRECTIONS.includes(mapping.direction as SyncDirection)) {
    throw new Error(
      `Invalid direction "${mapping.direction}" in mapping "${mapping.id}". Must be one of: both, pen-to-code, code-to-pen.`,
    );
  }

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
  const withoutComments = raw.replace(
    /"(?:[^"\\]|\\.)*"|\/\/.*?(?=\n|$)|\/\*[\s\S]*?\*\//gm,
    (match) => (match.startsWith('"') ? match : ""),
  );
  // Strip trailing commas before } or ] (not inside strings)
  const cleaned = withoutComments.replace(
    /"(?:[^"\\]|\\.)*"|,(\s*[}\]])/gm,
    (match, g1) => (match.startsWith('"') ? match : g1 as string),
  );
  const raw_parsed = JSON.parse(cleaned) as unknown;

  let parsed: z.infer<typeof ConfigInputSchema>;
  try {
    parsed = ConfigInputSchema.parse(raw_parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues ?? (err as { errors?: typeof err.issues }).errors ?? [];
      const msg = issues.map((e) => `${e.path.join(".") || "config"}: ${e.message}`).join("; ");
      throw new Error(`Config validation failed: ${msg}`);
    }
    throw err;
  }

  const configDir = dirname(resolvedPath);
  const rawConfig = raw_parsed as Record<string, unknown>;
  const settings: Settings = safeMerge(DEFAULT_SETTINGS, rawConfig.settings as Partial<Settings>);

  // Expand ${VAR_NAME} in apiKey, or auto-populate from well-known env vars
  if (settings.apiKey?.startsWith("${") && settings.apiKey.endsWith("}")) {
    const varName = settings.apiKey.slice(2, -1);
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable '${varName}' referenced in apiKey is not set. ` +
          `Set it with: export ${varName}=<your-api-key>`,
      );
    }
    settings.apiKey = envValue;
  } else if (!settings.apiKey) {
    const effectiveProvider = settings.provider ?? settings.aiProvider;
    if (effectiveProvider && effectiveProvider !== "claude-cli") {
      const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        "openai-compatible": "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
      };
      const varName = envMap[effectiveProvider];
      if (varName) settings.apiKey = process.env[varName];
    }
  }

  if (settings.apiBaseUrl) {
    try {
      const parsedUrl = new URL(settings.apiBaseUrl);
      if (parsedUrl.protocol !== "https:") {
        console.warn(
          `[pencil-sync] WARNING: apiBaseUrl "${settings.apiBaseUrl}" uses a non-https protocol. ` +
            "Using http:// sends API keys in cleartext.",
        );
      }
      const host = parsedUrl.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      ) {
        console.warn(
          `[pencil-sync] WARNING: apiBaseUrl "${settings.apiBaseUrl}" points to localhost or an internal network address.`,
        );
      }
    } catch {
      // Invalid URL — let downstream validation surface the error
    }
    // Warn about common MiniMax domain mismatch: minimax.chat (China) returns 401 for a valid key;
    // the international domain is minimaxi.chat (double-i)
    if (
      settings.apiBaseUrl.includes("minimax.chat") &&
      !settings.apiBaseUrl.includes("minimaxi.chat")
    ) {
      console.warn(
        "[pencil-sync] WARNING: apiBaseUrl looks like the MiniMax China domain (minimax.chat). " +
          "For international accounts use api.minimaxi.chat/v1 (double-i). " +
          "The China domain returns '401 invalid api key' for valid international keys.",
      );
    }
  }

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
