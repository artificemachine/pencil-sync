import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, hashFile, hashCodeDir, diffHashes, globToRegex } from "../state-store.js";
import type { SyncResult } from "../types.js";

describe("hashFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns SHA-256 hex hash of file", async () => {
    const file = join(dir, "test.txt");
    await writeFile(file, "hello world");
    const hash = await hashFile(file);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns same hash for same content", async () => {
    const file1 = join(dir, "a.txt");
    const file2 = join(dir, "b.txt");
    await writeFile(file1, "same content");
    await writeFile(file2, "same content");
    expect(await hashFile(file1)).toBe(await hashFile(file2));
  });

  it("returns different hash for different content", async () => {
    const file1 = join(dir, "a.txt");
    const file2 = join(dir, "b.txt");
    await writeFile(file1, "content a");
    await writeFile(file2, "content b");
    expect(await hashFile(file1)).not.toBe(await hashFile(file2));
  });

  it("returns empty string for non-existent file", async () => {
    expect(await hashFile(join(dir, "nope.txt"))).toBe("");
  });
});

describe("hashCodeDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects matching files with relative paths", async () => {
    await writeFile(join(dir, "app.tsx"), "export default function App() {}");
    await writeFile(join(dir, "style.css"), "body {}");

    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toEqual(["app.tsx"]);
    expect(hashes["app.tsx"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches multiple glob patterns", async () => {
    await writeFile(join(dir, "a.tsx"), "a");
    await writeFile(join(dir, "b.css"), "b");
    await writeFile(join(dir, "c.txt"), "c");

    const hashes = await hashCodeDir(dir, ["**/*.tsx", "**/*.css"]);
    const keys = Object.keys(hashes).sort();
    expect(keys).toEqual(["a.tsx", "b.css"]);
  });

  it("recurses into subdirectories", async () => {
    await mkdir(join(dir, "components"), { recursive: true });
    await writeFile(join(dir, "components", "Button.tsx"), "button");
    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toContain("components/Button.tsx");
  });

  it("ignores node_modules", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.tsx"), "nope");
    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toEqual([]);
  });

  it("hashCodeDir skips .next output", async () => {
    await writeFile(join(dir, "comp.tsx"), "export const A = 1;");
    await mkdir(join(dir, ".next"), { recursive: true });
    await writeFile(join(dir, ".next", "x.tsx"), "// build output");
    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    const keys = Object.keys(hashes);
    expect(keys).toContain("comp.tsx");
    expect(keys.some((k) => k.includes(".next"))).toBe(false);
  });

  it("brace patterns select tsx and jsx files", async () => {
    await writeFile(join(dir, "Button.tsx"), "tsx");
    await writeFile(join(dir, "Icon.jsx"), "jsx");
    await writeFile(join(dir, "style.css"), "css");
    const hashes = await hashCodeDir(dir, ["**/*.{tsx,jsx}"]);
    const keys = Object.keys(hashes).sort();
    expect(keys).toContain("Button.tsx");
    expect(keys).toContain("Icon.jsx");
    expect(keys).not.toContain("style.css");
  });
});

describe("diffHashes", () => {
  it("detects new files", () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = { "new.tsx": "abc123" };
    expect(diffHashes(before, after)).toEqual(["new.tsx"]);
  });

  it("detects modified files", () => {
    const before = { "app.tsx": "hash1" };
    const after = { "app.tsx": "hash2" };
    expect(diffHashes(before, after)).toEqual(["app.tsx"]);
  });

  it("detects deleted files", () => {
    const before = { "old.tsx": "hash1" };
    const after: Record<string, string> = {};
    expect(diffHashes(before, after)).toEqual(["old.tsx"]);
  });

  it("returns empty for identical hashes", () => {
    const hashes = { "a.tsx": "h1", "b.tsx": "h2" };
    expect(diffHashes(hashes, { ...hashes })).toEqual([]);
  });

  it("handles mixed changes", () => {
    const before = { "kept.tsx": "same", "modified.tsx": "old", "deleted.tsx": "d" };
    const after = { "kept.tsx": "same", "modified.tsx": "new", "added.tsx": "a" };
    const changed = diffHashes(before, after);
    expect(changed).toContain("modified.tsx");
    expect(changed).toContain("deleted.tsx");
    expect(changed).toContain("added.tsx");
    expect(changed).not.toContain("kept.tsx");
  });
});

describe("globToRegex", () => {
  it("matches **/*.tsx (any depth)", () => {
    const re = globToRegex("**/*.tsx");
    expect(re.test("app.tsx")).toBe(true);
    expect(re.test("components/Button.tsx")).toBe(true);
    expect(re.test("src/ui/Card.tsx")).toBe(true);
    expect(re.test("app.ts")).toBe(false);
    expect(re.test("app.tsx.bak")).toBe(false);
  });

  it("matches *.css (root level only)", () => {
    const re = globToRegex("*.css");
    expect(re.test("style.css")).toBe(true);
    expect(re.test("sub/style.css")).toBe(false);
  });

  it("matches **/*.{tsx,ts} via separate globs", () => {
    const reTsx = globToRegex("**/*.tsx");
    const reTs = globToRegex("**/*.ts");
    expect(reTsx.test("app.tsx")).toBe(true);
    expect(reTs.test("app.ts")).toBe(true);
    expect(reTsx.test("app.ts")).toBe(false);
  });

  it("escapes dots in extension", () => {
    const re = globToRegex("**/*.config.js");
    expect(re.test("tailwind.config.js")).toBe(true);
    expect(re.test("tailwindxconfigxjs")).toBe(false);
  });

  it("matches ? as single non-slash character", () => {
    const re = globToRegex("?.txt");
    expect(re.test("a.txt")).toBe(true);
    expect(re.test("ab.txt")).toBe(false);
    expect(re.test("/.txt")).toBe(false);
  });

  it("matches ** at end as anything", () => {
    const re = globToRegex("src/**");
    expect(re.test("src/foo")).toBe(true);
    expect(re.test("src/foo/bar/baz.ts")).toBe(true);
  });

  it("matches nested directory glob", () => {
    const re = globToRegex("src/**/components/*.tsx");
    expect(re.test("src/components/Button.tsx")).toBe(true);
    expect(re.test("src/ui/components/Button.tsx")).toBe(true);
    expect(re.test("src/Button.tsx")).toBe(false);
  });

  it("does not match across slashes with single *", () => {
    const re = globToRegex("src/*.tsx");
    expect(re.test("src/App.tsx")).toBe(true);
    expect(re.test("src/deep/App.tsx")).toBe(false);
  });
});

describe("StateStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads from empty state when file does not exist", async () => {
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    expect(store.getMappingState("nope")).toBeUndefined();
  });

  it("saves and reloads state", async () => {
    const stateFile = join(dir, "state.json");
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "content");
    const penFile = join(dir, "design.pen");
    await writeFile(penFile, "pen content");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "test",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.updateMappingState(mapping, "pen-to-code");

    const state = store.getMappingState("test");
    expect(state).toBeDefined();
    expect(state!.mappingId).toBe("test");
    expect(state!.penHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state!.lastSyncDirection).toBe("pen-to-code");

    // Reload from disk
    const store2 = new StateStore(stateFile);
    await store2.load();
    const reloaded = store2.getMappingState("test");
    expect(reloaded).toEqual(state);
  });

  it("initMappingState only initializes once", async () => {
    const stateFile = join(dir, "state.json");
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "a.tsx"), "v1");
    const penFile = join(dir, "d.pen");
    await writeFile(penFile, "pen");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "m1",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.initMappingState(mapping);
    const first = store.getMappingState("m1");

    // Modify file and re-init — should NOT update
    await writeFile(join(codeDir, "a.tsx"), "v2");
    await store.initMappingState(mapping);
    const second = store.getMappingState("m1");

    expect(second!.codeHashes).toEqual(first!.codeHashes);
  });

  it("creates a .backup file when saving over an existing state file", async () => {
    const stateFile = join(dir, "state.json");
    const backupFile = stateFile + ".backup";

    const store = new StateStore(stateFile);
    await store.load(); // starts fresh (no file)
    await store.save(); // creates state file

    // Save again — this time a state file exists, so backup should be created
    await store.save();

    const backupExists = await access(backupFile).then(() => true).catch(() => false);
    expect(backupExists).toBe(true);
  });

  it("logs a warning when backup creation fails with a non-ENOENT error", async () => {
    const { log } = await import("../logger.js");
    const warnSpy = vi.spyOn(log, "warn");

    const stateFile = join(dir, "state.json");
    const backupPath = stateFile + ".backup";

    // Write initial state and create a backup file that is a directory (causes copyFile to fail with non-ENOENT)
    await writeFile(stateFile, JSON.stringify({ version: 1, mappings: {} }));
    await mkdir(backupPath); // backup path is a directory — copyFile will fail with EISDIR

    const store = new StateStore(stateFile);
    await store.load();
    await store.save(); // triggers createBackup which will fail with EISDIR

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to create state backup"));

    warnSpy.mockRestore();
  });
});

describe("StateStore — .pencil-sync/ directory auto-create and migration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-dir-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Smoke
  it("creates .pencil-sync/ directory when it does not exist", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();
    const dirExists = await access(join(dir, ".pencil-sync")).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
  });

  // Unit — migration fires
  it("migrates old flat .pencil-sync-state.json to .pencil-sync/state.json", async () => {
    const oldFile = join(dir, ".pencil-sync-state.json");
    await writeFile(oldFile, JSON.stringify({ version: 1, mappings: {} }));

    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    const newExists = await access(stateFile).then(() => true).catch(() => false);
    const oldGone = await access(oldFile).then(() => false).catch(() => true);
    expect(newExists).toBe(true);
    expect(oldGone).toBe(true);
  });

  // State machine — migration skipped when new file already exists
  it("does not migrate when .pencil-sync/state.json already exists", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    await mkdir(join(dir, ".pencil-sync"), { recursive: true });
    const newContent = JSON.stringify({ version: 1, mappings: { m1: { mappingId: "m1", penHash: "abc", codeHashes: {}, lastSyncTimestamp: 0, lastSyncDirection: "pen-to-code" } } });
    await writeFile(stateFile, newContent);

    const oldFile = join(dir, ".pencil-sync-state.json");
    await writeFile(oldFile, JSON.stringify({ version: 1, mappings: {} }));

    const store = new StateStore(stateFile);
    await store.load();

    const oldStillExists = await access(oldFile).then(() => true).catch(() => false);
    expect(oldStillExists).toBe(true);
    expect(store.getMappingState("m1")).toBeDefined();
  });

  // Unit — migration skipped for custom path
  it("does not migrate for a custom (non-default) state file path", async () => {
    const oldFile = join(dir, ".pencil-sync-state.json");
    await writeFile(oldFile, JSON.stringify({ version: 1, mappings: {} }));

    // Parent dir is NOT named .pencil-sync
    const customDir = join(dir, "custom");
    await mkdir(customDir, { recursive: true });
    const store = new StateStore(join(customDir, "my-state.json"));
    await store.load();

    const oldStillExists = await access(oldFile).then(() => true).catch(() => false);
    expect(oldStillExists).toBe(true);
  });

  // Unit — save creates dir if it was removed
  it("save() recreates .pencil-sync/ if it was removed after load", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    await rm(join(dir, ".pencil-sync"), { recursive: true, force: true });

    await store.save();
    const dirExists = await access(join(dir, ".pencil-sync")).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
  });

  // Regression — custom flat path still works
  it("regression: flat custom stateFile path works unchanged", async () => {
    const stateFile = join(dir, "flat-state.json");
    const store = new StateStore(stateFile);
    await store.load();
    expect(store.getMappingState("nope")).toBeUndefined();
    await store.save();
    const exists = await access(stateFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  // Chaos — load when a file exists at the directory path
  it("load() does not throw when a file blocks directory creation", async () => {
    const penSyncPath = join(dir, ".pencil-sync");
    await writeFile(penSyncPath, "not a directory");
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    // Should resolve without throwing (graceful degradation)
    await store.load();
  });
});

describe("StateStore — writeLastRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-lastrun-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Unit
  it("writes last-run.json next to state.json in .pencil-sync/", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    const result: SyncResult = {
      success: true,
      direction: "pen-to-code",
      mappingId: "test-mapping",
      filesChanged: ["src/styles.css"],
    };
    await store.writeLastRun(result);

    const lastRunPath = join(dir, ".pencil-sync", "last-run.json");
    const exists = await access(lastRunPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = JSON.parse(await readFile(lastRunPath, "utf-8")) as SyncResult;
    expect(content.success).toBe(true);
    expect(content.direction).toBe("pen-to-code");
    expect(content.mappingId).toBe("test-mapping");
    expect(content.filesChanged).toEqual(["src/styles.css"]);
  });

  // Unit
  it("writeLastRun overwrites previous last-run.json", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    const r1: SyncResult = { success: true, direction: "pen-to-code", mappingId: "m1", filesChanged: ["a.css"] };
    const r2: SyncResult = { success: false, direction: "code-to-pen", mappingId: "m2", filesChanged: [], error: "oops" };
    await store.writeLastRun(r1);
    await store.writeLastRun(r2);

    const content = JSON.parse(await readFile(join(dir, ".pencil-sync", "last-run.json"), "utf-8")) as SyncResult;
    expect(content.direction).toBe("code-to-pen");
    expect(content.mappingId).toBe("m2");
    expect(content.error).toBe("oops");
  });

  // Contract
  it("last-run.json contains all required SyncResult shape fields", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    const result: SyncResult = {
      success: true,
      direction: "pen-to-code",
      mappingId: "contract",
      filesChanged: ["x.css"],
    };
    await store.writeLastRun(result);

    const content = JSON.parse(await readFile(join(dir, ".pencil-sync", "last-run.json"), "utf-8"));
    expect(content).toHaveProperty("success");
    expect(content).toHaveProperty("direction");
    expect(content).toHaveProperty("mappingId");
    expect(content).toHaveProperty("filesChanged");
  });

  // Chaos — writeLastRun does not throw when last-run path is a directory
  it("writeLastRun does not throw when write would fail", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    // Block write by putting a directory at last-run.json path
    await mkdir(join(dir, ".pencil-sync", "last-run.json"), { recursive: true });

    const result: SyncResult = { success: true, direction: "pen-to-code", mappingId: "m", filesChanged: [] };
    await store.writeLastRun(result); // must not throw
  });

  it("two concurrent save() calls do not corrupt the state file", async () => {
    const stateFile = join(dir, ".pencil-sync", "state.json");
    const store = new StateStore(stateFile);
    await store.load();

    await Promise.all([store.save(), store.save()]);

    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw); // must not throw
    expect(parsed.version).toBe(1);
    expect(typeof parsed._checksum).toBe("string");
  });
});
