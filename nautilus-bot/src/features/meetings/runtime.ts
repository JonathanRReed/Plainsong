export type MeetingLifecyclePhase =
  | "idle"
  | "preparing"
  | "recording"
  | "stopping"
  | "processing"
  | "ready"
  | "error"
  | "cancelled"
  | "recoverable";

export interface MeetingLifecycleEvent {
  phase: MeetingLifecyclePhase | "transcribing";
  recordingId?: string | null;
  startedAtMs?: number | null;
  systemAudioActive?: boolean | null;
  consentPromptShown?: boolean | null;
  message?: string | null;
  /**
   * Pause state, carried by the sidecar's pause/resume events and by the
   * overlay snapshot. Absent on every other event, which keeps what it had.
   */
  paused?: boolean | null;
  closedPausedMs?: number | null;
  pauseStartedAtMs?: number | null;
}

export interface MeetingLifecycleState {
  phase: MeetingLifecyclePhase;
  recordingId: string | null;
  startedAtMs: number | null;
  systemAudioActive: boolean;
  consentPromptShown: boolean;
  message: string | null;
  /** Capture is live but every frame is being dropped on purpose. */
  paused: boolean;
  /** Paused time from pauses that have ended, in milliseconds. */
  closedPausedMs: number;
  /** When the current pause began, while paused. */
  pauseStartedAtMs: number | null;
}

export const INITIAL_MEETING_LIFECYCLE_STATE: MeetingLifecycleState = {
  phase: "idle",
  recordingId: null,
  startedAtMs: null,
  systemAudioActive: false,
  consentPromptShown: false,
  message: null,
  paused: false,
  closedPausedMs: 0,
  pauseStartedAtMs: null,
};

const ACTIVE_PHASES = new Set<MeetingLifecyclePhase>([
  "preparing",
  "recording",
  "stopping",
]);
const RETAINED_TERMINAL_PHASES = new Set<MeetingLifecyclePhase>([
  "ready",
  "error",
  "cancelled",
  "recoverable",
]);

function normalizeMeetingLifecyclePhase(
  phase: MeetingLifecycleEvent["phase"],
): MeetingLifecyclePhase {
  return phase === "transcribing" ? "processing" : phase;
}

export function reduceMeetingLifecycleState(
  current: MeetingLifecycleState,
  event: MeetingLifecycleEvent,
): MeetingLifecycleState {
  const phase = normalizeMeetingLifecyclePhase(event.phase);
  const incomingId = event.recordingId?.trim() || null;

  if (
    incomingId &&
    current.recordingId &&
    incomingId !== current.recordingId &&
    ACTIVE_PHASES.has(current.phase)
  ) {
    return current;
  }
  if (phase === "idle") {
    return RETAINED_TERMINAL_PHASES.has(current.phase)
      ? current
      : INITIAL_MEETING_LIFECYCLE_STATE;
  }

  return {
    phase,
    recordingId: incomingId ?? current.recordingId,
    startedAtMs:
      typeof event.startedAtMs === "number"
        ? event.startedAtMs
        : current.startedAtMs,
    systemAudioActive:
      typeof event.systemAudioActive === "boolean"
        ? event.systemAudioActive
        : current.systemAudioActive,
    consentPromptShown:
      typeof event.consentPromptShown === "boolean"
        ? event.consentPromptShown
        : current.consentPromptShown,
    message:
      event.message === undefined ? current.message : event.message ?? null,
    ...reducePauseFields(current, event, phase, incomingId),
  };
}

/**
 * The pause fields after `event`.
 *
 * A pause belongs to one capture: entering `recording` for a different
 * meeting (or from idle) starts clean, and leaving `recording` clears it, so
 * a stale "paused" can never freeze the next meeting's clock. Within a
 * capture, only an event that carries the fields changes them.
 */
function reducePauseFields(
  current: MeetingLifecycleState,
  event: MeetingLifecycleEvent,
  phase: MeetingLifecyclePhase,
  incomingId: string | null,
): Pick<MeetingLifecycleState, "paused" | "closedPausedMs" | "pauseStartedAtMs"> {
  const sameCapture =
    phase === "recording" &&
    current.phase === "recording" &&
    (incomingId ?? current.recordingId) === current.recordingId;
  const base = sameCapture
    ? current
    : INITIAL_MEETING_LIFECYCLE_STATE;
  if (phase !== "recording") {
    return {
      paused: false,
      closedPausedMs: 0,
      pauseStartedAtMs: null,
    };
  }
  if (typeof event.paused !== "boolean") {
    return {
      paused: base.paused,
      closedPausedMs: base.closedPausedMs,
      pauseStartedAtMs: base.pauseStartedAtMs,
    };
  }
  const closedPausedMs =
    typeof event.closedPausedMs === "number" && Number.isFinite(event.closedPausedMs)
      ? Math.max(0, event.closedPausedMs)
      : base.closedPausedMs;
  const pauseStartedAtMs =
    typeof event.pauseStartedAtMs === "number" && Number.isFinite(event.pauseStartedAtMs)
      ? event.pauseStartedAtMs
      : null;
  return {
    paused: event.paused,
    closedPausedMs,
    // A paused meeting without a start stamp is paused "since now": the clock
    // freezes either way, and a later resume event carries the real total.
    pauseStartedAtMs: event.paused ? pauseStartedAtMs : null,
  };
}

/**
 * Seconds of recording so far, excluding pauses: wall clock since the start,
 * minus every finished pause, minus the current one if paused. Frozen while
 * paused. Pure so the three timers (workspace, popup, header) agree.
 */
export function meetingElapsedSeconds(
  state: Pick<
    MeetingLifecycleState,
    "startedAtMs" | "paused" | "closedPausedMs" | "pauseStartedAtMs"
  >,
  now: number,
): number {
  if (typeof state.startedAtMs !== "number" || !Number.isFinite(state.startedAtMs)) {
    return 0;
  }
  const openPauseMs =
    state.paused
      ? Math.max(0, now - (state.pauseStartedAtMs ?? now))
      : 0;
  const elapsedMs = now - state.startedAtMs - state.closedPausedMs - openPauseMs;
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

/** `mm:ss`, or `h:mm:ss` past an hour, for the elapsed readouts. */
export function formatElapsedClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mmss = `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export function meetingPhaseIsCapturing(phase: MeetingLifecyclePhase): boolean {
  return phase === "recording";
}

/**
 * Whether this reduction actually *entered* live capture, as opposed to
 * re-asserting a phase the meeting was already in.
 *
 * The sidecar re-emits `recording` mid-meeting to carry an advisory message — a
 * WAV writer that died, a disk about to fill. Those events are not a new
 * capture, and treating them as one is destructive: consumers clear the
 * transcript preview, the lost-audio counter, the visible source warning and
 * the elapsed timer when capture starts, so a warning arriving on a
 * `recording` event would wipe the very warning it came to deliver (and reset
 * the meeting clock to zero).
 *
 * A different `recordingId` still counts as entering capture: that is a
 * genuinely different meeting and its predecessor's preview must not linger.
 */
export function meetingCaptureRestarted(
  previous: MeetingLifecycleState,
  next: MeetingLifecycleState,
): boolean {
  if (next.phase !== "recording") {
    return false;
  }
  return (
    previous.phase !== "recording" || previous.recordingId !== next.recordingId
  );
}
