import { describe, it, expect } from "vitest";
import { IGNORED_DIRS, IGNORED_GLOBS } from "../ignored-dirs.js";

const EXPECTED_NAMES = ["node_modules", ".git", "dist", ".next"];

describe("ignored-dirs", () => {
  it("exposes the same dir set in both name and glob form", () => {
    for (const name of EXPECTED_NAMES) {
      expect(IGNORED_DIRS.has(name), `IGNORED_DIRS missing: ${name}`).toBe(true);
      const hasGlob = IGNORED_GLOBS.some((g) => g.includes(name));
      expect(hasGlob, `IGNORED_GLOBS missing entry for: ${name}`).toBe(true);
    }
  });

  it("IGNORED_DIRS and IGNORED_GLOBS cover the same names", () => {
    for (const name of IGNORED_DIRS) {
      const hasGlob = IGNORED_GLOBS.some((g) => g.includes(name));
      expect(hasGlob, `IGNORED_GLOBS has no entry for IGNORED_DIRS name: ${name}`).toBe(true);
    }
  });
});
