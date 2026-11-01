import { describe, expect, it, vi } from "vitest";
import {
  probeDictationAiLane,
  probeDictationAiLaneReadiness,
  resolveDictationRecognizer,
  resolveTranslateToEnglishAvailability,
  TRANSLATE_ENGLISH_ONLY_MODEL_COPY,
  TRANSLATE_NEEDS_AI_PROVIDER_COPY,
} from "@/lib/dictation-translation";

vi.mock("@/lib/backend", () => ({
  getOllamaStatus: vi.fn(async () => true),
  hasProviderSecret: vi.fn(async () => true),
}));

vi.mock("@/lib/backend/ai", () => ({
  getNativeTextModelStatus: vi.fn(),
  listOllamaModels: vi.fn(async () => ["qwen3.5:4b"]),
  listOllamaModelCatalog: vi.fn(async () => []),
  getLocalTextRuntimeHealth: vi.fn(async () => ({
    localGateApplies: true,
    runtimeHealth: { state: "available", message: null },
  })),
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
  const bundledStatus = {
    provider: "bundled_local", modelId: "s1-mini", displayName: "S1-mini", vendor: "Superwhisper",
    downloadBytes: 484219808, bytesOnDisk: 484219808, ready: true, missingFiles: [], path: "/models",
    backend: "metal", backendMeetsBudget: true, backendPresent: true, residentBytes: 1200000000,
  };

  it("checks bundled cleanup without requiring Ollama or cloud credentials", async () => {
    const deps = {
      getOllamaStatus: vi.fn(async () => false),
      hasProviderSecret: vi.fn(async () => false),
      getBundledCleanupModelStatus: vi.fn(async () => bundledStatus),
    };
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "bundled_local", modelId: null }, remoteProcessingEnabled: false,
    }, deps)).resolves.toEqual({ ready: true, message: null });
    expect(deps.getBundledCleanupModelStatus).toHaveBeenCalledOnce();
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
    expect(deps.hasProviderSecret).not.toHaveBeenCalled();
  });

  it.each([
    { ready: false }, { backendPresent: false }, { backendMeetsBudget: false },
  ])("refuses confirmed bundled cleanup blockers: %o", async (override) => {
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "bundled_local", modelId: "s1-mini" }, remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true),
      getBundledCleanupModelStatus: vi.fn(async () => ({ ...bundledStatus, ...override })),
    })).resolves.toMatchObject({ ready: false });
  });

  it("refuses a mismatched bundled model and reports failed status checks as unknown", async () => {
    const deps = {
      getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true),
      getBundledCleanupModelStatus: vi.fn(async () => bundledStatus),
    };
    const privacy = { dictationAi: { provider: "bundled_local", modelId: "other" }, remoteProcessingEnabled: false };
    await expect(probeDictationAiLaneReadiness(privacy, deps)).resolves.toMatchObject({ ready: false });
    deps.getBundledCleanupModelStatus.mockRejectedValueOnce(new Error("unavailable"));
    await expect(probeDictationAiLaneReadiness(privacy, deps)).resolves.toMatchObject({ ready: null });
  });

  it.each(["bundled_local", "apple_language_model"])("does not offer %s cleanup for translation", async (provider) => {
    const deps = {
      getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true),
      getBundledCleanupModelStatus: vi.fn(async () => bundledStatus),
    };
    await expect(probeDictationAiLane({
      dictationAi: { provider, modelId: null }, remoteProcessingEnabled: false,
    }, deps)).resolves.toBe(false);
    expect(deps.getBundledCleanupModelStatus).not.toHaveBeenCalled();
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses Apple availability without Ollama: %s", async (available) => {
    const deps = {
      getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true),
      getAppleLanguageModelAvailability: vi.fn(async () => ({
        provider: "apple_language_model", displayName: "Apple on-device", available,
        reason: available ? null : "model_not_ready", detail: available ? null : "Enable Apple Intelligence.",
        operatingSystemVersion: "26",
      })),
    };
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "apple_language_model", modelId: "apple-on-device" }, remoteProcessingEnabled: false,
    }, deps)).resolves.toEqual({ ready: available, message: available ? null : "Enable Apple Intelligence." });
    expect(deps.getAppleLanguageModelAvailability).toHaveBeenCalledWith();
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
  });

  it("does not infer unknown provider readiness from Ollama", async () => {
    const deps = { getOllamaStatus: vi.fn(async () => true), hasProviderSecret: vi.fn(async () => true) };
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "unsupported", modelId: null }, remoteProcessingEnabled: false,
    }, deps)).resolves.toEqual({ ready: null, message: null });
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
    expect(deps.hasProviderSecret).not.toHaveBeenCalled();
  });

  const nativeStatus = {
    provider: "native_text" as const,
    modelId: "qwen3-4b-instruct-2507-q4_k_m",
    displayName: "Qwen3 4B Instruct",
    downloadBytes: 2_500_000_000,
    bytesOnDisk: 2_500_000_000,
    ready: true,
    missingFiles: [],
    runtimePresent: true,
    runtimeHealth: { state: "available" as const, message: null },
    memoryAvailableBytes: 20_000_000_000,
    canLoadNow: true,
    qualified: false,
    contextTokens: 8192,
  };

  it.each([null, nativeStatus.modelId])("checks native files and memory without Ollama for model %s", async (modelId) => {
    const deps = {
      getOllamaStatus: vi.fn(async () => false),
      hasProviderSecret: vi.fn(async () => false),
      getNativeTextModelStatus: vi.fn(async () => nativeStatus),
    };
    await expect(probeDictationAiLane({
      dictationAi: { provider: "native_text", modelId },
      remoteProcessingEnabled: false,
    }, deps)).resolves.toBe(true);
    expect(deps.getNativeTextModelStatus).toHaveBeenCalledOnce();
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
    expect(deps.hasProviderSecret).not.toHaveBeenCalled();
  });

  it.each([
    { runtimePresent: false },
    { ready: false, missingFiles: ["weights"] },
    { canLoadNow: false },
  ])("refuses a native lane with a confirmed blocker: %o", async (override) => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => ({ ...nativeStatus, ...override })),
    })).resolves.toBe(false);
  });

  it("refuses a native model ID that is not the managed model", async () => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "native_text", modelId: "other-model" },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => nativeStatus),
    })).resolves.toBe(false);
  });

  it.each(["completion_unknown", "storage_error"] as const)("refuses a native runtime paused by %s", async (state) => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => ({
        ...nativeStatus, runtimeHealth: { state, message: "Local AI is paused." },
      })),
    })).resolves.toBe(false);
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => ({
        ...nativeStatus, runtimeHealth: { state, message: "Local AI is paused." },
      })),
    })).resolves.toEqual({ ready: false, message: "Local AI is paused." });
  });

  it.each([
    undefined,
    { state: "busy" as const, message: "Local AI is in use." },
  ])("reports unknown while native runtime health is unavailable or busy: %o", async (runtimeHealth) => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => ({ ...nativeStatus, runtimeHealth })),
    })).resolves.toBeNull();
  });

  it.each([
    [{ runtimePresent: false }, "The built-in text model isn't available in this version of Plainsong."],
    [{ ready: false }, "Download and verify the built-in text model before using this profile."],
    [{ canLoadNow: false }, "Not enough free memory right now. Close apps you aren't using, or try again later."],
  ] as const)("names a native blocker without credential advice: %o", async (override, message) => {
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => false),
      hasProviderSecret: vi.fn(async () => false),
      getNativeTextModelStatus: vi.fn(async () => ({ ...nativeStatus, ...override })),
    })).resolves.toEqual({ ready: false, message });
  });

  it("retains the native busy cause as a temporary status", async () => {
    await expect(probeDictationAiLaneReadiness({
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => false),
      hasProviderSecret: vi.fn(async () => false),
      getNativeTextModelStatus: vi.fn(async () => ({
        ...nativeStatus, runtimeHealth: { state: "busy" as const, message: "Another local text operation is running." },
      })),
    })).resolves.toEqual({ ready: null, message: "Another local text operation is running." });
  });

  it("reports unknown when native status or memory cannot be checked", async () => {
    const privacy = {
      dictationAi: { provider: "native_text", modelId: null },
      remoteProcessingEnabled: false,
    };
    const deps = {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => true),
      getNativeTextModelStatus: vi.fn(async () => ({
        ...nativeStatus, memoryAvailableBytes: null, canLoadNow: false,
      })),
    };
    await expect(probeDictationAiLane(privacy, deps)).resolves.toBeNull();
    deps.getNativeTextModelStatus.mockRejectedValueOnce(new Error("Status unavailable"));
    await expect(probeDictationAiLane(privacy, deps)).resolves.toBeNull();
    expect(deps.getOllamaStatus).not.toHaveBeenCalled();
  });

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

  it.each([
    ["available", true],
    ["completion_unknown", false],
    ["storage_error", false],
    ["busy", null],
  ] as const)("uses execution eligibility for an installed Ollama model: %s", async (state, expected) => {
    const getLocalTextRuntimeHealth = vi.fn(async () => ({
      localGateApplies: true,
      runtimeHealth: { state, message: null },
    }));
    await expect(probeDictationAiLane({
      dictationAi: { provider: "ollama", modelId: "selected:latest" },
      remoteProcessingEnabled: false,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => false),
      listOllamaModels: vi.fn(async () => ["selected:latest"]),
      listOllamaModelCatalog: vi.fn(async () => []),
      getLocalTextRuntimeHealth,
    })).resolves.toBe(expected);
    expect(getLocalTextRuntimeHealth).toHaveBeenCalledWith("selected:latest");
  });

  it.each([false, true])("requires remote consent for an Ollama alias: %s", async (remoteProcessingEnabled) => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "ollama", modelId: "remote:latest" },
      remoteProcessingEnabled,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => false),
      listOllamaModels: vi.fn(async () => ["remote:latest"]),
      listOllamaModelCatalog: vi.fn(async () => []),
      getLocalTextRuntimeHealth: vi.fn(async () => ({
        localGateApplies: false,
        runtimeHealth: { state: "completion_unknown" as const, message: "Local AI is paused." },
      })),
    })).resolves.toBe(remoteProcessingEnabled);
  });

  it("reports unknown when Ollama execution metadata is unverified", async () => {
    await expect(probeDictationAiLane({
      dictationAi: { provider: "ollama", modelId: null },
      remoteProcessingEnabled: true,
    }, {
      getOllamaStatus: vi.fn(async () => true),
      hasProviderSecret: vi.fn(async () => false),
      getLocalTextRuntimeHealth: vi.fn(async () => ({
        localGateApplies: null,
        runtimeHealth: { state: "available" as const, message: null },
      })),
    })).resolves.toBeNull();
  });

  it("checks cached ChatGPT account and model state without asking for an API key", async () => {
    const hasProviderSecret = vi.fn(async () => false);
    await expect(
      probeDictationAiLane(
        {
          dictationAi: { provider: "chatgpt_plan", modelId: "gpt-5" },
          remoteProcessingEnabled: true,
        },
        {
          getOllamaStatus: vi.fn(async () => false),
          hasProviderSecret,
          getChatGptPlanStatus: vi.fn(async () => ({
            loaded: true,
            modelsReady: true,
            accounts: [{ clientId: "one", label: "Jonathan", active: true, connected: true, planEnabled: true }],
            models: [{ slug: "gpt-5", displayName: "GPT-5" }],
          })),
        },
      ),
    ).resolves.toBe(true);
    expect(hasProviderSecret).not.toHaveBeenCalled();
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
