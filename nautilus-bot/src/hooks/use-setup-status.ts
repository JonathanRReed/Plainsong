import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAsrProviders, listDownloadedModels } from "@/lib/backend/asr";
import {
  buildDownloadedModelIndex,
  isModelOnDisk,
  type DownloadedModelIndex,
} from "@/components/models/downloaded-models";
import {
  getPermissionDiagnostics,
  getSettings,
  hasProviderSecret,
  type PermissionDiagnostics,
} from "@/lib/backend/settings";
import {
  getNativeTextModelStatus,
  getAppleLanguageModelAvailability,
  getLocalTextRuntimeHealth,
  getOllamaStatus,
  listOllamaModelCatalog,
  listOllamaModels,
} from "@/lib/backend/ai";
import {
  isDictationOnlyAnalysisProvider,
  isRemoteAnalysisProvider,
} from "@/components/models/ai-lanes";
import {
  AI_NOTES_PREFERENCE_EVENT,
  readAiNotesOptOut,
} from "@/lib/ai-notes-preference";
import {
  resolveMeetingNotesRoute,
  type MeetingNotesRouteAssessment,
} from "@/features/readiness/meeting-notes-route";
import {
  describeSidecarLoss,
  parseSidecarRuntimeEvent,
  SIDECAR_RUNTIME_EVENT,
  type SidecarLossNotice,
} from "@/lib/sidecar-runtime";
import {
  getSystemAudioCapability,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import {
  isCloudProvider,
  isDownloadableProvider,
  isMeetingEligibleProvider,
  isMeetingEligibleModel,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import {
  buildProductReadinessSnapshot,
  type ProductReadinessSnapshot,
  type ProductReadinessEvidence,
} from "@/features/readiness/product-readiness";
import { invoke, listen } from "@/lib/electron";
import { routeDisplayLabel } from "@/lib/asr-route-catalog";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import type { Settings } from "@/types/settings";
import { probeOllamaModelReadiness } from "@/lib/ollama-model-readiness";
import {
  CHATGPT_PLAN_PROVIDER,
  getChatGptPlanStatus,
} from "@/lib/backend/chatgpt-plan";

interface SetupRouteStatus {
  providerType: AsrProviderType | null;
  modelId: string | null;
  provider: AsrProviderInfo | null;
  summary: string;
  ready: boolean;
  reason: string | null;
}

interface SetupStatusSnapshot {
  settings: Settings | null;
  providers: AsrProviderInfo[];
  permissions: PermissionDiagnostics | null;
  systemAudioAvailable: boolean | null;
  loopbackDevice: string | null;
  systemAudioCapability: SystemAudioCapability | null;
  meetingCaptureMode: "me_and_them" | "mic_only" | "unknown";
  dictationRoutePreference: "local" | "cloud";
  dictationLocalReady: boolean;
  dictationCloudReady: boolean;
  meetingRoutePolicy: "prefer_local" | "best_available";
  dictationRoute: SetupRouteStatus;
  meetingRoute: SetupRouteStatus;
  microphoneReady: boolean;
  dictationReady: boolean;
  meetingReady: boolean;
  fullCaptureReady: boolean;
  dictationBlockers: string[];
  meetingBlockers: string[];
  fullCaptureBlockers: string[];
  meetingNotesRoute: MeetingNotesRouteAssessment;
  productReadiness: ProductReadinessSnapshot;
  productReadinessEvidence: ProductReadinessEvidence;
}

/**
 * What the renderer observed about the meetings AI lane. Kept separate from the
 * settings-declared provider so an unanswered probe stays `null` instead of
 * collapsing into "not ready".
 */
export interface MeetingNotesRouteProbe {
  optedOut: boolean;
  localRuntimeReady: boolean | null;
  localModelReady: boolean | null;
  localModelId: string | null;
  credentialPresent: boolean | null;
  nativeMemoryReady?: boolean;
  localExecutionReady?: boolean | null;
  localExecutionMessage?: string | null;
  accountRoute?: "ready" | "check_account" | "connect" | "choose_model";
}

interface SetupStatusSourceState {
  observedAt?: number;
  loading?: boolean;
  error?: string | null;
  settingsLoaded?: boolean;
  providersLoaded?: boolean;
}

function resolveSharedSelection(settings: Settings | null, kind: "dictation" | "meeting") {
  if (!settings) {
    return { providerType: null, modelId: null };
  }

  const shared = settings.transcription.useSharedAsrSelection;
  const providerType = shared
    ? ((settings.transcription.defaultProvider ?? null) as AsrProviderType | null)
    : ((kind === "dictation"
        ? settings.transcription.dictationProvider
        : settings.transcription.meetingProvider) ?? null);
  const modelId = shared
    ? settings.transcription.selectedModelId ?? null
    : kind === "dictation"
      ? settings.transcription.dictationModelId ?? null
      : settings.transcription.meetingModelId ?? null;

  return {
    providerType: providerType as AsrProviderType | null,
    modelId,
  };
}

/** The speech model's name as the model pickers show it. */
function speechModelName(
  provider: AsrProviderInfo,
  modelId: string,
): string {
  const modelLabel =
    provider.modelOptions.find((option) => option.id === modelId)?.label ?? modelId;
  return routeDisplayLabel(provider.providerType, modelId, modelLabel);
}

/**
 * "Parakeet v3", or "Deepgram · Nova-3" for a cloud service. A local model
 * is named on its own: which program runs it on this Mac is not the reader's
 * concern, while a cloud service is where the audio goes.
 */
function summarizeRoute(
  provider: AsrProviderInfo | null,
  modelId: string | null,
) {
  if (!provider) {
    return "Not selected";
  }

  if (!modelId) {
    return provider.name;
  }

  const name = speechModelName(provider, modelId);
  return isCloudProvider(provider.providerType) ? `${provider.name} · ${name}` : name;
}

type RouteDiagnostics = Pick<AsrProviderInfo,
  "providerType" | "selectedModelId" | "runtimeStatus" | "runtimeDetails"
> & { runtimeMessage: string | null };

type RouteDiagnosticsMap = Map<string, RouteDiagnostics | null>;

function routeDiagnosticsKey(providerType: AsrProviderType, modelId: string) {
  return `${providerType}:${modelId}`;
}

/**
 * The meeting route the sidecar falls back to when the configured one is not
 * ready, or null when none is. Mirrors `preferred_meeting_provider_candidates`
 * and `select_ready_meeting_candidate` in rust-sidecar/src/asr_routing.rs:
 * the meeting slot, then ONNX Parakeet when the slot names a GGUF route (the
 * same weights), then the shared default, the dictation slot, ONNX Parakeet
 * and Distil-Whisper. whisper.cpp, Apple Speech and transcribe.cpp are
 * candidates only when the meeting slot itself names them; cloud routes only
 * under Best available and only when the meeting slot names them. Each
 * candidate runs on the model its provider has selected, which must be a
 * meeting model and on disk.
 */
function readyMeetingSubstitute(
  settings: Settings,
  providers: AsrProviderInfo[],
  downloadedModels: DownloadedModelIndex | null,
): { provider: AsrProviderInfo; modelId: string } | null {
  const transcription = settings.transcription;
  const meetingProvider = (transcription.meetingProvider ?? null) as AsrProviderType | null;
  const policy = transcription.meetingRoutePolicy === "best_available" ? "best_available" : "prefer_local";
  const defaultProvider = (transcription.defaultProvider ?? null) as AsrProviderType | null;
  const dictationProvider =
    (transcription.dictationProvider as AsrProviderType | undefined) ?? defaultProvider;
  const candidates: Array<AsrProviderType | null> = [
    meetingProvider,
    meetingProvider === "transcribe_cpp" ? "parakeet" : null,
    defaultProvider,
    dictationProvider,
    "parakeet",
    "distil_whisper",
  ];
  const slotOnly = new Set<AsrProviderType>(["whisper", "macos_apple_speech", "transcribe_cpp"]);
  const seen = new Set<AsrProviderType>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const named = candidate === meetingProvider;
    if (slotOnly.has(candidate) && !named) continue;
    if (isCloudProvider(candidate) && (policy === "prefer_local" || !named)) continue;
    const provider = providers.find((item) => item.providerType === candidate);
    if (!provider) continue;
    const modelId = provider.selectedModelId;
    if (
      provider.inferenceEnabled &&
      provider.runtimeStatus === "ready" &&
      isMeetingEligibleProvider(candidate) &&
      isMeetingEligibleModel(candidate, modelId ?? "") &&
      (isModelOnDisk(downloadedModels, candidate, modelId) ?? true)
    ) {
      return { provider, modelId };
    }
  }
  return null;
}

function buildRouteStatus(
  kind: "dictation" | "meeting",
  settings: Settings | null,
  providers: AsrProviderInfo[],
  permissions: PermissionDiagnostics | null,
  downloadedModels: DownloadedModelIndex | null,
  modelInventoryError: string | null,
  routeDiagnostics: RouteDiagnosticsMap,
): SetupRouteStatus {
  const { providerType, modelId } = resolveSharedSelection(settings, kind);
  const provider =
    providers.find((item) => item.providerType === providerType) ?? null;

  if (!providerType || !provider) {
    // A meeting slot naming a route this build does not list (GGUF Parakeet
    // on an Intel Mac) still records on the sidecar's fallback.
    const substitute =
      kind === "meeting" && providerType && settings
        ? readyMeetingSubstitute(settings, providers, downloadedModels)
        : null;
    if (substitute) {
      return {
        providerType: substitute.provider.providerType,
        modelId: substitute.modelId,
        provider: substitute.provider,
        summary: summarizeRoute(substitute.provider, substitute.modelId),
        ready: true,
        reason: null,
      };
    }
    return {
      providerType,
      modelId,
      provider,
      summary: "Not selected",
      ready: false,
      reason: "Choose a speech model.",
    };
  }

  const routeSummary = summarizeRoute(provider, modelId);
  const modelIsKnown = Boolean(
    modelId && provider.modelOptions.some((option) => option.id === modelId),
  );
  const selectedModelMatches = Boolean(
    modelId && provider.selectedModelId === modelId,
  );
  const modelOnDisk = modelId
    ? isModelOnDisk(downloadedModels, provider.providerType, modelId)
    : null;
  const modelInventoryBlocked = Boolean(
    modelId &&
      isDownloadableProvider(provider.providerType) &&
      modelOnDisk === null &&
      modelInventoryError
  );
  const exactModelReady = modelOnDisk ?? selectedModelMatches;
  const diagnosticKey = modelId ? routeDiagnosticsKey(provider.providerType, modelId) : null;
  const checked = diagnosticKey !== null && routeDiagnostics.has(diagnosticKey);
  const diagnostics = diagnosticKey ? routeDiagnostics.get(diagnosticKey) : null;
  const runtimeStatus = checked ? diagnostics?.runtimeStatus : provider.runtimeStatus;
  const runtimeMessage = checked ? diagnostics?.runtimeMessage : provider.runtimeMessage;
  const runtimeDetails = checked ? diagnostics?.runtimeDetails : provider.runtimeDetails;
  const runtimeReady = runtimeStatus === "ready";
  const baseReady = Boolean(
    provider.inferenceEnabled &&
      runtimeReady &&
      modelIsKnown &&
      exactModelReady &&
      !modelInventoryBlocked,
  );

  if (
    kind === "meeting" &&
    (!isMeetingEligibleProvider(provider.providerType) ||
      !isMeetingEligibleModel(provider.providerType, modelId ?? ""))
  ) {
    return {
      providerType,
      modelId,
      provider,
      summary: routeSummary,
      ready: false,
      reason: `${modelId ? speechModelName(provider, modelId) : provider.name} is for dictation only. Choose a speech model for meetings.`,
    };
  }

  if (
    provider.providerType === "macos_apple_speech" &&
    provider.platformReadiness &&
    !provider.platformReadiness.ready
  ) {
    return {
      providerType,
      modelId,
      provider,
      summary: routeSummary,
      ready: false,
      reason: provider.platformReadiness.message,
    };
  }

  if (
    provider.providerType === "macos_apple_speech" &&
    permissions &&
    !permissions.speechRecognitionReady
  ) {
    return {
      providerType,
      modelId,
      provider,
      summary: routeSummary,
      ready: false,
      reason: "Speech Recognition permission is still required for Apple Speech dictation.",
    };
  }

  if (kind === "meeting" && !baseReady && settings) {
    const substitute = readyMeetingSubstitute(settings, providers, downloadedModels);
    if (
      substitute &&
      !(substitute.provider.providerType === providerType && substitute.modelId === modelId)
    ) {
      // The configured meeting route is not ready, but the sidecar records
      // meetings on this one meanwhile: ready, naming the model that runs.
      const substituteSummary = summarizeRoute(substitute.provider, substitute.modelId);
      return {
        providerType: substitute.provider.providerType,
        modelId: substitute.modelId,
        provider: substitute.provider,
        // Both builds of Parakeet v3 share a name: the model that runs is
        // the same one, so there is nothing to wait for in the summary.
        summary:
          substituteSummary === routeSummary
            ? substituteSummary
            : `${substituteSummary}, until ${routeSummary} is ready`,
        ready: true,
        reason: null,
      };
    }
  }

  return {
    providerType,
    modelId,
    provider,
    summary: routeSummary,
    ready: baseReady,
    reason: baseReady
      ? null
      : !modelId
        ? `Choose a ${kind} speech model.`
        : !modelIsKnown
          ? `${speechModelName(provider, modelId)} is not available in this version of Plainsong. Choose another speech model.`
          : modelInventoryBlocked
            ? modelInventoryError ?? "Could not check which speech models are downloaded."
            : modelOnDisk === false
              ? `${speechModelName(provider, modelId)} is not downloaded yet.`
              : !exactModelReady
                ? `${speechModelName(provider, modelId)} has not been confirmed as the active speech model yet.`
                : runtimeStatus === "missing_model" &&
                    runtimeDetails?.missingFiles?.length
                  ? `Some of ${speechModelName(provider, modelId)}'s files are missing or damaged. Download it again.`
                  : runtimeMessage ?? `${speechModelName(provider, modelId)} is not ready yet.`,
  };
}

export function buildSnapshot(
  settings: Settings | null,
  providers: AsrProviderInfo[],
  permissions: PermissionDiagnostics | null,
  systemAudioAvailable: boolean | null,
  loopbackDevice: string | null,
  systemAudioCapability: SystemAudioCapability | null = null,
  sourceState: SetupStatusSourceState = {},
  downloadedModels: DownloadedModelIndex | null = null,
  modelInventoryError: string | null = null,
  meetingNotesProbe: MeetingNotesRouteProbe | null = null,
  routeDiagnostics: RouteDiagnosticsMap = new Map(),
): SetupStatusSnapshot {
  const dictationRoute = buildRouteStatus(
    "dictation",
    settings,
    providers,
    permissions,
    downloadedModels,
    modelInventoryError,
    routeDiagnostics,
  );
  const meetingRoute = buildRouteStatus(
    "meeting",
    settings,
    providers,
    permissions,
    downloadedModels,
    modelInventoryError,
    routeDiagnostics,
  );
  const effectiveSystemAudioAvailable = systemAudioCapability
    ? systemAudioCapability.backend !== "none"
    : systemAudioAvailable;
  const systemAudioVerified = Boolean(
    systemAudioCapability?.ready &&
      systemAudioCapability.readiness === "ready" &&
      systemAudioCapability.backend !== "none"
  );
  const effectiveLoopbackDevice =
    systemAudioCapability?.routeDevice ?? loopbackDevice;
  const dictationInsertionMode = settings?.transcription.dictationInsertionMode ?? "auto";
  const cursorInsertionRequired = dictationInsertionMode !== "clipboard_only";
  const cursorInsertionReady =
    !cursorInsertionRequired ||
    (permissions?.cursorInsertionReady ?? permissions?.accessibilityReady ?? false);
  const dictationRoutePreference =
    settings?.transcription.dictationRoutePreference === "cloud" ? "cloud" : "local";
  const meetingRoutePolicy =
    settings?.transcription.meetingRoutePolicy === "best_available"
      ? "best_available"
      : "prefer_local";
  const dictationLocalReady = providers.some(
    (provider) =>
      provider.inferenceEnabled &&
      provider.runtimeStatus === "ready" &&
      providerHostingPreference(provider.providerType) === "local"
  );
  const dictationCloudReady = providers.some(
    (provider) =>
      provider.inferenceEnabled &&
      provider.runtimeStatus === "ready" &&
      providerHostingPreference(provider.providerType) === "cloud"
  );
  const microphonePermissionReady =
    permissions?.microphonePermissionReady ?? permissions?.microphoneReady ?? false;
  const microphoneReady = Boolean(
    permissions?.microphoneReady && microphonePermissionReady
  );
  const microphoneBlocker = !microphonePermissionReady
    ? "Microphone permission is still required."
    : !microphoneReady
      ? "No microphone input device is currently available."
      : null;
  const dictationReady = Boolean(
    microphoneReady && dictationRoute.ready && cursorInsertionReady
  );
  const speechRecognitionRequiredForDictation =
    dictationRoute.providerType === "macos_apple_speech";
  const meetingReady = Boolean(microphoneReady && meetingRoute.ready);
  const fullCaptureReady = Boolean(meetingReady && systemAudioVerified);
  const dictationBlockers = [
    microphoneBlocker,
    speechRecognitionRequiredForDictation &&
    !(permissions?.speechRecognitionReady ?? true)
      ? "Speech Recognition permission is still required for Apple Speech dictation."
      : null,
    !cursorInsertionReady && cursorInsertionRequired
      ? "Cursor insertion is still required for the current dictation mode."
      : null,
    !dictationRoute.ready ? dictationRoute.reason : null,
  ].filter((value): value is string => Boolean(value));
  const meetingBlockers = [
    microphoneBlocker,
    !meetingRoute.ready ? meetingRoute.reason : null,
  ].filter((value): value is string => Boolean(value));
  const fullCaptureBlockers = [
    ...meetingBlockers,
    effectiveSystemAudioAvailable === false
      ? systemAudioCapability?.actionableReason ??
        "Plainsong can't record the meeting audio on this Mac yet, so meetings record your microphone only."
      : null,
    effectiveSystemAudioAvailable === true && !systemAudioVerified
      ? systemAudioCapability?.actionableReason ??
        "Plainsong hasn't checked the meeting audio yet. Choose Check meeting audio before using Me + Them."
      : null,
    !effectiveLoopbackDevice && effectiveSystemAudioAvailable === false
      ? "Plainsong found no way to record the meeting audio for Me + Them."
      : null,
  ].filter((value): value is string => Boolean(value));
  const meetingNotesRoute = resolveMeetingNotesRoute({
    optedOut: meetingNotesProbe?.optedOut ?? false,
    provider: settings?.privacy?.meetingsAi?.provider ?? null,
    remoteProcessingEnabled: settings?.privacy?.remoteProcessingEnabled ?? false,
    localRuntimeReady: meetingNotesProbe
      ? meetingNotesProbe.localRuntimeReady
      : null,
    localModelReady: meetingNotesProbe
      ? meetingNotesProbe.localModelReady
      : null,
    localModelId: meetingNotesProbe ? meetingNotesProbe.localModelId : null,
    credentialPresent: meetingNotesProbe
      ? meetingNotesProbe.credentialPresent
      : null,
    accountRoute: meetingNotesProbe?.accountRoute,
    nativeMemoryReady: meetingNotesProbe?.nativeMemoryReady,
    localExecutionReady: meetingNotesProbe?.localExecutionReady,
    localExecutionMessage: meetingNotesProbe?.localExecutionMessage,
  });
  const meetingCaptureMode =
    effectiveSystemAudioAvailable === null
      ? "unknown"
      : fullCaptureReady
        ? "me_and_them"
        : "mic_only";
  const productReadinessEvidence: ProductReadinessEvidence = {
    observedAt: sourceState.observedAt ?? Date.now(),
    loading: sourceState.loading ?? false,
    error: sourceState.error ?? null,
    settingsLoaded: sourceState.settingsLoaded ?? settings !== null,
    providersLoaded:
      sourceState.providersLoaded ?? providers.length > 0,
    microphonePermissionReady: permissions
      ? (permissions.microphonePermissionReady ??
        permissions.microphoneReady ??
        null)
      : null,
    microphoneDeviceReady: permissions?.microphoneReady ?? null,
    dictationRouteReady:
      settings && providers.length > 0 ? dictationRoute.ready : null,
    dictationRouteReason: dictationRoute.reason,
    cursorInsertionRequired,
    cursorInsertionReady: permissions
      ? (permissions.cursorInsertionReady ??
        permissions.accessibilityReady ??
        null)
      : null,
    meetingRouteReady:
      settings && providers.length > 0 ? meetingRoute.ready : null,
    meetingRouteReason: meetingRoute.reason,
    meetingNotesRoute: meetingNotesRoute.state,
    meetingNotesRouteReason: meetingNotesRoute.reason,
    systemAudioState: systemAudioCapability
      ? systemAudioCapability.ready &&
        systemAudioCapability.readiness === "ready"
        ? "ready"
        : systemAudioCapability.readiness === "unverified"
          ? "unverified"
          : "unavailable"
      : effectiveSystemAudioAvailable === true
        ? "unverified"
        : effectiveSystemAudioAvailable === false
          ? "unavailable"
          : "unknown",
  };
  const productReadiness = buildProductReadinessSnapshot(productReadinessEvidence);

  return {
    settings,
    providers,
    permissions,
    systemAudioAvailable: effectiveSystemAudioAvailable,
    loopbackDevice: effectiveLoopbackDevice,
    systemAudioCapability,
    meetingCaptureMode,
    dictationRoutePreference,
    dictationLocalReady,
    dictationCloudReady,
    meetingRoutePolicy,
    dictationRoute,
    meetingRoute,
    microphoneReady,
    dictationReady,
    meetingReady,
    fullCaptureReady,
    dictationBlockers,
    meetingBlockers,
    fullCaptureBlockers,
    meetingNotesRoute,
    productReadiness,
    productReadinessEvidence,
  };
}

/**
 * Ask whether the meetings AI lane can actually run: Ollama reachable for the
 * local route, a stored key for a cloud one. Every probe failure resolves to
 * `null` — "we did not get an answer" — because claiming a route is broken on a
 * failed probe is as dishonest as claiming it works.
 */
export async function probeMeetingNotesRoute(
  settings: Settings | null,
  dependencies: Partial<{
    hasProviderSecret: typeof hasProviderSecret;
    getNativeTextModelStatus: typeof getNativeTextModelStatus;
    getAppleLanguageModelAvailability: typeof getAppleLanguageModelAvailability;
    getLocalTextRuntimeHealth: typeof getLocalTextRuntimeHealth;
    getOllamaStatus: typeof getOllamaStatus;
    listOllamaModels: typeof listOllamaModels;
    listOllamaModelCatalog: typeof listOllamaModelCatalog;
    getChatGptPlanStatus: typeof getChatGptPlanStatus;
  }> = {},
): Promise<MeetingNotesRouteProbe> {
  const optedOut = readAiNotesOptOut();
  const provider = settings?.privacy?.meetingsAi?.provider?.trim() ?? "";
  if (!provider) {
    return {
      optedOut,
      localRuntimeReady: null,
      localModelReady: null,
      localModelId: null,
      credentialPresent: null,
    };
  }

  if (provider === "native_text") {
    try {
      const status = await (dependencies.getNativeTextModelStatus ?? getNativeTextModelStatus)(settings?.privacy?.meetingsAi?.modelId ?? undefined);
      const modelId = settings?.privacy?.meetingsAi?.modelId ?? status.modelId;
      const health = status.runtimeHealth;
      return { optedOut, localRuntimeReady: status.runtimePresent,
        localModelReady: status.ready && modelId === status.modelId,
        localModelId: modelId, credentialPresent: null,
        nativeMemoryReady: status.memoryAvailableBytes === null ? undefined : status.canLoadNow,
        localExecutionReady: !health || health.state === "busy" ? null : health.state === "available",
        localExecutionMessage: health?.message ?? null };
    } catch {
      return { optedOut, localRuntimeReady: null, localModelReady: null,
        localModelId: settings?.privacy?.meetingsAi?.modelId ?? null, credentialPresent: null };
    }
  }

  if (provider === "apple_language_model") {
    const status = await (dependencies.getAppleLanguageModelAvailability ?? getAppleLanguageModelAvailability)().catch(() => null);
    return { optedOut, localRuntimeReady: status?.available ?? null, localModelReady: status?.available ?? null,
      localModelId: "apple-on-device", credentialPresent: null,
      localExecutionReady: status?.available ?? null, localExecutionMessage: status?.detail ?? null };
  }

  if (provider === CHATGPT_PLAN_PROVIDER) {
    if (!settings?.privacy?.remoteProcessingEnabled) {
      return {
        optedOut,
        localRuntimeReady: null,
        localModelReady: null,
        localModelId: null,
        credentialPresent: null,
        accountRoute: "check_account",
      };
    }
    const status = await (
      dependencies.getChatGptPlanStatus ?? getChatGptPlanStatus
    )().catch(() => null);
    const selectedModel = settings.privacy.meetingsAi.modelId?.trim() ?? "";
    const active = status?.accounts.find((account) => account.active);
    const accountRoute = !status?.loaded || !status.modelsReady
      ? "check_account"
      : !active?.connected || !active.planEnabled
        ? "connect"
        : !selectedModel || !status.models.some((model) => model.slug === selectedModel)
          ? "choose_model"
          : "ready";
    return {
      optedOut,
      localRuntimeReady: null,
      localModelReady: null,
      localModelId: selectedModel || null,
      credentialPresent: null,
      accountRoute,
    };
  }

  if (isRemoteAnalysisProvider(provider)) {
    if (!settings?.privacy?.remoteProcessingEnabled) {
      return {
        optedOut,
        localRuntimeReady: null,
        localModelReady: null,
        localModelId: null,
        credentialPresent: null,
      };
    }
    const credentialPresent = await (
      dependencies.hasProviderSecret ?? hasProviderSecret
    )(provider)
      .then((present) => (typeof present === "boolean" ? present : null))
      .catch(() => null);
    return {
      optedOut,
      localRuntimeReady: null,
      localModelReady: null,
      localModelId: null,
      credentialPresent,
    };
  }

  if (isDictationOnlyAnalysisProvider(provider)) {
    return {
      optedOut,
      localRuntimeReady: null,
      localModelReady: null,
      localModelId: settings?.privacy?.meetingsAi?.modelId ?? null,
      credentialPresent: null,
    };
  }

  const local = await probeOllamaModelReadiness(
    settings?.privacy?.meetingsAi?.modelId,
    {
      getRuntimeStatus: dependencies.getOllamaStatus ?? getOllamaStatus,
      listInstalledModels: dependencies.listOllamaModels ?? listOllamaModels,
      listCatalog:
        dependencies.listOllamaModelCatalog ?? listOllamaModelCatalog,
      getRuntimeHealth: dependencies.getLocalTextRuntimeHealth ?? getLocalTextRuntimeHealth,
      remoteProcessingEnabled: settings?.privacy?.remoteProcessingEnabled,
    },
  );
  return {
    optedOut,
    localRuntimeReady: local.runtimeReady,
    localModelReady: local.modelReady,
    localModelId: local.modelId,
    credentialPresent: null,
    localExecutionReady: local.executionReady,
    localExecutionMessage: local.executionMessage,
  };
}

export function useSetupStatus() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [downloadedModels, setDownloadedModels] =
    useState<DownloadedModelIndex | null>(null);
  const [routeDiagnostics, setRouteDiagnostics] = useState<RouteDiagnosticsMap>(() => new Map());
  const [modelInventoryError, setModelInventoryError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionDiagnostics | null>(null);
  const [systemAudioCapability, setSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const [meetingNotesProbe, setMeetingNotesProbe] =
    useState<MeetingNotesRouteProbe | null>(null);
  // Engine loss, held until it recovers or the reader dismisses it. Both
  // primary views render this; before, it existed only as a raw log line on
  // the Setup view, which nobody is looking at while they dictate.
  const [engineNotice, setEngineNotice] = useState<SidecarLossNotice | null>(
    null,
  );
  // One incident, not one event. The bridge re-emits `ready:false` for the same
  // ongoing failure (an exit and an error arrive from a single dead process,
  // and each restart attempt reports again), so a dismissal keyed to the event
  // would pop the banner straight back up. Dismissal is remembered against the
  // incident and cleared by a `ready:true` — the only thing that actually ends
  // one.
  const dismissedIncidentRef = useRef<number | null>(null);
  const engineIncidentRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const refreshSequenceRef = useRef(0);
  const captureInputsCheckedRef = useRef(false);

  const refresh = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    const refreshSequence = ++refreshSequenceRef.current;
    // Focus rechecks the same setup. Keep its checked display until the answer
    // changes, rather than restarting spinners and resizing the capture card.
    // Settings writes, explicit invalidations and engine loss still clear it.
    if (!background || !captureInputsCheckedRef.current) {
      captureInputsCheckedRef.current = false;
      setLoading(true);
    }
    setError(null);

    try {
      const [
        nextSettings,
        nextProviders,
        nextDownloadedModelResult,
        nextPermissions,
        nextSystemAudioCapability,
      ] = await Promise.all([
        getSettings(),
        getAsrProviders(),
        listDownloadedModels()
          .then((files) => ({
            index: buildDownloadedModelIndex(files),
            error: null,
          }))
          .catch((nextError) => ({
            index: null,
            error:
              nextError instanceof Error && nextError.message.trim()
                ? nextError.message
                : "Could not inspect downloaded transcription models.",
          })),
        getPermissionDiagnostics().catch(() => null),
        getSystemAudioCapability().catch(() => null),
      ]);

      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
      const selectedRoutes = [
        resolveSharedSelection(nextSettings, "dictation"),
        resolveSharedSelection(nextSettings, "meeting"),
      ];
      const nextRouteDiagnostics: RouteDiagnosticsMap = new Map();
      await Promise.all(selectedRoutes.map(async ({ providerType, modelId }) => {
        const provider = nextProviders.find(item => item.providerType === providerType);
        if (!provider || !providerType || !modelId ||
          !isDownloadableProvider(providerType) ||
          (provider.runtimeStatus !== "missing_model" && provider.selectedModelId === modelId)) {
          return;
        }
        const key = routeDiagnosticsKey(providerType, modelId);
        if (nextRouteDiagnostics.has(key)) return;
        // Reserve the exact route before awaiting, so shared selections probe once.
        // A failed or mismatched response keeps this route blocked.
        nextRouteDiagnostics.set(key, null);
        try {
          const diagnostics = await invoke<RouteDiagnostics>(
            "get_asr_runtime_diagnostics", { providerType, modelId },
          );
          if (diagnostics.providerType === providerType && diagnostics.selectedModelId === modelId) {
            nextRouteDiagnostics.set(key, diagnostics);
          }
        } catch {
          // Keep the failed route's null result rather than reuse another model's status.
        }
      }));
      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
      setSettings(nextSettings);
      setProviders(nextProviders);
      setRouteDiagnostics(nextRouteDiagnostics);
      setDownloadedModels(nextDownloadedModelResult.index);
      setModelInventoryError(nextDownloadedModelResult.error);
      setPermissions(nextPermissions);
      setSystemAudioCapability(nextSystemAudioCapability);
      // Capture readiness does not depend on the meeting-notes model. Publish
      // the checked capture inputs before probing that optional lane.
      if (!background) setMeetingNotesProbe(null);
      setObservedAt(Date.now());
      captureInputsCheckedRef.current = true;
      setLoading(false);
      const nextMeetingNotesProbe = await probeMeetingNotesRoute(nextSettings)
        .catch(() => null);
      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
      setMeetingNotesProbe(nextMeetingNotesProbe);
    } catch (nextError) {
      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
      captureInputsCheckedRef.current = false;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (refreshSequence === refreshSequenceRef.current) {
        setObservedAt(Date.now());
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshSequenceRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const retainUnlistener = (unlisten: () => void) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };

    void listen("settings-changed", () => {
      if (!disposed) {
        void refresh();
      }
    })
      .then(retainUnlistener)
      .catch((nextError) => {
        console.warn(
          "Failed to subscribe to readiness settings changes:",
          nextError,
        );
      });

    void listen<[AsrProviderType, number]>(
      "asr-download-progress",
      (event) => {
        const [, percent] = event.payload;
        if (!disposed && Number.isFinite(percent) && percent >= 100) {
          void refresh();
        }
      },
    )
      .then(retainUnlistener)
      .catch((nextError) => {
        console.warn(
          "Failed to subscribe to readiness model downloads:",
          nextError,
        );
      });

    void listen("readiness-invalidated", () => {
      if (!disposed) {
        void refresh();
      }
    })
      .then(retainUnlistener)
      .catch((nextError) => {
        console.warn("Failed to subscribe to readiness invalidation:", nextError);
      });

    let runtimeRevision = 0;
    const applyRuntimeStatus = (payload: unknown) => {
      if (disposed) return;
      const runtime = parseSidecarRuntimeEvent(payload);
      if (!runtime) {
        return;
      }
      if (!runtime.ready) {
        // The bridge's own wording ("Sidecar process exited (code=1,
        // signal=null)") stays in the log and out of the interface.
        if (runtime.detail) {
          console.warn("[sidecar] runtime lost:", runtime.detail);
        }
        const notice = describeSidecarLoss(runtime.reason);
        // A loss while one is already open is the same incident continuing.
        if (engineIncidentRef.current === 0) {
          engineIncidentRef.current = Date.now();
        }
        refreshSequenceRef.current += 1;
        captureInputsCheckedRef.current = false;
        setLoading(false);
        // Readiness is blocked either way; only the banner is suppressed, and
        // only for the incident the reader actually dismissed.
        if (dismissedIncidentRef.current !== engineIncidentRef.current) {
          setEngineNotice({ ...notice });
        }
        setError(`${notice.title}. ${notice.message}`);
        setObservedAt(Date.now());
        return;
      }
      // Recovery is what ends an incident, so the next failure is a new one.
      engineIncidentRef.current = 0;
      dismissedIncidentRef.current = null;
      setEngineNotice(null);
      void refresh();
    };
    void listen(SIDECAR_RUNTIME_EVENT, (event) => {
      ++runtimeRevision;
      applyRuntimeStatus(event.payload);
    })
      .then((unlisten) => {
        retainUnlistener(unlisten);
        if (disposed) return;
        const revision = runtimeRevision;
        void invoke("get_sidecar_runtime_status").then((payload) => {
          if (disposed || runtimeRevision !== revision) return;
          const runtime = parseSidecarRuntimeEvent(payload);
          if (runtime?.ready || runtime?.reason) applyRuntimeStatus(payload);
        }).catch(() => { /* Older bridges report lifecycle events without snapshots. */ });
      })
      .catch((nextError) => {
        console.warn("Failed to subscribe to sidecar readiness:", nextError);
      });

    const handleWindowFocus = () => {
      if (!disposed) {
        void refresh({ background: true });
      }
    };
    window.addEventListener("focus", handleWindowFocus);
    // The AI-notes opt-out is renderer-local, so no backend event announces it.
    const handleAiNotesPreference = () => {
      if (!disposed) {
        void refresh();
      }
    };
    window.addEventListener(
      AI_NOTES_PREFERENCE_EVENT,
      handleAiNotesPreference,
    );

    return () => {
      disposed = true;
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener(
        AI_NOTES_PREFERENCE_EVENT,
        handleAiNotesPreference,
      );
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [refresh]);

  const snapshot = useMemo(
    () =>
      buildSnapshot(
        settings,
        providers,
        permissions,
        systemAudioCapability
          ? systemAudioCapability.backend !== "none"
          : null,
        systemAudioCapability?.routeDevice ?? null,
        systemAudioCapability,
        {
          observedAt,
          loading,
          error,
          settingsLoaded: settings !== null,
          providersLoaded: !loading && error === null,
        },
        downloadedModels,
        modelInventoryError,
        meetingNotesProbe,
        routeDiagnostics,
      ),
    [
      downloadedModels,
      routeDiagnostics,
      error,
      meetingNotesProbe,
      modelInventoryError,
      loading,
      observedAt,
      permissions,
      providers,
      settings,
      systemAudioCapability,
    ]
  );

  const dismissEngineNotice = useCallback(() => {
    dismissedIncidentRef.current = engineIncidentRef.current;
    setEngineNotice(null);
  }, []);

  return {
    ...snapshot,
    loading,
    error,
    engineNotice,
    dismissEngineNotice,
    refresh,
  };
}
