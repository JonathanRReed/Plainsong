import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_MAX_SIZE } from "../../electron/overlay-placement";
import { RecordingPopup } from "@/components/popups/recording-popup";

const popupMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => void>();
  return {
    listeners,
    copyOverlayText: vi.fn(async (_text: string) => {}),
    // The fixture answers several command shapes.
    invoke: vi.fn(async (command: string, args?: unknown): Promise<any> => {
      if (command === "__overlay_copy_text__") return popupMocks.copyOverlayText((args as { text: string }).text);
      if (command === "__overlay_notes_focus__") return true;
      if (command === "get_recording_overlay_state") {
        return {
          phase: "recording",
          recordingId: "r1",
          startedAtMs: Date.now(),
          systemAudioActive: true,
          consentPromptShown: true,
          message: null,
        };
      }
      return null;
    }),
    getRecording: vi.fn(async () => ({
      id: "r1",
      title: "Board sync",
      projectId: "default",
      duration: 120,
      createdAt: "2026-03-11T18:00:00Z",
      updatedAt: "2026-03-11T18:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/board-sync.wav",
      status: "recording" as const,
      meetingNotes: "Initial note",
      meetingTemplateId: "standup",
      consentPromptShown: true,
      consentNoticeMode: "manual_required",
      consentNoticeMessage:
        "Send the consent notice in Zoom chat yourself. Plainsong does not post it for you.",
      metadata: {
        sampleRate: 16000,
        channels: 1,
        systemAudio: true,
      },
    })),
    getWaveformData: vi.fn(async () => [0.1, 0.2, 0.3]),
    getMeetingSourceLevels: vi.fn(async () => ({ mic: 0.05, system: 0.1 })),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    stopRecording: vi.fn(async () => {}),
    queueMeetingNoteRecovery: vi.fn(async () => {}),
    updateRecordingNotes: vi.fn(async (recordingId: string, meetingNotes: string) => {
      void recordingId;
      void meetingNotes;
    }),
    getSettings: vi.fn(async () => ({
      transcription: { meetingCustomTemplates: [] },
    })),
    windowHandle: {
      setSize: vi.fn(async () => {}),
      show: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    },
  };
});

vi.mock("@/lib/electron", () => ({
  invoke: popupMocks.invoke,
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    popupMocks.listeners.set(eventName, handler);
    return () => { if (popupMocks.listeners.get(eventName) === handler) popupMocks.listeners.delete(eventName); };
  }),
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

vi.mock("@/lib/backend", () => ({
  getRecording: popupMocks.getRecording,
  getWaveformData: popupMocks.getWaveformData,
  getMeetingSourceLevels: popupMocks.getMeetingSourceLevels,
  pauseRecording: popupMocks.pauseRecording,
  resumeRecording: popupMocks.resumeRecording,
  stopRecording: popupMocks.stopRecording,
  queueMeetingNoteRecovery: popupMocks.queueMeetingNoteRecovery,
  updateRecordingNotes: popupMocks.updateRecordingNotes,
  getSettings: popupMocks.getSettings,
}));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const cardMeasurement = { scrollHeight: 180, offsetHeight: 182 };
const resizeObservers = new Set<() => void>();
beforeEach(() => {
  cardMeasurement.scrollHeight = 180;
  cardMeasurement.offsetHeight = 182;
  resizeObservers.clear();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-recording-card") ? cardMeasurement.scrollHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-recording-card") ? cardMeasurement.offsetHeight : 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { resizeObservers.add(this.callback); }
    disconnect() { resizeObservers.delete(this.callback); }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


describe("RecordingPopup", () => {
  beforeEach(() => {
    popupMocks.listeners.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    popupMocks.invoke.mockClear();
    popupMocks.copyOverlayText.mockReset().mockResolvedValue(undefined);
    popupMocks.getRecording.mockClear();
    popupMocks.getWaveformData.mockClear();
    popupMocks.stopRecording.mockReset();
    popupMocks.queueMeetingNoteRecovery.mockReset();
    popupMocks.queueMeetingNoteRecovery.mockResolvedValue(undefined);
    popupMocks.stopRecording.mockResolvedValue(undefined);
    popupMocks.updateRecordingNotes.mockClear();
    popupMocks.getSettings.mockClear();
    popupMocks.windowHandle.setSize.mockClear();
    popupMocks.windowHandle.show.mockClear();
    popupMocks.windowHandle.hide.mockClear();
    popupMocks.windowHandle.startDragging.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("keeps compact capture controls together without full-mode metadata", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    expect(screen.getByText("Instant notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    expect(screen.getByText("Board sync")).toBeVisible();
    expect(screen.getByLabelText("Elapsed time")).toHaveTextContent(/\d{2}:\d{2}/);
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeVisible();
    expect(screen.getByText("Live meeting")).toBeVisible();
    expect(screen.getByText("Me + Them")).toBeVisible();
    expect(screen.getByText("Manual reminder required")).toBeVisible();
    expect(screen.queryByText("Instant notes")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Template:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Notes snapshot")).not.toBeInTheDocument();
    const card = screen.getByText("Board sync").closest("[data-recording-card]");
    expect(card).toHaveClass("bg-background");
    expect(card).not.toHaveClass("bg-background/95");
  });

  it("fits compact content, rounds up, and ignores unchanged measurements", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: 206 })));
    const calls = popupMocks.windowHandle.setSize.mock.calls.length;
    act(() => resizeObservers.forEach((notify) => notify()));
    expect(popupMocks.windowHandle.setSize).toHaveBeenCalledTimes(calls);
    cardMeasurement.scrollHeight = 250.3;
    cardMeasurement.offsetHeight = 252.3;
    act(() => resizeObservers.forEach((notify) => notify()));
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: 277 }));
    cardMeasurement.scrollHeight = 180;
    cardMeasurement.offsetHeight = 182;
    act(() => resizeObservers.forEach((notify) => notify()));
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: 206 }));
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 340, height: 46 }));
    const minimalCalls = popupMocks.windowHandle.setSize.mock.calls.length;
    act(() => resizeObservers.forEach((notify) => notify()));
    expect(popupMocks.windowHandle.setSize).toHaveBeenCalledTimes(minimalCalls);
  });

  it("bounds oversized compact content without changing the overlay security cap", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    cardMeasurement.scrollHeight = 2000;
    cardMeasurement.offsetHeight = 696;
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: OVERLAY_MAX_SIZE.recording.height }));
    expect(OVERLAY_MAX_SIZE.recording).toEqual({ width: 560, height: 720 });
  });

  it("keeps consent, preview delay, and lost audio visible in compact mode", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    await act(async () => popupMocks.listeners.get("recording-transcription-stream")?.({ payload: {
      recordingId: "r1", isPartial: true, isFinal: false, text: "A delayed preview", kind: "gap", startTime: 60, endTime: 72, delayedPreview: true, lagSeconds: 9,
    } }));
    expect(screen.getByText("12s not transcribed")).toBeVisible();
    expect(screen.getByText("Delayed preview")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy notice" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeVisible();
  });

  it.each(["full", "compact", "minimal"])("reveals live capture warnings from %s mode without stopping", async (mode) => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    if (mode !== "full") fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    if (mode === "minimal") fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: {
        phase: "recording", recordingId: "r1", message: "This meeting will stop at 120 minutes of captured audio.",
      } });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("120 minutes");
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    expect(popupMocks.stopRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(popupMocks.invoke).toHaveBeenCalledWith("open_main_window_to", { view: "settings", recordingId: null });
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    expect(screen.getByRole("alert")).toHaveTextContent("120 minutes");
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Show meeting warning" }));
    expect(screen.getByRole("alert")).toHaveTextContent("120 minutes");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", message: null } });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces each phase change to screen readers, without the clock", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    const announcer = () =>
      screen.getAllByRole("status").find((node) => node.getAttribute("aria-live") === "polite" && node.classList.contains("sr-only"));
    expect(announcer()).toHaveTextContent("Recording the meeting");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", paused: true } });
    });
    expect(announcer()).toHaveTextContent("Meeting paused");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
    });
    expect(announcer()).toHaveTextContent("Finishing the meeting");
    expect(announcer()?.textContent).not.toMatch(/\d:\d\d/);
  });

  it("does not carry capture warnings into a new recording", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", message: "Old meeting limit warning" } });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Old meeting limit warning");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r2", startedAtMs: Date.now() } });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows pause failures from the minimal popup and keeps retry available", async () => {
    popupMocks.pauseRecording.mockRejectedValueOnce(new Error("Microphone could not pause."));
    popupMocks.pauseRecording.mockResolvedValueOnce({ paused: true, closedPausedMs: 0, pauseStartedAtMs: Date.now() });
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone could not pause.");
    const retry = screen.getByRole("button", { name: "Pause recording" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Resume recording" })).toBeEnabled();
  });

  it("keeps Stop available after a failed command until a lifecycle event confirms stopping", async () => {
    popupMocks.stopRecording.mockRejectedValueOnce(new Error("Request failed"));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not confirm this meeting stopped");
    const retry = screen.getByRole("button", { name: "Stop recording" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(popupMocks.stopRecording).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
    });
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
  });

  it("ignores a delayed Stop failure after the lifecycle confirms processing", async () => {
    let rejectStop!: (error: Error) => void;
    popupMocks.stopRecording.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectStop = reject; }));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
      rejectStop(new Error("Late reply"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Processing").length).toBeGreaterThan(0);
  });

  it("shows resume failures while preserving the paused capture controls", async () => {
    popupMocks.resumeRecording.mockRejectedValueOnce(new Error("Microphone could not resume."));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", paused: true } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone could not resume.");
    expect(screen.getByRole("button", { name: "Resume recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
  });

  it.each(["Stop", "Pause"])("keeps a new meeting's pending %s disabled after an old rejection", async (control) => {
    const command = control === "Stop" ? popupMocks.stopRecording : popupMocks.pauseRecording;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: any) => void;
    command.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    command.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: `${control} recording` }));
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r2", startedAtMs: Date.now() } });
    });
    fireEvent.click(screen.getByRole("button", { name: `${control} recording` }));
    await act(async () => { rejectOld(new Error("Old request failed")); });
    expect(screen.getByRole("button", { name: `${control} recording` })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { resolveNew({ paused: true, closedPausedMs: 0, pauseStartedAtMs: Date.now() }); });
    if (control === "Pause") {
      expect(screen.getByRole("button", { name: "Resume recording" })).toBeEnabled();
    } else {
      await act(async () => {
        popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r2" } });
      });
      expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
    }
  });

  it("shows a live level for your microphone and for the meeting audio", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: {
        phase: "recording", recordingId: "r1", systemAudioActive: true,
      } });
    });
    const you = await screen.findByRole("meter", { name: "You level" });
    const meeting = screen.getByRole("meter", { name: "Meeting audio level" });
    await waitFor(() => {
      expect(Number(you.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
      expect(Number(meeting.getAttribute("aria-valuenow"))).toBeGreaterThan(
        Number(you.getAttribute("aria-valuenow")),
      );
    });
    expect(popupMocks.getMeetingSourceLevels).toHaveBeenCalledWith("r1");
  });

  it("sizes the initial full popup so its editor and controls can be reached", async () => {
    render(<RecordingPopup />);
    await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 470, height: 650 })));
  });

  it("hydrates meeting metadata and autosaves popup meeting notes", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });

    expect(await screen.findByText("Board sync")).toBeInTheDocument();
    expect(screen.getAllByText("Manual reminder required").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers, names, and next steps/i), {
      target: { value: "Updated note from popup" },
    });

    await waitFor(() => {
      expect(popupMocks.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Updated note from popup", undefined, "Initial note"
      );
    });
  });

  it("makes the overlay focusable only when the Live notes box is used, and releases it on blur", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });
    await screen.findByText("Board sync");
    expect(popupMocks.invoke).not.toHaveBeenCalledWith("__overlay_notes_focus__", expect.anything());

    const notes = screen.getByRole("textbox", { name: "Live notes" });
    await act(async () => {
      fireEvent.pointerDown(notes);
    });
    expect(popupMocks.invoke).toHaveBeenCalledWith("__overlay_notes_focus__", { focus: true });
    await waitFor(() => expect(document.activeElement).toBe(notes));

    await act(async () => {
      fireEvent.blur(notes);
    });
    expect(popupMocks.invoke).toHaveBeenLastCalledWith("__overlay_notes_focus__", { focus: false });
  });

  it("focuses Live notes from the menu bar command, opening the full popup", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    expect(screen.queryByRole("textbox", { name: "Live notes" })).not.toBeInTheDocument();

    await act(async () => {
      popupMocks.listeners.get("overlay-focus-live-notes")?.({ payload: {} });
    });
    const notes = await screen.findByRole("textbox", { name: "Live notes" });
    await waitFor(() => expect(document.activeElement).toBe(notes));
  });

  it("does not overwrite notes the meeting view wrote while the popup was open", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });

    await screen.findByText("Board sync");

    // The main window saved its own edit after the popup hydrated; the popup's
    // pre-write read is the next getRecording call.
    const hydrated = await popupMocks.getRecording();
    popupMocks.getRecording.mockResolvedValueOnce({
      ...hydrated,
      meetingNotes: "Initial note\nfrom the meeting view",
    });

    fireEvent.change(
      screen.getByPlaceholderText(/Capture decisions, blockers, names, and next steps/i),
      { target: { value: "Initial note\nfrom the popup" } }
    );

    await waitFor(() => {
      expect(popupMocks.updateRecordingNotes).toHaveBeenCalled();
    });

    const writes = popupMocks.updateRecordingNotes.mock.calls;
    const written = writes[writes.length - 1][1];
    expect(written).toContain("from the meeting view");
    expect(written).toContain("from the popup");
  });

  it("keeps newer popup typing when an older rebased save finishes", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    const hydrated = await popupMocks.getRecording();
    popupMocks.getRecording.mockResolvedValueOnce({ ...hydrated, meetingNotes: "Initial note\nRemote addition" });
    let finish!: () => void;
    popupMocks.updateRecordingNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const input = screen.getByPlaceholderText(/Capture decisions, blockers/i);
    fireEvent.change(input, { target: { value: "Initial note\nFirst local note" } });
    await waitFor(() => expect(popupMocks.updateRecordingNotes).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Initial note\nFirst local note\nNewer local condition" } });
    await act(async () => finish());
    expect((input as HTMLTextAreaElement).value).toContain("Newer local condition");
    expect((input as HTMLTextAreaElement).value).toContain("Remote addition");
  });

  it("shows popup note save failure with an explicit retry", async () => {
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    popupMocks.updateRecordingNotes.mockRejectedValueOnce(new Error("Meeting notes changed while saving"));
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Initial note\nKeep my condition" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved notes changed");
    fireEvent.click(screen.getByRole("button", { name: "Retry note save" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("expands the minimal popup back to the full notes card", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });

    await screen.findByText("Board sync");

    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 340, height: 46 }));
    fireEvent.click(screen.getByRole("button", { name: "Expand popup" }));

    expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 470, height: 650 }));
    expect(screen.getByRole("button", { name: "Compact popup" })).toBeInTheDocument();
  });

  it("keeps meeting-view access in minimal mode", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });

    await screen.findByText("Board sync");

    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Open meeting view" }));

    expect(popupMocks.invoke).toHaveBeenCalledWith("open_main_window_to", {
      view: "recordings",
      recordingId: "r1",
    });
  });

  it("retains the recording identifier and recovery text after a terminal error", async () => {
    await act(async () => {
      render(<RecordingPopup />);
    });
    await screen.findByText("Board sync");

    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({
        payload: {
          phase: "recoverable",
          recordingId: "r1",
          message: "Saved audio can be retried after relaunch.",
        },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Saved audio can be retried after relaunch.",
    );
    expect(screen.getByRole("button", { name: "Open Workspace" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
  });

  it("journals the last popup keystroke while stopping immediately", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    let finishQueue!: () => void;
    popupMocks.queueMeetingNoteRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => { finishQueue = resolve; }));
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Final condition before Stop" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(popupMocks.stopRecording).toHaveBeenCalledWith("r1");
    expect(popupMocks.queueMeetingNoteRecovery).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "r1", notes: "Final condition before Stop", baseNotes: "Initial note" }));
    await act(async () => finishQueue());
    await waitFor(() => expect(popupMocks.updateRecordingNotes).toHaveBeenCalledWith("r1", "Final condition before Stop", expect.any(String), "Initial note"));
  });

  it("keeps a failed final popup snapshot after capture loses its recording ID", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    popupMocks.updateRecordingNotes.mockRejectedValueOnce(new Error("Controlled final save failure"));
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Retain this final condition" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByLabelText("Retained final popup notes");
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "idle", recordingId: null } }); });
    expect(screen.getByLabelText("Retained final popup notes")).toHaveValue("Retain this final condition");
    fireEvent.click(screen.getByRole("button", { name: "Retry final note save" }));
    await waitFor(() => expect(screen.queryByLabelText("Retained final popup notes")).not.toBeInTheDocument());
  });

  it("keeps memory-only final notes visible when journal and note writes fail", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    popupMocks.queueMeetingNoteRecovery.mockRejectedValueOnce(new Error("Storage unavailable"));
    popupMocks.updateRecordingNotes.mockRejectedValueOnce(new Error("Storage unavailable"));
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Only copy of final notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(await screen.findByText("Final notes could not be stored. Keep Plainsong open and retry.")).toBeInTheDocument();
    expect(screen.getByLabelText("Retained final popup notes")).toHaveValue("Only copy of final notes");
  });

  it("journals the latest popup draft before allowing quit", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Final condition at quit" } });
    let finish!: () => void;
    popupMocks.queueMeetingNoteRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const target = window as Window & { __plainsongPrepareQuit?: () => Promise<boolean> };
    let settled = false;
    const quitting = target.__plainsongPrepareQuit!().then((allowed) => { settled = true; return allowed; });
    await waitFor(() => expect(popupMocks.queueMeetingNoteRecovery).toHaveBeenCalled());
    expect(settled).toBe(false);
    expect(popupMocks.queueMeetingNoteRecovery).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "r1", notes: "Final condition at quit", baseNotes: "Initial note" }));
    finish();
    expect(await quitting).toBe(true);
  });

  it("refuses quit when the popup draft cannot reach storage", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    fireEvent.change(screen.getByPlaceholderText(/Capture decisions, blockers/i), { target: { value: "Keep this unsaved condition" } });
    popupMocks.queueMeetingNoteRecovery.mockRejectedValueOnce(new Error("Storage unavailable"));
    const target = window as Window & { __plainsongPrepareQuit?: () => Promise<boolean> };
    await act(async () => { expect(await target.__plainsongPrepareQuit!()).toBe(false); });
    expect(screen.getByLabelText("Retained final popup notes")).toHaveValue("Keep this unsaved condition");
  });

  it("refuses quit if popup typing changes during the journal write", async () => {
    render(<RecordingPopup />); await screen.findByText("Board sync");
    const input = screen.getByPlaceholderText(/Capture decisions, blockers/i);
    fireEvent.change(input, { target: { value: "Earlier condition" } });
    let finish!: () => void;
    popupMocks.queueMeetingNoteRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const target = window as Window & { __plainsongPrepareQuit?: () => Promise<boolean> };
    const quitting = target.__plainsongPrepareQuit!();
    await waitFor(() => expect(popupMocks.queueMeetingNoteRecovery).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Later condition" } });
    finish();
    expect(await quitting).toBe(false);
    expect(input).toHaveValue("Later condition");
  });

  it("surfaces a Stop failure without losing the active recording", async () => {
    popupMocks.stopRecording.mockRejectedValueOnce(
      new Error("Sidecar stopped before the meeting was saved"),
    );

    await act(async () => {
      render(<RecordingPopup />);
    });
    await screen.findByText("Board sync");

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Plainsong could not confirm this meeting stopped. Try Stop again.",
      );
    });
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open Workspace" })).toBeVisible();
  });

  it("offers the copy-to-clipboard notice from the popup because Plainsong never posts it", async () => {
    popupMocks.getRecording.mockResolvedValueOnce({
      id: "r1",
      title: "Board sync",
      projectId: "default",
      duration: 120,
      createdAt: "2026-03-11T18:00:00Z",
      updatedAt: "2026-03-11T18:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/board-sync.wav",
      status: "recording" as const,
      meetingNotes: "Initial note",
      meetingTemplateId: "standup",
      consentPromptShown: true,
      consentNoticeMode: "manual_required",
      consentNoticeMessage: "Manual reminder only. Copy the notice from Plainsong before you continue.",
      metadata: {
        sampleRate: 16000,
        channels: 1,
        systemAudio: true,
      },
    });

    await act(async () => {
      render(<RecordingPopup />);
    });

    expect(await screen.findByText("Manual reminder required")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));

    await waitFor(() => {
      expect(popupMocks.copyOverlayText).toHaveBeenCalled();
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each(["full", "compact"])("retries notice copy failures through native clipboard from %s mode", async (mode) => {
    popupMocks.copyOverlayText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    if (mode === "compact") fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the notice. Try again.");
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(popupMocks.copyOverlayText).toHaveBeenCalledTimes(2);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("keeps a new meeting's notice copy pending when an old copy settles", async () => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    popupMocks.copyOverlayText
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNew = resolve; }));
    render(<RecordingPopup />);
    await screen.findByText("Board sync");
    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    await act(async () => {
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "processing", recordingId: "r1" } });
      popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r2", startedAtMs: Date.now() } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Copy notice" }));
    await act(async () => { finishOld(); });
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    await act(async () => { finishNew(); });
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy notice" })).toBeEnabled();
  });

  describe("meeting transcription activity", () => {
    let originalInvoke: ReturnType<typeof popupMocks.invoke.getMockImplementation>;
    beforeEach(() => { originalInvoke = popupMocks.invoke.getMockImplementation(); });
    afterEach(() => { if (originalInvoke) popupMocks.invoke.mockImplementation(originalInvoke); });
    const sendLifecycle = async (phase: string, recordingId = "r1") => {
      await waitFor(() => expect(popupMocks.listeners.has("meeting-recording-state-changed")).toBe(true));
      await act(async () => popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase, recordingId } }));
    };
    const sendProgress = async (recordingId = "r1") => {
      await waitFor(() => expect(popupMocks.listeners.has("recording-transcription-progress")).toBe(true));
      await act(async () => popupMocks.listeners.get("recording-transcription-progress")?.({
        payload: { recordingId, stage: "chunk_started", chunkIndex: 1, progress: 0.5 },
      }));
    };

    it("shows stage beside partial text and ignores foreign recording activity", async () => {
      await act(async () => { render(<RecordingPopup />); });
      await screen.findByText("Board sync");
      await sendLifecycle("processing");
      expect(await screen.findByText("Waiting for a transcription update.")).toBeInTheDocument();
      await act(async () => popupMocks.listeners.get("recording-transcription-stream")?.({
        payload: { recordingId: "r1", text: "Partial words remain available.", segmentText: "Partial words remain available.", isFinal: false, kind: "speech" },
      }));
      await sendProgress("foreign-recording");
      expect(screen.queryByText("Transcribing an audio segment")).not.toBeInTheDocument();
      await sendProgress();
      expect(await screen.findByText("Transcribing an audio segment")).toBeInTheDocument();
      expect(screen.getAllByText("Partial words remain available.").length).toBeGreaterThan(0);
      expect(screen.getByText("Last update just now.")).toBeInTheDocument();
      await sendLifecycle("ready", "foreign-recording");
      expect(screen.getByText("Transcribing an audio segment")).toBeInTheDocument();
      await sendLifecycle("ready");
      expect(screen.queryByText("Transcribing an audio segment")).not.toBeInTheDocument();
      expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
    });

    it("does not invent an update timer from a processing hydration", async () => {
      popupMocks.invoke.mockImplementation(async (command: string) => command === "get_recording_overlay_state"
        ? { phase: "processing", recordingId: "r1", startedAtMs: Date.now() - 60_000,
            systemAudioActive: false, consentPromptShown: false, message: null }
        : (await originalInvoke?.(command)) ?? null);
      await act(async () => { render(<RecordingPopup />); });
      expect(await screen.findByText("Waiting for a transcription update.")).toBeInTheDocument();
      expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
    });

    it.each(["ready", "error"])("queues an unknown old owner %s without replacing the hydrated current owner", async (oldPhase) => {
      let resolveSnapshot!: (value: any) => void;
      const snapshot = new Promise<any>((resolve) => { resolveSnapshot = resolve; });
      popupMocks.invoke.mockImplementation(async (command: string) => command === "get_recording_overlay_state"
        ? snapshot : originalInvoke?.(command));
      await act(async () => { render(<RecordingPopup />); });
      await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("get_recording_overlay_state"));
      await sendLifecycle(oldPhase, "old-A");
      expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
      await act(async () => { resolveSnapshot({ phase: "recording", recordingId: "current-B", startedAtMs: Date.now() }); await snapshot; });
      expect(await screen.findByRole("button", { name: "Stop recording" })).toBeInTheDocument();
      expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
      expect(screen.queryByText("Ready")).not.toBeInTheDocument();
      await sendLifecycle("processing", "current-B");
      await sendProgress("current-B");
      expect(await screen.findByText("Transcribing an audio segment")).toBeInTheDocument();
    });

    it.each(["ready", "processing"])("replays same-owner %s after its older recording snapshot", async (queuedPhase) => {
      let resolveSnapshot!: (value: any) => void;
      const snapshot = new Promise<any>((resolve) => { resolveSnapshot = resolve; });
      popupMocks.invoke.mockImplementation(async (command: string) => command === "get_recording_overlay_state"
        ? snapshot : originalInvoke?.(command));
      await act(async () => { render(<RecordingPopup />); });
      await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("get_recording_overlay_state"));
      await sendLifecycle(queuedPhase, "r1");
      await act(async () => { resolveSnapshot({ phase: "recording", recordingId: "r1", startedAtMs: Date.now() }); await snapshot; });
      expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
      if (queuedPhase === "ready") expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
      else {
        expect(await screen.findByText("Waiting for a transcription update.")).toBeInTheDocument();
        await sendProgress();
        expect(await screen.findByText("Transcribing an audio segment")).toBeInTheDocument();
      }
    });

    it("gives compact activity enough window height while full stays scrollable", async () => {
      await act(async () => { render(<RecordingPopup />); });
      await screen.findByText("Board sync");
      await sendLifecycle("processing");
      fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
      await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: 206 })));
      expect(screen.getByText("Waiting for a transcription update.")).toBeInTheDocument();
    });

    it("keeps a live processing update when an older hydration resolves later", async () => {
      let resolveSnapshot!: (value: any) => void;
      const snapshot = new Promise<any>((resolve) => { resolveSnapshot = resolve; });
      popupMocks.invoke.mockImplementation(async (command: string) => command === "get_recording_overlay_state"
        ? snapshot : originalInvoke?.(command));
      await act(async () => { render(<RecordingPopup />); });
      await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("get_recording_overlay_state"));
      await sendLifecycle("preparing", "r2");
      await sendLifecycle("processing", "r2");
      await sendProgress("r2");
      expect(await screen.findByText("Transcribing an audio segment")).toBeInTheDocument();
      await act(async () => { resolveSnapshot({ phase: "recording", recordingId: "r1", startedAtMs: Date.now() }); await snapshot; });
      expect(screen.getByText("Transcribing an audio segment")).toBeInTheDocument();
      await sendProgress("r1");
      expect(screen.getByText("Transcribing an audio segment")).toBeInTheDocument();
    });
  });

  describe("the transcript preview pane", () => {
    const streamSegment = (overrides: Record<string, unknown> = {}) => ({
      recordingId: "r1",
      isPartial: true,
      isFinal: false,
      text: "",
      segmentText: "",
      startTime: 0,
      endTime: 5,
      confidence: 0.9,
      kind: "speech",
      delayedPreview: true,
      lagSeconds: 7,
      ...overrides,
    });

    it("shows the whole preview transcript across consecutive segments", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const handler = popupMocks.listeners.get("recording-transcription-stream");
      expect(handler).toBeTruthy();

      // `text` is the running transcript, so this pane replaces rather than
      // appends; appending would repeat every earlier word on every event.
      await act(async () => {
        handler?.({
          payload: streamSegment({
            segmentText: "we should ship the parity push",
            text: "we should ship the parity push",
          }),
        });
        handler?.({
          payload: streamSegment({
            segmentText: "before Friday",
            text: "we should ship the parity push before Friday",
          }),
        });
        handler?.({
          payload: streamSegment({
            segmentText: "and tell the team",
            text: "we should ship the parity push before Friday and tell the team",
          }),
        });
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(
            "we should ship the parity push before Friday and tell the team"
          ).length
        ).toBeGreaterThan(0);
      });
    });

    it("does not call a preview that trails the speaker a live transcript", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const handler = popupMocks.listeners.get("recording-transcription-stream");

      await act(async () => {
        handler?.({
          payload: streamSegment({
            segmentText: "opening remarks",
            text: "opening remarks",
            lagSeconds: 9,
          }),
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("Delayed preview").length).toBeGreaterThan(0);
      });
      expect(screen.queryByText("Live transcript preview")).not.toBeInTheDocument();
      expect(screen.getByText(/9s behind the speaker/)).toBeInTheDocument();
    });

    it("reports audio that was lost before it could be decoded", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const handler = popupMocks.listeners.get("recording-transcription-stream");

      await act(async () => {
        handler?.({
          payload: streamSegment({
            kind: "gap",
            segmentText: "[12s not transcribed: the live preview fell behind]",
            text: "[12s not transcribed: the live preview fell behind]",
            startTime: 60,
            endTime: 72,
          }),
        });
      });

      await waitFor(() => {
        expect(screen.getByText("12s not transcribed")).toBeInTheDocument();
      });
    });

    it("warns in the overlay when a capture source goes silent mid-meeting", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const handler = popupMocks.listeners.get("meeting-audio-source-warning");
      expect(handler).toBeTruthy();

      await act(async () => {
        handler?.({
          payload: {
            recordingId: "r1",
            source: "mic",
            reason: "silence",
            silentSeconds: 20,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Microphone has gone silent")).toBeInTheDocument();
      });
    });

    it("keeps the live preview and source warning when a mid-meeting warning re-asserts the recording phase", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const streamHandler = popupMocks.listeners.get(
        "recording-transcription-stream",
      );
      const warningHandler = popupMocks.listeners.get(
        "meeting-audio-source-warning",
      );
      const lifecycleHandler = popupMocks.listeners.get(
        "meeting-recording-state-changed",
      );
      expect(lifecycleHandler).toBeTruthy();

      await act(async () => {
        streamHandler?.({
          payload: streamSegment({
            text: "Everyone can hear me now.",
            segmentText: "Everyone can hear me now.",
          }),
        });
        // `text` is the whole running preview, so the gap segment carries the
        // earlier words along with it.
        streamHandler?.({
          payload: streamSegment({
            kind: "gap",
            segmentText: "[12s not transcribed]",
            text: "Everyone can hear me now. [12s not transcribed]",
            startTime: 60,
            endTime: 72,
          }),
        });
        warningHandler?.({
          payload: {
            recordingId: "r1",
            source: "mic",
            reason: "silence",
            silentSeconds: 20,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Microphone has gone silent")).toBeInTheDocument();
      });

      // The sidecar re-emits `recording` mid-meeting purely to carry an
      // advisory message. This used to run the full "capture started" reset:
      // it blanked the preview, zeroed the lost-audio counter and dismissed the
      // source warning at the exact moment the warning arrived.
      await act(async () => {
        lifecycleHandler?.({
          payload: {
            phase: "recording",
            recordingId: "r1",
            message:
              "Plainsong stopped being able to save this meeting's audio, so nothing recorded from now on is kept.",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Plainsong stopped being able to save/),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Microphone has gone silent")).toBeInTheDocument();
      expect(screen.getByText(/Everyone can hear me now/)).toBeInTheDocument();
      expect(screen.getByText("12s not transcribed")).toBeInTheDocument();
    });

    it("still resets the preview when a different meeting takes over", async () => {
      await act(async () => {
        render(<RecordingPopup />);
      });
      await screen.findByText("Board sync");

      const streamHandler = popupMocks.listeners.get(
        "recording-transcription-stream",
      );
      const lifecycleHandler = popupMocks.listeners.get(
        "meeting-recording-state-changed",
      );

      await act(async () => {
        streamHandler?.({
          payload: streamSegment({
            text: "Words from the first meeting.",
            segmentText: "Words from the first meeting.",
          }),
        });
      });
      await waitFor(() => {
        expect(
          screen.getByText(/Words from the first meeting/),
        ).toBeInTheDocument();
      });

      // A genuinely new capture must not inherit its predecessor's preview.
      await act(async () => {
        lifecycleHandler?.({
          payload: {
            phase: "ready",
            recordingId: "r1",
          },
        });
        lifecycleHandler?.({
          payload: {
            phase: "recording",
            recordingId: "r2",
            startedAtMs: Date.now(),
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByText(/Words from the first meeting/),
        ).not.toBeInTheDocument();
      });
    });
  });
});

describe("recording popup microphone fallback", () => {
  const input = { requestedName: "Desk microphone", resolvedName: "Built-in Microphone", usedFallback: true, advisory: "Fallback" };
  it("hydrates fallback from the active session and preserves it through pause", async () => {
    const original = popupMocks.invoke.getMockImplementation();
    popupMocks.invoke.mockImplementation(async (command: string) => {
      if (!original) throw new Error("Missing popup fixture implementation");
      const result = await original(command);
      return command === "get_recording_overlay_state" && result
        ? { ...result, microphoneInput: input }
        : result;
    });
    render(<RecordingPopup />);
    expect(await screen.findByText("Using Built-in Microphone.")).toBeInTheDocument();
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", paused: true } }); });
    expect(screen.getByText("Using Built-in Microphone.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Meeting microphone" })).getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("open_main_window_to", { view: "settings", recordingId: null }));
    expect(popupMocks.invoke).not.toHaveBeenCalledWith("stop_recording", expect.anything());
  });
  it("keeps fallback controls reachable in compact and minimal modes", async () => {
    render(<RecordingPopup />);
    await waitFor(() => expect(popupMocks.listeners.has("meeting-recording-state-changed")).toBe(true));
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", microphoneInput: input } }); });
    await screen.findByText("Using Built-in Microphone.");
    fireEvent.click(screen.getByRole("button", { name: "Compact popup" }));
    await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 330, height: 206 })));
    expect(screen.getByRole("button", { name: "Dismiss warning" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Minimal popup" }));
    await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 340, height: 46 })));
    fireEvent.click(screen.getByRole("button", { name: "Show microphone warning" }));
    await waitFor(() => expect(popupMocks.windowHandle.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 470, height: 650 })));
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });
  it("scopes dismissal and clears fallback on stop without accepting foreign events", async () => {
    render(<RecordingPopup />);
    await waitFor(() => expect(popupMocks.listeners.has("meeting-recording-state-changed")).toBe(true));
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", microphoneInput: input } }); });
    expect(await screen.findByText("Using Built-in Microphone.")).toBeInTheDocument();
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "foreign", microphoneInput: { ...input, resolvedName: "Wrong" } } }); });
    expect(screen.queryByText("Using Wrong.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await waitFor(() => expect(popupMocks.invoke).toHaveBeenCalledWith("dismiss_meeting_microphone_warning", { recordingId: "r1" }));
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "r1", microphoneInput: input, microphoneWarningDismissed: true } }); });
    expect(screen.queryByText("Using Built-in Microphone.")).not.toBeInTheDocument();
    await act(async () => { popupMocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "stopping", recordingId: "r1" } }); });
    expect(screen.queryByRole("region", { name: "Meeting microphone" })).not.toBeInTheDocument();
  });
});
