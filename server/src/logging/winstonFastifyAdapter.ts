import type { FastifyBaseLogger } from "fastify";
import type { Bindings, ChildLoggerOptions } from "pino";
import winston from "winston";

/** Aligns with common Pino level names used by Fastify. */
export const WINSTON_FASTIFY_LEVELS = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const;

function redactFastifyLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj };
  const req = out.req;
  if (req && typeof req === "object" && req !== null && "headers" in req) {
    const headers = (req as { headers?: Record<string, unknown> }).headers;
    if (headers && typeof headers === "object") {
      const h = { ...headers };
      delete h.authorization;
      delete h.cookie;
      out.req = { ...(req as object), headers: h };
    }
  }
  return out;
}

function normalizePinoStyleArgs(args: unknown[]): { message: string; meta: Record<string, unknown> } {
  const [a, b] = args;
  if (typeof a === "string") {
    return { message: a, meta: {} };
  }
  if (a && typeof a === "object" && typeof b === "string") {
    const meta = redactFastifyLogObject({ ...(a as Record<string, unknown>) });
    return { message: b, meta };
  }
  if (a && typeof a === "object") {
    const o = redactFastifyLogObject({ ...(a as Record<string, unknown>) });
    const msg =
      typeof o.msg === "string"
        ? String(o.msg)
        : typeof o.message === "string"
          ? String(o.message)
          : "";
    const { msg: _m, message: _msg, ...rest } = o;
    return { message: msg || JSON.stringify(rest), meta: rest };
  }
  return { message: String(a), meta: {} };
}

/**
 * Winston-backed logger exposing Pino-style `log.info(obj, msg)` so Fastify and app code stay unchanged.
 */
export class WinstonFastifyLogger implements FastifyBaseLogger {
  readonly silent: FastifyBaseLogger["silent"];

  constructor(private readonly logger: winston.Logger) {
    const noop: FastifyBaseLogger["silent"] = () => {};
    this.silent = noop;
  }

  get level(): string {
    return this.logger.level;
  }

  set level(val: string) {
    this.logger.level = val;
  }

  child(bindings: Bindings, _options?: ChildLoggerOptions): FastifyBaseLogger {
    const childLogger = this.logger.child(bindings as Record<string, unknown>);
    return new WinstonFastifyLogger(childLogger);
  }

  fatal: FastifyBaseLogger["fatal"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "fatal", message, ...meta });
  };

  error: FastifyBaseLogger["error"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "error", message, ...meta });
  };

  warn: FastifyBaseLogger["warn"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "warn", message, ...meta });
  };

  info: FastifyBaseLogger["info"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "info", message, ...meta });
  };

  debug: FastifyBaseLogger["debug"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "debug", message, ...meta });
  };

  trace: FastifyBaseLogger["trace"] = (...args: unknown[]) => {
    const { message, meta } = normalizePinoStyleArgs(args);
    this.logger.log({ level: "trace", message, ...meta });
  };
}

export function buildWinstonJsonFormat(): winston.Logform.Format {
  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  );
}
