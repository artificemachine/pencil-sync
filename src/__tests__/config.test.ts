import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFramework, detectStyling, findPenFiles, loadConfig } from "../config.js";

describe("detectFramework", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects Next.js from config file", async () => {
    await writeFile(join(dir, "next.config.js"), "module.exports = {}");
    expect(await detectFramework(dir)).toBe("nextjs");
  });

  it("detects Svelte from config file", async () => {
    await writeFile(join(dir, "svelte.config.js"), "export default {}");
    expect(await detectFramework(dir)).toBe("svelte");
  });

  it("detects Astro from config file", async () => {
    await writeFile(join(dir, "astro.config.mjs"), "export default {}");
    expect(await detectFramework(dir)).toBe("astro");
  });

  it("detects React from package.json deps", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { react: "^18.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("react");
  });

  it("detects Vue from package.json deps", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { vue: "^3.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("vue");
  });

  it("returns unknown when nothing detected", async () => {
    expect(await detectFramework(dir)).toBe("unknown");
  });

  it("prefers config file over package.json", async () => {
    await writeFile(join(dir, "next.config.js"), "");
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { vue: "^3.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("nextjs");
  });
});

describe("detectStyling", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects tailwind from config file", async () => {
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {}");
    expect(await detectStyling(dir)).toBe("tailwind");
  });

  it("detects tailwind from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      devDependencies: { tailwindcss: "^4.0.0" },
    }));
    expect(await detectStyling(dir)).toBe("tailwind");
  });

  it("detects styled-components from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { "styled-components": "^6.0.0" },
    }));
    expect(await detectStyling(dir)).toBe("styled-components");
  });

  it("returns unknown when nothing detected", async () => {
    expect(await detectStyling(dir)).toBe("unknown");
  });

  it("detects css-modules from *.module.css file", async () => {
    await writeFile(join(dir, "App.module.css"), ".root {}");
    expect(await detectStyling(dir)).toBe("css-modules");
  });

  it("detects css when only plain *.css file present", async () => {
    await writeFile(join(dir, "styles.css"), "body {}");
    expect(await detectStyling(dir)).toBe("css");
  });

  it("tailwind config file beats css-modules when both present", async () => {
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {}");
    await writeFile(join(dir, "App.module.css"), ".root {}");
    expect(await detectStyling(dir)).toBe("tailwind");
  });

  it("chaos: malformed package.json falls through without throwing", async () => {
    await writeFile(join(dir, "package.json"), "{ broken ]]]");
    let threw = false;
    let result: string | undefined;
    try {
      result = await detectStyling(dir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe("unknown");
  });
});

describe("findPenFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-find-pen-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Smoke
  it("smoke: findPenFiles is importable and callable", async () => {
    const result = await findPenFiles(dir);
    expect(Array.isArray(result)).toBe(true);
  });

  // Unit
  it("returns empty array when no pen files present", async () => {
    await writeFile(join(dir, "design.tsx"), "content");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(0);
  });

  it("finds pen file in root directory", async () => {
    await writeFile(join(dir, "design.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("design.pen");
  });

  it("finds pen files recursively in subdirectories", async () => {
    await mkdir(join(dir, "screens"), { recursive: true });
    await writeFile(join(dir, "screens", "home.pen"), "{}");
    await writeFile(join(dir, "screens", "settings.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(2);
    expect(result.some((p) => p.includes("home.pen"))).toBe(true);
    expect(result.some((p) => p.includes("settings.pen"))).toBe(true);
  });

  it("ignores node_modules directory", async () => {
    await mkdir(join(dir, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "some-pkg", "demo.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(0);
  });

  it("ignores .pencil-sync directory", async () => {
    await mkdir(join(dir, ".pencil-sync"), { recursive: true });
    await writeFile(join(dir, ".pencil-sync", "hidden.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(0);
  });

  it("ignores other hidden directories", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "hidden.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(result).toHaveLength(0);
  });

  // Contract
  it("contract: always returns string[]", async () => {
    await writeFile(join(dir, "a.pen"), "{}");
    const result = await findPenFiles(dir);
    expect(Array.isArray(result)).toBe(true);
    for (const item of result) {
      expect(typeof item).toBe("string");
    }
  });

  // Regression
  it("regression: detectFramework still works after findPenFiles is added", async () => {
    await writeFile(join(dir, "next.config.js"), "module.exports = {}");
    expect(await detectFramework(dir)).toBe("nextjs");
  });

  // Chaos
  it("chaos: maxDepth=0 returns only root-level pen files (no recursion)", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "root.pen"), "{}");
    await writeFile(join(dir, "sub", "nested.pen"), "{}");
    const result = await findPenFiles(dir, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("root.pen");
  });

  it("chaos: unreadable directory returns empty array without throwing", async () => {
    const fakeDir = join(dir, "nonexistent");
    let threw = false;
    let result: string[] | undefined;
    try {
      result = await findPenFiles(fakeDir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual([]);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads valid JSON config", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      mappings: [{
        id: "main",
        penFile: "design.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.mappings).toHaveLength(1);
    expect(config.mappings[0].id).toBe("main");
    expect(config.mappings[0].penFile).toContain(dir);
  });

  it("strips JSONC comments", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // This is a comment
      "version": 1,
      /* block comment */
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx"],
        "direction": "both"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
  });

  it("strips JSONC comments without corrupting glob patterns", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // line comment
      "version": 1,
      /* block comment */
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx", "**/*.css"],
        "direction": "both"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect(config.mappings[0].codeGlobs).toEqual(["**/*.tsx", "**/*.css"]);
  });

  it("merges with default settings", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: { model: "claude-haiku-4-5-20251001" },
    }));

    const config = await loadConfig(configPath);
    expect(config.settings.model).toBe("claude-haiku-4-5-20251001");
    expect(config.settings.debounceMs).toBe(2000); // default
    expect(config.settings.maxBudgetUsd).toBe(0.5); // default
  });

  it("throws when no mappings", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({ mappings: [] }));

    await expect(loadConfig(configPath)).rejects.toThrow("at least one mapping");
  });

  it("throws when config file not found", async () => {
    await expect(loadConfig(join(dir, "nope.json"))).rejects.toThrow();
  });

  it("blocks __proto__ keys in settings (prototype pollution)", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    const malicious = {
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: {
        model: "claude-haiku-4-5-20251001",
        "__proto__": { polluted: true },
        "constructor": { polluted: true },
        "prototype": { polluted: true },
      },
    };
    await writeFile(configPath, JSON.stringify(malicious));

    const config = await loadConfig(configPath);
    // Settings should have the safe model value
    expect(config.settings.model).toBe("claude-haiku-4-5-20251001");
    // Prototype chain should not be polluted
    const plain = {} as Record<string, unknown>;
    expect(plain["polluted"]).toBeUndefined();
    // Dangerous keys should not exist as own properties on the result
    expect(Object.getOwnPropertyDescriptor(config.settings, "__proto__")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(config.settings, "prototype")).toBeUndefined();
  });

  it("rejects duplicate mapping ids", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [
        { id: "app", penFile: "a.pen", codeDir: "code", codeGlobs: ["**/*.tsx"], direction: "both" },
        { id: "app", penFile: "b.pen", codeDir: "code", codeGlobs: ["**/*.tsx"], direction: "both" },
      ],
    }));

    await expect(loadConfig(configPath)).rejects.toThrow("Duplicate mapping id(s): app");
  });

  it("rejects invalid direction value in mapping", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "bad-dir",
        penFile: "design.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "/Users/someone/Downloads/start.pen",
      }],
    }));

    await expect(loadConfig(configPath)).rejects.toThrow(
      /Invalid direction.*Must be one of: both, pen-to-code, code-to-pen/,
    );
  });

  it.each(["both", "pen-to-code", "code-to-pen"] as const)(
    "accepts valid direction %s",
    async (direction) => {
      const configPath = join(dir, "pencil-sync.config.json");
      await writeFile(configPath, JSON.stringify({
        mappings: [{
          id: "valid-dir",
          penFile: "design.pen",
          codeDir: "code",
          codeGlobs: ["**/*.tsx"],
          direction,
        }],
      }));

      const config = await loadConfig(configPath);
      expect(config.mappings[0].direction).toBe(direction);
    },
  );

  it("merges settings with no overrides", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    const config = await loadConfig(configPath);
    expect(config.settings.model).toBe("claude-sonnet-4-6");
    expect(config.settings.debounceMs).toBe(2000);
  });

  it("allows penFile outside configDir (read-only input, not a write target)", async () => {
    // penFile is read-only — it may legitimately live anywhere (e.g. a Pencil
    // workspace folder outside the project). Only write targets (codeDir,
    // stateFile) are confined by the traversal guard.
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "external",
        penFile: "../../../../../../etc/hosts",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    const config = await loadConfig(configPath);
    expect(config.mappings[0].penFile).toMatch(/etc\/hosts$/);
  });

  it("prevents path traversal in codeDir", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "escape",
        penFile: "design.pen",
        codeDir: "../../../../../../../tmp/evil",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    await expect(loadConfig(configPath)).rejects.toThrow(/path traversal detected/i);
  });

  it("prevents path traversal in stateFile", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: {
        stateFile: "../../../../../../../../tmp/evil-state.json",
      },
    }));

    await expect(loadConfig(configPath)).rejects.toThrow(/path traversal detected/i);
  });

  it("resolves absolute penFile outside configDir without error", async () => {
    // Absolute paths outside the config directory must also be accepted
    // for penFile — the file is read-only, not a write target.
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "absolute",
        penFile: "/tmp/test.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));
    const config = await loadConfig(configPath);
    expect(config.mappings[0].penFile).toBe("/tmp/test.pen");
  });

  it("rejects a sibling path sharing a prefix with config dir", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "prefix-escape",
        penFile: "design.pen",
        codeDir: "../evil-sibling",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));
    await expect(loadConfig(configPath)).rejects.toThrow(/path traversal detected/i);
  });

  it("accepts a nested path within config dir when sibling shares a prefix", async () => {
    await mkdir(join(dir, "code-extra"), { recursive: true });
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "design.pen",
        codeDir: "code-extra",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));
    const config = await loadConfig(configPath);
    expect(config.mappings[0].codeDir).toContain("code-extra");
  });

  it("allows valid relative paths within config directory", async () => {
    await mkdir(join(dir, "subdir"));
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "subdir/design.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: {
        stateFile: "subdir/state.json",
      },
    }));

    const config = await loadConfig(configPath);
    expect(config.mappings[0].penFile).toContain("subdir/design.pen");
    expect(config.settings.stateFile).toContain("subdir/state.json");
  });

  it("preserves // in JSON strings when stripping JSONC comments", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // This is a comment
      "version": 1,
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx"],
        "direction": "both",
        "note": "URL: https://example.com/path // not a comment"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect((config.mappings[0] as Record<string, unknown>).note).toBe("URL: https://example.com/path // not a comment");
  });

  it("preserves /* in JSON strings when stripping JSONC comments", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      /* block comment */
      "version": 1,
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx"],
        "direction": "both",
        "regex": "match /* wildcard */ pattern"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect((config.mappings[0] as Record<string, unknown>).regex).toBe("match /* wildcard */ pattern");
  });

  it("preserves escaped quotes in strings when stripping JSONC comments", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // comment
      "version": 1,
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx"],
        "direction": "both",
        "text": "She said \\"hello // world\\""
      }]
    }`);

    const config = await loadConfig(configPath);
    expect(config.mappings[0].text).toBe('She said "hello // world"');
  });
});
