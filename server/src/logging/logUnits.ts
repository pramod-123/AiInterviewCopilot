/**
 * Small, pure helpers for size-safe structured logging (Winston / Fastify).
 */

/** Safe string length for log metadata; non-strings → 0. */
export function stringCharCount(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * Single-line preview for logs. Non-strings yield `""`.
 * Use for optional debug fields; prefer {@link stringCharCount} when you must not emit body text.
 */
export function truncateForLog(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}
