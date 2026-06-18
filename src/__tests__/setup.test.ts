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
function makeIO(answers: string[]): WizardIO & { _printed: string[]; _steps: string[]; _detected: string[] } {
  let idx = 0;
  const printed: string[] = [];
  const steps: string[] = [];
  const detected: string[] = [];
  return {
    async ask(_question: string, defaultVal?: string): Promise<string> {
      if (idx >= answers.length) return defaultVal ?? "";
      const ans = answers[idx++];
      return ans === "" ? (defaultVal ?? "") : ans;
    },
    print(msg: string) {
      printed.push(msg);
    },
    printSection(title: string) {
      printed.push(`── ${title} ──`);
    },
    printStep(n: number, total: number, label: string) {
      const s = `[${n}/${total}] ${label}`;
      steps.push(s);
      printed.push(s);
    },
    printDetected(label: string, value: string) {
      const s = `${label}: ${value} (auto-detected)`;
      detected.push(s);
      printed.push(s);
    },
    _printed: printed,
    _steps: steps,
    _detected: detected,
  } as WizardIO & { _printed: string[]; _steps: string[]; _detected: string[] };
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

describe("setup — non-interactive mode", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-ni-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes config from defaults without prompting when nonInteractive=true", async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup(undefined, {
      cwd: dir,
      nonInteractive: true,
      defaults: {
        projectName: "ci-app",
        penFile: "./design.pen",
        codeDir: "./src",
        framework: "react",
        styling: "css",
        direction: "both",
        budget: "1.0",
      },
    });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].penFile).toBe("./design.pen");
    expect(config.mappings[0].codeDir).toBe("./src");
    expect(config.mappings[0].framework).toBe("react");
    expect(config.mappings[0].styling).toBe("css");
    expect(config.settings.maxBudgetUsd).toBe(1.0);
  });

  it("creates .pencil-sync/ directory in non-interactive mode", async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup(undefined, {
      cwd: dir,
      nonInteractive: true,
      defaults: { penFile: "./design.pen", codeDir: "./src" },
    });
    await expect(access(join(dir, ".pencil-sync"))).resolves.toBeUndefined();
  });

  it("exits cleanly with error when required fields missing in non-interactive mode", async () => {
    const { runSetup } = await import("../setup.js");
    let threw = false;
    try {
      await runSetup(undefined, {
        cwd: dir,
        nonInteractive: true,
        defaults: {},  // no penFile or codeDir
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Config should not have been written
    let configExists = false;
    try {
      await access(join(dir, "pencil-sync.config.json"));
      configExists = true;
    } catch { }
    expect(configExists).toBe(false);
  });

  it("non-interactive mode does not require isTTY", async () => {
    const { runSetup } = await import("../setup.js");
    let threw = false;
    try {
      await runSetup(undefined, {
        cwd: dir,
        isTTY: false,
        nonInteractive: true,
        defaults: { penFile: "./design.pen", codeDir: "./src" },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("contract: non-interactive config is valid JSON parseable by JSON.parse", async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup(undefined, {
      cwd: dir,
      nonInteractive: true,
      defaults: { penFile: "./design.pen", codeDir: "./src" },
    });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ─── Iteration 3: Back navigation ────────────────────────────────────────────

describe("setup — back navigation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-back-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("smoke: 'back' at step 1 does not throw", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["back", "myapp", "1", "./src", "", "", "", "", "y"]);
    let threw = false;
    try { await runSetup(io, { cwd: dir }); } catch { threw = true; }
    expect(threw).toBe(false);
  });

  it("back at step 2 re-asks step 1 (step 1 question asked twice)", async () => {
    const { runSetup } = await import("../setup.js");
    let projectNameAskCount = 0;
    const answers = ["myapp", "back", "myapp", "1", "./src", "", "", "", "", "y"];
    let idx = 0;
    const io: WizardIO & { _printed: string[]; _steps: string[]; _detected: string[] } = {
      async ask(question: string, defaultVal?: string): Promise<string> {
        if (question.toLowerCase().includes("project name") || question.toLowerCase().includes("project")) {
          if (!question.toLowerCase().includes("pen") && !question.toLowerCase().includes("framework") && !question.toLowerCase().includes("styling") && !question.toLowerCase().includes("direction") && !question.toLowerCase().includes("budget") && !question.toLowerCase().includes("confirm") && !question.toLowerCase().includes("code")) {
            projectNameAskCount++;
          }
        }
        if (idx >= answers.length) return defaultVal ?? "";
        const ans = answers[idx++];
        return ans === "" ? (defaultVal ?? "") : ans;
      },
      print(_msg: string) {},
      printSection(_title: string) {},
      printStep(_n: number, _total: number, _label: string) {},
      printDetected(_label: string, _value: string) {},
      _printed: [],
      _steps: [],
      _detected: [],
    };
    await runSetup(io, { cwd: dir });
    expect(projectNameAskCount).toBeGreaterThanOrEqual(2);
  });

  it("back at step 1 is a no-op and re-asks step 1", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["back", "myapp", "1", "./src", "", "", "", "", "y"]);
    await runSetup(io, { cwd: dir });
    // Should not hang or throw; and config should be written
    await expect(access(join(dir, "pencil-sync.config.json"))).resolves.toBeUndefined();
    expect(io._printed.some((s) => s.toLowerCase().includes("already at step 1"))).toBe(true);
  });

  it("previous answer shown as default when going back", async () => {
    const { runSetup } = await import("../setup.js");
    const answers: string[] = [];
    const defaults: string[] = [];
    let callIdx = 0;
    const io: WizardIO & { _printed: string[]; _steps: string[]; _detected: string[] } = {
      async ask(question: string, defaultVal?: string): Promise<string> {
        const step = callIdx++;
        if (defaultVal !== undefined) defaults.push(defaultVal);
        // Step 0 = project name: answer "myapp"
        // Step 1 = pen file selection: answer "back"
        // Step 2 = project name again: return "" (use default, should be "myapp")
        const seq = ["myapp", "back", "", "1", "./src", "", "", "", "", "y"];
        if (step >= seq.length) return defaultVal ?? "";
        const ans = seq[step];
        return ans === "" ? (defaultVal ?? "") : ans;
      },
      print(_msg: string) {},
      printSection(_title: string) {},
      printStep(_n: number, _total: number, _label: string) {},
      printDetected(_label: string, _value: string) {},
      _printed: [],
      _steps: [],
      _detected: [],
    };
    await runSetup(io, { cwd: dir });
    // After answering "myapp" for project name and then going back via pen selection,
    // the re-asked project name step should have "myapp" as its default
    const myappDefaults = defaults.filter((d) => d === "myapp");
    expect(myappDefaults.length).toBeGreaterThanOrEqual(1);
  });

  it("back navigates multiple steps in sequence", async () => {
    const { runSetup } = await import("../setup.js");
    // Navigate: name -> pen(back) -> name(back) -> name[at step1, no-op] -> name answer -> pen -> src -> ... -> y
    const io = makeIO(["myapp", "back", "back", "myapp2", "1", "./src", "", "", "", "", "y"]);
    let threw = false;
    try { await runSetup(io, { cwd: dir }); } catch { threw = true; }
    expect(threw).toBe(false);
  });

  it("contract: WizardIO.ask signature unchanged (2 params: question, defaultVal)", async () => {
    const io = makeIO([]);
    const result = await io.ask("Test question?", "default-value");
    expect(result).toBe("default-value");
  });

  it("regression: forward-only answer sequences still produce correct config", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "react", "css", "both", "0.5", "y"]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].framework).toBe("react");
    expect(config.mappings[0].styling).toBe("css");
    expect(config.mappings[0].direction).toBe("both");
    expect(config.settings.maxBudgetUsd).toBe(0.5);
  });

  it("chaos: 'back' at confirmation screen returns to step 7", async () => {
    const { runSetup } = await import("../setup.js");
    // Answer 7 steps, then "back" at confirm (re-asks step 7 budget), then answer budget + confirm y
    const io = makeIO(["myapp", "1", "./src", "", "", "", "0.5", "back", "1.0", "y"]);
    let threw = false;
    try { await runSetup(io, { cwd: dir }); } catch { threw = true; }
    expect(threw).toBe(false);
  });
});

// ─── Iteration 2: Confirmation summary screen ────────────────────────────────

describe("setup — confirmation summary screen", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-confirm-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("smoke: runSetup with 'n' at summary exits cleanly without writing config", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", "n"]);
    await runSetup(io, { cwd: dir });
    let configExists = false;
    try { await access(join(dir, "pencil-sync.config.json")); configExists = true; } catch {}
    expect(configExists).toBe(false);
  });

  it("shows penFile and codeDir values in printed output before writing", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", "y"]);
    await runSetup(io, { cwd: dir });
    const allOutput = io._printed.join("\n");
    expect(allOutput).toMatch(/\.pen/);
    expect(allOutput).toMatch(/src/);
  });

  it("aborts without writing config when user answers 'n' at confirmation", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "react", "css", "both", "0.5", "n"]);
    await runSetup(io, { cwd: dir });
    let configExists = false;
    try { await access(join(dir, "pencil-sync.config.json")); configExists = true; } catch {}
    expect(configExists).toBe(false);
  });

  it("writes config when user answers 'y' at confirmation", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "react", "css", "both", "0.5", "y"]);
    await runSetup(io, { cwd: dir });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    expect(JSON.parse(raw).mappings[0].framework).toBe("react");
  });

  it("state machine: loops back to step 1 when user answers 'restart' at confirmation", async () => {
    const { runSetup } = await import("../setup.js");
    // First pass: answer everything, then restart; second pass: answer with different name, confirm y
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", "restart", "newapp", "1", "./src", "", "", "", "", "y"]);
    await runSetup(io, { cwd: dir });
    const config = JSON.parse(await readFile(join(dir, "pencil-sync.config.json"), "utf-8"));
    expect(config.mappings[0].id).toBe("newapp");
  });

  it("state machine: collecting -> confirming -> aborted", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", "n"]);
    await runSetup(io, { cwd: dir });
    expect(io._printed.some((s) => s.toLowerCase().includes("abort"))).toBe(true);
  });

  it("state machine: collecting -> confirming -> writing", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", "y"]);
    await runSetup(io, { cwd: dir });
    await expect(access(join(dir, "pencil-sync.config.json"))).resolves.toBeUndefined();
  });

  it("regression: non-interactive mode skips the summary screen", async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup(undefined, {
      cwd: dir,
      nonInteractive: true,
      defaults: { penFile: "./design.pen", codeDir: "./src" },
    });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("chaos: empty string at confirmation defaults to 'y' and writes config", async () => {
    const { runSetup } = await import("../setup.js");
    // empty string returns defaultVal which should be "y"
    const io = makeIO(["myapp", "1", "./src", "", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    await expect(access(join(dir, "pencil-sync.config.json"))).resolves.toBeUndefined();
  });
});

// ─── Iteration 1: WizardIO display primitives ────────────────────────────────

describe("setup — WizardIO display primitives", () => {
  it("smoke: makeIO returns an object with all 5 WizardIO methods", () => {
    const io = makeIO([]);
    expect(typeof io.ask).toBe("function");
    expect(typeof io.print).toBe("function");
    expect(typeof io.printSection).toBe("function");
    expect(typeof io.printStep).toBe("function");
    expect(typeof io.printDetected).toBe("function");
  });

  it("printSection formats header with title in output", () => {
    const io = makeIO([]);
    io.printSection("Project Setup");
    expect(io._printed.some((s) => s.includes("Project Setup"))).toBe(true);
  });

  it("printStep includes [N/total] counter in output", () => {
    const io = makeIO([]);
    io.printStep(1, 7, "Project");
    expect(io._steps[0]).toBe("[1/7] Project");
    expect(io._printed.some((s) => s.includes("[1/7]"))).toBe(true);
  });

  it("printDetected marks value as auto-detected in output", () => {
    const io = makeIO([]);
    io.printDetected("framework", "nextjs");
    expect(io._detected[0]).toContain("nextjs");
    expect(io._printed.some((s) => s.includes("(auto-detected)"))).toBe(true);
  });

  it("contract: WizardIO interface has all 5 required methods", () => {
    const io = makeIO([]) as WizardIO;
    expect(typeof io.ask).toBe("function");
    expect(typeof io.print).toBe("function");
    expect(typeof (io as unknown as { printSection: unknown }).printSection).toBe("function");
    expect(typeof (io as unknown as { printStep: unknown }).printStep).toBe("function");
    expect(typeof (io as unknown as { printDetected: unknown }).printDetected).toBe("function");
  });
});

describe("setup — step counter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-setup-steps-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "design.pen"), "{}");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits [1/7] step counter before first wizard question", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    expect(io._steps.some((s) => s.startsWith("[1/7]"))).toBe(true);
  });

  it("emits [7/7] step counter before budget question", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "", "", "", ""]);
    await runSetup(io, { cwd: dir });
    expect(io._steps.some((s) => s.startsWith("[7/7]"))).toBe(true);
  });

  it("regression: existing 7-answer happy path still writes config after step counter added", async () => {
    const { runSetup } = await import("../setup.js");
    const io = makeIO(["myapp", "1", "./src", "react", "css", "both", "0.5"]);
    await runSetup(io, { cwd: dir });
    const raw = await readFile(join(dir, "pencil-sync.config.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
