import { normalizeDownloadStatus } from "@/lib/download-status";
import {
  FLUID_SPEECH_MINI_MODEL_ID,
  UNDERDOG_BARK_PRO_MODEL_ID,
  appleSpeechServesMeetings,
  describeAsrModel,
  getAsrModelCapabilityFor,
  isDownloadableProvider,
  isMeetingEligibleModel,
  isSharedMeetingCompatible,
  isWhisperMeetingModel,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import type { AsrModelCapability } from "@/lib/asr-capabilities";
import type {
  AppleSpeechReadiness,
  AsrProviderInfo,
  AsrProviderInventory,
  AsrProviderType,
} from "@/types";
import { compareStrings } from "@/lib/format-locale";

export type AsrRouteLane = "shared" | "dictation" | "meeting";
type MeetingRoutePolicy = "prefer_local" | "best_available";
type AsrRouteHosting = "local" | "cloud" | "platform";
type AsrRouteReadiness =
  | "ready"
  | "needs_download"
  | "requires_key"
  | "missing_runtime"
  | "unavailable";
type AsrRouteAction =
  | "download"
  // Asks macOS for one SpeechAnalyzer language. Distinct from "download",
  // which fetches a model this repo pins and hashes: this one is Apple's
  // asset, on Apple's terms, and Plainsong never stores a copy.
  | "install_language"
  | "connect_api_key"
  | "request_permission"
  | "open_system_setup"
  | "fix_setup"
  | null;

type RouteSelectableProvider =
  | AsrProviderInfo
  | AsrProviderInventory;

export interface AsrRouteCatalogEntry {
  routeId: string;
  providerType: AsrProviderType;
  modelId: string;
  label: string;
  providerLabel: string;
  providerDescription: string;
  laneCompatibility: Record<AsrRouteLane, boolean>;
  hosting: AsrRouteHosting;
  readiness: AsrRouteReadiness;
  readinessDetail: string | null;
  selectable: boolean;
  downloadable: boolean;
  experimental: boolean;
  capabilityBadge: "Dictation only" | "Meetings" | "Dictation and meetings";
  readinessLabel: string;
  action: AsrRouteAction;
  actionLabel: string | null;
  summary: string;
  /** Size, language coverage, tier and pause behaviour. Null for cloud routes. */
  capability: AsrModelCapability | null;
  /** One honest sentence including the downside. Null when no metadata exists. */
  capabilitySummary: string | null;
  /**
   * ONNX Parakeet v3 where the GGUF build of the same model can run. Kept in
   * the catalog so a slot that still names it can be read and labelled, but
   * never offered in a picker: there it is an internal fallback.
   */
  superseded: boolean;
  recommendedRank: Record<AsrRouteLane, number | null>;
}

// Ordered so the recommended dictation route lands on Parakeet TDT 0.6B v3 --
// the default (see settings.rs's default_provider doc) -- rather than
// whisper.cpp base.en, which this repo's own benchmark shows mis-transcribing
// words it hasn't seen before (including "Plainsong" itself). Platform-native
// engines and Moonshine's lowest-friction local route still rank first where
// available; base.en remains offered as the smaller download further down.
// Qwen3-ASR sits with the other experimental local route: it is offered (it
// is the only local route to Chinese, Japanese and Korean) but never
// recommended, and `isExperimentalRoute` sorts it into the last bucket.
//
// transcribe.cpp sits directly ahead of Parakeet: its one non-experimental
// route, GGUF Parakeet, is the recommended local speech engine on Apple
// Silicon (see `isRecommendedSpeechRoute`), and its experimental routes still
// sort into the last bucket whatever their provider rank.
const DICTATION_PROVIDER_ORDER: AsrProviderType[] = [
  "moonshine",
  "macos_apple_speech",
  "windows_sdk_dictation",
  "transcribe_cpp",
  "parakeet",
  "whisper",
  "distil_whisper",
  "whisper_candle",
  "qwen3_asr",
  "openai_cloud",
  "elevenlabs_scribe",
  "groq",
  "deepgram",
  "gemini_transcribe",
  "mistral_voxtral",
  "xai_stt",
  "cohere_transcribe",
];

// Parakeet leads the local routes in every policy: GGUF Parakeet through
// transcribe.cpp first where this build lists it (Apple Silicon -- see
// `isRecommendedSpeechRoute`), then the ONNX build of the same weights. Only
// that one transcribe.cpp route is non-experimental; the others (Unified EN)
// still sort into the last bucket whatever their provider rank. whisper.cpp
// (only its multilingual small+ models reach this lane -- see
// `isWhisperMeetingModel`) sits after Parakeet and before Distil: it is the
// local route for the ~100 languages Parakeet v3 lacks, at the cost of being
// slower than Parakeet on long audio.
const MEETING_PROVIDER_ORDER_BY_POLICY: Record<
  MeetingRoutePolicy,
  AsrProviderType[]
> = {
  prefer_local: [
    "transcribe_cpp",
    "parakeet",
    "whisper",
    "distil_whisper",
    // Apple Speech reaches this lane only on a Mac running SpeechAnalyzer with
    // the language installed (see `routeLaneCompatibility`). It ranks after
    // the three routes above -- they are what the meeting lane has been
    // measured on -- but ahead of every cloud route, because it needs no
    // account and never leaves the machine.
    "macos_apple_speech",
    // Deepgram and Gemini lead the cloud group here for the same reason they
    // lead it under `best_available`: they are the only routes that return
    // speaker labels with the transcript.
    "deepgram",
    "gemini_transcribe",
    "mistral_voxtral",
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
  ],
  // Deepgram, Gemini and Mistral Voxtral lead the cloud order for meetings
  // because they are the only three routes that return speaker labels with the
  // transcript; every other cloud route still pays for a local diarization
  // pass afterwards.
  best_available: [
    "deepgram",
    "gemini_transcribe",
    "mistral_voxtral",
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
    "transcribe_cpp",
    "parakeet",
    "whisper",
    "distil_whisper",
    "macos_apple_speech",
  ],
};

export function routeIdFor(providerType: AsrProviderType, modelId: string) {
  return `${providerType}:${modelId}`;
}

export function laneProviderOrder(
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  if (lane === "dictation") {
    return DICTATION_PROVIDER_ORDER;
  }
  return MEETING_PROVIDER_ORDER_BY_POLICY[meetingRoutePolicy];
}

function routeHosting(providerType: AsrProviderType): AsrRouteHosting {
  if (
    providerType === "macos_apple_speech" ||
    providerType === "windows_sdk_dictation"
  ) {
    return "platform";
  }

  return providerHostingPreference(providerType) === "cloud" ? "cloud" : "local";
}

/** "en_US" as a reader says it ("American English"), or the code when unknown. */
function localeDisplayName(locale: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(
        locale.replace(/_/g, "-"),
      ) ?? locale
    );
  } catch {
    return locale;
  }
}

/**
 * Which engine the Apple Speech route runs, and why, in one sentence.
 *
 * Says what will happen rather than what exists: "SpeechAnalyzer API
 * available" told a reader nothing about whether their next dictation would
 * use it.
 */
export function describeAppleSpeechEngine(
  readiness: AppleSpeechReadiness,
): string {
  const version = readiness.operatingSystemVersion
    ? ` (macOS ${readiness.operatingSystemVersion})`
    : "";
  const locale = readiness.locale ? localeDisplayName(readiness.locale) : "this language";

  if (!readiness.speechAnalyzerAvailable) {
    return `Uses Apple's older speech recognizer${version}, so it works for dictation only. Meetings need macOS 26 or later.`;
  }
  if (readiness.engine === "speech_analyzer") {
    return `Uses Apple's current speech recognizer${version} with ${locale} installed. Nothing to download.`;
  }
  if (!readiness.speechAnalyzerLocaleSupported) {
    return `Uses Apple's older speech recognizer${version}. The current one doesn't cover ${locale} yet.`;
  }
  return `Uses Apple's older speech recognizer${version}. Install ${locale} to switch to the current one, which also works for meetings.`;
}

/// Builds the human-readable readiness detail string for a route.
///
/// For Apple Speech this names the engine that will actually run and the
/// language-asset state behind that choice, because which of the two engines
/// runs decides whether the route has timestamps and whether meetings can use
/// it at all.
function buildReadinessDetail(provider: RouteSelectableProvider): string | null {
  const detail = provider.platformReadiness?.message ?? ("runtimeMessage" in provider ? provider.runtimeMessage ?? null : null);
  const base = detail && /\bGGUF\b|transcribe\.cpp|\bONNX\b|\bMetal\b|\bCoreML\b/i.test(detail)
    ? ("runtimeStatus" in provider && provider.runtimeStatus === "missing_model")
      ? "The speech model is missing or couldn't be verified. Download it again in Settings > Models."
      : "The speech model isn't ready. Check it in Settings > Models."
    : detail;
  if (
    provider.providerType === "macos_apple_speech" &&
    provider.platformReadiness
  ) {
    const engineNote = describeAppleSpeechEngine(provider.platformReadiness);
    return base ? `${base.replace(/\.\s*$/, "")}. ${engineNote}` : engineNote;
  }
  return base;
}

function routeReadiness(
  provider: RouteSelectableProvider,
  hosting: AsrRouteHosting,
): AsrRouteReadiness {
  if (!provider.inferenceEnabled) {
    return "unavailable";
  }

  if (provider.providerType === "macos_apple_speech") {
    const readiness = provider.platformReadiness;
    if (readiness) {
      if (readiness.ready && readiness.status === "ready") {
        return "ready";
      }
      return readiness.status === "unsupported_platform"
        ? "unavailable"
        : "missing_runtime";
    }
  }

  if (
    hosting === "local" &&
    isDownloadableProvider(provider.providerType) &&
    normalizeDownloadStatus(provider.downloadStatus).kind !== "downloaded"
  ) {
    return "needs_download";
  }

  if (!provider.isAvailable) {
    if (hosting === "cloud") {
      return "requires_key";
    }
    return "missing_runtime";
  }

  return "ready";
}

function routeReadinessLabel(
  provider: RouteSelectableProvider,
  readiness: AsrRouteReadiness,
) {
  if (provider.providerType === "macos_apple_speech") {
    switch (provider.platformReadiness?.status) {
      case "ready":
        return "Ready on this Mac";
      case "authorization_not_determined":
        return "Permission required";
      case "authorization_denied":
        return "Permission denied";
      case "authorization_restricted":
        return "Permission restricted";
      case "unsupported_locale":
        return "Language not supported";
      case "on_device_unavailable":
        return "Not available offline";
      case "helper_missing":
        return "Needs repair";
      case "recognizer_unavailable":
        return "Temporarily unavailable";
      case "unsupported_platform":
        return "Not available on this Mac";
      default:
        break;
    }
  }

  switch (readiness) {
    case "ready":
      return "Ready";
    case "needs_download":
      return "Needs download";
    case "requires_key":
      return "Needs an API key";
    case "missing_runtime":
      return "Fix setup";
    default:
      return "Unavailable";
  }
}

function routeAction(
  provider: RouteSelectableProvider,
  readiness: AsrRouteReadiness,
  hosting: AsrRouteHosting,
): { action: AsrRouteAction; actionLabel: string | null } {
  if (provider.providerType === "macos_apple_speech") {
    switch (provider.platformReadiness?.status) {
      case "authorization_not_determined":
        return { action: "request_permission", actionLabel: "Request permission" };
      case "authorization_denied":
      case "authorization_restricted":
        return { action: "open_system_setup", actionLabel: "Open Speech Settings" };
      case "helper_missing":
        return { action: "fix_setup", actionLabel: "Repair install" };
      case "unsupported_locale":
      case "on_device_unavailable":
      case "recognizer_unavailable":
      case "unknown_authorization":
      case "runtime_unavailable":
        return { action: "fix_setup", actionLabel: "Review setup" };
      default:
        break;
    }

    // Offered even on a ready route: the route works on SFSpeechRecognizer,
    // and installing the language is what upgrades it to SpeechAnalyzer and
    // opens the meeting lane.
    if (
      provider.platformReadiness?.speechAnalyzerAvailable &&
      provider.platformReadiness.speechAnalyzerLocaleSupported &&
      !provider.platformReadiness.speechAnalyzerAssetsInstalled
    ) {
      return { action: "install_language", actionLabel: "Install language" };
    }
  }

  if (readiness === "needs_download") {
    return { action: "download", actionLabel: "Download" };
  }
  if (readiness === "requires_key") {
    return { action: "connect_api_key", actionLabel: "Connect API key" };
  }
  if (readiness === "missing_runtime") {
    if (hosting === "platform") {
      return { action: "open_system_setup", actionLabel: "Open system setup" };
    }
    return { action: "fix_setup", actionLabel: "Fix setup" };
  }
  if (
    readiness === "unavailable" &&
    (provider.providerType === "macos_apple_speech" ||
      provider.providerType === "windows_sdk_dictation")
  ) {
    return { action: "open_system_setup", actionLabel: "Open system setup" };
  }
  return { action: null, actionLabel: null };
}

function routeCapabilityBadge(
  provider: RouteSelectableProvider,
  modelId: string,
): "Dictation only" | "Meetings" | "Dictation and meetings" {
  const lanes = routeLaneCompatibility(provider, modelId);
  if (lanes.shared) {
    return "Dictation and meetings";
  }
  if (lanes.meeting) {
    return "Meetings";
  }
  return "Dictation only";
}

/**
 * The local speech route a new Apple Silicon install dictates and records
 * meetings on: Parakeet TDT 0.6B v3 in GGUF through transcribe.cpp, one
 * download for both lanes (the Neural Engine build and vocabulary model in
 * place of the 739 MB GGUF on Macs that run them; the sidecar reports the
 * size, `parakeet_download_bytes`). Mirrors `fresh_install_dictation_route` in
 * rust-sidecar/src/settings.rs, which points the dictation and meeting slots
 * at it and leaves the shared default on ONNX Parakeet. The sidecar lists the
 * transcribe.cpp provider only in builds that compile it, so a catalog entry
 * for this route is itself the "this Mac can run it" signal; everywhere else
 * ONNX Parakeet stays the recommendation.
 */
export const RECOMMENDED_SPEECH_ROUTE = {
  providerType: "transcribe_cpp",
  modelId: "parakeet-tdt-0.6b-v3-q8_0",
} as const satisfies { providerType: AsrProviderType; modelId: string };

/** Whether this is GGUF Parakeet, the one non-experimental transcribe.cpp route. */
export function isRecommendedSpeechRoute(
  providerType: AsrProviderType,
  modelId: string,
): boolean {
  return (
    providerType === RECOMMENDED_SPEECH_ROUTE.providerType &&
    modelId.trim() === RECOMMENDED_SPEECH_ROUTE.modelId
  );
}

/**
 * Whether Settings marks this route Recommended in a lane: GGUF Parakeet in
 * the dictation and meeting lanes, the two slots a new Apple Silicon install
 * starts on. Never in the shared lane (see `isExperimentalInLane`).
 */
export function isRecommendedLaneRoute(
  lane: AsrRouteLane,
  providerType: AsrProviderType,
  modelId: string,
): boolean {
  return lane !== "shared" && isRecommendedSpeechRoute(providerType, modelId);
}

function isExperimentalRoute(providerType: AsrProviderType, modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  if (isRecommendedSpeechRoute(providerType, modelId)) {
    return false;
  }
  return (
    providerType === "whisper_candle" ||
    providerType === "qwen3_asr" ||
    // Named "(experimental)" in every picker (`LOCAL_ROUTE_DISPLAY_LABELS`).
    providerType === "whistle" ||
    providerType === "cohere_local" ||
    // transcribe.cpp's other routes (Qwen3-ASR, Orukeet, Unified EN,
    // Nemotron, Moonshine Streaming, and the optional English Fluid Speech
    // Mini and Underdog Bark 3.0 Pro): offered, never recommended.
    providerType === "transcribe_cpp" ||
    normalized.includes("experimental") ||
    normalized === "parakeet-tdt-0.6b-v2" ||
    normalized === "orukeet-v0.1.0-int8" ||
    normalized === "parakeet-tdt-ctc-110m"
  );
}

/**
 * Whether this Mac can run GGUF Parakeet, the efficient build of Parakeet v3
 * (Apple Silicon builds that compile transcribe.cpp). Where it can, it is the
 * only Parakeet v3 any picker offers, and ONNX Parakeet is kept as an
 * internal fallback (`AsrRouteCatalogEntry.superseded`). Everywhere else ONNX
 * Parakeet is simply Parakeet v3.
 */
export function efficientParakeetOffered(
  providers:
    | readonly Pick<AsrProviderInfo, "providerType" | "modelOptions" | "inferenceEnabled">[]
    | null
    | undefined,
): boolean {
  return (
    providers?.some(
      (provider) =>
        provider.providerType === RECOMMENDED_SPEECH_ROUTE.providerType &&
        provider.inferenceEnabled !== false &&
        provider.modelOptions.some((option) =>
          isRecommendedSpeechRoute(provider.providerType, option.id),
        ),
    ) ?? false
  );
}

/** ONNX Parakeet v3, the build of Parakeet v3 that runs on every Mac. */
export const ONNX_PARAKEET_ROUTE = {
  providerType: "parakeet",
  modelId: "parakeet-tdt-0.6b-v3",
} as const satisfies { providerType: AsrProviderType; modelId: string };

export function isOnnxParakeetRoute(
  providerType: AsrProviderType | string | null | undefined,
  modelId: string | null | undefined,
): boolean {
  return (
    providerType === ONNX_PARAKEET_ROUTE.providerType &&
    (modelId ?? "").trim() === ONNX_PARAKEET_ROUTE.modelId
  );
}

/**
 * The plain name a picker shows for each local speech model, so every surface
 * calls a model the same thing. The sidecar's own labels carry build details
 * ("GGUF Q8_0 via transcribe.cpp", "int4") that mean nothing to a reader;
 * those stay in the model id. Both builds of Parakeet v3 are "Parakeet v3":
 * a picker never offers both (`superseded`), so there is nothing to tell
 * apart.
 */
const LOCAL_ROUTE_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0": "Parakeet v3",
  "transcribe_cpp:parakeet-unified-en-0.6b-q8_0": "Parakeet Unified English (experimental)",
  "transcribe_cpp:orukeet-r3-q8_0": "Orukeet r3 (experimental)",
  "transcribe_cpp:qwen3-asr-1.7b-q8_0": "Qwen3-ASR 1.7B (experimental)",
  "transcribe_cpp:qwen3-asr-0.6b-q6_k": "Qwen3-ASR 0.6B Lite (experimental)",
  "transcribe_cpp:nemotron-3.5-asr-streaming-0.6b-q8_0": "Nemotron 3.5 Streaming (experimental)",
  "transcribe_cpp:moonshine-streaming-medium-q8_0": "Moonshine Streaming Medium (experimental)",
  [`transcribe_cpp:${FLUID_SPEECH_MINI_MODEL_ID}`]: "Fluid Speech Mini by FluidVoice",
  [`transcribe_cpp:${UNDERDOG_BARK_PRO_MODEL_ID}`]: "Underdog Bark 3.0 Pro by Conway Research",
  "parakeet:parakeet-tdt-0.6b-v3": "Parakeet v3",
  "parakeet:parakeet-tdt-0.6b-v2": "Parakeet v2 (English)",
  "parakeet:orukeet-v0.1.0-int8": "Orukeet v0.1 (experimental)",
  "parakeet:parakeet-tdt-ctc-110m": "Parakeet 110M (older, English)",
  "whisper:tiny": "Whisper Tiny",
  "whisper:tiny.en": "Whisper Tiny (English)",
  "whisper:base": "Whisper Base",
  "whisper:base.en": "Whisper Base (English)",
  "whisper:small": "Whisper Small",
  "whisper:small.en": "Whisper Small (English)",
  "whisper:medium": "Whisper Medium",
  "whisper:medium.en": "Whisper Medium (English)",
  "whisper:large-v3-turbo": "Whisper Large Turbo",
  "whisper:large-v3": "Whisper Large",
  "whisper_candle:whisper-large-v3-turbo": "Whisper Large Turbo, alternate (experimental)",
  "distil_whisper:distil-large-v3.5": "Distil-Whisper Large (English)",
  "moonshine:moonshine-tiny": "Moonshine Tiny (English)",
  "moonshine:moonshine-base": "Moonshine Base (English)",
  "whistle:whistle-2.0.0": "Cactus Whistle 2.0 (experimental)",
  "qwen3_asr:qwen3-asr-0.6b": "Qwen3-ASR 0.6B (experimental)",
  "cohere_local:cohere-transcribe-03-2026-q4": "Cohere Transcribe, offline (experimental)",
  "macos_apple_speech:macos_apple_speech": "Apple Speech",
};

/** Build details a sidecar label may carry that a reader never needs. */
const BUILD_DETAIL_PATTERN =
  /\s*via transcribe\.cpp|\bGGUF\b|\bONNX\b|\bQ\d(?:_[A-Z0-9]+)*\b|\bint[48]\b/gi;

export function routeDisplayLabel(
  providerType: AsrProviderType,
  modelId: string,
  upstreamLabel: string,
) {
  const key = `${providerType}:${modelId.trim()}`;
  const known = LOCAL_ROUTE_DISPLAY_LABELS[key];
  if (known) {
    return known;
  }
  if (routeHosting(providerType) === "cloud") {
    return upstreamLabel;
  }
  return upstreamLabel
    .replace(BUILD_DETAIL_PATTERN, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/,\s*\)/g, ")")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A speech model the way a status line names it: "Parakeet v3" for a model on
 * this Mac, "Deepgram · Nova-3" for a cloud service. Which program runs a
 * local model is not the reader's concern; where cloud audio goes is.
 */
export function speechRouteName(
  provider: Pick<AsrProviderInfo, "providerType" | "name" | "modelOptions">,
  modelId: string,
) {
  const label = routeDisplayLabel(
    provider.providerType,
    modelId,
    provider.modelOptions.find((option) => option.id === modelId)?.label ?? modelId,
  );
  return routeHosting(provider.providerType) === "cloud" ? `${provider.name} · ${label}` : label;
}

function routeSummary(
  providerType: AsrProviderType,
  modelId: string,
  capabilityBadge: AsrRouteCatalogEntry["capabilityBadge"],
) {
  if (providerType === "moonshine") {
    return "Quick to set up, for fast everyday dictation on this Mac.";
  }
  if (providerType === "distil_whisper") {
    return "English only. An accuracy alternative that is slower on long meetings.";
  }
  if (providerType === "parakeet") {
    if (modelId === "orukeet-v0.1.0-int8") {
      return "Experimental, for English dictation. A separate download, not yet tested for meetings.";
    }
    if (modelId === "parakeet-tdt-0.6b-v3") {
      return "For dictation and long meetings: one download covers both.";
    }
    if (modelId === "parakeet-tdt-0.6b-v2") {
      return "Experimental, English only. Not yet tested on real recordings.";
    }
    return "An older English-only Parakeet, kept as a fallback for short dictation.";
  }
  if (providerType === "openai_cloud") {
    // Only whisper-1 requests OpenAI's verbose_json response format
    // (openai_cloud.rs's uses_verbose_json()), which is what actually
    // returns segment timestamps -- gpt-transcribe and the gpt-4o-*
    // transcribe models return a single un-timed block, so they never
    // appear as meeting routes (see isMeetingEligibleModel).
    return modelId === "whisper-1"
      ? "Cloud transcription with timestamps, for meetings and dictation."
      : "Cloud transcription for dictation. It returns no timestamps, so it isn't offered for meetings.";
  }
  if (providerType === "elevenlabs_scribe") {
    return "Cloud service aimed at high-quality meeting transcription.";
  }
  if (providerType === "groq") {
    return "Cloud service for fast Whisper transcription.";
  }
  if (providerType === "cohere_transcribe") {
    return "Cloud service for meeting transcription. Bring your own API key.";
  }
  if (providerType === "deepgram") {
    // The per-minute rate belongs in the picker, not only in the model label
    // the sidecar sends: this is the line a user reads while choosing.
    return modelId === "nova-3-medical"
      ? "Deepgram's clinical-vocabulary build, English only, with the same speaker labels and word timestamps as Nova-3. Billed to your Deepgram key at $0.0043/min."
      : "Cloud transcription with speaker labels and word timestamps. Meetings keep Deepgram's speaker labels. Billed to your Deepgram key at $0.0043/min in English, $0.0052/min on any other language setting including auto.";
  }
  if (providerType === "gemini_transcribe") {
    return "Cloud transcription with speaker labels and word timestamps. Its API refuses your dictionary on the same request, so meetings get speakers and dictation gets the dictionary. Billed to your Google key at $0.005/min.";
  }
  if (providerType === "mistral_voxtral") {
    return "Cloud transcription with speaker labels, at $0.003/min, in 13 languages. Mistral's API refuses a language and timestamps on the same request, so meetings detect the language and dictation sends the one you chose. Billed to your Mistral key.";
  }
  if (providerType === "xai_stt") {
    return "xAI's Grok speech-to-text, with your dictionary sent as key terms. Dictation only for now. Billed to your xAI key.";
  }
  if (providerType === "macos_apple_speech") {
    return capabilityBadge === "Dictation only"
      ? "Apple's speech recognition on this Mac, for dictation only. It never falls back to Apple's servers; meetings use another model."
      : "Apple's speech recognition on this Mac: nothing to download, works for meetings, and never falls back to Apple's servers.";
  }
  if (providerType === "windows_sdk_dictation") {
    return "Built into Windows and handy for dictation, but not for meetings.";
  }
  if (providerType === "whisper_candle") {
    return "The same model as Whisper Large Turbo, run a different way. A fallback, not a different model.";
  }
  if (providerType === "whisper") {
    // The meeting-grade ggml models carry the same tradeoff sentence in every
    // picker: what they add over Parakeet, where they run, and what it costs.
    return isWhisperMeetingModel(modelId)
      ? "About 100 languages, slower than Parakeet. For meetings in languages Parakeet v3 and Distil-Whisper can't handle."
      : "Whisper in more sizes, for people who want to choose their own trade-off.";
  }
  if (providerType === "transcribe_cpp") {
    if (modelId === "qwen3-asr-0.6b-q6_k") {
      return "Experimental English dictation. Not for meetings, and long recordings aren't tested yet.";
    }
    if (modelId === "qwen3-asr-1.7b-q8_0") {
      return "Experimental English dictation with a larger download. Not for meetings.";
    }
    if (modelId === "orukeet-r3-q8_0") {
      return "Experimental English dictation. A separate download from the other Orukeet.";
    }
    if (modelId === FLUID_SPEECH_MINI_MODEL_ID) {
      return "English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.";
    }
    if (modelId === UNDERDOG_BARK_PRO_MODEL_ID) {
      return "English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.";
    }
    if (isRecommendedSpeechRoute(providerType, modelId)) {
      return "Recommended for dictation and meetings on this Mac: one download covers both.";
    }
    return "Experimental speech model.";
  }
  if (providerType === "qwen3_asr") {
    return "Experimental. Built for 30 languages and 22 Chinese dialects. Tested in English in Plainsong.";
  }
  return capabilityBadge === "Dictation and meetings"
    ? "Works for both dictation and meetings."
    : capabilityBadge === "Meetings"
      ? "Made for longer recordings like meetings."
      : "Made for fast everyday dictation.";
}

function routeLaneCompatibility(
  provider: RouteSelectableProvider,
  modelId: string,
): Record<AsrRouteLane, boolean> {
  // Apple Speech is the one route whose meeting eligibility depends on the
  // machine rather than the model id: only its SpeechAnalyzer engine returns
  // the per-segment timestamps a meeting transcript is assembled from.
  if (provider.providerType === "macos_apple_speech") {
    const meeting = appleSpeechServesMeetings(provider.platformReadiness);
    return { dictation: true, meeting, shared: meeting };
  }
  return {
    dictation: true,
    meeting: isMeetingEligibleModel(provider.providerType, modelId),
    shared: isSharedMeetingCompatible(provider.providerType, modelId),
  };
}

/**
 * Whether a route counts as experimental in one lane.
 *
 * GGUF Parakeet is recommended for dictation and meetings: it made fewer word
 * errors than the ONNX int8 route on dictation clips and on recorded meetings
 * through the chunked meeting path, at about half the memory. So in those two
 * lanes it ranks ahead of ONNX Parakeet, and a GGUF model already on disk for
 * dictation outranks an ONNX one that still needs downloading -- one download
 * covers both.
 *
 * The shared lane still sorts every transcribe.cpp route last and never
 * recommends one, mirroring settings.rs: a new install keeps the shared
 * default on ONNX Parakeet (`apply_fresh_install_route`) as the sidecar's
 * nearest substitute when the GGUF model is missing, and gives the two lanes
 * their own GGUF selections instead of one shared GGUF route.
 */
function isExperimentalInLane(route: AsrRouteCatalogEntry, lane: AsrRouteLane) {
  return (
    route.experimental ||
    (lane === "shared" && route.providerType === "transcribe_cpp")
  );
}

function routeSortBucket(
  route: AsrRouteCatalogEntry,
  lane: AsrRouteLane,
): number {
  if (isExperimentalInLane(route, lane)) {
    return 5;
  }

  if (route.readiness === "ready") {
    if (
      lane === "dictation" &&
      route.hosting === "cloud"
    ) {
      return 1;
    }
    return 0;
  }

  if (route.readiness === "needs_download") {
    return 2;
  }
  if (route.readiness === "requires_key") {
    return 3;
  }
  if (route.readiness === "missing_runtime") {
    return 4;
  }
  return 6;
}

function routeProviderRank(
  route: AsrRouteCatalogEntry,
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  const order = laneProviderOrder(lane, meetingRoutePolicy);
  const index = order.indexOf(route.providerType);
  return index === -1 ? order.length : index;
}

function sortRoutesForLane(
  routes: AsrRouteCatalogEntry[],
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  return [...routes].sort((left, right) => {
    const bucketDelta = routeSortBucket(left, lane) - routeSortBucket(right, lane);
    if (bucketDelta !== 0) {
      return bucketDelta;
    }

    const providerDelta =
      routeProviderRank(left, lane, meetingRoutePolicy) -
      routeProviderRank(right, lane, meetingRoutePolicy);
    if (providerDelta !== 0) {
      return providerDelta;
    }

    return compareStrings(left.label, right.label);
  });
}

/**
 * The routes a lane can use, best first. The dictation and meeting lanes are
 * what pickers offer, so a superseded route (ONNX Parakeet where GGUF
 * Parakeet can run) is never among them; the shared lane is the sidecar's
 * fallback and keeps it.
 */
export function getLaneRoutes(
  routes: AsrRouteCatalogEntry[],
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  return sortRoutesForLane(
    routes.filter(
      (route) => route.laneCompatibility[lane] && !(route.superseded && lane !== "shared"),
    ),
    lane,
    meetingRoutePolicy,
  );
}

/**
 * The route the app recommends for a lane, or null when only experimental
 * routes are compatible. Sorting already pushes experimental routes to the
 * back, but a Qwen-only (or Candle-only) inventory would still surface one
 * as "recommended" -- and the first-run wizard saves this as the meeting
 * route -- so experimental routes are excluded outright rather than ranked.
 */
export function getRecommendedLaneRoute(
  routes: AsrRouteCatalogEntry[],
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  return (
    getLaneRoutes(routes, lane, meetingRoutePolicy).find(
      (route) => !isExperimentalInLane(route, lane),
    ) ?? null
  );
}

export function buildAsrRouteCatalog(
  providers: RouteSelectableProvider[],
  meetingRoutePolicy: MeetingRoutePolicy,
): AsrRouteCatalogEntry[] {
  const efficientParakeet = efficientParakeetOffered(providers);
  const baseRoutes = providers.flatMap((provider) =>
    provider.modelOptions.map((option) => {
      const hosting = routeHosting(provider.providerType);
      const readiness = routeReadiness(provider, hosting);
      const capabilityBadge = routeCapabilityBadge(provider, option.id);
      const actionState = routeAction(provider, readiness, hosting);
      const capability = getAsrModelCapabilityFor(provider, option.id);

      return {
        routeId: routeIdFor(provider.providerType, option.id),
        providerType: provider.providerType,
        modelId: option.id,
        label: routeDisplayLabel(provider.providerType, option.id, option.label),
        providerLabel: provider.name,
        providerDescription: provider.description,
        laneCompatibility: routeLaneCompatibility(provider, option.id),
        hosting,
        readiness,
        readinessDetail: buildReadinessDetail(provider),
        selectable:
          provider.providerType !== "macos_apple_speech" || readiness === "ready",
        downloadable: isDownloadableProvider(provider.providerType),
        experimental: isExperimentalRoute(provider.providerType, option.id),
        capabilityBadge,
        readinessLabel: routeReadinessLabel(provider, readiness),
        action: actionState.action,
        actionLabel: actionState.actionLabel,
        summary: routeSummary(provider.providerType, option.id, capabilityBadge),
        capability,
        capabilitySummary: describeAsrModel(provider.providerType, option.id, capability),
        superseded:
          efficientParakeet && isOnnxParakeetRoute(provider.providerType, option.id),
        recommendedRank: {
          dictation: null,
          meeting: null,
          shared: null,
        } as Record<AsrRouteLane, number | null>,
      } satisfies AsrRouteCatalogEntry;
    }),
  );

  for (const lane of ["shared", "dictation", "meeting"] as const) {
    getLaneRoutes(baseRoutes, lane, meetingRoutePolicy).forEach((route, index) => {
      const match = baseRoutes.find((entry) => entry.routeId === route.routeId);
      if (match) {
        match.recommendedRank[lane] = index;
      }
    });
  }

  return baseRoutes;
}
