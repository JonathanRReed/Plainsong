import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type DictationStartOptions,
  startDictation as tauriStartDictation,
  startRecording as tauriStartRecording,
  stopDictation as tauriStopDictation,
  stopRecording as tauriStopRecording,
} from "@/lib/tauri";

interface RecordingState {
  isRecording: boolean;
  recordingId: string | null;
  recordingMode: "dictation" | "meeting" | null;
  duration: number;
  isSystemAudioActive: boolean;
}

interface DictationStateChangedEvent {
  phase: "idle" | "starting" | "recording" | "stopping" | "transcribing" | "done" | "error";
  startedAtMs?: number | null;
}

interface MeetingRecordingStateChangedEvent {
  phase: "idle" | "recording" | "transcribing" | "error";
  recordingId?: string | null;
  startedAtMs?: number | null;
  systemAudioActive?: boolean | null;
}

interface RecordingOverlayState {
  phase: "idle" | "recording" | "transcribing" | "error";
  recordingId?: string | null;
  startedAtMs?: number | null;
  systemAudioActive?: boolean | null;
}

interface RecordingContextValue extends RecordingState {
  formattedDuration: string;
  startDictation: (options?: DictationStartOptions) => Promise<void>;
  stopDictation: () => Promise<string>;
  startMeeting: (options: {
    mic: boolean;
    systemAudio: boolean;
    projectId: string;
    template?: string;
    meetingNotes?: string;
    consentPromptShown?: boolean;
  }) => Promise<string | null>;
  stopMeeting: () => Promise<void>;
}

const INITIAL_STATE: RecordingState = {
  isRecording: false,
  recordingId: null,
  recordingMode: null,
  duration: 0,
  isSystemAudioActive: false,
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RecordingState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  stateRef.current = state;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback((startedAtMs?: number | null) => {
    clearTimer();
    const startTime =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? startedAtMs
        : Date.now();
    setState((prev) => ({
      ...prev,
      duration: Math.max(0, Math.floor((Date.now() - startTime) / 1000)),
    }));
    timerRef.current = setInterval(() => {
      setState((prev) => ({
        ...prev,
        duration: Math.max(0, Math.floor((Date.now() - startTime) / 1000)),
      }));
    }, 1000);
  }, [clearTimer]);

  const startDictation = useCallback(async (options?: DictationStartOptions) => {
    try {
      await tauriStartDictation(options);
    } catch (error) {
      console.error("Failed to start dictation:", error);
    }
  }, []);

  const stopDictation = useCallback(async () => {
    try {
      const text = await tauriStopDictation();
      clearTimer();
      setState(INITIAL_STATE);
      return text;
    } catch (error) {
      console.error("Failed to stop dictation:", error);
      clearTimer();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }, [clearTimer]);

  const startMeeting = useCallback(
    async (options: {
      mic: boolean;
      systemAudio: boolean;
      projectId: string;
      template?: string;
      meetingNotes?: string;
      consentPromptShown?: boolean;
    }) => {
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
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message);
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

  useEffect(() => {
    void invoke<RecordingOverlayState>("get_recording_overlay_state")
      .then((overlayState) => {
        if (overlayState.phase === "recording" && overlayState.recordingId) {
          setState({
            isRecording: true,
            recordingId: overlayState.recordingId,
            recordingMode: "meeting",
            duration: 0,
            isSystemAudioActive: Boolean(overlayState.systemAudioActive),
          });
          startTimer(overlayState.startedAtMs);
          return;
        }

        if (overlayState.phase === "transcribing") {
          clearTimer();
          setState({
            isRecording: false,
            recordingId: overlayState.recordingId ?? null,
            recordingMode: "meeting",
            duration: 0,
            isSystemAudioActive: Boolean(overlayState.systemAudioActive),
          });
        }
      })
      .catch(() => {
        // Ignore initial hydration failures.
      });

    let unlistenDictation: (() => void) | undefined;
    let unlistenMeeting: (() => void) | undefined;

    const setup = async () => {
      unlistenDictation = await listen<DictationStateChangedEvent>(
        "dictation-state-changed",
        (event) => {
          const payload = event.payload;
          if (payload.phase === "recording") {
            setState({
              isRecording: true,
              recordingId: null,
              recordingMode: "dictation",
              duration: 0,
              isSystemAudioActive: false,
            });
            startTimer(payload.startedAtMs);
            return;
          }

          if (payload.phase === "starting") {
            setState((prev) => ({
              ...prev,
              isRecording: true,
              recordingMode: "dictation",
              isSystemAudioActive: false,
            }));
            return;
          }

          if (
            (payload.phase === "idle" ||
              payload.phase === "done" ||
              payload.phase === "error") &&
            stateRef.current.recordingMode === "dictation"
          ) {
            clearTimer();
            setState(INITIAL_STATE);
          }
        }
      );

      unlistenMeeting = await listen<MeetingRecordingStateChangedEvent>(
        "meeting-recording-state-changed",
        (event) => {
          const payload = event.payload;
          if (payload.phase === "recording" && payload.recordingId) {
            setState({
              isRecording: true,
              recordingId: payload.recordingId,
              recordingMode: "meeting",
              duration: 0,
              isSystemAudioActive: Boolean(payload.systemAudioActive),
            });
            startTimer(payload.startedAtMs);
            return;
          }

          if (payload.phase === "transcribing") {
            clearTimer();
            setState((prev) => ({
              ...prev,
              isRecording: false,
              recordingMode: "meeting",
              recordingId: payload.recordingId ?? prev.recordingId,
            }));
            return;
          }

          if (payload.phase === "idle" && stateRef.current.recordingMode === "meeting") {
            clearTimer();
            setState(INITIAL_STATE);
          }
        }
      );
    };

    void setup();

    return () => {
      clearTimer();
      unlistenDictation?.();
      unlistenMeeting?.();
    };
  }, [clearTimer, startTimer]);

  useEffect(() => {
    const id = setInterval(() => {
      if (stateRef.current.recordingMode === "dictation") {
        void invoke<DictationStateChangedEvent>("get_dictation_overlay_state")
          .then((overlayState) => {
            if (
              overlayState.phase === "idle" ||
              overlayState.phase === "done" ||
              overlayState.phase === "error"
            ) {
              clearTimer();
              setState(INITIAL_STATE);
              return;
            }

            if (overlayState.phase === "recording" && !stateRef.current.isRecording) {
              setState({
                isRecording: true,
                recordingId: null,
                recordingMode: "dictation",
                duration: 0,
                isSystemAudioActive: false,
              });
              startTimer(overlayState.startedAtMs);
            }
          })
          .catch(() => {
            // Ignore transient backend polling issues.
          });
        return;
      }

      if (stateRef.current.recordingMode === "meeting") {
        void invoke<RecordingOverlayState>("get_recording_overlay_state")
          .then((overlayState) => {
            if (overlayState.phase === "idle" || overlayState.phase === "error") {
              clearTimer();
              setState(INITIAL_STATE);
              return;
            }

            if (overlayState.phase === "recording" && overlayState.recordingId) {
              if (!stateRef.current.isRecording || stateRef.current.recordingId !== overlayState.recordingId) {
                setState({
                  isRecording: true,
                  recordingId: overlayState.recordingId,
                  recordingMode: "meeting",
                  duration: 0,
                  isSystemAudioActive: Boolean(overlayState.systemAudioActive),
                });
                startTimer(overlayState.startedAtMs);
              }
              return;
            }

            if (overlayState.phase === "transcribing") {
              clearTimer();
              setState((prev) => ({
                ...prev,
                isRecording: false,
                recordingMode: "meeting",
                recordingId: overlayState.recordingId ?? prev.recordingId,
              }));
            }
          })
          .catch(() => {
            // Ignore transient backend polling issues.
          });
      }
    }, 2500);

    return () => clearInterval(id);
  }, [clearTimer, startTimer]);

  const formattedDuration = useMemo(() => {
    const mins = Math.floor(state.duration / 60);
    const secs = state.duration % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [state.duration]);

  const value = useMemo<RecordingContextValue>(
    () => ({
      ...state,
      formattedDuration,
      startDictation,
      stopDictation,
      startMeeting,
      stopMeeting,
    }),
    [formattedDuration, startDictation, startMeeting, state, stopDictation, stopMeeting]
  );

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording() {
  const context = useContext(RecordingContext);
  if (!context) {
    throw new Error("useRecording must be used within RecordingProvider");
  }
  return context;
}
