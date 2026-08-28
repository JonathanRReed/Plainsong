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
import { invoke, listen } from "@/lib/electron";
import {
  type DictationStartOptions,
  startDictation,
  stopDictation,
} from "@/lib/backend/dictation";
import {
  startRecording,
  stopRecording,
} from "@/lib/backend/recordings";
import { logger } from "@/lib/logger";
import {
  describeMeetingStartFailure,
  MeetingStartError,
} from "@/lib/meeting-start-error";
import type { DictationStateChangedEvent as SharedDictationStateChangedEvent } from "@/features/dictation/runtime";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
  meetingCaptureRestarted,
  meetingPhaseIsCapturing,
  reduceMeetingLifecycleState,
  type MeetingLifecycleEvent,
  type MeetingLifecyclePhase,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";

interface RecordingState {
  isRecording: boolean;
  recordingId: string | null;
  recordingMode: "dictation" | "meeting" | null;
  duration: number;
  isSystemAudioActive: boolean;
  meetingPhase: MeetingLifecyclePhase;
  meetingMessage: string | null;
}

type RecordingOverlayState = MeetingLifecycleEvent;

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
  }) => Promise<string | null>;
  stopMeeting: () => Promise<void>;
}

const INITIAL_STATE: RecordingState = {
  isRecording: false,
  recordingId: null,
  recordingMode: null,
  duration: 0,
  isSystemAudioActive: false,
  meetingPhase: "idle",
  meetingMessage: null,
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

function lifecycleFromRecordingState(state: RecordingState): MeetingLifecycleState {
  if (state.recordingMode !== "meeting") {
    return INITIAL_MEETING_LIFECYCLE_STATE;
  }
  return {
    phase: state.meetingPhase,
    recordingId: state.recordingId,
    startedAtMs: null,
    systemAudioActive: state.isSystemAudioActive,
    consentPromptShown: false,
    message: state.meetingMessage,
  };
}

function reconcileMeetingState(
  state: RecordingState,
  event: MeetingLifecycleEvent,
): RecordingState {
  const current = lifecycleFromRecordingState(state);
  const next = reduceMeetingLifecycleState(current, event);
  if (next === current) {
    return state;
  }
  if (next.phase === "idle") {
    return INITIAL_STATE;
  }
  return {
    ...state,
    isRecording: meetingPhaseIsCapturing(next.phase),
    recordingId: next.recordingId,
    recordingMode: "meeting",
    duration: next.phase === "recording" ? state.duration : 0,
    isSystemAudioActive: next.systemAudioActive,
    meetingPhase: next.phase,
    meetingMessage: next.message,
  };
}

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

  const startDictationFn = useCallback(async (options?: DictationStartOptions) => {
    try {
      await startDictation(options);
    } catch (error) {
      logger.error("Failed to start dictation:", error);
      const message = error instanceof Error ? error.message : String(error);
      // Add actionable suggestions based on common errors
      if (message.includes("ASR provider") || message.includes("model")) {
        throw new Error(`${message}. Please check your ASR provider settings in Settings > AI & Models.`);
      }
      if (message.includes("audio") || message.includes("microphone")) {
        throw new Error(`${message}. Please check your microphone permissions in System Settings.`);
      }
      throw new Error(message);
    }
  }, []);

  const stopDictationFn = useCallback(async () => {
    try {
      const text = await stopDictation();
      clearTimer();
      setState(INITIAL_STATE);
      return text;
    } catch (error) {
      logger.error("Failed to stop dictation:", error);
      clearTimer();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timeout") || message.includes("busy")) {
        throw new Error(`${message}. Please wait a moment and try again.`);
      }
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
    }) => {
      try {
        const recordingId = await startRecording(options);
        setState((prev) =>
          prev.recordingId === recordingId && prev.meetingPhase === "recording"
            ? prev
            : reconcileMeetingState(prev, {
                phase: "recording",
                recordingId,
                systemAudioActive: options.systemAudio,
              }),
        );
        if (stateRef.current.recordingId !== recordingId) {
          startTimer();
        }
        return recordingId;
      } catch (error) {
        console.error("Failed to start meeting:", error);
        // Rethrown as the typed failure so the view can offer the one action
        // that matches the code, not just print the sentence.
        throw new MeetingStartError(describeMeetingStartFailure(error));
      }
    },
    [startTimer]
  );

  const stopMeeting = useCallback(async () => {
    const currentId = stateRef.current.recordingId;
    if (!currentId) return;

    try {
      await stopRecording(currentId);
      clearTimer();
    } catch (error) {
      logger.error("Failed to stop meeting:", error);
      clearTimer();
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) =>
        reconcileMeetingState(prev, {
          phase: "error",
          recordingId: currentId,
          message,
        }),
      );
      if (message.includes("timeout") || message.includes("busy")) {
        throw new Error(`${message}. Please wait a moment and try again.`);
      }
      throw new Error(message);
    }
  }, [clearTimer]);

  useEffect(() => {
    void invoke<RecordingOverlayState>("get_recording_overlay_state")
      .then((overlayState) => {
        if (overlayState.phase !== "idle") {
          setState((prev) => reconcileMeetingState(prev, overlayState));
        }
        if (overlayState.phase === "recording" && overlayState.recordingId) {
          startTimer(overlayState.startedAtMs);
        } else {
          clearTimer();
        }
      })
      .catch((error) => {
        logger.warn("Initial recording overlay state hydration failed:", error);
      });

    let unlistenDictation: (() => void) | undefined;
    let unlistenMeeting: (() => void) | undefined;
    let mounted = true;

    const setup = async () => {
      unlistenDictation = await listen<SharedDictationStateChangedEvent>(
        "dictation-state-changed",
        (event) => {
          if (!mounted) return;

          const payload = event.payload;
          if (payload.phase === "recording") {
            if (
              stateRef.current.recordingMode === "dictation" &&
              stateRef.current.isRecording
            ) {
              return;
            }
            setState({
              ...INITIAL_STATE,
              isRecording: true,
              recordingId: null,
              recordingMode: "dictation",
              duration: 0,
              isSystemAudioActive: false,
            });
            startTimer(payload.startedAtMs);
            return;
          }

          if (payload.phase === "primed") {
            if (
              stateRef.current.recordingMode === "dictation" &&
              stateRef.current.isRecording
            ) {
              return;
            }
            setState((prev) => ({
              ...prev,
              isRecording: true,
              recordingMode: "dictation",
              duration: 0,
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

      unlistenMeeting = await listen<MeetingLifecycleEvent>(
        "meeting-recording-state-changed",
        (event) => {
          if (!mounted) return;

          const payload = event.payload;
          const previous = lifecycleFromRecordingState(stateRef.current);
          const next = reduceMeetingLifecycleState(previous, payload);
          setState((prev) => reconcileMeetingState(prev, payload));
          // Restarting the timer on every `recording` event would zero the
          // meeting clock each time the sidecar re-emits that phase to carry a
          // mid-meeting warning. Only an actual entry into capture starts it;
          // a meeting that is still recording keeps the clock it has.
          if (meetingCaptureRestarted(previous, next)) {
            startTimer(next.startedAtMs);
          } else if (next.phase !== "recording") {
            clearTimer();
          }
        }
      );
    };

    void setup();

    return () => {
      mounted = false;
      clearTimer();
      unlistenDictation?.();
      unlistenMeeting?.();
    };
  }, [clearTimer, startTimer]);

  useEffect(() => {
    let mounted = true;
    const id = setInterval(() => {
      if (!mounted) return;

      if (stateRef.current.recordingMode === "dictation") {
        void invoke<SharedDictationStateChangedEvent>("get_dictation_overlay_state")
          .then((overlayState) => {
            if (!mounted) return;

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
                ...INITIAL_STATE,
                isRecording: true,
                recordingId: null,
                recordingMode: "dictation",
                duration: 0,
                isSystemAudioActive: false,
              });
              startTimer(overlayState.startedAtMs);
            }
          })
          .catch((error) => {
            logger.debug("Transient backend polling error:", error);
          });
        return;
      }

      if (stateRef.current.recordingMode === "meeting") {
        void invoke<RecordingOverlayState>("get_recording_overlay_state")
          .then((overlayState) => {
            if (!mounted) return;
            setState((prev) => reconcileMeetingState(prev, overlayState));
            if (overlayState.phase === "recording" && overlayState.recordingId) {
              if (
                !stateRef.current.isRecording ||
                stateRef.current.recordingId !== overlayState.recordingId
              ) {
                startTimer(overlayState.startedAtMs);
              }
              return;
            }
            clearTimer();
          })
          .catch((error) => {
            logger.debug("Transient backend polling error:", error);
          });
      }
    }, 2500);

    return () => {
      mounted = false;
      clearInterval(id);
    };
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
      startDictation: startDictationFn,
      stopDictation: stopDictationFn,
      startMeeting,
      stopMeeting,
    }),
    [formattedDuration, startDictationFn, startMeeting, state, stopDictationFn, stopMeeting]
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
