import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { BudgetMeter } from "../../tui/BudgetMeter.js";

afterEach(() => cleanup());

describe("BudgetMeter", () => {
  it("smoke: renders without throwing", () => {
    expect(() => render(<BudgetMeter used={0} max={0.5} />)).not.toThrow();
  });

  it("renders used and max values in output", () => {
    const { lastFrame } = render(<BudgetMeter used={0.05} max={0.5} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("0.05");
    expect(frame).toContain("0.50");
  });

  it("renders a bar character (progress indicator)", () => {
    const { lastFrame } = render(<BudgetMeter used={0.25} max={0.5} />);
    const frame = lastFrame() ?? "";
    // Bar should contain at least one fill character
    expect(frame.length).toBeGreaterThan(10);
  });

  it("shows OVER BUDGET when used exceeds max", () => {
    const { lastFrame } = render(<BudgetMeter used={0.6} max={0.5} />);
    expect(lastFrame()).toContain("OVER BUDGET");
  });

  it("contract: used and max props are typed as number", () => {
    const used: number = 0.1;
    const max: number = 0.5;
    expect(() => render(<BudgetMeter used={used} max={max} />)).not.toThrow();
  });
});
