import { describe, expect, it } from "vitest";
import type { LiveServerMessage } from "@google/genai";
import { geminiLiveMessageToClientPayload } from "../../src/live-session/realtime/geminiLiveMessageMapper.js";

describe("geminiLiveMessageToClientPayload", () => {
  it("returns empty array for empty message", () => {
    expect(geminiLiveMessageToClientPayload({} as LiveServerMessage)).toEqual([]);
  });

  it("maps toolCall function names", () => {
    const msg = {
      toolCall: {
        functionCalls: [{ name: "foo" }, { name: "bar" }, { name: "" }],
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "toolCall", names: ["foo", "bar"] },
    ]);
  });

  it("maps serverContent lifecycle flags", () => {
    const msg = {
      serverContent: {
        interrupted: true,
        generationComplete: true,
        turnComplete: true,
        waitingForInput: true,
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "interrupted", value: true },
      { type: "generationComplete", value: true },
      { type: "turnComplete", value: true },
      { type: "waitingForInput", value: true },
    ]);
  });

  it("maps transcriptions when text non-empty", () => {
    const msg = {
      serverContent: {
        inputTranscription: { text: "hi", finished: true },
        outputTranscription: { text: "there", finished: false },
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "inputTranscription", text: "hi", finished: true },
      { type: "outputTranscription", text: "there", finished: false },
    ]);
  });

  it("skips transcriptions with empty or missing text", () => {
    const msg = {
      serverContent: {
        inputTranscription: { text: "", finished: true },
        outputTranscription: { text: "ok" },
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "outputTranscription", text: "ok", finished: false },
    ]);
  });

  it("maps modelTurn audio and text parts", () => {
    const msg = {
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: "YmFzZTY0", mimeType: "audio/pcm;rate=24000" } },
            { text: "Hello" },
            { inlineData: { data: "x", mimeType: "image/png" } },
          ],
        },
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "modelAudio", mimeType: "audio/pcm;rate=24000", data: "YmFzZTY0" },
      { type: "modelText", text: "Hello" },
    ]);
  });

  it("maps modelTurn text with thought flag as modelThought", () => {
    const msg = {
      serverContent: {
        modelTurn: {
          parts: [{ text: "Planning…", thought: true }, { text: "Hi there" }],
        },
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "modelThought", text: "Planning…" },
      { type: "modelText", text: "Hi there" },
    ]);
  });

  it("maps goAway with timeLeft", () => {
    const msg = { goAway: { timeLeft: "30s" } } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "goAway", timeLeft: "30s" },
    ]);
  });

  it("maps goAway with null timeLeft when absent", () => {
    const msg = { goAway: {} } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "goAway", timeLeft: null },
    ]);
  });

  it("maps sessionResumptionUpdate without exposing newHandle", () => {
    const msg = {
      sessionResumptionUpdate: {
        newHandle: "secret-token",
        resumable: true,
        lastConsumedClientMessageIndex: "42",
      },
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      {
        type: "sessionResumptionUpdate",
        resumable: true,
        lastConsumedClientMessageIndex: "42",
      },
    ]);
  });

  it("maps sessionResumptionUpdate with null resumable when absent", () => {
    const msg = {
      sessionResumptionUpdate: {},
    } as LiveServerMessage;
    expect(geminiLiveMessageToClientPayload(msg)).toEqual([
      { type: "sessionResumptionUpdate", resumable: null },
    ]);
  });
});
