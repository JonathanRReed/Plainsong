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

export function nextActiveMeetingRecordingId(
  currentRecordingId: string | null,
  event: MeetingLifecycleEvent,
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
    return currentRecordingId;
  }
  return incomingId ?? currentRecordingId;
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
