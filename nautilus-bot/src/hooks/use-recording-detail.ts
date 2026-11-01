import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { listen } from "@/lib/electron";
import {
  getRecording,
  getMeetingTranscriptDetails,
  getRecordingWaveform,
  getTranscript,
} from "@/lib/backend/recordings";
import { getSpeakers } from "@/lib/backend/asr";
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

type TranscriptUpdatedEvent = {
  recordingId: string;
  reason: "diarization";
  updatedAt: string;
};

type UseRecordingDetailOptions = {
  isOpen: boolean;
  onRecordingLoaded?: (recording: Recording) => void;
};

export function useRecordingDetail({
  isOpen,
  onRecordingLoaded,
}: UseRecordingDetailOptions) {
  const [selectedRecording, setSelectedRecordingState] = useState<Recording | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [selectedTranscriptDetails, setSelectedTranscriptDetails] =
    useState<MeetingTranscriptDetails | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const onRecordingLoadedRef = useRef(onRecordingLoaded);
  onRecordingLoadedRef.current = onRecordingLoaded;
  const detailRequestGuard = useScopedRequestGuard<string | null>();
  const recordingRequestGuard = useScopedRequestGuard<string | null>();
  const transcriptRequestGuard = useScopedRequestGuard<string | null>();
  const transcriptDetailsRequestGuard = useScopedRequestGuard<string | null>();
  const speakerNamesRequestGuard = useScopedRequestGuard<string | null>();
  const setSelectedRecording = useCallback((action: SetStateAction<Recording | null>) => {
    // A confirmed local write supersedes reads started before that write.
    recordingRequestGuard.setScope(detailRequestGuard.activeScopeRef.current);
    setSelectedRecordingState(action);
  }, [detailRequestGuard, recordingRequestGuard]);
  const selectedRecordingId = selectedRecording?.id ?? null;

  const applyLatestRecording = useCallback(
    (recording: Recording) => {
      setSelectedRecordingState((current) =>
        current?.id === recording.id ? recording : current
      );
      onRecordingLoadedRef.current?.(recording);
      return recording;
    },
    []
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
      if (detailRequestGuard.activeScopeRef.current !== recordingIdToRefresh) return null;
      const requestToken = recordingRequestGuard.beginRequest(recordingIdToRefresh);
      const latestRecording = await fetchSelectedRecording(recordingIdToRefresh);
      if (
        !latestRecording ||
        detailRequestGuard.activeScopeRef.current !== recordingIdToRefresh ||
        !recordingRequestGuard.isCurrent(requestToken)
      ) {
        return null;
      }
      return applyLatestRecording(latestRecording);
    },
    [applyLatestRecording, detailRequestGuard, fetchSelectedRecording, recordingRequestGuard]
  );

  const refreshTranscript = useCallback(
    async (recordingId: string) => {
      if (detailRequestGuard.activeScopeRef.current !== recordingId) return null;
      const requestToken = transcriptRequestGuard.beginRequest(recordingId);
      const transcript = await fetchTranscript(recordingId);
      if (
        detailRequestGuard.activeScopeRef.current !== recordingId ||
        !transcriptRequestGuard.isCurrent(requestToken)
      ) {
        return null;
      }
      setSelectedTranscript(transcript);
      return transcript;
    },
    [detailRequestGuard, fetchTranscript, transcriptRequestGuard]
  );

  const refreshTranscriptDetails = useCallback(
    async (recordingId: string) => {
      if (detailRequestGuard.activeScopeRef.current !== recordingId) return null;
      const requestToken = transcriptDetailsRequestGuard.beginRequest(recordingId);
      const details = await fetchTranscriptDetails(recordingId);
      if (
        detailRequestGuard.activeScopeRef.current !== recordingId ||
        !transcriptDetailsRequestGuard.isCurrent(requestToken)
      ) {
        return null;
      }
      setSelectedTranscriptDetails(details);
      return details;
    },
    [detailRequestGuard, fetchTranscriptDetails, transcriptDetailsRequestGuard]
  );

  const refreshSpeakerNames = useCallback(
    async (recordingId: string) => {
      if (detailRequestGuard.activeScopeRef.current !== recordingId) return null;
      const requestToken = speakerNamesRequestGuard.beginRequest(recordingId);
      const names = await fetchSpeakerNames(recordingId);
      if (
        detailRequestGuard.activeScopeRef.current !== recordingId ||
        !speakerNamesRequestGuard.isCurrent(requestToken)
      ) {
        return null;
      }
      setSpeakerNames(names);
      return names;
    },
    [detailRequestGuard, fetchSpeakerNames, speakerNamesRequestGuard]
  );

  const loadRecordingDetail = useCallback(
    async (recording: Recording) => {
      const requestToken = detailRequestGuard.beginRequest(recording.id);
      const recordingRequestToken = recordingRequestGuard.beginRequest(recording.id);
      const transcriptRequestToken = transcriptRequestGuard.beginRequest(recording.id);
      const transcriptDetailsRequestToken =
        transcriptDetailsRequestGuard.beginRequest(recording.id);
      const speakerNamesRequestToken =
        speakerNamesRequestGuard.beginRequest(recording.id);
      setSelectedRecordingState(recording);
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

        if (recordingRequestGuard.isCurrent(recordingRequestToken)) {
          if (recordingResult.status === "fulfilled" && recordingResult.value) {
            applyLatestRecording(recordingResult.value);
          } else if (recordingResult.status === "rejected") {
            hadAnyFailure = true;
          }
        }

        if (transcriptRequestGuard.isCurrent(transcriptRequestToken)) {
          if (transcriptResult.status === "fulfilled") {
            setSelectedTranscript(transcriptResult.value);
          } else {
            hadAnyFailure = true;
            setSelectedTranscript(null);
          }
        }

        if (
          transcriptDetailsRequestGuard.isCurrent(transcriptDetailsRequestToken)
        ) {
          if (transcriptDetailsResult.status === "fulfilled") {
            setSelectedTranscriptDetails(transcriptDetailsResult.value);
          } else {
            hadAnyFailure = true;
            setSelectedTranscriptDetails(null);
          }
        }

        if (waveformResult.status === "fulfilled") {
          setWaveformData(waveformResult.value);
        } else {
          hadAnyFailure = true;
          setWaveformData([]);
        }

        if (speakerNamesRequestGuard.isCurrent(speakerNamesRequestToken)) {
          if (speakersResult.status === "fulfilled") {
            setSpeakerNames(speakersResult.value);
          } else {
            hadAnyFailure = true;
            setSpeakerNames({});
          }
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
      recordingRequestGuard,
      fetchSpeakerNames,
      fetchTranscript,
      fetchTranscriptDetails,
      fetchWaveform,
      speakerNamesRequestGuard,
      transcriptDetailsRequestGuard,
      transcriptRequestGuard,
    ]
  );

  const clearRecordingDetail = useCallback(() => {
    detailRequestGuard.setScope(null);
    recordingRequestGuard.setScope(null);
    transcriptRequestGuard.setScope(null);
    transcriptDetailsRequestGuard.setScope(null);
    speakerNamesRequestGuard.setScope(null);
    setSelectedRecordingState(null);
    setSelectedTranscript(null);
    setSelectedTranscriptDetails(null);
    setSpeakerNames({});
    setWaveformData([]);
    setIsLoadingDetail(false);
    setDetailError(null);
  }, [
    detailRequestGuard,
    recordingRequestGuard,
    speakerNamesRequestGuard,
    transcriptDetailsRequestGuard,
    transcriptRequestGuard,
  ]);

  useEffect(() => {
    if (!isOpen || !selectedRecordingId) {
      return;
    }

    let disposed = false;
    let unlistenAnalysis: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenTranscriptUpdated: (() => void) | undefined;

    const retainUnlistener = (
      assign: (unlisten: () => void) => void,
      unlisten: () => void,
    ) => {
      if (disposed) {
        unlisten();
        return;
      }
      assign(unlisten);
    };

    const setup = async () => {
      retainUnlistener(
        (unlisten) => {
          unlistenAnalysis = unlisten;
        },
        await listen<{ recordingId: string }>(
          "recording-analysis-ready",
          (event) => {
            if (event.payload?.recordingId === selectedRecordingId) {
              void refreshSelectedRecording(selectedRecordingId);
              void refreshTranscript(selectedRecordingId);
              void refreshTranscriptDetails(selectedRecordingId);
            }
          },
        ),
      );

      retainUnlistener(
        (unlisten) => {
          unlistenTitle = unlisten;
        },
        await listen<{
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
        }),
      );

      retainUnlistener(
        (unlisten) => {
          unlistenTranscriptUpdated = unlisten;
        },
        await listen<TranscriptUpdatedEvent>(
          "transcript-updated",
          (event) => {
            if (event.payload?.recordingId !== selectedRecordingId) {
              return;
            }

            void refreshTranscript(selectedRecordingId);
            void refreshTranscriptDetails(selectedRecordingId);
            void refreshSpeakerNames(selectedRecordingId);
          },
        ),
      );

      retainUnlistener(
        (unlisten) => {
          unlistenStatus = unlisten;
        },
        await listen<RecordingStatusChangedEvent>(
          "recording-status-changed",
          (event) => {
            if (disposed || event.payload?.recordingId !== selectedRecordingId
                || detailRequestGuard.activeScopeRef.current !== selectedRecordingId) {
              return;
            }

            setSelectedRecording((current) =>
              current?.id === selectedRecordingId ? { ...current, status: event.payload.status } : current
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
              event.payload.status === "pending" ||
              event.payload.status === "error"
            ) {
              void refreshSelectedRecording(selectedRecordingId);
              void refreshTranscript(selectedRecordingId);
              void refreshTranscriptDetails(selectedRecordingId);
            }
          },
        ),
      );
    };

    void setup();
    return () => {
      disposed = true;
      unlistenAnalysis?.();
      unlistenTitle?.();
      unlistenStatus?.();
      unlistenTranscriptUpdated?.();
    };
  }, [
    detailRequestGuard,
    setSelectedRecording,
    isOpen,
    refreshSelectedRecording,
    refreshSpeakerNames,
    refreshTranscript,
    refreshTranscriptDetails,
    selectedRecordingId,
  ]);

  const shouldPoll = isOpen && selectedRecordingId !== null
    && selectedRecording?.status !== "error"
    && selectedRecording?.status !== "pending"
    && (selectedRecording?.status === "processing" || selectedTranscript == null);

  useEffect(() => {
    if (!shouldPoll || !selectedRecordingId) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const results = await Promise.allSettled([
          refreshSelectedRecording(selectedRecordingId),
          refreshTranscript(selectedRecordingId),
          refreshTranscriptDetails(selectedRecordingId),
        ]);
        if (!cancelled && results.some(result => result.status === "rejected")) {
          console.warn("Some recording detail auto-refresh requests failed.");
        }
      } catch (error) {
        if (!cancelled) console.warn("Recording detail auto-refresh failed:", error);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const intervalId = window.setInterval(() => { void poll(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [shouldPoll, selectedRecordingId, refreshSelectedRecording, refreshTranscript, refreshTranscriptDetails]);

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
    refreshSpeakerNames,
    refreshTranscript,
    refreshTranscriptDetails,
    clearRecordingDetail,
  };
}
