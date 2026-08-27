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
}

export interface MeetingLifecycleState {
  phase: MeetingLifecyclePhase;
  recordingId: string | null;
  startedAtMs: number | null;
  systemAudioActive: boolean;
  consentPromptShown: boolean;
  message: string | null;
}

export const INITIAL_MEETING_LIFECYCLE_STATE: MeetingLifecycleState = {
  phase: "idle",
  recordingId: null,
  startedAtMs: null,
  systemAudioActive: false,
  consentPromptShown: false,
  message: null,
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
  };
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
