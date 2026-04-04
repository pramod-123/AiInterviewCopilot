/**
 * Builds a screen+coding interview MP4 from fixtures/synthetic/longest-substring-interview-timeline.json:
 * - macOS `say` for one consistent voice (override with SAY_VOICE)
 * - sharp: LeetCode-inspired split UI (description + editor, line numbers, JS highlight)
 * - ffmpeg: narration with human-like pauses, padded/trimmed to each interval’s JSON duration (full timeline = 10:00)
 * - Occasional “typing” frames: partial variable names or truncated lines before the final code state
 *
 * Output: fixtures/synthetic/generated/longest-substring-interview-synthetic.mp4 (gitignored)
 *
 * UI is inspired by common competitive-programming layouts (no logos or trademarks).
 *
 * Requires: macOS (for `say`), ffmpeg/ffprobe on PATH, run from server/: npm run fixture:video:longest-substring
 *
 * Env: SAY_VOICE (default Samantha), FIXTURE_RANDOM_SEED (default 20260331) for reproducible pauses/typing.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");
const FIXTURE_JSON = join(SERVER_ROOT, "fixtures/synthetic/longest-substring-interview-timeline.json");
const FIXTURE_PROBLEM = join(SERVER_ROOT, "fixtures/synthetic/longest-substring-problem-panel.txt");
const OUT_DIR = join(SERVER_ROOT, "fixtures/synthetic/generated");
const FINAL_MP4 = join(OUT_DIR, "longest-substring-interview-synthetic.mp4");
const WORK_DIR = join(OUT_DIR, "work");
const VOICE = process.env.SAY_VOICE ?? "Samantha";

type Interval = { start: number; end: number; speech: string; frameData: string[] };

/** Deterministic PRNG for reproducible pauses / typing (override with FIXTURE_RANDOM_SEED). */
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_SEED = (() => {
  const e = process.env.FIXTURE_RANDOM_SEED;
  if (e === undefined || e === "") return 20260331;
  const n = parseInt(e, 10);
  return Number.isFinite(n) ? n : 20260331;
})();

/** Split speech into TTS-sized chunks; pauses are inserted between chunks. */
function splitSpeechIntoChunks(speech: string): string[] {
  const cleaned = speech.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (t.length <= 140) {
      chunks.push(t);
      continue;
    }
    const subs = t.split(/,\s+/);
    let buf = "";
    for (const part of subs) {
      const next = buf ? `${buf}, ${part}` : part;
      if (next.length > 120 && buf) {
        chunks.push(buf);
        buf = part;
      } else buf = next;
    }
    if (buf) chunks.push(buf);
  }
  return chunks.length > 0 ? chunks : [cleaned];
}

/** Occasionally shorten an identifier or the end of a line (mid-typing). */
function partialCodeSnapshot(code: string, rng: () => number): string {
  const lines = code.split("\n");
  type Hit = { li: number; start: number; end: number; word: string };
  const hits: Hit[] = [];
  const idRe = /\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (/^\s*\/\//.test(line)) continue;
    idRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(line)) !== null) {
      const word = m[0];
      if (JS_KW.has(word)) continue;
      hits.push({ li, start: m.index, end: m.index + word.length, word });
    }
  }
  if (hits.length > 0 && rng() < 0.72) {
    const h = hits[Math.floor(rng() * hits.length)]!;
    const minKeep = Math.max(1, Math.floor(h.word.length * 0.35));
    const maxKeep = Math.max(minKeep, h.word.length - 1);
    const keep = minKeep + Math.floor(rng() * (maxKeep - minKeep + 1));
    const partial = h.word.slice(0, keep);
    const L = lines[h.li]!;
    lines[h.li] = L.slice(0, h.start) + partial + L.slice(h.end);
    return lines.join("\n");
  }
  const nonempty = lines
    .map((L, i) => ({ L, i }))
    .filter(({ L }) => L.trim().length > 8 && !/^\s*\/\//.test(L));
  if (nonempty.length === 0) return code;
  const pick = nonempty[Math.floor(rng() * nonempty.length)]!;
  const L = pick.L;
  const cut = 1 + Math.floor(rng() * Math.min(14, Math.max(2, L.length - 2)));
  lines[pick.i] = L.slice(0, Math.max(1, L.length - cut));
  return lines.join("\n");
}

function buildCodePhaseDurations(
  targetSec: number,
  finalCode: string,
  segmentIndex: number,
): { codes: string[]; phaseSec: number[] } {
  const rng = mulberry32(RANDOM_SEED + segmentIndex * 100003 + 17);
  const typing = rng() < 0.42 && finalCode.trim().length > 12;
  if (!typing) {
    return { codes: [finalCode], phaseSec: [targetSec] };
  }
  const rough = partialCodeSnapshot(finalCode, rng);
  if (rough === finalCode) {
    return { codes: [finalCode], phaseSec: [targetSec] };
  }
  const shareTyping = 0.18 + rng() * 0.28;
  const tTyping = Math.max(0.8, targetSec * shareTyping);
  const tFinal = Math.max(0.5, targetSec - tTyping);
  const drift = targetSec - (tTyping + tFinal);
  return { codes: [rough, finalCode], phaseSec: [tTyping + drift, tFinal] };
}

async function writeSilenceWav(outPath: string, sec: number): Promise<void> {
  if (sec <= 0) return;
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    String(sec),
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

async function concatWavFiles(
  inputBasenames: string[],
  listBasename: string,
  outBasename: string,
  cwd: string,
): Promise<void> {
  const body = inputBasenames.map((b) => `file '${b.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(join(cwd, listBasename), body, "utf8");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listBasename,
      "-c:a",
      "copy",
      outBasename,
    ],
    { cwd },
  );
}

async function buildSegmentWavWithPauses(
  speech: string,
  workDir: string,
  segIndex: number,
  targetSec: number,
): Promise<string> {
  const rng = mulberry32(RANDOM_SEED + segIndex * 7919 + 3);
  let chunks = splitSpeechIntoChunks(speech);
  if (chunks.length === 0) chunks = ["…"];
  const mergedParts: string[] = [];
  const listName = `seg-${segIndex}-wavlist.txt`;
  const mergedRawBasename = `seg-${segIndex}-merged-raw.wav`;

  if (rng() < 0.22) {
    const think = 0.35 + rng() * 0.95;
    const sil = join(workDir, `seg-${segIndex}-think.wav`);
    await writeSilenceWav(sil, think);
    mergedParts.push(sil);
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunkTxt = join(workDir, `seg-${segIndex}-c${c}.txt`);
    const aiff = join(workDir, `seg-${segIndex}-c${c}.aiff`);
    const wav = join(workDir, `seg-${segIndex}-c${c}.wav`);
    await writeFile(chunkTxt, chunks[c]!, "utf8");
    await execFileAsync("say", ["-v", VOICE, "-o", aiff, "-f", chunkTxt]);
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      aiff,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    mergedParts.push(wav);
    if (c < chunks.length - 1) {
      const pauseSec = 0.14 + rng() * 0.62;
      const sil = join(workDir, `seg-${segIndex}-gap${c}.wav`);
      await writeSilenceWav(sil, pauseSec);
      mergedParts.push(sil);
    }
  }

  const relParts = mergedParts.map((p) => p.slice(p.lastIndexOf("/") + 1));
  await concatWavFiles(relParts, listName, mergedRawBasename, workDir);

  const mergedRawPath = join(workDir, mergedRawBasename);
  const dur = await ffprobeDurationSec(mergedRawPath);
  const outFinal = join(workDir, `seg-${segIndex}.wav`);

  if (dur < targetSec - 0.05) {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mergedRawPath,
      "-af",
      `apad=whole_dur=${targetSec}`,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outFinal,
    ]);
  } else if (dur > targetSec + 0.05) {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mergedRawPath,
      "-t",
      String(targetSec),
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outFinal,
    ]);
  } else {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mergedRawPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outFinal,
    ]);
  }

  return outFinal;
}

async function muxSegmentMp4(opts: {
  workDir: string;
  segIndex: number;
  codes: string[];
  phaseSec: number[];
  audioWav: string;
  outMp4: string;
  problemRaw: string;
  width: number;
  height: number;
}): Promise<void> {
  const { workDir, segIndex, codes, phaseSec, audioWav, outMp4, problemRaw, width, height } = opts;
  const sum = phaseSec.reduce((a, b) => a + b, 0);
  const audioDur = await ffprobeDurationSec(audioWav);
  const target = audioDur;
  let phases = [...phaseSec];
  if (Math.abs(sum - target) > 0.02) {
    const scale = target / sum;
    phases = phases.map((p) => p * scale);
    const drift = target - phases.reduce((a, b) => a + b, 0);
    phases[phases.length - 1]! += drift;
  }

  if (codes.length === 1) {
    const pngPath = join(workDir, `seg-${segIndex}.png`);
    const svg = leetcodeStyleSvg(codes[0]!, problemRaw, width, height);
    await sharp(Buffer.from(svg)).png().toFile(pngPath);
    const audioT = await ffprobeDurationSec(audioWav);
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-i",
      pngPath,
      "-i",
      audioWav,
      "-t",
      String(audioT),
      "-c:v",
      "libx264",
      "-tune",
      "stillimage",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-pix_fmt",
      "yuv420p",
      outMp4,
    ]);
    return;
  }

  const pngPaths: string[] = [];
  for (let j = 0; j < codes.length; j++) {
    const pngPath = join(workDir, `seg-${segIndex}-v${j}.png`);
    const svg = leetcodeStyleSvg(codes[j]!, problemRaw, width, height);
    await sharp(Buffer.from(svg)).png().toFile(pngPath);
    pngPaths.push(pngPath);
  }

  const vidOnly = join(workDir, `seg-${segIndex}-video-only.mp4`);
  const ffArgs = ["-hide_banner", "-loglevel", "error", "-y"];
  for (let j = 0; j < pngPaths.length; j++) {
    ffArgs.push(
      "-loop",
      "1",
      "-t",
      String(Math.max(0.04, phases[j]!)),
      "-i",
      pngPaths[j]!,
    );
  }
  const n = pngPaths.length;
  const labels = Array.from({ length: n }, (_, j) => `[${j}:v]`).join("");
  ffArgs.push(
    "-filter_complex",
    `${labels}concat=n=${n}:v=1:a=0[outv]`,
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    vidOnly,
  );
  await execFileAsync("ffmpeg", ffArgs);

  const audioTEnd = await ffprobeDurationSec(audioWav);
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    vidOnly,
    "-i",
    audioWav,
    "-t",
    String(audioTEnd),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outMp4,
  ]);
}

/** Dark split-pane palette (LeetCode-style, generic). */
const LC = {
  page: "#0a0a0a",
  topBar: "#282828",
  topBorder: "#3c3c3c",
  leftPanel: "#141414",
  tabInactive: "#8a8f99",
  tabActive: "#f5a623",
  descText: "#e8eaed",
  descMuted: "#9aa0a6",
  editorBg: "#1e1e1e",
  gutterBg: "#252526",
  gutterText: "#858585",
  divider: "#2d2d2d",
  badgeBg: "#e2b203",
  badgeText: "#1a1a1a",
};

const JS_KW = new Set([
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "let",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "class",
  "extends",
  "super",
  "static",
  "await",
  "of",
  "Math",
  "Set",
  "console",
  "undefined",
  "null",
  "true",
  "false",
]);

type TokKind = "com" | "str" | "kw" | "num" | "id" | "sym" | "ws";

function fillForKind(k: TokKind): string {
  switch (k) {
    case "com":
      return "#6a9955";
    case "str":
      return "#ce9178";
    case "kw":
      return "#569cd6";
    case "num":
      return "#b5cea8";
    default:
      return "#d4d4d4";
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tokenizeJsLine(line: string): Array<{ v: string; k: TokKind }> {
  const out: Array<{ v: string; k: TokKind }> = [];
  let i = 0;
  const n = line.length;

  function readStr(quote: string): string {
    let j = i + 1;
    let s = quote;
    while (j < n) {
      const ch = line[j]!;
      s += ch;
      if (ch === "\\" && j + 1 < n) {
        j++;
        s += line[j]!;
      } else if (ch === quote) {
        j++;
        break;
      }
      j++;
    }
    i = j;
    return s;
  }

  while (i < n) {
    if (line[i] === "/" && line[i + 1] === "/") {
      out.push({ v: line.slice(i), k: "com" });
      break;
    }
    const ch = line[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      out.push({ v: readStr(ch), k: "str" });
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(line[j]!)) j++;
      out.push({ v: line.slice(i, j), k: "ws" });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(line[j]!)) j++;
      out.push({ v: line.slice(i, j), k: "num" });
      i = j;
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      out.push({ v: word, k: JS_KW.has(word) ? "kw" : "id" });
      i = j;
      continue;
    }
    out.push({ v: ch, k: "sym" });
    i++;
  }
  return out;
}

function wrapParagraph(text: string, maxLen: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxLen) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxLen ? `${w.slice(0, maxLen - 1)}…` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function problemTextToLines(raw: string, maxLen: number): string[] {
  const blocks = raw.trim().split(/\n\s*\n/);
  const lines: string[] = [];
  for (const block of blocks) {
    const flat = block.replace(/\n/g, " ").trim();
    lines.push(...wrapParagraph(flat, maxLen));
    lines.push("");
  }
  return lines;
}

function renderHighlightedLine(line: string, startX: number, y: number, charPx: number): string {
  let x = startX;
  const parts: string[] = [];
  for (const t of tokenizeJsLine(line)) {
    const w = t.v.length * charPx;
    parts.push(
      `<tspan x="${x.toFixed(2)}" y="${y}" fill="${fillForKind(t.k)}">${escapeXml(t.v)}</tspan>`,
    );
    x += w;
  }
  return parts.join("");
}

function leetcodeStyleSvg(code: string, problemRaw: string, width: number, height: number): string {
  const topH = 48;
  const tabStrip = 34;
  const mainTop = topH + tabStrip;
  const editorTabH = 28;
  const leftW = Math.floor(width * 0.42);
  const gutterW = 44;
  const fontCode = 14;
  const charPx = fontCode * 0.62;
  const lineH = 22;
  const descFont = 13;
  const descLineH = 19;
  const problemLines = problemTextToLines(problemRaw, 44);
  const maxDescLines = Math.floor((height - mainTop - 16) / descLineH);
  const descShown = problemLines.slice(0, maxDescLines);
  if (problemLines.length > maxDescLines) {
    descShown.push("…");
  }

  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const codeAreaH = height - mainTop - editorTabH - 12;
  const maxCodeLines = Math.max(1, Math.floor(codeAreaH / lineH));
  const codeLines = lines.length > maxCodeLines ? [...lines.slice(0, maxCodeLines - 1), "// …"] : lines;

  const codeBaseX = leftW + gutterW + 12;
  const maxChars = Math.max(20, Math.floor((width - codeBaseX - 16) / charPx));

  const codeLineY0 = mainTop + editorTabH + 12;
  const codeBlocks: string[] = [];
  for (let li = 0; li < codeLines.length; li++) {
    let line = codeLines[li]!;
    if (line.length > maxChars) line = `${line.slice(0, maxChars - 2)}…`;
    const y = codeLineY0 + (li + 1) * lineH;
    const num = String(li + 1);
    const numX = leftW + gutterW - 6 - num.length * (descFont * 0.55);
    codeBlocks.push(
      `<text font-family="Menlo,Monaco,Consolas,monospace" font-size="${descFont}" fill="${LC.gutterText}" x="${numX.toFixed(1)}" y="${y}">${num}</text>`,
    );
    codeBlocks.push(
      `<text font-family="Menlo,Monaco,Consolas,monospace" font-size="${fontCode}" xml:space="preserve">${renderHighlightedLine(line, codeBaseX, y, charPx)}</text>`,
    );
  }

  const descY0 = mainTop + 6;
  const descBlocks = descShown
    .map((line, i) => {
      const fill = line.startsWith("Example") || line.startsWith("Constraints") ? LC.tabActive : LC.descText;
      return `<text x="20" y="${descY0 + (i + 1) * descLineH}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="${descFont}" fill="${fill}">${escapeXml(line)}</text>`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${LC.page}"/>
  <rect x="0" y="0" width="${width}" height="${topH}" fill="${LC.topBar}"/>
  <line x1="0" y1="${topH}" x2="${width}" y2="${topH}" stroke="${LC.topBorder}" stroke-width="1"/>
  <text x="20" y="31" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" fill="${LC.descText}">3. Longest Substring Without Repeating Characters</text>
  <rect x="560" y="14" rx="4" ry="4" width="58" height="22" fill="${LC.badgeBg}"/>
  <text x="572" y="29" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="11" font-weight="600" fill="${LC.badgeText}">Medium</text>
  <text x="630" y="29" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="12" fill="${LC.descMuted}">JavaScript</text>

  <rect x="0" y="${topH}" width="${leftW}" height="${height - topH}" fill="${LC.leftPanel}"/>
  <line x1="${leftW}" y1="${topH}" x2="${leftW}" y2="${height}" stroke="${LC.divider}" stroke-width="1"/>

  <text x="20" y="${topH + 22}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="${LC.tabActive}">Description</text>
  <line x1="20" y1="${topH + 28}" x2="100" y2="${topH + 28}" stroke="${LC.tabActive}" stroke-width="2"/>
  <text x="115" y="${topH + 22}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="13" fill="${LC.tabInactive}">Editorial</text>
  <text x="200" y="${topH + 22}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="13" fill="${LC.tabInactive}">Solutions</text>

  ${descBlocks}

  <rect x="${leftW}" y="${mainTop}" width="${width - leftW}" height="${height - mainTop}" fill="${LC.editorBg}"/>
  <rect x="${leftW}" y="${mainTop}" width="${gutterW}" height="${height - mainTop}" fill="${LC.gutterBg}"/>
  <text x="${leftW + 10}" y="${mainTop + 18}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="12" fill="${LC.tabActive}">Code</text>
  <line x1="${leftW + 8}" y1="${mainTop + editorTabH - 2}" x2="${leftW + 40}" y2="${mainTop + editorTabH - 2}" stroke="${LC.tabActive}" stroke-width="2"/>
  ${codeBlocks.join("\n  ")}
</svg>`;
}

async function ffprobeDurationSec(wavPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    wavPath,
  ]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad duration from ffprobe: ${stdout}`);
  return n;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("This script uses macOS `say`. On Linux consider piping espeak-ng to ffmpeg, or set a custom pipeline.");
    process.exit(1);
  }

  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });

  const raw = await readFile(FIXTURE_JSON, "utf8");
  const intervals = JSON.parse(raw) as Interval[];
  const problemRaw = await readFile(FIXTURE_PROBLEM, "utf8");

  const W = 1280;
  const H = 720;
  const segmentPaths: string[] = [];

  let totalSlotSec = 0;
  for (let i = 0; i < intervals.length; i++) {
    const seg = intervals[i];
    const targetSec = (seg.end - seg.start) / 1000;
    totalSlotSec += targetSec;
    const mp4Path = join(WORK_DIR, `seg-${i}.mp4`);
    const finalCode =
      seg.frameData.length > 0 ? seg.frameData[seg.frameData.length - 1]! : "// (no code snapshot)";
    const { codes, phaseSec } = buildCodePhaseDurations(targetSec, finalCode, i);
    const wavPath = await buildSegmentWavWithPauses(seg.speech, WORK_DIR, i, targetSec);
    await muxSegmentMp4({
      workDir: WORK_DIR,
      segIndex: i,
      codes,
      phaseSec,
      audioWav: wavPath,
      outMp4: mp4Path,
      problemRaw,
      width: W,
      height: H,
    });
    segmentPaths.push(mp4Path);
    const wavDur = await ffprobeDurationSec(wavPath);
    console.error(
      `Segment ${i + 1}/${intervals.length}  slot ${targetSec.toFixed(1)}s  wav ${wavDur.toFixed(1)}s  codeFrames ${codes.length}`,
    );
  }
  console.error(`Total timeline slots: ${totalSlotSec.toFixed(1)}s (expect 600 for 10:00)`);

  const listPath = join(WORK_DIR, "concat.txt");
  const listBody = segmentPaths
    .map((p) => `file '${p.slice(p.lastIndexOf("/") + 1)}'`)
    .join("\n");
  await writeFile(listPath, listBody, "utf8");

  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      FINAL_MP4,
    ],
    { cwd: WORK_DIR },
  );

  console.error(`Wrote ${FINAL_MP4}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
