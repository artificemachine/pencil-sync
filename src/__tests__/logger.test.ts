import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Logger has module-level state — re-import fresh each suite via dynamic import with cache bust
const loggerModule = await import("../logger.js");
const { log, setLogLevel, setMcpMode } = loggerModule;

describe("logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogLevel("debug");
    setMcpMode(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setMcpMode(false);
  });

  describe("smoke", () => {
    it("setMcpMode is exported and callable", () => {
      expect(() => setMcpMode(true)).not.toThrow();
      expect(() => setMcpMode(false)).not.toThrow();
    });
  });

  describe("MCP mode — output routing", () => {
    it("setMcpMode(true) redirects log.debug to stderr", () => {
      setMcpMode(true);
      log.debug("test debug");
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("test debug");
    });

    it("setMcpMode(true) redirects log.info to stderr", () => {
      setMcpMode(true);
      log.info("test info");
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("test info");
    });

    it("setMcpMode(true) redirects log.success to stderr", () => {
      setMcpMode(true);
      log.success("test success");
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("test success");
    });

    it("setMcpMode(true) redirects log.sync to stderr", () => {
      setMcpMode(true);
      log.sync("pen-to-code", "map1", "test sync");
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("test sync");
    });

    it("setMcpMode(false) keeps log.info on stdout", () => {
      setMcpMode(false);
      log.info("test stdout info");
      // In non-MCP mode, console.log is used — process.stdout.write may be called
      // indirectly. We verify stderr was NOT called with our message.
      const stderrContent = stderrSpy.mock.calls.map(c => String(c[0])).join("");
      expect(stderrContent).not.toContain("test stdout info");
    });

    it("log.warn and log.error use stderr regardless of MCP mode", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        // Non-MCP mode
        setMcpMode(false);
        log.warn("warn msg");
        log.error("error msg");
        expect(warnSpy).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        const warnArg = String(warnSpy.mock.calls[0]?.[0] ?? "");
        const errArg = String(errorSpy.mock.calls[0]?.[0] ?? "");
        expect(warnArg).toContain("warn msg");
        expect(errArg).toContain("error msg");

        warnSpy.mockClear();
        errorSpy.mockClear();

        // MCP mode — still uses console.warn/error (already stderr)
        setMcpMode(true);
        log.warn("warn mcp");
        log.error("error mcp");
        expect(warnSpy).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        const warnArgMcp = String(warnSpy.mock.calls[0]?.[0] ?? "");
        const errArgMcp = String(errorSpy.mock.calls[0]?.[0] ?? "");
        expect(warnArgMcp).toContain("warn mcp");
        expect(errArgMcp).toContain("error mcp");
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe("regression — CLI mode unchanged", () => {
    it("in default (non-MCP) mode, log.debug does not write to stderr", () => {
      setMcpMode(false);
      log.debug("cli debug");
      const stderrContent = stderrSpy.mock.calls.map(c => String(c[0])).join("");
      expect(stderrContent).not.toContain("cli debug");
    });
  });
});
