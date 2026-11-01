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
import { plainMeetingNotesFailure } from "@/lib/meeting-ui-message";

export const MEETING_ANALYSIS_STATUS_EVENT = "meeting-analysis-status";

export type MeetingAnalysisPhase =
  | "running"
  | "waiting"
  | "failed"
  | "completed";

export interface MeetingAnalysisStatusEvent {
  recordingId: string;
  phase: MeetingAnalysisPhase;
  error?: string | null;
}

const PHASES: readonly MeetingAnalysisPhase[] = [
  "running",
  "waiting",
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
  /** Plainsong will try again by itself; the wait can be stopped. */
  waiting: boolean;
}

/**
 * The sidecar's stored notice for notes that are waiting for the built-in
 * model to get enough memory (`analysis::MEMORY_WAIT_NOTICE`).
 */
export const MEMORY_WAIT_NOTICE = "Notes will be written when memory frees up.";
const MEMORY_WAIT_TITLE = "Notes will be written when you step away or memory frees up.";

function localProcessingIsPaused(reason: string | null): boolean {
  return Boolean(reason && (
    reason.includes("An earlier Ollama request may still be running. Local processing is paused because its completion could not be confirmed.") ||
    reason.includes("Local processing is paused because Plainsong could not read or update its Ollama safety marker in the configuration directory.")
  ));
}

/**
 * Turn the stored failure and the live phase into one line of copy.
 *
 * The live phase wins while it is saying something: a retry that is running is
 * more current than the failure it is trying to clear.
 */
/**
 * First line of notes the sidecar builds from the transcript alone when the
 * summary fails (`TRANSCRIPT_FACTS_NOTICE` in llm/grounded.rs).
 */
const TRANSCRIPT_FACTS_PREFIX = "Summary couldn't be written.";

export function describeMeetingAnalysis(args: {
  storedFailure: string | null;
  livePhase: MeetingAnalysisPhase | null;
  liveError: string | null;
  /** The stored summary, to tell quoted fallback notes from no notes. */
  summary?: string | null;
}): MeetingAnalysisNotice | null {
  if (args.livePhase === "running") {
    return {
      title: "Writing meeting notes",
      // The first automatic pass and a retry both report "running", so the
      // line must read right for either.
      message: "Plainsong is writing the summary and action items.",
      retryable: false,
      busy: true,
      waiting: false,
    };
  }
  if (args.livePhase === "waiting") {
    return {
      title: MEMORY_WAIT_TITLE,
      message:
        "Plainsong will try again after the call ends, then every few minutes.",
      retryable: true,
      busy: false,
      waiting: true,
    };
  }
  if (args.livePhase === "completed") {
    return null;
  }

  const reason = args.liveError ?? args.storedFailure;
  if (args.livePhase !== "failed" && !reason) {
    return null;
  }
  if (args.livePhase !== "failed" && reason === MEMORY_WAIT_NOTICE) {
    // The sidecar restores persisted waits after startup.
    return {
      title: MEMORY_WAIT_TITLE,
      message: "Plainsong will retry automatically.",
      retryable: true,
      busy: false,
      waiting: true,
    };
  }

  const quotedFallback = args.summary?.trimStart().startsWith(TRANSCRIPT_FACTS_PREFIX) === true;
  const cause =
    plainMeetingNotesFailure(reason) ??
    "The summary and action items failed and no reason was recorded.";
  return {
    title: quotedFallback ? "Summary couldn't be written" : "Meeting notes were not written",
    message: quotedFallback
      ? `${cause} Key lines from the transcript are saved in the notes.`
      : cause,
    retryable: !localProcessingIsPaused(reason),
    busy: false,
    waiting: false,
  };
}
