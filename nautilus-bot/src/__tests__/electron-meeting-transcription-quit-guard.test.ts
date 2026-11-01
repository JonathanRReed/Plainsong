import { describe, expect, it, vi } from "vitest";
import {
  createMeetingTranscriptionQuitGuard,
  meetingTranscriptionQuitPromptContent,
  type MeetingTranscriptionQuitChoice,
} from "../../electron/meeting-transcription-quit-guard";
import { createDictationQuitGuard } from "../../electron/dictation-quit-guard";
import { createMeetingQuitDraftCoordinator } from "../../electron/meeting-quit-drafts";

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** Electron's before-quit, in main.ts order: dictation, meeting transcript, drafts and meeting stop. */
function app(choices: MeetingTranscriptionQuitChoice[]) {
  const state = {
    meetingId: null as string | null,
    meetingPhase: null as string | null,
    shutdowns: 0,
    stops: 0,
    prompts: 0,
  };
  let quit: () => void = () => undefined;
  const dictation = createDictationQuitGuard({
    stop: async () => undefined,
    discard: async () => undefined,
    readText: async () => null,
    copyText: () => undefined,
    ask: async () => "wait",
    quit: () => quit(),
  });
  const transcription = createMeetingTranscriptionQuitGuard({
    ask: async () => {
      state.prompts += 1;
      return choices.shift() ?? "wait";
    },
    quit: () => quit(),
  });
  const coordinator = createMeetingQuitDraftCoordinator({
    flushRendererDrafts: async () => true,
    finalizeMeeting: async () => {
      // stop_recording: capture ends and transcription begins.
      state.stops += 1;
      setMeeting("processing");
      return { status: "confirmed" };
    },
    reissueQuit: () => quit(),
    setQuitPending: () => undefined,
    onFinalizationFailure: () => undefined,
  });
  const setMeeting = (phase: string | null) => {
    state.meetingPhase = phase;
    // As `nextActiveMeetingRecordingId` does: a finished meeting is no longer active.
    if (phase === null || ["ready", "error", "cancelled", "recoverable"].includes(phase)) state.meetingId = null;
    transcription.onMeetingPhase(state.meetingId ? phase : null);
  };
  quit = () => {
    if (!dictation.beforeQuit("idle")) return;
    if (!transcription.beforeQuit(state.meetingId ? state.meetingPhase : null)) return;
    if (!coordinator.beforeQuit({ activeMeetingId: state.meetingId, needsRendererFlush: false })) return;
    state.shutdowns += 1;
  };
  return { state, quit: () => quit(), setMeeting };
}

describe("meeting transcription quit guard", () => {
  it("holds a quit while the meeting transcribes, and Wait quits when the transcript is done", async () => {
    const { state, quit, setMeeting } = app(["wait"]);
    state.meetingId = "m1";
    setMeeting("processing");
    quit();
    await settle();
    expect(state.prompts).toBe(1);
    expect(state.shutdowns).toBe(0);
    setMeeting("ready");
    await settle();
    expect(state.shutdowns).toBe(1);
  });

  it("a quit during recording stops the meeting, then holds for its transcript", async () => {
    const { state, quit } = app(["quit"]);
    state.meetingId = "m1";
    state.meetingPhase = "recording";
    quit();
    await settle();
    expect(state.stops).toBe(1);
    expect(state.prompts).toBe(1);
    // "Quit and Transcribe Later": the saved audio is retried on next launch.
    expect(state.shutdowns).toBe(1);
  });

  it("never releases on its own while transcription runs", async () => {
    vi.useFakeTimers();
    try {
      const { state, quit, setMeeting } = app(["wait"]);
      state.meetingId = "m1";
      setMeeting("processing");
      quit();
      await settle();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(state.shutdowns).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a quit through when no meeting is transcribing", () => {
    const { state, quit } = app([]);
    quit();
    expect(state.prompts).toBe(0);
    expect(state.shutdowns).toBe(1);
  });

  it("says that the audio is kept and can be transcribed again", () => {
    const content = meetingTranscriptionQuitPromptContent();
    expect(content.buttons).toEqual(["Wait", "Quit and Transcribe Later"]);
    expect(content.choices).toEqual(["wait", "quit"]);
    expect(content.detail).toMatch(/audio is already saved/);
    expect(content.detail).toMatch(/Retry transcription/);
  });
});
