import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SpeechSegment, SpeechTranscription } from "../../types/speechTranscription.js";
import type { ISpeechToTextService } from "./ISpeechToTextService.js";
import { transcribeWavByTimeWindows, wavDurationSec } from "./wavChunkTranscription.js";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "local";
const DEFAULT_EXECUTABLE = "whisper";
const DEFAULT_MODEL = "base";

type WhisperJsonFile = {
  text?: string;
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
};

function parseWhisperJson(
  raw: string,
  durationFallback: number,
  modelId: string,
): SpeechTranscription {
  let data: WhisperJsonFile;
  try {
    data = JSON.parse(raw) as WhisperJsonFile;
  } catch {
    return new SpeechTranscription([], 0, null, null, PROVIDER_ID, modelId);
  }

  const fullText =
    typeof data.text === "string" && data.text.trim() ? data.text.trim() : null;
  const language = typeof data.language === "string" ? data.language : null;
  const segments: SpeechSegment[] = [];
  for (const s of data.segments ?? []) {
    const start = typeof s.start === "number" ? s.start : 0;
    const end = typeof s.end === "number" ? s.end : start;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (text) {
      segments.push(new SpeechSegment(start, end, text));
    }
  }

  let durationSec = durationFallback;
  if (segments.length > 0) {
    durationSec = Math.max(durationSec, segments[segments.length - 1]!.endSec);
  }

  if (segments.length === 0 && fullText) {
    const end = durationSec > 0 ? durationSec : 0.001;
    segments.push(new SpeechSegment(0, end, fullText));
  }

  return new SpeechTranscription(
    segments,
    durationSec,
    language,
    fullText,
    PROVIDER_ID,
    modelId,
  );
}

/**
 * Runs the OpenAI Whisper **Python** CLI (`pip install openai-whisper`) on WAV files.
 *
 * - `LOCAL_WHISPER_EXECUTABLE`, `LOCAL_WHISPER_MODEL`
 * - `LOCAL_WHISPER_MAX_CHUNK_BYTES`: if unset, the **whole file** is sent in one CLI run (no time splitting).
 *   Set a byte cap to split long files into FFmpeg windows (same PCM assumptions as other STT paths).
 */
export class LocalWhisperSpeechToTextService implements ISpeechToTextService {
  readonly providerId = PROVIDER_ID;

  constructor(
    private readonly executable: string,
    private readonly modelId: string,
    private readonly maxChunkBytes: number,
  ) {}

  static tryCreate(env: NodeJS.ProcessEnv = process.env): LocalWhisperSpeechToTextService | null {
    const exe = env.LOCAL_WHISPER_EXECUTABLE?.trim() || DEFAULT_EXECUTABLE;
    const model = env.LOCAL_WHISPER_MODEL?.trim() || DEFAULT_MODEL;
    const raw = env.LOCAL_WHISPER_MAX_CHUNK_BYTES?.trim();
    const maxChunkBytes =
      raw == null || raw === ""
        ? Number.MAX_SAFE_INTEGER
        : (() => {
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) {
              throw new Error(
                `LOCAL_WHISPER_MAX_CHUNK_BYTES must be a positive number when set; got "${raw}".`,
              );
            }
            return Math.floor(n);
          })();
    return new LocalWhisperSpeechToTextService(exe, model, maxChunkBytes);
  }

  async transcribeFromFile(audioFilePath: string): Promise<SpeechTranscription> {
    return transcribeWavByTimeWindows({
      wavPath: audioFilePath,
      maxChunkBytes: this.maxChunkBytes,
      logLabel: "[stt:local]",
      transcribeChunk: (chunkPath) => this.transcribeOneWav(chunkPath),
    });
  }

  private async transcribeOneWav(wavPath: string): Promise<SpeechTranscription> {
    const tmpOut = path.join(
      path.dirname(wavPath),
      `.whisper-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpOut, { recursive: true });
    try {
      await execFileAsync(
        this.executable,
        [
          wavPath,
          "--model",
          this.modelId,
          "--output_format",
          "json",
          "--output_dir",
          tmpOut,
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );

      const base = path.basename(wavPath, path.extname(wavPath));
      const jsonPath = path.join(tmpOut, `${base}.json`);
      const raw = await readFile(jsonPath, "utf-8");
      const dur = await wavDurationSec(wavPath).catch(() => 0);
      const tr = parseWhisperJson(raw, dur, this.modelId);
      return new SpeechTranscription(
        tr.segments,
        tr.durationSec > 0 ? tr.durationSec : dur,
        tr.language,
        tr.fullText,
        PROVIDER_ID,
        this.modelId,
      );
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  }
}
