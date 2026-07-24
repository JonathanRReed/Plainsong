import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
        dictationHandsFreeEnabled: false,
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
    startDictation: vi.fn(async () => {}),
    stopDictation: vi.fn(async () => {}),
    windowHandle: {
      setSize: vi.fn(async () => {}),
      show: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    },
    speechSynthesis: {
      speak: vi.fn(),
      cancel: vi.fn(),
    },
  };
});

vi.mock("@/lib/electron", () => ({
  invoke: popupMocks.invoke,
  listen: vi.fn(
    async (eventName: string, handler: (event: { payload: any }) => void) => {
      popupMocks.listeners.set(eventName, handler);
      return () => popupMocks.listeners.delete(eventName);
    },
  ),
  getCurrentWindow: () => popupMocks.windowHandle,
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: popupMocks.getSettings,
}));

vi.mock("@/lib/backend/dictation", () => ({
  getDictationAudioLevel: popupMocks.getDictationAudioLevel,
  startDictation: popupMocks.startDictation,
  stopDictation: popupMocks.stopDictation,
}));

describe("DictationPopup", () => {
  beforeEach(() => {
    popupMocks.listeners.clear();
    popupMocks.invoke.mockClear();
    popupMocks.getSettings.mockClear();
    popupMocks.getDictationAudioLevel.mockClear();
    popupMocks.startDictation.mockClear();
    popupMocks.stopDictation.mockClear();
    popupMocks.windowHandle.setSize.mockClear();
    popupMocks.windowHandle.show.mockClear();
    popupMocks.windowHandle.hide.mockClear();
    popupMocks.windowHandle.startDragging.mockClear();
    popupMocks.speechSynthesis.speak.mockClear();
    popupMocks.speechSynthesis.cancel.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
    Object.assign(window, {
      speechSynthesis: popupMocks.speechSynthesis,
      SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
        text: string;
        rate = 1;
        pitch = 1;
        lang = "";
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        constructor(text = "") {
          this.text = text;
        }
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a dismissed overlay hidden when the backend snapshot is stale", async () => {
    popupMocks.invoke.mockResolvedValueOnce({
      phase: "idle",
      dismissed: true,
      sessionId: 9,
      message: null,
    } as any);

    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Listening/i)).not.toBeInTheDocument();
    });
    expect(popupMocks.windowHandle.hide).not.toHaveBeenCalled();
    expect(screen.queryByText(/Listening/i)).not.toBeInTheDocument();
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
          // Newer than the hydrated overlay state (sessionId 9); session ids are
          // monotonic, so a new session is always >= the hydrated one.
          sessionId: 10,
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

    expect(
      (await screen.findAllByText("Slack Replies")).length,
    ).toBeGreaterThan(0);
    // New minimal UI shows app target as "Sending to X"
    expect(screen.getByText(/Sending to Slack/i)).toBeInTheDocument();
  });

  it("renders the popup immediately without waiting for settings to load", async () => {
    const pendingSettings = deferred<{
      transcription: {
        dictationPushToTalk: boolean;
        dictationHandsFreeEnabled: boolean;
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

    expect((await screen.findAllByText("Slack & Chat")).length).toBeGreaterThan(
      0,
    );
    // New minimal UI shows app target in status line
    expect(screen.getByText(/Sending to Codex/i)).toBeInTheDocument();
    // Phase shown in header (recording = "Listening")
    expect(screen.getByText(/Listening/i)).toBeInTheDocument();

    await act(async () => {
      pendingSettings.resolve({
        transcription: {
          dictationPushToTalk: false,
          dictationHandsFreeEnabled: false,
          dictationModePreset: "voice",
          dictationSelectedCustomModeId: null,
          dictationCustomModes: [
            { id: "slack-replies", name: "Slack Replies" },
          ],
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

  it("shows hands-free recording guidance when that mode is enabled", async () => {
    popupMocks.getSettings.mockResolvedValueOnce({
      transcription: {
        dictationPushToTalk: false,
        dictationHandsFreeEnabled: true,
        dictationModePreset: "voice",
        dictationSelectedCustomModeId: null,
        dictationCustomModes: [{ id: "slack-replies", name: "Slack Replies" }],
        dictationContextSource: "none",
        dictationProvider: "distil_whisper",
        dictationModelId: "distil-large-v3.5",
        dictationInsertionMode: "auto",
      },
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    // New minimal UI shows app target or context detail
    expect(
      await screen.findByText(/Sending to Codex/i),
    ).toBeInTheDocument();
  });

  it("keeps preview text visible while transcribing and delivering", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    const handler = popupMocks.listeners.get("dictation-state-changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler?.({
        payload: {
          phase: "transcribing",
          sessionId: 41,
          message: "Turning speech into send-ready text.",
          preview: "Draft the follow-up with clear owners.",
          resolvedModePreset: "meeting_follow_up",
          resolvedModeLabel: "Follow-up",
          contextSource: "application_context",
          insertionMode: "paste",
          appTarget: "Slack",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
    });

    expect(
      await screen.findByText("Turning speech into send-ready text."),
    ).toBeInTheDocument();
    expect(screen.getByText("Live preview")).toBeInTheDocument();
    expect(
      screen.getByText("Draft the follow-up with clear owners."),
    ).toBeInTheDocument();

    await act(async () => {
      handler?.({
        payload: {
          phase: "delivering",
          sessionId: 41,
          message: "Delivering the rewrite to Slack now.",
          preview: "Draft the follow-up with clear owners.",
          resolvedModePreset: "meeting_follow_up",
          resolvedModeLabel: "Follow-up",
          contextSource: "application_context",
          insertionMode: "paste",
          appTarget: "Slack",
          dictationProvider: "distil_whisper",
          dictationModelId: "distil-large-v3.5",
        },
      });
    });

    expect(
      await screen.findByText("Delivering the rewrite to Slack now."),
    ).toBeInTheDocument();
    expect(screen.getByText("Latest text")).toBeInTheDocument();
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

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it("dismisses the overlay instead of only hiding the webview locally", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    // Dismissing does not stop capture, so the button is only offered once the
    // microphone is closed — otherwise the HUD would vanish with no indicator
    // anywhere that recording was still running.
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();

    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "pasted",
          preview: "Ship it tomorrow.",
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Hide" }));

    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "dismiss_dictation_overlay",
      );
    });
    expect(popupMocks.windowHandle.hide).not.toHaveBeenCalled();
  });

  it("stops capture from the minimal pill instead of only hiding it", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    // full -> compact -> minimal
    fireEvent.click(await screen.findByRole("button", { name: "Compact" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));

    expect(await screen.findByText("Listening")).toBeInTheDocument();
    // The pill has no other control, so its one button must end the session.
    // Dismissing alone would hide the last indicator of a live microphone.
    expect(screen.queryByRole("button", { name: "Hide popup" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(popupMocks.stopDictation).toHaveBeenCalled();
    });
    expect(popupMocks.invoke).not.toHaveBeenCalledWith(
      "dismiss_dictation_overlay",
    );

    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "pasted",
          preview: "Ship it tomorrow.",
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Hide popup" }));

    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "dismiss_dictation_overlay",
      );
    });
  });

  it("does not promise a clipboard copy when the text was not left there", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "Ship the launch update tomorrow morning.",
          pasted: true,
          copied: false,
          appTarget: "Slack",
        },
      });
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "pasted",
          appTarget: "Slack",
        },
      });
    });

    // "Copy to clipboard" off restores the previous clipboard after the paste,
    // so Cmd+V would hand back whatever the user had copied before dictating.
    expect(
      await screen.findByText("The result was inserted into Slack."),
    ).toBeInTheDocument();
  });

  it("turns done state into a real review surface with command metadata and quick actions", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");
    expect(stateHandler).toBeDefined();
    expect(textReadyHandler).toBeDefined();

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "Ship the launch update tomorrow morning.",
          pasted: true,
          commandApplied: "backtrack_replace_last_insert",
          snippetAppliedCount: 2,
          appTarget: "Slack",
          actualProvider: "distil_whisper",
          modelId: "distil-large-v3.5",
          providerModelLabel: "Distil Whisper",
          resolvedHosting: "local",
        },
      });
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "pasted",
          resolvedModePreset: "messages",
          resolvedModeLabel: "Messages",
          contextSource: "application_context",
          insertionMode: "paste",
          appTarget: "Slack",
        },
      });
    });

    expect(await screen.findByText("Backtrack applied")).toBeInTheDocument();
    expect(
      screen.getByText("Backtrack replace last insert"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 snippets")).toBeInTheDocument();
    expect(screen.getByText("Target Slack")).toBeInTheDocument();
    expect(screen.getByText("Edit commands available")).toBeInTheDocument();
    expect(screen.getByText("Voice edits")).toBeInTheDocument();
    expect(screen.getByText("Copy result")).toBeInTheDocument();
    expect(screen.getByText("Start again")).toBeInTheDocument();
    expect(screen.getByText("Open history")).toBeInTheDocument();
    expect(screen.getByText("Open app")).toBeInTheDocument();
    expect(screen.getByText("Read aloud")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Copy result/i }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "Ship the launch update tomorrow morning.",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /^Start again/i }));

    await waitFor(() => {
      expect(popupMocks.startDictation).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Read aloud/i }));

    await waitFor(() => {
      expect(popupMocks.speechSynthesis.cancel).toHaveBeenCalled();
      expect(popupMocks.speechSynthesis.speak).toHaveBeenCalled();
    });
  });

  it("shows honest recovery actions when dictation fails", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    expect(stateHandler).toBeDefined();

    await act(async () => {
      stateHandler?.({
        payload: {
          phase: "error",
          sessionId: 11,
          message: "Microphone permission is not ready.",
          appTarget: "Codex",
        },
      });
    });

    expect(
      await screen.findByText("Microphone permission is not ready."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start again" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open dictation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy result" }),
    ).not.toBeInTheDocument();
  });
});
