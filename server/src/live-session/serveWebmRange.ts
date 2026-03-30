import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

type RangeParse =
  | { mode: "full" }
  | { mode: "partial"; start: number; end: number }
  | { mode: "invalid" };

/**
 * Parse a single `Range: bytes=…` value. Browsers send this for video seek / resume.
 * @see https://datatracker.ietf.org/doc/html/rfc7233
 */
export function parseBytesRange(rangeHeader: string | undefined, resourceSize: number): RangeParse {
  if (resourceSize <= 0) {
    return { mode: "invalid" };
  }
  if (rangeHeader == null || rangeHeader === "") {
    return { mode: "full" };
  }
  if (!rangeHeader.startsWith("bytes=")) {
    return { mode: "full" };
  }

  const spec = rangeHeader.slice("bytes=".length).trim();
  const part = spec.split(",")[0]?.trim();
  if (!part) {
    return { mode: "invalid" };
  }

  const dash = part.indexOf("-");
  if (dash < 0) {
    return { mode: "invalid" };
  }

  const startS = part.slice(0, dash);
  const endS = part.slice(dash + 1);

  let start: number;
  let end: number;

  if (startS === "" && endS !== "") {
    const suffixLen = Number.parseInt(endS, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return { mode: "invalid" };
    }
    start = Math.max(0, resourceSize - suffixLen);
    end = resourceSize - 1;
  } else if (startS !== "" && endS === "") {
    start = Number.parseInt(startS, 10);
    if (!Number.isFinite(start) || start < 0 || start >= resourceSize) {
      return { mode: "invalid" };
    }
    end = resourceSize - 1;
  } else if (startS !== "" && endS !== "") {
    start = Number.parseInt(startS, 10);
    end = Number.parseInt(endS, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
      return { mode: "invalid" };
    }
    end = Math.min(end, resourceSize - 1);
    if (start >= resourceSize) {
      return { mode: "invalid" };
    }
  } else {
    return { mode: "invalid" };
  }

  if (start > end) {
    return { mode: "invalid" };
  }

  return { mode: "partial", start, end };
}

function commonHeaders(reply: FastifyReply, sessionId: string): void {
  reply
    .type("video/webm")
    .header("Accept-Ranges", "bytes")
    .header("Content-Disposition", `inline; filename="live-session-${sessionId}.webm"`)
    .header("Cache-Control", "private, max-age=60");
}

/**
 * Send WebM from disk with optional 206 partial response (required for HTML5 seek).
 */
export async function sendWebmFileWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  sessionId: string,
): Promise<void> {
  const stat = await fs.stat(filePath);
  const size = Number(stat.size);
  const rangeRaw = request.headers.range;
  const rangeHeader = Array.isArray(rangeRaw) ? rangeRaw[0] : rangeRaw;
  const parsed = parseBytesRange(rangeHeader, size);

  commonHeaders(reply, sessionId);

  if (parsed.mode === "invalid") {
    reply.code(416).header("Content-Range", `bytes */${size}`).send();
    return;
  }

  if (parsed.mode === "full") {
    reply.header("Content-Length", String(size));
    await reply.send(createReadStream(filePath));
    return;
  }

  const { start, end } = parsed;
  const chunkLen = end - start + 1;
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", String(chunkLen));
  await reply.send(createReadStream(filePath, { start, end }));
}

/**
 * Send WebM from memory with optional 206 partial response.
 */
export async function sendWebmBufferWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  data: Buffer,
  sessionId: string,
): Promise<void> {
  const size = data.length;
  const rangeRaw = request.headers.range;
  const rangeHeader = Array.isArray(rangeRaw) ? rangeRaw[0] : rangeRaw;
  const parsed = parseBytesRange(rangeHeader, size);

  commonHeaders(reply, sessionId);

  if (parsed.mode === "invalid") {
    reply.code(416).header("Content-Range", `bytes */${size}`).send();
    return;
  }

  if (parsed.mode === "full") {
    reply.header("Content-Length", String(size));
    await reply.send(data);
    return;
  }

  const { start, end } = parsed;
  const chunk = data.subarray(start, end + 1);
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", String(chunk.length));
  await reply.send(chunk);
}
