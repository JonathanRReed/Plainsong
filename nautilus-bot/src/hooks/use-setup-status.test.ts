import { describe, expect, it } from "vitest";
import { buildSnapshot } from "@/hooks/use-setup-status";
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
      meetingModelId: "parakeet-ctc-0.6b",
      selectedModelId: "distil-large-v3",
      dictationRoutePreference: "local",
      meetingRoutePolicy: "prefer_local",
      dictationInsertionMode,
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
      selectedModelId: "parakeet-ctc-0.6b",
      modelOptions: [{ id: "parakeet-ctc-0.6b", label: "CTC 0.6B" }],
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
      selectedModelId: "parakeet-ctc-0.6b",
      modelOptions: [{ id: "parakeet-ctc-0.6b", label: "CTC 0.6B" }],
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

  it("does not block local dictation on speech recognition permission", () => {
    const snapshot = buildSnapshot(
      {
        transcription: {
          useSharedAsrSelection: false,
          defaultProvider: "moonshine",
          dictationProvider: "moonshine",
          dictationModelId: "moonshine-tiny",
          meetingProvider: "parakeet",
          meetingModelId: "parakeet-ctc-0.6b",
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
      "Speech Recognition permission is still required for Apple Native dictation."
    );
  });
});
