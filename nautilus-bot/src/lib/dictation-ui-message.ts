import { stripTransportPrefix } from "@/lib/meeting-start-error";
import { containsTechnicalDetails } from "@/lib/user-facing-error";

/**
 * Sidecar `outcome` for a delivery Plainsong refused on purpose because the
 * focused control is a password box or another secure input. Mirrors
 * `dictation_secure_field::SECURE_FIELD_REASON_CODE` in the sidecar.
 */
const SECURE_FIELD_DICTATION_OUTCOME = "secure_field";

/** Sidecar `outcome` when a newer user clipboard was kept instead of copying. */
const NEWER_CLIPBOARD_KEPT_DICTATION_OUTCOME = "clipboard_kept";

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
  if (outcome === NEWER_CLIPBOARD_KEPT_DICTATION_OUTCOME) {
    // Delivery was refused and the clipboard fallback skipped, because the
    // user copied something while Plainsong was working. Their copy stays.
    return {
      title: "Not inserted — clipboard kept",
      message:
        "You copied something while Plainsong was working, so Plainsong did not replace your clipboard. The words are kept in Plainsong; use Copy result to put them on the clipboard.",
    };
  }
  if (outcome !== SECURE_FIELD_DICTATION_OUTCOME) {
    return null;
  }
  return {
    title: "Not inserted — secure field",
    message:
      "The field in front is a password or secure input, so Plainsong did not insert or copy the words. They stay in Plainsong; use Copy result to put them on the clipboard.",
  };
}

/**
 * What a cloud dictation route does with the personal dictionary, in the
 * words the route selector and the provider cards show. The terms leave the
 * machine only for providers that accept them, and ElevenLabs charges for it;
 * both facts belong next to the choice, not only in developer docs. Local
 * routes say whether the model takes hints at all: without them, a dictionary
 * entry only fixes words the model already heard as its spoken form.
 */
export function describeDictationVocabularyNote(
  providerType: string | null | undefined,
): string | null {
  switch (providerType) {
    case "openai_cloud":
    case "groq":
      return "Your dictionary terms and snippet triggers are sent with the audio to help recognition.";
    case "elevenlabs_scribe":
      return "Your dictionary terms and snippet triggers are sent with the audio to help recognition. ElevenLabs bills 20% more for a request that carries them.";
    case "cohere_transcribe":
      return "Cohere does not accept vocabulary hints, so your dictionary is applied only after transcription, on this Mac.";
    case "deepgram":
      return "Your dictionary terms and snippet triggers are sent with the audio as keyterms to help recognition. Every request also opts out of Deepgram's model improvement programme.";
    case "gemini_transcribe":
      return "Your dictionary terms and snippet triggers are sent with the audio to help recognition. Google's paid tier does not train on them; its free tier does.";
    case "mistral_voxtral":
      return "Up to 100 of your dictionary terms and snippet triggers are sent with the audio as context bias to help recognition. Mistral optimises that for English; other languages are experimental.";
    case "xai_stt":
      return "Up to 100 of your dictionary terms and snippet triggers are sent with the audio as key terms to help recognition.";
    case "whisper":
    case "qwen3_asr":
    case "whistle":
      return "Your dictionary terms are given to this model as spelling hints on this Mac, then applied as exact replacements.";
    case "parakeet":
    case "moonshine":
    case "whisper_candle":
    case "distil_whisper":
    case "transcribe_cpp":
      return "This model does not take vocabulary hints, so your dictionary is applied only as exact replacements after transcription. If a word is misheard, add the misheard form as the spoken phrase.";
    default:
      return null;
  }
}

const memoryAdmissionMessages = [
  "Not enough verified memory headroom for native inference working buffers alongside other applications",
  "Not enough verified memory headroom to run built-in cleanup alongside other applications",
  "Not enough verified memory headroom for native text processing and other applications",
  "Not enough current memory headroom for this Ollama model and context alongside other applications",
  "Could not verify current memory headroom for local Ollama processing",
  "Could not verify native memory headroom",
  "Apple Speech needs more verified memory headroom before transcription",
];

export function isDictationMemoryAdmissionRefusal(message: string | null | undefined): boolean {
  return memoryAdmissionMessages.some((candidate) => message?.toLowerCase().includes(candidate.toLowerCase()));
}

const INTERNAL_ENGINE_TERMS = /\bneural engine\b|\bcore ?ml\b|\bfluid ?audio\b|\bggml\b(?!-)/i;

export function sanitizeUserFacingDictationMessage(
  message: string | null | undefined,
  options?: {
    inSetup?: boolean;
    phase?: "recording" | "transcribing" | "delivering" | "done" | "error";
  },
): string | null {
  if (!message) {
    return null;
  }

  const trimmed = stripTransportPrefix(message).replace(
    /Settings\s*->\s*ASR Models\b/gi,
    "Settings > Models",
  );
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  // Native admission can refuse before allocations or fail to measure enough
  // headroom. Keep that distinction from an actual out-of-memory crash, and
  // preserve any following notice about audio retained for retry.
  const looksLikeRuntimeDump =
    normalized.includes("sttoutput(") ||
    normalized.includes("segments=[") ||
    normalized.includes("prompt_tps") ||
    normalized.includes("generation_tps") ||
    normalized.includes("total_tokens=") ||
    normalized.includes("traceback (most recent call last)") ||
    normalized.includes("object at 0x");

  // Engine internals say nothing a user can act on. Whisper model file names
  // ("ggml-base.en.bin") are not internals and stay.
  if (!looksLikeRuntimeDump && INTERNAL_ENGINE_TERMS.test(trimmed)) {
    if (options?.phase === "done") return null;
    if (options?.phase === "error") return "Transcription failed. Try again or switch to another model.";
    return options?.phase === "transcribing" || options?.phase === "delivering"
      ? "Finishing transcription."
      : "Working on transcription.";
  }

  if (!looksLikeRuntimeDump) {
    for (const admissionMessage of memoryAdmissionMessages) {
      const literalPattern = admissionMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(literalPattern, "i").exec(trimmed);
      if (!match) continue;
      const start = match.index;
      const end = start + match[0].length;
      const suffix = trimmed.slice(end).replace(/^\./, "");
      return `${trimmed.slice(0, start)}Plainsong couldn't confirm enough free memory for local processing. Close memory-heavy applications and try again, or choose a smaller model${options?.inSetup ? "" : " in Settings > Models"}.${suffix}`;
    }

    if (!containsTechnicalDetails(trimmed)) return trimmed;
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
