import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import {
  isAllowedWhisperModelId,
  patchRuntimeAppConfig,
  readRuntimeAppConfigSync,
  toPublicRuntimeConfig,
} from "../infrastructure/appRuntimeConfig.js";
import { getInterviewApiDisableReason, getInterviewApiEnabled } from "../interviewApiRuntimeState.js";

/** Preset string arrays (eval LLM + voice bridge); same validation rules. */
const MODEL_PRESET_ARRAY_KEYS = new Set([
  "openaiEvalModelOptions",
  "anthropicEvalModelOptions",
  "geminiEvalModelOptions",
  "openaiRealtimeModelOptions",
  "openaiRealtimeVoiceOptions",
  "geminiLiveModelOptions",
  "geminiLiveVoiceOptions",
  "whisperModelOptions",
]);

const EVAL_MODEL_OPTION_ITEM_RE = /^[a-zA-Z0-9._\-:]+$/;
const EVAL_MODEL_OPTION_MAX = 10;
const EVAL_MODEL_OPTION_ITEM_MAX_LEN = 128;

const LIVE_PROVIDERS = new Set(["gemini", "openai"]);
const LLM_PROVIDERS = new Set(["openai", "anthropic", "gemini", "ollama"]);
const EVAL_PROVIDERS = new Set(["llm", "single-agent"]);
const LOCAL_WHISPER_EXE_MAX_LEN = 4096;
const DATABASE_URL_MAX_LEN = 2048;
const LISTEN_HOST_MAX_LEN = 255;

/** Hostnames must be single-line ASCII without spaces or C0 control bytes. */
function listenHostHasInvalidChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20) {
      return true;
    }
  }
  return false;
}

export class AppRuntimeConfigRoutesController {
  constructor(
    private readonly paths: AppPaths,
    /** Invoked before reading config so `interviewApiEnabled` matches merged env (no server restart). */
    private readonly onBeforeAppConfigExpose?: () => void,
  ) {}

  register(app: FastifyInstance): void {
    app.get("/api/app-config", (_request, reply) => this.handleGet(reply));
    app.put<{ Body: unknown }>("/api/app-config", (request, reply) => this.handlePut(request, reply));
  }

  private handleGet(reply: FastifyReply): void {
    this.onBeforeAppConfigExpose?.();
    const cfg = readRuntimeAppConfigSync(this.paths);
    void reply.send(
      toPublicRuntimeConfig(this.paths, cfg, {
        interviewApiEnabled: getInterviewApiEnabled(),
        interviewApiDisableReason: getInterviewApiDisableReason(),
      }),
    );
  }

  private async handlePut(request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> {
    const body = request.body;
    if (!body || typeof body !== "object") {
      return void reply.code(400).send({ error: "Expected JSON object body." });
    }
    const raw = body as Record<string, unknown>;
    const err = validateAppConfigPatch(this.paths, raw);
    if (err) {
      return void reply.code(400).send({ error: err });
    }
    try {
      await patchRuntimeAppConfig(this.paths, raw);
    } catch (e) {
      request.log.warn({ err: e }, "app-config: write failed");
      return void reply.code(500).send({ error: "Failed to save configuration." });
    }
    this.onBeforeAppConfigExpose?.();
    return void reply.send({ ok: true });
  }
}

function validateAppConfigPatch(paths: AppPaths, raw: Record<string, unknown>): string | null {
  const lr = raw.liveRealtimeProvider;
  if (lr !== undefined && lr !== null) {
    if (typeof lr !== "string") {
      return "liveRealtimeProvider must be a string.";
    }
    const t = lr.trim().toLowerCase();
    if (t && !LIVE_PROVIDERS.has(t)) {
      return `liveRealtimeProvider must be "gemini" or "openai" (got "${lr}").`;
    }
  }
  const wm = raw.whisperModel;
  if (wm !== undefined && wm !== null) {
    if (typeof wm !== "string") {
      return "whisperModel must be a string.";
    }
    const t = wm.trim().toLowerCase();
    if (t && !isAllowedWhisperModelId(paths, t)) {
      return `whisperModel must be a known Whisper id or a safe custom id (got "${wm}").`;
    }
  }
  const glv = raw.geminiLiveVoice;
  if (glv !== undefined && glv !== null) {
    if (typeof glv !== "string") {
      return "geminiLiveVoice must be a string.";
    }
    const t = glv.trim();
    if (t && (t.length > EVAL_MODEL_OPTION_ITEM_MAX_LEN || !EVAL_MODEL_OPTION_ITEM_RE.test(t))) {
      return `geminiLiveVoice is invalid (got "${glv}").`;
    }
  }
  const lp = raw.llmProvider;
  if (lp !== undefined && lp !== null) {
    if (typeof lp !== "string") {
      return "llmProvider must be a string.";
    }
    const t = lp.trim().toLowerCase();
    if (t && !LLM_PROVIDERS.has(t)) {
      return `llmProvider must be openai, anthropic, gemini, or ollama (got "${lp}").`;
    }
  }
  const ep = raw.evaluationProvider;
  if (ep !== undefined && ep !== null) {
    if (typeof ep !== "string") {
      return "evaluationProvider must be a string.";
    }
    const t = ep.trim().toLowerCase();
    if (t && !EVAL_PROVIDERS.has(t)) {
      return `evaluationProvider must be "llm" or "single-agent" (got "${ep}").`;
    }
  }
  const dbu = raw.databaseUrl;
  if (dbu !== undefined && dbu !== null) {
    if (typeof dbu !== "string") {
      return "databaseUrl must be a string.";
    }
    const t = dbu.trim();
    if (t.length > DATABASE_URL_MAX_LEN) {
      return "databaseUrl is too long.";
    }
    if (t.includes("\n") || t.includes("\r")) {
      return "databaseUrl must not contain line breaks.";
    }
  }
  const lh = raw.listenHost;
  if (lh !== undefined && lh !== null) {
    if (typeof lh !== "string") {
      return "listenHost must be a string.";
    }
    const t = lh.trim();
    if (t.length > LISTEN_HOST_MAX_LEN) {
      return "listenHost is too long.";
    }
    if (listenHostHasInvalidChar(t)) {
      return "listenHost must not contain whitespace or control characters.";
    }
  }
  const lpn = raw.listenPort;
  if (lpn !== undefined && lpn !== null) {
    if (typeof lpn !== "string") {
      return "listenPort must be a string.";
    }
    const t = lpn.trim();
    if (t && !/^[0-9]+$/.test(t)) {
      return `listenPort must be digits only (got "${lpn}").`;
    }
    if (t) {
      const n = Number.parseInt(t, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) {
        return `listenPort must be between 1 and 65535 (got "${lpn}").`;
      }
    }
  }
  const lwx = raw.localWhisperExecutable;
  if (lwx !== undefined && lwx !== null) {
    if (typeof lwx !== "string") {
      return "localWhisperExecutable must be a string.";
    }
    const t = lwx.trim();
    if (t.length > LOCAL_WHISPER_EXE_MAX_LEN) {
      return "localWhisperExecutable is too long.";
    }
    if (t.includes("\n") || t.includes("\r")) {
      return "localWhisperExecutable must not contain line breaks.";
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) {
      continue;
    }
    if (MODEL_PRESET_ARRAY_KEYS.has(k)) {
      if (!Array.isArray(v)) {
        return `Field "${k}" must be an array of strings or null.`;
      }
      if (v.length > EVAL_MODEL_OPTION_MAX) {
        return `Field "${k}" must have at most ${EVAL_MODEL_OPTION_MAX} entries.`;
      }
      for (const item of v) {
        if (typeof item !== "string") {
          return `Field "${k}" entries must be strings.`;
        }
        const t = item.trim();
        if (k === "whisperModelOptions") {
          const tl = t.toLowerCase();
          if (!tl || !isAllowedWhisperModelId(paths, tl)) {
            return `Field "${k}" contains an invalid Whisper model id "${item}".`;
          }
        } else if (!t || t.length > EVAL_MODEL_OPTION_ITEM_MAX_LEN || !EVAL_MODEL_OPTION_ITEM_RE.test(t)) {
          return `Field "${k}" contains an invalid model id "${item}".`;
        }
      }
      continue;
    }
    if (typeof v !== "string") {
      return `Field "${k}" must be a string or null.`;
    }
  }
  return null;
}
