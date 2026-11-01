import type { MeetingMicrophoneInput } from "@/lib/meeting-microphone-input";
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
  pauseRecording,
  resumeRecording,
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
  meetingElapsedSeconds,
  meetingPhaseIsCapturing,
  reduceMeetingLifecycleState,
  type MeetingLifecycleEvent,
  type MeetingLifecyclePhase,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";
import {
  createRecordingClock,
  formatRecordingClock,
  useRecordingClockValue,
  type RecordingClock,
} from "@/hooks/recording-clock";

interface RecordingState {
  isRecording: boolean;
  recordingId: string | null;
  recordingMode: "dictation" | "meeting" | null;
  isSystemAudioActive: boolean;
  meetingPhase: MeetingLifecyclePhase;
  meetingMessage: string | null;
  meetingMicrophoneInput?: MeetingMicrophoneInput | null;
  meetingMicrophoneWarningDismissed?: boolean;
  /** Pause state of the live meeting; the clock below is derived from it. */
  meetingPaused: boolean;
  meetingClosedPausedMs: number;
  meetingPauseStartedAtMs: number | null;
  /** When the live capture began, for a clock that excludes pauses. */
  meetingStartedAtMs: number | null;
}

interface RecordingSessionOwnership {
  mode: "dictation" | "meeting";
  id: number | string | null;
}

type RecordingOverlayState = MeetingLifecycleEvent;

/**
 * Everything about the capture except its clock. Stable between ticks: it
 * changes only when the capture itself changes (starts, pauses, stops).
 */
interface RecordingSessionValue extends RecordingState {
  startDictation: (options?: DictationStartOptions) => Promise<void>;
  stopDictation: () => Promise<string>;
  startMeeting: (options: {
    mic: boolean;
    systemAudio: boolean;
    projectId: string;
    template?: string;
    meetingNotes?: string;
    /** The detected call whose offer this capture answers, if any. */
    detectedCallId?: number;
    /** The conferencing service the meeting is on, when something knew it. */
    videoService?: string;
    joinConferenceUrl?: string;
    onJoinFailure?: () => void;
  }) => Promise<string | null>;
  stopMeeting: () => Promise<void>;
  /** Pause the live meeting: capture stays open, nothing is kept until resume. */
  pauseMeeting: () => Promise<void>;
  resumeMeeting: () => Promise<void>;
}

interface RecordingContextValue extends RecordingSessionValue {
  duration: number;
  formattedDuration: string;
}

const INITIAL_STATE: RecordingState = {
  isRecording: false,
  recordingId: null,
  recordingMode: null,
  isSystemAudioActive: false,
  meetingPhase: "idle",
  meetingMessage: null,
  meetingMicrophoneInput: null,
  meetingMicrophoneWarningDismissed: false,
  meetingPaused: false,
  meetingClosedPausedMs: 0,
  meetingPauseStartedAtMs: null,
  meetingStartedAtMs: null,
};

const RecordingContext = createContext<RecordingSessionValue | null>(null);
const RecordingClockContext = createContext<RecordingClock | null>(null);

function lifecycleFromRecordingState(state: RecordingState): MeetingLifecycleState {
  if (state.recordingMode !== "meeting") {
    return INITIAL_MEETING_LIFECYCLE_STATE;
  }
  return {
    phase: state.meetingPhase,
    recordingId: state.recordingId,
    startedAtMs: state.meetingStartedAtMs,
    systemAudioActive: state.isSystemAudioActive,
    consentPromptShown: false,
    message: state.meetingMessage,
    microphoneInput: state.meetingMicrophoneInput ?? null,
    microphoneWarningDismissed: state.meetingMicrophoneWarningDismissed ?? false,
    paused: state.meetingPaused,
    closedPausedMs: state.meetingClosedPausedMs,
    pauseStartedAtMs: state.meetingPauseStartedAtMs,
  };
}

function canAcceptDictationEvent(
  state: RecordingState,
  owner: RecordingSessionOwnership | null,
  sessionId: number | null | undefined,
  phase: SharedDictationStateChangedEvent["phase"],
): boolean {
  if (
    state.recordingMode === "meeting" &&
    ["preparing", "recording", "stopping"].includes(state.meetingPhase)
  ) {
    return false;
  }
  const terminal = phase === "idle" || phase === "done" || phase === "error";
  if (
    terminal &&
    state.recordingMode === "dictation" &&
    owner?.mode === "dictation" &&
    owner.id != null &&
    sessionId != null &&
    owner.id !== sessionId
  ) {
    return false;
  }
  if (
    !terminal &&
    state.recordingMode === "dictation" &&
    state.isRecording &&
    owner?.mode === "dictation" &&
    owner.id != null &&
    sessionId != null &&
    typeof owner.id === "number" &&
    sessionId < owner.id
  ) {
    return false;
  }
  return true;
}

function canApplyMeetingStartAcknowledgement(
  state: RecordingState,
  recordingId: string,
): boolean {
  if (state.recordingMode === null) return true;
  if (state.recordingMode !== "meeting") {
    return false;
  }
  if (state.recordingId !== recordingId) {
    return !["preparing", "recording", "stopping", "processing"].includes(
      state.meetingPhase,
    );
  }
  return state.meetingPhase === "preparing" || state.meetingPhase === "recording";
}

function reconcileMeetingState(
  state: RecordingState,
  event: MeetingLifecycleEvent,
): RecordingState {
  const current = lifecycleFromRecordingState(state);
  const next = reduceMeetingLifecycleState(current, event);
  // The overlay poll repeats the same snapshot every few seconds; an
  // unchanged answer must not hand every consumer a new context value.
  if (
    next === current ||
    (Object.keys(next) as (keyof MeetingLifecycleState)[]).every((key) =>
      Object.is(next[key], current[key]),
    )
  ) {
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
    isSystemAudioActive: next.systemAudioActive,
    meetingPhase: next.phase,
    meetingMessage: next.message,
    meetingMicrophoneInput: next.microphoneInput ?? null,
    meetingMicrophoneWarningDismissed: next.microphoneWarningDismissed ?? false,
    meetingPaused: next.paused,
    meetingClosedPausedMs: next.closedPausedMs,
    meetingPauseStartedAtMs: next.pauseStartedAtMs,
    meetingStartedAtMs: next.startedAtMs,
  };
}

/** The clock, from the state it is derived from: frozen while paused. */
function meetingDurationFrom(state: RecordingState, startTime: number, now: number): number {
  if (state.recordingMode !== "meeting") {
    return Math.max(0, Math.floor((now - startTime) / 1000));
  }
  return meetingElapsedSeconds(
    {
      startedAtMs: state.meetingStartedAtMs ?? startTime,
      paused: state.meetingPaused,
      closedPausedMs: state.meetingClosedPausedMs,
      pauseStartedAtMs: state.meetingPauseStartedAtMs,
    },
    now,
  );
}

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RecordingState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerStartRef = useRef<number | null>(null);
  const sessionOwnershipRef = useRef<RecordingSessionOwnership | null>(null);
  const pendingMeetingStopsRef = useRef(new Map<string, Promise<void>>());
  const pendingMeetingPausesRef = useRef(new Map<string, Promise<void>>());
  const clockRef = useRef<RecordingClock | null>(null);
  if (!clockRef.current) {
    clockRef.current = createRecordingClock();
  }
  const clock = clockRef.current;
  stateRef.current = state;

  const clearTimer = useCallback(() => {
    timerStartRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const claimSession = useCallback(
    (mode: RecordingSessionOwnership["mode"], id: RecordingSessionOwnership["id"]) => {
      const current = sessionOwnershipRef.current;
      if (current?.mode === mode && current.id === id) return current;
      const next = { mode, id };
      sessionOwnershipRef.current = next;
      return next;
    },
    [],
  );

  // A stopped timer leaves the last reading on the clock, as it always has.
  const tick = useCallback(() => {
    const startTime = timerStartRef.current;
    if (startTime === null) return;
    clock.set(meetingDurationFrom(stateRef.current, startTime, Date.now()));
  }, [clock]);

  const startTimer = useCallback((startedAtMs?: number | null) => {
    clearTimer();
    const startTime =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? startedAtMs
        : Date.now();
    timerStartRef.current = startTime;
    setState((prev) => ({
      ...prev,
      meetingStartedAtMs:
        prev.recordingMode === "meeting" ? prev.meetingStartedAtMs ?? startTime : prev.meetingStartedAtMs,
    }));
    tick();
    timerRef.current = setInterval(tick, 1000);
  }, [clearTimer, tick]);

  // Re-read the clock whenever the capture changes, so a pause freezes it and
  // a new capture starts it from the state that was just committed. Outside a
  // live capture it reads zero.
  useEffect(() => {
    const live =
      state.recordingMode === "dictation"
        ? state.isRecording
        : state.meetingPhase === "recording";
    if (!live) {
      clock.set(0);
      return;
    }
    tick();
  }, [clock, state, tick]);

  const applyMeetingLifecycle = useCallback((event: MeetingLifecycleEvent) => {
    const current = stateRef.current;
    // A dictation owns the session while it runs. An earlier meeting that
    // finishes transcribing meanwhile must not turn it into a stopped
    // meeting: the dictation UI went idle mid-sentence, and when the
    // dictation ended the meeting's own outcome was wiped as well. A new
    // capture cannot start during dictation, so only post-capture phases
    // arrive here, and the meeting list still hears them on its own.
    if (current.recordingMode === "dictation") {
      const phase = event.phase === "transcribing" ? "processing" : event.phase;
      if (phase !== "preparing" && phase !== "recording") return;
    }
    const previous = lifecycleFromRecordingState(current);
    const next = reduceMeetingLifecycleState(previous, event);
    if (next === previous) return;
    const nextState = reconcileMeetingState(current, event);
    if (nextState === current) return;
    if (next.phase !== "idle") claimSession("meeting", next.recordingId);
    // Later events in the same batch must reconcile against this accepted state.
    stateRef.current = nextState;
    setState(nextState);
    if (meetingCaptureRestarted(previous, next)) {
      startTimer(next.startedAtMs);
    } else if (next.phase !== "recording") {
      clearTimer();
    }
  }, [claimSession, clearTimer, startTimer]);

  const startDictationFn = useCallback(async (options?: DictationStartOptions) => {
    try {
      await startDictation(options);
    } catch (error) {
      logger.error("Failed to start dictation:", error);
      const message = error instanceof Error ? error.message : String(error);
      // Add actionable suggestions based on common errors
      if (message.includes("ASR provider") || message.includes("model")) {
        throw new Error(`${message}. Check the speech model in Settings > Models.`);
      }
      if (message.includes("audio") || message.includes("microphone")) {
        throw new Error(`${message}. Please check your microphone permissions in System Settings.`);
      }
      throw new Error(message);
    }
  }, []);

  const stopDictationFn = useCallback(async () => {
    const stoppedSession = sessionOwnershipRef.current;
    try {
      const text = await stopDictation();
      if (sessionOwnershipRef.current === stoppedSession) {
        sessionOwnershipRef.current = null;
        clearTimer();
        setState(INITIAL_STATE);
      }
      return text;
    } catch (error) {
      logger.error("Failed to stop dictation:", error);
      if (sessionOwnershipRef.current === stoppedSession) {
        clearTimer();
      }
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
      detectedCallId?: number;
      videoService?: string;
      joinConferenceUrl?: string;
      onJoinFailure?: () => void;
    }) => {
      try {
        const ownerBeforeStart = sessionOwnershipRef.current;
        const recordingId = await startRecording(options);
        const ownerAfterStart = sessionOwnershipRef.current;
        if (
          ownerAfterStart !== ownerBeforeStart &&
          !(ownerAfterStart?.mode === "meeting" && ownerAfterStart.id === recordingId)
        ) {
          return null;
        }
        if (!canApplyMeetingStartAcknowledgement(stateRef.current, recordingId)) {
          return null;
        }
        claimSession("meeting", recordingId);
        const current = stateRef.current;
        const nextState = current.recordingId === recordingId && current.meetingPhase === "recording"
          ? current
          : reconcileMeetingState(current, {
              phase: "recording",
              recordingId,
              systemAudioActive: options.systemAudio,
            });
        // A lifecycle event can arrive in the same batch as this acknowledgement.
        // Let it reconcile against the accepted start rather than stale idle state.
        stateRef.current = nextState;
        setState(nextState);
        if (current.recordingId !== recordingId) {
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
    [claimSession, startTimer]
  );

  const setMeetingPaused = useCallback((paused: boolean) => {
    const captureState = stateRef.current;
    const currentId = captureState.recordingId;
    if (!currentId || captureState.recordingMode !== "meeting" ||
        captureState.meetingPhase !== "recording" || pendingMeetingStopsRef.current.has(currentId)) return Promise.resolve();
    const pending = pendingMeetingPausesRef.current.get(currentId);
    if (pending) return pending;
    const owner = sessionOwnershipRef.current;
    // The sidecar answers with the ledger and also broadcasts the lifecycle
    // event every window renders from; applying the answer here only closes
    // the gap before that event lands.
    const request = Promise.resolve().then(async () => {
      const snapshot = paused
        ? await pauseRecording(currentId)
        : await resumeRecording(currentId);
      setState((prev) => {
        // A newer lifecycle update takes precedence over this response.
        if (prev !== captureState || sessionOwnershipRef.current !== owner || prev.recordingId !== currentId ||
            prev.recordingMode !== "meeting" || prev.meetingPhase !== "recording") return prev;
        return reconcileMeetingState(prev, {
          phase: "recording",
          recordingId: currentId,
          paused: snapshot.paused,
          closedPausedMs: snapshot.closedPausedMs,
          pauseStartedAtMs: snapshot.pauseStartedAtMs,
        });
      });
    }).finally(() => { pendingMeetingPausesRef.current.delete(currentId); });
    pendingMeetingPausesRef.current.set(currentId, request);
    return request;
  }, []);

  const pauseMeeting = useCallback(() => setMeetingPaused(true), [setMeetingPaused]);
  const resumeMeeting = useCallback(() => setMeetingPaused(false), [setMeetingPaused]);

  const stopMeeting = useCallback(() => {
    const currentId = stateRef.current.recordingId;
    if (!currentId || stateRef.current.recordingMode !== "meeting") return Promise.resolve();
    const pending = pendingMeetingStopsRef.current.get(currentId);
    if (pending) return pending;
    const owner = sessionOwnershipRef.current;
    const request = Promise.resolve().then(async () => {
      try {
        await stopRecording(currentId);
        if (sessionOwnershipRef.current === owner) clearTimer();
      } catch (error) {
        // A rejected request does not establish that capture stopped.
        // Lifecycle events own the capture state and clock.
        logger.error("Failed to stop meeting:", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("timeout") || message.includes("busy")) {
          throw new Error(`${message}. Please wait a moment and try again.`);
        }
        throw new Error(message);
      } finally {
        pendingMeetingStopsRef.current.delete(currentId);
      }
    });
    pendingMeetingStopsRef.current.set(currentId, request);
    return request;
  }, [clearTimer]);

  useEffect(() => {
    let mounted = true;
    const hydrationOwner = sessionOwnershipRef.current;
    void invoke<RecordingOverlayState>("get_recording_overlay_state")
      .then((overlayState) => {
        if (!mounted || sessionOwnershipRef.current !== hydrationOwner) return;
        applyMeetingLifecycle(overlayState);
      })
      .catch((error) => {
        logger.warn("Initial recording overlay state hydration failed:", error);
      });

    let unlistenDictation: (() => void) | undefined;
    let unlistenMeeting: (() => void) | undefined;

    const setup = async () => {
      unlistenDictation = await listen<SharedDictationStateChangedEvent>(
        "dictation-state-changed",
        (event) => {
          if (!mounted) return;

          const payload = event.payload;
          if (
            !canAcceptDictationEvent(
              stateRef.current,
              sessionOwnershipRef.current,
              payload.sessionId,
              payload.phase,
            )
          ) {
            return;
          }
          if (payload.phase === "recording") {
            const previousOwner = sessionOwnershipRef.current;
            const nextOwner = claimSession("dictation", payload.sessionId ?? null);
            if (
              previousOwner === nextOwner &&
              stateRef.current.recordingMode === "dictation" &&
              stateRef.current.isRecording &&
              timerStartRef.current !== null
            ) {
              return;
            }
            const nextState: RecordingState = {
              ...INITIAL_STATE,
              isRecording: true,
              recordingId: null,
              recordingMode: "dictation",
              isSystemAudioActive: false,
            };
            stateRef.current = nextState;
            setState(nextState);
            startTimer(payload.startedAtMs);
            return;
          }

          if (payload.phase === "primed") {
            claimSession("dictation", payload.sessionId ?? null);
            if (
              stateRef.current.recordingMode === "dictation" &&
              stateRef.current.isRecording
            ) {
              return;
            }
            const nextState: RecordingState = {
              ...stateRef.current,
              isRecording: true,
              recordingMode: "dictation",
              isSystemAudioActive: false,
            };
            stateRef.current = nextState;
            setState(nextState);
            return;
          }

          if (
            (payload.phase === "idle" ||
              payload.phase === "done" ||
              payload.phase === "error") &&
            stateRef.current.recordingMode === "dictation"
          ) {
            clearTimer();
            stateRef.current = INITIAL_STATE;
            setState(INITIAL_STATE);
          }
        }
      );

      unlistenMeeting = await listen<MeetingLifecycleEvent>(
        "meeting-recording-state-changed",
        (event) => {
          if (!mounted) return;

          applyMeetingLifecycle(event.payload);
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
  }, [applyMeetingLifecycle, claimSession, clearTimer, startTimer]);

  useEffect(() => {
    let mounted = true;
    const id = setInterval(() => {
      if (!mounted) return;

      if (stateRef.current.recordingMode === "dictation") {
        const polledSession = sessionOwnershipRef.current;
        void invoke<SharedDictationStateChangedEvent>("get_dictation_overlay_state")
          .then((overlayState) => {
            if (!mounted || sessionOwnershipRef.current !== polledSession) return;
            if (
              !canAcceptDictationEvent(
                stateRef.current,
                sessionOwnershipRef.current,
                overlayState.sessionId,
                overlayState.phase,
              )
            ) {
              return;
            }

            if (
              overlayState.phase === "idle" ||
              overlayState.phase === "done" ||
              overlayState.phase === "error"
            ) {
              clearTimer();
              setState(INITIAL_STATE);
              return;
            }

            if (overlayState.phase === "recording") {
              const previousOwner = sessionOwnershipRef.current;
              const nextOwner = claimSession("dictation", overlayState.sessionId ?? null);
              if (
                previousOwner !== nextOwner ||
                !stateRef.current.isRecording ||
                timerStartRef.current === null
              ) {
                setState({
                  ...INITIAL_STATE,
                  isRecording: true,
                  recordingId: null,
                  recordingMode: "dictation",
                  isSystemAudioActive: false,
                });
                startTimer(overlayState.startedAtMs);
              }
            }
          })
          .catch((error) => {
            logger.debug("Transient backend polling error:", error);
          });
        return;
      }

      if (stateRef.current.recordingMode === "meeting") {
        const polledSession = sessionOwnershipRef.current;
        void invoke<RecordingOverlayState>("get_recording_overlay_state")
          .then((overlayState) => {
            if (!mounted || sessionOwnershipRef.current !== polledSession) return;
            applyMeetingLifecycle(overlayState);
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
  }, [applyMeetingLifecycle, claimSession, clearTimer, startTimer]);

  const value = useMemo<RecordingSessionValue>(
    () => ({
      ...state,
      startDictation: startDictationFn,
      stopDictation: stopDictationFn,
      startMeeting,
      stopMeeting,
      pauseMeeting,
      resumeMeeting,
    }),
    [
      pauseMeeting,
      resumeMeeting,
      startDictationFn,
      startMeeting,
      state,
      stopDictationFn,
      stopMeeting,
    ]
  );

  return (
    <RecordingContext.Provider value={value}>
      <RecordingClockContext.Provider value={clock}>{children}</RecordingClockContext.Provider>
    </RecordingContext.Provider>
  );
}

/**
 * The capture without its clock. Does not re-render while the clock ticks;
 * show the time with `RecordingDurationText`.
 */
export function useRecordingSession(): RecordingSessionValue {
  const context = useContext(RecordingContext);
  if (!context) {
    throw new Error("useRecording must be used within RecordingProvider");
  }
  return context;
}

/** Seconds of live capture. Re-renders the caller once a second. */
function useRecordingDuration(): number {
  const clock = useContext(RecordingClockContext);
  if (!clock) {
    throw new Error("useRecordingDuration must be used within RecordingProvider");
  }
  return useRecordingClockValue(clock);
}

/** The live clock as mm:ss, re-rendering only this text. */
export function RecordingDurationText() {
  return <>{formatRecordingClock(useRecordingDuration())}</>;
}

/**
 * The capture with its clock, for callers that have not moved to
 * `useRecordingSession`. Re-renders the caller on every tick.
 */
export function useRecording(): RecordingContextValue {
  const session = useRecordingSession();
  const duration = useRecordingDuration();
  return useMemo(
    () => ({ ...session, duration, formattedDuration: formatRecordingClock(duration) }),
    [session, duration],
  );
}
