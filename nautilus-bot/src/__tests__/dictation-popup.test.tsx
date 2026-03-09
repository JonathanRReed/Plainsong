import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationPopup } from "@/components/popups/dictation-popup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const popupMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => void>();
  return {
    listeners,
    invoke: vi.fn(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return {
          phase: "recording",
          startedAtMs: Date.now(),
          sessionId: 9,
          resolvedModePreset: "messages",
          resolvedModeLabel: "Messages",
          contextSource: "application_context",
          insertionMode: "paste",
          appTarget: "Codex",
          dictationProvider: "whisper",
          dictationModelId: "base",
        };
      }
      return null;
    }),
    getSettings: vi.fn(async () => ({
      transcription: {
        dictationPushToTalk: false,
        dictationModePreset: "voice",
        dictationSelectedCustomModeId: null,
        dictationCustomModes: [{ id: "slack-replies", name: "Slack Replies" }],
        dictationContextSource: "none",
        dictationProvider: "distil_whisper",
        dictationModelId: "distil-large-v3.5",
        dictationInsertionMode: "auto",
      },
    })),
    getDictationAudioLevel: vi.fn(async () => 0.2),
    stopDictation: vi.fn(async () => {}),
    windowHandle: {
      setSize: vi.fn(async () => {}),
      show: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: popupMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    popupMocks.listeners.set(eventName, handler);
    return () => popupMocks.listeners.delete(eventName);
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => popupMocks.windowHandle,
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock("@/lib/tauri", () => ({
  getSettings: popupMocks.getSettings,
  getDictationAudioLevel: popupMocks.getDictationAudioLevel,
  stopDictation: popupMocks.stopDictation,
}));

describe("DictationPopup", () => {
  beforeEach(() => {
    popupMocks.listeners.clear();
    popupMocks.invoke.mockClear();
    popupMocks.getSettings.mockClear();
    popupMocks.getDictationAudioLevel.mockClear();
    popupMocks.stopDictation.mockClear();
    popupMocks.windowHandle.setSize.mockClear();
    popupMocks.windowHandle.show.mockClear();
    popupMocks.windowHandle.hide.mockClear();
    popupMocks.windowHandle.startDragging.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders resolved runtime mode metadata from dictation state events", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-state-changed")).toBeDefined();
    });

    const handler = popupMocks.listeners.get("dictation-state-changed");

    await act(async () => {
      handler?.({
        payload: {
          phase: "recording",
          startedAtMs: Date.now(),
          sessionId: 7,
          resolvedModePreset: "custom",
          resolvedCustomModeId: "slack-replies",
          resolvedModeLabel: "Slack Replies",
          contextSource: "none",
          insertionMode: "paste",
          appTarget: "Slack",
          activationMatcher: "slack",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
    });

    expect(await screen.findByText(/Slack Replies · Fresh dictation · Paste at cursor · Target Slack/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto for Slack via "slack"/i)).toBeInTheDocument();
  });

  it("renders the popup immediately without waiting for settings to load", async () => {
    const pendingSettings = deferred<{
      transcription: {
        dictationPushToTalk: boolean;
        dictationModePreset: string;
        dictationSelectedCustomModeId: null;
        dictationCustomModes: { id: string; name: string }[];
        dictationContextSource: string;
        dictationProvider: string;
        dictationModelId: string;
        dictationInsertionMode: string;
      };
    }>();
    popupMocks.getSettings.mockReturnValueOnce(pendingSettings.promise);

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(
      await screen.findByText(
        /Messages · Using the frontmost app and window · Paste at cursor · Target Codex/i
      )
    ).toBeInTheDocument();

    await act(async () => {
      pendingSettings.resolve({
        transcription: {
          dictationPushToTalk: false,
          dictationModePreset: "voice",
          dictationSelectedCustomModeId: null,
          dictationCustomModes: [{ id: "slack-replies", name: "Slack Replies" }],
          dictationContextSource: "none",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
          dictationInsertionMode: "auto",
        },
      });
      await pendingSettings.promise;
    });
  });

  it("keeps the same session timer when recording updates omit startedAtMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    popupMocks.invoke.mockResolvedValueOnce({
      phase: "recording",
      startedAtMs: Date.now(),
      sessionId: 22,
      resolvedModePreset: "voice",
      resolvedModeLabel: "Voice",
      contextSource: "none",
      insertionMode: "paste",
      appTarget: "Codex",
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3.5",
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText("00:01")).toBeInTheDocument();

    const handler = popupMocks.listeners.get("dictation-state-changed");
    expect(handler).toBeDefined();
    await act(async () => {
      handler?.({
        payload: {
          phase: "recording",
          sessionId: 22,
          preview: "still listening",
          resolvedModePreset: "voice",
          resolvedModeLabel: "Voice",
          contextSource: "none",
          insertionMode: "paste",
          appTarget: "Codex",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("00:02")).toBeInTheDocument();
  });

  it("resets the timer cleanly when a new session starts after idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    popupMocks.invoke.mockResolvedValueOnce({
      phase: "recording",
      startedAtMs: Date.now(),
      sessionId: 22,
      resolvedModePreset: "voice",
      resolvedModeLabel: "Voice",
      contextSource: "none",
      insertionMode: "paste",
      appTarget: "Codex",
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3.5",
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(2100);
    });

    expect(screen.getByText("00:02")).toBeInTheDocument();

    const handler = popupMocks.listeners.get("dictation-state-changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler?.({
        payload: {
          phase: "idle",
          sessionId: 22,
        },
      });
    });

    await act(async () => {
      vi.setSystemTime(new Date("2026-03-09T12:00:10.000Z"));
      handler?.({
        payload: {
          phase: "primed",
          startedAtMs: Date.now(),
          sessionId: 23,
          resolvedModePreset: "voice",
          resolvedModeLabel: "Voice",
          contextSource: "none",
          insertionMode: "paste",
          appTarget: "Codex",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
      handler?.({
        payload: {
          phase: "recording",
          sessionId: 23,
          resolvedModePreset: "voice",
          resolvedModeLabel: "Voice",
          contextSource: "none",
          insertionMode: "paste",
          appTarget: "Codex",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText("00:01")).toBeInTheDocument();
  });

  it("shows the primed state without faking active recording time", async () => {
    popupMocks.invoke.mockResolvedValueOnce({
      phase: "primed",
      startedAtMs: Date.now(),
      sessionId: 30,
      resolvedModePreset: "voice",
      resolvedModeLabel: "Voice",
      contextSource: "none",
      insertionMode: "paste",
      appTarget: "Codex",
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3.5",
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(await screen.findByText("Mic primed")).toBeInTheDocument();
    expect(screen.getByText("--:--")).toBeInTheDocument();
  });
});
