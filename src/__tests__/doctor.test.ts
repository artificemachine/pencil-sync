import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoist mock so it's accessible inside vi.mock()
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execFile: vi.fn(),
}));

const { runDoctor } = await import("../doctor.js");

/** Scaffold a minimal valid project in a temp dir and return the config path. */
async function scaffoldProject(
  dir: string,
  opts: { noPenFile?: boolean; noSrcDir?: boolean; budget?: number; badConfig?: boolean; noConfig?: boolean } = {},
): Promise<string> {
  if (!opts.noSrcDir) {
    await mkdir(join(dir, "src"), { recursive: true });
  }
  if (!opts.noPenFile) {
    await writeFile(join(dir, "design.pen"), "{}");
  }

  const configPath = join(dir, "pencil-sync.config.json");

  if (opts.noConfig) return configPath; // caller wants no config

  if (opts.badConfig) {
    await writeFile(configPath, "{ broken json ]]]");
    return configPath;
  }

  const config = {
    version: 1,
    mappings: [
      {
        id: "test-mapping",
        penFile: "./design.pen",
        codeDir: "./src",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      },
    ],
    settings: {
      maxBudgetUsd: opts.budget ?? 0.5,
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

describe("doctor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-doctor-"));
    // Default: claude binary check succeeds
    execFileSyncMock.mockReturnValue(undefined);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Smoke
  it("runDoctor returns DoctorResult without throwing", async () => {
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    expect(result).toBeDefined();
  });

  // Check (a) — Claude binary
  it("check_a_passes when execFileSync succeeds (claude on PATH)", async () => {
    execFileSyncMock.mockReturnValue(undefined);
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Claude CLI"));
    expect(check?.passed).toBe(true);
  });

  it("check_a_fails when execFileSync throws ENOENT (claude not found)", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
    });
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Claude CLI"));
    expect(check?.passed).toBe(false);
  });

  // Check (b) — Config valid
  it("check_b_passes for a valid config file", async () => {
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Config"));
    expect(check?.passed).toBe(true);
  });

  it("check_b_fails when config file does not exist", async () => {
    const result = await runDoctor(join(dir, "nonexistent.json"));
    const check = result.checks.find((c) => c.label.includes("Config"));
    expect(check?.passed).toBe(false);
  });

  it("check_b_fails when config file contains invalid JSON", async () => {
    const configPath = await scaffoldProject(dir, { badConfig: true });
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Config"));
    expect(check?.passed).toBe(false);
  });

  // Check (c) — pen file accessible
  it("check_c_passes when pen file exists and is readable", async () => {
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("pen file"));
    expect(check?.passed).toBe(true);
  });

  it("check_c_fails when pen file is missing", async () => {
    const configPath = await scaffoldProject(dir, { noPenFile: true });
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("pen file"));
    expect(check?.passed).toBe(false);
  });

  // Check (d) — codeDir accessible
  it("check_d_passes when codeDir exists", async () => {
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("code directory"));
    expect(check?.passed).toBe(true);
  });

  it("check_d_fails when codeDir is missing", async () => {
    const configPath = await scaffoldProject(dir, { noSrcDir: true });
    // write a valid pen file so check (c) passes
    await writeFile(join(dir, "design.pen"), "{}");
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("code directory"));
    expect(check?.passed).toBe(false);
  });

  // Check (e) — globs match files
  it("check_e_passes when codeGlobs match at least one file", async () => {
    const configPath = await scaffoldProject(dir);
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() {}");
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("globs"));
    expect(check?.passed).toBe(true);
  });

  it("check_e_fails when no files match the codeGlobs", async () => {
    const configPath = await scaffoldProject(dir);
    // src/ exists but has no .tsx files
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("globs"));
    expect(check?.passed).toBe(false);
  });

  // Check (f) — budget > 0
  it("check_f_passes when maxBudgetUsd is positive", async () => {
    const configPath = await scaffoldProject(dir, { budget: 0.5 });
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Budget"));
    expect(check?.passed).toBe(true);
  });

  it("check_f_fails when maxBudgetUsd is zero", async () => {
    const configPath = await scaffoldProject(dir, { budget: 0 });
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Budget"));
    expect(check?.passed).toBe(false);
  });

  // allPassed
  it("allPassed is true when every check passes", async () => {
    execFileSyncMock.mockReturnValue(undefined);
    const configPath = await scaffoldProject(dir);
    await writeFile(join(dir, "src", "App.tsx"), "component");
    const result = await runDoctor(configPath);
    expect(result.allPassed).toBe(result.checks.every((c) => c.passed));
  });

  it("allPassed is false when at least one check fails", async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("not found"); });
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    expect(result.allPassed).toBe(false);
  });

  // Contract — DoctorResult shape
  it("DoctorResult has checks array with label + passed per entry", async () => {
    const configPath = await scaffoldProject(dir);
    const result = await runDoctor(configPath);
    expect(typeof result.allPassed).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    for (const check of result.checks) {
      expect(typeof check.label).toBe("string");
      expect(typeof check.passed).toBe("boolean");
    }
  });

  // Regression
  it("regression: doctor module imports cleanly alongside existing modules", async () => {
    const { loadConfig } = await import("../config.js");
    expect(typeof loadConfig).toBe("function");
    const { runDoctor: rd } = await import("../doctor.js");
    expect(typeof rd).toBe("function");
  });

  // Chaos
  it("chaos: corrupt config JSON does not throw — returns config check failed", async () => {
    const configPath = await scaffoldProject(dir, { badConfig: true });
    let threw = false;
    try {
      await runDoctor(configPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const result = await runDoctor(configPath);
    const check = result.checks.find((c) => c.label.includes("Config"));
    expect(check?.passed).toBe(false);
  });

  it("chaos: missing codeDir does not throw — returns code directory check failed", async () => {
    const configPath = await scaffoldProject(dir, { noSrcDir: true });
    await writeFile(join(dir, "design.pen"), "{}");
    let threw = false;
    try {
      await runDoctor(configPath);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  // E2E — full passing project
  it("e2e: all non-binary checks pass on a fully configured project", async () => {
    execFileSyncMock.mockReturnValue(undefined);
    const configPath = await scaffoldProject(dir, { budget: 0.5 });
    await writeFile(join(dir, "src", "App.tsx"), "component");

    const result = await runDoctor(configPath);

    const nonBinaryChecks = result.checks.filter((c) => !c.label.includes("Claude CLI"));
    expect(nonBinaryChecks.every((c) => c.passed)).toBe(true);
    expect(result.allPassed).toBe(true); // claude mock returns success
  });
});
