import { describe, expect, it } from "vitest";
import {
  createOpenAIRealtimeMapperState,
  openaiRealtimeServerEventToClientPayloads,
  OPENAI_REALTIME_OUTPUT_AUDIO_MIME,
} from "../../src/live-session/realtime/openai/openaiRealtimeMessageMapper.js";

describe("openaiRealtimeServerEventToClientPayloads", () => {
  it("maps response.audio.delta to modelAudio", () => {
    const state = createOpenAIRealtimeMapperState();
    const payloads = openaiRealtimeServerEventToClientPayloads(
      { type: "response.audio.delta", delta: "AAA" },
      state,
    );
    expect(payloads).toEqual([
      { type: "modelAudio", mimeType: OPENAI_REALTIME_OUTPUT_AUDIO_MIME, data: "AAA" },
    ]);
  });

  it("accumulates output transcript deltas", () => {
    const state = createOpenAIRealtimeMapperState();
    const a = openaiRealtimeServerEventToClientPayloads(
      {
        type: "response.audio_transcript.delta",
        delta: "hel",
        response_id: "r1",
        item_id: "i1",
        content_index: 0,
      },
      state,
    );
    const b = openaiRealtimeServerEventToClientPayloads(
      {
        type: "response.audio_transcript.delta",
        delta: "lo",
        response_id: "r1",
        item_id: "i1",
        content_index: 0,
      },
      state,
    );
    const outKey = "r1\0i1\0" + String(0);
    expect(a).toEqual([{ type: "outputTranscription", text: "hel", finished: false, itemKey: outKey }]);
    expect(b).toEqual([{ type: "outputTranscription", text: "hello", finished: false, itemKey: outKey }]);
  });

  it("maps response.audio_transcript.done with finished true", () => {
    const state = createOpenAIRealtimeMapperState();
    const payloads = openaiRealtimeServerEventToClientPayloads(
      {
        type: "response.audio_transcript.done",
        transcript: "hello",
        response_id: "r1",
        item_id: "i1",
        content_index: 0,
      },
      state,
    );
    expect(payloads).toEqual([
      { type: "outputTranscription", text: "hello", finished: true, itemKey: "r1\0i1\0" + String(0) },
    ]);
  });

  it("maps function_call output item to toolCall", () => {
    const state = createOpenAIRealtimeMapperState();
    const payloads = openaiRealtimeServerEventToClientPayloads(
      {
        type: "response.output_item.added",
        item: { type: "function_call", name: "lookup" },
      },
      state,
    );
    expect(payloads).toEqual([{ type: "toolCall", names: ["lookup"] }]);
  });

  it("maps response.done completed to lifecycle flags", () => {
    const state = createOpenAIRealtimeMapperState();
    const payloads = openaiRealtimeServerEventToClientPayloads(
      { type: "response.done", response: { status: "completed" } },
      state,
    );
    expect(payloads).toEqual([
      { type: "generationComplete", value: true },
      { type: "turnComplete", value: true },
      { type: "waitingForInput", value: true },
    ]);
  });

  it("accumulates input transcript deltas with stable itemKey", () => {
    const state = createOpenAIRealtimeMapperState();
    const a = openaiRealtimeServerEventToClientPayloads(
      {
        type: "conversation.item.input_audio_transcription.delta",
        delta: "Hi",
        item_id: "msg_1",
        content_index: 0,
      },
      state,
    );
    const b = openaiRealtimeServerEventToClientPayloads(
      {
        type: "conversation.item.input_audio_transcription.delta",
        delta: " there",
        item_id: "msg_1",
        content_index: 0,
      },
      state,
    );
    expect(a).toEqual([
      {
        type: "inputTranscription",
        text: "Hi",
        finished: false,
        itemKey: "msg_1\0" + "0",
      },
    ]);
    expect(b).toEqual([
      {
        type: "inputTranscription",
        text: "Hi there",
        finished: false,
        itemKey: "msg_1\0" + "0",
      },
    ]);
  });

  it("maps input_audio_transcription.completed with itemKey matching deltas", () => {
    const state = createOpenAIRealtimeMapperState();
    openaiRealtimeServerEventToClientPayloads(
      {
        type: "conversation.item.input_audio_transcription.delta",
        delta: "x",
        item_id: "msg_1",
        content_index: 0,
      },
      state,
    );
    const payloads = openaiRealtimeServerEventToClientPayloads(
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "x",
        item_id: "msg_1",
        content_index: 0,
      },
      state,
    );
    expect(payloads).toEqual([
      {
        type: "inputTranscription",
        text: "x",
        finished: true,
        itemKey: "msg_1\0" + "0",
      },
    ]);
  });

  it("maps cancelled turn_detected to interrupted", () => {
    const state = createOpenAIRealtimeMapperState();
    const payloads = openaiRealtimeServerEventToClientPayloads(
      {
        type: "response.done",
        response: { status: "cancelled", status_details: { reason: "turn_detected" } },
      },
      state,
    );
    expect(payloads).toEqual([{ type: "interrupted", value: true }]);
  });
});
