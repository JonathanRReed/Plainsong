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
