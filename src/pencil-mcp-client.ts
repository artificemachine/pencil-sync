import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "./logger.js";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export type PencilNodeData = Record<string, Record<string, string | number | boolean | null>>;

export class PencilMcpClient {
  private configPath: string;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(mcpConfigPath: string) {
    this.configPath = mcpConfigPath.startsWith("~/")
      ? mcpConfigPath.replace("~", process.env["HOME"] ?? "~")
      : mcpConfigPath;
  }

  private async loadServerEntry(): Promise<McpServerEntry> {
    const raw = await readFile(this.configPath, "utf-8");
    const config = JSON.parse(raw) as McpConfigFile;

    // Support { mcpServers: { pencil: ... } } and flat { pencil: ... }
    const servers = config.mcpServers ?? (config as Record<string, unknown>);
    const entry = (servers as Record<string, unknown>)["pencil"];

    if (!entry || typeof entry !== "object" || !("command" in entry)) {
      throw new Error(
        `No valid 'pencil' server entry found in MCP config at ${this.configPath}. ` +
          `Expected { mcpServers: { pencil: { command: "...", args: [] } } }.`,
      );
    }

    return entry as McpServerEntry;
  }

  async connect(): Promise<void> {
    const entry = await this.loadServerEntry();

    this.transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env,
    });

    this.client = new Client(
      { name: "pencil-sync", version: "1.0.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    log.debug("PencilMcpClient connected");
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
      log.debug("PencilMcpClient disconnected");
    }
  }

  async batchGet(screenIds?: string[]): Promise<PencilNodeData> {
    if (!this.client) throw new Error("PencilMcpClient not connected — call connect() first");

    const args: Record<string, unknown> = {};
    if (screenIds && screenIds.length > 0) args["screens"] = screenIds;

    const result = await this.client.callTool({ name: "batch_get", arguments: args });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "{}";

    try {
      return JSON.parse(text) as PencilNodeData;
    } catch {
      log.warn("batch_get returned non-JSON response — returning empty state");
      return {};
    }
  }

  async batchDesign(script: string): Promise<void> {
    if (!this.client) throw new Error("PencilMcpClient not connected — call connect() first");

    await this.client.callTool({ name: "batch_design", arguments: { script } });
    log.debug("batch_design script executed");
  }

  async setVariables(vars: Record<string, string>): Promise<void> {
    if (!this.client) throw new Error("PencilMcpClient not connected — call connect() first");

    await this.client.callTool({ name: "set_variables", arguments: { variables: vars } });
    log.debug(`set_variables applied (${Object.keys(vars).length} tokens)`);
  }
}
