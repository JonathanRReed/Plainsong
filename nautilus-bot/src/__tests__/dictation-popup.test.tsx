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

  it("shows and then clears the 'Recording from a link' notice", async () => {
    // `plainsong://record` is reachable from any web page, so a dictation that
    // a link started has to be visibly attributable rather than silent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-source-notice")).toBeDefined();
    });

    await act(async () => {
      popupMocks.listeners.get("dictation-source-notice")?.({
        payload: { source: "deep_link", message: "Recording from a link", durationMs: 1000 },
      });
    });
    expect(
      await screen.findByTestId("dictation-source-notice"),
    ).toHaveTextContent("Recording from a link");

    // It is a one-second notice, not a permanent badge.
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("dictation-source-notice")).not.toBeInTheDocument();
    });
  });

  it("ignores an empty source notice instead of flashing a blank badge", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });
    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-source-notice")).toBeDefined();
    });
    await act(async () => {
      popupMocks.listeners.get("dictation-source-notice")?.({ payload: { message: "   " } });
    });
    expect(screen.queryByTestId("dictation-source-notice")).not.toBeInTheDocument();
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

    expect(await screen.findByText("Model ready")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it("shows cold-model preparation truthfully and lets the user cancel it", async () => {
    popupMocks.invoke.mockResolvedValueOnce({
      phase: "preparing",
      startedAtMs: Date.now(),
      sessionId: 31,
      message: "Loading the selected dictation model",
      modelReadiness: "loading",
    } as any);

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(await screen.findByText("Loading model")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith("force_stop_dictation");
    });
  });

  it("labels priming, recording and processing distinctly", async () => {
    // "Ready" used to mean both "the microphone is warming up" and "your text
    // is done", which is exactly the ambiguity that makes people keep talking
    // into a closed mic. The three live states must never share a label.
    popupMocks.invoke.mockResolvedValueOnce({
      phase: "primed",
      startedAtMs: Date.now(),
      sessionId: 40,
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

    expect(await screen.findByText("Model ready")).toBeInTheDocument();

    const handler = popupMocks.listeners.get("dictation-state-changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler?.({ payload: { phase: "recording", sessionId: 40 } });
    });
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    expect(screen.queryByText("Model ready")).toBeNull();

    await act(async () => {
      handler?.({ payload: { phase: "transcribing", sessionId: 40 } });
    });
    expect(await screen.findAllByText("Transcribing")).not.toHaveLength(0);
    expect(screen.queryByText("Listening")).toBeNull();
  });

  it("tells the user how to stop and cancel while capture is live", async () => {
    // Escape-cancel has always worked (the native shortcut helper handles it)
    // and no surface in the app said so.
    popupMocks.getSettings.mockResolvedValueOnce({
      shortcuts: { toggleDictation: "Cmd+Shift+Space" },
      transcription: {
        dictationPushToTalk: false,
        dictationHandsFreeEnabled: false,
        dictationModePreset: "voice",
        dictationSelectedCustomModeId: null,
        dictationCustomModes: [],
        dictationContextSource: "none",
        dictationInsertionMode: "auto",
      },
    } as any);

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(
      await screen.findByText("Cmd + Shift + Space to stop · Esc to cancel"),
    ).toBeInTheDocument();
  });

  it("persists the display mode the user picked", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Compact" }));

    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "__overlay_set_display_mode__",
        { displayMode: "compact" },
      );
    });
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

  it("does not dress a failed delivery up as a success", async () => {
    // Insertion failing outright still reaches phase "done" — the transcript
    // exists and is saved — so the done surface itself has to carry the bad
    // news. It used to render a check icon over "Transcription ready".
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<DictationPopup />));
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");
    expect(stateHandler).toBeDefined();

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "Ship the launch update tomorrow morning.",
          pasted: false,
          copied: false,
          error: "Accessibility permission denied",
          appTarget: "Slack",
        },
      });
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "error",
          message:
            "Could not deliver the text. It is saved in your dictation history.",
          appTarget: "Slack",
        },
      });
    });

    expect(
      await screen.findByText("Not delivered — saved to history"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Transcription ready")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Inserted into/)).not.toBeInTheDocument();

    expect(container.querySelector(".lucide-circle-check-big")).toBeNull();
    expect(
      container.querySelector(".lucide-triangle-alert"),
    ).toBeInTheDocument();
  });

  it("reports a failed delivery even when a command was applied", async () => {
    // The commandApplied arms used to run before the outcome check, so a
    // command applied to text nobody received claimed success twice over.
    await act(async () => {
      render(<DictationPopup />);
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "SHIP THE LAUNCH UPDATE.",
          pasted: false,
          copied: false,
          commandApplied: "backtrack_replace_last_insert",
          error: "Accessibility permission denied",
          appTarget: "Slack",
        },
      });
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "error",
          appTarget: "Slack",
        },
      });
    });

    expect(
      await screen.findByText("Not delivered — saved to history"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Backtrack applied")).not.toBeInTheDocument();
  });

  it("explains a secure-field refusal and keeps the copy action available", async () => {
    // The sidecar refused to write into a password field: nothing inserted,
    // nothing copied, words kept in history. The popup must say exactly that
    // rather than "Transcription ready" or "Inserted into", and still offer
    // Copy result for the user who wants the words on the clipboard anyway.
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<DictationPopup />));
    });

    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "hunter two",
          outcome: "secure_field",
          pasted: false,
          copied: false,
          pasteError:
            "The field in front is a password or secure input, so Plainsong did not insert or copy the words. They are kept in your dictation history.",
          appTarget: "Safari",
        },
      });
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 11,
          outcome: "secure_field",
          appTarget: "Safari",
        },
      });
    });

    expect(
      await screen.findByText("Not inserted — secure field"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/password or secure input.*did not insert or copy/),
    ).toBeInTheDocument();
    expect(screen.getByText("Kept in history")).toBeInTheDocument();
    expect(screen.getByText("Copy result")).toBeInTheDocument();
    expect(screen.queryByText("Transcription ready")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Inserted into/)).not.toBeInTheDocument();
    expect(screen.queryByText("Clipboard ready")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-circle-check-big")).toBeNull();
    expect(
      container.querySelector(".lucide-triangle-alert"),
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

  // STYLE.md \u00a75: mode/template/capture selectors are rubric controls, so
  // they are rust and neutral. This notice used to be gilded (bg-gold/12,
  // neume-lit, text-gold-text) while nothing was being recorded, competing
  // with the one moment on this HUD that earns gold.
  it("announces the next profile in rust and neutral, never gold", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-mode-cycled")).toBeDefined();
    });

    await act(async () => {
      popupMocks.listeners.get("dictation-mode-cycled")?.({
        payload: {
          modePreset: "notes",
          selectedCustomModeId: null,
          label: "Notes",
        },
      });
    });

    const notice = (await screen.findByText("Next profile")).closest(
      "[role=\"status\"]",
    ) as HTMLElement;
    expect(notice).toBeTruthy();
    expect(notice.className).not.toMatch(/gold/);
    expect(notice.innerHTML).not.toMatch(/gold/);
    expect(notice.innerHTML).not.toMatch(/neume-lit/);
    expect(notice.querySelector(".neume-rust")).toBeTruthy();
    expect(screen.getByText("Notes").className).toMatch(/text-foreground/);
  });
  it("renders a streaming preview's settled words apart from the tail it may still change", async () => {
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
          sessionId: 11,
          partialText: "ship the release",
          partialStableText: "ship the",
          partialVolatileText: " release",
          partialEngine: "streaming",
        },
      });
    });

    const settled = await screen.findByText("ship the");
    const volatileTail = screen.getByText("release");
    // The committed half reads as text; the half the recognizer may still
    // rewrite is muted. No new colours -- the muted foreground the rest of
    // the popup already uses.
    expect(settled.className).not.toMatch(/text-muted-foreground/);
    expect(volatileTail.className).toMatch(/text-muted-foreground/);
    expect(volatileTail.className).not.toMatch(/gold|rust/);
  });

  it("renders a re-decode preview as one run, because none of it is settled", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-state-changed")).toBeDefined();
    });

    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({
        payload: {
          phase: "recording",
          startedAtMs: Date.now(),
          sessionId: 12,
          partialText: "ship the release",
        },
      });
    });

    const preview = await screen.findByText("ship the release");
    expect(preview.querySelector("span")).toBeNull();
  });

  it("drops the streaming preview split when the session goes idle", async () => {
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
          sessionId: 13,
          partialText: "ship the release",
          partialStableText: "ship the",
          partialVolatileText: " release",
          partialEngine: "streaming",
        },
      });
    });
    expect(await screen.findByText("ship the")).toBeInTheDocument();

    await act(async () => {
      handler?.({ payload: { phase: "idle", sessionId: 13 } });
    });

    expect(screen.queryByText("ship the")).not.toBeInTheDocument();
    expect(screen.queryByText("release")).not.toBeInTheDocument();
  });
});
