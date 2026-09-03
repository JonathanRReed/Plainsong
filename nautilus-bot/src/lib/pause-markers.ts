/**
 * Where the transcript timeline says "[Paused 2 min 10 s]".
 *
 * The saved audio does not contain the pauses, so the transcript's timestamps
 * run straight through them. Each span records the audio offset at which it
 * began (`atSeconds`); a marker goes in front of the first speaker turn that
 * starts at or after that offset, or after the last turn when the pause was
 * at the very end. Pure, so the placement is testable without a viewer.
 */

import type { PauseSpan } from "@/types";

export interface PauseMarker {
  /** Index of the speaker turn the marker precedes; `groups.length` means "after the last". */
  beforeGroupIndex: number;
  /** Where in the audio the pause sat. */
  atSeconds: number;
  durationMs: number;
  label: string;
}

/** "2 min 10 s", "45 s", "1 h 2 min"; under a second is "under 1 s". */
export function formatPauseDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 1) return "under 1 s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 && hours === 0) parts.push(`${seconds} s`);
  return parts.join(" ");
}

export function pauseSpanDurationMs(span: PauseSpan): number {
  if (typeof span.endedAtMs !== "number") return 0;
  return Math.max(0, span.endedAtMs - span.startedAtMs);
}

/**
 * Markers for `spans` against speaker turns whose first segment starts at
 * `groupStartTimes[i]` seconds. Spans that never ended (a stop while paused
 * closes them, so this is only a malformed record) are skipped rather than
 * shown with an invented length.
 */
export function placePauseMarkers(
  groupStartTimes: readonly number[],
  spans: readonly PauseSpan[] | null | undefined,
): PauseMarker[] {
  if (!spans || spans.length === 0) return [];
  const markers: PauseMarker[] = [];
  for (const span of spans) {
    const durationMs = pauseSpanDurationMs(span);
    if (typeof span.endedAtMs !== "number" || !Number.isFinite(span.atSeconds)) continue;
    const atSeconds = Math.max(0, span.atSeconds);
    let beforeGroupIndex = groupStartTimes.findIndex((start) => start >= atSeconds);
    if (beforeGroupIndex === -1) beforeGroupIndex = groupStartTimes.length;
    markers.push({
      beforeGroupIndex,
      atSeconds,
      durationMs,
      label: `Paused ${formatPauseDuration(durationMs)}`,
    });
  }
  markers.sort((a, b) => a.atSeconds - b.atSeconds);
  return markers;
}
