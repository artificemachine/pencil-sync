import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude-runner.js", () => ({
  runClaude: vi.fn(),
}));

const { LocalClaudeExecutor, localClaudeExecutor } = await import("../executor.js");
const { runClaude } = await import("../claude-runner.js");
const mockedRunClaude = vi.mocked(runClaude);

describe("LocalClaudeExecutor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("instantiates without throwing (smoke)", () => {
    const executor = new LocalClaudeExecutor();
    expect(executor).toBeDefined();
  });

  it("run delegates to runClaude with the same options", async () => {
    const executor = new LocalClaudeExecutor();
    const opts = { prompt: "test prompt", model: "claude-sonnet-4-6" };
    const mockResult = { success: true, stdout: "result", stderr: "", exitCode: 0 };
    mockedRunClaude.mockResolvedValue(mockResult);

    await executor.run(opts);

    expect(mockedRunClaude).toHaveBeenCalledOnce();
    expect(mockedRunClaude).toHaveBeenCalledWith(opts);
  });

  it("run returns the runClaude result unchanged", async () => {
    const executor = new LocalClaudeExecutor();
    const opts = { prompt: "test", model: "claude-sonnet-4-6" };
    const mockResult = {
      success: true,
      stdout: "hello world",
      stderr: "debug info",
      exitCode: 0,
      tokenUsage: { input: 100, output: 50 },
    };
    mockedRunClaude.mockResolvedValue(mockResult);

    const result = await executor.run(opts);

    expect(result).toStrictEqual(mockResult);
  });

  it("localClaudeExecutor satisfies Executor interface (contract)", () => {
    expect(typeof localClaudeExecutor.run).toBe("function");
  });
});
