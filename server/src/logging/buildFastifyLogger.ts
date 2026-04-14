import type { FastifyBaseLogger } from "fastify";
import path from "node:path";
import DailyRotateFile from "winston-daily-rotate-file";
import winston from "winston";
import {
  WINSTON_FASTIFY_LEVELS,
  WinstonFastifyLogger,
  buildWinstonJsonFormat,
} from "./winstonFastifyAdapter.js";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function envFlagTrue(key: string): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Effective Winston level: `LOG_LEVEL` if set and valid; else `debug` when `LOG_DEBUG=1`; else `info`.
 */
export function resolveEffectiveLogLevel(): string {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && LEVELS.has(raw)) {
    return raw;
  }
  if (envFlagTrue("LOG_DEBUG")) {
    return "debug";
  }
  return "info";
}

/**
 * Root logger for Fastify using [Winston](https://github.com/winstonjs/winston). JSON to stderr/stdout;
 * optional hourly rotated files via [winston-daily-rotate-file](https://github.com/winstonjs/winston-daily-rotate-file).
 *
 * | Variable | Effect |
 * |----------|--------|
 * | `LOG_LEVEL` | `fatal` … `trace` / `silent` (default `info` if nothing else applies) |
 * | `LOG_DEBUG=1` | Same as `LOG_LEVEL=debug` when `LOG_LEVEL` is unset or invalid |
 * | `LOG_FILE_ENABLED=1` | Also write to `LOG_DIR/server-*.log` (hourly `%DATE%`) |
 * | `LOG_DIR` | Directory under `process.cwd()` (default `logs`) |
 */
export function buildFastifyLogger(): FastifyBaseLogger {
  const resolved = resolveEffectiveLogLevel();
  const format = buildWinstonJsonFormat();

  const transports: winston.transport[] = [
    new winston.transports.Console({
      stderrLevels: ["error", "fatal"],
    }),
  ];

  if (envFlagTrue("LOG_FILE_ENABLED")) {
    const logDir = path.join(process.cwd(), process.env.LOG_DIR?.trim() || "logs");
    transports.push(
      new DailyRotateFile({
        dirname: logDir,
        filename: "server-%DATE%.log",
        datePattern: "YYYY-MM-DD-HH",
        maxFiles: 168,
      }),
    );
  }

  const logger = winston.createLogger({
    levels: WINSTON_FASTIFY_LEVELS,
    level: resolved === "silent" ? "trace" : resolved,
    silent: resolved === "silent",
    format,
    transports,
  });

  return new WinstonFastifyLogger(logger) as FastifyBaseLogger;
}
