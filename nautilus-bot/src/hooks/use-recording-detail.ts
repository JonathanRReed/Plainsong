import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getRecording,
  getRecordingWaveform,
  getSpeakers,
  getTranscript,
} from "@/lib/tauri";
import type { Recording, Transcript, TranscriptSegment } from "@/types";

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

  return { ...transcript, segments: normalizedSegments };
}

type RecordingStatusChangedEvent = {
  recordingId: string;
  status: Recording["status"];
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
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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

  const refreshSelectedRecording = useCallback(
    async (recordingIdToRefresh: string) => {
      const latestRecording = await getRecording(recordingIdToRefresh);
      if (latestRecording) {
        return applyLatestRecording(latestRecording);
      }
      return null;
    },
    [applyLatestRecording]
  );

  const refreshTranscript = useCallback(async (recordingId: string) => {
    const transcript = await getTranscript(recordingId);
    const normalized = normalizeTranscriptForViewer(transcript, recordingId);
    setSelectedTranscript(normalized);
    return normalized;
  }, []);

  const loadRecordingDetail = useCallback(
    async (recording: Recording) => {
      setSelectedRecording(recording);
      setIsLoadingDetail(true);
      setDetailError(null);
      setSelectedTranscript(null);
      setSpeakerNames({});
      setWaveformData([]);

      try {
        const [recordingResult, transcriptResult, waveformResult, speakersResult] =
          await Promise.allSettled([
            getRecording(recording.id),
            refreshTranscript(recording.id),
            getRecordingWaveform(recording.id, 500),
            getSpeakers(recording.id),
          ]);

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

        if (waveformResult.status === "fulfilled") {
          const waveform = waveformResult.value;
          setWaveformData(Array.isArray(waveform) ? waveform : []);
        } else {
          hadAnyFailure = true;
          setWaveformData([]);
        }

        if (speakersResult.status === "fulfilled") {
          const speakers = Array.isArray(speakersResult.value) ? speakersResult.value : [];
          setSpeakerNames(
            speakers.reduce<Record<string, string>>((acc, speaker) => {
              if (speaker.name) {
                acc[speaker.id] = speaker.name;
              }
              return acc;
            }, {})
          );
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
        setDetailError(
          error instanceof Error ? error.message : "Failed to load recording details."
        );
      } finally {
        setIsLoadingDetail(false);
      }
    },
    [applyLatestRecording]
  );

  const clearRecordingDetail = useCallback(() => {
    setSelectedRecording(null);
    setSelectedTranscript(null);
    setSpeakerNames({});
    setWaveformData([]);
    setIsLoadingDetail(false);
    setDetailError(null);
  }, []);

  useEffect(() => {
    if (!isOpen || !selectedRecording) {
      return;
    }

    let unlistenAnalysis: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    const setup = async () => {
      unlistenAnalysis = await listen<{ recordingId: string }>(
        "recording-analysis-ready",
        (event) => {
          if (event.payload?.recordingId === selectedRecording.id) {
            void refreshSelectedRecording(selectedRecording.id);
          }
        }
      );

      unlistenTitle = await listen<{
        recordingId: string;
        status: "ok" | "error";
      }>("recording-title-updated", (event) => {
        if (
          event.payload?.status === "ok" &&
          event.payload.recordingId === selectedRecording.id
        ) {
          void refreshSelectedRecording(selectedRecording.id);
        }
      });

      unlistenStatus = await listen<RecordingStatusChangedEvent>(
        "recording-status-changed",
        (event) => {
          if (event.payload?.recordingId !== selectedRecording.id) {
            return;
          }

          setSelectedRecording((current) =>
            current ? { ...current, status: event.payload.status } : current
          );

          if (
            event.payload.status === "completed" ||
            event.payload.status === "error"
          ) {
            void refreshSelectedRecording(selectedRecording.id);
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
  }, [isOpen, refreshSelectedRecording, selectedRecording]);

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
  }, [isOpen, refreshSelectedRecording, refreshTranscript, selectedRecording, selectedTranscript]);

  return {
    selectedRecording,
    setSelectedRecording,
    selectedTranscript,
    setSelectedTranscript,
    speakerNames,
    setSpeakerNames,
    waveformData,
    isLoadingDetail,
    detailError,
    loadRecordingDetail,
    refreshSelectedRecording,
    refreshTranscript,
    clearRecordingDetail,
  };
}
