import { useCallback, useEffect, useState } from "react";
import { listen } from "@/lib/electron";
import {
  getRecording,
  getMeetingTranscriptDetails,
  getRecordingWaveform,
  getSpeakers,
  getTranscript,
} from "@/lib/backend";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import type {
  MeetingTranscriptDetails,
  Recording,
  Transcript,
  TranscriptSegment,
} from "@/types";

function normalizeTranscriptForViewer(
  transcript: Transcript | null,
  recordingId: string
): Transcript | null {
  if (!transcript) return null;
  const normalizedSegments: TranscriptSegment[] = Array.isArray(transcript.segments)
    ? transcript.segments
        .filter((segment): segment is TranscriptSegment => {
          return Boolean(
            segment &&
              typeof segment.text === "string" &&
              Number.isFinite(segment.startTime) &&
              Number.isFinite(segment.endTime)
          );
        })
        .map((segment, index) => ({
          id: segment.id || `${transcript.id ?? recordingId}-segment-${index}`,
          startTime: Number.isFinite(segment.startTime) ? segment.startTime : 0,
          endTime: Number.isFinite(segment.endTime) ? segment.endTime : 0,
          text: segment.text ?? "",
          speakerId: segment.speakerId,
          confidence: Number.isFinite(segment.confidence) ? segment.confidence : 0,
        }))
    : [];

  if (normalizedSegments.length > 0) {
    return { ...transcript, segments: normalizedSegments };
  }

  const fallbackText = transcript.fullText?.trim();
  if (!fallbackText) {
    return { ...transcript, segments: normalizedSegments };
  }

  const estimatedDurationSeconds = Math.max(
    1,
    Math.ceil(fallbackText.split(/\s+/).filter(Boolean).length / 2.5)
  );

  return {
    ...transcript,
    segments: [
      {
        id: `${transcript.id ?? recordingId}-full-text-fallback`,
        startTime: 0,
        endTime: estimatedDurationSeconds,
        text: fallbackText,
        confidence: Number.isFinite(transcript.confidence) ? transcript.confidence : 0,
      },
    ],
  };
}

type RecordingStatusChangedEvent = {
  recordingId: string;
  status: Recording["status"];
  message?: string | null;
  progress?: number | null;
  updatedAt?: string | null;
  meetingProcessingStartedAt?: string | null;
  transcriptFirstAvailableAt?: string | null;
  consentPromptShown?: boolean | null;
};

type UseRecordingDetailOptions = {
  isOpen: boolean;
  onRecordingLoaded?: (recording: Recording) => void;
};

export function useRecordingDetail({
  isOpen,
  onRecordingLoaded,
}: UseRecordingDetailOptions) {
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [selectedTranscriptDetails, setSelectedTranscriptDetails] =
    useState<MeetingTranscriptDetails | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestGuard = useScopedRequestGuard<string | null>();
  const selectedRecordingId = selectedRecording?.id ?? null;

  const applyLatestRecording = useCallback(
    (recording: Recording) => {
      setSelectedRecording((current) =>
        current?.id === recording.id ? recording : current
      );
      onRecordingLoaded?.(recording);
      return recording;
    },
    [onRecordingLoaded]
  );

  const fetchSelectedRecording = useCallback(async (recordingIdToRefresh: string) => {
    return await getRecording(recordingIdToRefresh);
  }, []);

  const fetchTranscript = useCallback(async (recordingId: string) => {
    const transcript = await getTranscript(recordingId);
    return normalizeTranscriptForViewer(transcript, recordingId);
  }, []);

  const fetchTranscriptDetails = useCallback(async (recordingId: string) => {
    return await getMeetingTranscriptDetails(recordingId);
  }, []);

  const fetchWaveform = useCallback(async (recordingId: string) => {
    const waveform = await getRecordingWaveform(recordingId, 500);
    return Array.isArray(waveform) ? waveform : [];
  }, []);

  const fetchSpeakerNames = useCallback(async (recordingId: string) => {
    const rawSpeakers = await getSpeakers(recordingId);
    const speakers = Array.isArray(rawSpeakers) ? rawSpeakers : [];

    return speakers.reduce<Record<string, string>>((acc, speaker) => {
      if (speaker.name) {
        acc[speaker.id] = speaker.name;
      }
      return acc;
    }, {});
  }, []);

  const refreshSelectedRecording = useCallback(
    async (recordingIdToRefresh: string) => {
      const latestRecording = await fetchSelectedRecording(recordingIdToRefresh);
      if (
        !latestRecording ||
        detailRequestGuard.activeScopeRef.current !== recordingIdToRefresh
      ) {
        return null;
      }
      return applyLatestRecording(latestRecording);
    },
    [applyLatestRecording, detailRequestGuard, fetchSelectedRecording]
  );

  const refreshTranscript = useCallback(
    async (recordingId: string) => {
      const transcript = await fetchTranscript(recordingId);
      if (detailRequestGuard.activeScopeRef.current !== recordingId) {
        return null;
      }
      setSelectedTranscript(transcript);
      return transcript;
    },
    [detailRequestGuard, fetchTranscript]
  );

  const refreshTranscriptDetails = useCallback(
    async (recordingId: string) => {
      const details = await fetchTranscriptDetails(recordingId);
      if (detailRequestGuard.activeScopeRef.current !== recordingId) {
        return null;
      }
      setSelectedTranscriptDetails(details);
      return details;
    },
    [detailRequestGuard, fetchTranscriptDetails]
  );

  const loadRecordingDetail = useCallback(
    async (recording: Recording) => {
      const requestToken = detailRequestGuard.beginRequest(recording.id);
      setSelectedRecording(recording);
      setIsLoadingDetail(true);
      setDetailError(null);
      setSelectedTranscript(null);
      setSelectedTranscriptDetails(null);
      setSpeakerNames({});
      setWaveformData([]);

      try {
        const [
          recordingResult,
          transcriptResult,
          transcriptDetailsResult,
          waveformResult,
          speakersResult,
        ] =
          await Promise.allSettled([
            fetchSelectedRecording(recording.id),
            fetchTranscript(recording.id),
            fetchTranscriptDetails(recording.id),
            fetchWaveform(recording.id),
            fetchSpeakerNames(recording.id),
          ]);

        if (!detailRequestGuard.isCurrent(requestToken)) {
          return;
        }

        let hadAnyFailure = false;

        if (recordingResult.status === "fulfilled" && recordingResult.value) {
          applyLatestRecording(recordingResult.value);
        } else if (recordingResult.status === "rejected") {
          hadAnyFailure = true;
        }

        if (transcriptResult.status === "fulfilled") {
          setSelectedTranscript(transcriptResult.value);
        } else {
          hadAnyFailure = true;
          setSelectedTranscript(null);
        }

        if (transcriptDetailsResult.status === "fulfilled") {
          setSelectedTranscriptDetails(transcriptDetailsResult.value);
        } else {
          hadAnyFailure = true;
          setSelectedTranscriptDetails(null);
        }

        if (waveformResult.status === "fulfilled") {
          setWaveformData(waveformResult.value);
        } else {
          hadAnyFailure = true;
          setWaveformData([]);
        }

        if (speakersResult.status === "fulfilled") {
          setSpeakerNames(speakersResult.value);
        } else {
          hadAnyFailure = true;
          setSpeakerNames({});
        }

        if (hadAnyFailure) {
          setDetailError(
            "Some recording details could not be loaded. Transcript content is still shown when available."
          );
        }
      } catch (error) {
        if (!detailRequestGuard.isCurrent(requestToken)) {
          return;
        }
        setDetailError(
          error instanceof Error ? error.message : "Failed to load recording details."
        );
      } finally {
        if (detailRequestGuard.isCurrent(requestToken)) {
          setIsLoadingDetail(false);
        }
      }
    },
    [
      applyLatestRecording,
      detailRequestGuard,
      fetchSelectedRecording,
      fetchSpeakerNames,
      fetchTranscript,
      fetchTranscriptDetails,
      fetchWaveform,
    ]
  );

  const clearRecordingDetail = useCallback(() => {
    detailRequestGuard.setScope(null);
    setSelectedRecording(null);
    setSelectedTranscript(null);
    setSelectedTranscriptDetails(null);
    setSpeakerNames({});
    setWaveformData([]);
    setIsLoadingDetail(false);
    setDetailError(null);
  }, [detailRequestGuard]);

  useEffect(() => {
    if (!isOpen || !selectedRecordingId) {
      return;
    }

    let unlistenAnalysis: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    const setup = async () => {
      unlistenAnalysis = await listen<{ recordingId: string }>(
        "recording-analysis-ready",
        (event) => {
          if (event.payload?.recordingId === selectedRecordingId) {
            void refreshSelectedRecording(selectedRecordingId);
            void refreshTranscript(selectedRecordingId);
            void refreshTranscriptDetails(selectedRecordingId);
          }
        }
      );

      unlistenTitle = await listen<{
        recordingId: string;
        status: "ok" | "error";
      }>("recording-title-updated", (event) => {
        if (
          event.payload?.status === "ok" &&
          event.payload.recordingId === selectedRecordingId
        ) {
          void refreshSelectedRecording(selectedRecordingId);
          void refreshTranscriptDetails(selectedRecordingId);
        }
      });

      unlistenStatus = await listen<RecordingStatusChangedEvent>(
        "recording-status-changed",
        (event) => {
          if (event.payload?.recordingId !== selectedRecordingId) {
            return;
          }

          setSelectedRecording((current) =>
            current ? { ...current, status: event.payload.status } : current
          );

          if (event.payload.status === "processing") {
            setSelectedTranscript(null);
            setSelectedTranscriptDetails(null);
            void refreshSelectedRecording(selectedRecordingId);
            void refreshTranscriptDetails(selectedRecordingId);
            return;
          }

          if (
            event.payload.status === "completed" ||
            event.payload.status === "error"
          ) {
            void refreshSelectedRecording(selectedRecordingId);
            void refreshTranscript(selectedRecordingId);
            void refreshTranscriptDetails(selectedRecordingId);
          }
        }
      );
    };

    void setup();
    return () => {
      unlistenAnalysis?.();
      unlistenTitle?.();
      unlistenStatus?.();
    };
  }, [
    isOpen,
    refreshSelectedRecording,
    refreshTranscript,
    refreshTranscriptDetails,
    selectedRecordingId,
  ]);

  useEffect(() => {
    if (!isOpen || !selectedRecording) {
      return;
    }

    if (selectedRecording.status === "error") {
      return;
    }

    const shouldPoll =
      selectedRecording.status === "processing" || selectedTranscript == null;
    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const [latestRecording] = await Promise.all([
          refreshSelectedRecording(selectedRecording.id),
          refreshTranscript(selectedRecording.id),
          refreshTranscriptDetails(selectedRecording.id),
        ]);
        if (cancelled) return;

        if (
          latestRecording &&
          (latestRecording.status === "completed" || latestRecording.status === "error")
        ) {
          return;
        }
      } catch (error) {
        console.warn("Recording detail auto-refresh failed:", error);
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    isOpen,
    refreshSelectedRecording,
    refreshTranscript,
    refreshTranscriptDetails,
    selectedRecording,
    selectedTranscript,
  ]);

  return {
    selectedRecording,
    setSelectedRecording,
    selectedTranscript,
    selectedTranscriptDetails,
    setSelectedTranscript,
    speakerNames,
    setSpeakerNames,
    waveformData,
    isLoadingDetail,
    detailError,
    loadRecordingDetail,
    refreshSelectedRecording,
    refreshTranscript,
    refreshTranscriptDetails,
    clearRecordingDetail,
  };
}
