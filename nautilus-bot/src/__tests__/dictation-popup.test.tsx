import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationPopup } from "@/components/popups/dictation-popup";

const popupMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => void>();
  return {
    listeners,
    invoke: vi.fn(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return { phase: "idle", sessionId: null };
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
    popupMocks.windowHandle.hide.mockClear();
    popupMocks.windowHandle.startDragging.mockClear();
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
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
    });

    expect(await screen.findByText(/Slack Replies · Fresh dictation · Paste at cursor · Target Slack/i)).toBeInTheDocument();
  });
});
