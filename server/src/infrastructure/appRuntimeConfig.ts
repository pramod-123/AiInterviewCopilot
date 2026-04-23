import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AppPaths } from "./AppPaths.js";

/**
 * Preset option lists when `.app-runtime-config.json` omits an array live in
 * {@link AppPaths.runtimeAppConfigDefaultsPath} (`server/.app-runtime-config.defaults.json`).
 */

const EVAL_MODEL_OPTION_ID_RE = /^[a-zA-Z0-9._\-:]+$/;
const EVAL_MODEL_OPTION_MAX = 10;
const EVAL_MODEL_OPTION_ITEM_MAX_LEN = 128;

const WHISPER_MODEL_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** On-disk shape under {@link AppPaths.runtimeAppConfigPath}. */
export type AppRuntimeConfigV1 = {
  version: 1;
  liveRealtimeProvider?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openaiRealtimeModel?: string;
  openaiRealtimeVoice?: string;
  geminiLiveModel?: string;
  /** Gemini Live prebuilt voice name (`speechConfig`); merged as `GEMINI_LIVE_VOICE` when set. */
  geminiLiveVoice?: string;
  llmProvider?: string;
  openaiModelId?: string;
  anthropicModelId?: string;
  geminiModelId?: string;
  /** Local Ollama model name; merged as `OLLAMA_MODEL_ID` when set. */
  ollamaModelId?: string;
  /** Ollama server base URL (e.g. `http://127.0.0.1:11434`); merged as `OLLAMA_BASE_URL` when set. */
  ollamaBaseUrl?: string;
  /** Preset evaluation LLM ids for OpenAI (shown in UI datalist); max {@link EVAL_MODEL_OPTION_MAX} entries. */
  openaiEvalModelOptions?: string[];
  anthropicEvalModelOptions?: string[];
  geminiEvalModelOptions?: string[];
  /** Preset OpenAI Realtime model ids (voice bridge UI datalist). */
  openaiRealtimeModelOptions?: string[];
  /** Preset OpenAI Realtime voice names (voice bridge UI datalist). */
  openaiRealtimeVoiceOptions?: string[];
  /** Preset Gemini Live model ids (voice bridge UI datalist). */
  geminiLiveModelOptions?: string[];
  /** Preset Gemini Live voice names (voice bridge UI). */
  geminiLiveVoiceOptions?: string[];
  /** Preset Whisper checkpoint ids for the Server config UI; merged list only (actual choice is `whisperModel`). */
  whisperModelOptions?: string[];
  /** Local Whisper CLI checkpoint id; merged as `WHISPER_MODEL` when set. */
  whisperModel?: string;
  /** Evaluator mode; merged as `EVALUATION_PROVIDER` when set (`llm` | `single-agent`). */
  evaluationProvider?: string;
  /** Path to local Whisper CLI; merged as `LOCAL_WHISPER_EXECUTABLE` when set. */
  localWhisperExecutable?: string;
  /** Prisma / LibSQL URL; merged as `DATABASE_URL` when set (no `.env` required). */
  databaseUrl?: string;
  /** HTTP bind host; merged as `HOST` when set. */
  listenHost?: string;
  /** HTTP bind port (digits only); merged as `PORT` when set. */
  listenPort?: string;
};

/** GET `/api/app-config` — no raw secrets. */
export type AppRuntimeConfigPublicV1 = {
  version: 1;
  liveRealtimeProvider: string;
  openaiRealtimeModel: string;
  openaiRealtimeVoice: string;
  geminiLiveModel: string;
  geminiLiveVoice: string;
  llmProvider: string;
  openaiModelId: string;
  anthropicModelId: string;
  geminiModelId: string;
  ollamaModelId: string;
  ollamaBaseUrl: string;
  openaiEvalModelOptions: string[];
  anthropicEvalModelOptions: string[];
  geminiEvalModelOptions: string[];
  openaiRealtimeModelOptions: string[];
  openaiRealtimeVoiceOptions: string[];
  geminiLiveModelOptions: string[];
  geminiLiveVoiceOptions: string[];
  whisperModelOptions: string[];
  openaiApiKeyConfigured: boolean;
  geminiApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  whisperModel: string;
  evaluationProvider: string;
  localWhisperExecutable: string;
  listenHost: string;
  listenPort: string;
  /** True when `databaseUrl` is set in the runtime file (GET never returns the raw URL). */
  databaseUrlConfigured: boolean;
  /** True when the server built the full speech + evaluation stack for live-session post-processing. */
  interviewApiEnabled: boolean;
  /** When {@link interviewApiEnabled} is false, short error from the last readiness check (no secrets). */
  interviewApiDisableReason: string;
};

const STRING_PATCH_KEYS = new Set([
  "liveRealtimeProvider",
  "openaiApiKey",
  "geminiApiKey",
  "anthropicApiKey",
  "openaiRealtimeModel",
  "openaiRealtimeVoice",
  "geminiLiveModel",
  "geminiLiveVoice",
  "llmProvider",
  "openaiModelId",
  "anthropicModelId",
  "geminiModelId",
  "ollamaModelId",
  "ollamaBaseUrl",
  "whisperModel",
  "evaluationProvider",
  "localWhisperExecutable",
  "databaseUrl",
  "listenHost",
  "listenPort",
]);

const ARRAY_PATCH_KEYS = new Set([
  "openaiEvalModelOptions",
  "anthropicEvalModelOptions",
  "geminiEvalModelOptions",
  "openaiRealtimeModelOptions",
  "openaiRealtimeVoiceOptions",
  "geminiLiveModelOptions",
  "geminiLiveVoiceOptions",
  "whisperModelOptions",
]);

const PATCH_KEYS = new Set([...STRING_PATCH_KEYS, ...ARRAY_PATCH_KEYS]);

let mergedEnvCache: { mtimeMs: number; env: NodeJS.ProcessEnv } | null = null;

type RuntimeDefaultsBundle = {
  defaults: AppRuntimeConfigV1;
  whisperAllowlist: string[];
};

let defaultsBundleCache: { mtimeMs: number; bundle: RuntimeDefaultsBundle } | null = null;

export function invalidateRuntimeAppConfigEnvCache(): void {
  mergedEnvCache = null;
  defaultsBundleCache = null;
}

export function readRuntimeAppConfigSync(paths: AppPaths): AppRuntimeConfigV1 | null {
  const p = paths.runtimeAppConfigPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const o = JSON.parse(raw) as AppRuntimeConfigV1;
    if (o && o.version === 1) {
      return o;
    }
  } catch {
    /* missing or invalid */
  }
  return null;
}

function buildWhisperAllowlistFromRaw(whisperModelOptions: unknown): string[] {
  if (!Array.isArray(whisperModelOptions)) {
    return [];
  }
  const out: string[] = [];
  for (const item of whisperModelOptions) {
    if (typeof item !== "string") {
      continue;
    }
    const t = item.trim().toLowerCase();
    if (!t || t.length > 64 || !WHISPER_MODEL_ID_RE.test(t)) {
      continue;
    }
    if (!out.includes(t)) {
      out.push(t);
    }
    if (out.length >= EVAL_MODEL_OPTION_MAX) {
      break;
    }
  }
  return out;
}

/**
 * Shipped defaults (`.app-runtime-config.defaults.json`), mtime-cached.
 * Whisper allowlist is derived from `whisperModelOptions` in that file (regex-validated only).
 */
export function readRuntimeAppConfigDefaultsBundle(paths: AppPaths): RuntimeDefaultsBundle {
  const p = paths.runtimeAppConfigDefaultsPath();
  try {
    const st = fs.statSync(p);
    if (defaultsBundleCache && defaultsBundleCache.mtimeMs === st.mtimeMs) {
      return defaultsBundleCache.bundle;
    }
    const raw = fs.readFileSync(p, "utf-8");
    const o = JSON.parse(raw) as AppRuntimeConfigV1;
    const defaults: AppRuntimeConfigV1 = o?.version === 1 ? o : { version: 1 };
    const bundle: RuntimeDefaultsBundle = {
      defaults,
      whisperAllowlist: buildWhisperAllowlistFromRaw(defaults.whisperModelOptions),
    };
    defaultsBundleCache = { mtimeMs: st.mtimeMs, bundle };
    return bundle;
  } catch {
    const empty: AppRuntimeConfigV1 = { version: 1 };
    const bundle: RuntimeDefaultsBundle = { defaults: empty, whisperAllowlist: [] };
    defaultsBundleCache = { mtimeMs: -1, bundle };
    return bundle;
  }
}

export function toPublicRuntimeConfig(
  paths: AppPaths,
  cfg: AppRuntimeConfigV1 | null,
  runtimeState?: { interviewApiEnabled: boolean; interviewApiDisableReason: string },
): AppRuntimeConfigPublicV1 {
  const c = cfg ?? { version: 1 };
  const { defaults: d } = readRuntimeAppConfigDefaultsBundle(paths);
  const openaiEvalFb = sanitizeEvalModelOptionList(d.openaiEvalModelOptions, []);
  const anthropicEvalFb = sanitizeEvalModelOptionList(d.anthropicEvalModelOptions, []);
  const geminiEvalFb = sanitizeEvalModelOptionList(d.geminiEvalModelOptions, []);
  const openaiRtModelFb = sanitizeEvalModelOptionList(d.openaiRealtimeModelOptions, []);
  const openaiRtVoiceFb = sanitizeEvalModelOptionList(d.openaiRealtimeVoiceOptions, []);
  const geminiLiveModelFb = sanitizeEvalModelOptionList(d.geminiLiveModelOptions, []);
  const geminiLiveVoiceFb = sanitizeEvalModelOptionList(d.geminiLiveVoiceOptions, []);
  const whisperOptFb = sanitizeWhisperModelOptionList(paths, d.whisperModelOptions, []);
  return {
    version: 1,
    liveRealtimeProvider: (c.liveRealtimeProvider ?? "").trim(),
    openaiRealtimeModel: (c.openaiRealtimeModel ?? "").trim(),
    openaiRealtimeVoice: (c.openaiRealtimeVoice ?? "").trim(),
    geminiLiveModel: (c.geminiLiveModel ?? "").trim(),
    geminiLiveVoice: (c.geminiLiveVoice ?? "").trim(),
    llmProvider: (c.llmProvider ?? "").trim(),
    openaiModelId: (c.openaiModelId ?? "").trim(),
    anthropicModelId: (c.anthropicModelId ?? "").trim(),
    geminiModelId: (c.geminiModelId ?? "").trim(),
    ollamaModelId: (c.ollamaModelId ?? "").trim(),
    ollamaBaseUrl: (c.ollamaBaseUrl ?? "").trim(),
    openaiEvalModelOptions: sanitizeEvalModelOptionList(c.openaiEvalModelOptions, openaiEvalFb),
    anthropicEvalModelOptions: sanitizeEvalModelOptionList(c.anthropicEvalModelOptions, anthropicEvalFb),
    geminiEvalModelOptions: sanitizeEvalModelOptionList(c.geminiEvalModelOptions, geminiEvalFb),
    openaiRealtimeModelOptions: sanitizeEvalModelOptionList(c.openaiRealtimeModelOptions, openaiRtModelFb),
    openaiRealtimeVoiceOptions: sanitizeEvalModelOptionList(c.openaiRealtimeVoiceOptions, openaiRtVoiceFb),
    geminiLiveModelOptions: sanitizeEvalModelOptionList(c.geminiLiveModelOptions, geminiLiveModelFb),
    geminiLiveVoiceOptions: sanitizeEvalModelOptionList(c.geminiLiveVoiceOptions, geminiLiveVoiceFb),
    whisperModelOptions: sanitizeWhisperModelOptionList(paths, c.whisperModelOptions, whisperOptFb),
    openaiApiKeyConfigured: Boolean(c.openaiApiKey?.trim()),
    geminiApiKeyConfigured: Boolean(c.geminiApiKey?.trim()),
    anthropicApiKeyConfigured: Boolean(c.anthropicApiKey?.trim()),
    whisperModel: (c.whisperModel ?? "").trim(),
    evaluationProvider: (c.evaluationProvider ?? "").trim(),
    localWhisperExecutable: (c.localWhisperExecutable ?? "").trim(),
    listenHost: (c.listenHost ?? "").trim(),
    listenPort: (c.listenPort ?? "").trim(),
    databaseUrlConfigured: Boolean(c.databaseUrl?.trim()),
    interviewApiEnabled: runtimeState?.interviewApiEnabled ?? true,
    interviewApiDisableReason: (runtimeState?.interviewApiDisableReason ?? "").trim(),
  };
}

function sanitizeEvalModelOptionList(
  raw: unknown,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const t = item.trim();
    if (!t || t.length > EVAL_MODEL_OPTION_ITEM_MAX_LEN || !EVAL_MODEL_OPTION_ID_RE.test(t)) {
      continue;
    }
    if (!out.includes(t)) {
      out.push(t);
    }
    if (out.length >= EVAL_MODEL_OPTION_MAX) {
      break;
    }
  }
  return out.length > 0 ? out : [...fallback];
}

export function isAllowedWhisperModelId(paths: AppPaths, raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t || t.length > 64) {
    return false;
  }
  const { whisperAllowlist } = readRuntimeAppConfigDefaultsBundle(paths);
  if (whisperAllowlist.includes(t)) {
    return true;
  }
  return WHISPER_MODEL_ID_RE.test(t);
}

function sanitizeWhisperModelOptionList(
  paths: AppPaths,
  raw: unknown,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const t = item.trim().toLowerCase();
    if (!t || !isAllowedWhisperModelId(paths, item)) {
      continue;
    }
    if (!out.includes(t)) {
      out.push(t);
    }
    if (out.length >= EVAL_MODEL_OPTION_MAX) {
      break;
    }
  }
  return out.length > 0 ? out : [...fallback];
}

/**
 * Speech-to-text backend mode. This build **always** uses the local Whisper CLI (`"local"`).
 * The `"remote"` branch remains in {@link SpeechToTextServiceFactory} for reference.
 */
export function getSpeechToTextProviderMode(_paths: AppPaths | null): "local" | "remote" {
  return "local";
}

/**
 * `process.env` plus non-empty overrides from `.app-runtime-config.json` (mtime-cached).
 * Used for live realtime bridge, LLM evaluation, and Whisper model override.
 */
export function getMergedAppEnv(paths: AppPaths): NodeJS.ProcessEnv {
  const p = paths.runtimeAppConfigPath();
  try {
    const st = fs.statSync(p);
    if (mergedEnvCache && mergedEnvCache.mtimeMs === st.mtimeMs) {
      return mergedEnvCache.env;
    }
    const file = readRuntimeAppConfigSync(paths);
    const base = { ...process.env } as Record<string, string | undefined>;
    const set = (envKey: string, fileVal: string | undefined) => {
      if (typeof fileVal !== "string") {
        return;
      }
      const t = fileVal.trim();
      if (!t) {
        return;
      }
      base[envKey] = t;
    };
    if (file) {
      set("LIVE_REALTIME_PROVIDER", file.liveRealtimeProvider);
      set("OPENAI_API_KEY", file.openaiApiKey);
      set("GEMINI_API_KEY", file.geminiApiKey);
      set("ANTHROPIC_API_KEY", file.anthropicApiKey);
      set("OPENAI_REALTIME_MODEL", file.openaiRealtimeModel);
      set("OPENAI_REALTIME_VOICE", file.openaiRealtimeVoice);
      set("GEMINI_LIVE_MODEL", file.geminiLiveModel);
      set("GEMINI_LIVE_VOICE", file.geminiLiveVoice);
      set("LLM_PROVIDER", file.llmProvider);
      set("OPENAI_MODEL_ID", file.openaiModelId);
      set("ANTHROPIC_MODEL_ID", file.anthropicModelId);
      set("GEMINI_MODEL_ID", file.geminiModelId);
      set("OLLAMA_MODEL_ID", file.ollamaModelId);
      set("OLLAMA_BASE_URL", file.ollamaBaseUrl);
      set("WHISPER_MODEL", file.whisperModel);
      set("EVALUATION_PROVIDER", file.evaluationProvider);
      set("LOCAL_WHISPER_EXECUTABLE", file.localWhisperExecutable);
      set("DATABASE_URL", file.databaseUrl);
      set("HOST", file.listenHost);
      set("PORT", file.listenPort);
    }
    const env = base as NodeJS.ProcessEnv;
    mergedEnvCache = { mtimeMs: st.mtimeMs, env };
    return env;
  } catch {
    mergedEnvCache = null;
    return process.env;
  }
}

/**
 * Merge JSON patch into the runtime config file. Empty string removes that field (falls back to process
 * environment or built-in defaults where applicable).
 * Unknown keys are ignored. `version` is forced to 1.
 */
export async function patchRuntimeAppConfig(
  paths: AppPaths,
  patch: Record<string, unknown>,
): Promise<AppRuntimeConfigV1> {
  const current = readRuntimeAppConfigSync(paths) ?? { version: 1 };
  const next: AppRuntimeConfigV1 = { ...current, version: 1 };

  for (const [k, v] of Object.entries(patch)) {
    if (k === "version" || !PATCH_KEYS.has(k)) {
      continue;
    }
    if (v === undefined) {
      continue;
    }
    if (ARRAY_PATCH_KEYS.has(k)) {
      if (v === null) {
        delete (next as Record<string, unknown>)[k];
        continue;
      }
      if (!Array.isArray(v)) {
        continue;
      }
      const sanitized =
        k === "whisperModelOptions"
          ? sanitizeWhisperModelOptionList(paths, v, [])
          : sanitizeEvalModelOptionList(v, []);
      if (sanitized.length === 0) {
        delete (next as Record<string, unknown>)[k];
      } else {
        (next as Record<string, unknown>)[k] = sanitized;
      }
      continue;
    }
    if (v === null) {
      delete (next as Record<string, unknown>)[k];
      continue;
    }
    if (typeof v !== "string") {
      continue;
    }
    if (v.trim() === "") {
      delete (next as Record<string, unknown>)[k];
    } else {
      (next as Record<string, unknown>)[k] = v.trim();
    }
  }

  if (next.liveRealtimeProvider) {
    next.liveRealtimeProvider = next.liveRealtimeProvider.trim().toLowerCase();
  }
  if (next.llmProvider) {
    next.llmProvider = next.llmProvider.trim().toLowerCase();
  }
  if (next.evaluationProvider) {
    next.evaluationProvider = next.evaluationProvider.trim().toLowerCase();
  }
  if (next.whisperModel) {
    next.whisperModel = next.whisperModel.trim().toLowerCase();
  }

  await fsp.mkdir(paths.dataDir, { recursive: true });
  const outPath = paths.runtimeAppConfigPath();
  const tmp = `${outPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, outPath);
  invalidateRuntimeAppConfigEnvCache();
  return next;
}
