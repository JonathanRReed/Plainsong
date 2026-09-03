import { normalizeDownloadStatus } from "@/lib/download-status";
import {
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
  "deepgram",
  "gemini_transcribe",
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
    "deepgram",
    "gemini_transcribe",
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
  ],
  // Deepgram and Gemini lead the cloud order for meetings because they are the
  // only two routes that return speaker labels with the transcript; every
  // other cloud route still pays for a local diarization pass afterwards.
  best_available: [
    "deepgram",
    "gemini_transcribe",
    "openai_cloud",
    "elevenlabs_scribe",
    "groq",
    "cohere_transcribe",
    "parakeet",
    "whisper",
    "distil_whisper",
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

/// Builds the human-readable readiness detail string for a route.
///
/// For Apple Speech, this appends a note about the SpeechAnalyzer API
/// (macOS 26+) when it is available, so the route catalog surfaces the
/// newer streaming-capable framework to the UI.
function buildReadinessDetail(provider: RouteSelectableProvider): string | null {
  const base = provider.platformReadiness?.message ?? null;
  if (
    provider.providerType === "macos_apple_speech" &&
    provider.platformReadiness?.speechAnalyzerAvailable
  ) {
    const analyzerNote = `SpeechAnalyzer API available${
      provider.platformReadiness.operatingSystemVersion
        ? ` (macOS ${provider.platformReadiness.operatingSystemVersion})`
        : ""
    }`;
    return base ? `${base}. ${analyzerNote}` : analyzerNote;
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
  providerType: AsrProviderType,
  modelId: string,
): "Best for dictation" | "Best for meetings" | "Shared" {
  if (isSharedMeetingCompatible(providerType, modelId)) {
    return "Shared";
  }
  if (isMeetingEligibleModel(providerType, modelId)) {
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
  if (providerType === "deepgram") {
    // The per-minute rate belongs in the picker, not only in the model label
    // the sidecar sends: this is the line a user reads while choosing.
    return modelId === "nova-3-medical"
      ? "Deepgram's clinical-vocabulary build, English only, with the same speaker labels and word timestamps as Nova-3. Billed to your Deepgram key at $0.0043/min."
      : "Fastest cloud route here, and the cheapest with speaker labels: meetings keep Deepgram's own speakers instead of running a second pass on this Mac. Billed to your Deepgram key at $0.0043/min in English, $0.0052/min on any other language setting including auto.";
  }
  if (providerType === "gemini_transcribe") {
    return "Lowest published word error rate of the cloud routes, with speaker labels and word timestamps. Its API refuses your dictionary on the same request, so meetings get speakers and dictation gets the dictionary. Billed to your Google key at $0.005/min.";
  }
  if (providerType === "macos_apple_speech") {
    return "On-device Apple Speech for direct dictation only; server fallback is disabled and meetings use a separate provider.";
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
  providerType: AsrProviderType,
  modelId: string,
): Record<AsrRouteLane, boolean> {
  return {
    dictation: true,
    meeting: isMeetingEligibleModel(providerType, modelId),
    shared: isSharedMeetingCompatible(providerType, modelId),
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
      const capabilityBadge = routeCapabilityBadge(provider.providerType, option.id);
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
        laneCompatibility: routeLaneCompatibility(provider.providerType, option.id),
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
