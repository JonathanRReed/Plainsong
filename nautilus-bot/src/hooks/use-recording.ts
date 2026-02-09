import { useState, useEffect, useCallback, useRef } from "react";
import {
  startDictation as tauriStartDictation,
  stopDictation as tauriStopDictation,
  startRecording as tauriStartRecording,
  stopRecording as tauriStopRecording,
} from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

interface RecordingState {
  isRecording: boolean;
  recordingId: string | null;
  recordingMode: "dictation" | "meeting" | null;
  duration: number;
  isSystemAudioActive: boolean;
}

const INITIAL_STATE: RecordingState = {
  isRecording: false,
  recordingId: null,
  recordingMode: null,
  duration: 0,
  isSystemAudioActive: false,
};

export function useRecording() {
  const [state, setState] = useState<RecordingState>(INITIAL_STATE);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setState((prev) => ({
        ...prev,
        duration: Math.floor((Date.now() - startTime) / 1000),
      }));
    }, 1000);
  }, [clearTimer]);

  const startDictation = useCallback(async () => {
    try {
      await tauriStartDictation();
      setState({
        isRecording: true,
        recordingId: null,
        recordingMode: "dictation",
        duration: 0,
        isSystemAudioActive: false,
      });
      startTimer();
    } catch (error) {
      console.error("Failed to start dictation:", error);
    }
  }, [startTimer]);

  const stopDictation = useCallback(async () => {
    try {
      const text = await tauriStopDictation();
      clearTimer();
      setState(INITIAL_STATE);
      return text;
    } catch (error) {
      console.error("Failed to stop dictation:", error);
      clearTimer();
      return null;
    }
  }, [clearTimer]);

  const startMeeting = useCallback(
    async (options: { mic: boolean; systemAudio: boolean; projectId: string }) => {
      try {
        const recordingId = await tauriStartRecording(options);
        setState({
          isRecording: true,
          recordingId,
          recordingMode: "meeting",
          duration: 0,
          isSystemAudioActive: options.systemAudio,
        });
        startTimer();
        return recordingId;
      } catch (error) {
        console.error("Failed to start meeting:", error);
        return null;
      }
    },
    [startTimer]
  );

  const stopMeeting = useCallback(async () => {
    const currentId = stateRef.current.recordingId;
    if (!currentId) return;
    try {
      await tauriStopRecording(currentId);
      clearTimer();
      setState(INITIAL_STATE);
    } catch (error) {
      console.error("Failed to stop meeting:", error);
      clearTimer();
    }
  }, [clearTimer]);

  const formatDuration = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, []);

  // Register hotkey listeners once — use refs to avoid stale closures
  useEffect(() => {
    let unlistenPressed: (() => void) | undefined;
    let unlistenReleased: (() => void) | undefined;

    const setup = async () => {
      unlistenPressed = await listen("dictation-hotkey-pressed", () => {
        if (!stateRef.current.isRecording) {
          startDictation();
        }
      });

      unlistenReleased = await listen("dictation-hotkey-released", () => {
        const s = stateRef.current;
        if (s.isRecording && s.recordingMode === "dictation") {
          stopDictation();
        }
      });
    };

    setup();

    return () => {
      clearTimer();
      unlistenPressed?.();
      unlistenReleased?.();
    };
  }, [startDictation, stopDictation, clearTimer]);

  return {
    ...state,
    formattedDuration: formatDuration(state.duration),
    startDictation,
    stopDictation,
    startMeeting,
    stopMeeting,
  };
}
