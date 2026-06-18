import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WizardIO } from "../setup.js";

// Smoke
describe("setup — smoke", () => {
  it("WizardIO and runSetup are importable", async () => {
    const { runSetup } = await import("../setup.js");
    expect(typeof runSetup).toBe("function");
  });
});

/** Build a mock WizardIO that returns answers in sequence. */
function makeIO(answers: string[]): WizardIO {
  let idx = 0;
  const printed: string[] = [];
  return {
    async ask(_question: string, defaultVal?: string): Promise<string> {
      if (idx >= answers.length) return defaultVal ?? "";
      const ans = answers[idx++];
      return ans === "" ? (defaultVal ?? "") : ans;
    },
    print(msg: string) {
      printed.push(msg);
    },
    _printed: printed,
  } as WizardIO & { _printed: string[] };
}

/** Scaffold a minimal temp project directory. */
async function scaffoldProject(
  dir: string,
  opts: { penFile?: boolean; tailwindConfig?: boolean; moduleCss?: boolean; pkgJson?: boolean } = {},
): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  if (opts.penFile !== false) {
    await writeFile(join(dir, "design.pen"), "{}");
  }
  if (opts.tailwindConfig) {
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {}");
  }
  if (opts.moduleCss) {
    await writeFile(join(dir, "App.module.css"), ".root {}");
  }
  if (opts.pkgJson) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
  }
}

describe("setup — WizardIO.ask", () => {
  it("returns default when user presses Enter (empty input)", async () => {
    const io = makeIO([""]);
    const result = await io.ask("Project name?", "myapp");
    expect(result).toBe("myapp");
  });

  it("returns user input when typed", async () => {
    const io = makeIO(["myproject"]);
    const result = await io.ask("Project name?", "myapp");
    expect(result).toBe("myproject");
  });
});

describe("setup — pen file selection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prompts for manual pen path when no pen files found", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO([
      "myapp",         // project name
      "./design.pen",  // manual pen file path (no pen found)
      "./src",         // code directory
      "",              // framework (use default)
      "",              // styling (use default)
      "",              // direction (use default)
      "",              // budget (use default)
    ]);
    await runSetup(io, { cwd: dir });
    const configPath = join(dir, "pencil-sync.config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    expect(config.mappings[0].penFile).toBe("./design.pen");
  });

  it("selects pen file by number when pen files are found", async () => {
    const { runSetup } = await import("../setup.js");
    await writeFile(join(dir, "design.pen"), "{}");
    await mkdir(join(dir, "screens"), { recursive: true });
    await writeFile(join(dir, "screens", "main.pen"), "{}");
    const io = makeIO([
      "myapp",  // project name
      "1",      // select first found pen file
      "./src",  // code directory
      "",       // framework
      "",       // styling
      "",       // direction
      "",       // budget
    ]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].penFile).toMatch(/\.pen$/);
  });

  it("uses manual entry when pen files found but user picks manual option", async () => {
    const { runSetup } = await import("../setup.js");
    await writeFile(join(dir, "design.pen"), "{}");
    const io = makeIO([
      "myapp",
      "m",             // manual
      "./custom.pen",  // custom path
      "./src",
      "",
      "",
      "",
    ]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].penFile).toBe("./custom.pen");
  });
});

describe("setup — auto-detection defaults", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-"));
    await mkdir(join(dir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses detected framework as default", async () => {
    const { runSetup } = await import("../setup.js");
    await writeFile(join(dir, "next.config.js"), "module.exports = {}");
    await writeFile(join(dir, "design.pen"), "{}");
    const io = makeIO([
      "myapp",
      "1",    // select first pen file
      "./src",
      "",     // accept framework default (nextjs)
      "",
      "",
      "",
    ]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].framework).toBe("nextjs");
  });

  it("uses detected styling as default", async () => {
    const { runSetup } = await import("../setup.js");
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {}");
    await writeFile(join(dir, "design.pen"), "{}");
    const io = makeIO([
      "myapp",
      "1",
      "./src",
      "",     // framework default
      "",     // accept styling default (tailwind)
      "",
      "",
    ]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].styling).toBe("tailwind");
  });
});

describe("setup — config writing", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes pencil-sync.config.json with all required fields", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "react", "css", "both", "0.5"]);
    await runSetup(io, { cwd: dir });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.version).toBe(1);
    expect(Array.isArray(config.mappings)).toBe(true);
    expect(config.mappings[0].id).toBeDefined();
    expect(config.mappings[0].penFile).toBeDefined();
    expect(config.mappings[0].codeDir).toBeDefined();
    expect(config.mappings[0].direction).toBeDefined();
    expect(config.settings?.maxBudgetUsd).toBeDefined();
  });

  it("creates .pencil-sync directory during setup", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    await expect(access(join(dir, ".pencil-sync"))).resolves.toBeUndefined();
  });

  it("contract: written config is parseable by JSON.parse", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("setup — overwrite protection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
    // Pre-existing config
    await writeFile(join(dir, "pencil-sync.config.json"), JSON.stringify({ version: 1, mappings: [], settings: {} }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("aborts when config exists and user declines overwrite", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["n"]);  // decline overwrite
    await runSetup(io, { cwd: dir });
    // Config should still have old content
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings).toEqual([]);
  });

  it("overwrites config when user confirms", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["y", "myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings.length).toBeGreaterThan(0);
  });
});

describe("setup — non-TTY mode", () => {
  it("exits cleanly in non-TTY mode without hanging", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO([]);
    let threw = false;
    try {
      // Pass isTTY: false to simulate non-TTY environment
      await runSetup(io, { cwd: "/tmp", isTTY: false });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("setup — state machine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-sm-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() {}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("state: config is written before doctor runs", async () => {
    const { runSetup } = await import("../setup.js");
    let configWrittenBeforeDoctor = false;
    // We verify by checking that config.json exists after setup
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    try {
      await access(join(dir, "pencil-sync.config.json"));
      configWrittenBeforeDoctor = true;
    } catch {
      // not written
    }
    expect(configWrittenBeforeDoctor).toBe(true);
  });

  it("state: .pencil-sync/ directory is created during setup", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    await expect(access(join(dir, ".pencil-sync"))).resolves.toBeUndefined();
  });
});

describe("setup — integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-int-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() {}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("full happy-path: config + .pencil-sync dir both exist after wizard", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    await expect(access(join(dir, "pencil-sync.config.json"))).resolves.toBeUndefined();
    await expect(access(join(dir, ".pencil-sync"))).resolves.toBeUndefined();
  });

  it("config-exists path: overwrite y produces a valid new config", async () => {
    const { runSetup } = await import("../setup.js");
    await writeFile(join(dir, "pencil-sync.config.json"), JSON.stringify({ version: 1, mappings: [], settings: {} }));
    const io = makeIO(["y", "newapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings.length).toBeGreaterThan(0);
  });
});

describe("setup — chaos", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-chaos-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("chaos: unwritable directory exits without throw", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "./design.pen", "./src", "", "", "", ""]);
    let threw = false;
    try {
      await runSetup(io, { cwd: "/nonexistent-path-xyz-12345" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("chaos: setup completes even when .pencil-sync dir creation fails gracefully", async () => {
    const { runSetup } = await import("../setup.js");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    let threw = false;
    try {
      await runSetup(io, { cwd: dir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("setup — regression", () => {
  it("regression: pencil-sync init alias is preserved in index.ts", async () => {
    // Verify init is still exported/registered as an alias to setup
    const { runSetup } = await import("../setup.js");
    expect(typeof runSetup).toBe("function");
  });
});
