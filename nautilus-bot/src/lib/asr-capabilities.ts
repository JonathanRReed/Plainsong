import type {
  AppleSpeechReadiness,
  AsrProviderInfo,
  AsrProviderType,
} from "@/types";
import { compareStrings } from "@/lib/format-locale";

export type DictationRoutePreference = "local" | "cloud";

/**
 * Every provider the app can actually run, as a runtime value rather than a
 * type-only union. Settings files and stored transcripts carry provider names
 * as bare strings, so the only way to reject a name for an engine that no
 * longer exists -- `mlx_audio` in an old settings file, say -- is to check it
 * against a list that survives type erasure.
 *
 * The `satisfies Record<AsrProviderType, true>` clause is what keeps this
 * honest: it fails to compile both when a variant is missing and when a name
 * here is not a real variant. That is the check the duplicated copy of this
 * list in recordings-view.tsx never had, which is how `mlx_audio` and
 * `voxtral` stayed in it after the engines were deleted.
 */
const ASR_PROVIDER_TYPE_FLAGS = {
  whisper: true,
  parakeet: true,
  whisper_candle: true,
  distil_whisper: true,
  macos_apple_speech: true,
  moonshine: true,
  windows_sdk_dictation: true,
  elevenlabs_scribe: true,
  openai_cloud: true,
  groq: true,
  cohere_transcribe: true,
  cohere_local: true,
  qwen3_asr: true,
  whistle: true,
  deepgram: true,
  gemini_transcribe: true,
  mistral_voxtral: true,
  xai_stt: true,
  transcribe_cpp: true,
} satisfies Record<AsrProviderType, true>;

export const ASR_PROVIDER_TYPES = Object.keys(
  ASR_PROVIDER_TYPE_FLAGS
) as AsrProviderType[];

/** True only for a provider name this build can still run. */
export function isKnownAsrProvider(
  providerType: string | null | undefined
): providerType is AsrProviderType {
  return Object.prototype.hasOwnProperty.call(
    ASR_PROVIDER_TYPE_FLAGS,
    (providerType ?? "").trim()
  );
}

const DOWNLOADABLE_PROVIDER_SET = new Set<AsrProviderType>([
  "whisper",
  "parakeet",
  "whisper_candle",
  "distil_whisper",
  "moonshine",
  "qwen3_asr",
  "cohere_local",
  "transcribe_cpp",
  "whistle",
]);

const MEETING_GRADE_PROVIDER_SET = new Set<AsrProviderType>([
  "distil_whisper",
  "parakeet",
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
  "cohere_transcribe",
  "qwen3_asr",
  "deepgram",
  "gemini_transcribe",
  "mistral_voxtral",
  "transcribe_cpp",
]);

/**
 * Providers whose transcription response carries speaker labels, so a meeting
 * transcribed by them does not need Plainsong's own diarizer run over the same
 * audio afterwards. Mirrors which `AsrProvider` implementations populate
 * `TranscriptionResult::speaker_turns` in the sidecar.
 *
 * None of the four cloud providers that shipped before September 2026
 * (OpenAI, Groq, ElevenLabs, Cohere) returns speaker labels at all, which is
 * why this set is not simply "the cloud providers".
 */
const PROVIDER_DIARIZATION_SET = new Set<AsrProviderType>([
  "deepgram",
  "gemini_transcribe",
  "mistral_voxtral",
]);

export function providerReturnsSpeakerLabels(providerType: AsrProviderType) {
  return PROVIDER_DIARIZATION_SET.has(providerType);
}

// whisper.cpp is deliberately absent: its meeting support is per model (see
// `WHISPER_MEETING_MODEL_IDS` below), so the provider is neither dictation-only
// nor meeting-grade as a whole.
//
// Apple Speech is listed here as its default, which is what a Mac without
// SpeechAnalyzer has. On macOS 26+ with the language installed it runs
// SpeechAnalyzer, which does return per-segment timestamps, and
// `appleSpeechServesMeetings` below is what tells the two apart. Nothing here
// can decide it, because it depends on the machine.
const DICTATION_ONLY_PROVIDER_SET = new Set<AsrProviderType>([
  "macos_apple_speech",
  "windows_sdk_dictation",
  "moonshine",
  "whisper_candle",
  "whistle",
  // Until xAI's per-request size and duration limits are confirmed.
  "xai_stt",
]);

/**
 * Whether the Apple Speech route on *this* Mac can serve meetings.
 *
 * Only its SpeechAnalyzer engine returns the per-segment timestamps a meeting
 * transcript is assembled from, and only when the route is otherwise ready.
 * Mirrors `supports_meetings` in rust-sidecar/src/asr/platform/macos_speech.rs,
 * which is the check the sidecar actually enforces.
 */
export function appleSpeechServesMeetings(
  readiness: AppleSpeechReadiness | null | undefined,
): boolean {
  return Boolean(readiness?.ready) && readiness?.engine === "speech_analyzer";
}

/**
 * The whisper.cpp ggml models the meeting lane accepts. Mirrors
 * `WHISPER_MEETING_MODEL_IDS` in rust-sidecar/src/lib.rs: multilingual
 * `small` and up, never tiny/base, never a `.en` build. They exist in the
 * meeting lane for the ~100 languages Parakeet v3 and Distil-Whisper cannot
 * hear, and whisper.cpp returns per-segment timestamps for them.
 */
const WHISPER_MEETING_MODEL_IDS = new Set([
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
]);

export function isWhisperMeetingModel(modelId: string) {
  return WHISPER_MEETING_MODEL_IDS.has(modelId.trim().toLowerCase());
}

const CLOUD_PROVIDER_SET = new Set<AsrProviderType>([
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
  "cohere_transcribe",
  "deepgram",
  "gemini_transcribe",
  "mistral_voxtral",
  "xai_stt",
]);

export function isDownloadableProvider(providerType: AsrProviderType) {
  return DOWNLOADABLE_PROVIDER_SET.has(providerType);
}

export function isMeetingGradeProvider(providerType: AsrProviderType) {
  return MEETING_GRADE_PROVIDER_SET.has(providerType);
}

export function isDictationOnlyProvider(providerType: AsrProviderType) {
  return DICTATION_ONLY_PROVIDER_SET.has(providerType);
}

export function isCloudProvider(providerType: AsrProviderType) {
  return CLOUD_PROVIDER_SET.has(providerType);
}

export function providerHostingPreference(
  providerType: AsrProviderType
): DictationRoutePreference {
  return isCloudProvider(providerType) ? "cloud" : "local";
}

export function isMeetingEligibleProvider(providerType: AsrProviderType) {
  return !isDictationOnlyProvider(providerType);
}

export function isMeetingEligibleModel(providerType: AsrProviderType, modelId: string) {
  if (!isMeetingEligibleProvider(providerType)) {
    return false;
  }

  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    // whisper.cpp has no meeting-safe default: its provider default is
    // base.en, which is dictation-only.
    return providerType !== "whisper";
  }

  switch (providerType) {
    case "whisper":
      return isWhisperMeetingModel(normalizedModelId);
    case "distil_whisper":
      return normalizedModelId.startsWith("distil");
    case "parakeet":
      // Only v3 has a real-audio long-form receipt in Plainsong. V2 remains a
      // dictation-only preview until the exact pinned export is qualified.
      return normalizedModelId === "parakeet-tdt-0.6b-v3";
    case "groq":
    case "elevenlabs_scribe":
    case "cohere_transcribe":
      return true;
    case "deepgram":
      // Both Nova-3 builds return word timestamps and turn-level utterances.
      return normalizedModelId.startsWith("nova-3");
    case "gemini_transcribe":
      // Only the batch model returns word timestamps; the -live model is
      // websocket-only and cannot diarize (see the sidecar's
      // sanitize_gemini_asr_model_id).
      return normalizedModelId === "gemini-3.5-transcribe";
    case "mistral_voxtral":
      // Only the batch snapshot returns segment timestamps and speaker
      // labels; `voxtral-mini-realtime-2602` is a websocket route that cannot
      // diarize, and `voxtral-mini-2507` is the deprecated predecessor (see
      // the sidecar's sanitize_mistral_model_id).
      return normalizedModelId === "voxtral-mini-2602";
    case "openai_cloud":
      // Only whisper-1 requests verbose_json from the transcriptions
      // endpoint (openai_cloud.rs's uses_verbose_json()), which is what
      // actually returns segment timestamps. gpt-transcribe (the dictation
      // default) and the gpt-4o-*-transcribe models return a single
      // un-timed block, which breaks seek/timeline/diarization alignment
      // for a meeting -- so they stay dictation-only and the meeting lane
      // always resolves openai_cloud to whisper-1.
      return normalizedModelId === "whisper-1";
    case "transcribe_cpp":
      // Pinned batch routes tested on English conversation audio. GGUF
      // Parakeet is the recommended meeting route on Apple Silicon (see
      // `isExperimentalInLane` in asr-route-catalog.ts); Unified EN stays
      // experimental. Eligible, never inherited: the sidecar uses either for
      // meetings only when the meeting slot names it, so an older install
      // that dictates on GGUF keeps recording meetings on ONNX Parakeet.
      // Fluid Speech Mini and Underdog Bark 3.0 Pro are optional English
      // models for both lanes, never inherited or recommended.
      return normalizedModelId === "parakeet-tdt-0.6b-v3-q8_0" ||
        normalizedModelId === "parakeet-unified-en-0.6b-q8_0" ||
        normalizedModelId === FLUID_SPEECH_MINI_MODEL_ID ||
        normalizedModelId === UNDERDOG_BARK_PRO_MODEL_ID;
    case "qwen3_asr":
      // Qwen3-ASR is an encoder-decoder model that transcribes a whole
      // recording in one pass (the meeting lane chunks it). Experimental:
      // validated on English real audio in Plainsong on 2026-09-01, and the
      // only local route to Chinese, Japanese and Korean.
      return normalizedModelId.startsWith("qwen3-asr");
    default:
      return false;
  }
}

export function isSharedMeetingCompatible(providerType: AsrProviderType, modelId: string) {
  return isMeetingEligibleProvider(providerType) && isMeetingEligibleModel(providerType, modelId);
}

export function providerCapabilityLabel(
  providerType: AsrProviderType,
  appleSpeechMeetingCapable = false,
) {
  if (isMeetingGradeProvider(providerType)) {
    return "Meeting-grade";
  }

  if (
    providerType === "macos_apple_speech" &&
    appleSpeechMeetingCapable
  ) {
    return "Meeting-grade";
  }

  if (isDictationOnlyProvider(providerType)) {
    return "Dictation-only";
  }

  return "General";
}

export function providerHostingLabel(providerType: AsrProviderType): string {
  if (providerType === "macos_apple_speech") {
    return "On-device";
  }

  return isCloudProvider(providerType) ? "Cloud" : "Local";
}

export function providerRecommendation(provider: AsrProviderInfo) {
  if (isMeetingGradeProvider(provider.providerType)) {
    if (provider.runtimeStatus === "ready" && provider.inferenceEnabled) {
      return "Ready for meeting-grade transcription.";
    }
    return "Supports meetings once it is set up.";
  }

  if (
    provider.providerType === "macos_apple_speech" &&
    appleSpeechServesMeetings(provider.platformReadiness)
  ) {
    return "Ready for dictation and meetings with Apple's built-in speech recognition, with nothing to download.";
  }

  if (isDictationOnlyProvider(provider.providerType)) {
    return "Supports dictation only.";
  }

  return "Available for transcription once it is set up.";
}

export function providerActionLabel(provider: AsrProviderInfo) {
  if (provider.runtimeStatus === "missing_model" && isDownloadableProvider(provider.providerType)) {
    return "Download";
  }

  if (provider.runtimeStatus === "missing_runtime") {
    return "Fix setup";
  }

  return "Re-check";
}

// ---------------------------------------------------------------------------
// Per-model capability metadata
//
// The UI had no language field at all, which is why six multilingual Whisper
// builds shipped visually indistinguishable from the English-only `.en` ones.
// Everything below is the metadata needed to tell them apart honestly.
// ---------------------------------------------------------------------------

/**
 * What a model does when the speaker stops talking mid-utterance. This is not
 * trivia -- it is the single most user-visible difference between the two
 * families during dictation.
 *
 * `encoder_decoder` (Whisper and its derivatives) runs an autoregressive
 * decoder that always wants to emit the next token, so a long pause gets filled
 * with invented text: repeated phrases, stray thank-yous, subtitle boilerplate
 * absorbed from the training data.
 *
 * `transducer` (Parakeet) emits a blank per frame, so silence produces silence.
 * The legacy 110M export runs its CTC head rather than the transducer head, but
 * it shares the property that matters here: blank frames produce no text.
 */
export type AsrPauseBehavior = "encoder_decoder" | "transducer";

/**
 * Where a model sits in the picker. Exactly three routes are promoted; the rest
 * live behind a "More models" disclosure so the default list stays readable.
 */
export type AsrModelTier = "promoted" | "more";

export interface AsrModelLanguageSupport {
  /** True when the model was trained on English alone and will mistranscribe anything else. */
  englishOnly: boolean;
  /** Approximate count claimed upstream; 1 for the English-only builds. */
  count: number;
  /** Short renderable label, e.g. "English only", "~100 languages". */
  label: string;
  /** The label in a sentence, when the short form reads badly there ("about 100 languages"). */
  prose?: string;
  /** The languages besides English, for "Tested in English. Also built for …". */
  besidesEnglish?: string;
}

export type AsrLanguageEvidenceBasis =
  | "plainsong_verified"
  | "upstream_listed";

export interface AsrModelLanguageEvidence {
  /**
   * `plainsong_verified` means the complete language claim was exercised in
   * this product. `upstream_listed` keeps a vendor capability distinct from a
   * Plainsong release qualification.
   */
  basis: AsrLanguageEvidenceBasis;
  /** Languages exercised successfully in Plainsong's packaged runtime. */
  verifiedLanguages: readonly string[];
}

export interface AsrModelCapability {
  providerType: AsrProviderType;
  modelId: string;
  languages: AsrModelLanguageSupport;
  languageEvidence: AsrModelLanguageEvidence;
  /**
   * Download size in **MiB** (2^20 bytes), not MB (10^6). The unit is not
   * cosmetic: `ggml-base.en.bin` is 147,964,211 bytes, which is 141.1 MiB but
   * 148.0 MB, and the table previously carried one entry in each unit while
   * rendering them side by side.
   *
   * Every number here mirrors the Rust side, whose `size_mb` fields are also
   * MiB despite the name -- see `min_expected_model_bytes` in
   * rust-sidecar/src/download/mod.rs, which multiplies by 1024*1024. The
   * sources are that file's table for whisper.cpp and each provider's own
   * `model_info` for the rest. `formatModelSize` is the only renderer and it
   * converts to the decimal MB/GB Finder shows.
   */
  sizeMib: number;
  tier: AsrModelTier;
  pauseBehavior: AsrPauseBehavior;
  /** What picking this model costs you. Never a selling point. */
  tradeoff: string;
}

const ENGLISH_ONLY: AsrModelLanguageSupport = {
  englishOnly: true,
  count: 1,
  label: "English only",
};

const WHISPER_MULTILINGUAL: AsrModelLanguageSupport = {
  englishOnly: false,
  count: 99,
  label: "~100 languages",
  prose: "about 100 languages",
  besidesEnglish: "about 100 other languages",
};

const PARAKEET_V3_LANGUAGES: AsrModelLanguageSupport = {
  englishOnly: false,
  count: 25,
  label: "25 European languages",
  besidesEnglish: "24 other European languages",
};

/**
 * Optional English models on the transcribe.cpp route: Parakeet TDT 0.6B v3
 * derivatives that Plainsong converts and serves from its own GitHub release.
 * Neither is a default or recommended anywhere. Each id mirrors the pin in
 * rust-sidecar/src/asr/transcribe_cpp.rs.
 */
export const FLUID_SPEECH_MINI_MODEL_ID = "fluid-speech-mini-q8_0";
export const UNDERDOG_BARK_PRO_MODEL_ID = "underdog-bark-3.0-pro-q8_0";

/** The credits each model's licence asks for, shown wherever the model is described. */
const FLUID_SPEECH_MINI_ATTRIBUTION =
  "Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.";
const UNDERDOG_BARK_PRO_ATTRIBUTION =
  "Underdog Bark 3.0 Pro by Conway Research. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra; post-trained and compressed by Conway Research.";

const ASR_MODEL_CAPABILITIES_WITHOUT_LANGUAGE_EVIDENCE: readonly Omit<
  AsrModelCapability,
  "languageEvidence"
>[] = [
  {
    providerType: "whisper",
    modelId: "tiny",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 75,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Garbles names and accented speech often enough that you'll retype sentences.",
  },
  {
    providerType: "whisper",
    modelId: "tiny.en",
    languages: ENGLISH_ONLY,
    sizeMib: 75,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Has the same accuracy problems as Whisper Tiny, without the option of another language.",
  },
  {
    providerType: "whisper",
    modelId: "base",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 142,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Less accurate in English than Whisper Base (English), at the same size.",
  },
  {
    providerType: "whisper",
    modelId: "base.en",
    languages: ENGLISH_ONLY,
    // Same file size as `base` -- 147,964,211 bytes measured on disk. The two
    // must stay equal, because the `base` tradeoff below says so in words.
    sizeMib: 142,
    tier: "promoted",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Speak Spanish or German into it and it returns English-sounding nonsense rather than admitting it can't.",
  },
  {
    providerType: "whisper",
    modelId: "small",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 466,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About three times the download of Whisper Base, for a gain you may not notice on short dictation.",
  },
  {
    providerType: "whisper",
    modelId: "small.en",
    languages: ENGLISH_ONLY,
    sizeMib: 466,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About three times the download of Whisper Base, for a gain you may not notice on short dictation.",
  },
  {
    providerType: "whisper",
    modelId: "medium",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1500,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About ten times the size of Whisper Base, and slower on every dictation to match.",
  },
  {
    providerType: "whisper",
    modelId: "medium.en",
    languages: ENGLISH_ONLY,
    sizeMib: 1500,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About ten times the size of Whisper Base, and slower on every dictation to match.",
  },
  {
    providerType: "whisper",
    modelId: "large-v3",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 2900,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About twenty times the size of Whisper Base and slower again than Whisper Large Turbo, for a small accuracy difference.",
  },
  {
    providerType: "whisper",
    modelId: "large-v3-turbo",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1620,
    tier: "promoted",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "About eleven times the size of Whisper Base, and slower. Choose it for the languages, not the speed.",
  },
  {
    providerType: "parakeet",
    modelId: "parakeet-tdt-0.6b-v3",
    languages: PARAKEET_V3_LANGUAGES,
    sizeMib: 639,
    tier: "promoted",
    pauseBehavior: "transducer",
    // Offered only where the GGUF build can't run, so there is nothing to
    // compare it with in a picker. Where both can run, the GGUF build made
    // fewer word errors (6.3% against 7.6% pooled on real speech) at about
    // half the memory, and this one is an internal fallback.
    tradeoff: "One download covers dictation and meetings.",
  },
  {
    providerType: "parakeet",
    modelId: "parakeet-tdt-0.6b-v2",
    languages: ENGLISH_ONLY,
    // 661,190,513 bytes across the four pinned int8 artifacts.
    sizeMib: 631,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "Choose Parakeet v3 for other languages. Plainsong hasn't compared its accuracy and speed with Parakeet v3 yet.",
  },
  {
    providerType: "parakeet",
    modelId: "orukeet-v0.1.0-int8",
    languages: ENGLISH_ONLY,
    // Six pinned files total 671,502,392 bytes, including the retained terms.
    sizeMib: 640,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "Experimental, offered for English dictation. It was tuned against one public English test set, and Plainsong hasn't shown it does better than the recommended model.",
  },
  {
    providerType: "parakeet",
    modelId: "parakeet-tdt-ctc-110m",
    languages: ENGLISH_ONLY,
    // 458,161,021 bytes for model.onnx upstream = 436.9 MiB. Mirrors
    // `size_mb: 437.0` in rust-sidecar/src/asr/parakeet.rs `model_info`.
    sizeMib: 437,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "An older version kept as a fallback. Less accurate than Parakeet v3, and for short dictation only.",
  },
  {
    providerType: "whisper_candle",
    modelId: "whisper-large-v3-turbo",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1600,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "The same model as Whisper Large Turbo, run a different way. A fallback, not extra accuracy.",
  },
  {
    providerType: "distil_whisper",
    modelId: "distil-large-v3.5",
    languages: ENGLISH_ONLY,
    // Pinned bundle: 3,028,168,610 bytes across the four required files.
    sizeMib: 2888,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "A lot of disk for a model that can't switch out of English.",
  },
  {
    providerType: "moonshine",
    modelId: "moonshine-tiny",
    languages: ENGLISH_ONLY,
    sizeMib: 120,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "Tuned for very short phrases. Accuracy drops on anything longer.",
  },
  {
    providerType: "moonshine",
    modelId: "moonshine-base",
    languages: ENGLISH_ONLY,
    sizeMib: 246,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "Tuned for short phrases. Longer recordings drift.",
  },
  {
    providerType: "whistle",
    modelId: "whistle-2.0.0",
    languages: { englishOnly: false, count: 7, label: "7 languages", besidesEnglish: "6 other languages" },
    sizeMib: 17,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Experimental, for dictations up to 30 seconds. It takes vocabulary hints, but names can still be misheard. Not for meetings or live preview.",
  },
  {
    providerType: "qwen3_asr",
    modelId: "qwen3-asr-0.6b",
    // 30 languages + 22 Chinese dialects per the Qwen3-ASR technical report.
    languages: {
      englishOnly: false,
      count: 52,
      label: "30 languages + 22 Chinese dialects",
      prose: "30 languages and 22 Chinese dialects",
      besidesEnglish: "29 other languages and 22 Chinese dialects",
    },
    // Total across all 7 files: ~2,020,098,572 bytes ≈ 1927 MiB.
    sizeMib: 1927,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Experimental. It can be slower than real time: 11 to 59 seconds to transcribe 44 seconds of speech on an M4 Pro, depending on what else was running. A meeting can take longer to transcribe than it took to hold.",
  },
  {
    providerType: "cohere_local",
    modelId: "cohere-transcribe-03-2026-q4",
    languages: {
      englishOnly: false,
      count: 14,
      label: "14 languages, and you have to pick one",
      prose: "14 languages",
      besidesEnglish: "13 other languages",
    },
    // 2,127,674,554 bytes across the eight pinned files.
    sizeMib: 2029,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "Experimental. The same model the Cohere cloud service uses, run offline on this Mac. Slower than Parakeet on a quiet M4 Pro: 0.67 s against 0.13 s for a 5-second phrase, and 7.5 s against 1.0 s for 44 s of speech. It can't detect a language, so it transcribes as English until you choose one, and its timings are estimated rather than measured, which is why it isn't offered for meetings.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "parakeet-tdt-0.6b-v3-q8_0",
    languages: PARAKEET_V3_LANGUAGES,
    // 739,508,576 bytes for the single GGUF = 705.3 MiB. Mirrors
    // `size_bytes` in rust-sidecar/src/asr/transcribe_cpp.rs. Where a
    // Download fetches more (the Neural Engine build on Apple Silicon), the
    // sidecar reports the total and `withDownloadSize` shows it instead.
    sizeMib: 705,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "One download covers dictation and meetings. It can write stray words when only background chatter is audible.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "orukeet-r3-q8_0",
    languages: ENGLISH_ONLY,
    sizeMib: 705,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "Experimental, for English dictation. A separate download from the other Orukeet. Check spoken amounts: one came out differently between test runs. Other languages and meetings aren't tested yet.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "qwen3-asr-1.7b-q8_0",
    languages: ENGLISH_ONLY,
    sizeMib: 2084,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "Experimental, for English dictation. A larger download and more memory than Parakeet. Not for meetings or live preview; other languages aren't tested yet.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "qwen3-asr-0.6b-q6_k",
    languages: ENGLISH_ONLY,
    sizeMib: 658,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "Experimental, for short English dictation. Longer recordings can repeat text and drop speech; use Parakeet for those. Not for meetings or live preview; other languages aren't tested yet.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "parakeet-unified-en-0.6b-q8_0",
    languages: ENGLISH_ONLY,
    sizeMib: 698,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "Experimental, for English dictation and meetings. Overlapping speech can confuse amounts, so check important numbers. No live preview while you dictate. Licensed by NVIDIA Corporation under the NVIDIA Open Model License.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "nemotron-3.5-asr-streaming-0.6b-q8_0",
    languages: ENGLISH_ONLY,
    sizeMib: 717,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff: "Experimental, for English dictation, using the same model as the live preview. Live preview with it, other languages and meetings aren't tested yet. Licensed under OpenMDW-1.1.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: FLUID_SPEECH_MINI_MODEL_ID,
    languages: ENGLISH_ONLY,
    // 739,508,608 bytes for the single GGUF = 705.3 MiB.
    sizeMib: 705,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff: `English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies. Compared with Parakeet v3, it left more real-speech clips empty, did worse in synthetic crowd noise, and made more critical errors in dictation tests. ${FLUID_SPEECH_MINI_ATTRIBUTION} CC BY 4.0.`,
  },
  {
    providerType: "transcribe_cpp",
    modelId: UNDERDOG_BARK_PRO_MODEL_ID,
    languages: ENGLISH_ONLY,
    sizeMib: 705,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff: `English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation and run numbers into words. Whole-meeting differences were within test variation, and it did worse on synthetic noisy audio. ${UNDERDOG_BARK_PRO_ATTRIBUTION} CC BY 4.0.`,
  },
  {
    providerType: "transcribe_cpp",
    modelId: "moonshine-streaming-medium-q8_0",
    languages: ENGLISH_ONLY,
    sizeMib: 282,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "Experimental, for short English dictation, with a small download. Check numbers carefully. Longer recordings can drop speech; use Parakeet for those. Not for meetings or live preview.",
  },
];

const LANGUAGE_EVIDENCE_BY_ROUTE = new Map<
  string,
  AsrModelLanguageEvidence
>([
  [
    "whisper:base.en",
    {
      basis: "plainsong_verified",
      verifiedLanguages: ["English"],
    },
  ],
  [
    "parakeet:parakeet-tdt-0.6b-v3",
    {
      basis: "upstream_listed",
      verifiedLanguages: ["English"],
    },
  ],
  [
    "parakeet:parakeet-tdt-0.6b-v2",
    {
      basis: "upstream_listed",
      verifiedLanguages: [],
    },
  ],
  [
    "parakeet:orukeet-v0.1.0-int8",
    {
      basis: "plainsong_verified",
      verifiedLanguages: ["English"],
    },
  ],
  [
    "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0",
    {
      // English only, on the two repo fixtures, in the spike receipt
      // artifacts/qa/transcribe-cpp-spike-2026-09-02.md. The other 24
      // languages are an upstream claim this build never exercised.
      basis: "upstream_listed",
      verifiedLanguages: ["English"],
    },
  ],
  [
    "transcribe_cpp:orukeet-r3-q8_0",
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  [
    "transcribe_cpp:qwen3-asr-1.7b-q8_0",
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  [
    "transcribe_cpp:parakeet-unified-en-0.6b-q8_0",
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  [
    "transcribe_cpp:nemotron-3.5-asr-streaming-0.6b-q8_0",
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  ["transcribe_cpp:moonshine-streaming-medium-q8_0", { basis: "plainsong_verified", verifiedLanguages: ["English"] }],
  [
    `transcribe_cpp:${FLUID_SPEECH_MINI_MODEL_ID}`,
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  [
    `transcribe_cpp:${UNDERDOG_BARK_PRO_MODEL_ID}`,
    { basis: "plainsong_verified", verifiedLanguages: ["English"] },
  ],
  [
    "cohere_local:cohere-transcribe-03-2026-q4",
    {
      // English only, on the two repo fixtures, in
      // artifacts/qa/cohere-local-receipt-2026-09-02.md. The other 13
      // languages are the upstream processor's list, which this build has
      // never exercised.
      basis: "upstream_listed",
      verifiedLanguages: ["English"],
    },
  ],
  [
    "qwen3_asr:qwen3-asr-0.6b",
    {
      // English: real-audio eval on 2026-09-01 (qwen3_asr_real_audio_eval).
      // Chinese, Japanese and Korean were only spot-checked with synthetic
      // TTS clips, which is not a qualification.
      basis: "upstream_listed",
      verifiedLanguages: ["English"],
    },
  ],
]);

const ASR_MODEL_CAPABILITIES: readonly AsrModelCapability[] =
  ASR_MODEL_CAPABILITIES_WITHOUT_LANGUAGE_EVIDENCE.map((entry) => ({
    ...entry,
    languageEvidence:
      LANGUAGE_EVIDENCE_BY_ROUTE.get(
        `${entry.providerType}:${entry.modelId}`,
      ) ?? {
        basis: "upstream_listed",
        verifiedLanguages: [],
      },
  }));

const CAPABILITY_BY_ROUTE = new Map<string, AsrModelCapability>(
  ASR_MODEL_CAPABILITIES.map((entry) => [
    `${entry.providerType}:${entry.modelId}`,
    entry,
  ])
);

/**
 * Metadata for a specific provider/model pair, or null when we have no measured
 * numbers for it -- cloud routes have no download and are deliberately absent
 * rather than given invented sizes.
 */
export function getAsrModelCapability(
  providerType: AsrProviderType,
  modelId: string | null | undefined
): AsrModelCapability | null {
  return CAPABILITY_BY_ROUTE.get(`${providerType}:${(modelId ?? "").trim()}`) ?? null;
}

/**
 * `capability` with its size replaced by what a Download fetches on this Mac,
 * when the sidecar reports that (`modelDownloadBytes`). On Apple Silicon a
 * Parakeet download fetches its Neural Engine build and, for English, the
 * vocabulary model besides the one GGUF file the catalog sizes.
 */
function withDownloadSize(
  capability: AsrModelCapability | null,
  downloadBytes: number | null | undefined,
): AsrModelCapability | null {
  if (!capability || typeof downloadBytes !== "number" || !Number.isFinite(downloadBytes) || downloadBytes <= 0) {
    return capability;
  }
  return { ...capability, sizeMib: downloadBytes / (1024 * 1024) };
}

/** The capability for one of `provider`'s models, sized for this Mac. */
export function getAsrModelCapabilityFor(
  provider: { providerType: AsrProviderType; modelDownloadBytes?: Record<string, number> },
  modelId: string | null | undefined,
): AsrModelCapability | null {
  const id = (modelId ?? "").trim();
  return withDownloadSize(
    getAsrModelCapability(provider.providerType, id),
    provider.modelDownloadBytes?.[id],
  );
}

export function asrModelTier(
  providerType: AsrProviderType,
  modelId: string | null | undefined
): AsrModelTier {
  return getAsrModelCapability(providerType, modelId)?.tier ?? "more";
}

/**
 * Renders an `AsrModelCapability.sizeMib` value the way Finder and the first-run
 * wizard show a download: decimal MB and GB. The stored numbers are binary
 * (MiB), so this converts rather than relabels -- 705 MiB is 739 MB. Printing
 * MiB here while the wizard printed MB showed one file at two sizes.
 */
export function formatModelSize(sizeMib: number): string {
  if (!Number.isFinite(sizeMib) || sizeMib <= 0) {
    return "size unknown";
  }
  const megabytes = (sizeMib * 1024 * 1024) / 1_000_000;
  return megabytes >= 1000
    ? `${(megabytes / 1000).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

export function describePauseBehavior(behavior: AsrPauseBehavior): string {
  return behavior === "transducer"
    ? "Stays quiet through pauses, so silence produces no text."
    : "Can turn long pauses into invented words.";
}

// ---------------------------------------------------------------------------
// Which languages a route actually accepts
//
// The dictation language picker used to be a hardcoded list of seven, offered
// against models that accept anywhere from one language to a hundred. Seven was
// neither the truth for Whisper (which loses 92 of them) nor for base.en (which
// accepts none of the other six and returns English-sounding nonsense instead of
// refusing). The lists below are the model's own coverage, so the picker's
// boundary is the model's boundary.
// ---------------------------------------------------------------------------

/**
 * Whisper's multilingual token set, in the order the upstream tokenizer
 * declares it (`whisper/tokenizer.py`'s `LANGUAGES`).
 */
const WHISPER_LANGUAGE_CODES: readonly string[] = [
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr",
  "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi",
  "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
  "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk",
  "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk",
  "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc",
  "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
  "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
  "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
];

/** large-v3 and its turbo distillation add Cantonese to the set above. */
const WHISPER_LARGE_V3_LANGUAGE_CODES: readonly string[] = [
  ...WHISPER_LANGUAGE_CODES,
  "yue",
];

/**
 * Parakeet TDT 0.6B v3's 25 languages: the 23 official EU languages the model
 * card lists, plus Russian and Ukrainian. Mandarin, Hindi and Arabic are absent
 * — the same absence the route's `tradeoff` names in words.
 */
const PARAKEET_V3_LANGUAGE_CODES: readonly string[] = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de",
  "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk",
  "sl", "es", "sv", "ru", "uk",
];

/**
 * The 30 languages the Qwen3-ASR model card lists (its 22 Chinese dialects
 * all surface as `zh`/`yue`). Mirrors `QWEN3_ASR_LANGUAGES` in
 * rust-sidecar/src/settings.rs, which is what a saved selection is validated
 * against.
 */
const QWEN3_ASR_LANGUAGE_CODES: readonly string[] = [
  "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it",
  "ko", "ru", "th", "vi", "ja", "tr", "hi", "ms", "nl", "sv",
  "da", "fi", "pl", "cs", "fil", "fa", "el", "hu", "mk", "ro",
];

/**
 * The 14 languages `CohereAsrProcessor` accepts. Mirrors
 * `COHERE_LOCAL_LANGUAGES` in rust-sidecar/src/asr/cohere_local.rs and
 * `COHERE_LOCAL_LANGUAGES` in rust-sidecar/src/settings.rs. Unlike every other
 * local route this one cannot detect a language, so the list is also the set
 * the user must choose from.
 */
const COHERE_LOCAL_LANGUAGE_CODES: readonly string[] = [
  "ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];

/**
 * The 13 languages Mistral lists for Voxtral Mini Transcribe 2, taken from the
 * `mistralai/Voxtral-Mini-4B-Realtime-2602` model card's own `language`
 * metadata (fetched 2026-09-03), which is the same set the announcement names.
 * Unlike Deepgram's `multi` and Gemini's "85+", Mistral publishes the actual
 * set, so the picker can show it.
 */
const VOXTRAL_TRANSCRIBE_LANGUAGE_CODES: readonly string[] = [
  "en", "fr", "es", "de", "ru", "zh", "ja", "it", "pt", "nl", "ar", "hi", "ko",
];

/** Language codes per route, where Plainsong can name the set. */
const LANGUAGE_CODES_BY_ROUTE = new Map<string, readonly string[]>([
  ["whisper:tiny", WHISPER_LANGUAGE_CODES],
  ["whisper:base", WHISPER_LANGUAGE_CODES],
  ["whisper:small", WHISPER_LANGUAGE_CODES],
  ["whisper:medium", WHISPER_LANGUAGE_CODES],
  ["whisper:large-v3", WHISPER_LARGE_V3_LANGUAGE_CODES],
  ["whisper:large-v3-turbo", WHISPER_LARGE_V3_LANGUAGE_CODES],
  ["whisper_candle:whisper-large-v3-turbo", WHISPER_LARGE_V3_LANGUAGE_CODES],
  ["parakeet:parakeet-tdt-0.6b-v3", PARAKEET_V3_LANGUAGE_CODES],
  ["parakeet:parakeet-tdt-0.6b-v2", ["en"]],
  ["parakeet:orukeet-v0.1.0-int8", ["en"]],
  ["transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0", PARAKEET_V3_LANGUAGE_CODES],
  ["transcribe_cpp:parakeet-unified-en-0.6b-q8_0", ["en"]],
  [`transcribe_cpp:${FLUID_SPEECH_MINI_MODEL_ID}`, ["en"]],
  [`transcribe_cpp:${UNDERDOG_BARK_PRO_MODEL_ID}`, ["en"]],
  ["qwen3_asr:qwen3-asr-0.6b", QWEN3_ASR_LANGUAGE_CODES],
  ["whistle:whistle-2.0.0", ["en", "de", "fr", "es", "it", "nl", "pl"]],
  ["cohere_local:cohere-transcribe-03-2026-q4", COHERE_LOCAL_LANGUAGE_CODES],
]);

/**
 * Cloud routes carry no capability entry (they have no download to measure),
 * but they still have a language boundary — and it is per *model*, not per
 * provider. `openai_cloud` serves both `whisper-1` and the GPT-4o transcribe
 * family, which this file already documents as behaving differently; keying by
 * provider gave the GPT-4o models Whisper's list, which is an assumption no
 * provider doc supports.
 *
 * A cloud model is listed here only when its coverage is the published coverage
 * of a Whisper release. Everything else — the GPT-4o transcribe models,
 * ElevenLabs Scribe, Cohere — resolves to `unenumerated`, so the picker says it
 * does not know rather than offering ~100 languages on an inherited guess.
 */
const CLOUD_LANGUAGE_CODES_BY_ROUTE = new Map<string, readonly string[]>([
  // OpenAI's whisper-1 is the hosted Whisper large-v2 checkpoint, which
  // predates the large-v3 addition of Cantonese.
  ["openai_cloud:whisper-1", WHISPER_LANGUAGE_CODES],
  ["groq:whisper-large-v3", WHISPER_LARGE_V3_LANGUAGE_CODES],
  ["groq:whisper-large-v3-turbo", WHISPER_LARGE_V3_LANGUAGE_CODES],
  // Mistral publishes the set rather than a count, so this one can be named.
  ["mistral_voxtral:voxtral-mini-2602", VOXTRAL_TRANSCRIBE_LANGUAGE_CODES],
]);

/**
 * Routes that are multilingual but whose language list Plainsong has never
 * confirmed, with a label that says whose claim it is.
 *
 * These have no entry in `ASR_MODEL_CAPABILITIES` -- that table is about
 * downloads (size, pause behaviour), and a hosted route has no download and no
 * published decoder behaviour to describe. Without something here they fell
 * through to the generic "the selected model's languages", which tells a user
 * nothing about a route they are paying per minute for. The labels below state
 * the upstream claim and mark it as upstream's, which is the same standard
 * `languageEvidence.basis: "upstream_listed"` holds the downloadable models to.
 *
 * They are deliberately not enumerated: Plainsong has not exercised these
 * language sets, and a fabricated list in the session-language picker would be
 * a capability claim the app cannot back.
 */
const UNENUMERATED_LANGUAGE_LABELS_BY_ROUTE = new Map<string, string>([
  // Deepgram documents `language=multi` code-switching for Nova-3 without
  // publishing a fixed set. Nova-3 Medical is the English clinical build.
  ["deepgram:nova-3", "multilingual code-switching, listed by Deepgram"],
  ["deepgram:nova-3-medical", "English, listed by Deepgram"],
  // Google reports 2.6% average word error rate across 85+ languages
  // (Artificial Analysis, announced 2026-08-26) without publishing the set.
  ["gemini_transcribe:gemini-3.5-transcribe", "85+ languages, listed by Google"],
]);

/** The English name of every code the lists above can produce. */
export const ASR_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  af: "Afrikaans", am: "Amharic", ar: "Arabic", as: "Assamese", az: "Azerbaijani",
  ba: "Bashkir", be: "Belarusian", bg: "Bulgarian", bn: "Bengali", bo: "Tibetan",
  br: "Breton", bs: "Bosnian", ca: "Catalan", cs: "Czech", cy: "Welsh",
  da: "Danish", de: "German", el: "Greek", en: "English", es: "Spanish",
  et: "Estonian", eu: "Basque", fa: "Persian", fi: "Finnish", fil: "Filipino", fo: "Faroese",
  fr: "French", gl: "Galician", gu: "Gujarati", ha: "Hausa", haw: "Hawaiian",
  he: "Hebrew", hi: "Hindi", hr: "Croatian", ht: "Haitian Creole", hu: "Hungarian",
  hy: "Armenian", id: "Indonesian", is: "Icelandic", it: "Italian", ja: "Japanese",
  jw: "Javanese", ka: "Georgian", kk: "Kazakh", km: "Khmer", kn: "Kannada",
  ko: "Korean", la: "Latin", lb: "Luxembourgish", ln: "Lingala", lo: "Lao",
  lt: "Lithuanian", lv: "Latvian", mg: "Malagasy", mi: "Māori", mk: "Macedonian",
  ml: "Malayalam", mn: "Mongolian", mr: "Marathi", ms: "Malay", mt: "Maltese",
  my: "Burmese", ne: "Nepali", nl: "Dutch", nn: "Norwegian Nynorsk", no: "Norwegian",
  oc: "Occitan", pa: "Punjabi", pl: "Polish", ps: "Pashto", pt: "Portuguese",
  ro: "Romanian", ru: "Russian", sa: "Sanskrit", sd: "Sindhi", si: "Sinhala",
  sk: "Slovak", sl: "Slovenian", sn: "Shona", so: "Somali", sq: "Albanian",
  sr: "Serbian", su: "Sundanese", sv: "Swedish", sw: "Swahili", ta: "Tamil",
  te: "Telugu", tg: "Tajik", th: "Thai", tk: "Turkmen", tl: "Tagalog",
  tr: "Turkish", tt: "Tatar", uk: "Ukrainian", ur: "Urdu", uz: "Uzbek",
  vi: "Vietnamese", yi: "Yiddish", yo: "Yoruba", yue: "Cantonese", zh: "Chinese",
};

/** The English name of a language code, or the code itself when unnamed. */
export function asrLanguageName(code: string): string {
  return ASR_LANGUAGE_NAMES[code] ?? code;
}

export type AsrLanguageBoundary =
  /** One language, and switching is not possible on this model. */
  | { kind: "english_only"; label: string }
  /** Exactly these languages, named. */
  | { kind: "enumerated"; codes: readonly string[]; label: string }
  /** More than one language, but Plainsong cannot name which. */
  | { kind: "unenumerated"; label: string };

/**
 * What the selected route will actually accept.
 *
 * Returns `unenumerated` rather than a guess when the model is multilingual but
 * Plainsong has no verified list for it — the picker then says so instead of
 * presenting a fabricated set as the boundary.
 */
export function resolveAsrLanguageBoundary(
  providerType: AsrProviderType | null | undefined,
  modelId: string | null | undefined
): AsrLanguageBoundary {
  if (!providerType) {
    return { kind: "unenumerated", label: "the selected model's languages" };
  }

  const capability = getAsrModelCapability(providerType, modelId);
  if (capability?.languages.englishOnly) {
    return { kind: "english_only", label: capability.languages.label };
  }

  const route = `${providerType}:${(modelId ?? "").trim()}`;
  const codes =
    LANGUAGE_CODES_BY_ROUTE.get(route) ??
    CLOUD_LANGUAGE_CODES_BY_ROUTE.get(route) ??
    null;
  if (codes) {
    return {
      kind: "enumerated",
      codes,
      label: capability?.languages.label ?? `${codes.length} languages`,
    };
  }

  if (capability) {
    return { kind: "unenumerated", label: capability.languages.label };
  }
  const upstreamLabel = UNENUMERATED_LANGUAGE_LABELS_BY_ROUTE.get(route);
  if (upstreamLabel) {
    return { kind: "unenumerated", label: upstreamLabel };
  }
  return { kind: "unenumerated", label: "the selected model's languages" };
}

/**
 * The picker's option list for a route: `null` when the model is English-only,
 * because a one-item picker is not a choice and the caller says so in words
 * instead. `codes` is empty for an unenumerated route.
 */
export function asrLanguageOptions(
  boundary: AsrLanguageBoundary
): Array<{ value: string; label: string }> {
  if (boundary.kind !== "enumerated") {
    return [];
  }
  return [...boundary.codes]
    .map((code) => ({ value: code, label: asrLanguageName(code) }))
    .sort((left, right) => compareStrings(left.label, right.label));
}

/**
 * What a model's language coverage means for you, in plain sentences. What
 * Plainsong has tested stays apart from what the model was built for.
 */
function describeLanguages(capability: AsrModelCapability): string {
  const { languages, languageEvidence } = capability;
  const verified = languageEvidence.verifiedLanguages;
  if (languages.englishOnly) {
    return verified.length > 0 ? "English only." : "English only. Not yet tested in Plainsong.";
  }
  const prose = languages.prose ?? languages.label;
  if (languageEvidence.basis === "plainsong_verified") {
    return `${prose.charAt(0).toUpperCase()}${prose.slice(1)}, tested in Plainsong.`;
  }
  if (verified.length === 0) {
    return `Built for ${prose}. Not yet tested in Plainsong.`;
  }
  const besides =
    verified.length === 1 && verified[0] === "English" && languages.besidesEnglish
      ? languages.besidesEnglish
      : prose;
  return `Tested in ${verified.join(" and ")}. Also built for ${besides}.`;
}

/**
 * What a model is, in a few short sentences a user can act on: size, language
 * coverage, and the downside. Returns null for routes we have no measured
 * metadata for, so callers render nothing rather than a plausible-sounding
 * guess.
 */
export function describeAsrModel(
  providerType: AsrProviderType,
  modelId: string | null | undefined,
  capability: AsrModelCapability | null = getAsrModelCapability(providerType, modelId),
): string | null {
  if (!capability) {
    return null;
  }

  return `${formatModelSize(capability.sizeMib)}. ${describeLanguages(capability)} ${capability.tradeoff}`;
}

/**
 * A model's display name without the file-format details a sidecar adds
 * ("Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0)" -> "Nemotron 3.5 ASR
 * Streaming 0.6B"). Those details stay in the model id.
 */
export function plainModelName(name: string): string {
  return name
    .replace(/\s*\((?:GGUF|ONNX)?[\s,]*(?:Q\d(?:_[A-Z0-9]+)*|int[48])?[\s,]*\)/gi, "")
    .replace(/\s*via transcribe\.cpp/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
