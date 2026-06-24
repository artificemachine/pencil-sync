import { describe, it, expect } from "vitest";
import { matches, globToRegex } from "../glob-matcher.js";

describe("globToRegex", () => {
  it("matches simple extension glob", () => {
    const re = globToRegex("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
    expect(re.test("dir/foo.ts")).toBe(false);
  });

  it("matches ** recursive glob", () => {
    const re = globToRegex("**/*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("dir/foo.ts")).toBe(true);
    expect(re.test("a/b/c/foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
  });

  it("matches ? wildcard", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("fileA.ts")).toBe(true);
    expect(re.test("fileAB.ts")).toBe(false);
    expect(re.test("file.ts")).toBe(false);
  });

  it("expands {a,b} alternation", () => {
    const re = globToRegex("*.{tsx,jsx}");
    expect(re.test("x.tsx")).toBe(true);
    expect(re.test("x.jsx")).toBe(true);
    expect(re.test("x.css")).toBe(false);
    expect(re.test("x.ts")).toBe(false);
  });

  it("expands brace patterns with ** prefix", () => {
    const re = globToRegex("**/*.{tsx,jsx}");
    expect(re.test("x.tsx")).toBe(true);
    expect(re.test("x.jsx")).toBe(true);
    expect(re.test("components/Button.tsx")).toBe(true);
    expect(re.test("components/Button.jsx")).toBe(true);
    expect(re.test("components/Button.css")).toBe(false);
  });

  it("supports [..] character classes", () => {
    const re = globToRegex("file-[abc].ts");
    expect(re.test("file-a.ts")).toBe(true);
    expect(re.test("file-b.ts")).toBe(true);
    expect(re.test("file-c.ts")).toBe(true);
    expect(re.test("file-d.ts")).toBe(false);
    expect(re.test("file-.ts")).toBe(false);
  });

  it("supports negated character classes [^..]", () => {
    const re = globToRegex("file-[^abc].ts");
    expect(re.test("file-d.ts")).toBe(true);
    expect(re.test("file-a.ts")).toBe(false);
  });
});

describe("matches", () => {
  it("returns true when any glob matches", () => {
    expect(matches("src/Button.tsx", ["**/*.tsx", "**/*.jsx"])).toBe(true);
    expect(matches("src/Button.jsx", ["**/*.tsx", "**/*.jsx"])).toBe(true);
    expect(matches("src/Button.css", ["**/*.tsx", "**/*.jsx"])).toBe(false);
  });

  it("returns false for empty glob list", () => {
    expect(matches("any/path.ts", [])).toBe(false);
  });

  it("handles brace expansion in matches()", () => {
    expect(matches("comp.tsx", ["*.{tsx,jsx}"])).toBe(true);
    expect(matches("comp.jsx", ["*.{tsx,jsx}"])).toBe(true);
    expect(matches("comp.css", ["*.{tsx,jsx}"])).toBe(false);
  });

  it("normalises Windows backslashes", () => {
    expect(matches("src\\Button.tsx", ["**/*.tsx"])).toBe(true);
  });
});

describe("ReDoS guard", () => {
  it("completes within 100ms for a deeply-nested pattern", () => {
    const pathological = "a/".repeat(50) + "b.ts";
    const start = process.hrtime.bigint();
    const result = matches(pathological, ["**/**/**/**/**/**/**/**/**/**/**/**/**/**/*.ts"]);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(elapsedMs).toBeLessThan(100);
    expect(typeof result).toBe("boolean");
  });

  it("completes within 100ms for many alternation branches", () => {
    const manyBranches = "*.{ts,tsx,js,jsx,css,scss,less,html,vue,svelte}";
    const start = process.hrtime.bigint();
    const result = matches("component.tsx", [manyBranches]);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(elapsedMs).toBeLessThan(100);
    expect(result).toBe(true);
  });

  // Iter 8 — pathological multi-**/ on a deep non-matching path
  it("Iter 8 — pathological **/ glob matches in bounded time (<50ms) on a long non-match", () => {
    // 20 **/ groups on a 100-deep path that does NOT match (wrong extension)
    const pathological = "a/".repeat(100) + "b.nonexistent";
    const pattern = "**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/**/*.ts";
    const start = process.hrtime.bigint();
    const result = matches(pathological, [pattern]);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(50);
  });

  // Iter 8 — regex cache: same glob should reuse the RegExp object
  it("Iter 8 — repeated globToRegex calls return the same cached RegExp object", () => {
    const re1 = globToRegex("**/*.tsx");
    const re2 = globToRegex("**/*.tsx");
    expect(re1).toBe(re2); // same reference, not just equal
  });
});

describe("Iter 8 — correctness fixes", () => {
  it("[!abc] POSIX negation negates matching chars", () => {
    const re = globToRegex("[!abc].ts");
    expect(re.test("d.ts")).toBe(true);
    expect(re.test("a.ts")).toBe(false);
    expect(re.test("b.ts")).toBe(false);
  });

  it("backslash in glob pattern is normalized to forward slash", () => {
    // Windows-style glob: src\*.ts should match src/foo.ts
    const re = globToRegex("src\\*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/bar.ts")).toBe(true);
    expect(re.test("other/foo.ts")).toBe(false);
  });

  it("unterminated brace is treated as literal, not silently collapsed", () => {
    // {ts,tsx without closing } — should NOT silently match only "ts" and drop "tsx"
    // The correct behavior: literal `{ts,tsx` in the pattern
    const re = globToRegex("*.{ts,tsx");
    // A correctly escaped literal brace means neither ts nor tsx match via alternation;
    // the pattern matches the literal string "{ts,tsx" after the wildcard.
    expect(re.test("foo.{ts,tsx")).toBe(true);
    expect(re.test("foo.ts")).toBe(false);
  });
});
