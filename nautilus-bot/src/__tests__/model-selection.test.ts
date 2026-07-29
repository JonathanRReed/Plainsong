import { describe, expect, it } from "vitest";
import {
  MODEL_PRESETS,
  presetDiskLabel,
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
import { laneRouteReadiness } from "@/components/models/model-facts";
import { buildAsrRouteCatalog } from "@/lib/asr-route-catalog";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";

function preset(id: ModelPreset["id"]): ModelPreset {
  const found = MODEL_PRESETS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No preset ${id}`);
  }
  return found;
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
    // base.en (142 MiB) + Parakeet v3 (639 MiB), summed from asr-capabilities.
    expect(presetDiskLabel(preset("light"))).toBe("781 MiB");
    // One model serving both lanes is counted once.
    expect(presetDiskLabel(preset("balanced"))).toBe("639 MiB");
    expect(presetDiskLabel(preset("largest_models"))).toBe("3.1 GiB");
  });

  it("states a downside for every preset", () => {
    for (const entry of MODEL_PRESETS) {
      expect(entry.costs.length).toBeGreaterThan(0);
      expect(entry.buys).not.toMatch(/\bbest\b/i);
      expect(entry.name).not.toMatch(/\bbest\b/i);
    }
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

    expect(resolveActivePresetId(readLaneSelection(providers, next))).toBe(
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

    const next = withModelPreset(cloudAi, providers, preset("balanced"));

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
      preset("balanced"),
    );

    expect(next.transcription.useSharedAsrSelection).toBe(true);
    expect(next.transcription.defaultProvider).toBe("parakeet");
    expect(resolveActivePresetId(readLaneSelection(providers, next))).toBe(
      "balanced",
    );
  });

  it("reads as Custom once a single lane is changed underneath it", () => {
    const balanced = withModelPreset(
      settingsFixture(),
      providers,
      preset("balanced"),
    );
    expect(resolveActivePresetId(readLaneSelection(providers, balanced))).toBe(
      "balanced",
    );

    const changed = withSpeechLaneRoute(balanced, providers, "meeting", {
      providerType: "distil_whisper",
      modelId: "distil-large-v3.5",
    });

    expect(resolveActivePresetId(readLaneSelection(providers, changed))).toBeNull();
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

    expect(resolveActivePresetId(readLaneSelection(providers, changed))).toBe(
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

    expect(resolveActivePresetId(readLaneSelection(providers, cloudAi))).toBe(
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
      name: "Silero VAD silero_vad.onnx",
      provider: "silero_vad",
      path: "/Users/x/Library/Application Support/Plainsong/models/vad/silero_vad.onnx",
      sizeBytes: 2_000_000,
    },
  ];

  it("counts only speech models, at their measured size", () => {
    const index = buildDownloadedModelIndex(files);

    expect(index.fileCount).toBe(2);
    expect(index.totalBytes).toBe(148_000_000 + 652_000_000);
  });

  it("answers per model rather than per provider", () => {
    const index = buildDownloadedModelIndex(files);

    expect(isModelOnDisk(index, "whisper", "base.en")).toBe(true);
    // The same provider, a build that was never fetched.
    expect(isModelOnDisk(index, "whisper", "large-v3-turbo")).toBe(false);
    expect(isModelOnDisk(index, "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
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
