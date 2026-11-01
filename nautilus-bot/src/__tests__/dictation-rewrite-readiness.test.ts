import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OLLAMA_REWRITE_MODEL,
  dictationModeNeedsRewrite,
  probeOllamaRewriteModel,
  probeOllamaRewriteReadiness,
  resolveDictationRewriteReadiness,
  resolveDictationCleanupReadiness,
} from "@/lib/dictation-rewrite-readiness";

vi.mock("@/lib/backend/ai", () => ({
  getLocalTextRuntimeHealth: vi.fn(async () => ({
    localGateApplies: true,
    runtimeHealth: { state: "available", message: null },
  })),
}));

const catalogEntry = (overrides: Record<string, unknown> = {}) => ({
  id: DEFAULT_OLLAMA_REWRITE_MODEL,
  displayName: "Qwen 3.5 4B",
  provider: "Alibaba via Ollama",
  diskSizeBytes: 3_000_000_000,
  contextTokens: 32_768,
  minimumMemoryBytes: null,
  recommendedMemoryBytes: null,
  license: "Apache-2.0",
  disclosure: null,
  lanes: ["dictation"],
  expectedManifestDigest: null,
  installed: true,
  installedDigest: null,
  installedSizeBytes: 3_000_000_000,
  ready: true,
  ...overrides,
});

describe("dictation rewrite readiness", () => {
  it("leaves conservative cleanup profiles alone", () => {
    expect(
      dictationModeNeedsRewrite({ profile: "normal_speed", customPrompt: null }),
    ).toBe(false);
    expect(
      resolveDictationRewriteReadiness({
        needsRewrite: false,
        profileName: "General",
        provider: "bundled_local",
        remoteProcessingEnabled: false,
        aiLaneReady: true,
      }),
    ).toBeNull();
  });

  it("requires a capable model for power rewrite and explicit prompts", () => {
    expect(
      dictationModeNeedsRewrite({ profile: "power_rewrite", customPrompt: null }),
    ).toBe(true);
    expect(
      dictationModeNeedsRewrite({
        profile: "normal_speed",
        customPrompt: "Tighten this draft.",
      }),
    ).toBe(true);

    for (const provider of ["bundled_local", "apple_language_model"]) {
      expect(
        resolveDictationRewriteReadiness({
          needsRewrite: true,
          profileName: "Writing",
          provider,
          remoteProcessingEnabled: false,
          aiLaneReady: true,
        }),
      ).toMatchObject({
        title: "Writing needs a rewrite model",
        tone: "rust",
      });
    }
  });

  it("distinguishes local runtime, remote policy, checking, and ready states", () => {
    expect(
      resolveDictationRewriteReadiness({
        needsRewrite: true,
        profileName: "Writing",
        provider: "ollama",
        remoteProcessingEnabled: false,
        aiLaneReady: false,
      })?.title,
    ).toBe("Ollama is not ready");
    expect(
      resolveDictationRewriteReadiness({
        needsRewrite: true,
        profileName: "Writing",
        provider: "openai",
        remoteProcessingEnabled: false,
        aiLaneReady: true,
      })?.title,
    ).toBe("Cloud rewriting is off");
    expect(
      resolveDictationRewriteReadiness({
        needsRewrite: true,
        profileName: "Writing",
        provider: "ollama",
        remoteProcessingEnabled: false,
        aiLaneReady: null,
      })?.tone,
    ).toBe("muted");
    expect(
      resolveDictationRewriteReadiness({
        needsRewrite: true,
        profileName: "Writing",
        provider: "ollama",
        remoteProcessingEnabled: false,
        aiLaneReady: true,
      }),
    ).toBeNull();
  });

  it("checks the exact selected Ollama model or the backend default", async () => {
    const listCatalog = async () => [
      catalogEntry(),
      catalogEntry({ id: "other:latest", ready: false }),
    ];

    const listInstalledModels = async () => [
      DEFAULT_OLLAMA_REWRITE_MODEL,
      "other:latest",
      "gemma4:e4b",
    ];
    await expect(
      probeOllamaRewriteModel(null, listInstalledModels, listCatalog),
    ).resolves.toBe(true);
    await expect(
      probeOllamaRewriteModel(
        "other:latest",
        listInstalledModels,
        listCatalog,
      ),
    ).resolves.toBe(false);
    await expect(
      probeOllamaRewriteModel(
        "missing:latest",
        listInstalledModels,
        listCatalog,
      ),
    ).resolves.toBe(false);
    await expect(
      probeOllamaRewriteModel(
        DEFAULT_OLLAMA_REWRITE_MODEL,
        listInstalledModels,
        async () => [catalogEntry({ installed: false })],
      ),
    ).resolves.toBe(false);
    await expect(
      probeOllamaRewriteModel(
        "gemma4:e4b",
        listInstalledModels,
        listCatalog,
      ),
    ).resolves.toBe(true);
    await expect(
      probeOllamaRewriteModel(
        DEFAULT_OLLAMA_REWRITE_MODEL,
        async () => {
          throw new Error("Ollama unavailable");
        },
        listCatalog,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["completion_unknown", false],
    ["storage_error", false],
    ["busy", null],
  ] as const)("does not treat installed rewrite files as execution permission: %s", async (state, expected) => {
    await expect(probeOllamaRewriteModel(
      DEFAULT_OLLAMA_REWRITE_MODEL,
      async () => [DEFAULT_OLLAMA_REWRITE_MODEL],
      async () => [catalogEntry()],
      { getRuntimeHealth: async () => ({
        localGateApplies: true, runtimeHealth: { state, message: null },
      }) },
    )).resolves.toBe(expected);
    const readiness = await probeOllamaRewriteReadiness(
      DEFAULT_OLLAMA_REWRITE_MODEL,
      async () => [DEFAULT_OLLAMA_REWRITE_MODEL],
      async () => [catalogEntry()],
      { getRuntimeHealth: async () => ({
        localGateApplies: true, runtimeHealth: { state, message: "Preserve this runtime cause." },
      }) },
    );
    expect(readiness).toEqual({ ready: expected, message: "Preserve this runtime cause." });
    expect(resolveDictationRewriteReadiness({
      needsRewrite: true, profileName: "Writing", provider: "ollama",
      remoteProcessingEnabled: false, aiLaneReady: readiness.ready, aiLaneMessage: readiness.message,
    })?.message).toBe("Preserve this runtime cause.");
  });

  it.each([false, true])("requires remote consent for a rewrite alias: %s", async (remoteProcessingEnabled) => {
    await expect(probeOllamaRewriteModel(
      "remote:latest",
      async () => ["remote:latest"],
      async () => [],
      { remoteProcessingEnabled, getRuntimeHealth: async () => ({
        localGateApplies: false,
        runtimeHealth: { state: "completion_unknown", message: null },
      }) },
    )).resolves.toBe(remoteProcessingEnabled);
    const readiness = await probeOllamaRewriteReadiness(
      "remote:latest",
      async () => ["remote:latest"],
      async () => [],
      { remoteProcessingEnabled, getRuntimeHealth: async () => ({
        localGateApplies: false,
        runtimeHealth: { state: "completion_unknown", message: "Local AI is paused." },
      }) },
    );
    expect(readiness.message).toBe(remoteProcessingEnabled
      ? "The selected Ollama model runs remotely with your permission."
      : "The selected Ollama model runs remotely, but remote processing is disabled.");
  });

  it("keeps rewrite readiness unknown when Ollama metadata is unverified", async () => {
    await expect(probeOllamaRewriteModel(
      DEFAULT_OLLAMA_REWRITE_MODEL,
      async () => [DEFAULT_OLLAMA_REWRITE_MODEL],
      async () => [catalogEntry()],
      { remoteProcessingEnabled: true, getRuntimeHealth: async () => ({
        localGateApplies: null, runtimeHealth: { state: "available", message: null },
      }) },
    )).resolves.toBeNull();
  });
});

describe("ordinary dictation cleanup readiness", () => {
  const blocked = { aiFormattingEnabled: true, needsRewrite: false,
    readinessMatchesCapture: true, aiLaneReady: false as boolean | null,
    aiLaneMessage: "Not enough current memory headroom." };
  it("describes the local fallback for a matching blocked cleanup route", () => {
    expect(resolveDictationCleanupReadiness(blocked)).toEqual({
      title: "AI cleanup is unavailable",
      message: "Basic local formatting will be used. Not enough current memory headroom.",
      tone: "muted", role: "status",
    });
  });
  it.each([
    { aiFormattingEnabled: false }, { needsRewrite: true },
    { readinessMatchesCapture: false }, { aiLaneReady: null }, { aiLaneReady: true },
  ])("does not claim cleanup failure for inactive or unverified readiness: %o", (override) => {
    expect(resolveDictationCleanupReadiness({ ...blocked, ...override })).toBeNull();
  });
});
