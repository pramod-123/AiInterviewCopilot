import fs from "node:fs";
import { PromptLoader } from "../prompts/PromptLoader.js";
import type { LlmClient } from "../services/llm/LlmClient.js";
import type { VideoCropRect } from "./VideoProcessingPipeline.js";

// --- PNG dimensions -----------------------------------------------------------

export function readPngDimensions(filePath: string): { width: number; height: number } {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 24) {
    throw new Error(`File too small to be a PNG: ${filePath}`);
  }
  const sig = buf.subarray(0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`Not a PNG file: ${filePath}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) {
    throw new Error(`Invalid PNG dimensions in ${filePath}`);
  }
  return { width, height };
}

// --- Result -------------------------------------------------------------------

export type EditorRoiResult = {
  crop: VideoCropRect | null;
  problemStatement: string | null;
  /** Non-empty model output; useful for debugging ROI vs. crop on disk. */
  rawResponseText?: string;
};

export type EditorRoiInput = {
  imagePath: string;
};

const SYSTEM_FILE = "roi-editor-system.md";
const USER_FILE = "roi-editor-user.md";

// --- Parse model JSON ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Prefer full-string parse; if that fails, take the outermost `{ ... }` slice (handles stray prose). */
function jsonPayloadForParse(text: string): string {
  const trimmed = stripCodeFences(text);
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return trimmed.slice(start, end + 1);
    }
    return trimmed;
  }
}

const NESTED_ROI_KEYS = [
  "crop",
  "bbox",
  "roi",
  "editor_roi",
  "editor",
  "editor_rect",
  "rectangle",
] as const;

/** Merge nested `{ crop: { x, ... } }` so inner keys win (models often nest the box). */
function mergeNestedRoiPayload(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parsed };
  for (const k of NESTED_ROI_KEYS) {
    const inner = parsed[k];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      Object.assign(out, inner as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * If all components look like 0–1 fractions, scale to pixels. Otherwise assume pixel coords.
 * Without this, values like x=0.42 are floored to 0 and the crop sticks to the top-left.
 */
function toPixelCropRect(
  x: number,
  y: number,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const finite = [x, y, width, height].every((n) => Number.isFinite(n));
  if (!finite || width <= 0 || height <= 0) {
    return { x, y, width, height };
  }
  const maxv = Math.max(x, y, width, height);
  const looksNormalized =
    maxv <= 1 &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x <= 1 &&
    y <= 1 &&
    width <= 1 &&
    height <= 1;
  if (!looksNormalized) {
    return { x, y, width, height };
  }
  return {
    x: x * imageWidth,
    y: y * imageHeight,
    width: width * imageWidth,
    height: height * imageHeight,
  };
}

function pickNum(parsed: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = parsed[k];
    if (v == null || v === "") {
      continue;
    }
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function readRawCropNumbers(parsed: Record<string, unknown>): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const xMin = pickNum(parsed, ["x_min", "xmin", "XMin", "xMin"]);
  const yMin = pickNum(parsed, ["y_min", "ymin", "YMin", "yMin"]);
  const xMax = pickNum(parsed, ["x_max", "xmax", "XMax", "xMax"]);
  const yMax = pickNum(parsed, ["y_max", "ymax", "YMax", "yMax"]);
  if (xMin != null && yMin != null && xMax != null && yMax != null) {
    return {
      x: xMin,
      y: yMin,
      width: xMax - xMin,
      height: yMax - yMin,
    };
  }

  const left = pickNum(parsed, ["left", "Left", "l", "L"]);
  const top = pickNum(parsed, ["top", "Top", "t", "T"]);
  const right = pickNum(parsed, ["right", "Right", "r", "R"]);
  const bottom = pickNum(parsed, ["bottom", "Bottom", "b", "B"]);
  if (left != null && top != null && right != null && bottom != null) {
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  const cx = pickNum(parsed, ["center_x", "centerX", "cx", "Cx"]);
  const cy = pickNum(parsed, ["center_y", "centerY", "cy", "Cy"]);
  const halfW = pickNum(parsed, ["half_width", "halfWidth"]);
  const halfH = pickNum(parsed, ["half_height", "halfHeight"]);
  if (cx != null && cy != null && halfW != null && halfH != null) {
    return {
      x: cx - halfW,
      y: cy - halfH,
      width: halfW * 2,
      height: halfH * 2,
    };
  }

  const x = pickNum(parsed, ["x", "X"]);
  const y = pickNum(parsed, ["y", "Y"]);
  const width = pickNum(parsed, ["width", "Width", "w", "W"]);
  const height = pickNum(parsed, ["height", "Height", "h", "H"]);
  if (x == null || y == null || width == null || height == null) {
    return null;
  }
  return { x, y, width, height };
}

function parseCrop(
  parsed: Record<string, unknown>,
  imageWidth: number,
  imageHeight: number,
): VideoCropRect | null {
  const raw = readRawCropNumbers(parsed);
  if (!raw) {
    return null;
  }
  const px = toPixelCropRect(raw.x, raw.y, raw.width, raw.height, imageWidth, imageHeight);
  let xi = Math.floor(px.x);
  let yi = Math.floor(px.y);
  let wi = Math.floor(px.width);
  let hi = Math.floor(px.height);
  if (wi < 1 || hi < 1) {
    return null;
  }
  xi = Math.max(0, Math.min(xi, imageWidth - 1));
  yi = Math.max(0, Math.min(yi, imageHeight - 1));
  wi = Math.min(wi, imageWidth - xi);
  hi = Math.min(hi, imageHeight - yi);
  if (wi < 1 || hi < 1) {
    return null;
  }
  return { x: xi, y: yi, width: wi, height: hi };
}

function parseProblemStatement(parsed: Record<string, unknown>): string | null {
  const raw =
    parsed.problem_statement ?? parsed.problemStatement ?? parsed.problem_text;
  if (raw == null) {
    return null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

export function parseEditorRoiResponse(
  rawText: string,
  imageWidth: number,
  imageHeight: number,
): EditorRoiResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayloadForParse(rawText));
  } catch {
    return { crop: null, problemStatement: null };
  }
  if (!isRecord(parsed)) {
    return { crop: null, problemStatement: null };
  }
  const flat = mergeNestedRoiPayload(parsed);
  return {
    crop: parseCrop(flat, imageWidth, imageHeight),
    problemStatement: parseProblemStatement(parsed),
  };
}

export function fillRoiSystemPrompt(
  template: string,
  imageWidth: number,
  imageHeight: number,
): string {
  return template
    .replaceAll("{{IMAGE_WIDTH}}", String(imageWidth))
    .replaceAll("{{IMAGE_HEIGHT}}", String(imageHeight));
}

// --- Service ------------------------------------------------------------------

/**
 * Vision-based editor ROI + problem statement using an injected {@link LlmClient} (multimodal JSON).
 */
export class EditorRoiDetectionService {
  private readonly systemTemplate: string;
  private readonly userTemplate: string;

  constructor(private readonly llm: LlmClient) {
    const loader = new PromptLoader();
    this.systemTemplate = loader.loadSync(SYSTEM_FILE);
    this.userTemplate = loader.loadSync(USER_FILE);
  }

  get providerId(): string {
    return this.llm.getProviderId();
  }

  async detectEditorRoi(input: EditorRoiInput): Promise<EditorRoiResult> {
    const { width, height } = readPngDimensions(input.imagePath);
    const system = fillRoiSystemPrompt(this.systemTemplate, width, height);

    const { text: content } = await this.llm.completeVisionJsonChat({
      system,
      userText: this.userTemplate,
      imagePngPath: input.imagePath,
      temperature: 0.2,
      maxTokens: 4096,
    });

    if (!content.trim()) {
      return { crop: null, problemStatement: null };
    }
    const parsed = parseEditorRoiResponse(content, width, height);
    return { ...parsed, rawResponseText: content.trim() };
  }
}
