const DEFAULT = "base";

/**
 * Shared Whisper **model id** for the local `whisper` CLI ({@link LocalWhisperSpeechToTextService}).
 *
 * Precedence: `WHISPER_MODEL` → `LOCAL_WHISPER_MODEL` → `WHISPERX_MODEL` (legacy alias) → `"base"`.
 */
export function whisperModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const m =
    env.WHISPER_MODEL?.trim() || env.LOCAL_WHISPER_MODEL?.trim() || env.WHISPERX_MODEL?.trim() || DEFAULT;
  return m || DEFAULT;
}
