import chalk from "chalk";
import type { LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let mcpMode = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setMcpMode(enabled: boolean): void {
  mcpMode = enabled;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return chalk.gray(new Date().toISOString().slice(11, 19));
}

function emit(formatted: string, ...args: unknown[]): void {
  if (mcpMode) {
    const extra = args.length ? " " + args.map(String).join(" ") : "";
    process.stderr.write(formatted + extra + "\n");
  } else {
    console.log(formatted, ...args);
  }
}

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog("debug")) {
      emit(`${timestamp()} ${chalk.gray("DBG")} ${msg}`, ...args);
    }
  },

  info(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      emit(`${timestamp()} ${chalk.blue("INF")} ${msg}`, ...args);
    }
  },

  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog("warn")) {
      console.warn(`${timestamp()} ${chalk.yellow("WRN")} ${msg}`, ...args);
    }
  },

  error(msg: string, ...args: unknown[]): void {
    if (shouldLog("error")) {
      console.error(`${timestamp()} ${chalk.red("ERR")} ${msg}`, ...args);
    }
  },

  success(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      emit(`${timestamp()} ${chalk.green("OK ")} ${msg}`, ...args);
    }
  },

  sync(direction: string, mappingId: string, msg: string): void {
    if (shouldLog("info")) {
      const arrow =
        direction === "pen-to-code"
          ? chalk.magenta(".pen → code")
          : chalk.cyan("code → .pen");
      emit(`${timestamp()} ${arrow} ${chalk.dim(`[${mappingId}]`)} ${msg}`);
    }
  },
};
