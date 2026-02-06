import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface RecordingState {
  isRecording: boolean;
  recordingId: string | null;
  recordingMode: "dictation" | "meeting" | null;
  duration: number;
  isSystemAudioActive: boolean;
}

export function useRecording() {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    recordingId: null,
    recordingMode: null,
    duration: 0,
    isSystemAudioActive: false,
  });
  const [timer, setTimer] = useState<NodeJS.Timeout | null>(null);

  const startTimer = useCallback(() => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      setState((prev) => ({
        ...prev,
        duration: Math.floor((Date.now() - startTime) / 1000),
      }));
    }, 1000);
    setTimer(interval);
  }, []);

  const stopTimer = useCallback(() => {
    if (timer) {
      clearInterval(timer);
      setTimer(null);
    }
  }, [timer]);

  const startDictation = useCallback(async () => {
    try {
      await invoke("start_dictation");
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
      const text = await invoke<string>("stop_dictation");
      stopTimer();
      setState({
        isRecording: false,
        recordingId: null,
        recordingMode: null,
        duration: 0,
        isSystemAudioActive: false,
      });
      return text;
    } catch (error) {
      console.error("Failed to stop dictation:", error);
      stopTimer();
      return null;
    }
  }, [stopTimer]);

  const startMeeting = useCallback(
    async (options: { mic: boolean; systemAudio: boolean; projectId: string }) => {
      try {
        const recordingId = await invoke<string>("start_recording", {
          options,
        });
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
    if (!state.recordingId) return;
    try {
      await invoke("stop_recording", { recordingId: state.recordingId });
      stopTimer();
      setState({
        isRecording: false,
        recordingId: null,
        recordingMode: null,
        duration: 0,
        isSystemAudioActive: false,
      });
    } catch (error) {
      console.error("Failed to stop meeting:", error);
      stopTimer();
    }
  }, [state.recordingId, stopTimer]);

  const formatDuration = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, []);

  useEffect(() => {
    // Listen for global hold-to-record hotkey lifecycle.
    let unlistenPressed: (() => void) | undefined;
    let unlistenReleased: (() => void) | undefined;
    
    const setupListener = async () => {
      unlistenPressed = await listen("dictation-hotkey-pressed", () => {
        if (!state.isRecording) {
          startDictation();
        }
      });

      unlistenReleased = await listen("dictation-hotkey-released", () => {
        if (state.isRecording && state.recordingMode === "dictation") {
          stopDictation();
        }
      });
    };
    
    setupListener();
    
    return () => {
      if (timer) {
        clearInterval(timer);
      }
      unlistenPressed?.();
      unlistenReleased?.();
    };
  }, [timer, state.isRecording, state.recordingMode, startDictation, stopDictation]);

  return {
    ...state,
    formattedDuration: formatDuration(state.duration),
    startDictation,
    stopDictation,
    startMeeting,
    stopMeeting,
  };
}
