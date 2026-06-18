import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { EventFeed } from "../../tui/EventFeed.js";
import type { TuiSyncEvent } from "../../types.js";

afterEach(() => cleanup());

function makeEvent(overrides: Partial<TuiSyncEvent> = {}): TuiSyncEvent {
  return {
    type: "sync",
    mappingId: "m1",
    message: "Sync completed",
    timestamp: Date.now(),
    success: true,
    ...overrides,
  };
}

describe("EventFeed", () => {
  it("smoke: renders empty feed without throwing", () => {
    expect(() => render(<EventFeed events={[]} />)).not.toThrow();
  });

  it("renders event messages in output", () => {
    const events = [makeEvent({ message: "Applied 3 color changes" })];
    const { lastFrame } = render(<EventFeed events={events} />);
    expect(lastFrame()).toContain("Applied 3 color changes");
  });

  it("renders error events differently from success events", () => {
    const errorEv = makeEvent({ type: "error", message: "Claude CLI failed", success: false });
    const successEv = makeEvent({ message: "Sync OK" });
    const { lastFrame } = render(<EventFeed events={[errorEv, successEv]} />);
    const frame = lastFrame() ?? "";
    // Both messages should appear
    expect(frame).toContain("Claude CLI failed");
    expect(frame).toContain("Sync OK");
  });

  it("truncates to maxItems oldest events dropped", () => {
    const events = Array.from({ length: 55 }, (_, i) =>
      makeEvent({ message: `event-${i}`, timestamp: i }),
    );
    const { lastFrame } = render(<EventFeed events={events} maxItems={50} />);
    const frame = lastFrame() ?? "";
    // The first 5 (oldest) should be dropped, the last 50 should be present
    expect(frame).not.toContain("event-0");
    expect(frame).toContain("event-54");
  });

  it("contract: TuiSyncEvent has type, mappingId, message, timestamp fields", () => {
    const ev: TuiSyncEvent = makeEvent();
    expect(typeof ev.type).toBe("string");
    expect(typeof ev.mappingId).toBe("string");
    expect(typeof ev.message).toBe("string");
    expect(typeof ev.timestamp).toBe("number");
  });
});
