/**
 * Logging for an stdio MCP server.
 *
 * stdout is reserved for the JSON-RPC protocol stream, so every diagnostic goes
 * to stderr. Log records are redacted before they are written.
 */
import { redact } from "../text/redact.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function configuredLevel(): LogLevel {
  const raw = (process.env.AUTOAPPLY_LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {}),
  };
  process.stderr.write(`${redact(JSON.stringify(record))}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
};
