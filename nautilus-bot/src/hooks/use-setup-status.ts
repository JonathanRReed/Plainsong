import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checkSystemAudioAvailability,
  getAsrProviders,
  getLoopbackDeviceName,
  getPermissionDiagnostics,
  getSettings,
  type PermissionDiagnostics,
} from "@/lib/backend";
import {
  isMeetingEligibleProvider,
  isMeetingEligibleModel,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import type { Settings } from "@/types/settings";

export interface SetupRouteStatus {
  providerType: AsrProviderType | null;
  modelId: string | null;
  provider: AsrProviderInfo | null;
  summary: string;
  ready: boolean;
  reason: string | null;
}

export interface SetupStatusSnapshot {
  settings: Settings | null;
  providers: AsrProviderInfo[];
  permissions: PermissionDiagnostics | null;
  systemAudioAvailable: boolean | null;
  loopbackDevice: string | null;
  meetingCaptureMode: "me_and_them" | "mic_only" | "unknown";
  dictationRoutePreference: "local" | "cloud";
  dictationLocalReady: boolean;
  dictationCloudReady: boolean;
  meetingRoutePolicy: "prefer_local" | "best_available";
  dictationRoute: SetupRouteStatus;
  meetingRoute: SetupRouteStatus;
  dictationReady: boolean;
  meetingReady: boolean;
  dictationBlockers: string[];
  meetingBlockers: string[];
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
  permissions: PermissionDiagnostics | null
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
  const baseReady = provider.inferenceEnabled && provider.runtimeStatus === "ready";

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
    permissions &&
    !permissions.speechRecognitionReady
  ) {
    return {
      providerType,
      modelId,
      provider,
      summary: routeSummary,
      ready: false,
      reason: "Speech Recognition permission is still required for Apple Native dictation.",
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
      : provider.runtimeMessage ?? `${provider.name} is not ready yet.`,
  };
}

export function buildSnapshot(
  settings: Settings | null,
  providers: AsrProviderInfo[],
  permissions: PermissionDiagnostics | null,
  systemAudioAvailable: boolean | null,
  loopbackDevice: string | null
): SetupStatusSnapshot {
  const dictationRoute = buildRouteStatus("dictation", settings, providers, permissions);
  const meetingRoute = buildRouteStatus("meeting", settings, providers, permissions);
  const dictationInsertionMode = settings?.transcription.dictationInsertionMode ?? "auto";
  const cursorInsertionRequired = dictationInsertionMode !== "clipboard_only";
  const cursorInsertionReady =
    !cursorInsertionRequired ||
    (permissions?.cursorInsertionReady ?? permissions?.accessibilityReady ?? true);
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
      providerHostingPreference(provider.providerType, provider.selectedModelId) === "local"
  );
  const dictationCloudReady = providers.some(
    (provider) =>
      provider.inferenceEnabled &&
      provider.runtimeStatus === "ready" &&
      providerHostingPreference(provider.providerType, provider.selectedModelId) === "cloud"
  );
  const dictationReady = Boolean(
    permissions?.microphoneReady && dictationRoute.ready && cursorInsertionReady
  );
  const speechRecognitionRequiredForDictation =
    dictationRoute.providerType === "macos_apple_speech";
  const meetingReady = Boolean(
    permissions?.microphoneReady &&
      meetingRoute.ready &&
      (systemAudioAvailable ?? false)
  );
  const dictationBlockers = [
    !permissions?.microphoneReady ? "Microphone permission is still required." : null,
    speechRecognitionRequiredForDictation &&
    !(permissions?.speechRecognitionReady ?? true)
      ? "Speech Recognition permission is still required for Apple Native dictation."
      : null,
    !cursorInsertionReady && cursorInsertionRequired
      ? "Cursor insertion is still required for the current dictation mode."
      : null,
    !dictationRoute.ready ? dictationRoute.reason : null,
  ].filter((value): value is string => Boolean(value));
  const meetingBlockers = [
    !permissions?.microphoneReady ? "Microphone permission is still required." : null,
    !meetingRoute.ready ? meetingRoute.reason : null,
    systemAudioAvailable === false
      ? "System audio capture is not available yet."
      : null,
    !loopbackDevice && systemAudioAvailable === false
      ? "No loopback device was detected for meeting capture."
      : null,
  ].filter((value): value is string => Boolean(value));
  const meetingCaptureMode =
    systemAudioAvailable === null
      ? "unknown"
      : systemAudioAvailable
        ? "me_and_them"
        : "mic_only";

  return {
    settings,
    providers,
    permissions,
    systemAudioAvailable,
    loopbackDevice,
    meetingCaptureMode,
    dictationRoutePreference,
    dictationLocalReady,
    dictationCloudReady,
    meetingRoutePolicy,
    dictationRoute,
    meetingRoute,
    dictationReady,
    meetingReady,
    dictationBlockers,
    meetingBlockers,
  };
}

export function useSetupStatus() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [permissions, setPermissions] = useState<PermissionDiagnostics | null>(null);
  const [systemAudioAvailable, setSystemAudioAvailable] = useState<boolean | null>(null);
  const [loopbackDevice, setLoopbackDevice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [
        nextSettings,
        nextProviders,
        nextPermissions,
        nextSystemAudioAvailable,
        nextLoopbackDevice,
      ] = await Promise.all([
        getSettings(),
        getAsrProviders(),
        getPermissionDiagnostics().catch(() => null),
        checkSystemAudioAvailability().catch(() => null),
        getLoopbackDeviceName().catch(() => null),
      ]);

      setSettings(nextSettings);
      setProviders(nextProviders);
      setPermissions(nextPermissions);
      setSystemAudioAvailable(nextSystemAudioAvailable);
      setLoopbackDevice(nextLoopbackDevice);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const snapshot = useMemo(
    () =>
      buildSnapshot(settings, providers, permissions, systemAudioAvailable, loopbackDevice),
    [loopbackDevice, permissions, providers, settings, systemAudioAvailable]
  );

  return {
    ...snapshot,
    loading,
    error,
    refresh,
  };
}
