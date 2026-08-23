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
