import type { FastifyServerOptions } from "fastify";
import pino from "pino";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/**
 * Pino options for Fastify: ISO-8601 `time`, configurable level, redacted sensitive headers.
 */
export function buildFastifyLoggerOptions(): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  const level = raw && LEVELS.has(raw) ? raw : "info";
  return {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      remove: true,
    },
  };
}
