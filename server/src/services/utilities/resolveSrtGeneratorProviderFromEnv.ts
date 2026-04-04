export type SrtGeneratorProviderId = "llm_client" | "whisperx" | "none";

/**
 * Same resolution as {@link SrtGeneratorFactory} / `SRT_GENERATOR_PROVIDER` + `DIARIZATION_PROVIDER`.
 * Does not throw (returns `null` for unsupported values) so callers can branch safely.
 */
export function tryResolveSrtGeneratorProviderFromEnv(
  env: NodeJS.ProcessEnv,
): SrtGeneratorProviderId | null {
  const raw = env.SRT_GENERATOR_PROVIDER ?? env.DIARIZATION_PROVIDER ?? "openai";
  const mode = raw.trim().toLowerCase();
  if (mode === "openai_semantic" || mode === "openai") {
    return "llm_client";
  }
  if (mode === "llm_client" || mode === "whisperx" || mode === "none") {
    return mode;
  }
  return null;
}

export function resolveSrtGeneratorProviderFromEnv(env: NodeJS.ProcessEnv): SrtGeneratorProviderId {
  const resolved = tryResolveSrtGeneratorProviderFromEnv(env);
  if (resolved != null) {
    return resolved;
  }
  const raw = env.SRT_GENERATOR_PROVIDER ?? env.DIARIZATION_PROVIDER ?? "openai";
  const mode = raw.trim().toLowerCase();
  throw new Error(
    `Unsupported SRT generator provider "${mode}". Use SRT_GENERATOR_PROVIDER=llm_client|whisperx|none, or DIARIZATION_PROVIDER=openai|openai_semantic|whisperx|none.`,
  );
}

export function isWhisperXSrtProviderEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return tryResolveSrtGeneratorProviderFromEnv(env) === "whisperx";
}
