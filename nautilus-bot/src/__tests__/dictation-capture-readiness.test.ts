import { describe, expect, it } from "vitest";
import {
  assessInAppDictationCapture,
  assessOneOffDictationCapture,
} from "@/lib/dictation-capture-readiness";
import type { ProductReadinessEvidence } from "@/features/readiness/product-readiness";
import type { AsrProviderInfo, AsrProviderType } from "@/types";

const evidence = (overrides: Partial<ProductReadinessEvidence> = {}): ProductReadinessEvidence => ({
  observedAt: 1,
  loading: false,
  error: null,
  settingsLoaded: true,
  providersLoaded: true,
  microphonePermissionReady: true,
  microphoneDeviceReady: true,
  dictationRouteReady: false,
  dictationRouteReason: "No route was ready before this check.",
  cursorInsertionRequired: false,
  cursorInsertionReady: true,
  meetingRouteReady: true,
  meetingRouteReason: null,
  meetingNotesRoute: "ready",
  meetingNotesRouteReason: null,
  systemAudioState: "unavailable",
  ...overrides,
});

const provider = (
  providerType: AsrProviderType,
  overrides: Partial<AsrProviderInfo> = {},
): AsrProviderInfo => ({
  providerType,
  name: providerType,
  description: "test provider",
  isAvailable: true,
  inferenceEnabled: true,
  modelInfo: {} as AsrProviderInfo["modelInfo"],
  selectedModelId: "test-model",
  modelOptions: [],
  downloadStatus: "Downloaded",
  runtimeStatus: "ready",
  runtimeDetails: {} as AsrProviderInfo["runtimeDetails"],
  ...overrides,
});

const assess = (overrides: Partial<Parameters<typeof assessOneOffDictationCapture>[0]> = {}) =>
  assessOneOffDictationCapture({
    evidence: evidence(),
    providers: [],
    preference: "local",
    remoteProcessingEnabled: false,
    configuredProviders: [],
    requestedProvider: null,
    ...overrides,
  });

describe("one-off dictation capture readiness", () => {
  it("accepts a ready cloud route even when the prior local route was missing", () => {
    expect(assess({
      preference: "cloud",
      remoteProcessingEnabled: true,
      providers: [provider("openai_cloud")],
    })).toMatchObject({ domain: "dictation", state: "ready", cause: null });
  });

  it("blocks cloud capture when remote processing is disabled", () => {
    expect(assess({
      preference: "cloud",
      providers: [provider("openai_cloud")],
    })).toMatchObject({ state: "blocked", cause: { id: "dictation_route" } });
  });

  it.each([
    [{ microphonePermissionReady: false }, "microphone_permission"],
    [{ microphoneDeviceReady: false }, "microphone_device"],
    [{ cursorInsertionRequired: true, cursorInsertionReady: false }, "cursor_insertion"],
  ] as const)("preserves the %s readiness gate", (changes, cause) => {
    expect(assess({ evidence: evidence(changes), providers: [provider("whisper")] }))
      .toMatchObject({ cause: { id: cause } });
  });

  it.each([false, null])(
    "allows preview delivery when cursor insertion readiness is %s",
    (cursorInsertionReady) => {
      expect(assess({
        deliveryMode: "preview",
        evidence: evidence({
          cursorInsertionRequired: true,
          cursorInsertionReady,
        }),
        providers: [provider("whisper")],
      })).toMatchObject({ state: "ready", cause: null });
    },
  );

  it("preserves loading and source errors before considering providers", () => {
    expect(assess({ evidence: evidence({ loading: true }), providers: [provider("whisper")] }))
      .toMatchObject({ state: "unknown", cause: { id: "loading" } });
    expect(assess({ evidence: evidence({ error: "provider probe failed" }), providers: [provider("whisper")] }))
      .toMatchObject({ state: "blocked", cause: { id: "source_error", message: "provider probe failed" } });
  });

  it("does not claim ready without authoritative evidence or provider metadata", () => {
    expect(assess({ evidence: null, providers: [provider("whisper")] }))
      .toMatchObject({ state: "unknown", cause: { id: "source_unavailable" } });
    expect(assess({ providers: [] })).toMatchObject({ state: "blocked", cause: { id: "dictation_route" } });
  });

  it("rejects disabled, unavailable, and unlisted providers", () => {
    for (const candidate of [
      provider("whisper", { isAvailable: false }),
      provider("whisper", { inferenceEnabled: false }),
      provider("whisper", { runtimeStatus: "missing_model" }),
      provider("deepgram"),
    ]) {
      expect(assess({ providers: [candidate] })).toMatchObject({ state: "blocked" });
    }
  });

  it("requires Deepgram to be configured, while a configured ready provider can rescue the route", () => {
    expect(assess({ providers: [provider("deepgram")] })).toMatchObject({ state: "blocked" });
    expect(assess({
      preference: "cloud",
      remoteProcessingEnabled: true,
      providers: [provider("deepgram")],
      configuredProviders: ["deepgram"],
    }))
      .toMatchObject({ state: "ready" });
  });

  it("rejects Moonshine even when saved route evidence claims ready", () => {
    expect(assess({ providers: [provider("moonshine")], requestedProvider: null }))
      .toMatchObject({ state: "blocked" });
    expect(assess({ providers: [provider("moonshine")], requestedProvider: "moonshine" }))
      .toMatchObject({ state: "blocked" });
    expect(assess({
      providers: [provider("moonshine")],
      requestedProvider: "moonshine",
      evidence: evidence({ dictationRouteReady: true }),
    })).toMatchObject({ state: "blocked" });
  });
  it("preserves the explicit Apple Speech no-fallback rule", () => {
    expect(assess({ preference: "local", requestedProvider: "macos_apple_speech",
      providers: [provider("whisper")] })).toMatchObject({ state: "blocked" });
    expect(assess({ preference: "local", requestedProvider: "macos_apple_speech",
      providers: [provider("macos_apple_speech")], evidence: evidence({ dictationRouteReady: true })
    })).toMatchObject({ state: "ready" });
    expect(assess({ preference: "cloud", requestedProvider: "macos_apple_speech",
      providers: [provider("openai_cloud")], remoteProcessingEnabled: true
    })).toMatchObject({ state: "ready" });
  });

});

describe("in-app dictation capture readiness", () => {
  it.each([false, null])(
    "ignores cursor insertion readiness when it is %s",
    (cursorInsertionReady) => {
      expect(assessInAppDictationCapture(evidence({
        dictationRouteReady: true,
        dictationRouteReason: null,
        cursorInsertionRequired: true,
        cursorInsertionReady,
      }))).toMatchObject({ state: "ready", cause: null });
    },
  );

  it.each([
    [{ microphonePermissionReady: false }, "microphone_permission"],
    [{ microphoneDeviceReady: false }, "microphone_device"],
    [{ dictationRouteReady: false }, "dictation_route"],
    [{ error: "provider probe failed" }, "source_error"],
  ] as const)("preserves the %s readiness gate", (changes, cause) => {
    expect(assessInAppDictationCapture(evidence({
      dictationRouteReady: true,
      dictationRouteReason: null,
      ...changes,
    }))).toMatchObject({ cause: { id: cause } });
  });
});
