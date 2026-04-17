/**
 * Wraps candidate editor buffer for {@link Session.sendRealtimeInput} text turns.
 * No server-side length cap — the Live API may still reject or truncate per Google’s limits.
 * @public — exported for unit tests
 */
export function formatCandidateEditorSnapshotForGeminiLive(code: string): string {
  const raw = typeof code === "string" ? code : "";
  const body = raw.trim().length > 0 ? raw : "(empty editor buffer)";
  return [
    "[Candidate editor — full buffer as plain text. The interview problem is in your system instructions above. Screen/video frames are not sent; only this buffer updates when their code changes.]",
    "",
    body,
  ].join("\n");
}
