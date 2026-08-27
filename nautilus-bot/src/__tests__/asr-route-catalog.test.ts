import { describe, expect, it } from "vitest";
import {
  buildAsrRouteCatalog,
  getLaneRoutes,
  getRecommendedLaneRoute,
} from "@/lib/asr-route-catalog";
import type {
  AppleSpeechReadinessStatus,
  AsrProviderInfo,
} from "@/types";

const providers: AsrProviderInfo[] = [
  {
    providerType: "moonshine",
    name: "UsefulSensors Moonshine",
    description: "Fast local dictation",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Moonshine Base",
      version: "moonshine-base",
      sizeMb: 120,
      parameters: "base",
      languages: ["en"],
      license: "Apache-2.0",
      sourceUrl: "https://example.com/moonshine",
    },
    selectedModelId: "moonshine-base",
    modelOptions: [{ id: "moonshine-base", label: "Moonshine Base" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "distil_whisper",
    name: "Distil-Whisper",
    description: "Balanced local route",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Distil Whisper",
      version: "distil-large-v3.5",
      sizeMb: 1530,
      parameters: "756M",
      languages: ["en"],
      license: "Apache-2.0",
      sourceUrl: "https://example.com/distil",
    },
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "Distil Whisper Large v3.5" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "parakeet",
    name: "Parakeet",
    description: "Meeting-grade local route",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Parakeet",
      version: "parakeet-tdt-0.6b-v3",
      sizeMb: 2100,
      parameters: "0.6B",
      languages: ["en"],
      license: "NVIDIA Open Model License",
      sourceUrl: "https://example.com/parakeet",
    },
    selectedModelId: "parakeet-tdt-0.6b-v3",
    modelOptions: [
      { id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" },
      { id: "parakeet-tdt-ctc-110m", label: "Parakeet TDT CTC 110M legacy" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "openai_cloud",
    name: "OpenAI Transcribe",
    description: "Cloud route",
    isAvailable: false,
    inferenceEnabled: true,
    modelInfo: {
      name: "OpenAI",
      version: "gpt-4o-mini-transcribe",
      sizeMb: 0,
      parameters: "managed",
      languages: ["en"],
      license: "OpenAI",
      sourceUrl: "https://example.com/openai",
    },
    selectedModelId: "gpt-4o-mini-transcribe",
    modelOptions: [
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini transcribe" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
];

function appleProvider(status: AppleSpeechReadinessStatus): AsrProviderInfo {
  const ready = status === "ready";
  return {
    providerType: "macos_apple_speech",
    name: "Apple Speech (On-Device)",
    description: "Dictation-only on-device route",
    isAvailable: ready,
    inferenceEnabled: true,
    modelInfo: {
      name: "Apple Speech (On-Device)",
      version: "system",
      sizeMb: 0,
      parameters: "OS managed",
      languages: ["system"],
      license: "Apple platform terms",
      sourceUrl: "https://developer.apple.com/documentation/speech",
    },
    selectedModelId: "macos_apple_speech",
    modelOptions: [
      { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: ready ? "ready" : "error",
    runtimeMessage: ready ? "Ready" : "Not ready",
    runtimeDetails: {},
    platformReadiness: {
      status,
      ready,
      platformSupported: status !== "unsupported_platform",
      helperPresent: !["unsupported_platform", "helper_missing"].includes(status),
      authorization:
        status === "ready"
          ? "authorized"
          : status === "authorization_denied"
            ? "denied"
            : status === "authorization_not_determined"
              ? "not_determined"
              : "authorized",
      locale: "en_US",
      localeSupported: status !== "unsupported_locale",
      onDeviceAvailable: status !== "on_device_unavailable",
      recognizerAvailable: status !== "recognizer_unavailable",
      message: `Apple Speech status: ${status}`,
      setupAction: ready ? null : "Fix Apple Speech setup.",
      speechAnalyzerAvailable: false,
      operatingSystemVersion: null,
    },
  };
}

describe("asr-route-catalog", () => {
  it("keeps dictation-only routes out of meeting selectors and promotes the current Parakeet release", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const meetingRoutes = getLaneRoutes(routes, "meeting", "prefer_local");

    expect(meetingRoutes.some((route) => route.providerType === "moonshine")).toBe(false);
    expect(
      meetingRoutes.some(
        (route) =>
          route.providerType === "parakeet" &&
          route.modelId === "parakeet-tdt-0.6b-v3",
      ),
    ).toBe(true);
  });

  it("does not repeat an unqualified language count in the Parakeet route label", () => {
    const parakeet = {
      ...providers[2],
      modelOptions: [
        {
          id: "parakeet-tdt-0.6b-v3",
          label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)",
        },
      ],
    };
    const route = buildAsrRouteCatalog([parakeet], "prefer_local")[0];

    expect(route.label).toBe("Parakeet TDT 0.6B v3");
    expect(route.capabilitySummary).toContain(
      "25 European languages listed upstream",
    );
  });

  it("recommends the fastest local route for dictation when it is ready", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const recommended = getRecommendedLaneRoute(routes, "dictation", "prefer_local");

    expect(recommended?.providerType).toBe("moonshine");
    expect(recommended?.modelId).toBe("moonshine-base");
  });

  it("recommends whisper.cpp base.en over distil_whisper for dictation when no platform-native engine is ready", () => {
    // Regression test: distil_whisper used to outrank whisper in
    // DICTATION_PROVIDER_ORDER, steering the "Recommended" badge onto the
    // slower route even though settings.rs's documented default is
    // whisper.cpp base.en.
    const whisperAndDistilProviders: AsrProviderInfo[] = [
      {
        providerType: "whisper",
        name: "Whisper",
        description: "Flexible local route",
        isAvailable: true,
        inferenceEnabled: true,
        modelInfo: {
          name: "Whisper",
          version: "base.en",
          sizeMb: 150,
          parameters: "74M",
          languages: ["en"],
          license: "MIT",
          sourceUrl: "https://example.com/whisper",
        },
        selectedModelId: "base.en",
        modelOptions: [{ id: "base.en", label: "base.en" }],
        downloadStatus: "Downloaded",
        runtimeStatus: "ready",
        runtimeDetails: {},
      },
      providers[1], // distil_whisper, also ready
    ];

    const routes = buildAsrRouteCatalog(whisperAndDistilProviders, "prefer_local");
    const recommended = getRecommendedLaneRoute(routes, "dictation", "prefer_local");

    expect(recommended?.providerType).toBe("whisper");
    expect(recommended?.modelId).toBe("base.en");
  });

  it("recommends Parakeet before Distil Whisper for local meetings", () => {
    const routes = buildAsrRouteCatalog(
      [providers[1], providers[2]],
      "prefer_local",
    );
    const recommended = getRecommendedLaneRoute(
      routes,
      "meeting",
      "prefer_local",
    );

    expect(recommended?.providerType).toBe("parakeet");
    expect(recommended?.modelId).toBe("parakeet-tdt-0.6b-v3");
  });

  it("marks missing cloud credentials as BYOK-required instead of generic failure", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const openAiRoute = routes.find(
      (route) => route.providerType === "openai_cloud",
    );

    expect(openAiRoute?.readiness).toBe("requires_key");
    expect(openAiRoute?.actionLabel).toBe("Connect API key");
  });

  it.each([
    ["authorization_not_determined", "Permission required", "request_permission"],
    ["authorization_denied", "Permission denied", "open_system_setup"],
    ["unsupported_locale", "Locale unsupported", "fix_setup"],
    ["helper_missing", "Helper missing", "fix_setup"],
    ["on_device_unavailable", "On-device unavailable", "fix_setup"],
  ] as const)(
    "keeps Apple Speech unselectable for %s with an actionable status",
    (status, label, action) => {
      const route = buildAsrRouteCatalog([appleProvider(status)], "prefer_local")[0];

      expect(route.readiness).not.toBe("ready");
      expect(route.selectable).toBe(false);
      expect(route.readinessLabel).toBe(label);
      expect(route.action).toBe(action);
      expect(route.laneCompatibility.dictation).toBe(true);
      expect(route.laneCompatibility.meeting).toBe(false);
    },
  );

  it("makes Apple Speech selectable only when every on-device readiness check passes", () => {
    const route = buildAsrRouteCatalog([appleProvider("ready")], "prefer_local")[0];

    expect(route.readiness).toBe("ready");
    expect(route.readinessLabel).toBe("Ready on-device");
    expect(route.selectable).toBe(true);
    expect(route.action).toBeNull();
    expect(route.hosting).toBe("platform");
  });

  it("surfaces SpeechAnalyzer availability in the readiness detail for macOS 26+", () => {
    const provider = appleProvider("ready");
    provider.platformReadiness!.speechAnalyzerAvailable = true;
    provider.platformReadiness!.operatingSystemVersion = "26.0.0";
    const route = buildAsrRouteCatalog([provider], "prefer_local")[0];

    expect(route.readinessDetail).toContain("SpeechAnalyzer API available");
    expect(route.readinessDetail).toContain("macOS 26.0.0");
  });

  it("omits SpeechAnalyzer detail when the API is not available", () => {
    const route = buildAsrRouteCatalog([appleProvider("ready")], "prefer_local")[0];

    expect(route.readinessDetail).not.toContain("SpeechAnalyzer");
  });
});
