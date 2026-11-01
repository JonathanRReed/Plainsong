import { isDictationMemoryAdmissionRefusal } from "@/lib/dictation-ui-message";
import { stripTransportPrefix } from "@/lib/meeting-start-error";
import { containsTechnicalDetails as containsTechnicalTerms } from "@/lib/user-facing-error";

export { containsTechnicalDetails as containsTechnicalTerms } from "@/lib/user-facing-error";

function looksBusy(text: string): boolean {
  return /\bbusy\b|another (local )?task|already running/i.test(text);
}

/**
 * The stored reason a meeting's summary and action items were not written,
 * as the reader should see it. The sidecar joins one reason per stage
 * ("summary: …; action items: …"); the same cause twice reads as one line.
 */
export function plainMeetingNotesFailure(reason: string | null | undefined): string | null {
  const raw = reason ? stripTransportPrefix(reason).trim() : "";
  if (!raw) return null;
  // "summary: <why>; action items: <why>" with the provider id in front of a
  // policy refusal ("native_text Policy: …") is how the log reads it.
  const parts = raw
    .split(/;\s+(?=(?:summary|action items|title):)/i)
    .map((part) =>
      part
        .replace(/^(?:summary|action items|title):\s*/i, "")
        .replace(/^[a-z][a-z0-9_]* policy:\s*/i, "")
        .trim(),
    )
    .filter(Boolean);
  const trimmed = [...new Set(parts)].join(" ") || raw;
  if (isDictationMemoryAdmissionRefusal(trimmed) || /\bheadroom\b|not enough (verified |free )?memory/i.test(trimmed)) {
    return "There wasn't enough free memory to write the summary and action items. Close other large apps, then try again.";
  }
  if (containsTechnicalTerms(trimmed)) {
    return looksBusy(trimmed)
      ? "Another task on this Mac was using the text model. Try again in a moment."
      : "The text model could not write the summary and action items. Try again, or choose another model in Settings > Search & AI.";
  }
  return trimmed;
}

/**
 * A meeting processing or speaker-labelling failure, as the reader should see
 * it: the sidecar's own sentence when it is already plain, otherwise
 * `fallback`.
 */
export function plainMeetingProcessingMessage(
  message: string | null | undefined,
  fallback: string,
): string {
  const trimmed = message ? stripTransportPrefix(message).trim() : "";
  if (!trimmed) return fallback;
  if (isDictationMemoryAdmissionRefusal(trimmed) || /\bheadroom\b/i.test(trimmed)) {
    return "There wasn't enough free memory to finish this meeting. Close other large apps, then try again.";
  }
  if (containsTechnicalTerms(trimmed)) return fallback;
  return trimmed;
}
