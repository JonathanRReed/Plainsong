/**
 * Sidecar `outcome` for a delivery Plainsong refused on purpose because the
 * focused control is a password box or another secure input. Mirrors
 * `dictation_secure_field::SECURE_FIELD_REASON_CODE` in the sidecar.
 */
const SECURE_FIELD_DICTATION_OUTCOME = "secure_field";

export interface DictationDeliveryRefusal {
  title: string;
  message: string;
}

/**
 * Plain-language explanation for an outcome where Plainsong chose not to
 * deliver. Distinct from a delivery *failure*: nothing was inserted and
 * nothing was put on the clipboard, and the words are kept in history with
 * the usual Copy action. Returns `null` for every other outcome so callers
 * keep their existing branches.
 */
export function describeDictationDeliveryRefusal(
  outcome: string | null | undefined,
): DictationDeliveryRefusal | null {
  if (outcome !== SECURE_FIELD_DICTATION_OUTCOME) {
    return null;
  }
  return {
    title: "Not inserted — secure field",
    message:
      "The field in front is a password or secure input, so Plainsong did not insert or copy the words. They are kept in your dictation history; use Copy result to put them on the clipboard.",
  };
}

export function sanitizeUserFacingDictationMessage(
  message: string | null | undefined,
  options?: {
    phase?: "recording" | "transcribing" | "delivering" | "done" | "error";
  },
): string | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  const looksLikeRuntimeDump =
    normalized.includes("sttoutput(") ||
    normalized.includes("segments=[") ||
    normalized.includes("prompt_tps") ||
    normalized.includes("generation_tps") ||
    normalized.includes("total_tokens=") ||
    normalized.includes("traceback (most recent call last)") ||
    normalized.includes("object at 0x");

  if (!looksLikeRuntimeDump) {
    return trimmed;
  }

  switch (options?.phase) {
    case "transcribing":
    case "delivering":
      return "Finishing transcription.";
    case "error":
      return "Transcription failed. Try again or switch to another model.";
    case "done":
      return "Transcription is ready.";
    default:
      return "Working on transcription.";
  }
}
