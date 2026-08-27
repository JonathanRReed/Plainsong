import { describe, expect, it } from "vitest";
import { buildSnapshot } from "@/hooks/use-setup-status";
import { buildDownloadedModelIndex } from "@/components/models/downloaded-models";
import type { PermissionDiagnostics } from "@/lib/backend/settings";
import type { AsrProviderInfo } from "@/types";
import type { Settings } from "@/types/settings";

function createSettings(dictationInsertionMode: "auto" | "clipboard_only"): Settings {
  return {
    transcription: {
      useSharedAsrSelection: false,
      defaultProvider: "distil_whisper",
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3",
      meetingProvider: "parakeet",
      meetingModelId: "parakeet-tdt-0.6b-v3",
      selectedModelId: "distil-large-v3",
      dictationRoutePreference: "local",
      meetingRoutePolicy: "prefer_local",
      dictationInsertionMode,
    },
    privacy: {
      remoteProcessingEnabled: false,
      dictationAi: { provider: "ollama", modelId: null },
      meetingsAi: { provider: "ollama", modelId: null },
    },
  } as Settings;
}

function createProviders(): AsrProviderInfo[] {
  return [
    {
      providerType: "distil_whisper",
      name: "Distil Whisper",
      inferenceEnabled: true,
      runtimeStatus: "ready",
      runtimeMessage: "ready",
      selectedModelId: "distil-large-v3",
      modelOptions: [{ id: "distil-large-v3", label: "Large V3" }],
    },
    {
      providerType: "parakeet",
      name: "Parakeet",
      inferenceEnabled: true,
      runtimeStatus: "ready",
      runtimeMessage: "ready",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "TDT 0.6B v3" }],
    },
  ] as AsrProviderInfo[];
}

function createLocalProviders(): AsrProviderInfo[] {
  return [
    {
      providerType: "moonshine",
      name: "UsefulSensors Moonshine",
      inferenceEnabled: true,
      runtimeStatus: "ready",
      runtimeMessage: "ready",
      selectedModelId: "moonshine-tiny",
      modelOptions: [{ id: "moonshine-tiny", label: "Moonshine Tiny" }],
    },
    {
      providerType: "parakeet",
      name: "Parakeet",
      inferenceEnabled: true,
      runtimeStatus: "ready",
      runtimeMessage: "ready",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "TDT 0.6B v3" }],
    },
  ] as AsrProviderInfo[];
}

function createPermissions(
  overrides: Partial<PermissionDiagnostics> = {}
): PermissionDiagnostics {
  return {
    microphoneReady: true,
    microphonePermissionReady: true,
    speechRecognitionReady: true,
    accessibilityReady: false,
    accessibilityTrusted: false,
    postEventReady: false,
    automationReady: false,
    cursorInsertionReady: false,
    cursorInsertionObserved: false,
    preferredInsertStrategy: null,
    availableInsertStrategies: [],
    lastCursorInsertStatus: null,
    runningFromDiskImage: false,
    appBundlePath: null,
    recommendedAppBundlePath: null,
    notes: [],
    ...overrides,
  };
}

describe("buildSnapshot", () => {
  it("treats clipboard-only dictation as ready without cursor insertion", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      false,
      null
    );

    expect(snapshot.dictationReady).toBe(true);
    expect(snapshot.dictationBlockers).not.toContain(
      "Cursor insertion is still required for the current dictation mode."
    );
  });

  it("accepts keyboard fallback as valid cursor insertion readiness", () => {
    const snapshot = buildSnapshot(
      createSettings("auto"),
      createProviders(),
      createPermissions({
        accessibilityReady: false,
        cursorInsertionReady: true,
        postEventReady: true,
      }),
      false,
      null
    );

    expect(snapshot.dictationReady).toBe(true);
    expect(snapshot.dictationBlockers).not.toContain(
      "Cursor insertion is still required for the current dictation mode."
    );
  });

  it("does not infer verified full capture from route availability alone", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      true,
      "MacBook Pro Speakers"
    );

    expect(snapshot.meetingReady).toBe(true);
    expect(snapshot.fullCaptureReady).toBe(false);
    expect(snapshot.meetingCaptureMode).toBe("mic_only");
  });

  it("does not promote an incoherent capability to full-capture readiness", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      true,
      "MacBook Pro Speakers",
      {
        backend: "core_audio_process_tap",
        nativeOsSupported: true,
        nativeOsEnabled: true,
        routeDevice: "MacBook Pro Speakers",
        routeId: "coreaudio:BuiltInSpeakerDevice",
        nativeSampleRate: 48000,
        nativeChannels: 2,
        readiness: "unverified",
        ready: true,
        reason: null,
        actionableReason: "Run Test system audio.",
      }
    );

    expect(snapshot.meetingReady).toBe(true);
    expect(snapshot.fullCaptureReady).toBe(false);
    expect(snapshot.meetingCaptureMode).toBe("mic_only");
  });

  it("keeps mic-only meetings ready while full capture remains unverified", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      true,
      "MacBook Pro Speakers",
      {
        backend: "core_audio_process_tap",
        nativeOsSupported: true,
        nativeOsEnabled: true,
        routeDevice: "MacBook Pro Speakers",
        routeId: "coreaudio:BuiltInSpeakerDevice",
        nativeSampleRate: 48000,
        nativeChannels: 2,
        readiness: "unverified",
        ready: false,
        reason: null,
        actionableReason: "Run Test system audio.",
      },
      {},
      null,
      null,
      // Meetings only reads "ready" once the AI-notes lane has actually
      // answered; an unprobed lane is unknown, which degrades the domain.
      { optedOut: false, localRuntimeReady: true, credentialPresent: null }
    );

    expect(snapshot.systemAudioAvailable).toBe(true);
    expect(snapshot.meetingReady).toBe(true);
    expect(snapshot.fullCaptureReady).toBe(false);
    expect(snapshot.meetingCaptureMode).toBe("mic_only");
    expect(snapshot.meetingBlockers).toEqual([]);
    expect(snapshot.fullCaptureBlockers).toContain("Run Test system audio.");
    expect(snapshot.productReadiness.meetings.state).toBe("ready");
    expect(snapshot.productReadiness.fullCapture.state).toBe("degraded");
    expect(snapshot.productReadiness.fullCapture.cause?.id).toBe(
      "system_audio_unverified",
    );
  });

  it("does not call meetings ready while the AI notes lane is missing", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      false,
      null,
      null,
      {},
      null,
      null,
      { optedOut: false, localRuntimeReady: false, credentialPresent: null }
    );

    expect(snapshot.meetingNotesRoute.state).toBe("unconfigured");
    expect(snapshot.productReadiness.meetings.state).toBe("degraded");
    expect(snapshot.productReadiness.meetings.cause?.id).toBe("ai_route");
    // Capture itself is unaffected: the transcript still lands.
    expect(snapshot.meetingReady).toBe(true);
  });

  it("stays quiet about AI notes once transcripts-only is chosen", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      false,
      null,
      null,
      {},
      null,
      null,
      { optedOut: true, localRuntimeReady: false, credentialPresent: null }
    );

    expect(snapshot.meetingNotesRoute.state).toBe("opted_out");
    expect(snapshot.productReadiness.meetings.state).toBe("ready");
  });

  it("requires microphone permission even when an input device is present", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions({
        microphoneReady: true,
        microphonePermissionReady: false,
      }),
      false,
      null
    );

    expect(snapshot.microphoneReady).toBe(false);
    expect(snapshot.dictationReady).toBe(false);
    expect(snapshot.meetingReady).toBe(false);
    expect(snapshot.dictationBlockers).toContain(
      "Microphone permission is still required."
    );
    expect(snapshot.meetingBlockers).toContain(
      "Microphone permission is still required."
    );
    expect(snapshot.productReadiness.dictation.state).toBe("needs_action");
    expect(snapshot.productReadiness.dictation.cause?.id).toBe(
      "microphone_permission",
    );
  });

  it("keeps missing permission diagnostics unknown in the canonical snapshot", () => {
    const snapshot = buildSnapshot(
      createSettings("auto"),
      createProviders(),
      null,
      null,
      null,
    );

    expect(snapshot.productReadiness.dictation.state).toBe("unknown");
    expect(snapshot.productReadiness.dictation.cause?.id).toBe(
      "source_unavailable",
    );
    expect(snapshot.productReadiness.meetings.state).toBe("unknown");
  });

  it("reserves Me + Them readiness for a verified system-audio route", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      true,
      "MacBook Pro Speakers",
      {
        backend: "core_audio_process_tap",
        nativeOsSupported: true,
        nativeOsEnabled: true,
        routeDevice: "MacBook Pro Speakers",
        routeId: "coreaudio:BuiltInSpeakerDevice",
        nativeSampleRate: 48000,
        nativeChannels: 2,
        readiness: "ready",
        ready: true,
        reason: null,
        actionableReason: null,
      }
    );

    expect(snapshot.meetingReady).toBe(true);
    expect(snapshot.fullCaptureReady).toBe(true);
    expect(snapshot.meetingCaptureMode).toBe("me_and_them");
    expect(snapshot.fullCaptureBlockers).toEqual([]);
  });

  it("does not block local dictation on speech recognition permission", () => {
    const snapshot = buildSnapshot(
      {
        transcription: {
          useSharedAsrSelection: false,
          defaultProvider: "moonshine",
          dictationProvider: "moonshine",
          dictationModelId: "moonshine-tiny",
          meetingProvider: "parakeet",
          meetingModelId: "parakeet-tdt-0.6b-v3",
          selectedModelId: "moonshine-tiny",
          dictationRoutePreference: "local",
          meetingRoutePolicy: "prefer_local",
          dictationInsertionMode: "clipboard_only",
        },
      } as Settings,
      createLocalProviders(),
      createPermissions({
        speechRecognitionReady: false,
      }),
      false,
      null
    );

    expect(snapshot.dictationReady).toBe(true);
    expect(snapshot.dictationBlockers).not.toContain(
      "Speech Recognition permission is still required for Apple Speech dictation."
    );
  });

  it("uses structured Apple Speech readiness as the dictation blocker", () => {
    const settings = {
      transcription: {
        useSharedAsrSelection: false,
        defaultProvider: "macos_apple_speech",
        dictationProvider: "macos_apple_speech",
        dictationModelId: "macos_apple_speech",
        meetingProvider: "parakeet",
        meetingModelId: "parakeet-tdt-0.6b-v3",
        selectedModelId: "macos_apple_speech",
        dictationRoutePreference: "local",
        meetingRoutePolicy: "prefer_local",
        dictationInsertionMode: "clipboard_only",
      },
    } as Settings;
    const apple = {
      providerType: "macos_apple_speech",
      name: "Apple Speech (On-Device)",
      inferenceEnabled: true,
      runtimeStatus: "missing_runtime",
      runtimeMessage: "Generic runtime failure",
      selectedModelId: "macos_apple_speech",
      modelOptions: [{ id: "macos_apple_speech", label: "Apple Speech" }],
      platformReadiness: {
        status: "helper_missing",
        ready: false,
        platformSupported: true,
        helperPresent: false,
        authorization: "unavailable",
        locale: null,
        localeSupported: false,
        onDeviceAvailable: false,
        recognizerAvailable: false,
        message: "The required macOS Speech helper is missing or not executable.",
        setupAction: "Reinstall Plainsong.",
      },
    } as AsrProviderInfo;

    const snapshot = buildSnapshot(
      settings,
      [apple, createProviders()[1]],
      createPermissions(),
      false,
      null,
    );

    expect(snapshot.dictationReady).toBe(false);
    expect(snapshot.dictationBlockers).toContain(
      "The required macOS Speech helper is missing or not executable.",
    );
  });

  it("does not treat a provider marker as ready when the selected dictation model is missing", () => {
    const providers = createProviders();
    providers[0] = {
      ...providers[0],
      selectedModelId: "distil-large-v3",
      runtimeStatus: "ready",
      modelOptions: [{ id: "another-model", label: "Another model" }],
    };

    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      providers,
      createPermissions(),
      false,
      null,
    );

    expect(snapshot.dictationReady).toBe(false);
    expect(snapshot.productReadiness.dictation.state).toBe("blocked");
    expect(snapshot.dictationRoute.reason).toContain("is not available");
  });

  it("uses the exact downloaded model when provider state points at another variant", () => {
    const settings = createSettings("clipboard_only");
    settings.transcription.dictationProvider = "whisper";
    settings.transcription.dictationModelId = "small.en";
    const provider = {
      providerType: "whisper",
      name: "Whisper",
      inferenceEnabled: true,
      runtimeStatus: "missing_model",
      runtimeMessage: "The selected provider model is missing.",
      selectedModelId: "base.en",
      modelOptions: [
        { id: "base.en", label: "Base English" },
        { id: "small.en", label: "Small English" },
      ],
    } as AsrProviderInfo;
    const downloadedModels = buildDownloadedModelIndex([
      {
        name: "ggml-small.en.bin",
        provider: "whisper",
        path: "/models/whisper/ggml-small.en.bin",
        sizeBytes: 1,
      },
    ]);

    const snapshot = buildSnapshot(
      settings,
      [provider, createProviders()[1]],
      createPermissions(),
      false,
      null,
      null,
      {},
      downloadedModels,
    );

    expect(snapshot.dictationReady).toBe(true);
    expect(snapshot.dictationRoute.reason).toBeNull();
  });

  it("fails closed when the exact model inventory cannot be inspected", () => {
    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      createProviders(),
      createPermissions(),
      false,
      null,
      null,
      {},
      null,
      "Model inventory unavailable.",
    );

    expect(snapshot.dictationReady).toBe(false);
    expect(snapshot.meetingReady).toBe(false);
    expect(snapshot.dictationRoute.reason).toBe("Model inventory unavailable.");
  });

  it("does not treat a meeting provider as ready for a different active model", () => {
    const providers = createProviders();
    providers[1] = {
      ...providers[1],
      selectedModelId: "parakeet-legacy-110m",
      runtimeStatus: "ready",
    };

    const snapshot = buildSnapshot(
      createSettings("clipboard_only"),
      providers,
      createPermissions(),
      false,
      null,
    );

    expect(snapshot.meetingReady).toBe(false);
    expect(snapshot.meetingRoute.reason).toContain("has not confirmed");
  });
});
