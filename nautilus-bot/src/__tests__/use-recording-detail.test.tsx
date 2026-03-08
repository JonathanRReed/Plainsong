import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingDetail } from "@/hooks/use-recording-detail";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const tauriMocks = vi.hoisted(() => ({
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
  getRecordingWaveform: vi.fn(async () => [0.1, 0.5, 0.2]),
  getSpeakers: vi.fn(async () => []),
}));

vi.mock("@/lib/tauri", () => ({
  getRecording: tauriMocks.getRecording,
  getTranscript: tauriMocks.getTranscript,
  getRecordingWaveform: tauriMocks.getRecordingWaveform,
  getSpeakers: tauriMocks.getSpeakers,
}));

describe("useRecordingDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});
