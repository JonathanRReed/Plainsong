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
import { getOllamaStatus } from "@/lib/backend/ai";
import { isRemoteAnalysisProvider } from "@/components/models/ai-lanes";
import {
  AI_NOTES_PREFERENCE_EVENT,
  readAiNotesOptOut,
} from "@/lib/ai-notes-preference";
import {
  resolveMeetingNotesRoute,
  type MeetingNotesRouteAssessment,
} from "@/features/readiness/meeting-notes-route";
import {
  getSystemAudioCapability,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import {
  isDownloadableProvider,
  isMeetingEligibleProvider,
  isMeetingEligibleModel,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import {
  buildProductReadinessSnapshot,
  type ProductReadinessSnapshot,
} from "@/features/readiness/product-readiness";
import { listen } from "@/lib/electron";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import type { Settings } from "@/types/settings";

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
}

/**
 * What the renderer observed about the meetings AI lane. Kept separate from the
 * settings-declared provider so an unanswered probe stays `null` instead of
 * collapsing into "not ready".
 */
export interface MeetingNotesRouteProbe {
  optedOut: boolean;
  localRuntimeReady: boolean | null;
  credentialPresent: boolean | null;
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

function summarizeRoute(provider: AsrProviderInfo | null, modelId: string | null) {
  if (!provider) {
    return "Not selected";
  }

  if (!modelId) {
    return provider.name;
  }

  const modelLabel =
    provider.modelOptions.find((option) => option.id === modelId)?.label ?? modelId;
  return `${provider.name} · ${modelLabel}`;
}

function buildRouteStatus(
  kind: "dictation" | "meeting",
  settings: Settings | null,
  providers: AsrProviderInfo[],
  permissions: PermissionDiagnostics | null,
  downloadedModels: DownloadedModelIndex | null,
  modelInventoryError: string | null
): SetupRouteStatus {
  const { providerType, modelId } = resolveSharedSelection(settings, kind);
  const provider =
    providers.find((item) => item.providerType === providerType) ?? null;

  if (!providerType || !provider) {
    return {
      providerType,
      modelId,
      provider,
      summary: "Not selected",
      ready: false,
      reason: "Choose a transcription route.",
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
  const runtimeReady =
    provider.runtimeStatus === "ready" ||
    (modelOnDisk === true && provider.runtimeStatus === "missing_model");
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
      reason: `${provider.name} is dictation-only. Meetings need a meeting-grade ASR route.`,
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

  return {
    providerType,
    modelId,
    provider,
    summary: routeSummary,
    ready: baseReady,
    reason: baseReady
      ? null
      : !modelId
        ? `Choose a ${kind} model for ${provider.name}.`
        : !modelIsKnown
          ? `${modelId} is not available for ${provider.name}. Choose or download a model.`
          : modelInventoryBlocked
            ? modelInventoryError ?? "Could not inspect downloaded transcription models."
            : modelOnDisk === false
              ? `${modelId} is not downloaded for ${provider.name}.`
              : !exactModelReady
                ? `${provider.name} has not confirmed ${modelId} as its active model.`
                : provider.runtimeMessage ?? `${provider.name} is not ready yet.`,
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
): SetupStatusSnapshot {
  const dictationRoute = buildRouteStatus(
    "dictation",
    settings,
    providers,
    permissions,
    downloadedModels,
    modelInventoryError
  );
  const meetingRoute = buildRouteStatus(
    "meeting",
    settings,
    providers,
    permissions,
    downloadedModels,
    modelInventoryError
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
        "System audio capture is not available yet. Start in Mic only mode or configure a route."
      : null,
    effectiveSystemAudioAvailable === true && !systemAudioVerified
      ? systemAudioCapability?.actionableReason ??
        "A system-audio route was detected, but callbacks are unverified. Run Test system audio before using Me + Them."
      : null,
    !effectiveLoopbackDevice && effectiveSystemAudioAvailable === false
      ? "No native or virtual-loopback route was detected for Me + Them capture."
      : null,
  ].filter((value): value is string => Boolean(value));
  const meetingNotesRoute = resolveMeetingNotesRoute({
    optedOut: meetingNotesProbe?.optedOut ?? false,
    provider: settings?.privacy?.meetingsAi?.provider ?? null,
    remoteProcessingEnabled: settings?.privacy?.remoteProcessingEnabled ?? false,
    localRuntimeReady: meetingNotesProbe
      ? meetingNotesProbe.localRuntimeReady
      : null,
    credentialPresent: meetingNotesProbe
      ? meetingNotesProbe.credentialPresent
      : null,
  });
  const meetingCaptureMode =
    effectiveSystemAudioAvailable === null
      ? "unknown"
      : fullCaptureReady
        ? "me_and_them"
        : "mic_only";
  const productReadiness = buildProductReadinessSnapshot({
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
  });

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
  };
}

/**
 * Ask whether the meetings AI lane can actually run: Ollama reachable for the
 * local route, a stored key for a cloud one. Every probe failure resolves to
 * `null` — "we did not get an answer" — because claiming a route is broken on a
 * failed probe is as dishonest as claiming it works.
 */
async function probeMeetingNotesRoute(
  settings: Settings | null,
): Promise<MeetingNotesRouteProbe> {
  const optedOut = readAiNotesOptOut();
  const provider = settings?.privacy?.meetingsAi?.provider?.trim() ?? "";
  if (!provider) {
    return { optedOut, localRuntimeReady: null, credentialPresent: null };
  }

  if (isRemoteAnalysisProvider(provider)) {
    const credentialPresent = await hasProviderSecret(provider)
      .then((present) => (typeof present === "boolean" ? present : null))
      .catch(() => null);
    return { optedOut, localRuntimeReady: null, credentialPresent };
  }

  const localRuntimeReady = await getOllamaStatus()
    .then((ready) => (typeof ready === "boolean" ? ready : null))
    .catch(() => null);
  return { optedOut, localRuntimeReady, credentialPresent: null };
}

export function useSetupStatus() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [downloadedModels, setDownloadedModels] =
    useState<DownloadedModelIndex | null>(null);
  const [modelInventoryError, setModelInventoryError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionDiagnostics | null>(null);
  const [systemAudioCapability, setSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const [meetingNotesProbe, setMeetingNotesProbe] =
    useState<MeetingNotesRouteProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshSequence = ++refreshSequenceRef.current;
    setLoading(true);
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
      // The AI-notes probe has to know which provider the lane names before it
      // can ask the right question, so it runs after settings land rather than
      // beside them. A probe that throws stays `null` — unknown, not unready.
      const nextMeetingNotesProbe = await probeMeetingNotesRoute(nextSettings);
      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
      setSettings(nextSettings);
      setProviders(nextProviders);
      setDownloadedModels(nextDownloadedModelResult.index);
      setModelInventoryError(nextDownloadedModelResult.error);
      setPermissions(nextPermissions);
      setSystemAudioCapability(nextSystemAudioCapability);
      setMeetingNotesProbe(nextMeetingNotesProbe);
    } catch (nextError) {
      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }
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

    void listen<{ ready?: boolean; reason?: string }>(
      "sidecar-runtime-changed",
      (event) => {
        if (disposed) return;
        if (event.payload?.ready === false) {
          refreshSequenceRef.current += 1;
          setLoading(false);
          setError(
            event.payload.reason ??
              "The local audio engine stopped. Plainsong is reconnecting.",
          );
          setObservedAt(Date.now());
          return;
        }
        void refresh();
      },
    )
      .then(retainUnlistener)
      .catch((nextError) => {
        console.warn("Failed to subscribe to sidecar readiness:", nextError);
      });

    const handleWindowFocus = () => {
      if (!disposed) {
        void refresh();
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
      ),
    [
      downloadedModels,
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

  return {
    ...snapshot,
    loading,
    error,
    refresh,
  };
}
