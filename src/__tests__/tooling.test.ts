import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../../");

async function readPackageJson() {
  const raw = await readFile(resolve(projectRoot, "package.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("ESLint tooling", () => {
  it("package.json has a lint script", async () => {
    const pkg = await readPackageJson();
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts).toHaveProperty("lint");
    expect(typeof scripts.lint).toBe("string");
    expect(scripts.lint.length).toBeGreaterThan(0);
  });

  it("eslint.config.js exists at the project root", async () => {
    const content = await readFile(resolve(projectRoot, "eslint.config.js"), "utf8");
    expect(content.length).toBeGreaterThan(0);
  });
});

describe("Coverage tooling", () => {
  it("package.json has a test:coverage script", async () => {
    const pkg = await readPackageJson();
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts).toHaveProperty("test:coverage");
    expect(scripts["test:coverage"]).toContain("coverage");
  });

  it("vitest.config.ts has coverage thresholds configured", async () => {
    const content = await readFile(resolve(projectRoot, "vitest.config.ts"), "utf8");
    expect(content).toContain("thresholds");
    expect(content).toMatch(/lines\s*:\s*\d+/);
    expect(content).toMatch(/functions\s*:\s*\d+/);
    expect(content).toMatch(/branches\s*:\s*\d+/);
    expect(content).toMatch(/statements\s*:\s*\d+/);
  });
});
