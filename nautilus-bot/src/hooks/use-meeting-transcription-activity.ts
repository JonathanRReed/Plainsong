import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@/lib/electron";
import {
  emptyMeetingTranscriptionActivity,
  MEETING_TRANSCRIPTION_PROGRESS_EVENT,
  reduceMeetingTranscriptionProgress,
  reduceMeetingTranscriptionStatus,
  scopeMeetingTranscriptionActivity,
  type MeetingTranscriptionActivity,
} from "@/lib/meeting-transcription-activity";

export function useMeetingTranscriptionActivity(recordingId: string | null, processing: boolean) {
  const [state, setState] = useState(() => emptyMeetingTranscriptionActivity(recordingId, processing));
  const stateRef = useRef(state);
  const scopeRef = useRef({ recordingId, processing });
  scopeRef.current = { recordingId, processing };
  const apply = useCallback((next: MeetingTranscriptionActivity) => {
    stateRef.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    apply(scopeMeetingTranscriptionActivity(stateRef.current, recordingId, processing));
  }, [recordingId, processing, apply]);
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const subscribe = async (event: string, reduce: typeof reduceMeetingTranscriptionProgress) => {
      try {
        const unlisten = await listen(event, ({ payload }) => {
          if (disposed || scopeRef.current.recordingId !== recordingId || stateRef.current.recordingId !== recordingId) return;
          apply(reduce(stateRef.current, payload, Date.now()));
        });
        if (disposed) unlisten(); else cleanups.push(unlisten);
      } catch {
        // Missing activity leaves timing unknown; it never marks a job failed.
      }
    };
    void subscribe(MEETING_TRANSCRIPTION_PROGRESS_EVENT, reduceMeetingTranscriptionProgress);
    void subscribe("recording-status-changed", reduceMeetingTranscriptionStatus);
    return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [recordingId, apply]);
  const reset = useCallback(() => {
    apply({ ...emptyMeetingTranscriptionActivity(scopeRef.current.recordingId, scopeRef.current.processing), statusAt: stateRef.current.statusAt });
  }, [apply]);
  return {
    activity: processing && state.active && state.recordingId === recordingId ? state : null,
    reset,
  };
}
