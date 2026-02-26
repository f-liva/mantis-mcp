import type { Config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let currentLevel: number = LEVELS.info;

export function initLogger(config: Config): void {
  currentLevel = LEVELS[config.LOG_LEVEL];
}

function write(level: LogLevel, message: string, ...args: unknown[]): void {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  const extra = args.length
    ? " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    : "";
  // CRITICAL: never use stdout — it's reserved for MCP JSON-RPC
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}${extra}\n`);
}

export const logger = {
  error: (msg: string, ...args: unknown[]) => write("error", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write("warn", msg, ...args),
  info: (msg: string, ...args: unknown[]) => write("info", msg, ...args),
  debug: (msg: string, ...args: unknown[]) => write("debug", msg, ...args),
};
