import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = join(root, "dist", "mcp-server.js");

beforeAll(async () => {
  await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], {
    cwd: root,
    timeout: 25_000,
  });
}, 30_000);

describe("MCP executable startup", () => {
  it.each(["direct", "symlink"])("serves the protocol through the %s entry", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pencil-mcp-launcher-"));
    const client = new Client({ name: "launcher-regression", version: "1.0.0" });
    let transport: StdioClientTransport | undefined;
    try {
      let executable = entry;
      if (mode === "symlink") {
        executable = join(directory, "pencil-sync-mcp");
        await symlink(entry, executable);
      }
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [executable],
        cwd: directory,
        stderr: "pipe",
      });
      await client.connect(transport);

      expect(client.getServerVersion()?.name).toBe("pencil-sync");
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "pencil_get_config",
        "pencil_diff_design",
        "pencil_diff_code",
      ]));
    } finally {
      await client.close();
      await transport?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["no entry", "unrelated entry", "missing entry"])(
    "does not start the transport when imported with %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "pencil-mcp-import-"));
      try {
        const unrelated = join(directory, "host.js");
        if (mode === "unrelated entry") await writeFile(unrelated, "");
        const script = `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log("imported");`;
        const args = ["--input-type=module", "--eval", script];
        if (mode !== "no entry") args.push(unrelated);
        const result = await run(process.execPath, args, { cwd: directory, timeout: 5_000 });

        expect(result.stdout).toBe("imported\n");
        expect(result.stderr).toBe("");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
