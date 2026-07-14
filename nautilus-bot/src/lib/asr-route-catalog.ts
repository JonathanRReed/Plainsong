import { normalizeDownloadStatus } from "@/lib/download-status";
import {
  isDownloadableProvider,
  isMeetingEligibleModel,
  isSharedMeetingCompatible,
  modelSupportsMlxAcceleration,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
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
  downloadable: boolean;
  experimental: boolean;
  supportsMlxAcceleration: boolean;
  capabilityBadge: "Best for dictation" | "Best for meetings" | "Shared";
  readinessLabel: string;
  action: AsrRouteAction;
  actionLabel: string | null;
  summary: string;
  recommendedRank: Record<AsrRouteLane, number | null>;
}

// Ordered so the recommended dictation route lands on whisper.cpp base.en --
// the deliberately fast default (see settings.rs's default_provider doc) --
// rather than the heavier distil_whisper route. Platform-native engines still
// rank first where available.
const DICTATION_PROVIDER_ORDER: AsrProviderType[] = [
  "moonshine",
  "macos_apple_speech",
  "windows_sdk_dictation",
  "whisper",
  "distil_whisper",
  "whisper_candle",
  "openai_cloud",
  "elevenlabs_scribe",
  "groq",
  "cohere_transcribe",
  "parakeet",
  "voxtral",
];

const MEETING_PROVIDER_ORDER_BY_POLICY: Record<
  MeetingRoutePolicy,
  AsrProviderType[]
> = {
  prefer_local: [
    "distil_whisper",
    "parakeet",
    "voxtral",
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
    "distil_whisper",
    "parakeet",
    "voxtral",
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

function routeHosting(
  providerType: AsrProviderType,
  modelId: string,
): AsrRouteHosting {
  if (
    providerType === "macos_apple_speech" ||
    providerType === "windows_sdk_dictation"
  ) {
    return "platform";
  }

  return providerHostingPreference(providerType, modelId) === "cloud"
    ? "cloud"
    : "local";
}

function routeReadiness(
  provider: RouteSelectableProvider,
  hosting: AsrRouteHosting,
): AsrRouteReadiness {
  if (!provider.inferenceEnabled) {
    return "unavailable";
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

function routeReadinessLabel(readiness: AsrRouteReadiness) {
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
  providerType: AsrProviderType,
  readiness: AsrRouteReadiness,
  hosting: AsrRouteHosting,
): { action: AsrRouteAction; actionLabel: string | null } {
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
    (providerType === "macos_apple_speech" ||
      providerType === "windows_sdk_dictation")
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
    normalized.includes("experimental") ||
    normalized === "parakeet-ctc-1.1b" ||
    normalized === "parakeet-tdt-ctc-110m" ||
    normalized === "voxtral-small"
  );
}

function routeSummary(
  providerType: AsrProviderType,
  modelId: string,
  capabilityBadge: AsrRouteCatalogEntry["capabilityBadge"],
  hosting: AsrRouteHosting,
) {
  if (providerType === "moonshine") {
    return "Lowest-friction local dictation route for fast everyday writing.";
  }
  if (providerType === "distil_whisper") {
    return "Balanced default with strong local speed and good meeting coverage.";
  }
  if (providerType === "parakeet") {
    return modelId === "parakeet-tdt-0.6b-v3"
      ? "Higher-accuracy local meeting route with the current recommended Parakeet release."
      : "Parakeet accuracy route for meetings and longer recordings.";
  }
  if (providerType === "openai_cloud") {
    return "Cloud transcription route tuned for higher-quality meeting and dictation output.";
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
    return "Built into macOS and convenient for direct dictation, but not a meeting route.";
  }
  if (providerType === "windows_sdk_dictation") {
    return "Built into Windows and convenient for direct dictation, but not a meeting route.";
  }
  if (providerType === "whisper_candle") {
    return "Whisper Large v3 Turbo run via Candle instead of whisper.cpp — a fallback engine, not a different model from the whisper.cpp large-v3-turbo route.";
  }
  if (providerType === "whisper") {
    return "Flexible Whisper family for local power users who want finer model control.";
  }
  if (providerType === "voxtral") {
    return hosting === "cloud"
      ? "Cloud Voxtral route for users who want managed setup over local assets."
      : "Meeting-capable local route with MLX acceleration support on Apple Silicon.";
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

export function getRecommendedLaneRoute(
  routes: AsrRouteCatalogEntry[],
  lane: AsrRouteLane,
  meetingRoutePolicy: MeetingRoutePolicy,
) {
  return getLaneRoutes(routes, lane, meetingRoutePolicy)[0] ?? null;
}

export function buildAsrRouteCatalog(
  providers: RouteSelectableProvider[],
  meetingRoutePolicy: MeetingRoutePolicy,
): AsrRouteCatalogEntry[] {
  const baseRoutes = providers.flatMap((provider) =>
    provider.providerType === "mlx_audio"
      ? []
      : provider.modelOptions.map((option) => {
          const hosting = routeHosting(provider.providerType, option.id);
          const readiness = routeReadiness(provider, hosting);
          const capabilityBadge = routeCapabilityBadge(
            provider.providerType,
            option.id,
          );
          const actionState = routeAction(
            provider.providerType,
            readiness,
            hosting,
          );

          return {
            routeId: routeIdFor(provider.providerType, option.id),
            providerType: provider.providerType,
            modelId: option.id,
            label: option.label,
            providerLabel: provider.name,
            providerDescription: provider.description,
            laneCompatibility: routeLaneCompatibility(provider.providerType, option.id),
            hosting,
            readiness,
            downloadable: isDownloadableProvider(provider.providerType),
            experimental: isExperimentalRoute(provider.providerType, option.id),
            supportsMlxAcceleration: modelSupportsMlxAcceleration(
              provider.providerType,
              option.id,
            ),
            capabilityBadge,
            readinessLabel: routeReadinessLabel(readiness),
            action: actionState.action,
            actionLabel: actionState.actionLabel,
            summary: routeSummary(
              provider.providerType,
              option.id,
              capabilityBadge,
              hosting,
            ),
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
