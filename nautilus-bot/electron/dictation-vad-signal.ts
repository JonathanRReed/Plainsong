/**
 * Which `dictation-vad-signal` events stop the live session, and how.
 *
 * Two of the sidecar's signals end capture on their own:
 *
 * - `silence_stop`: sustained silence after speech (the auto-stop gate).
 * - `max_duration_stop`: the session hit the maximum dictation length and the
 *   sidecar has ALREADY stopped storing audio. Before this was handled the pill
 *   kept saying "Listening" past the ceiling, the user kept talking into a
 *   microphone that was no longer recorded, and nothing was delivered until
 *   they pressed Stop themselves. It now takes the same stop path as a manual
 *   stop, so the words captured so far are delivered (and the sidecar's
 *   truncation warning is shown) the moment capture ends.
 *
 * Both are scoped to the session that emitted them: a late signal from a
 * finished session must not stop a newer one.
 */
export type DictationVadStop = {
  stopReason: "auto_stop_silence" | "max_duration";
  sessionId: number | null;
};

const STOP_REASONS: Record<string, DictationVadStop["stopReason"]> = {
  silence_stop: "auto_stop_silence",
  max_duration_stop: "max_duration",
};

export function resolveDictationVadStop(
  payload: unknown,
  current: { phase: string; sessionId: number | null },
): DictationVadStop | null {
  if (!payload || typeof payload !== "object") return null;
  const { signal, sessionId } = payload as { signal?: unknown; sessionId?: unknown };
  const stopReason = typeof signal === "string" ? STOP_REASONS[signal] : undefined;
  if (!stopReason) return null;
  // Only a session that is still recording can be stopped this way; one that
  // is already finishing went through another stop path first.
  if (current.phase !== "recording") return null;
  const payloadSessionId = typeof sessionId === "number" ? sessionId : null;
  if (
    payloadSessionId !== null &&
    current.sessionId !== null &&
    payloadSessionId !== current.sessionId
  ) {
    return null;
  }
  return { stopReason, sessionId: payloadSessionId };
}
