import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import type { DiarizationPipelineResult } from "../../types/diarization.js";
import { tryCreateOpenAiClient } from "../llm/openAiClient.js";

const execFileAsync = promisify(execFile);

export function isOpenAiSemanticDiarizationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIARIZATION_PROVIDER?.trim().toLowerCase() === "openai_semantic";
}

function chatModel(env: NodeJS.ProcessEnv): string {
  const m = env.OPENAI_DIARIZATION_MODEL?.trim();
  if (m) {
    return m;
  }
  const ev = env.OPENAI_EVAL_MODEL?.trim();
  if (ev && ev.startsWith("gpt-")) {
    return ev;
  }
  return "gpt-4o-mini";
}

type WhisperJsonSeg = { start?: number; end?: number; text?: string };

type WhisperJson = { language?: string; segments?: WhisperJsonSeg[] };

/**
 * Local `whisper` JSON (same CLI as {@link LocalWhisperSpeechToTextService}) + OpenAI chat labels
 * each segment INTERVIEWER vs INTERVIEWEE. No Hugging Face / pyannote; not true acoustic diarization.
 */
export async function runOpenAiSemanticDiarization(params: {
  wavPath: string;
  outJsonPath: string;
  audioSource: DiarizationPipelineResult["audioSource"];
  log: FastifyBaseLogger;
}): Promise<DiarizationPipelineResult | null> {
  const { wavPath, outJsonPath, audioSource, log } = params;
  const client = tryCreateOpenAiClient();
  if (!client) {
    log.warn("OpenAI semantic diarization skipped (OPENAI_API_KEY not set).");
    return null;
  }

  const exe = process.env.LOCAL_WHISPER_EXECUTABLE?.trim() || "whisper";
  const modelId = process.env.LOCAL_WHISPER_MODEL?.trim() || "base";

  const tmpOut = path.join(
    path.dirname(wavPath),
    `.whisper-diarize-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpOut, { recursive: true });
  let whisperRaw = "";
  try {
    await execFileAsync(
      exe,
      [wavPath, "--model", modelId, "--output_format", "json", "--output_dir", tmpOut, "--fp16", "False"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const base = path.basename(wavPath, path.extname(wavPath));
    whisperRaw = await readFile(path.join(tmpOut, `${base}.json`), "utf-8");
  } catch (err) {
    log.warn({ err, exe, wavPath }, "OpenAI semantic diarization: local whisper failed.");
    return null;
  } finally {
    await rm(tmpOut, { recursive: true, force: true });
  }

  let whisper: WhisperJson;
  try {
    whisper = JSON.parse(whisperRaw) as WhisperJson;
  } catch {
    log.warn("OpenAI semantic diarization: invalid whisper json.");
    return null;
  }

  const segs = (whisper.segments ?? []).filter(
    (s) => typeof s.text === "string" && s.text.trim().length > 0,
  );
  if (segs.length === 0) {
    log.warn("OpenAI semantic diarization: no whisper segments.");
    return null;
  }

  const lines = segs
    .map((s, i) => {
      const start = typeof s.start === "number" ? s.start : 0;
      const end = typeof s.end === "number" ? s.end : start;
      return `${i} [${start}-${end}s] ${String(s.text).trim()}`;
    })
    .join("\n");

  const chatModelId = chatModel(process.env);
  let content: string;
  try {
    const completion = await client.chat.completions.create({
      model: chatModelId,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You label technical interview transcript segments. Output ONLY valid JSON. Schema: {"labels":[{"i":number,"speaker":"INTERVIEWER"|"INTERVIEWEE"}]}. INTERVIEWER: states problem, asks questions, comments on the candidate\'s approach. INTERVIEWEE: short acknowledgements (ok, hello), explains their own thinking or code.',
        },
        {
          role: "user",
          content: `Label each segment by speaker:\n\n${lines}`,
        },
      ],
    });
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    log.warn({ err }, "OpenAI semantic diarization: chat completion failed.");
    return null;
  }

  let labels: Array<{ i: number; speaker: string }>;
  try {
    const parsed = JSON.parse(content) as { labels?: Array<{ i: number; speaker: string }> };
    labels = parsed.labels ?? [];
  } catch {
    log.warn("OpenAI semantic diarization: invalid labels JSON.");
    return null;
  }

  const byI = new Map(labels.map((l) => [l.i, l.speaker]));
  const segments = segs.map((s, i) => {
    const start = typeof s.start === "number" ? s.start : 0;
    const end = typeof s.end === "number" ? s.end : start;
    const text = String(s.text).trim();
    const sp = byI.get(i) === "INTERVIEWEE" ? "INTERVIEWEE" : "INTERVIEWER";
    return { start, end, speaker: sp, text };
  });

  const lang = typeof whisper.language === "string" ? whisper.language : "en";
  const filePayload = {
    provider: "openai_semantic" as const,
    model: chatModelId,
    language: lang,
    note: "Speaker labels from OpenAI on local Whisper segments of the diarization WAV (semantic, not pyannote).",
    segments,
  };
  await writeFile(outJsonPath, JSON.stringify(filePayload, null, 2), "utf-8");

  const diarizedSegments = segments.map((s) => {
    const startMs = Math.max(0, Math.round(s.start * 1000));
    let endMs = Math.max(0, Math.round(s.end * 1000));
    if (endMs <= startMs) {
      endMs = startMs + 1;
    }
    return { startMs, endMs, speaker: s.speaker, text: s.text };
  });

  return {
    provider: "openai_semantic",
    model: chatModelId,
    language: lang,
    audioSource,
    segmentCount: diarizedSegments.length,
    artifactPath: outJsonPath,
    segments: diarizedSegments,
  };
}
