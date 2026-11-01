import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingDetail } from "@/hooks/use-recording-detail";
import type { Recording, Transcript } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function recording(
  id: string,
  overrides: Partial<Recording> = {},
): Recording {
  return {
    id,
    title: `Meeting - ${id}`,
    projectId: "default",
    duration: 14,
    createdAt: "2026-03-08T18:57:36.000Z",
    updatedAt: "2026-03-08T18:57:52.000Z",
    sourceType: "meeting",
    audioPath: `/tmp/${id}.wav`,
    status: "error",
    ...overrides,
  };
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
  getRecording: vi.fn(async (recordingId: string): Promise<Recording> => ({
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

  it("keeps one processing poll on the two-second cadence and uses the latest callback", async () => {
    vi.useFakeTimers();
    const initial = recording("meeting-processing", { status: "processing" });
    const refreshed = recording("meeting-processing", {
      status: "processing",
      updatedAt: "2026-03-08T18:57:58.000Z",
    });
    const firstPoll = deferred<Recording>();
    const secondPoll = deferred<Recording>();
    backendMocks.getRecording
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => firstPoll.promise)
      .mockImplementationOnce(() => secondPoll.promise);
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();

    const { result, rerender, unmount } = renderHook(
      ({ onLoaded }: { onLoaded: (value: Recording) => void }) =>
        useRecordingDetail({
          isOpen: true,
          onRecordingLoaded: (value) => onLoaded(value),
        }),
      { initialProps: { onLoaded: firstCallback } },
    );

    try {
      await act(async () => {
        await result.current.loadRecordingDetail(initial);
      });
      await act(async () => {});
      expect(backendMocks.getRecording).toHaveBeenCalledTimes(2);

      rerender({ onLoaded: latestCallback });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(backendMocks.getRecording).toHaveBeenCalledTimes(2);

      await act(async () => {
        firstPoll.resolve(refreshed);
        await firstPoll.promise;
      });
      expect(result.current.selectedRecording?.updatedAt).toBe(
        "2026-03-08T18:57:58.000Z",
      );
      expect(latestCallback).toHaveBeenCalledWith(refreshed);
      expect(firstCallback).toHaveBeenCalledTimes(1);
      expect(backendMocks.getRecording).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(backendMocks.getRecording).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(backendMocks.getRecording).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      secondPoll.resolve(refreshed);
      vi.useRealTimers();
    }
  });

  it("keeps the newer same-recording refresh when responses resolve out of order", async () => {
    const initial = recording("meeting-refresh-race");
    const olderResponse = deferred<Recording>();
    const newerResponse = deferred<Recording>();
    const onRecordingLoaded = vi.fn();
    backendMocks.getRecording.mockResolvedValueOnce(initial);

    const { result } = renderHook(() =>
      useRecordingDetail({ isOpen: true, onRecordingLoaded }),
    );
    await act(async () => {
      await result.current.loadRecordingDetail(initial);
    });
    onRecordingLoaded.mockClear();
    backendMocks.getRecording
      .mockImplementationOnce(() => olderResponse.promise)
      .mockImplementationOnce(() => newerResponse.promise);

    let olderRefresh!: Promise<Recording | null>;
    let newerRefresh!: Promise<Recording | null>;
    act(() => {
      olderRefresh = result.current.refreshSelectedRecording(initial.id);
      newerRefresh = result.current.refreshSelectedRecording(initial.id);
    });

    const newer = recording(initial.id, { summary: "New summary" });
    await act(async () => {
      newerResponse.resolve(newer);
      await newerRefresh;
    });
    expect(result.current.selectedRecording?.summary).toBe("New summary");

    const older = recording(initial.id, { summary: "Old summary" });
    await act(async () => {
      olderResponse.resolve(older);
      await olderRefresh;
    });

    expect(result.current.selectedRecording?.summary).toBe("New summary");
    expect(onRecordingLoaded).toHaveBeenCalledTimes(1);
    expect(onRecordingLoaded).toHaveBeenCalledWith(newer);
  });

  it("invalidates an older refresh when a local recording update is confirmed", async () => {
    const initial = recording("meeting-local-write", { summary: "Initial summary" });
    const staleResponse = deferred<Recording>();
    const onRecordingLoaded = vi.fn();
    backendMocks.getRecording.mockResolvedValueOnce(initial);

    const { result } = renderHook(() =>
      useRecordingDetail({ isOpen: true, onRecordingLoaded }),
    );
    await act(async () => {
      await result.current.loadRecordingDetail(initial);
    });
    onRecordingLoaded.mockClear();
    backendMocks.getRecording.mockImplementationOnce(() => staleResponse.promise);

    let pendingRefresh!: Promise<Recording | null>;
    act(() => {
      pendingRefresh = result.current.refreshSelectedRecording(initial.id);
      result.current.setSelectedRecording(
        recording(initial.id, { summary: "Confirmed local summary" }),
      );
    });

    const stale = recording(initial.id, { summary: "Stale server summary" });
    let refreshResult: Recording | null | undefined;
    await act(async () => {
      staleResponse.resolve(stale);
      refreshResult = await pendingRefresh;
    });

    expect(refreshResult).toBeNull();
    expect(result.current.selectedRecording?.summary).toBe(
      "Confirmed local summary",
    );
    expect(onRecordingLoaded).not.toHaveBeenCalled();
  });

  it("invalidates an old refresh when navigation returns from B to A", async () => {
    const firstA = recording("meeting-a", { summary: "First A" });
    const meetingB = recording("meeting-b", { summary: "Meeting B" });
    const currentA = recording("meeting-a", { summary: "Current A" });
    const oldAResponse = deferred<Recording>();
    const onRecordingLoaded = vi.fn();
    backendMocks.getRecording.mockResolvedValueOnce(firstA);

    const { result } = renderHook(() =>
      useRecordingDetail({ isOpen: true, onRecordingLoaded }),
    );
    await act(async () => {
      await result.current.loadRecordingDetail(firstA);
    });
    onRecordingLoaded.mockClear();
    backendMocks.getRecording
      .mockImplementationOnce(() => oldAResponse.promise)
      .mockResolvedValueOnce(meetingB)
      .mockResolvedValueOnce(currentA);

    let staleRefresh!: Promise<Recording | null>;
    act(() => {
      staleRefresh = result.current.refreshSelectedRecording(firstA.id);
    });
    await act(async () => {
      await result.current.loadRecordingDetail(meetingB);
      await result.current.loadRecordingDetail(currentA);
    });
    onRecordingLoaded.mockClear();

    const staleA = recording("meeting-a", { summary: "Stale A" });
    await act(async () => {
      oldAResponse.resolve(staleA);
      await staleRefresh;
    });

    expect(result.current.selectedRecording?.summary).toBe("Current A");
    expect(onRecordingLoaded).not.toHaveBeenCalled();
  });
});
