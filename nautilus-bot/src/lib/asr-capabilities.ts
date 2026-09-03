import type {
  AppleSpeechReadiness,
  AsrProviderInfo,
  AsrProviderType,
} from "@/types";

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
  qwen3_asr: true,
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
  "transcribe_cpp",
]);

const MEETING_GRADE_PROVIDER_SET = new Set<AsrProviderType>([
  "distil_whisper",
  "parakeet",
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
  "cohere_transcribe",
  "qwen3_asr",
  "transcribe_cpp",
]);

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
      // Only the v3 TDT route is long-form capable. The legacy 110M export is
      // a short-form English model and stays out of the meeting lane.
      return normalizedModelId.startsWith("parakeet-tdt-0.6b");
    case "groq":
    case "elevenlabs_scribe":
    case "cohere_transcribe":
      return true;
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
      // Same Parakeet TDT 0.6B v3 weights as the shipped meeting route, so
      // the long-form property is the same one; only the runtime differs.
      // Experimental, so the catalog sorts it last and never recommends it.
      return normalizedModelId.startsWith("parakeet-tdt-0.6b-v3");
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
    return "Best used for meetings once the runtime is ready.";
  }

  if (
    provider.providerType === "macos_apple_speech" &&
    appleSpeechServesMeetings(provider.platformReadiness)
  ) {
    return "Ready for dictation and meetings through Apple's SpeechAnalyzer, with nothing to download.";
  }

  if (isDictationOnlyProvider(provider.providerType)) {
    return "Best used for fast dictation, not meeting transcription.";
  }

  return "Available for general transcription once the runtime is ready.";
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
   * divides by 1024, so the displayed unit matches the stored one.
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
};

const PARAKEET_V3_LANGUAGES: AsrModelLanguageSupport = {
  englishOnly: false,
  count: 25,
  label: "25 European languages",
};

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
      "it garbles proper nouns and accented speech often enough that you will retype sentences.",
  },
  {
    providerType: "whisper",
    modelId: "tiny.en",
    languages: ENGLISH_ONLY,
    sizeMib: 75,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "it has the same accuracy problems as tiny, without the option of another language.",
  },
  {
    providerType: "whisper",
    modelId: "base",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 142,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "the multilingual weights cost accuracy on English against base.en at effectively the same size.",
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
      "speak Spanish or German into it and it returns English-sounding nonsense rather than admitting it cannot.",
  },
  {
    providerType: "whisper",
    modelId: "small",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 466,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "about three times the download of base.en for a gain you may not notice on short dictation.",
  },
  {
    providerType: "whisper",
    modelId: "small.en",
    languages: ENGLISH_ONLY,
    sizeMib: 466,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "about three times the download of base.en for a gain you may not notice on short dictation.",
  },
  {
    providerType: "whisper",
    modelId: "medium",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1500,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "roughly ten times the size of base.en, and proportionally slower on every utterance.",
  },
  {
    providerType: "whisper",
    modelId: "medium.en",
    languages: ENGLISH_ONLY,
    sizeMib: 1500,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "roughly ten times the size of base.en, and proportionally slower on every utterance.",
  },
  {
    providerType: "whisper",
    modelId: "large-v3",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 2900,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "roughly twenty times the size of base.en and slower again than large-v3-turbo, for a narrow accuracy difference.",
  },
  {
    providerType: "whisper",
    modelId: "large-v3-turbo",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1620,
    tier: "promoted",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "about eleven times the size of base.en and slower per utterance; take it for the language coverage, not the speed.",
  },
  {
    providerType: "parakeet",
    modelId: "parakeet-tdt-0.6b-v3",
    languages: PARAKEET_V3_LANGUAGES,
    sizeMib: 639,
    tier: "promoted",
    pauseBehavior: "transducer",
    tradeoff:
      "Mandarin, Hindi and Arabic are not covered at all, and the download is four separate ONNX files rather than one.",
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
      "an older English-only export kept as a fallback; less accurate than the v3 model and short-form only.",
  },
  {
    providerType: "whisper_candle",
    modelId: "whisper-large-v3-turbo",
    languages: WHISPER_MULTILINGUAL,
    sizeMib: 1600,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "the same weights as the whisper.cpp large-v3-turbo route, run through Candle -- a fallback engine, not extra accuracy.",
  },
  {
    providerType: "distil_whisper",
    modelId: "distil-large-v3.5",
    languages: ENGLISH_ONLY,
    // Pinned bundle: 3,028,168,610 bytes across the four required files.
    sizeMib: 2888,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "that is a lot of disk for a model that cannot switch out of English.",
  },
  {
    providerType: "moonshine",
    modelId: "moonshine-tiny",
    languages: ENGLISH_ONLY,
    sizeMib: 120,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "tuned for very short utterances; accuracy drops on anything longer.",
  },
  {
    providerType: "moonshine",
    modelId: "moonshine-base",
    languages: ENGLISH_ONLY,
    sizeMib: 246,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff: "tuned for short utterances; longer recordings drift.",
  },
  {
    providerType: "qwen3_asr",
    modelId: "qwen3-asr-0.6b",
    // 30 languages + 22 Chinese dialects per the Qwen3-ASR technical report.
    languages: {
      englishOnly: false,
      count: 52,
      label: "30 languages + 22 Chinese dialects",
    },
    // Total across all 7 files: ~2,020,098,572 bytes ≈ 1927 MiB.
    sizeMib: 1927,
    tier: "more",
    pauseBehavior: "encoder_decoder",
    tradeoff:
      "experimental — English is the only language verified in Plainsong, and the int4 decoders run on the CPU at anywhere from a quarter of real time to slower than real time depending on load (11-59 s to transcribe 44 s of speech on an M4 Pro across quiet and shared-CPU runs), so a meeting can take longer to transcribe than it took to hold.",
  },
  {
    providerType: "transcribe_cpp",
    modelId: "parakeet-tdt-0.6b-v3-q8_0",
    languages: PARAKEET_V3_LANGUAGES,
    // 739,508,576 bytes for the single GGUF = 705.3 MiB. Mirrors
    // `size_bytes` in rust-sidecar/src/asr/transcribe_cpp.rs.
    sizeMib: 705,
    tier: "more",
    pauseBehavior: "transducer",
    tradeoff:
      "experimental — the same Parakeet weights the recommended route already runs, re-quantized to GGUF and run through a second inference runtime, so it is a second copy of a model you may already have downloaded.",
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

export function asrModelTier(
  providerType: AsrProviderType,
  modelId: string | null | undefined
): AsrModelTier {
  return getAsrModelCapability(providerType, modelId)?.tier ?? "more";
}

/**
 * Renders an `AsrModelCapability.sizeMib` value. The divisor is 1024 and the
 * suffix says MiB/GiB, because the stored numbers are binary units -- dividing
 * by 1000 and printing "MB" understated every size in the picker by ~5%.
 */
export function formatModelSize(sizeMib: number): string {
  if (!Number.isFinite(sizeMib) || sizeMib <= 0) {
    return "size unknown";
  }
  return sizeMib >= 1024
    ? `${(sizeMib / 1024).toFixed(1)} GiB`
    : `${Math.round(sizeMib)} MiB`;
}

export function describePauseBehavior(behavior: AsrPauseBehavior): string {
  return behavior === "transducer"
    ? "Stays quiet through pauses: silence produces no text."
    : "Its decoder keeps emitting through long pauses, so silence can become invented words.";
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
  ["transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0", PARAKEET_V3_LANGUAGE_CODES],
  ["qwen3_asr:qwen3-asr-0.6b", QWEN3_ASR_LANGUAGE_CODES],
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
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * One sentence a user can act on: size, language coverage, and the downside.
 * Returns null for routes we have no measured metadata for, so callers render
 * nothing rather than a plausible-sounding guess.
 */
export function describeAsrModel(
  providerType: AsrProviderType,
  modelId: string | null | undefined
): string | null {
  const capability = getAsrModelCapability(providerType, modelId);
  if (!capability) {
    return null;
  }

  const verifiedLanguages = capability.languageEvidence.verifiedLanguages;
  const languageEvidence =
    capability.languageEvidence.basis === "plainsong_verified"
      ? `${capability.languages.label}; ${verifiedLanguages.join(
          " and ",
        )} verified in Plainsong`
      : verifiedLanguages.length > 0
        ? `${capability.languages.label} listed upstream; ${verifiedLanguages.join(
            " and ",
          )} verified in Plainsong`
        : `${capability.languages.label} listed upstream; not yet qualified across the full set in Plainsong`;

  return `${formatModelSize(capability.sizeMib)}, ${languageEvidence}; ${capability.tradeoff}`;
}
