import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppPaths } from "../infrastructure/AppPaths.js";
import {
  isAllowedWhisperModelId,
  patchRuntimeAppConfig,
  readRuntimeAppConfigSync,
  toPublicRuntimeConfig,
} from "../infrastructure/appRuntimeConfig.js";

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
const LLM_PROVIDERS = new Set(["openai", "anthropic", "gemini"]);

export class AppRuntimeConfigRoutesController {
  constructor(private readonly paths: AppPaths) {}

  register(app: FastifyInstance): void {
    app.get("/api/app-config", (_request, reply) => this.handleGet(reply));
    app.put<{ Body: unknown }>("/api/app-config", (request, reply) => this.handlePut(request, reply));
  }

  private handleGet(reply: FastifyReply): void {
    const cfg = readRuntimeAppConfigSync(this.paths);
    void reply.send(toPublicRuntimeConfig(this.paths, cfg));
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
      return `llmProvider must be openai, anthropic, or gemini (got "${lp}").`;
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
