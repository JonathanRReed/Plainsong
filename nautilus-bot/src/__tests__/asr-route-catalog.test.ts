import { describe, expect, it } from "vitest";
import {
  efficientParakeetOffered,
  buildAsrRouteCatalog,
  getLaneRoutes,
  getRecommendedLaneRoute,
  isRecommendedLaneRoute,
  isRecommendedSpeechRoute,
  laneProviderOrder,
} from "@/lib/asr-route-catalog";
import type {
  AppleSpeechEngine,
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
      { id: "parakeet-tdt-0.6b-v2", label: "Parakeet TDT 0.6B v2" },
      { id: "orukeet-v0.1.0-int8", label: "Orukeet v0.1.0 int8 (experimental)" },
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

/**
 * @param engine which Apple engine this Mac would run. `speech_analyzer` is
 *   macOS 26+ with the language installed, which is the only configuration
 *   that reaches the meeting lane.
 */
function appleProvider(
  status: AppleSpeechReadinessStatus,
  engine: AppleSpeechEngine = "sf_speech_recognizer",
): AsrProviderInfo {
  const ready = status === "ready";
  const analyzer = engine === "speech_analyzer";
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
      speechAnalyzerAvailable: analyzer,
      speechAnalyzerLocaleSupported: analyzer,
      speechAnalyzerAssetsInstalled: analyzer,
      speechAnalyzerAssetStatus: analyzer ? "installed" : "unavailable",
      speechAnalyzerLocales: analyzer ? ["en_US", "fr_FR"] : [],
      speechAnalyzerInstalledLocales: analyzer ? ["en_US"] : [],
      engine,
      operatingSystemVersion: analyzer ? "27.0.0" : null,
    },
  };
}

const qwen3Provider: AsrProviderInfo = {
  providerType: "qwen3_asr",
  name: "Qwen3-ASR (Local)",
  description: "Experimental multilingual local route",
  isAvailable: true,
  inferenceEnabled: true,
  modelInfo: {
    name: "Qwen3-ASR 0.6B",
    version: "0.6b-int4",
    sizeMb: 1927,
    parameters: "0.6B",
    languages: ["en", "zh", "ja", "ko"],
    license: "Apache-2.0",
    sourceUrl: "https://example.com/qwen3",
  },
  selectedModelId: "qwen3-asr-0.6b",
  modelOptions: [{ id: "qwen3-asr-0.6b", label: "Qwen3-ASR 0.6B int4" }],
  downloadStatus: "Downloaded",
  runtimeStatus: "ready",
  runtimeDetails: {},
};

// The transcribe.cpp GGUF Parakeet route, as the macOS build reports it
// (`--features asr-transcribe-cpp`).
const transcribeCppProvider: AsrProviderInfo = {
  providerType: "transcribe_cpp",
  name: "transcribe.cpp",
  description: "Parakeet TDT 0.6B v3 GGUF on Metal via transcribe.cpp",
  isAvailable: true,
  inferenceEnabled: true,
  modelInfo: {
    name: "Parakeet TDT 0.6B v3 (GGUF Q8_0)",
    version: "q8_0",
    sizeMb: 705,
    parameters: "600M",
    languages: ["en", "de", "fr"],
    license: "CC-BY-4.0",
    sourceUrl: "https://example.com/transcribe-cpp",
  },
  selectedModelId: "parakeet-tdt-0.6b-v3-q8_0",
  modelOptions: [
    { id: "parakeet-tdt-0.6b-v3-q8_0", label: "Parakeet TDT 0.6B v3 GGUF Q8_0" },
  ],
  downloadStatus: "Downloaded",
  runtimeStatus: "ready",
  runtimeDetails: {},
};

// The two diarizing cloud routes, as the sidecar reports them.
const deepgramProvider: AsrProviderInfo = {
  providerType: "deepgram",
  name: "Deepgram Nova",
  description: "Cloud speech-to-text via Deepgram's Nova-3 batch API",
  isAvailable: true,
  inferenceEnabled: true,
  modelInfo: {
    name: "Deepgram Nova-3",
    version: "nova-3",
    sizeMb: 0,
    parameters: "cloud",
    languages: ["en", "multilingual"],
    license: "Commercial API",
    sourceUrl: "https://developers.deepgram.com/docs/pre-recorded-audio",
  },
  selectedModelId: "nova-3",
  modelOptions: [
    { id: "nova-3", label: "Nova-3" },
    { id: "nova-3-medical", label: "Nova-3 Medical" },
  ],
  downloadStatus: "Downloaded",
  runtimeStatus: "ready",
  runtimeDetails: {},
};

const geminiProvider: AsrProviderInfo = {
  providerType: "gemini_transcribe",
  name: "Google Gemini Transcribe",
  description: "Cloud speech-to-text via Gemini 3.5 Transcribe",
  isAvailable: true,
  inferenceEnabled: true,
  modelInfo: {
    name: "Gemini 3.5 Transcribe",
    version: "gemini-3.5-transcribe",
    sizeMb: 0,
    parameters: "cloud",
    languages: ["en", "multilingual"],
    license: "Commercial API",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/transcribe",
  },
  selectedModelId: "gemini-3.5-transcribe",
  modelOptions: [
    { id: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe" },
  ],
  downloadStatus: "Downloaded",
  runtimeStatus: "ready",
  runtimeDetails: {},
};

describe("asr-route-catalog", () => {
  it("puts what a cloud route costs per minute in the picker", () => {
    // The rate used to live only in the model label the sidecar sends, which
    // is not the line a user reads while choosing a route. A route that bills
    // per minute has to say so where the choice is made.
    const routes = buildAsrRouteCatalog(
      [...providers, deepgramProvider, geminiProvider],
      "best_available",
    );

    const deepgram = routes.filter(
      (route) => route.providerType === "deepgram",
    );
    const nova = deepgram.find((route) => route.modelId === "nova-3");
    expect(nova?.summary).toContain("$0.0043/min");
    // The multilingual tier is a different price, and auto lands on it.
    expect(nova?.summary).toContain("$0.0052/min");
    expect(nova?.summary).toContain("auto");

    const medical = deepgram.find(
      (route) => route.modelId === "nova-3-medical",
    );
    expect(medical?.summary).toContain("$0.0043/min");
    // English-only, so it never reaches the multilingual rate.
    expect(medical?.summary).not.toContain("$0.0052/min");
    expect(medical?.summary).toContain("English only");

    const gemini = routes.find(
      (route) => route.providerType === "gemini_transcribe",
    );
    expect(gemini?.summary).toContain("$0.005/min");
  });


  it("sizes a route by what its download fetches on this Mac when the sidecar reports it", () => {
    const fileOnly = buildAsrRouteCatalog([transcribeCppProvider], "prefer_local")[0];
    expect(fileOnly.capability?.sizeMib).toBe(705);
    expect(fileOnly.capabilitySummary).toMatch(/^739 MB\./);

    // The Neural Engine build and the vocabulary model, in place of the GGUF.
    const bytes = 632_169_729 + 102_802_576;
    const sized = buildAsrRouteCatalog(
      [{ ...transcribeCppProvider, modelDownloadBytes: { "parakeet-tdt-0.6b-v3-q8_0": bytes } }],
      "prefer_local",
    )[0];
    expect(sized.capability?.sizeMib).toBe(bytes / (1024 * 1024));
    expect(sized.capabilitySummary).toMatch(/^735 MB\./);
    // Only the size changes; a nonsense figure is ignored.
    expect(sized.capability?.tradeoff).toBe(fileOnly.capability?.tradeoff);
    const ignored = buildAsrRouteCatalog(
      [{ ...transcribeCppProvider, modelDownloadBytes: { "parakeet-tdt-0.6b-v3-q8_0": -1 } }],
      "prefer_local",
    )[0];
    expect(ignored.capability?.sizeMib).toBe(705);
  });

  it("ranks GGUF Parakeet ahead of ONNX Parakeet for dictation and meetings, and behind it in the shared lane", () => {
    const routes = buildAsrRouteCatalog(
      [...providers, transcribeCppProvider],
      "prefer_local",
    );
    const gguf = routes.find((route) => route.providerType === "transcribe_cpp");

    expect(gguf).toBeDefined();
    expect(isRecommendedSpeechRoute(gguf!.providerType, gguf!.modelId)).toBe(true);
    expect(gguf?.experimental).toBe(false);
    expect(gguf?.readiness).toBe("ready");
    expect(gguf?.hosting).toBe("local");
    expect(gguf?.downloadable).toBe(true);
    // Same weights as the ONNX Parakeet meeting route, so the same lanes.
    expect(gguf?.laneCompatibility).toEqual({
      dictation: true,
      meeting: true,
      shared: true,
    });
    expect(gguf?.label).toBe("Parakeet v3");
    expect(gguf?.summary).toMatch(/recommended for dictation and meetings on this Mac/i);
    expect(gguf?.summary).toMatch(/one download covers both/i);
    // No build details or internal scheduling on a choice.
    expect(gguf?.summary).not.toMatch(/transcribe\.cpp|GPU|GGUF|one recording at a time/i);
    // Measured on word errors and memory, not speed.
    expect(gguf?.summary).not.toMatch(/faster/i);
    expect(gguf?.summary).not.toMatch(/meetings use/i);
    // The only Parakeet v3 offered here, so nothing to compare it with.
    expect(gguf?.capabilitySummary).not.toMatch(/Compatible|second copy/);
    expect(gguf?.capabilitySummary).not.toMatch(/meetings still use/i);

    const indexIn = (
      lane: "dictation" | "meeting" | "shared",
      provider: string,
      policy: "prefer_local" | "best_available" = "prefer_local",
    ) =>
      getLaneRoutes(routes, lane, policy).findIndex(
        (route) => route.providerType === provider,
      );
    for (const policy of ["prefer_local", "best_available"] as const) {
      for (const lane of ["dictation", "meeting"] as const) {
        // ONNX Parakeet is the same model: never offered beside GGUF Parakeet.
        expect(indexIn(lane, "transcribe_cpp", policy)).toBeGreaterThanOrEqual(0);
        expect(
          getLaneRoutes(routes, lane, policy).some(
            (route) => route.routeId === "parakeet:parakeet-tdt-0.6b-v3",
          ),
        ).toBe(false);
      }
      expect(getRecommendedLaneRoute(routes, "meeting", policy)?.routeId).toBe(
        "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0",
      );
      // The shared default stays ONNX Parakeet, the sidecar's nearest
      // substitute when the GGUF model is missing.
      expect(indexIn("shared", "transcribe_cpp", policy)).toBeGreaterThan(
        indexIn("shared", "parakeet", policy),
      );
      expect(getRecommendedLaneRoute(routes, "shared", policy)?.routeId).toBe(
        "parakeet:parakeet-tdt-0.6b-v3",
      );
    }
  });

  it("recommends ONNX Parakeet for meetings when the build does not list GGUF Parakeet", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    expect(getRecommendedLaneRoute(routes, "meeting", "prefer_local")?.routeId).toBe(
      "parakeet:parakeet-tdt-0.6b-v3",
    );
  });

  it("recommends GGUF Parakeet even while only the ONNX build is on disk", () => {
    // An older install with ONNX Parakeet on disk keeps using it (the slot
    // still names it), but it is never recommended beside the GGUF build:
    // Settings offers the GGUF download instead.
    const routes = buildAsrRouteCatalog(
      [
        providers[2],
        { ...transcribeCppProvider, downloadStatus: "NotDownloaded", runtimeStatus: "missing_model" },
      ],
      "prefer_local",
    );
    expect(getRecommendedLaneRoute(routes, "meeting", "prefer_local")?.routeId).toBe(
      "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0",
    );
    const onnx = routes.find((route) => route.providerType === "parakeet");
    expect(onnx?.superseded).toBe(true);
    expect(onnx?.label).toBe("Parakeet v3");
  });

  it("prefers GGUF Parakeet already on disk over an ONNX Parakeet that needs downloading", () => {
    const routes = buildAsrRouteCatalog(
      [
        { ...providers[2], downloadStatus: "NotDownloaded", runtimeStatus: "missing_model" },
        transcribeCppProvider,
      ],
      "prefer_local",
    );
    expect(getRecommendedLaneRoute(routes, "meeting", "prefer_local")?.routeId).toBe(
      "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0",
    );
  });

  it("recommends GGUF Parakeet for dictation and meetings but never for the shared lane", () => {
    const routes = buildAsrRouteCatalog([transcribeCppProvider], "prefer_local");
    for (const lane of ["dictation", "meeting"] as const) {
      expect(getRecommendedLaneRoute(routes, lane, "prefer_local")?.modelId).toBe(
        "parakeet-tdt-0.6b-v3-q8_0",
      );
      expect(isRecommendedLaneRoute(lane, "transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0")).toBe(true);
    }
    expect(
      getLaneRoutes(routes, "shared", "prefer_local").map((route) => route.providerType),
    ).toEqual(["transcribe_cpp"]);
    expect(getRecommendedLaneRoute(routes, "shared", "prefer_local")).toBeNull();
    expect(getRecommendedLaneRoute(routes, "shared", "best_available")).toBeNull();
    expect(isRecommendedLaneRoute("shared", "transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0")).toBe(false);
  });

  it("keeps every other transcribe.cpp route experimental in every lane", () => {
    const unified = {
      ...transcribeCppProvider,
      selectedModelId: "parakeet-unified-en-0.6b-q8_0",
      modelOptions: [
        { id: "parakeet-unified-en-0.6b-q8_0", label: "Parakeet Unified EN 0.6B (experimental)" },
      ],
    };
    const routes = buildAsrRouteCatalog([unified], "prefer_local");
    expect(routes[0]?.experimental).toBe(true);
    // Meeting-eligible, yet never the recommendation there either.
    expect(routes[0]?.laneCompatibility.meeting).toBe(true);
    expect(isRecommendedSpeechRoute("transcribe_cpp", "parakeet-unified-en-0.6b-q8_0")).toBe(false);
    expect(isRecommendedSpeechRoute("parakeet", "parakeet-tdt-0.6b-v3-q8_0")).toBe(false);
    for (const lane of ["dictation", "meeting", "shared"] as const) {
      expect(isRecommendedLaneRoute(lane, "transcribe_cpp", "parakeet-unified-en-0.6b-q8_0")).toBe(false);
      expect(getRecommendedLaneRoute(routes, lane, "prefer_local")).toBeNull();
    }
    // Beside ONNX Parakeet it still sorts behind it in the meeting lane.
    const withOnnx = buildAsrRouteCatalog([unified, providers[2]], "prefer_local");
    const meeting = getLaneRoutes(withOnnx, "meeting", "prefer_local").map((route) => route.routeId);
    expect(meeting.indexOf("parakeet:parakeet-tdt-0.6b-v3")).toBeLessThan(
      meeting.indexOf("transcribe_cpp:parakeet-unified-en-0.6b-q8_0"),
    );
  });

  it.each([
    [
      "fluid-speech-mini-q8_0",
      "Fluid Speech Mini by FluidVoice (GGUF Q8_0, optional, English)",
      "Fluid Speech Mini by FluidVoice",
      "English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.",
      "Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.",
    ],
    [
      "underdog-bark-3.0-pro-q8_0",
      "Underdog Bark 3.0 Pro by Conway Research (GGUF Q8_0, optional, English)",
      "Underdog Bark 3.0 Pro by Conway Research",
      "English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.",
      "Underdog Bark 3.0 Pro by Conway Research. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra; post-trained and compressed by Conway Research.",
    ],
  ])("offers optional English %s for dictation and meetings, never recommended", (model, label, displayLabel, summary, credit) => {
    const optional = {
      ...transcribeCppProvider,
      selectedModelId: model,
      modelOptions: [{ id: model, label }],
    };
    const routes = buildAsrRouteCatalog([optional], "prefer_local");
    const route = routes[0];
    expect(route).toMatchObject({
      routeId: `transcribe_cpp:${model}`,
      label: displayLabel,
      summary,
      experimental: true,
      hosting: "local",
      downloadable: true,
      laneCompatibility: { dictation: true, meeting: true, shared: true },
    });
    expect(route?.capability?.languages).toMatchObject({ englishOnly: true, label: "English only" });
    expect(route?.capability?.tier).toBe("more");
    expect(`${route?.summary} ${route?.capabilitySummary}`).not.toMatch(/\b(best|strongest)\b/i);
    expect(route?.capabilitySummary).toContain(credit);
    expect(route?.capabilitySummary).toContain("CC BY 4.0");
    expect(isRecommendedSpeechRoute("transcribe_cpp", model)).toBe(false);
    for (const lane of ["dictation", "meeting", "shared"] as const) {
      expect(isRecommendedLaneRoute(lane, "transcribe_cpp", model)).toBe(false);
      expect(getRecommendedLaneRoute(routes, lane, "prefer_local")).toBeNull();
    }
    // Beside the GGUF default it never becomes the recommendation.
    const both = buildAsrRouteCatalog(
      [{ ...transcribeCppProvider, modelOptions: [...transcribeCppProvider.modelOptions, { id: model, label }] }],
      "prefer_local",
    );
    for (const lane of ["dictation", "meeting"] as const) {
      expect(getRecommendedLaneRoute(both, lane, "prefer_local")?.modelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
      const order = getLaneRoutes(both, lane, "prefer_local").map((entry) => entry.modelId);
      expect(order.indexOf("parakeet-tdt-0.6b-v3-q8_0")).toBeLessThan(order.indexOf(model));
    }
  });

  it.each([
    ["qwen3-asr-1.7b-q8_0", "Qwen3-ASR 1.7B", "Qwen3-ASR 1.7B (experimental)"],
    ["qwen3-asr-0.6b-q6_k", "Qwen3-ASR 0.6B", "Qwen3-ASR 0.6B Lite (experimental)"],
  ])("keeps native %s experimental and out of meeting and shared lanes", (model, name, displayLabel) => {
    const provider = { ...transcribeCppProvider, selectedModelId: model,
      modelOptions: [{ id: model, label: `${name} (experimental)` }] };
    const routes = buildAsrRouteCatalog([...providers, provider], "prefer_local");
    const route = routes.find(entry => entry.modelId === model);
    expect(route).toMatchObject({ experimental: true, hosting: "local", downloadable: true });
    expect(route?.laneCompatibility).toEqual({ dictation: true, meeting: false, shared: false });
    expect(route?.label).toBe(displayLabel);
    expect(route?.summary).toContain("Experimental English dictation");
    expect(route?.summary).not.toMatch(/GGUF|Q6_K|weights/);
    expect(getRecommendedLaneRoute(routes, "dictation", "prefer_local")?.providerType).not.toBe("transcribe_cpp");
  });

  it("keeps native Orukeet experimental and out of meeting and shared lanes", () => {
    const nativeOrukeet = {
      ...transcribeCppProvider,
      selectedModelId: "orukeet-r3-q8_0",
      modelOptions: [{ id: "orukeet-r3-q8_0", label: "Orukeet r3 GGUF Q8_0 (experimental)" }],
    };
    const routes = buildAsrRouteCatalog([...providers, nativeOrukeet], "prefer_local");
    const route = routes.find((entry) => entry.modelId === "orukeet-r3-q8_0");
    expect(route).toMatchObject({ experimental: true, hosting: "local", downloadable: true });
    expect(route?.laneCompatibility).toEqual({ dictation: true, meeting: false, shared: false });
    expect(route?.summary).toContain("Orukeet");
    expect(route?.summary).not.toContain("Parakeet weights");
    expect(getRecommendedLaneRoute(routes, "dictation", "prefer_local")?.providerType).not.toBe("transcribe_cpp");
  });

  it("offers a ready Qwen3-ASR route for both lanes as experimental and never recommends it over Parakeet", () => {
    const routes = buildAsrRouteCatalog([...providers, qwen3Provider], "prefer_local");
    const qwen3 = routes.find((route) => route.providerType === "qwen3_asr");

    expect(qwen3).toBeDefined();
    expect(qwen3?.experimental).toBe(true);
    expect(qwen3?.readiness).toBe("ready");
    expect(qwen3?.selectable).toBe(true);
    expect(qwen3?.laneCompatibility).toEqual({ dictation: true, meeting: true, shared: true });
    expect(qwen3?.summary).toBe("Experimental. Built for 30 languages and 22 Chinese dialects. Tested in English in Plainsong.");

    for (const lane of ["dictation", "meeting", "shared"] as const) {
      const laneRoutes = getLaneRoutes(routes, lane, "prefer_local");
      expect(laneRoutes.some((route) => route.providerType === "qwen3_asr")).toBe(true);
      expect(getRecommendedLaneRoute(routes, lane, "prefer_local")?.providerType).not.toBe(
        "qwen3_asr",
      );
      const parakeetIndex = laneRoutes.findIndex((route) => route.providerType === "parakeet");
      const qwen3Index = laneRoutes.findIndex((route) => route.providerType === "qwen3_asr");
      expect(parakeetIndex).toBeLessThan(qwen3Index);
    }
  });

  it("recommends nothing rather than an experimental route when only Qwen3-ASR is ready", () => {
    const routes = buildAsrRouteCatalog([qwen3Provider], "prefer_local");

    for (const lane of ["dictation", "meeting", "shared"] as const) {
      // The route is still offered ...
      expect(getLaneRoutes(routes, lane, "prefer_local").map((route) => route.providerType)).toEqual([
        "qwen3_asr",
      ]);
      // ... but never recommended: the first-run wizard saves the
      // recommended meeting route, and an experimental route must not
      // become a default by being the only one installed.
      expect(getRecommendedLaneRoute(routes, lane, "prefer_local")).toBeNull();
      expect(getRecommendedLaneRoute(routes, lane, "best_available")).toBeNull();
    }

    // With a non-experimental route alongside it, that route wins.
    const withParakeet = buildAsrRouteCatalog([qwen3Provider, providers[2]], "prefer_local");
    expect(getRecommendedLaneRoute(withParakeet, "meeting", "prefer_local")?.providerType).toBe(
      "parakeet",
    );
  });

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
    expect(
      meetingRoutes.some(
        (route) =>
          route.providerType === "parakeet" &&
          route.modelId === "parakeet-tdt-0.6b-v2",
      ),
    ).toBe(false);

    const v2 = routes.find(
      (route) =>
        route.providerType === "parakeet" &&
        route.modelId === "parakeet-tdt-0.6b-v2",
    );
    expect(v2?.summary).toContain("Experimental");
    expect(v2?.summary).toContain("Not yet tested on real recordings");
    expect(v2?.recommendedRank.meeting).toBeNull();

    const orukeet = routes.find((route) => route.modelId === "orukeet-v0.1.0-int8");
    expect(orukeet).toMatchObject({
      label: "Orukeet v0.1 (experimental)",
      selectable: true,
      downloadable: true,
      experimental: true,
    });
    expect(orukeet?.laneCompatibility).toEqual({
      dictation: true,
      meeting: false,
      shared: false,
    });
    expect(orukeet?.summary).not.toContain("NVIDIA Parakeet");
  });

  it("names the any-Mac Parakeet build plainly, without an unqualified language count", () => {
    const parakeet = {
      ...providers[2],
      modelOptions: [
        {
          id: "parakeet-tdt-0.6b-v3",
          label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)",
        },
      ],
    };
    // On its own (Intel Macs, other platforms) it is simply Parakeet v3,
    // with nothing to be compared against.
    const alone = buildAsrRouteCatalog([parakeet], "prefer_local")[0];
    expect(alone.label).toBe("Parakeet v3");
    expect(alone.capabilitySummary).toContain(
      "Tested in English. Also built for 24 other European languages.",
    );
    expect(`${alone.summary} ${alone.capabilitySummary}`).not.toMatch(
      /Compatible|any Mac|more mistakes|twice the memory/,
    );

    expect(alone.superseded).toBe(false);

    // Beside GGUF Parakeet it keeps the same name, and is never offered.
    const beside = buildAsrRouteCatalog([parakeet, transcribeCppProvider], "prefer_local").find(
      (route) => route.providerType === "parakeet",
    );
    expect(beside?.label).toBe("Parakeet v3");
    expect(beside?.superseded).toBe(true);

    // A build that lists GGUF Parakeet but cannot run it offers the ONNX one.
    expect(
      efficientParakeetOffered([{ ...transcribeCppProvider, inferenceEnabled: false }]),
    ).toBe(false);
  });

  it("recommends the fastest local route for dictation when it is ready", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const recommended = getRecommendedLaneRoute(routes, "dictation", "prefer_local");

    expect(recommended?.providerType).toBe("moonshine");
    expect(recommended?.modelId).toBe("moonshine-base");
  });

  it("recommends whisper.cpp base.en over distil_whisper for dictation when neither Parakeet nor a platform-native engine is ready", () => {
    // Regression test: distil_whisper used to outrank whisper in
    // DICTATION_PROVIDER_ORDER, steering the "Recommended" badge onto the
    // slower route. Parakeet TDT 0.6B v3 is now settings.rs's documented
    // dictation default and ranks ahead of both (see the dedicated Parakeet
    // vs. Whisper ordering test below); this test only checks the remaining
    // whisper-vs-distil_whisper ordering among the routes it does not cover.
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

  it("recommends Parakeet over whisper.cpp base.en for dictation when both are ready", () => {
    // Parakeet TDT 0.6B v3 is settings.rs's documented dictation default;
    // whisper.cpp base.en mis-transcribes words it hasn't seen before
    // (including "Plainsong" itself, per this repo's own benchmark) and is
    // offered as the smaller-download alternative, not the recommendation.
    const whisperAndParakeetProviders: AsrProviderInfo[] = [
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
      providers[2], // parakeet, also ready
    ];

    const routes = buildAsrRouteCatalog(whisperAndParakeetProviders, "prefer_local");
    const recommended = getRecommendedLaneRoute(routes, "dictation", "prefer_local");

    expect(recommended?.providerType).toBe("parakeet");
    expect(recommended?.modelId).toBe("parakeet-tdt-0.6b-v3");
  });

  it("ranks a multilingual whisper.cpp model after Parakeet and before Distil for meetings, and keeps base.en out", () => {
    const whisper = {
      ...providers[0],
      providerType: "whisper" as const,
      name: "Whisper.cpp",
      description: "Local Whisper family",
      selectedModelId: "large-v3-turbo",
      modelOptions: [
        { id: "base.en", label: "base.en (balanced, English)" },
        { id: "large-v3-turbo", label: "large-v3-turbo (fast + accurate)" },
      ],
    };
    for (const policy of ["prefer_local", "best_available"] as const) {
      const routes = buildAsrRouteCatalog(
        [whisper, providers[1], providers[2]],
        policy,
      );
      const meetingRoutes = getLaneRoutes(routes, "meeting", policy);
      const order = meetingRoutes.map((route) => route.routeId);

      expect(order).not.toContain("whisper:base.en");
      expect(order.indexOf("parakeet:parakeet-tdt-0.6b-v3")).toBeLessThan(
        order.indexOf("whisper:large-v3-turbo"),
      );
      expect(order.indexOf("whisper:large-v3-turbo")).toBeLessThan(
        order.indexOf("distil_whisper:distil-large-v3.5"),
      );
      expect(getRecommendedLaneRoute(routes, "meeting", policy)?.providerType).toBe(
        "parakeet",
      );
    }

    const turbo = buildAsrRouteCatalog([whisper], "prefer_local").find(
      (route) => route.routeId === "whisper:large-v3-turbo",
    );
    expect(turbo?.label).toBe("Whisper Large Turbo");
    expect(turbo?.summary).toContain("About 100 languages, slower than Parakeet");
    expect(turbo?.laneCompatibility.meeting).toBe(true);
    expect(turbo?.experimental).toBe(false);
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

  it("resolves the openai_cloud meeting lane to whisper-1 even when gpt-transcribe ranks first", () => {
    // gpt-transcribe is openai_cloud's dictation default and sorts ahead of
    // whisper-1 in its model_options() list, but it cannot produce segment
    // timestamps -- only whisper-1 can (openai_cloud.rs's
    // uses_verbose_json()). The meeting lane must never resolve openai_cloud
    // to a model that silently drops timestamps.
    const openAiCloudMultiModel = {
      ...providers[3],
      selectedModelId: "gpt-transcribe",
      modelOptions: [
        { id: "gpt-transcribe", label: "gpt-transcribe (recommended)" },
        { id: "whisper-1", label: "whisper-1" },
        { id: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe" },
        { id: "gpt-4o-transcribe", label: "gpt-4o-transcribe" },
      ],
    };
    const routes = buildAsrRouteCatalog([openAiCloudMultiModel], "prefer_local");
    const meetingRoutes = routes.filter(
      (route) => route.providerType === "openai_cloud" && route.laneCompatibility.meeting,
    );

    expect(meetingRoutes).toHaveLength(1);
    expect(meetingRoutes[0]?.modelId).toBe("whisper-1");

    const recommended = getRecommendedLaneRoute(routes, "meeting", "best_available");
    expect(recommended?.providerType).toBe("openai_cloud");
    expect(recommended?.modelId).toBe("whisper-1");
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
    ["unsupported_locale", "Language not supported", "fix_setup"],
    ["helper_missing", "Needs repair", "fix_setup"],
    ["on_device_unavailable", "Not available offline", "fix_setup"],
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
    expect(route.readinessLabel).toBe("Ready on this Mac");
    expect(route.selectable).toBe(true);
    expect(route.action).toBeNull();
    expect(route.hosting).toBe("platform");
  });

  it("names the engine that will run, not just that SpeechAnalyzer exists", () => {
    const route = buildAsrRouteCatalog(
      [appleProvider("ready", "speech_analyzer")],
      "prefer_local",
    )[0];

    expect(route.readinessDetail).toContain("Uses Apple's current speech recognizer");
    expect(route.readinessDetail).toContain("American English installed");
    expect(route.readinessDetail).not.toContain("..");
    expect(route.readinessDetail).toContain("macOS 27.0.0");
    expect(route.readinessDetail).toContain("Nothing to download");
  });

  it("says which language is missing when SpeechAnalyzer is there but its assets are not", () => {
    const provider = appleProvider("ready", "speech_analyzer");
    provider.platformReadiness!.speechAnalyzerAssetsInstalled = false;
    provider.platformReadiness!.speechAnalyzerAssetStatus = "supported";
    provider.platformReadiness!.engine = "sf_speech_recognizer";
    const route = buildAsrRouteCatalog([provider], "prefer_local")[0];

    expect(route.readinessDetail).toContain("Uses Apple's older speech recognizer");
    expect(route.readinessDetail).toContain("Install American English");
    expect(route.laneCompatibility.meeting).toBe(false);
  });

  it("says SpeechAnalyzer needs a newer macOS when the API is absent", () => {
    const route = buildAsrRouteCatalog([appleProvider("ready")], "prefer_local")[0];

    expect(route.readinessDetail).toContain("Uses Apple's older speech recognizer");
    expect(route.readinessDetail).toContain("Meetings need macOS 26 or later");
  });

  it("keeps Apple Speech out of the meeting lane on the SFSpeechRecognizer path", () => {
    const route = buildAsrRouteCatalog([appleProvider("ready")], "prefer_local")[0];

    expect(route.laneCompatibility.dictation).toBe(true);
    expect(route.laneCompatibility.meeting).toBe(false);
    expect(route.laneCompatibility.shared).toBe(false);
    expect(route.capabilityBadge).toBe("Dictation only");
    expect(route.summary).toContain("dictation only");
    expect(
      getLaneRoutes([route], "meeting", "prefer_local").map((entry) => entry.routeId),
    ).toEqual([]);
  });

  it("lets Apple Speech into the meeting lane once SpeechAnalyzer is the engine", () => {
    const routes = buildAsrRouteCatalog(
      [appleProvider("ready", "speech_analyzer")],
      "prefer_local",
    );
    const route = routes[0];

    expect(route.laneCompatibility.meeting).toBe(true);
    expect(route.laneCompatibility.shared).toBe(true);
    expect(route.capabilityBadge).toBe("Dictation and meetings");
    expect(route.summary).toContain("works for meetings");
    expect(
      getLaneRoutes(routes, "meeting", "prefer_local").map((entry) => entry.routeId),
    ).toEqual([route.routeId]);
  });

  it("ranks Apple Speech behind the measured local meeting routes but ahead of cloud", () => {
    const routes = buildAsrRouteCatalog(
      [...providers, appleProvider("ready", "speech_analyzer")],
      "prefer_local",
    );
    const meetingProviders = getLaneRoutes(routes, "meeting", "prefer_local").map(
      (entry) => entry.providerType,
    );

    expect(meetingProviders).toContain("macos_apple_speech");
    expect(meetingProviders.indexOf("macos_apple_speech")).toBeGreaterThan(
      meetingProviders.indexOf("parakeet"),
    );

    // The cloud routes in this fixture are not meeting-eligible models, so the
    // ordering against them is asserted on the lane order itself.
    const order = laneProviderOrder("meeting", "prefer_local");
    expect(order.indexOf("macos_apple_speech")).toBeGreaterThan(
      order.indexOf("distil_whisper"),
    );
    expect(order.indexOf("macos_apple_speech")).toBeLessThan(
      order.indexOf("openai_cloud"),
    );
  });
});

it.each(["GGUF", "transcribe.cpp", "ONNX", "Metal", "CoreML"])("keeps %s details out of model recovery copy", (detail) => {
  const routes = buildAsrRouteCatalog([{ ...transcribeCppProvider,
    runtimeStatus: "missing_model", downloadStatus: "NotDownloaded",
    runtimeMessage: `The ${detail} speech model is missing.`,
  }], "prefer_local");
  expect(routes[0].readinessDetail).toBe("The speech model is missing or couldn't be verified. Download it again in Settings > Models.");
});
