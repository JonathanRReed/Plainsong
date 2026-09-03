import { describe, expect, it, vi } from "vitest";
import {
  probeDictationAiLane,
  resolveDictationRecognizer,
  resolveTranslateToEnglishAvailability,
  TRANSLATE_ENGLISH_ONLY_MODEL_COPY,
  TRANSLATE_NEEDS_AI_PROVIDER_COPY,
} from "@/lib/dictation-translation";

vi.mock("@/lib/backend", () => ({
  getOllamaStatus: vi.fn(async () => true),
  hasProviderSecret: vi.fn(async () => true),
}));

describe("resolveTranslateToEnglishAvailability", () => {
  it("lets multilingual whisper.cpp translate on its own", () => {
    const availability = resolveTranslateToEnglishAvailability({
      provider: "whisper",
      modelId: "base",
      aiLaneReady: false,
    });
    expect(availability.enabled).toBe(true);
    expect(availability.route).toBe("whisper_native");
  });

  it("disables the toggle for an English-only whisper model and says why", () => {
    const availability = resolveTranslateToEnglishAvailability({
      provider: "whisper",
      modelId: "base.en",
      aiLaneReady: true,
    });
    expect(availability.enabled).toBe(false);
    expect(availability.description).toBe(TRANSLATE_ENGLISH_ONLY_MODEL_COPY);
  });

  it("routes every other recognizer through the AI lane and needs a provider for it", () => {
    for (const [provider, modelId] of [
      ["parakeet", "parakeet-tdt-0.6b-v3"],
      ["qwen3_asr", "qwen3-asr-0.6b"],
      ["macos_apple_speech", "apple"],
      ["openai_cloud", "gpt-4o-transcribe"],
      ["whisper_candle", "large-v3"],
    ]) {
      const ready = resolveTranslateToEnglishAvailability({ provider, modelId, aiLaneReady: true });
      expect(ready).toMatchObject({ enabled: true, route: "ai_lane" });
      const notReady = resolveTranslateToEnglishAvailability({
        provider,
        modelId,
        aiLaneReady: false,
      });
      expect(notReady).toEqual({
        enabled: false,
        route: "ai_lane",
        description: TRANSLATE_NEEDS_AI_PROVIDER_COPY,
      });
    }
  });

  it("keeps the toggle usable while the AI lane probe has not answered", () => {
    expect(
      resolveTranslateToEnglishAvailability({
        provider: "parakeet",
        modelId: "parakeet-tdt-0.6b-v3",
        aiLaneReady: null,
      }).enabled,
    ).toBe(true);
  });
});

describe("resolveDictationRecognizer", () => {
  it("follows the shared selection unless dictation has its own", () => {
    expect(
      resolveDictationRecognizer({
        useSharedAsrSelection: true,
        defaultProvider: "whisper",
        selectedModelId: "base.en",
        dictationProvider: "parakeet",
        dictationModelId: "parakeet-tdt-0.6b-v3",
      }),
    ).toEqual({ provider: "whisper", modelId: "base.en" });
    expect(
      resolveDictationRecognizer({
        useSharedAsrSelection: false,
        defaultProvider: "whisper",
        selectedModelId: "base.en",
        dictationProvider: "parakeet",
        dictationModelId: "parakeet-tdt-0.6b-v3",
      }),
    ).toEqual({ provider: "parakeet", modelId: "parakeet-tdt-0.6b-v3" });
  });
});

describe("probeDictationAiLane", () => {
  it("asks Ollama for the local route and the keychain for a cloud one", async () => {
    const deps = {
      getOllamaStatus: vi.fn(async () => false),
      hasProviderSecret: vi.fn(async () => true),
    };
    await expect(
      probeDictationAiLane(
        { dictationAi: { provider: "ollama", modelId: null }, remoteProcessingEnabled: false },
        deps,
      ),
    ).resolves.toBe(false);
    await expect(
      probeDictationAiLane(
        { dictationAi: { provider: "openai", modelId: null }, remoteProcessingEnabled: true },
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.hasProviderSecret).toHaveBeenCalledWith("openai");
  });

  // The sidecar never stores an empty lane provider (it normalizes an empty
  // one back to "ollama"), so a blank provider means the renderer has not
  // loaded settings yet, not "no lane configured". Reporting `false` there
  // would flash a "Needs an AI provider" refusal on every mount.
  it("reports unknown, not unavailable, before settings have loaded", async () => {
    await expect(
      probeDictationAiLane(
        { dictationAi: { provider: "", modelId: null }, remoteProcessingEnabled: true },
        {
          getOllamaStatus: vi.fn(async () => true),
          hasProviderSecret: vi.fn(async () => true),
        },
      ),
    ).resolves.toBeNull();
  });

  it("refuses a cloud lane while remote processing is off, and reports unknown on a failed probe", async () => {
    await expect(
      probeDictationAiLane(
        { dictationAi: { provider: "anthropic", modelId: null }, remoteProcessingEnabled: false },
        { getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true) },
      ),
    ).resolves.toBe(false);
    await expect(
      probeDictationAiLane(
        { dictationAi: { provider: "ollama", modelId: null }, remoteProcessingEnabled: false },
        {
          getOllamaStatus: vi.fn(async () => {
            throw new Error("sidecar down");
          }),
          hasProviderSecret: vi.fn(async () => true),
        },
      ),
    ).resolves.toBeNull();
  });
});
