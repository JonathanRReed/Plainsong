import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingDetail } from "@/hooks/use-recording-detail";

const electronMocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    electronMocks.eventListeners.set(eventName, handler);
    return () => {
      if (electronMocks.eventListeners.get(eventName) === handler) {
        electronMocks.eventListeners.delete(eventName);
      }
    };
  }),
  invoke: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  getRecording: vi.fn(async (recordingId: string) => ({
    id: recordingId,
    title: "Meeting - 2026-03-08 13:57",
    projectId: "default",
    duration: 14,
    createdAt: "2026-03-08T18:57:36.000Z",
    updatedAt: "2026-03-08T18:57:52.000Z",
    sourceType: "meeting",
    audioPath: "/tmp/meeting.wav",
    status: "completed" as const,
  })),
  getTranscript: vi.fn(async (recordingId: string) => ({
    id: `tx-${recordingId}`,
    recordingId,
    fullText: "Discussed dictation popup lag and meeting title fallback behavior.",
    language: "en",
    confidence: 0.94,
    model: "Apple Native Speech",
    segments: [],
  })),
  getMeetingTranscriptDetails: vi.fn(async () => ({
    segmentCount: 1,
    model: "Distil Whisper",
    modelId: "distil-large-v3",
    requestedProvider: "distil_whisper",
    actualProvider: "distil_whisper",
    qualityScore: 0.91,
    transcriptionLatencyMs: 640,
    sourceMode: "me_them",
    hasSourceAwareSpeakers: true,
    hasSpeakerLabels: true,
  })),
  getRecordingWaveform: vi.fn(async () => [0.1, 0.5, 0.2]),
  getSpeakers: vi.fn(async () => []),
}));

vi.mock("@/lib/backend", () => ({
  getRecording: backendMocks.getRecording,
  getTranscript: backendMocks.getTranscript,
  getMeetingTranscriptDetails: backendMocks.getMeetingTranscriptDetails,
  getRecordingWaveform: backendMocks.getRecordingWaveform,
  getSpeakers: backendMocks.getSpeakers,
}));

describe("useRecordingDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.eventListeners.clear();
  });

  it("synthesizes a transcript segment when full text exists but segments are missing", async () => {
    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      })
    );

    await act(async () => {
      await result.current.loadRecordingDetail({
        id: "meeting-1",
        title: "Meeting - 2026-03-08 13:57",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:52.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "completed",
      });
    });

    await waitFor(() => {
      expect(result.current.selectedTranscript?.segments).toHaveLength(1);
    });

    expect(result.current.selectedTranscript?.segments[0]?.text).toContain(
      "dictation popup lag"
    );
    expect(result.current.selectedTranscript?.segments[0]?.endTime).toBeGreaterThan(0);
    expect(result.current.selectedTranscriptDetails?.sourceMode).toBe("me_them");
    expect(result.current.selectedTranscriptDetails?.qualityScore).toBe(0.91);
  });

  it("clears stale transcript state and refreshes an open meeting when it enters processing", async () => {
    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      })
    );

    await act(async () => {
      await result.current.loadRecordingDetail({
        id: "meeting-1",
        title: "Meeting - 2026-03-08 13:57",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:52.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "completed",
      });
    });

    let statusChangedHandler:
      | ((event: { payload: any }) => void)
      | undefined;
    await waitFor(() => {
      statusChangedHandler = electronMocks.eventListeners.get(
        "recording-status-changed"
      );
      expect(statusChangedHandler).toBeTruthy();
      expect(result.current.selectedTranscript?.segments).toHaveLength(1);
    });

    backendMocks.getRecording.mockResolvedValue({
      id: "meeting-1",
      title: "Meeting - 2026-03-08 13:57",
      projectId: "default",
      duration: 14,
      createdAt: "2026-03-08T18:57:36.000Z",
      updatedAt: "2026-03-08T18:58:02.000Z",
      sourceType: "meeting",
      audioPath: "/tmp/meeting.wav",
      status: "processing" as const,
    } as any);
    backendMocks.getTranscript.mockResolvedValue(null as any);
    backendMocks.getMeetingTranscriptDetails.mockResolvedValue(null as any);

    await act(async () => {
      expect(statusChangedHandler).toBeTruthy();
      statusChangedHandler?.({
        payload: {
          recordingId: "meeting-1",
          status: "processing",
          message: "Processing transcript",
          progress: 0,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.selectedRecording?.status).toBe("processing");
      expect(result.current.selectedTranscript).toBeNull();
      expect(result.current.selectedTranscriptDetails).toBeNull();
    });

    expect(backendMocks.getRecording).toHaveBeenCalledWith("meeting-1");
    expect(backendMocks.getMeetingTranscriptDetails).toHaveBeenCalledWith("meeting-1");
  });
});
