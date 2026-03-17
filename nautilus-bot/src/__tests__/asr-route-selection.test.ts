import { describe, expect, it } from "vitest";
import {
  mergeSelectionStateUpdate,
  selectionStateFromSettings,
  type AsrRouteSelectionState,
} from "@/lib/asr-route-selection";
import type { AsrProviderInfo, TranscriptionSettings } from "@/types";

const providers: AsrProviderInfo[] = [
  {
    providerType: "whisper",
    name: "Whisper",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Whisper",
      version: "base.en",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "base.en",
    modelOptions: [
      { id: "base.en", label: "base.en" },
      { id: "large-v3-turbo", label: "large-v3-turbo" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "distil_whisper",
    name: "Distil Whisper",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Distil Whisper",
      version: "distil-large-v3.5",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "distil-large-v3.5" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "moonshine",
    name: "Moonshine",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Moonshine",
      version: "moonshine-base",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "moonshine-base",
    modelOptions: [
      { id: "moonshine-tiny", label: "moonshine-tiny" },
      { id: "moonshine-base", label: "moonshine-base" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "whisper_candle",
    name: "Whisper Candle",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Whisper Candle",
      version: "whisper-large-v3-turbo",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "whisper-large-v3-turbo",
    modelOptions: [
      { id: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "parakeet",
    name: "Parakeet",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Parakeet",
      version: "parakeet-ctc-0.6b",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "parakeet-ctc-0.6b",
    modelOptions: [{ id: "parakeet-ctc-0.6b", label: "parakeet-ctc-0.6b" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "voxtral",
    name: "Voxtral",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Voxtral",
      version: "voxtral-local",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "voxtral-local",
    modelOptions: [{ id: "voxtral-local", label: "voxtral-local" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "openai_cloud",
    name: "OpenAI Cloud",
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "OpenAI Cloud",
      version: "whisper-1",
      sizeMb: 0,
      parameters: "",
      languages: ["en"],
      license: "commercial",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "whisper-1",
    modelOptions: [{ id: "whisper-1", label: "whisper-1" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
];

function makeTranscriptionSettings(
  overrides: Partial<TranscriptionSettings> = {}
): TranscriptionSettings {
  return {
    defaultProvider: "distil_whisper",
    selectedModelId: "distil-large-v3.5",
    useSharedAsrSelection: true,
    dictationProvider: "distil_whisper",
    dictationModelId: "distil-large-v3.5",
    meetingProvider: "distil_whisper",
    meetingModelId: "distil-large-v3.5",
    meetingRoutePolicy: "prefer_local",
    mlxAcceleratedProviders: [],
    dictationMlxEnabled: false,
    meetingMlxEnabled: false,
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    language: null,
    numSpeakers: 0,
    speakerNamingMethod: "auto",
    silenceSkipEnabled: false,
    dictationPasteToCursor: true,
    dictationPushToTalk: true,
    dictationAiFormatting: false,
    dictationCustomPrompt: null,
    meetingCustomPrompt: null,
    saveRawTranscript: false,
    dictationSaveToInbox: true,
    dictationProfile: "normal_speed",
    dictationProjectId: "inbox",
    dictationSilenceTimeoutSeconds: 0,
    memorySearchMode: "fts",
    embeddingModel: "nomic-embed-text",
    enableAutoAnalysis: true,
    ...overrides,
  };
}

const baseState: AsrRouteSelectionState = {
  defaultProvider: "distil_whisper",
  defaultModelId: "distil-large-v3.5",
  useSharedAsrSelection: true,
  dictationProvider: "distil_whisper",
  dictationModelId: "distil-large-v3.5",
  meetingProvider: "distil_whisper",
  meetingModelId: "distil-large-v3.5",
  dictationMlxEnabled: false,
  meetingMlxEnabled: false,
  meetingRoutePolicy: "prefer_local",
};

describe("asr-route-selection", () => {
  it("splits shared selection when default provider is dictation-only", () => {
    const selection = selectionStateFromSettings(
      providers,
      makeTranscriptionSettings({
        defaultProvider: "moonshine",
        selectedModelId: "moonshine-base",
        dictationProvider: "moonshine",
        dictationModelId: "moonshine-base",
        meetingProvider: "moonshine",
        meetingModelId: "moonshine-base",
      })
    );

    expect(selection.useSharedAsrSelection).toBe(false);
    expect(selection.dictationProvider).toBe("moonshine");
    expect(selection.meetingProvider).toBe("distil_whisper");
  });

  it("splits whisper candle shared selection into dictation plus meeting-grade fallback", () => {
    const selection = selectionStateFromSettings(
      providers,
      makeTranscriptionSettings({
        defaultProvider: "whisper_candle",
        selectedModelId: "whisper-large-v3-turbo",
        dictationProvider: "whisper_candle",
        dictationModelId: "whisper-large-v3-turbo",
        meetingProvider: "whisper_candle",
        meetingModelId: "whisper-large-v3-turbo",
      })
    );

    expect(selection.useSharedAsrSelection).toBe(false);
    expect(selection.dictationProvider).toBe("whisper_candle");
    expect(selection.meetingProvider).toBe("distil_whisper");
  });

  it("migrates legacy mlx routes into visible providers and slot mlx flags", () => {
    const selection = selectionStateFromSettings(
      providers,
      makeTranscriptionSettings({
        defaultProvider: "mlx_audio",
        selectedModelId: "UsefulSensors/moonshine-base",
        dictationProvider: "mlx_audio",
        dictationModelId: "UsefulSensors/moonshine-base",
      })
    );

    expect(selection.defaultProvider).toBe("moonshine");
    expect(selection.defaultModelId).toBe("moonshine-base");
    expect(selection.dictationMlxEnabled).toBe(true);
  });

  it("keeps explicit meeting provider when split routes are valid", () => {
    const selection = selectionStateFromSettings(
      providers,
      makeTranscriptionSettings({
        useSharedAsrSelection: false,
        dictationProvider: "moonshine",
        dictationModelId: "moonshine-base",
        meetingProvider: "parakeet",
        meetingModelId: "parakeet-ctc-0.6b",
      })
    );

    expect(selection.useSharedAsrSelection).toBe(false);
    expect(selection.meetingProvider).toBe("parakeet");
    expect(selection.meetingModelId).toBe("parakeet-ctc-0.6b");
  });

  it("prefers cloud meeting fallback first when best_available is selected", () => {
    const selection = selectionStateFromSettings(
      providers,
      makeTranscriptionSettings({
        useSharedAsrSelection: false,
        defaultProvider: "moonshine",
        selectedModelId: "moonshine-base",
        dictationProvider: "moonshine",
        dictationModelId: "moonshine-base",
        meetingProvider: "moonshine",
        meetingModelId: "moonshine-base",
        meetingRoutePolicy: "best_available",
      })
    );

    expect(selection.meetingProvider).toBe("openai_cloud");
  });

  it("drops mlx flags when the chosen model no longer supports mlx", () => {
    const selection = mergeSelectionStateUpdate(providers, baseState, {
      defaultProvider: "whisper",
      defaultModelId: "base.en",
      useSharedAsrSelection: false,
      dictationProvider: "whisper",
      dictationModelId: "base.en",
      dictationMlxEnabled: true,
      meetingProvider: "distil_whisper",
      meetingModelId: "distil-large-v3.5",
      meetingMlxEnabled: true,
    });

    expect(selection.dictationMlxEnabled).toBe(true);
    expect(selection.meetingMlxEnabled).toBe(false);
  });

  it("forces split routes when turning shared selection on for a dictation-only default", () => {
    const selection = mergeSelectionStateUpdate(
      providers,
      {
        ...baseState,
        useSharedAsrSelection: false,
        defaultProvider: "moonshine",
        defaultModelId: "moonshine-base",
        dictationProvider: "moonshine",
        dictationModelId: "moonshine-base",
        meetingProvider: "distil_whisper",
        meetingModelId: "distil-large-v3.5",
      },
      { useSharedAsrSelection: true }
    );

    expect(selection.useSharedAsrSelection).toBe(false);
    expect(selection.dictationProvider).toBe("moonshine");
    expect(selection.meetingProvider).toBe("distil_whisper");
  });
});
