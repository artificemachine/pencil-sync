import chalk from "chalk";
import type { LogLevel } from "./types.js";

export type TuiEvent = { level: LogLevel; message: string; timestamp: number };

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let mcpMode = false;
let tuiHandler: ((ev: TuiEvent) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setMcpMode(enabled: boolean): void {
  mcpMode = enabled;
}

export function setTuiEventHandler(h: ((ev: TuiEvent) => void) | null): void {
  tuiHandler = h;
}

export function clearTuiEventHandler(): void {
  tuiHandler = null;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return chalk.gray(new Date().toISOString().slice(11, 19));
}

function emit(level: LogLevel, formatted: string, message: string, ...args: unknown[]): void {
  if (tuiHandler !== null) {
    try {
      tuiHandler({ level, message, timestamp: Date.now() });
      return;
    } catch {
      // handler threw — fall through to console output
    }
  }
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
      emit("debug", `${timestamp()} ${chalk.gray("DBG")} ${msg}`, msg, ...args);
    }
  },

  info(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      emit("info", `${timestamp()} ${chalk.blue("INF")} ${msg}`, msg, ...args);
    }
  },

  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog("warn")) {
      if (tuiHandler !== null) {
        try {
          tuiHandler({ level: "warn", message: msg, timestamp: Date.now() });
          return;
        } catch {
          // fall through
        }
      }
      console.warn(`${timestamp()} ${chalk.yellow("WRN")} ${msg}`, ...args);
    }
  },

  error(msg: string, ...args: unknown[]): void {
    if (shouldLog("error")) {
      if (tuiHandler !== null) {
        try {
          tuiHandler({ level: "error", message: msg, timestamp: Date.now() });
          return;
        } catch {
          // fall through
        }
      }
      console.error(`${timestamp()} ${chalk.red("ERR")} ${msg}`, ...args);
    }
  },

  success(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      emit("info", `${timestamp()} ${chalk.green("OK ")} ${msg}`, msg, ...args);
    }
  },

  sync(direction: string, mappingId: string, msg: string): void {
    if (shouldLog("info")) {
      const arrow =
        direction === "pen-to-code"
          ? chalk.magenta(".pen → code")
          : chalk.cyan("code → .pen");
      const full = `${timestamp()} ${arrow} ${chalk.dim(`[${mappingId}]`)} ${msg}`;
      emit("info", full, msg);
    }
  },
};
