import { describe, expect, it } from "vitest";
import {
  MODEL_PRESETS,
  presetDiskLabel,
  presetForThisMac,
  resolveActivePresetId,
  type ModelPreset,
} from "@/components/models/model-presets";
import {
  readLaneSelection,
  withModelPreset,
  withSpeechLaneRoute,
} from "@/components/models/model-selection";
import {
  buildDownloadedModelIndex,
  isModelOnDisk,
} from "@/components/models/downloaded-models";
import { analysisModelChoices } from "@/components/models/ai-lanes";
import { laneRouteReadiness } from "@/components/models/model-facts";
import { buildAsrRouteCatalog } from "@/lib/asr-route-catalog";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";

/** A preset as a Mac without the GGUF build runs it (Intel, in these fixtures). */
function preset(id: ModelPreset["id"]): ModelPreset {
  const found = MODEL_PRESETS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No preset ${id}`);
  }
  return presetForThisMac(found, false);
}

const providers = [
  {
    providerType: "whisper",
    name: "Whisper",
    description: "Local Whisper",
    isAvailable: true,
    inferenceEnabled: true,
    selectedModelId: "base.en",
    modelOptions: [
      { id: "base.en", label: "base.en (balanced, English)" },
      { id: "large-v3-turbo", label: "large-v3-turbo (fast + accurate)" },
    ],
    downloadStatus: "Downloaded",
  },
  {
    providerType: "parakeet",
    name: "Parakeet",
    description: "Local Parakeet",
    isAvailable: true,
    inferenceEnabled: true,
    selectedModelId: "parakeet-tdt-0.6b-v3",
    modelOptions: [
      { id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" },
    ],
    downloadStatus: "NotDownloaded",
  },
  {
    providerType: "distil_whisper",
    name: "Distil-Whisper",
    description: "Local Distil",
    isAvailable: true,
    inferenceEnabled: true,
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "Distil Whisper Large v3.5" }],
    downloadStatus: "Downloaded",
  },
  {
    providerType: "macos_apple_speech",
    name: "Apple Speech (On-Device)",
    description: "Dictation-only Apple Speech",
    isAvailable: true,
    inferenceEnabled: true,
    selectedModelId: "macos_apple_speech",
    modelOptions: [
      { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
    ],
    downloadStatus: "Downloaded",
  },
] as unknown as AsrProviderInventory[];

function settingsFixture(): Settings {
  return {
    transcription: {
      defaultProvider: "distil_whisper",
      selectedModelId: "distil-large-v3.5",
      useSharedAsrSelection: true,
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3.5",
      meetingProvider: "distil_whisper",
      meetingModelId: "distil-large-v3.5",
      meetingRoutePolicy: "prefer_local",
    },
    privacy: {
      remoteProcessingEnabled: false,
      dictationAi: { provider: "ollama", modelId: "llama3.2" },
      meetingsAi: { provider: "ollama", modelId: "llama3.2" },
    },
  } as unknown as Settings;
}

describe("model presets", () => {
  it("costs a disk figure that only ever comes from the model catalogue", () => {
    // base.en (142 MiB) + Parakeet v3 (639 MiB), summed from asr-capabilities
    // and shown in the decimal MB Finder uses.
    expect(presetDiskLabel(preset("light"))).toBe("819 MB");
    // One model serving both lanes is counted once.
    expect(presetDiskLabel(preset("recommended"))).toBe("670 MB");
    expect(presetDiskLabel(preset("largest_models"))).toBe("4.7 GB");
    // Where the GGUF build runs, Parakeet v3 is that build (705 MiB).
    const recommendedHere = presetForThisMac(MODEL_PRESETS[0], true);
    expect(presetDiskLabel(recommendedHere)).toBe("739 MB");
    // Where the sidecar reports the download fetching something else (the
    // Neural Engine build and vocabulary model), the preset says so.
    const sized = (target: { modelId: string }) =>
      target.modelId === "parakeet-tdt-0.6b-v3-q8_0" ? 734_972_305 / (1024 * 1024) : undefined;
    expect(presetDiskLabel(recommendedHere, sized)).toBe("735 MB");
  });

  it("states a downside for every preset", () => {
    for (const entry of MODEL_PRESETS) {
      expect(entry.costs.length).toBeGreaterThan(0);
      expect(entry.buys).not.toMatch(/\bbest\b/i);
      expect(entry.name).not.toMatch(/\bbest\b/i);
    }
  });

  it("does not present upstream language counts as Plainsong-qualified coverage", () => {
    const recommended = preset("recommended");
    const widest = preset("widest_languages");

    expect(recommended.costs).toContain("Tested in English only so far");
    expect(widest.buys).toContain("built for about 100 languages");
    expect(widest.costs).toContain("Other languages aren't tested in Plainsong yet");
    for (const entry of MODEL_PRESETS) {
      expect(`${entry.buys} ${entry.costs}`).not.toMatch(
        /upstream|vendor|qualified|transducer|decodes|GGUF|ONNX|GPU|CPU|Apple Silicon/i,
      );
    }
  });

  it("offers one Parakeet v3 on every Mac, and never two presets for it", () => {
    for (const efficient of [true, false]) {
      const presets = MODEL_PRESETS.map((entry) => presetForThisMac(entry, efficient));
      expect(presets.map((entry) => entry.id)).toEqual([
        "recommended",
        "light",
        "widest_languages",
        "largest_models",
      ]);
      for (const entry of presets) {
        expect(`${entry.buys} ${entry.costs}`).not.toMatch(/Compatible|any Mac|Where Recommended/);
        expect(entry.costs.length).toBeGreaterThan(0);
        // Parakeet v3 is the GGUF build where it runs, the ONNX build elsewhere.
        for (const lane of [entry.dictationSpeech, entry.meetingSpeech]) {
          expect(lane.providerType).not.toBe(efficient ? "parakeet" : "transcribe_cpp");
        }
      }
      // No two presets set the same pair of lanes.
      const pairs = presets.map(
        (entry) =>
          `${entry.dictationSpeech.providerType}:${entry.dictationSpeech.modelId}|${entry.meetingSpeech.providerType}:${entry.meetingSpeech.modelId}`,
      );
      expect(new Set(pairs).size).toBe(pairs.length);
    }
    expect(preset("recommended").buys).toMatch(/^Parakeet v3 for dictation and meetings/);
    // The stray-words cost was measured on the GGUF build.
    expect(preset("recommended").costs).not.toMatch(/stray words/);
    expect(presetForThisMac(MODEL_PRESETS[0], true).costs).toMatch(/stray words/);
  });

  it("applies both speech lanes in one write", () => {
    const next = withModelPreset(
      settingsFixture(),
      providers,
      preset("light"),
    );

    expect(next.transcription.dictationProvider).toBe("whisper");
    expect(next.transcription.dictationModelId).toBe("base.en");
    expect(next.transcription.meetingProvider).toBe("parakeet");
    expect(next.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3");
    // base.en cannot serve meetings, so the pair has to be split -- claiming a
    // shared route here would leave the meeting lane pointing at nothing.
    expect(next.transcription.useSharedAsrSelection).toBe(false);

    expect(resolveActivePresetId(readLaneSelection(providers, next), false)).toBe(
      "light",
    );
  });

  it("leaves a configured cloud AI lane exactly as the user set it", () => {
    // The regression this guards: a preset that rewrote both AI lanes to its
    // own provider threw away a deliberate cloud choice *and* its model id --
    // and when that provider had listed no models yet, left the lane naming
    // none at all. A tile whose whole label is about speech must not do that.
    const cloudAi: Settings = {
      ...settingsFixture(),
      privacy: {
        ...settingsFixture().privacy,
        dictationAi: { provider: "anthropic", modelId: "claude-x" },
        meetingsAi: { provider: "openai", modelId: "gpt-x" },
      },
    };

    const next = withModelPreset(cloudAi, providers, preset("recommended"));

    expect(next.privacy.dictationAi).toEqual({
      provider: "anthropic",
      modelId: "claude-x",
    });
    expect(next.privacy.meetingsAi).toEqual({
      provider: "openai",
      modelId: "gpt-x",
    });
    // And the speech half still landed.
    expect(next.transcription.dictationProvider).toBe("parakeet");
  });

  it("shares one route across both lanes when the preset uses one model", () => {
    const next = withModelPreset(
      settingsFixture(),
      providers,
      preset("recommended"),
    );

    expect(next.transcription.useSharedAsrSelection).toBe(true);
    expect(next.transcription.defaultProvider).toBe("parakeet");
    expect(resolveActivePresetId(readLaneSelection(providers, next), false)).toBe(
      "recommended",
    );
  });

  it("reads as Custom once a single lane is changed underneath it", () => {
    const recommended = withModelPreset(
      settingsFixture(),
      providers,
      preset("recommended"),
    );
    expect(resolveActivePresetId(readLaneSelection(providers, recommended), false)).toBe(
      "recommended",
    );

    const changed = withSpeechLaneRoute(recommended, providers, "meeting", {
      providerType: "distil_whisper",
      modelId: "distil-large-v3.5",
    });

    expect(resolveActivePresetId(readLaneSelection(providers, changed), false)).toBeNull();
  });

  it("names the preset a change lands on rather than insisting on Custom", () => {
    // Light with its dictation lane moved to large-v3-turbo *is* the widest-
    // languages preset. Reporting Custom there would be the same lie in the
    // other direction.
    const light = withModelPreset(
      settingsFixture(),
      providers,
      preset("light"),
    );
    const changed = withSpeechLaneRoute(light, providers, "dictation", {
      providerType: "whisper",
      modelId: "large-v3-turbo",
    });

    expect(resolveActivePresetId(readLaneSelection(providers, changed), false)).toBe(
      "widest_languages",
    );
  });

  it("keeps naming the preset when an AI lane moves, because it never set one", () => {
    // The mirror of the Custom rule. A preset writes the speech lanes only, so
    // a user on Anthropic seeing "Custom" the instant they clicked Light would
    // be the same lie pointed the other way.
    const light = withModelPreset(
      settingsFixture(),
      providers,
      preset("light"),
    );
    const cloudAi: Settings = {
      ...light,
      privacy: {
        ...light.privacy,
        meetingsAi: { provider: "anthropic", modelId: null },
      },
    };

    expect(resolveActivePresetId(readLaneSelection(providers, cloudAi), false)).toBe(
      "light",
    );
  });

  it("keeps a dictation-only engine out of the meeting lane", () => {
    const next = withSpeechLaneRoute(settingsFixture(), providers, "dictation", {
      providerType: "macos_apple_speech",
      modelId: "macos_apple_speech",
    });

    expect(next.transcription.dictationProvider).toBe("macos_apple_speech");
    expect(next.transcription.useSharedAsrSelection).toBe(false);
    expect(next.transcription.meetingProvider).toBe("distil_whisper");
  });
});

describe("downloaded model index", () => {
  const files = [
    {
      name: "Whisper ggml-base.en.bin",
      provider: "whisper",
      path: "/Users/x/Library/Application Support/Plainsong/models/whisper/ggml-base.en.bin",
      sizeBytes: 148_000_000,
    },
    {
      name: "Parakeet parakeet-tdt-0.6b-v3 encoder.int8.onnx",
      provider: "parakeet",
      path: "/Users/x/Library/Application Support/Plainsong/models/parakeet/parakeet-tdt-0.6b-v3/encoder.int8.onnx",
      sizeBytes: 652_000_000,
    },
    {
      name: "Parakeet parakeet-tdt-0.6b-v2 encoder.int8.onnx",
      provider: "parakeet",
      path: "/Users/x/Library/Application Support/Plainsong/models/parakeet/parakeet-tdt-0.6b-v2/encoder.int8.onnx",
      sizeBytes: 652_000_000,
    },
    {
      name: "Silero VAD silero_vad.onnx",
      provider: "silero_vad",
      path: "/Users/x/Library/Application Support/Plainsong/models/vad/silero_vad.onnx",
      sizeBytes: 2_000_000,
    },
  ];

  it("counts only speech models, at their measured size", () => {
    const index = buildDownloadedModelIndex(files);

    expect(index.fileCount).toBe(3);
    expect(index.totalBytes).toBe(148_000_000 + 652_000_000 + 652_000_000);
  });

  it("answers per model rather than per provider", () => {
    const index = buildDownloadedModelIndex(files);

    expect(isModelOnDisk(index, "whisper", "base.en")).toBe(true);
    // The same provider, a build that was never fetched.
    expect(isModelOnDisk(index, "whisper", "large-v3-turbo")).toBe(false);
    expect(isModelOnDisk(index, "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
    expect(isModelOnDisk(index, "parakeet", "parakeet-tdt-0.6b-v2")).toBe(true);
    expect(isModelOnDisk(index, "parakeet", "parakeet-tdt-ctc-110m")).toBe(false);
    // Nothing to download, so there is nothing to claim.
    expect(isModelOnDisk(index, "openai_cloud", "whisper-1")).toBeNull();
    expect(isModelOnDisk(null, "whisper", "base.en")).toBeNull();
  });
});

describe("lane readiness", () => {
  const catalog = buildAsrRouteCatalog(providers, "prefer_local");

  function route(routeId: string) {
    const found = catalog.find((entry) => entry.routeId === routeId);
    if (!found) {
      throw new Error(`No route ${routeId}`);
    }
    return found;
  }

  it("refuses to call a model ready when its files are not on disk", () => {
    const turbo = route("whisper:large-v3-turbo");
    // The provider reports Downloaded because whisper.cpp is pointed at
    // base.en -- one status covers all ten builds it lists.
    expect(turbo.readiness).toBe("ready");
    expect(turbo.action).toBeNull();

    expect(laneRouteReadiness(turbo, false)).toEqual({
      label: "Needs download",
      tone: "attention",
      action: "download",
      actionLabel: "Download",
    });
  });

  it("stops asking for a download of a model that is already here", () => {
    const parakeet = route("parakeet:parakeet-tdt-0.6b-v3");
    expect(parakeet.readiness).toBe("needs_download");

    expect(laneRouteReadiness(parakeet, true)).toEqual({
      label: "Ready",
      tone: "ready",
      action: null,
      actionLabel: null,
    });
  });

  it("keeps the route's own answer when nothing could be measured", () => {
    const apple = route("macos_apple_speech:macos_apple_speech");

    expect(laneRouteReadiness(apple, null).label).toBe(apple.readinessLabel);
    expect(laneRouteReadiness(apple, null).action).toBe(apple.action);
  });

  it("keeps a blocker that no download would clear", () => {
    const broken = buildAsrRouteCatalog(
      providers.map((provider) =>
        provider.providerType === "whisper"
          ? ({ ...provider, isAvailable: false } as AsrProviderInventory)
          : provider,
      ),
      "prefer_local",
    );
    const turbo = broken.find(
      (entry) => entry.routeId === "whisper:large-v3-turbo",
    );

    expect(turbo?.readiness).toBe("missing_runtime");
    // "Needs download" here would be true and useless: fetching the file does
    // not fix an engine that will not load.
    expect(laneRouteReadiness(turbo!, false).label).toBe("Fix setup");
    expect(laneRouteReadiness(turbo!, false).action).toBe("fix_setup");
  });
});

describe("analysisModelChoices", () => {
  it("drops OpenAI models that cannot answer a completion", () => {
    // Every one of these contains "gpt", so a substring allowlist offered them
    // and the request failed later with a provider error the user could not act
    // on.
    const offered = analysisModelChoices("openai", [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-transcribe",
      "gpt-4o-audio-preview",
      "gpt-4o-realtime-preview",
      "gpt-image-1",
      "text-embedding-3-large",
      "omni-moderation-latest",
      "tts-1",
      "whisper-1",
    ]);

    expect(offered).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("keeps reasoning families that do not use a gpt prefix", () => {
    expect(analysisModelChoices("openai", ["o3-mini", "o4-mini", "gpt-4o"])).toEqual([
      "gpt-4o",
      "o3-mini",
      "o4-mini",
    ]);
  });

  it("drops Gemini embedding and TTS entries", () => {
    const offered = analysisModelChoices("gemini", [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-embedding-001",
      "gemini-2.5-flash-preview-tts",
    ]);

    expect(offered).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });

  it("still filters unknown providers to completion-capable models", () => {
    expect(analysisModelChoices("ollama", ["llama3.1", "nomic-embed-text"])).toEqual([
      "llama3.1",
    ]);
  });
});

describe("buildDownloadedModelIndex partial downloads", () => {
  it("does not count an in-flight download as an installed model", () => {
    // An interrupted download left a .part sibling behind, which made the
    // route read as ready and then fail when the user actually dictated.
    const index = buildDownloadedModelIndex([
      {
        provider: "whisper",
        path: "/models/whisper/ggml-base.en.bin.part",
        sizeBytes: 12_000_000,
      },
    ] as never);

    expect(isModelOnDisk(index, "whisper", "base.en")).toBe(false);
    expect(index.fileCount).toBe(0);
    expect(index.totalBytes).toBe(0);
  });

  it("still counts the completed file", () => {
    const index = buildDownloadedModelIndex([
      { provider: "whisper", path: "/models/whisper/ggml-base.en.bin", sizeBytes: 142_000_000 },
    ] as never);

    expect(isModelOnDisk(index, "whisper", "base.en")).toBe(true);
    expect(index.fileCount).toBe(1);
  });
});

describe("the Recommended preset", () => {
  const gguf = { providerType: "transcribe_cpp", modelId: "parakeet-tdt-0.6b-v3-q8_0" } as const;
  const onnx = { providerType: "parakeet", modelId: "parakeet-tdt-0.6b-v3" } as const;
  const recommendedHere = presetForThisMac(MODEL_PRESETS[0], true);

  it("matches the lanes a new Apple Silicon install starts with: GGUF Parakeet for both", () => {
    expect(
      resolveActivePresetId({ dictationSpeech: gguf, meetingSpeech: gguf }, true),
    ).toBe("recommended");
    expect(recommendedHere.dictationSpeech).toEqual(gguf);
    expect(recommendedHere.meetingSpeech).toEqual(gguf);
    // One model serving both lanes is one download, counted once.
    expect(presetDiskLabel(recommendedHere)).toBe("739 MB");
  });

  it("reads a lane still on the ONNX build as the same Parakeet v3", () => {
    // A beta.6 install dictates on GGUF and records meetings on ONNX: on a
    // Mac that runs the GGUF build both are Parakeet v3, and Settings offers
    // the GGUF download beside the preset.
    expect(
      resolveActivePresetId({ dictationSpeech: gguf, meetingSpeech: onnx }, true),
    ).toBe("recommended");
    expect(
      resolveActivePresetId({ dictationSpeech: onnx, meetingSpeech: onnx }, true),
    ).toBe("recommended");
    // Where the GGUF build can't run, a GGUF lane is no preset at all.
    expect(
      resolveActivePresetId({ dictationSpeech: gguf, meetingSpeech: onnx }, false),
    ).toBeNull();
    expect(
      resolveActivePresetId({ dictationSpeech: onnx, meetingSpeech: onnx }, false),
    ).toBe("recommended");
  });

  it("claims only what was measured, and names its costs", () => {
    expect(recommendedHere.buys).toMatch(/for dictation and meetings, in one download/i);
    expect(recommendedHere.buys).not.toMatch(/faster|quicker|Compatible/i);
    expect(recommendedHere.costs).toMatch(/stray words/i);
    expect(recommendedHere.costs).toMatch(/English only so far/);
    // Internal scheduling is not a chooser's cost.
    expect(recommendedHere.costs).not.toMatch(/one recording at a time|Apple Silicon/i);
    expect(recommendedHere.costs).not.toMatch(/two downloads/i);
  });

  it("reads back as Recommended once applied on a build that lists GGUF Parakeet", () => {
    const withGguf = [
      ...providers,
      {
        providerType: "transcribe_cpp",
        name: "transcribe.cpp",
        description: "GGUF Parakeet",
        isAvailable: true,
        inferenceEnabled: true,
        selectedModelId: gguf.modelId,
        modelOptions: [{ id: gguf.modelId, label: "Parakeet TDT 0.6B v3 GGUF Q8_0" }],
        downloadStatus: "NotDownloaded",
      },
    ] as unknown as AsrProviderInventory[];
    const next = withModelPreset(settingsFixture(), withGguf, recommendedHere);
    // The same shape `Settings::fresh_install` writes: split lanes on GGUF,
    // and a shared default that never names GGUF but its ONNX substitute.
    expect(next.transcription).toMatchObject({
      useSharedAsrSelection: false,
      defaultProvider: "parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      dictationProvider: "transcribe_cpp",
      dictationModelId: gguf.modelId,
      meetingProvider: "transcribe_cpp",
      meetingModelId: gguf.modelId,
    });
    expect(resolveActivePresetId(readLaneSelection(withGguf, next), true)).toBe("recommended");
  });

  it("never writes a GGUF route into the shared default when one lane moves to it", () => {
    const withGguf = [
      ...providers,
      {
        providerType: "transcribe_cpp",
        name: "transcribe.cpp",
        description: "GGUF Parakeet",
        isAvailable: true,
        inferenceEnabled: true,
        selectedModelId: gguf.modelId,
        modelOptions: [{ id: gguf.modelId, label: "Parakeet TDT 0.6B v3 GGUF Q8_0" }],
        downloadStatus: "NotDownloaded",
      },
    ] as unknown as AsrProviderInventory[];
    const next = withSpeechLaneRoute(settingsFixture(), withGguf, "dictation", gguf);
    expect(next.transcription.useSharedAsrSelection).toBe(false);
    expect(next.transcription.dictationProvider).toBe("transcribe_cpp");
    expect(next.transcription.defaultProvider).not.toBe("transcribe_cpp");
  });
});
