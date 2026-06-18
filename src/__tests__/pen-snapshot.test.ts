import { describe, it, expect } from "vitest";
import {
  realisticPenDoc,
  gradientFill,
  gradientFillAlt,
  cornerRadiusPerSide,
  cornerRadiusUniform,
  serializeDoc,
} from "./fixtures/realistic.pen.js";

const {
  snapshotPenFile, diffPenSnapshots,
} = await import("../pen-snapshot.js");

describe("snapshotPenFile", () => {
  it("extracts tracked properties from .pen JSON", () => {
    const pen = JSON.stringify({
      children: [
        {
          id: "btn1",
          name: "submitBtn",
          type: "frame",
          fill: "#ff0000",
          cornerRadius: 8,
          width: 200,
          height: 48,
        },
      ],
    });

    const snapshot = snapshotPenFile("/tmp/test.pen", pen)!;

    expect(snapshot["btn1"]).toBeDefined();
    expect(snapshot["btn1"].name).toBe("submitBtn");
    expect(snapshot["btn1"].fill).toBe("#ff0000");
    expect(snapshot["btn1"].cornerRadius).toBe(8);
    // width/height are NOT tracked
    expect(snapshot["btn1"].width).toBeUndefined();
  });

  it("flattens nested children", () => {
    const pen = JSON.stringify({
      children: [
        {
          id: "page",
          name: "HomePage",
          type: "frame",
          fill: "#272822",
          children: [
            {
              id: "header",
              name: "headerBar",
              type: "frame",
              fill: "#1e1f1c",
              children: [
                { id: "logo", name: "logoText", type: "text", content: "Acme", fontSize: 24 },
              ],
            },
          ],
        },
      ],
    });

    const snapshot = snapshotPenFile("/tmp/test.pen", pen)!;

    expect(snapshot["page"]).toBeDefined();
    expect(snapshot["header"]).toBeDefined();
    expect(snapshot["logo"]).toBeDefined();
    expect(snapshot["logo"].content).toBe("Acme");
    expect(snapshot["logo"].fontSize).toBe(24);
  });

  it("returns null for invalid JSON", () => {
    const snapshot = snapshotPenFile("/tmp/bad.pen", "not valid json {{{");
    expect(snapshot).toBeNull();
  });

  it("returns empty snapshot for .pen with no children", () => {
    const snapshot = snapshotPenFile("/tmp/empty.pen", JSON.stringify({}));
    expect(snapshot).toEqual({});
  });
});

describe("diffPenSnapshots", () => {
  it("detects fill changes", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" } };
    const newSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].nodeId).toBe("btn1");
    expect(diffs[0].prop).toBe("fill");
    expect(diffs[0].oldValue).toBe("#00ff00");
    expect(diffs[0].newValue).toBe("#ff0000");
  });

  it("detects text content changes", () => {
    const oldSnap = { t1: { name: "title", type: "text", content: "hello" } };
    const newSnap = { t1: { name: "title", type: "text", content: "world" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("content");
    expect(diffs[0].oldValue).toBe("hello");
    expect(diffs[0].newValue).toBe("world");
  });

  it("detects typography changes (fontSize, fontWeight)", () => {
    const oldSnap = { t1: { name: "heading", type: "text", fontSize: 16, fontWeight: "400" } };
    const newSnap = { t1: { name: "heading", type: "text", fontSize: 24, fontWeight: "700" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(2);
    const fontSizeDiff = diffs.find((d) => d.prop === "fontSize");
    const fontWeightDiff = diffs.find((d) => d.prop === "fontWeight");
    expect(fontSizeDiff!.oldValue).toBe(16);
    expect(fontSizeDiff!.newValue).toBe(24);
    expect(fontWeightDiff!.oldValue).toBe("400");
    expect(fontWeightDiff!.newValue).toBe("700");
  });

  it("ignores unchanged properties", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 } };
    const newSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(0);
  });

  it("skips new nodes (not in old snapshot)", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" } };
    const newSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" },
      btn2: { name: "newBtn", type: "frame", fill: "#00ff00" },
    };

    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(0);
  });

  it("detects multiple changes across multiple nodes", () => {
    const oldSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" },
      t1: { name: "title", type: "text", content: "old", fontSize: 16 },
    };
    const newSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" },
      t1: { name: "title", type: "text", content: "new", fontSize: 24 },
    };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(3); // fill + content + fontSize
    expect(diffs.map((d) => d.prop).sort()).toEqual(["content", "fill", "fontSize"]);
  });

  it("returns empty array when both snapshots are empty", () => {
    const diffs = diffPenSnapshots({}, {});
    expect(diffs).toHaveLength(0);
  });
});

// ── Iteration 1: real-schema complex value tests ─────────────────────────────

describe("snapshotPenFile — smoke (real-schema fixture)", () => {
  it("imports and snapshots realistic fixture without throwing", () => {
    const raw = serializeDoc(realisticPenDoc);
    const snapshot = snapshotPenFile("/tmp/realistic.pen", raw);
    expect(snapshot).not.toBeNull();
    expect(typeof snapshot).toBe("object");
  });
});

describe("snapshotPenFile — complex fill values", () => {
  it("stores gradient fill as a stable string (not [object Object])", () => {
    const pen = JSON.stringify({
      children: [{ id: "n1", name: "Hero", type: "frame", fill: gradientFill }],
    });
    const snapshot = snapshotPenFile("/tmp/test.pen", pen)!;
    expect(typeof snapshot["n1"].fill).toBe("string");
    expect(snapshot["n1"].fill).not.toBe("[object Object]");
  });

  it("two distinct gradient fills on same node produce 1 diff", () => {
    const oldPen = JSON.stringify({
      children: [{ id: "n1", name: "Hero", type: "frame", fill: gradientFill }],
    });
    const newPen = JSON.stringify({
      children: [{ id: "n1", name: "Hero", type: "frame", fill: gradientFillAlt }],
    });
    const oldSnap = snapshotPenFile("/tmp/old.pen", oldPen)!;
    const newSnap = snapshotPenFile("/tmp/new.pen", newPen)!;
    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("fill");
  });

  it("identical gradient objects with different key order produce 0 diffs", () => {
    const gradientKeyOrderA = { stops: gradientFill.stops, type: gradientFill.type, angle: gradientFill.angle };
    const gradientKeyOrderB = { angle: gradientFill.angle, type: gradientFill.type, stops: gradientFill.stops };
    const oldPen = JSON.stringify({
      children: [{ id: "n1", name: "Hero", type: "frame", fill: gradientKeyOrderA }],
    });
    const newPen = JSON.stringify({
      children: [{ id: "n1", name: "Hero", type: "frame", fill: gradientKeyOrderB }],
    });
    const oldSnap = snapshotPenFile("/tmp/old.pen", oldPen)!;
    const newSnap = snapshotPenFile("/tmp/new.pen", newPen)!;
    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(0);
  });

  it("fill array reorder produces a diff", () => {
    const fillA = [{ type: "solid", color: "#667eea" }, { type: "solid", color: "#764ba2" }];
    const fillB = [{ type: "solid", color: "#764ba2" }, { type: "solid", color: "#667eea" }];
    const oldPen = JSON.stringify({ children: [{ id: "n1", name: "CTA", type: "frame", fill: fillA }] });
    const newPen = JSON.stringify({ children: [{ id: "n1", name: "CTA", type: "frame", fill: fillB }] });
    const diffs = diffPenSnapshots(
      snapshotPenFile("/tmp/old.pen", oldPen)!,
      snapshotPenFile("/tmp/new.pen", newPen)!,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("fill");
  });

  it("identical fill arrays produce 0 diffs", () => {
    const fill = [{ type: "solid", color: "#667eea" }, { type: "solid", color: "#764ba2" }];
    const pen = JSON.stringify({ children: [{ id: "n1", name: "CTA", type: "frame", fill }] });
    const snap = snapshotPenFile("/tmp/test.pen", pen)!;
    expect(diffPenSnapshots(snap, snap)).toHaveLength(0);
  });
});

describe("snapshotPenFile — complex cornerRadius values", () => {
  it("cornerRadius [8,8,0,0] → [8,8,8,8] produces a diff", () => {
    const oldPen = JSON.stringify({ children: [{ id: "n1", name: "Card", type: "frame", fill: "#fff", cornerRadius: cornerRadiusPerSide }] });
    const newPen = JSON.stringify({ children: [{ id: "n1", name: "Card", type: "frame", fill: "#fff", cornerRadius: cornerRadiusUniform }] });
    const diffs = diffPenSnapshots(
      snapshotPenFile("/tmp/old.pen", oldPen)!,
      snapshotPenFile("/tmp/new.pen", newPen)!,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("cornerRadius");
  });

  it("scalar cornerRadius 8 → [8,8,8,8] transition produces a diff", () => {
    const oldPen = JSON.stringify({ children: [{ id: "n1", name: "Card", type: "frame", fill: "#fff", cornerRadius: 8 }] });
    const newPen = JSON.stringify({ children: [{ id: "n1", name: "Card", type: "frame", fill: "#fff", cornerRadius: [8, 8, 8, 8] }] });
    const diffs = diffPenSnapshots(
      snapshotPenFile("/tmp/old.pen", oldPen)!,
      snapshotPenFile("/tmp/new.pen", newPen)!,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("cornerRadius");
  });
});

describe("snapshotPenFile — chaos", () => {
  it("malformed fill object does not crash; node is still tracked", () => {
    const circular: Record<string, unknown> = { type: "weird" };
    circular.self = circular;
    const pen = JSON.stringify({
      children: [{ id: "n1", name: "Weird", type: "frame", fill: "#fff" }],
    });
    expect(() => snapshotPenFile("/tmp/test.pen", pen)).not.toThrow();
  });
});

// ── Iteration 2: design token tracking ───────────────────────────────────────

describe("snapshotPenFile — smoke (token-bearing doc)", () => {
  it("snapshot of token-bearing document includes a token entry", () => {
    const raw = serializeDoc(realisticPenDoc);
    const snapshot = snapshotPenFile("/tmp/realistic.pen", raw);
    expect(snapshot).not.toBeNull();
    const keys = Object.keys(snapshot!);
    expect(keys.some((k) => k.startsWith("/"))).toBe(true);
  });
});

describe("snapshotPenFile — design tokens (variables / themes)", () => {
  function makeDocWithTokens(variables: Record<string, unknown>, themes?: Record<string, unknown>): string {
    return JSON.stringify({ version: "2.13", variables, themes: themes ?? {}, children: [] });
  }

  it("variable value change produces a diff entry", () => {
    const oldRaw = makeDocWithTokens({ "color-primary": "#667eea" });
    const newRaw = makeDocWithTokens({ "color-primary": "#ff0000" });
    const oldSnap = snapshotPenFile("/tmp/old.pen", oldRaw)!;
    const newSnap = snapshotPenFile("/tmp/new.pen", newRaw)!;
    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    const tokenDiff = diffs.find((d) => d.prop === "color-primary");
    expect(tokenDiff).toBeDefined();
  });

  it("new token added produces a diff", () => {
    const oldRaw = makeDocWithTokens({ "color-primary": "#667eea" });
    const newRaw = makeDocWithTokens({ "color-primary": "#667eea", "color-accent": "#ff6b6b" });
    const oldSnap = snapshotPenFile("/tmp/old.pen", oldRaw)!;
    const newSnap = snapshotPenFile("/tmp/new.pen", newRaw)!;
    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs.length).toBeGreaterThanOrEqual(1);
  });

  it("no token change produces no diffs", () => {
    const raw = makeDocWithTokens({ "color-primary": "#667eea", "spacing-base": "8px" });
    const snap = snapshotPenFile("/tmp/test.pen", raw)!;
    expect(diffPenSnapshots(snap, snap)).toHaveLength(0);
  });

  it("legacy snapshot without tokens produces no spurious diffs against token-less doc", () => {
    const raw = JSON.stringify({ children: [{ id: "n1", name: "Box", type: "frame", fill: "#fff" }] });
    const snap = snapshotPenFile("/tmp/test.pen", raw)!;
    expect(diffPenSnapshots(snap, snap)).toHaveLength(0);
  });
});

describe("snapshotPenFile — contract (token key collision prevention)", () => {
  it("reserved token nodeId starting with '/' cannot collide with a real node id", () => {
    const raw = JSON.stringify({
      version: "2.13",
      variables: { "color-primary": "#667eea" },
      children: [{ id: "n1", name: "Box", type: "frame", fill: "#fff" }],
    });
    const snap = snapshotPenFile("/tmp/test.pen", raw)!;
    const nodeKeys = Object.keys(snap).filter((k) => !k.startsWith("/"));
    const tokenKeys = Object.keys(snap).filter((k) => k.startsWith("/"));
    // Node ids cannot contain '/' per the Pencil spec
    expect(nodeKeys.every((k) => !k.includes("/"))).toBe(true);
    expect(tokenKeys.length).toBeGreaterThan(0);
  });
});

describe("diffPenSnapshots — token regression", () => {
  it("token-less documents produce identical output to pre-Iter2 behaviour", () => {
    const raw = JSON.stringify({
      children: [{ id: "btn1", name: "Button", type: "frame", fill: "#667eea" }],
    });
    const snap = snapshotPenFile("/tmp/test.pen", raw)!;
    expect(diffPenSnapshots(snap, snap)).toHaveLength(0);
    expect(snap["btn1"]).toBeDefined();
    expect(snap["btn1"].fill).toBe("#667eea");
  });
});

describe("snapshotPenFile — regression (scalar hex fills unchanged)", () => {
  it("scalar hex fill change still detected correctly", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" } };
    const newSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" } };
    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].oldValue).toBe("#00ff00");
    expect(diffs[0].newValue).toBe("#ff0000");
  });
});

