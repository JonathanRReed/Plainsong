/**
 * The renderer half of the meeting-analysis retry contract.
 *
 * Two facts live here, and they are not the same fact:
 *
 *  - `meeting-analysis-status` is what is happening *now*, in this session.
 *  - the recording's own analysis-failure field is what happened *last time*,
 *    and survives a relaunch. It is the one that matters, because the failure
 *    users hit is discovered hours later, in a list.
 *
 * Both are read defensively. The sidecar half of this contract ships beside
 * this change, and a build where it is absent must degrade to today's
 * behaviour — no banner, no retry button — rather than render a claim about a
 * field that does not exist.
 */

import type { Recording } from "@/types";

export const MEETING_ANALYSIS_STATUS_EVENT = "meeting-analysis-status";

export type MeetingAnalysisPhase = "running" | "failed" | "completed";

export interface MeetingAnalysisStatusEvent {
  recordingId: string;
  phase: MeetingAnalysisPhase;
  error?: string | null;
}

const PHASES: readonly MeetingAnalysisPhase[] = [
  "running",
  "failed",
  "completed",
];

/**
 * Read one event, or null when the payload is not the shape this contract
 * promises. An unrecognized phase is discarded rather than guessed at.
 */
export function parseMeetingAnalysisStatus(
  payload: unknown,
): MeetingAnalysisStatusEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const recordingId =
    typeof record.recordingId === "string" ? record.recordingId.trim() : "";
  const phase = record.phase;
  if (
    !recordingId ||
    typeof phase !== "string" ||
    !PHASES.includes(phase as MeetingAnalysisPhase)
  ) {
    return null;
  }
  const error =
    typeof record.error === "string" && record.error.trim()
      ? record.error.trim()
      : null;
  return { recordingId, phase: phase as MeetingAnalysisPhase, error };
}

/**
 * Field names the sidecar could plausibly serialize the stored failure under.
 *
 * Recordings are serialized `rename_all = "camelCase"`, so camelCase is the
 * expected shape; the snake_case spellings are read as well because a wrong
 * guess here would silently restore the exact silence this change exists to
 * remove, and reading one extra key costs nothing.
 */
const ANALYSIS_ERROR_KEYS = [
  "analysisError",
  "analysis_error",
  "analysisFailure",
  "analysis_failure",
  "analysisFailureReason",
  "analysis_failure_reason",
  "lastAnalysisError",
  "last_analysis_error",
] as const;

/**
 * The stored reason a meeting's notes were never written, or null when there
 * is none — including when the field is absent because the sidecar half of the
 * contract has not landed.
 */
export function readStoredAnalysisFailure(
  recording: Pick<Recording, "id"> | null | undefined,
): string | null {
  if (!recording) {
    return null;
  }
  const record = recording as unknown as Record<string, unknown>;
  for (const key of ANALYSIS_ERROR_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    // A structured `{ message }` is as plausible as a bare string.
    if (value && typeof value === "object") {
      const message = (value as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }
  return null;
}

export interface MeetingAnalysisNotice {
  title: string;
  message: string;
  /** Whether a retry is worth offering — false while one is already running. */
  retryable: boolean;
  busy: boolean;
}

/**
 * Turn the stored failure and the live phase into one line of copy.
 *
 * The live phase wins while it is saying something: a retry that is running is
 * more current than the failure it is trying to clear.
 */
export function describeMeetingAnalysis(args: {
  storedFailure: string | null;
  livePhase: MeetingAnalysisPhase | null;
  liveError: string | null;
}): MeetingAnalysisNotice | null {
  if (args.livePhase === "running") {
    return {
      title: "Writing meeting notes",
      message: "Plainsong is generating the summary and action items again.",
      retryable: false,
      busy: true,
    };
  }
  if (args.livePhase === "completed") {
    return null;
  }

  const reason = args.liveError ?? args.storedFailure;
  if (args.livePhase !== "failed" && !reason) {
    return null;
  }

  return {
    title: "Meeting notes were not written",
    message:
      reason ??
      "The summary and action items failed and no reason was recorded.",
    retryable: true,
    busy: false,
  };
}
