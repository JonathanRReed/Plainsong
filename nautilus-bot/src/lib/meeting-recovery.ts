/**
 * The renderer half of Wave 1's meeting data-integrity work.
 *
 * The sidecar already knew three things that never reached a screen: that a
 * meeting's saved audio can be re-checked and repaired, that a transcript can
 * be *known* incomplete (and that its audio is being held back from cleanup
 * because of it), and that a capture can have gone partly silent. Merging Wave 1
 * was conditioned on these becoming reachable by hand rather than only
 * programmatically. This module reads those facts and puts them in words.
 *
 * Every field is read defensively. Recordings serialize `rename_all =
 * "camelCase"`, so that spelling is expected; the snake_case fallbacks cost
 * nothing and mean a serialization difference degrades to "no claim" rather
 * than to a wrong one.
 */

import type { Recording } from "@/types";
import { containsTechnicalTerms } from "@/lib/meeting-ui-message";

export interface MeetingIntegrity {
  /**
   * `false` only when the sidecar positively flagged the transcript as
   * incomplete. `null` means the field is absent — no claim either way.
   */
  transcriptComplete: boolean | null;
  /** Why it is incomplete, in the sidecar's words. */
  degradedReason: string | null;
  /** When the reader accepted losing the audio, if they have. */
  acknowledgedAt: string | null;
  captureDegradedSummary: string | null;
}

function readString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readBoolean(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    // SQLite-backed integers survive some serializations as 0/1.
    if (value === 0 || value === 1) {
      return value === 1;
    }
  }
  return null;
}

export function readMeetingIntegrity(
  recording: Recording | null | undefined,
): MeetingIntegrity {
  if (!recording) {
    return {
      transcriptComplete: null,
      degradedReason: null,
      acknowledgedAt: null,
      captureDegradedSummary: null,
    };
  }
  const record = recording as unknown as Record<string, unknown>;
  return {
    transcriptComplete: readBoolean(
      record,
      "transcriptComplete",
      "transcript_complete",
    ),
    degradedReason: readString(
      record,
      "transcriptDegradedReason",
      "transcript_degraded_reason",
    ),
    acknowledgedAt: readString(
      record,
      "transcriptIncompleteAcknowledgedAt",
      "transcript_incomplete_acknowledged_at",
    ),
    captureDegradedSummary: readString(
      record,
      "captureDegradedSummary",
      "capture_degraded_summary",
    ),
  };
}

/** True when the sidecar has positively said this transcript is incomplete. */
export function transcriptIsIncomplete(integrity: MeetingIntegrity): boolean {
  return integrity.transcriptComplete === false;
}

export function describeAnalysisSourceReview(integrity: MeetingIntegrity): string | null {
  if (integrity.captureDegradedSummary) {
    return "Part of this meeting was not captured. Review this result against the available transcript and notes before sharing.";
  }
  if (transcriptIsIncomplete(integrity)) {
    return "This transcript is incomplete. Review this result against the available transcript and notes before sharing.";
  }
  return null;
}

export interface IncompleteTranscriptNotice {
  title: string;
  message: string;
  /** The audio is still held back from cleanup. */
  audioHeld: boolean;
}

/**
 * What an incomplete transcript actually means for this meeting, including the
 * part users are never told: the audio is only still on disk because nobody has
 * agreed to lose it.
 */
export function describeIncompleteTranscript(
  integrity: MeetingIntegrity,
): IncompleteTranscriptNotice | null {
  if (!transcriptIsIncomplete(integrity)) {
    return null;
  }

  // The stored reason can be a raw chunk error written for the log; the
  // generic sentences below say the same thing in plain words.
  const reason = containsTechnicalTerms(integrity.degradedReason)
    ? null
    : integrity.degradedReason;
  if (integrity.acknowledgedAt) {
    const loss = integrity.captureDegradedSummary
      ? "Re-transcription cannot restore conversation that was not captured. "
      : "";
    return {
      title: "Transcript incomplete — you accepted losing the audio",
      message: reason
        ? `${reason} ${loss}Storage cleanup may now delete this meeting's audio; the transcript stays as it is.`
        : `${loss}Storage cleanup may now delete this meeting's audio; the transcript stays as it is.`,
      audioHeld: false,
    };
  }

  if (integrity.captureDegradedSummary) {
    return {
      title: "Transcript incomplete. Partial audio kept",
      message: `${reason ? `${reason} ` : ""}The saved audio is partial. Re-transcription cannot restore conversation that was not captured. Cleanup is keeping what was saved until you accept losing it.`,
      audioHeld: true,
    };
  }

  return {
    title: "Transcript incomplete — audio kept for re-transcription",
    message: reason
      ? `${reason} The saved audio may contain words missing from this transcript. Cleanup is holding it back until you re-transcribe or accept losing it.`
      : "Part of this meeting was never transcribed. The saved audio may contain missing words. Cleanup is holding it back until you re-transcribe or accept losing it.",
    audioHeld: true,
  };
}

/** The caveat to render alongside a meeting whose capture went partly quiet. */
export function describeCaptureDegradation(
  integrity: MeetingIntegrity,
): { title: string; message: string } | null {
  if (!integrity.captureDegradedSummary) {
    return null;
  }
  // The summary may end with the audio system's own account in brackets,
  // which is for the log when it names internals.
  const summary = containsTechnicalTerms(integrity.captureDegradedSummary)
    ? integrity.captureDegradedSummary.replace(/\s*\([^()]*\)/g, "")
    : integrity.captureDegradedSummary;
  return {
    title: "Some of this meeting was not captured",
    message: `${summary} Anything those sources would have carried is not in the recording or the transcript.`,
  };
}

/**
 * Whether re-checking the saved audio is worth offering.
 *
 * The renderer cannot see per-asset lifecycle rows — `Recording` deliberately
 * exposes only `audio_path` — so this reads the states those rows produce: a
 * meeting parked in `error`, a transcript known incomplete, or a finalization
 * that failed before the duration was ever written. The sidecar refuses while
 * capture or processing is running, so those are excluded here rather than
 * offered and rejected.
 */
export function canRecheckMeetingAudio(
  recording: Recording | null | undefined,
  integrity: MeetingIntegrity,
): boolean {
  if (!recording?.audioPath) {
    return false;
  }
  if (recording.status === "recording" || recording.status === "processing") {
    return false;
  }
  return (
    recording.status === "error" ||
    transcriptIsIncomplete(integrity) ||
    (recording.duration ?? 0) <= 0
  );
}
