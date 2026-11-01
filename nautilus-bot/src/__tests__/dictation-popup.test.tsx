import { createDictationShortcutSignalRuntime } from "../../electron/dictation-shortcut-controller";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
    copyOverlayText: vi.fn(async (_text: string) => {}),
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      // These tests exercise the full card; the pill default has its own test.
      if (command === "__overlay_placement__") {
        return { displayMode: "full" };
      }
      if (command === "__overlay_copy_text__") return popupMocks.copyOverlayText((args as { text: string }).text);
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
      if (command === "hold_dictation_overlay_review") {
        return { held: true, sessionId: args?.sessionId };
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
    playDictationEarcon: vi.fn(async (_sound: "start" | "success" | "error") => true),
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

function mockInitialOverlaySnapshot(snapshot: unknown) {
  const original = popupMocks.invoke.getMockImplementation();
  popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    command === "get_dictation_overlay_state"
      ? snapshot
      : original?.(command, args) ?? null,
  );
  onTestFinished(() => {
    if (original) popupMocks.invoke.mockImplementation(original);
  });
}

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

vi.mock("@/lib/dictation-earcons", () => ({
  playDictationEarcon: popupMocks.playDictationEarcon,
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
    popupMocks.copyOverlayText.mockReset().mockResolvedValue(undefined);
    popupMocks.getSettings.mockClear();
    popupMocks.getDictationAudioLevel.mockClear();
    popupMocks.startDictation.mockClear();
    popupMocks.stopDictation.mockClear();
    popupMocks.playDictationEarcon.mockClear();
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

  it.each(["error", "secure_field", "empty", "paste_dispatched", "previewed", "copied", "copied_replacement", "undone", null])(
    "does not play a success sound for done outcome %s",
    async (outcome) => {
      await act(async () => { render(<DictationPopup />); });
      await act(async () => {
        popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
          phase: "done", sessionId: 9, outcome,
        } });
      });
      expect(popupMocks.playDictationEarcon).not.toHaveBeenCalledWith("success");
    },
  );

  it.each(["pasted", "replaced"])("plays one success sound for confirmed %s", async (outcome) => {
    await act(async () => { render(<DictationPopup />); });
    const handler = popupMocks.listeners.get("dictation-state-changed");
    await act(async () => { handler?.({ payload: { phase: "done", sessionId: 9, outcome } }); });
    await act(async () => { handler?.({ payload: { phase: "done", sessionId: 9, outcome } }); });
    expect(popupMocks.playDictationEarcon.mock.calls.filter(([sound]) => sound === "success")).toHaveLength(1);
  });

  it("announces insertion and admits a slow delivery without completing the bar", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    popupMocks.invoke.mockImplementation(async (command: string) =>
      command === "get_dictation_overlay_state"
        ? { phase: "recording", startedAtMs: Date.now(), sessionId: 9 }
        : null,
    );
    await act(async () => { render(<DictationPopup />); });
    vi.useFakeTimers();
    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "delivering", sessionId: 9, processingStage: "polishing",
      } });
    });
    const bar = screen.getByTestId("dictation-finish-bar");
    expect(bar).toHaveAttribute("data-stage", "delivering");
    expect(bar).toHaveAttribute("aria-valuetext", "Inserting");
    expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Inserting");
    await act(async () => { await vi.advanceTimersByTimeAsync(4001); });
    expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Still working");
    expect((bar.firstElementChild as HTMLElement).style.transform).toBe("scaleX(0.94)");
  });

  it.each(["minimal", "compact", "full"])("releases the %s HUD canvas at idle and restores it for recording", async (displayMode) => {
    const original = popupMocks.invoke.getMockImplementation();
    popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "__overlay_placement__" ? { displayMode } : original?.(command, args),
    );
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    await act(async () => { render(<DictationPopup />); });
    expect(document.querySelector("canvas")).not.toBeNull();

    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: { phase: "idle", sessionId: 9 } });
    });
    expect(document.querySelector("[data-hud-card]")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();

    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "recording", sessionId: 10, startedAtMs: Date.now(), captureReady: true,
      } });
    });
    expect(document.querySelector("[data-hud-card]")).not.toBeNull();
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("keeps a dismissed overlay hidden when the backend snapshot is stale", async () => {
    mockInitialOverlaySnapshot({
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

  it("describes preview and clipboard delivery without claiming insertion into the context app", async () => {
    await act(async () => { render(<DictationPopup />); });
    for (const [insertionMode, label] of [["preview", "Preview in Plainsong"], ["clipboard_only", "Copy to clipboard"]]) {
      await act(async () => {
        popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
          phase: "recording", sessionId: 10, startedAtMs: Date.now(),
          insertionMode, appTarget: "TextEdit",
        } });
      });
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.queryByText("Sending to TextEdit")).not.toBeInTheDocument();
    }
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

    mockInitialOverlaySnapshot({
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
    mockInitialOverlaySnapshot({
      phase: "recording",
      startedAtMs: Date.now(),
      sessionId: 41,
    });
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
    expect(screen.getByText("Heard so far")).toBeInTheDocument();
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

    mockInitialOverlaySnapshot({
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
    mockInitialOverlaySnapshot({
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

    expect(await screen.findByText("Starting mic")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it.each(["preparing", "primed", "recording"])("discards %s without stopping or delivering", async (phase) => {
    mockInitialOverlaySnapshot({ phase, sessionId: 9, startedAtMs: Date.now() } as any);
    render(<DictationPopup />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel (discard)" }));
    expect(popupMocks.invoke).toHaveBeenCalledWith("force_stop_dictation", { sessionId: 9 });
    expect(popupMocks.stopDictation).not.toHaveBeenCalled();
  });

  it.each([50, 350])("shows the lock hint only after a short chord release, %i ms", async (duration) => {
    mockInitialOverlaySnapshot({ phase: "recording", sessionId: 9, startedAtMs: Date.now() } as any);
    render(<DictationPopup />);
    expect(await screen.findByText(/to stop · Esc to cancel/)).toBeInTheDocument();
    let phase: "idle" | "recording" = "idle";
    const runtime = createDictationShortcutSignalRuntime({
      getPhase: () => phase, getSessionId: () => 9, invoke: vi.fn().mockResolvedValue(undefined),
      onLockChanged: (shortcutLocked) => popupMocks.listeners.get("dictation-state-changed")?.({
        payload: { phase, sessionId: 9, shortcutLocked },
      }),
    });
    const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "chord", holdTapLocks: true } as const;
    await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1000 });
    phase = "recording"; runtime.onPhase(phase);
    await act(async () => {
      await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1000 + duration });
    });
    if (duration < 300) {
      expect(await screen.findByText("Locked. Press the shortcut again to finish.")).toBeInTheDocument();
    } else {
      expect(screen.getByText(/to stop · Esc to cancel/)).toBeInTheDocument();
      expect(screen.queryByText("Locked. Press the shortcut again to finish.")).toBeNull();
    }
    await act(async () => runtime.dispose());
  });

  it("shows cold-model preparation truthfully and lets the user cancel it", async () => {
    mockInitialOverlaySnapshot({
      phase: "preparing",
      startedAtMs: Date.now(),
      sessionId: 31,
      message: "Loading the selected dictation model",
      modelReadiness: "loading",
    } as any);

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(await screen.findByText("Starting")).toBeInTheDocument();
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
    mockInitialOverlaySnapshot({
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

    expect(await screen.findByText("Starting mic")).toBeInTheDocument();

    const handler = popupMocks.listeners.get("dictation-state-changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler?.({ payload: { phase: "recording", sessionId: 40 } });
    });
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    expect(screen.queryByText("Starting mic")).toBeNull();

    await act(async () => {
      handler?.({ payload: { phase: "transcribing", sessionId: 40 } });
    });
    expect(await screen.findAllByText("Transcribing")).not.toHaveLength(0);
    expect(screen.queryByText("Listening")).toBeNull();
  });

  it("opens as the compact pill when no display mode has been chosen", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return { phase: "recording", startedAtMs: Date.now(), sessionId: 12 };
      }
      return null;
    });
    await act(async () => {
      render(<DictationPopup />);
    });
    const status = await screen.findByTestId("dictation-hud-status");
    expect(status).toHaveTextContent("Listening");
    expect(status).toHaveAttribute("role", "status");
  });

  it("sizes and docks the pill from settings, and follows a later change", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return { phase: "recording", startedAtMs: Date.now(), sessionId: 13 };
      }
      return null;
    });
    popupMocks.getSettings.mockResolvedValueOnce({
      transcription: {},
      ui: { dictationPillSize: "xlarge", dictationPillDock: "left" },
    } as never);
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() =>
      expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 125, height: 255 }),
      ),
    );
    const card = document.querySelector("[data-hud-card]") as HTMLElement;
    expect(card).toHaveAttribute("data-dock", "left");
    expect(card.style.zoom).toBe("1.3");

    await act(async () => {
      popupMocks.listeners.get("settings-changed")?.({
        payload: { ui: { dictationPillSize: "small", dictationPillDock: "bottom" } },
      });
    });
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 241, height: 54 }),
    );
    expect(document.querySelector("[data-hud-card]")).toHaveAttribute(
      "data-dock",
      "bottom",
    );
  });

  it("never shows the pill's success bar for a refused delivery", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return { phase: "recording", startedAtMs: Date.now(), sessionId: 13 };
      }
      return null;
    });
    await act(async () => {
      render(<DictationPopup />);
    });
    const handler = popupMocks.listeners.get("dictation-state-changed");
    await act(async () => {
      handler?.({ payload: { phase: "done", sessionId: 13, outcome: "secure_field" } });
    });
    expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Secure field");
    expect(screen.queryByTestId("dictation-finish-bar")).toBeNull();
  });

  it("moves the finishing bar from Transcribing to Polishing and fills it only on done", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });
    const handler = popupMocks.listeners.get("dictation-state-changed");

    await act(async () => {
      handler?.({
        payload: {
          phase: "transcribing",
          sessionId: 9,
          processingStage: "transcribing",
          expectedTranscribeMs: 400,
          expectedPolishMs: 700,
        },
      });
    });
    const transcribingBar = await screen.findByTestId("dictation-finish-bar");
    expect(transcribingBar).toHaveAttribute("data-stage", "transcribing");
    expect(transcribingBar).toHaveAttribute("aria-valuetext", "Transcribing");

    await act(async () => {
      handler?.({
        payload: {
          phase: "transcribing",
          sessionId: 9,
          message: "Polishing…",
          processingStage: "polishing",
          expectedPolishMs: 700,
        },
      });
    });
    expect(await screen.findAllByText("Polishing")).not.toHaveLength(0);
    const polishingBar = screen.getByTestId("dictation-finish-bar");
    expect(polishingBar).toHaveAttribute("data-stage", "polishing");
    const fill = polishingBar.firstElementChild as HTMLElement;
    expect(fill.style.transform).not.toBe("scaleX(1)");
  });

  it("says Preparing model while the first dictation prepares the speech model", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    onTestFinished(() => {
      if (original) popupMocks.invoke.mockImplementation(original);
    });
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_dictation_overlay_state") {
        return { phase: "recording", startedAtMs: Date.now(), sessionId: 21 };
      }
      return null;
    });
    await act(async () => {
      render(<DictationPopup />);
    });
    const handler = popupMocks.listeners.get("dictation-state-changed");
    await act(async () => {
      handler?.({
        payload: {
          phase: "transcribing",
          sessionId: 21,
          message: "Preparing the speech model for this Mac. This happens once.",
          processingStage: "transcribing",
          speechModelPreparing: true,
          expectedTranscribeMs: 10_400,
        },
      });
    });
    expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Preparing model");

    // The next session's ordinary transcription does not inherit it.
    await act(async () => {
      handler?.({ payload: { phase: "recording", sessionId: 22, startedAtMs: Date.now() } });
    });
    await act(async () => {
      handler?.({
        payload: { phase: "transcribing", sessionId: 22, processingStage: "transcribing", expectedTranscribeMs: 400 },
      });
    });
    expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Transcribing");
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

    fireEvent.click(await screen.findByRole("button", { name: "Show compact controls" }));

    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "__overlay_set_display_mode__",
        { displayMode: "compact" },
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Show pill" }));
    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "__overlay_set_display_mode__", { displayMode: "minimal" },
      );
    });
    const pill = screen.getByTestId("dictation-hud-status").closest("[data-hud-card]")!;
    // Electron ignores pointer events in a native draggable region. The
    // status must receive its double-click while the indicator still drags.
    expect(pill).not.toHaveAttribute("data-drag-region");
    expect(pill.querySelector('[data-drag-region][title="Drag to move"]')).toBeInTheDocument();
    fireEvent.doubleClick(pill);
    await waitFor(() => {
      expect(popupMocks.invoke).toHaveBeenCalledWith(
        "__overlay_set_display_mode__", { displayMode: "full" },
      );
    });
    expect(await screen.findByRole("button", { name: "Show compact controls" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Show compact controls" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show pill" }));

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

  it("says nothing was heard instead of Transcription ready with a check", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<DictationPopup />));
    });
    const stateHandler = popupMocks.listeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({
        payload: {
          phase: "done",
          sessionId: 9,
          outcome: "empty",
          message: "No speech detected.",
        },
      });
    });

    expect(await screen.findByText("Nothing heard")).toBeInTheDocument();
    expect(screen.queryByText("Transcription ready")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-circle-check-big")).toBeNull();
    expect(container.querySelector(".lucide-mic-off")).toBeInTheDocument();
  });

  it("renders an unconfirmed paste as sent in the minimal pill", async () => {
    const originalInvoke = popupMocks.invoke.getMockImplementation()!;
    popupMocks.invoke.mockImplementation(async (command: string) =>
      command === "__overlay_placement__" ? { displayMode: "minimal" } : originalInvoke(command),
    );
    onTestFinished(() => { popupMocks.invoke.mockImplementation(originalInvoke); });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<DictationPopup />));
    });
    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "done", sessionId: 9, outcome: "paste_dispatched",
        message: "Paste sent without insertion confirmation.", appTarget: "TextEdit",
      } });
    });
    expect(await screen.findByRole("status", { name: /Check text.*Paste sent without insertion confirmation/ })).toBeInTheDocument();
    expect(screen.queryByText("Inserted")).not.toBeInTheDocument();
    expect(container.querySelector(".neume-hollow")).toBeInTheDocument();
  });

  it.each([
    "backtrack_replace_last_insert",
    "backtrack_replace_phrase",
    "undo_last_insert",
    "rewrite_shorter",
  ])("reports unconfirmed delivery before command success: %s", async (commandApplied) => {
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<DictationPopup />)); });
    await act(async () => {
      popupMocks.listeners.get("dictation-text-ready")?.({ payload: {
        text: "Ship the update tomorrow.", pasted: true, copied: false,
        undoPerformed: true, commandApplied, snippetAppliedCount: 2, appTarget: "Slack",
      } });
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "done", sessionId: 9, outcome: "paste_dispatched", appTarget: "Slack",
      } });
    });
    expect(await screen.findByText("Check Slack")).toBeInTheDocument();
    expect(screen.getByText("Check the text in Slack. Insertion was not confirmed. If nothing appeared, use Copy result to recover it.")).toBeInTheDocument();
    expect(screen.queryByText(/applied$|finished successfully\./i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cmd\+V/)).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-circle-check")).toBeNull();
    expect(container.querySelector(".lucide-clock-3")).toBeInTheDocument();
    expect(popupMocks.playDictationEarcon).not.toHaveBeenCalledWith("success");
  });

  it("offers clipboard recovery for an unconfirmed paste only when copied", async () => {
    await act(async () => { render(<DictationPopup />); });
    await act(async () => {
      popupMocks.listeners.get("dictation-text-ready")?.({ payload: {
        text: "Ship the update tomorrow.", pasted: true, copied: true,
        commandApplied: "backtrack_replace_last_insert", appTarget: "Slack",
      } });
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "done", sessionId: 9, outcome: "paste_dispatched", appTarget: "Slack",
      } });
    });
    expect(await screen.findByText("Check Slack")).toBeInTheDocument();
    expect(screen.getByText("Check the text in Slack. Insertion was not confirmed. If nothing appeared, paste the copied result with Cmd+V.")).toBeInTheDocument();
    expect(popupMocks.playDictationEarcon).not.toHaveBeenCalledWith("success");
  });

  it("reports a confirmed backtrack replacement with one success sound", async () => {
    await act(async () => { render(<DictationPopup />); });
    await act(async () => {
      popupMocks.listeners.get("dictation-text-ready")?.({ payload: {
        text: "Ship the update tomorrow.", pasted: true, copied: false,
        undoPerformed: true, commandApplied: "backtrack_replace_last_insert", appTarget: "Slack",
      } });
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase: "done", sessionId: 9, outcome: "replaced", appTarget: "Slack",
      } });
    });
    expect(await screen.findByText("Backtrack applied")).toBeInTheDocument();
    expect(screen.getByText("Replaced the last insert for Slack.")).toBeInTheDocument();
    expect(popupMocks.playDictationEarcon.mock.calls.filter(([sound]) => sound === "success")).toHaveLength(1);
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
      (await screen.findAllByText("Not inserted"))[0],
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
      (await screen.findAllByText("Not inserted"))[0],
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
          sessionId: 9,
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
          sessionId: 9,
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
    expect(screen.getByText("Edit commands available")).toHaveAttribute(
      "title",
      expect.stringContaining("scratch that"),
    );
    expect(screen.getByText("Copy result")).toBeInTheDocument();
    expect(screen.getByText("New dictation")).toBeInTheDocument();
    expect(screen.getByText("Open history")).toBeInTheDocument();
    expect(screen.getByText("Open app")).toBeInTheDocument();
    expect(screen.getByText("Read aloud")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Copy result/i }));

    await waitFor(() => {
      expect(popupMocks.copyOverlayText).toHaveBeenCalledWith(
        "Ship the launch update tomorrow morning.",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /^New dictation/i }));

    await waitFor(() => {
      expect(popupMocks.startDictation).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Read aloud/i }));

    await waitFor(() => {
      expect(popupMocks.speechSynthesis.cancel).toHaveBeenCalled();
      expect(popupMocks.speechSynthesis.speak).toHaveBeenCalled();
    });
  });

  describe("copy result ownership", () => {
    async function showResult(text: string, sessionId = 9) {
      await act(async () => {
        popupMocks.listeners.get("dictation-text-ready")?.({
          payload: { text, pasted: false, copied: false },
        });
        popupMocks.listeners.get("dictation-state-changed")?.({
          payload: { phase: "done", sessionId, outcome: "previewed" },
        });
      });
    }

    it("copies the exact captured bytes and ignores duplicate clicks until settlement", async () => {
      const write = deferred<void>();
      popupMocks.copyOverlayText.mockReturnValueOnce(write.promise);
      await act(async () => { render(<DictationPopup />); });
      await showResult("  Keep this line.\nAnd this one.  ");

      const copyButton = screen.getByRole("button", { name: "Copy result" });
      fireEvent.click(copyButton);
      fireEvent.click(copyButton);

      expect(popupMocks.copyOverlayText).toHaveBeenCalledTimes(1);
      expect(popupMocks.copyOverlayText).toHaveBeenCalledWith(
        "  Keep this line.\nAnd this one.  ",
      );
      expect(popupMocks.invoke).toHaveBeenCalledWith("__overlay_copy_text__", { text: "  Keep this line.\nAnd this one.  " });
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(copyButton).toBeDisabled();

      await act(async () => { write.resolve(); await write.promise; });
      expect(copyButton).toBeEnabled();
      expect(screen.getByText("Copied result")).toBeInTheDocument();

      const secondWrite = deferred<void>();
      popupMocks.copyOverlayText.mockReturnValueOnce(secondWrite.promise);
      fireEvent.click(copyButton);
      expect(screen.queryByText("Copied result")).not.toBeInTheDocument();
      expect(copyButton).toBeDisabled();
      await act(async () => { secondWrite.resolve(); await secondWrite.promise; });
      expect(screen.getByText("Copied result")).toBeInTheDocument();
    });

    it("suppresses a late failure from a prior capture", async () => {
      const write = deferred<void>();
      popupMocks.copyOverlayText.mockReturnValueOnce(write.promise);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => consoleError.mockRestore());
      await act(async () => { render(<DictationPopup />); });
      await showResult("First capture");
      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

      await act(async () => {
        popupMocks.listeners.get("dictation-state-changed")?.({
          payload: { phase: "recording", sessionId: 10, startedAtMs: Date.now() },
        });
      });
      await act(async () => {
        write.reject(new Error("clipboard unavailable"));
        await write.promise.catch(() => undefined);
      });

      expect(screen.queryByText("Copied result")).not.toBeInTheDocument();
      expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
    });

    it("suppresses stale completion when the result changes and reverts", async () => {
      const write = deferred<void>();
      popupMocks.copyOverlayText.mockReturnValueOnce(write.promise);
      await act(async () => { render(<DictationPopup />); });
      await showResult("Original result");
      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

      await showResult("Edited result");
      await showResult("Original result");
      await act(async () => { write.resolve(); await write.promise; });

      expect(screen.queryByText("Copied result")).not.toBeInTheDocument();
      expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
      expect(screen.getByText("Original result")).toBeInTheDocument();
    });

    it("keeps a failed current result available for retry", async () => {
      const firstWrite = deferred<void>();
      popupMocks.copyOverlayText
        .mockReturnValueOnce(firstWrite.promise)
        .mockResolvedValueOnce();
      await act(async () => { render(<DictationPopup />); });
      await showResult("Retry this result");
      const copyButton = screen.getByRole("button", { name: "Copy result" });

      fireEvent.click(copyButton);
      await act(async () => {
        firstWrite.reject(new Error("clipboard unavailable"));
        await firstWrite.promise.catch(() => undefined);
      });
      expect(screen.getByText("Copy failed")).toBeInTheDocument();
      expect(copyButton).toBeEnabled();

      fireEvent.click(copyButton);
      await waitFor(() => expect(screen.getByText("Copied result")).toBeInTheDocument());
      expect(popupMocks.copyOverlayText).toHaveBeenNthCalledWith(2, "Retry this result");
    });
  });

  describe("latest result review", () => {
    it("shows the complete exact result in a bounded selectable scroll region", async () => {
      const text = [
        "First line keeps its spacing.",
        "",
        "  Indented line stays indented.",
        "averylongtokenwithoutbreaksthatmustwrapinsideofthereviewregion",
        "Final line remains available.",
      ].join("\n");
      await act(async () => { render(<DictationPopup />); });

      await act(async () => {
        popupMocks.listeners.get("dictation-text-ready")?.({
          payload: { text, pasted: false, copied: false },
        });
        popupMocks.listeners.get("dictation-state-changed")?.({
          payload: { phase: "done", sessionId: 9, outcome: "previewed" },
        });
      });

      const result = screen.getByRole("region", { name: "Latest result" });
      expect(result.textContent).toBe(text);
      expect(result).toHaveClass(
        "max-h-24",
        "overflow-y-auto",
        "whitespace-pre-wrap",
        "break-words",
        "select-text",
      );
      expect(result).not.toHaveClass("line-clamp-4");
      expect(result).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("button", { name: "Copy result" })).toBeInTheDocument();
      expect(document.querySelector("[data-hud-card]")).toHaveClass(
        "max-h-[calc(100vh-1.5rem)]",
        "overflow-y-auto",
      );
    });
  });

  it.each(["done", "error"])("reports a rejected restart from %s", async (phase) => {
    render(<DictationPopup />);
    await waitFor(() => expect(popupMocks.listeners.has("dictation-state-changed")).toBe(true));
    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: {
        phase, sessionId: 9, message: phase === "error" ? "Previous capture failed." : undefined,
      } });
    });
    popupMocks.startDictation.mockRejectedValueOnce(new Error("QA startup rejected"));
    fireEvent.click(screen.getByRole("button", { name: "New dictation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't start dictation");
    expect(screen.getByRole("button", { name: "New dictation" })).toBeEnabled();
  });

  it("allows only one pending restart and clears failure on retry", async () => {
    render(<DictationPopup />);
    await waitFor(() => expect(popupMocks.listeners.has("dictation-state-changed")).toBe(true));
    await act(async () => {
      popupMocks.listeners.get("dictation-state-changed")?.({ payload: { phase: "error", sessionId: 9 } });
    });
    popupMocks.startDictation.mockRejectedValueOnce(new Error("QA startup rejected"));
    fireEvent.click(screen.getByRole("button", { name: "New dictation" }));
    await screen.findByRole("alert");
    let resolve!: () => void;
    popupMocks.startDictation.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const callsBefore = popupMocks.startDictation.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "New dictation" }));
    const pending = screen.getByRole("button", { name: "Starting…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(popupMocks.startDictation).toHaveBeenCalledTimes(callsBefore + 1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: "New dictation" })).toBeEnabled();
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
          sessionId: 9,
          message: "Microphone permission is not ready.",
          appTarget: "Codex",
        },
      });
    });

    expect(
      await screen.findByText("Microphone permission is not ready."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New dictation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open history" }),
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

  it("never reads a live partial aloud, only the finished result", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-state-changed")).toBeDefined();
    });

    const handler = popupMocks.listeners.get("dictation-state-changed");

    // A live preview is on screen and the session then *fails*, so there is
    // no finished result. The read-aloud button is not offered here, but the
    // handler must refuse on its own too: a partial is half-heard text, and
    // speaking it back would present a guess as the transcription.
    await act(async () => {
      handler?.({
        payload: {
          phase: "recording",
          startedAtMs: Date.now(),
          sessionId: 21,
          partialText: "ship the release",
          partialStableText: "ship the",
          partialVolatileText: " release",
          partialEngine: "streaming",
        },
      });
    });
    expect(await screen.findByText("ship the")).toBeInTheDocument();

    await act(async () => {
      handler?.({
        payload: {
          phase: "error",
          sessionId: 21,
          message: "The dictation engine stopped.",
        },
      });
    });

    expect(
      screen.queryByRole("button", { name: /^Read aloud/i }),
    ).not.toBeInTheDocument();
    expect(popupMocks.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("reads back the finished text even when a preview is still on screen", async () => {
    await act(async () => {
      render(<DictationPopup />);
    });

    await waitFor(() => {
      expect(popupMocks.listeners.get("dictation-state-changed")).toBeDefined();
    });

    const handler = popupMocks.listeners.get("dictation-state-changed");
    const textReadyHandler = popupMocks.listeners.get("dictation-text-ready");

    // The preview and the result deliberately disagree: the preview is the
    // recognizer's half-heard guess, the result is the batch decode. Read
    // aloud must speak the second one, whatever the first still says.
    await act(async () => {
      handler?.({
        payload: {
          phase: "recording",
          startedAtMs: Date.now(),
          sessionId: 22,
          partialText: "ship the realease",
          partialStableText: "ship the",
          partialVolatileText: " realease",
          partialEngine: "streaming",
        },
      });
    });

    await act(async () => {
      textReadyHandler?.({
        payload: {
          text: "Ship the release.",
          pasted: true,
          appTarget: "Slack",
        },
      });
      handler?.({
        payload: { phase: "done", sessionId: 22, outcome: "pasted" },
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /^Read aloud/i }),
    );

    await waitFor(() => {
      expect(popupMocks.speechSynthesis.speak).toHaveBeenCalled();
    });
    const spoken = popupMocks.speechSynthesis.speak.mock.calls.map(
      (call: unknown[]) => (call[0] as { text: string }).text,
    );
    expect(spoken).toEqual(["Ship the release."]);
    expect(spoken.join(" ")).not.toContain("realease");
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

  it("cancels minimal processing with the displayed session and stays single-flight until acknowledgement", async () => {
    const cancellation = deferred<unknown>();
    const originalInvoke = popupMocks.invoke.getMockImplementation()!;
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "__overlay_placement__") {
        return { displayMode: "minimal" };
      }
      if (command === "get_dictation_overlay_state") {
        return {
          phase: "transcribing",
          sessionId: 73,
          processingStage: "polishing",
          preview: "Keep this draft visible.",
        };
      }
      if (command === "force_stop_dictation") {
        return cancellation.promise;
      }
      return originalInvoke(command);
    });
    onTestFinished(() => {
      popupMocks.invoke.mockImplementation(originalInvoke);
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    const cancel = await screen.findByRole("button", { name: "Cancel dictation" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);

    expect(popupMocks.invoke.mock.calls.filter(([command]) => command === "force_stop_dictation"))
      .toEqual([["force_stop_dictation", { sessionId: 73 }]]);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Polishing");

    await act(async () => {
      cancellation.resolve(null);
      await cancellation.promise;
    });

    expect(await screen.findByRole("button", { name: "Cancel dictation" })).toBeEnabled();
    expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Polishing");
  });

  it.each(["full", "compact"])(
    "offers cancellation and its Escape hint in %s processing controls",
    async (displayMode) => {
      const originalInvoke = popupMocks.invoke.getMockImplementation()!;
      popupMocks.invoke.mockImplementation(async (command: string) => {
        if (command === "__overlay_placement__") {
          return { displayMode };
        }
        if (command === "get_dictation_overlay_state") {
          return {
            phase: "stopping",
            sessionId: 74,
            preview: "Keep this draft visible.",
          };
        }
        return originalInvoke(command);
      });
      onTestFinished(() => {
        popupMocks.invoke.mockImplementation(originalInvoke);
      });

      await act(async () => {
        render(<DictationPopup />);
      });

      fireEvent.click(await screen.findByRole("button", { name: "Cancel dictation" }));
      expect(screen.getByText("Esc to cancel")).toBeInTheDocument();
      await waitFor(() => {
        expect(popupMocks.invoke).toHaveBeenCalledWith("force_stop_dictation", {
          sessionId: 74,
        });
      });
    },
  );

  it("keeps delivery dismissible without offering cancellation", async () => {
    const originalInvoke = popupMocks.invoke.getMockImplementation()!;
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "__overlay_placement__") {
        return { displayMode: "minimal" };
      }
      if (command === "get_dictation_overlay_state") {
        return {
          phase: "delivering",
          sessionId: 75,
          preview: "Ready to insert.",
        };
      }
      return originalInvoke(command);
    });
    onTestFinished(() => {
      popupMocks.invoke.mockImplementation(originalInvoke);
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    expect(await screen.findByRole("button", { name: "Hide popup" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Cancel dictation|Cancelling/ })).toBeNull();
    expect(screen.queryByText("Esc to cancel")).toBeNull();
  });

  it("preserves the processing result and allows retry after a rejected cancellation", async () => {
    const originalInvoke = popupMocks.invoke.getMockImplementation()!;
    let cancellationAttempts = 0;
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "__overlay_placement__") {
        return { displayMode: "full" };
      }
      if (command === "get_dictation_overlay_state") {
        return {
          phase: "transcribing",
          sessionId: 76,
          processingStage: "polishing",
          preview: "Draft that must not be lost.",
        };
      }
      if (command === "force_stop_dictation") {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) {
          throw new Error("sidecar channel closed: raw transport detail");
        }
        return null;
      }
      return originalInvoke(command);
    });
    onTestFinished(() => {
      popupMocks.invoke.mockImplementation(originalInvoke);
    });

    await act(async () => {
      render(<DictationPopup />);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel dictation" }));
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Couldn't cancel this dictation. Try again.");
    expect(screen.queryByText(/raw transport detail/i)).toBeNull();
    expect(screen.getByText("Draft that must not be lost.")).toBeInTheDocument();
    expect(screen.getByText("Polishing")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await waitFor(() => expect(cancellationAttempts).toBe(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Draft that must not be lost.")).toBeInTheDocument();
  });

  describe("minimal details recovery", () => {
    let originalInvoke: ReturnType<typeof popupMocks.invoke.getMockImplementation>;

    beforeEach(() => {
      originalInvoke = popupMocks.invoke.getMockImplementation();
      popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
        command === "__overlay_placement__"
          ? { displayMode: "minimal" }
          : originalInvoke?.(command, args),
      );
    });

    afterEach(() => {
      if (originalInvoke) popupMocks.invoke.mockImplementation(originalInvoke);
    });

    const sendState = async (payload: Record<string, unknown>) => {
      await waitFor(() =>
        expect(popupMocks.listeners.get("dictation-state-changed")).toBeDefined(),
      );
      await act(async () => {
        popupMocks.listeners.get("dictation-state-changed")?.({ payload });
      });
    };

    const sendText = async (payload: Record<string, unknown>) => {
      await waitFor(() =>
        expect(popupMocks.listeners.get("dictation-text-ready")).toBeDefined(),
      );
      await act(async () => {
        popupMocks.listeners.get("dictation-text-ready")?.({ payload });
      });
    };

    describe("exact saved result review", () => {
      it("opens the warned live result by its saved ID without processing it", async () => {
        await act(async () => { render(<DictationPopup />); });
        await sendText({ sessionId: 9, recordingId: "saved-9", text: "Fallback words.", warnings: ["Formatting timed out."] });
        await sendState({ phase: "done", sessionId: 9, outcome: "pasted" });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        fireEvent.click(await screen.findByRole("button", { name: "Review this result" }));
        await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("open_main_window_to", { view: "dictation", recordingId: "saved-9" }));
        expect(popupMocks.startDictation).not.toHaveBeenCalled();
      });

      it.each([null, undefined])("keeps ordinary history when the live result has no saved ID: %s", async (recordingId) => {
        await act(async () => { render(<DictationPopup />); });
        await sendText({ sessionId: 9, recordingId, text: "Fallback words.", warnings: ["Formatting timed out."] });
        await sendState({ phase: "done", sessionId: 9, outcome: "pasted" });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        expect(screen.queryByRole("button", { name: "Review this result" })).not.toBeInTheDocument();
        fireEvent.click(await screen.findByRole("button", { name: "Open history" }));
        await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("open_main_window_to", { view: "dictation" }));
      });

      it("refuses an old review button after a newer session starts", async () => {
        await act(async () => { render(<DictationPopup />); });
        await sendText({ sessionId: 9, recordingId: "saved-9", text: "Fallback words.", warnings: ["Formatting timed out."] });
        await sendState({ phase: "done", sessionId: 9, outcome: "pasted" });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        const oldButton = await screen.findByRole("button", { name: "Review this result" });
        await sendState({ phase: "preparing", sessionId: 10, startedAtMs: Date.now() + 1000 });
        fireEvent.click(oldButton);
        expect(popupMocks.invoke.mock.calls.some(([command]) => command === "open_main_window_to")).toBe(false);
        await sendText({ sessionId: 9, recordingId: "saved-9", text: "Stale words.", warnings: ["Stale warning."] });
        await sendState({ phase: "done", sessionId: 10, outcome: "pasted", warnings: ["Current warning."] });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        expect(screen.queryByRole("button", { name: "Review this result" })).not.toBeInTheDocument();
      });

      it("does not infer a saved ID from a hydrated done snapshot", async () => {
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
          if (command === "__overlay_placement__") return { displayMode: "minimal" };
          if (command === "get_dictation_overlay_state") return { phase: "done", sessionId: 9, outcome: "pasted", preview: "Hydrated words.", warnings: ["Formatting timed out."] };
          return originalInvoke?.(command, args);
        });
        await act(async () => { render(<DictationPopup />); });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        expect(screen.queryByRole("button", { name: "Review this result" })).not.toBeInTheDocument();
        expect(await screen.findByRole("button", { name: "Open history" })).toBeInTheDocument();
      });
    });

    describe("review hold ownership", () => {
      it("sends one hold request for duplicate Details clicks", async () => {
        const hold = deferred<{ held: boolean; sessionId: number }>();
        const invoke = popupMocks.invoke.getMockImplementation();
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
          command === "hold_dictation_overlay_review"
            ? hold.promise
            : invoke?.(command, args),
        );
        await act(async () => { render(<DictationPopup />); });
        await sendState({ phase: "error", sessionId: 9, message: "Review this failure." });

        const details = await screen.findByRole("button", { name: "Details" });
        fireEvent.click(details);
        fireEvent.click(details);
        expect(popupMocks.invoke.mock.calls.filter(([command]) =>
          command === "hold_dictation_overlay_review"
        )).toHaveLength(1);
        expect(details).toBeDisabled();

        await act(async () => {
          hold.resolve({ held: true, sessionId: 9 });
          await hold.promise;
        });
        expect(await screen.findByText("Review this failure.")).toBeInTheDocument();
      });

      it("holds terminal review on double-click without changing the saved mode", async () => {
        await act(async () => { render(<DictationPopup />); });
        await sendState({
          phase: "done",
          sessionId: 9,
          outcome: "pasted",
          preview: "Review this delivered result.",
        });

        fireEvent.doubleClick(document.querySelector("[data-hud-card]") as HTMLElement);

        expect(await screen.findByText("Review this delivered result.")).toBeInTheDocument();
        expect(popupMocks.invoke).toHaveBeenCalledWith(
          "hold_dictation_overlay_review",
          { sessionId: 9 },
        );
        expect(popupMocks.invoke).not.toHaveBeenCalledWith(
          "__overlay_set_display_mode__",
          expect.anything(),
        );
      });

      it("ignores a hold acknowledgement after a new capture starts", async () => {
        const hold = deferred<{ held: boolean; sessionId: number }>();
        const invoke = popupMocks.invoke.getMockImplementation();
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
          command === "hold_dictation_overlay_review"
            ? hold.promise
            : invoke?.(command, args),
        );
        await act(async () => { render(<DictationPopup />); });
        await sendState({ phase: "error", sessionId: 9, message: "Old failure." });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));

        await sendState({
          phase: "recording",
          sessionId: 10,
          startedAtMs: Date.now() + 1000,
        });
        await act(async () => {
          hold.resolve({ held: true, sessionId: 9 });
          await hold.promise;
        });

        expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Listening");
        expect(screen.queryByText("Old failure.")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Show compact controls" })).not.toBeInTheDocument();
      });

      it("reports a current hold failure and allows retry", async () => {
        const retry = deferred<{ held: boolean; sessionId: number }>();
        const invoke = popupMocks.invoke.getMockImplementation();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        let attempts = 0;
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
          if (command === "hold_dictation_overlay_review") {
            attempts += 1;
            if (attempts === 1) throw new Error("hold rejected");
            return retry.promise;
          }
          return invoke?.(command, args);
        });
        await act(async () => { render(<DictationPopup />); });
        await sendState({ phase: "error", sessionId: 9, message: "Words remain recoverable." });

        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        expect(
          (await screen.findByText(/Couldn't keep this review open\. It may close automatically\./)).closest('[role="alert"]'),
        ).not.toBeNull();
        expect(screen.getByText("Words remain recoverable.")).toBeInTheDocument();
        const retryButton = screen.getByRole("button", { name: "Retry keep open" });
        expect(retryButton).toBeEnabled();
        fireEvent.click(retryButton);
        await act(async () => {
          retry.resolve({ held: true, sessionId: 9 });
          await retry.promise;
        });

        expect(await screen.findByText("Words remain recoverable.")).toBeInTheDocument();
        expect(attempts).toBe(2);
        consoleError.mockRestore();
      });

      it("opens a startup failure without a session and explains the time limit", async () => {
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
          if (command === "__overlay_placement__") return { displayMode: "minimal" };
          if (command === "get_dictation_overlay_state") {
            return {
              phase: "error",
              message: "The shortcut could not reach the dictation engine.",
            };
          }
          return originalInvoke?.(command, args);
        });

        await act(async () => { render(<DictationPopup />); });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));

        expect(
          await screen.findByText("The shortcut could not reach the dictation engine."),
        ).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent(
          "This review may close automatically. Open the app to continue reviewing.",
        );
        expect(screen.queryByRole("button", { name: "Retry keep open" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open history" })).toBeInTheDocument();
        expect(popupMocks.invoke).not.toHaveBeenCalledWith(
          "hold_dictation_overlay_review",
          expect.anything(),
        );
      });

      it("does not hold an old native session for a later host error", async () => {
        await act(async () => { render(<DictationPopup />); });
        await sendState({
          phase: "error",
          message: "The shortcut could not reach the dictation engine.",
        });

        fireEvent.click(await screen.findByRole("button", { name: "Details" }));

        expect(
          await screen.findByText("The shortcut could not reach the dictation engine."),
        ).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent(
          "This review may close automatically.",
        );
        expect(popupMocks.invoke).not.toHaveBeenCalledWith(
          "hold_dictation_overlay_review",
          expect.anything(),
        );
      });

      it("restores a held terminal snapshot directly into full review", async () => {
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
          if (command === "__overlay_placement__") return { displayMode: "minimal" };
          if (command === "get_dictation_overlay_state") {
            return {
              phase: "done",
              sessionId: 9,
              outcome: "pasted",
              preview: "Restored held words.",
              warnings: ["Review this warning."],
              reviewHeld: true,
            };
          }
          return originalInvoke?.(command, args);
        });

        await act(async () => { render(<DictationPopup />); });

        expect(await screen.findByText("Review this warning.")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Latest result" })).toHaveTextContent(
          "Restored held words.",
        );
        expect(popupMocks.invoke).not.toHaveBeenCalledWith(
          "hold_dictation_overlay_review",
          expect.anything(),
        );
      });

      it("ignores a hold acknowledgement after the popup closes", async () => {
        const hold = deferred<{ held: boolean; sessionId: number }>();
        const invoke = popupMocks.invoke.getMockImplementation();
        popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
          command === "hold_dictation_overlay_review"
            ? hold.promise
            : invoke?.(command, args),
        );
        await act(async () => { render(<DictationPopup />); });
        await sendState({ phase: "error", sessionId: 9, message: "Do not reopen." });
        fireEvent.click(await screen.findByRole("button", { name: "Details" }));
        fireEvent.click(screen.getByRole("button", { name: "Hide popup" }));

        await act(async () => {
          hold.resolve({ held: true, sessionId: 9 });
          await hold.promise;
        });

        expect(popupMocks.invoke).toHaveBeenCalledWith("dismiss_dictation_overlay");
        expect(screen.queryByRole("button", { name: "Show compact controls" })).not.toBeInTheDocument();
      });
    });

    it("opens full error details without persisting a display mode or sending commands", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendState({
        phase: "error",
        sessionId: 9,
        message: "The dictation engine stopped before insertion.",
      });

      fireEvent.click(await screen.findByRole("button", { name: "Details" }));

      expect(await screen.findByText("The dictation engine stopped before insertion.")).toBeInTheDocument();
      expect(popupMocks.invoke).not.toHaveBeenCalledWith(
        "__overlay_set_display_mode__",
        expect.anything(),
      );
      expect(popupMocks.startDictation).not.toHaveBeenCalled();
      expect(popupMocks.stopDictation).not.toHaveBeenCalled();
      expect(
        popupMocks.invoke.mock.calls.some(([command]) =>
          ["force_stop_dictation", "hide_dictation_popup", "open_main_window"].includes(command),
        ),
      ).toBe(false);
    });

    it.each([
      ["error", true],
      ["secure_field", true],
      ["paste_dispatched", true],
      ["pasted", false],
    ])("shows Details for done outcome %s only when recovery is useful", async (outcome, visible) => {
      await act(async () => { render(<DictationPopup />); });
      await sendState({ phase: "done", sessionId: 9, outcome });
      expect(screen.queryByRole("button", { name: "Details" }) !== null).toBe(visible);
    });

    it("opens warned pasted details without changing the delivery result", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendText({
        sessionId: 9,
        text: "Keep the accepted final text.",
        pasted: true,
        appTarget: "Slack",
        warnings: ["Meaning guard kept the original wording."],
      });
      await sendState({
        phase: "done",
        sessionId: 9,
        outcome: "pasted",
        appTarget: "Slack",
      });

      const details = await screen.findByRole("button", { name: "Details" });
      const pill = document.querySelector("[data-hud-card]") as HTMLElement;
      expect(within(pill).getByTestId("dictation-hud-status")).toHaveTextContent("Inserted");
      expect(within(pill).queryByRole("progressbar")).not.toBeInTheDocument();
      expect(pill.querySelector("canvas")).toBeNull();
      fireEvent.click(details);

      expect((await screen.findAllByText(/Inserted into Slack/)).length).toBeGreaterThan(0);
      expect(screen.getByText("Meaning guard kept the original wording.")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Latest result" })).toHaveTextContent(
        "Keep the accepted final text.",
      );
      expect(screen.queryByText(/Not inserted/)).not.toBeInTheDocument();
    });

    it("does not repeat a warning already included in the done message", async () => {
      const warning = "Cleanup timed out, so Plainsong kept the original wording.";
      await act(async () => { render(<DictationPopup />); });
      await sendText({
        sessionId: 9,
        text: "Accepted text.",
        pasted: true,
        warnings: [warning],
      });
      await sendState({
        phase: "done",
        sessionId: 9,
        outcome: "pasted",
        message: warning,
      });

      fireEvent.click(await screen.findByRole("button", { name: "Details" }));
      expect(await screen.findAllByText(warning)).toHaveLength(1);
      expect(screen.queryByLabelText("Warnings")).not.toBeInTheDocument();
    });

    it("ignores blank warnings for clean successful delivery", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendText({
        sessionId: 9,
        text: "Clean result.",
        pasted: true,
        warnings: ["", "   "],
      });
      await sendState({ phase: "done", sessionId: 9, outcome: "pasted" });

      expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    });

    it("clears accepted warnings on the next capture", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendText({
        sessionId: 9,
        text: "Warned result.",
        pasted: true,
        warnings: ["Meaning guard kept the original wording."],
      });
      await sendState({ phase: "done", sessionId: 9, outcome: "pasted" });
      expect(await screen.findByRole("button", { name: "Details" })).toBeInTheDocument();

      await sendState({ phase: "recording", sessionId: 10, startedAtMs: Date.now() });
      await sendState({ phase: "done", sessionId: 10, outcome: "pasted" });

      expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    });

    it("restores warned terminal snapshot text for details and copy recovery", async () => {
      const exactText = "  Restored final words.\nKeep this line exact.  ";
      popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === "__overlay_placement__") return { displayMode: "minimal" };
        if (command === "get_dictation_overlay_state") {
          return {
            phase: "done",
            sessionId: 9,
            outcome: "pasted",
            appTarget: "Slack",
            preview: exactText,
            warnings: ["Meaning guard kept the original wording."],
          };
        }
        return originalInvoke?.(command, args);
      });

      await act(async () => { render(<DictationPopup />); });
      fireEvent.click(await screen.findByRole("button", { name: "Details" }));

      expect(await screen.findByText("Meaning guard kept the original wording.")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Latest result" }).textContent).toBe(exactText);
      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      await waitFor(() =>
        expect(popupMocks.copyOverlayText).toHaveBeenCalledWith(exactText),
      );
    });

    it("keeps a clean terminal snapshot free of recovery details", async () => {
      popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === "__overlay_placement__") return { displayMode: "minimal" };
        if (command === "get_dictation_overlay_state") {
          return {
            phase: "done",
            sessionId: 9,
            outcome: "pasted",
            preview: "Clean restored result.",
            warnings: [],
          };
        }
        return originalInvoke?.(command, args);
      });

      await act(async () => { render(<DictationPopup />); });
      expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Inserted");
      expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    });

    it("returns temporary details to the saved minimal mode on the next capture", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendState({ phase: "error", sessionId: 9, message: "First session failed." });
      fireEvent.click(await screen.findByRole("button", { name: "Details" }));
      expect(await screen.findByText("First session failed.")).toBeInTheDocument();

      await sendState({ phase: "preparing", sessionId: 93, startedAtMs: Date.now() + 1000 });

      expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Starting");
      expect(screen.queryByRole("button", { name: "Show compact controls" })).toBeNull();
    });

    it("keeps a manual display mode cycle after temporary details", async () => {
      await act(async () => { render(<DictationPopup />); });
      await sendState({ phase: "error", sessionId: 9, message: "Review this failure." });
      fireEvent.click(await screen.findByRole("button", { name: "Details" }));
      fireEvent.click(await screen.findByRole("button", { name: "Show compact controls" }));
      await waitFor(() =>
        expect(popupMocks.invoke).toHaveBeenCalledWith(
          "__overlay_set_display_mode__",
          { displayMode: "compact" },
        ),
      );

      await sendState({ phase: "recording", sessionId: 95, startedAtMs: Date.now() + 1000 });

      expect(await screen.findByRole("button", { name: "Show pill" })).toBeInTheDocument();
      expect(screen.queryByTestId("dictation-hud-status")).toBeNull();
    });

    it("uses the vertical trace slot for Details", async () => {
      popupMocks.getSettings.mockResolvedValueOnce({
        transcription: {},
        ui: { dictationPillDock: "left" },
      } as never);
      await act(async () => { render(<DictationPopup />); });
      await waitFor(() =>
        expect(document.querySelector("[data-hud-card]")).toHaveAttribute("data-dock", "left"),
      );
      await sendState({ phase: "done", sessionId: 9, outcome: "paste_dispatched" });

      const card = document.querySelector("[data-hud-card]") as HTMLElement;
      expect(card).toHaveAttribute("data-dock", "left");
      expect(within(card).getByRole("button", { name: "Details" })).toBeInTheDocument();
      expect(card.querySelector("canvas")).toBeNull();
    });
  });


  describe("dictating during a meeting", () => {
    const noticeKey = "plainsong_meeting_aside_notice_seen";
    const notice = "Your call can still hear you. Mute the call if this is private.";
    const send = async (payload: Record<string, unknown>) => {
      await act(async () => {
        popupMocks.listeners.get("dictation-state-changed")?.({ payload });
      });
    };
    const asMinimalPill = () => {
      const originalInvoke = popupMocks.invoke.getMockImplementation()!;
      popupMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
        command === "__overlay_placement__" ? { displayMode: "minimal" } : originalInvoke(command, args),
      );
      onTestFinished(() => { popupMocks.invoke.mockImplementation(originalInvoke); });
    };

    beforeEach(() => {
      window.localStorage.removeItem(noticeKey);
    });
    afterEach(() => {
      window.localStorage.removeItem(noticeKey);
    });

    it("labels an aside in the pill and keeps the reminder in its accessible name", async () => {
      window.localStorage.setItem(noticeKey, "true");
      asMinimalPill();
      await act(async () => { render(<DictationPopup />); });
      await send({ phase: "preparing", sessionId: 31, meetingAside: true });
      await send({ phase: "recording", sessionId: 31, captureReady: true, meetingAside: true });

      const status = await screen.findByTestId("dictation-hud-status");
      expect(status).toHaveTextContent("Dictating during a meeting");
      expect(status).toHaveAccessibleName(`Dictating during a meeting. ${notice}`);
      // Two short lines, not a truncated one.
      expect(status.className).toContain("line-clamp-2");
      expect(status.className).not.toContain("truncate");
      // Already shown once on this Mac, so the pill stays a pill.
      expect(screen.queryByTestId("meeting-aside-notice")).toBeNull();
      expect(document.querySelector("[data-hud-card]")).toHaveAttribute("data-tone", "live");
    });

    it("shows the reminder once, in the details card, and never again", async () => {
      asMinimalPill();
      await act(async () => { render(<DictationPopup />); });
      await send({ phase: "preparing", sessionId: 41, meetingAside: true });
      expect(screen.queryByTestId("meeting-aside-notice")).toBeNull();
      await send({ phase: "recording", sessionId: 41, captureReady: true, meetingAside: true });

      expect(await screen.findByTestId("meeting-aside-notice")).toHaveTextContent(notice);
      expect(window.localStorage.getItem(noticeKey)).toBe("true");
      // The card says what kind of dictation this is in its header too.
      expect(screen.getAllByText("Dictating during a meeting").length).toBeGreaterThan(0);
      // A preview-only update keeps the reminder up for the whole dictation.
      await send({ phase: "recording", sessionId: 41, partialText: "reply to Dana" });
      expect(screen.getByTestId("meeting-aside-notice")).toBeInTheDocument();

      await send({ phase: "idle" });
      expect(screen.queryByTestId("meeting-aside-notice")).toBeNull();

      await send({ phase: "preparing", sessionId: 42, meetingAside: true });
      await send({ phase: "recording", sessionId: 42, captureReady: true, meetingAside: true });
      expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Dictating during a meeting");
      expect(screen.queryByTestId("meeting-aside-notice")).toBeNull();
    });

    it("goes back to listening for the next ordinary dictation", async () => {
      window.localStorage.setItem(noticeKey, "true");
      asMinimalPill();
      await act(async () => { render(<DictationPopup />); });
      const startedAtMs = Date.now();
      await send({ phase: "recording", sessionId: 51, startedAtMs, captureReady: true, meetingAside: true });
      expect(await screen.findByTestId("dictation-hud-status")).toHaveTextContent("Dictating during a meeting");

      // A new session's fields start empty: nothing carries the aside over.
      await send({ phase: "recording", sessionId: 52, startedAtMs: startedAtMs + 5_000, captureReady: true });
      expect(screen.getByTestId("dictation-hud-status")).toHaveTextContent("Listening");
      expect(screen.getByTestId("dictation-hud-status").className).toContain("truncate");
    });
  });

});
