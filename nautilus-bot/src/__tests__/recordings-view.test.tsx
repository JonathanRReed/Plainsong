import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsView } from "@/components/views/recordings-view";

const mocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
  refetch: vi.fn(),
  toast: vi.fn(),
  getRecording: vi.fn(),
  getTranscript: vi.fn(),
  getRecordingWaveform: vi.fn(async () => []),
  getSpeakers: vi.fn(async () => []),
  recordings: [
    {
      id: "r1",
      title: "Weekly sync",
      projectId: "default",
      duration: 120,
      createdAt: "2026-03-06T12:00:00Z",
      updatedAt: "2026-03-06T12:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/weekly-sync.wav",
      status: "completed" as const,
    },
  ],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    mocks.eventListeners.set(eventName, handler);
    return () => {
      mocks.eventListeners.delete(eventName);
    };
  }),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings: mocks.recordings,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    startMeeting: vi.fn(),
    stopMeeting: vi.fn(),
    isRecording: false,
    recordingId: null,
    formattedDuration: "00:00",
  }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast: mocks.toast,
  }),
}));

vi.mock("@/components/recording-overlay", () => ({
  ConsentDialog: () => null,
}));

vi.mock("@/components/transcript-viewer", () => ({
  TranscriptViewer: () => null,
  TranscriptSearch: () => null,
}));

vi.mock("@/components/waveform-visualizer", () => ({
  RecordingWaveform: () => null,
  WaveformVisualizer: () => null,
}));

vi.mock("@/components/ai-analysis-panel", () => ({
  AiAnalysisPanel: () => null,
}));

vi.mock("@/lib/tauri", () => ({
  getRecording: mocks.getRecording,
  getRecordingWaveform: mocks.getRecordingWaveform,
  openRecordingAudio: vi.fn(),
  getSpeakers: mocks.getSpeakers,
  getTranscript: mocks.getTranscript,
  runDiarization: vi.fn(),
  renameSpeaker: vi.fn(),
  deleteRecording: vi.fn(),
  renameRecording: vi.fn(),
  retryMeetingAutoName: vi.fn(),
  setRecordingSourceType: vi.fn(),
  isDiarizationModelAvailable: vi.fn(async () => false),
  updateTranscriptSegment: vi.fn(),
  deleteTranscriptSegments: vi.fn(),
  updateRecordingNotes: vi.fn(),
}));

describe("RecordingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventListeners.clear();
    mocks.getRecording.mockResolvedValue(mocks.recordings[0]);
    mocks.getTranscript.mockResolvedValue({
      id: "t1",
      recordingId: "r1",
      segments: [
        {
          id: "s1",
          startTime: 0,
          endTime: 5,
          text: "Transcript",
          confidence: 0.9,
        },
      ],
      fullText: "Transcript",
      language: "en",
      confidence: 0.9,
      model: "distil-whisper",
    });
  });

  it("updates meeting filters immediately when a recording enters processing", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "Processing" }));
    expect(screen.getByText("No meetings match your filters")).toBeInTheDocument();

    const handler = mocks.eventListeners.get("recording-status-changed");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          status: "processing",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    });
  });

  it("refreshes the selected meeting from canonical recording data when analysis completes", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    mocks.getRecording.mockResolvedValue({
      ...mocks.recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    const handler = mocks.eventListeners.get("recording-analysis-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          summary: "Stale event summary",
          actionItems: ["Stale event action"],
        },
      });
    });

    await waitFor(() => {
      expect(mocks.refetch).toHaveBeenCalled();
      expect(screen.getByText("Canonical meeting summary")).toBeInTheDocument();
      expect(screen.getByText("Ship launch checklist")).toBeInTheDocument();
    });
  });
});
