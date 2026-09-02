import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPopup } from "@/components/popups/recording-popup";

const popupMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => void>();
  return {
    listeners,
    invoke: vi.fn(async (command: string) => {
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
    stopRecording: vi.fn(async () => {}),
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
    return () => popupMocks.listeners.delete(eventName);
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
  stopRecording: popupMocks.stopRecording,
  updateRecordingNotes: popupMocks.updateRecordingNotes,
  getSettings: popupMocks.getSettings,
}));

describe("RecordingPopup", () => {
  beforeEach(() => {
    popupMocks.listeners.clear();
    popupMocks.invoke.mockClear();
    popupMocks.getRecording.mockClear();
    popupMocks.getWaveformData.mockClear();
    popupMocks.stopRecording.mockReset();
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
        "Updated note from popup"
      );
    });
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
        "Sidecar stopped before the meeting was saved",
      );
    });
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
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
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
