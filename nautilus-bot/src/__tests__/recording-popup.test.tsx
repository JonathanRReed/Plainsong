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
      consentNoticeMode: "sent",
      consentNoticeMessage: "Consent notice posted in Zoom chat.",
      metadata: {
        sampleRate: 16000,
        channels: 1,
        systemAudio: true,
      },
    })),
    getWaveformData: vi.fn(async () => [0.1, 0.2, 0.3]),
    stopRecording: vi.fn(async () => {}),
    updateRecordingNotes: vi.fn(async () => {}),
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
}));

describe("RecordingPopup", () => {
  beforeEach(() => {
    popupMocks.listeners.clear();
    popupMocks.invoke.mockClear();
    popupMocks.getRecording.mockClear();
    popupMocks.getWaveformData.mockClear();
    popupMocks.stopRecording.mockClear();
    popupMocks.updateRecordingNotes.mockClear();
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
    expect(screen.getAllByText("Notice sent").length).toBeGreaterThan(0);

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

  it("offers manual consent recovery from the popup when automation did not send", async () => {
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
      consentNoticeMessage: "Manual reminder only. Copy the notice from Nautilus before you continue.",
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
});
