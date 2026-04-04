import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { AppPaths } from "../../infrastructure/AppPaths.js";
import type { DiarizationPipelineResult } from "../../types/diarization.js";
import { isWhisperXSrtProviderEnv } from "../utilities/resolveSrtGeneratorProviderFromEnv.js";
import { parseDiarizationJson } from "./parseDiarizationJson.js";

function diarizationScriptPath(paths: AppPaths): string {
  return path.join(paths.serverRoot, "scripts", "diarize_dialogue_whisperx.py");
}

/** True when env selects WhisperX for SRT/diarization (`SRT_GENERATOR_PROVIDER` or `DIARIZATION_PROVIDER`). */
export function isWhisperXDiarizationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWhisperXSrtProviderEnv(env);
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DIARIZATION_TIMEOUT_MS?.trim();
  if (raw == null || raw === "") {
    return 3_600_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3_600_000;
}

/**
 * Runs WhisperX in a Python subprocess. Requires `pip install whisperx` (and torch), ffmpeg, and env
 * `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` (read access). Gated pyannote weights need the same
 * Hugging Face account to accept model terms — see `server/.env.example` (WhisperX / Hugging Face section).
 */
export async function runWhisperXDiarization(params: {
  paths: AppPaths;
  wavPath: string;
  outJsonPath: string;
  audioSource: DiarizationPipelineResult["audioSource"];
  log: FastifyBaseLogger;
}): Promise<DiarizationPipelineResult | null> {
  const { paths, wavPath, outJsonPath, audioSource, log } = params;
  const python = process.env.DIARIZATION_PYTHON?.trim() || "python3";
  const script = diarizationScriptPath(paths);

  try {
    await fs.access(script);
    await fs.access(wavPath);
  } catch (err) {
    log.warn({ err, script, wavPath }, "WhisperX diarization skipped (script or wav missing).");
    return null;
  }

  const stderrChunks: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const child = spawn(python, [script, wavPath, outJsonPath], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    const ms = timeoutMs(process.env);
    const t = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`WhisperX diarization timed out after ${ms} ms`));
    }, ms);
    child.stderr?.on("data", (c: Buffer) => {
      stderrChunks.push(c.toString("utf8"));
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(t);
      reject(err);
    });
    child.on("close", (c) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(t);
      resolve(c);
    });
  });

  if (code !== 0) {
    log.warn(
      { code, stderr: stderrChunks.join("").slice(-4000) },
      "WhisperX diarization process failed (install whisperx + HF token; see .env.example).",
    );
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(outJsonPath, "utf-8");
  } catch (err) {
    log.warn({ err, outJsonPath }, "WhisperX diarization output json missing.");
    return null;
  }

  const parsed = parseDiarizationJson(raw);
  if (!parsed || parsed.segments.length === 0) {
    log.warn({ outJsonPath }, "WhisperX diarization produced no segments.");
    return null;
  }

  return {
    provider: "whisperx",
    model: parsed.model,
    language: parsed.language,
    audioSource,
    segmentCount: parsed.segments.length,
    artifactPath: outJsonPath,
    segments: parsed.segments,
  };
}
