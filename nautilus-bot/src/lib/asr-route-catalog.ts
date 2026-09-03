import { normalizeDownloadStatus } from "@/lib/download-status";
import {
  appleSpeechServesMeetings,
  describeAsrModel,
  getAsrModelCapability,
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
  capabilityBadge: "Best for dictation" | "Best for meetings" | "Shared";
  readinessLabel: string;
  action: AsrRouteAction;
  actionLabel: string | null;
  summary: string;
  /** Size, language coverage, tier and pause behaviour. Null for cloud routes. */
  capability: AsrModelCapability | null;
  /** One honest sentence including the downside. Null when no metadata exists. */
  capabilitySummary: string | null;
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
const DICTATION_PROVIDER_ORDER: AsrProviderType[] = [
  "moonshine",
  "macos_apple_speech",
  "windows_sdk_dictation",
  "parakeet",
  "whisper",
  "distil_whisper",
  "whisper_candle",
  "qwen3_asr",
  "transcribe_cpp",
  "openai_cloud",
  "elevenlabs_scribe",
  "groq",
  "cohere_transcribe",
];

// Parakeet stays first in every policy. whisper.cpp (only its multilingual
// small+ models reach this lane -- see `isWhisperMeetingModel`) sits after it
// and before Distil: it is the local route for the ~100 languages Parakeet v3
// lacks, at the cost of being slower than Parakeet on long audio.
const MEETING_PROVIDER_ORDER_BY_POLICY: Record<
  MeetingRoutePolicy,
  AsrProviderType[]
> = {
  prefer_local: [
    "parakeet",
    "whisper",
    "distil_whisper",
    // Apple Speech reaches this lane only on a Mac running SpeechAnalyzer with
    // the language installed (see `routeLaneCompatibility`). It ranks after
    // the three routes above -- they are what the meeting lane has been
    // measured on -- but ahead of every cloud route, because it needs no
    // account and never leaves the machine.
    "macos_apple_speech",
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
  ],
  best_available: [
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
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
  const locale = readiness.locale ?? "this language";

  if (!readiness.speechAnalyzerAvailable) {
    return `Runs SFSpeechRecognizer${version}. SpeechAnalyzer needs macOS 26 or later.`;
  }
  if (readiness.engine === "speech_analyzer") {
    return `Runs SpeechAnalyzer${version} with the ${locale} language installed. Nothing to download.`;
  }
  if (!readiness.speechAnalyzerLocaleSupported) {
    return `Runs SFSpeechRecognizer${version}. SpeechAnalyzer is available but does not cover ${locale}.`;
  }
  return `Runs SFSpeechRecognizer${version}. Install the ${locale} language to switch to SpeechAnalyzer.`;
}

/// Builds the human-readable readiness detail string for a route.
///
/// For Apple Speech this names the engine that will actually run and the
/// language-asset state behind that choice, because which of the two engines
/// runs decides whether the route has timestamps and whether meetings can use
/// it at all.
function buildReadinessDetail(provider: RouteSelectableProvider): string | null {
  const base = provider.platformReadiness?.message ?? null;
  if (
    provider.providerType === "macos_apple_speech" &&
    provider.platformReadiness
  ) {
    const engineNote = describeAppleSpeechEngine(provider.platformReadiness);
    return base ? `${base}. ${engineNote}` : engineNote;
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
        return "Ready on-device";
      case "authorization_not_determined":
        return "Permission required";
      case "authorization_denied":
        return "Permission denied";
      case "authorization_restricted":
        return "Permission restricted";
      case "unsupported_locale":
        return "Locale unsupported";
      case "on_device_unavailable":
        return "On-device unavailable";
      case "helper_missing":
        return "Helper missing";
      case "recognizer_unavailable":
        return "Temporarily unavailable";
      case "unsupported_platform":
        return "Unsupported platform";
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
      return "BYOK required";
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
): "Best for dictation" | "Best for meetings" | "Shared" {
  const lanes = routeLaneCompatibility(provider, modelId);
  if (lanes.shared) {
    return "Shared";
  }
  if (lanes.meeting) {
    return "Best for meetings";
  }
  return "Best for dictation";
}

function isExperimentalRoute(providerType: AsrProviderType, modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  return (
    providerType === "whisper_candle" ||
    providerType === "qwen3_asr" ||
    // The transcribe.cpp spike: a second inference runtime behind an off-by-
    // default Cargo feature. Offered when a build has it, never recommended.
    providerType === "transcribe_cpp" ||
    normalized.includes("experimental") ||
    normalized === "parakeet-tdt-ctc-110m"
  );
}

function routeDisplayLabel(
  providerType: AsrProviderType,
  modelId: string,
  upstreamLabel: string,
) {
  if (
    providerType === "parakeet" &&
    modelId === "parakeet-tdt-0.6b-v3"
  ) {
    return "Parakeet TDT 0.6B v3";
  }

  return upstreamLabel;
}

function routeSummary(
  providerType: AsrProviderType,
  modelId: string,
  capabilityBadge: AsrRouteCatalogEntry["capabilityBadge"],
) {
  if (providerType === "moonshine") {
    return "Lowest-friction local dictation route for fast everyday writing.";
  }
  if (providerType === "distil_whisper") {
    return "English-only accuracy alternative that is slower on long local meetings.";
  }
  if (providerType === "parakeet") {
    // The only surviving non-v3 route is the legacy 110M export, which is
    // English-only and short-form -- it must not claim meeting coverage.
    return modelId === "parakeet-tdt-0.6b-v3"
      ? "Fast local long-form meeting route with the current recommended Parakeet release."
      : "Legacy English-only Parakeet export, kept as a short-form dictation fallback.";
  }
  if (providerType === "openai_cloud") {
    // Only whisper-1 requests OpenAI's verbose_json response format
    // (openai_cloud.rs's uses_verbose_json()), which is what actually
    // returns segment timestamps -- gpt-transcribe and the gpt-4o-*
    // transcribe models return a single un-timed block, so they never
    // appear as meeting routes (see isMeetingEligibleModel).
    return modelId === "whisper-1"
      ? "Cloud transcription route with segment timestamps, tuned for meeting and dictation output."
      : "Cloud transcription route for dictation; no segment timestamps, so it is not offered for meetings.";
  }
  if (providerType === "elevenlabs_scribe") {
    return "Cloud route aimed at premium meeting and transcription quality.";
  }
  if (providerType === "groq") {
    return "Cloud route optimized for low-latency Whisper-style transcription.";
  }
  if (providerType === "cohere_transcribe") {
    return "Cloud route for meeting-grade transcription with a simple BYOK setup.";
  }
  if (providerType === "macos_apple_speech") {
    return capabilityBadge === "Best for dictation"
      ? "On-device Apple Speech for direct dictation only; server fallback is disabled and meetings use a separate provider."
      : "On-device Apple Speech through SpeechAnalyzer: nothing to download, per-segment timestamps for meetings, and server fallback disabled.";
  }
  if (providerType === "windows_sdk_dictation") {
    return "Built into Windows and convenient for direct dictation, but not a meeting route.";
  }
  if (providerType === "whisper_candle") {
    return "Whisper Large v3 Turbo run via Candle instead of whisper.cpp — a fallback engine, not a different model from the whisper.cpp large-v3-turbo route.";
  }
  if (providerType === "whisper") {
    // The meeting-grade ggml models carry the same tradeoff sentence in every
    // picker: what they add over Parakeet, where they run, and what it costs.
    return isWhisperMeetingModel(modelId)
      ? "100 languages, runs on the GPU, slower than Parakeet. Local route for meetings in languages Parakeet v3 and Distil-Whisper cannot hear."
      : "Flexible Whisper family for local power users who want finer model control.";
  }
  if (providerType === "transcribe_cpp") {
    return "Experimental second engine for the Parakeet weights, run on Metal through transcribe.cpp instead of the CPU ONNX runtime; a separate download from the Parakeet route.";
  }
  if (providerType === "qwen3_asr") {
    return "Experimental local route with the widest language list here, including Chinese, Japanese and Korean; slower than real time on the CPU.";
  }
  return capabilityBadge === "Shared"
    ? "One route that stays viable for both dictation and meetings."
    : capabilityBadge === "Best for meetings"
      ? "Meeting-focused route for longer recordings and summaries."
      : "Dictation-focused route for fast everyday text entry.";
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

function routeSortBucket(
  route: AsrRouteCatalogEntry,
  lane: AsrRouteLane,
): number {
  if (route.experimental) {
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

    return left.label.localeCompare(right.label);
  });
}

export function getLaneRoutes(
  routes: AsrRouteCatalogEntry[],
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  return sortRoutesForLane(
    routes.filter((route) => route.laneCompatibility[lane]),
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
      (route) => !route.experimental,
    ) ?? null
  );
}

export function buildAsrRouteCatalog(
  providers: RouteSelectableProvider[],
  meetingRoutePolicy: MeetingRoutePolicy,
): AsrRouteCatalogEntry[] {
  const baseRoutes = providers.flatMap((provider) =>
    provider.modelOptions.map((option) => {
      const hosting = routeHosting(provider.providerType);
      const readiness = routeReadiness(provider, hosting);
      const capabilityBadge = routeCapabilityBadge(provider, option.id);
      const actionState = routeAction(provider, readiness, hosting);

      return {
        routeId: routeIdFor(provider.providerType, option.id),
        providerType: provider.providerType,
        modelId: option.id,
        label: routeDisplayLabel(
          provider.providerType,
          option.id,
          option.label,
        ),
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
        capability: getAsrModelCapability(provider.providerType, option.id),
        capabilitySummary: describeAsrModel(provider.providerType, option.id),
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
