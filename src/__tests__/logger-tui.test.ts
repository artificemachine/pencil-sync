import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Logger has module-level state — import fresh
const loggerModule = await import("../logger.js");
const { log, setTuiEventHandler, clearTuiEventHandler } = loggerModule as typeof loggerModule & {
  setTuiEventHandler: (h: ((ev: { level: string; message: string; timestamp: number }) => void) | null) => void;
  clearTuiEventHandler: () => void;
};

describe("logger TUI hook", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    clearTuiEventHandler();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    clearTuiEventHandler();
  });

  describe("smoke", () => {
    it("setTuiEventHandler is exported and callable", () => {
      expect(() => setTuiEventHandler(null)).not.toThrow();
    });
  });

  describe("setTuiEventHandler", () => {
    it("installed handler is called instead of console.log when log.info fires", () => {
      const received: Array<{ level: string; message: string; timestamp: number }> = [];
      setTuiEventHandler((ev) => received.push(ev));

      log.info("hello from TUI");

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("info");
      expect(received[0].message).toContain("hello from TUI");
    });

    it("handler receives level, message, timestamp fields (TuiEvent shape)", () => {
      const before = Date.now();
      const received: Array<{ level: string; message: string; timestamp: number }> = [];
      setTuiEventHandler((ev) => received.push(ev));

      log.warn("shape check");

      const ev = received[0];
      expect(ev).toBeDefined();
      expect(typeof ev.level).toBe("string");
      expect(typeof ev.message).toBe("string");
      expect(typeof ev.timestamp).toBe("number");
      expect(ev.timestamp).toBeGreaterThanOrEqual(before);
    });

    it("clearTuiEventHandler restores console.log behavior", () => {
      const received: Array<unknown> = [];
      setTuiEventHandler((ev) => received.push(ev));
      clearTuiEventHandler();

      log.info("after clear");

      expect(received).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("regression: existing log calls work normally when no handler is set", () => {
      // clearTuiEventHandler was called in beforeEach — no handler active
      expect(() => log.info("no handler")).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("chaos: handler that throws — emit falls back to console.log and does not crash", () => {
      setTuiEventHandler(() => {
        throw new Error("handler boom");
      });

      expect(() => log.info("crash test")).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});
