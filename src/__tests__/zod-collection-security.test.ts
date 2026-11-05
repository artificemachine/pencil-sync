import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("Zod bounded collection validation", () => {
  it("rejects oversized arrays before validating their elements", () => {
    const inspectElement = vi.fn((value: unknown) => value);
    const schema = z.array(z.preprocess(inspectElement, z.string())).max(2);

    const result = schema.safeParse([1, 2, 3]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected oversized array rejection");
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({
      code: "too_big",
      maximum: 2,
      path: [],
    });
    expect(inspectElement).not.toHaveBeenCalled();
  });

  it("still validates every element of an array within its size limit", () => {
    const inspectElement = vi.fn((value: unknown) => value);
    const schema = z.array(z.preprocess(inspectElement, z.string())).max(2);

    expect(schema.parse(["first", "second"])).toEqual(["first", "second"]);
    expect(inspectElement).toHaveBeenCalledTimes(2);
    expect(schema.safeParse([1]).success).toBe(false);
  });

  it("preserves transformations applied before the size constraint", () => {
    const schema = z.array(z.number()).overwrite((values) => values.slice(0, 2)).max(2);

    expect(schema.parse([1, 2, 3])).toEqual([1, 2]);
  });
});
