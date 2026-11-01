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
}

export type MeetingFinalizationOutcome =
  | { status: "confirmed" }
  | { status: "timed_out" }
  | { status: "failed"; error: unknown };

const TERMINAL_PHASES = new Set<MeetingLifecyclePhase>([
  "ready",
  "error",
  "cancelled",
  "recoverable",
]);

/**
 * Which meeting the menu bar follows after a lifecycle event. A meeting that
 * has finished capturing and is only transcribing gives way to a new meeting
 * that starts capturing: otherwise the menu bar keeps showing "Finishing the
 * meeting…" with Stop disabled for the whole of the new one.
 */
export function nextActiveMeetingRecordingId(
  currentRecordingId: string | null,
  event: MeetingLifecycleEvent,
  currentPhase: MeetingLifecyclePhase | null = null,
): string | null {
  const incomingId = event.recordingId?.trim() || null;
  const phase = event.phase === "transcribing" ? "processing" : event.phase;

  if (TERMINAL_PHASES.has(phase)) {
    return !incomingId || incomingId === currentRecordingId
      ? null
      : currentRecordingId;
  }
  if (phase === "idle") {
    return null;
  }

  if (
    currentRecordingId &&
    incomingId &&
    incomingId !== currentRecordingId
  ) {
    const currentOnlyTranscribing = currentPhase === "processing";
    const incomingCaptures = phase === "preparing" || phase === "recording";
    return currentOnlyTranscribing && incomingCaptures ? incomingId : currentRecordingId;
  }
  return incomingId ?? currentRecordingId;
}

/**
 * Phase of the active meeting, for the menu bar: null once no meeting is
 * active, otherwise the phase of the latest event about the active one. The
 * recording id stays set from "preparing" through "processing", so the id
 * alone cannot say whether the microphone is actually capturing.
 */
export function nextActiveMeetingPhase(
  currentPhase: MeetingLifecyclePhase | null,
  nextActiveRecordingId: string | null,
  event: MeetingLifecycleEvent,
): MeetingLifecyclePhase | null {
  if (!nextActiveRecordingId) {
    return null;
  }
  const incomingId = event.recordingId?.trim() || null;
  if (incomingId && incomingId !== nextActiveRecordingId) {
    return currentPhase;
  }
  return event.phase === "transcribing" ? "processing" : event.phase;
}

/**
 * What to tell the reader when the background service stops under a meeting.
 * Capture stopping and transcription stopping are different losses: the
 * first ends the recording early, the second only needs the saved audio
 * transcribed again.
 */
export function interruptedMeetingMessage(phase: MeetingLifecyclePhase | null): string {
  if (phase === "processing") {
    return "Plainsong restarted while this meeting was being transcribed. The recording is saved; open the meeting to transcribe it again.";
  }
  return "Recording stopped unexpectedly because Plainsong's audio service restarted. Open the meeting to check for saved audio.";
}

export function resolveMeetingStopId(
  activeRecordingId: string | null,
  requestedRecordingId?: string | null,
): string {
  const requested = requestedRecordingId?.trim() || null;
  if (activeRecordingId && requested && activeRecordingId !== requested) {
    throw new Error(
      `Requested meeting '${requested}' does not match active meeting '${activeRecordingId}'.`,
    );
  }
  const resolved = activeRecordingId ?? requested;
  if (!resolved) {
    throw new Error("No active meeting capture to stop");
  }
  return resolved;
}

export async function finalizeMeetingWithinBudget(
  finalize: () => Promise<void>,
  timeoutMs = 6_000,
): Promise<MeetingFinalizationOutcome> {
  const timeoutFailure = Symbol("meeting-finalization-timeout");
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      finalize(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(timeoutFailure),
          timeoutMs,
        );
      }),
    ]);
    return { status: "confirmed" };
  } catch (error) {
    return error === timeoutFailure
      ? { status: "timed_out" }
      : { status: "failed", error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
