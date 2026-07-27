import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingDetail } from "@/hooks/use-recording-detail";
import type { Transcript } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: { payload: any }) => void) => {
      eventMocks.listeners.set(eventName, handler);
      return () => {
        eventMocks.listeners.delete(eventName);
      };
    }
  ),
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
  getTranscript: vi.fn(async (recordingId: string): Promise<Transcript> => ({
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
  getSpeakers: vi.fn(
    async (): Promise<
      Array<{
        id: string;
        name: string | null;
        color: string;
        sampleCount: number;
      }>
    > => [],
  ),
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
    eventMocks.listeners.clear();
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

  it("reloads persisted analysis citations and provider metadata after analysis-ready", async () => {
    const initialRecording = await backendMocks.getRecording("meeting-analysis");
    backendMocks.getRecording
      .mockResolvedValueOnce(initialRecording)
      .mockResolvedValueOnce({
        ...initialRecording,
        summary: "Persisted grounded summary",
        summaryProvenance: {
          version: 1,
          contentHash: "v1:sha256:summary",
          actualProvider: "ollama",
          actualModel: "llama3.2",
          promptSource: "meeting_playbook:auto",
          completedAt: "2026-07-25T12:00:00.000Z",
          citations: [
            {
              text: "The release remains on track.",
              startTime: 4,
              endTime: 7,
              recordingId: "meeting-analysis",
              certainty: 1,
            },
          ],
          grounded: true,
        },
      } as any);

    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      })
    );
    await act(async () => {
      await result.current.loadRecordingDetail(initialRecording);
    });
    await waitFor(() => {
      expect(eventMocks.listeners.has("recording-analysis-ready")).toBe(true);
    });

    act(() => {
      eventMocks.listeners.get("recording-analysis-ready")?.({
        payload: { recordingId: "meeting-analysis", target: "summary" },
      });
    });

    await waitFor(() => {
      expect(result.current.selectedRecording?.summary).toBe(
        "Persisted grounded summary"
      );
    });
    expect(
      result.current.selectedRecording?.summaryProvenance?.actualProvider
    ).toBe("ollama");
    expect(
      result.current.selectedRecording?.summaryProvenance?.citations[0]?.text
    ).toBe("The release remains on track.");
  });

  it("refreshes an open transcript, details, and speaker aliases after diarization enrichment", async () => {
    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      })
    );

    await act(async () => {
      await result.current.loadRecordingDetail({
        id: "meeting-enriched",
        title: "Meeting - Enriched",
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
      expect(eventMocks.listeners.has("transcript-updated")).toBe(true);
      expect(eventMocks.listeners.has("recording-status-changed")).toBe(true);
    });

    backendMocks.getTranscript.mockResolvedValueOnce({
      id: "tx-meeting-enriched",
      recordingId: "meeting-enriched",
      fullText: "Alice opened the meeting.",
      language: "en",
      confidence: 0.96,
      model: "Distil Whisper",
      segments: [
        {
          id: "segment-enriched",
          startTime: 0,
          endTime: 2,
          text: "Alice opened the meeting.",
          speakerId: "speaker_0",
          confidence: 0.96,
        },
      ],
    });
    backendMocks.getMeetingTranscriptDetails.mockResolvedValueOnce({
      segmentCount: 1,
      model: "Distil Whisper",
      modelId: "distil-large-v3",
      requestedProvider: "distil_whisper",
      actualProvider: "distil_whisper",
      qualityScore: 0.96,
      transcriptionLatencyMs: 640,
      sourceMode: "speaker_labels",
      hasSourceAwareSpeakers: false,
      hasSpeakerLabels: true,
    });
    backendMocks.getSpeakers.mockResolvedValueOnce([
      {
        id: "speaker_0",
        name: "Alice",
        color: "#000000",
        sampleCount: 1,
      },
    ]);

    act(() => {
      eventMocks.listeners.get("recording-status-changed")?.({
        payload: {
          recordingId: "meeting-enriched",
          status: "recording",
        },
      });
    });
    expect(result.current.selectedRecording?.status).toBe("recording");

    act(() => {
      eventMocks.listeners.get("transcript-updated")?.({
        payload: {
          recordingId: "meeting-enriched",
          reason: "diarization",
          updatedAt: "2026-03-08T18:58:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.selectedTranscript?.segments[0]?.speakerId).toBe(
        "speaker_0",
      );
      expect(result.current.selectedTranscriptDetails?.hasSpeakerLabels).toBe(
        true,
      );
      expect(result.current.speakerNames).toEqual({ speaker_0: "Alice" });
    });

    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(2);
    expect(backendMocks.getMeetingTranscriptDetails).toHaveBeenCalledTimes(2);
    expect(backendMocks.getSpeakers).toHaveBeenCalledTimes(2);
  });

  it("ignores older same-recording responses after a diarization refresh", async () => {
    const initialTranscript = deferred<Transcript>();
    const initialDetails = deferred<
      Awaited<ReturnType<typeof backendMocks.getMeetingTranscriptDetails>>
    >();
    const initialSpeakers = deferred<
      Awaited<ReturnType<typeof backendMocks.getSpeakers>>
    >();

    backendMocks.getTranscript
      .mockImplementationOnce(() => initialTranscript.promise)
      .mockResolvedValueOnce({
        id: "tx-meeting-race",
        recordingId: "meeting-race",
        fullText: "Alice kept the enriched transcript.",
        language: "en",
        confidence: 0.97,
        model: "Distil Whisper",
        segments: [
          {
            id: "segment-enriched",
            startTime: 0,
            endTime: 2,
            text: "Alice kept the enriched transcript.",
            speakerId: "speaker_0",
            confidence: 0.97,
          },
        ],
      });
    backendMocks.getMeetingTranscriptDetails
      .mockImplementationOnce(() => initialDetails.promise)
      .mockResolvedValueOnce({
        segmentCount: 1,
        model: "Distil Whisper",
        modelId: "distil-large-v3",
        requestedProvider: "distil_whisper",
        actualProvider: "distil_whisper",
        qualityScore: 0.97,
        transcriptionLatencyMs: 640,
        sourceMode: "speaker_labels",
        hasSourceAwareSpeakers: false,
        hasSpeakerLabels: true,
      });
    backendMocks.getSpeakers
      .mockImplementationOnce(() => initialSpeakers.promise)
      .mockResolvedValueOnce([
        {
          id: "speaker_0",
          name: "Alice",
          color: "#000000",
          sampleCount: 1,
        },
      ]);

    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      })
    );

    let initialLoad!: Promise<void>;
    act(() => {
      initialLoad = result.current.loadRecordingDetail({
        id: "meeting-race",
        title: "Meeting - Race",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:52.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "error",
      });
    });

    await waitFor(() => {
      expect(eventMocks.listeners.has("transcript-updated")).toBe(true);
    });

    act(() => {
      eventMocks.listeners.get("transcript-updated")?.({
        payload: {
          recordingId: "meeting-race",
          reason: "diarization",
          updatedAt: "2026-03-08T18:58:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.selectedTranscript?.fullText).toBe(
        "Alice kept the enriched transcript."
      );
      expect(result.current.selectedTranscriptDetails?.hasSpeakerLabels).toBe(true);
      expect(result.current.speakerNames).toEqual({ speaker_0: "Alice" });
    });

    initialTranscript.resolve({
      id: "tx-meeting-race",
      recordingId: "meeting-race",
      fullText: "Older transcript without labels.",
      language: "en",
      confidence: 0.8,
      model: "Distil Whisper",
      segments: [
        {
          id: "segment-old",
          startTime: 0,
          endTime: 2,
          text: "Older transcript without labels.",
          confidence: 0.8,
        },
      ],
    });
    initialDetails.resolve({
      segmentCount: 1,
      model: "Distil Whisper",
      modelId: "distil-large-v3",
      requestedProvider: "distil_whisper",
      actualProvider: "distil_whisper",
      qualityScore: 0.8,
      transcriptionLatencyMs: 640,
      sourceMode: "none",
      hasSourceAwareSpeakers: false,
      hasSpeakerLabels: false,
    });
    initialSpeakers.resolve([
      {
        id: "speaker_0",
        name: "Stale name",
        color: "#ffffff",
        sampleCount: 1,
      },
    ]);
    await act(async () => {
      await initialLoad;
    });

    expect(result.current.selectedTranscript?.fullText).toBe(
      "Alice kept the enriched transcript."
    );
    expect(result.current.selectedTranscriptDetails?.hasSpeakerLabels).toBe(true);
    expect(result.current.speakerNames).toEqual({ speaker_0: "Alice" });
  });

  it("auto-refreshes a processing meeting until canonical detail data lands", async () => {
    backendMocks.getRecording
      .mockResolvedValueOnce({
        id: "meeting-processing",
        title: "Meeting - Processing",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:52.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "processing",
      } as unknown as Awaited<ReturnType<typeof backendMocks.getRecording>>)
      .mockResolvedValueOnce({
        id: "meeting-processing",
        title: "Meeting - Processing",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:58.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "completed" as const,
      });

    const { result } = renderHook(() =>
      useRecordingDetail({
        isOpen: true,
      }),
    );

    await act(async () => {
      await result.current.loadRecordingDetail({
        id: "meeting-processing",
        title: "Meeting - Processing",
        projectId: "default",
        duration: 14,
        createdAt: "2026-03-08T18:57:36.000Z",
        updatedAt: "2026-03-08T18:57:52.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/meeting.wav",
        status: "processing",
      });
    });

    await waitFor(() => {
      expect(result.current.selectedRecording?.status).toBe("completed");
    });

    expect(backendMocks.getRecording).toHaveBeenCalledTimes(2);
    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(2);
    expect(backendMocks.getMeetingTranscriptDetails).toHaveBeenCalledTimes(2);
  });
});
