import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_MODEL_ID,
  probeOllamaModelReadiness,
} from "@/lib/ollama-model-readiness";

const catalogEntry = (overrides: Record<string, unknown> = {}) => ({
  id: DEFAULT_OLLAMA_MODEL_ID,
  displayName: "Qwen 3.5 4B",
  provider: "Alibaba via Ollama",
  diskSizeBytes: 1,
  contextTokens: 1,
  minimumMemoryBytes: null,
  recommendedMemoryBytes: null,
  license: "Apache-2.0",
  disclosure: null,
  lanes: ["dictation", "meetings"],
  expectedManifestDigest: null,
  installed: true,
  installedDigest: null,
  installedSizeBytes: 1,
  ready: true,
  ...overrides,
});

describe("Ollama model readiness", () => {
  const installed = {
    getRuntimeStatus: async () => true,
    listInstalledModels: async () => [DEFAULT_OLLAMA_MODEL_ID],
    listCatalog: async () => [catalogEntry()],
  };
  it.each(["completion_unknown", "storage_error"] as const)("retains a verified local %s pause", async (state) => {
    const result = await probeOllamaModelReadiness(null, { ...installed,
      getRuntimeHealth: async () => ({ localGateApplies: true, runtimeHealth: { state, message: "Local processing is paused." } }),
    });
    expect(result).toMatchObject({ modelReady: true, executionReady: false, executionMessage: "Local processing is paused." });
  });
  it("keeps local busy and unknown model locality unresolved", async () => {
    expect(await probeOllamaModelReadiness(null, { ...installed,
      getRuntimeHealth: async () => ({ localGateApplies: true, runtimeHealth: { state: "busy", message: "Another local text operation is running." } }),
    })).toMatchObject({ executionReady: null, executionMessage: "Another local text operation is running." });
    expect(await probeOllamaModelReadiness(null, { ...installed,
      getRuntimeHealth: async () => ({ localGateApplies: null, runtimeHealth: { state: "available", message: null } }),
    })).toMatchObject({ executionReady: null });
  });
  it("permits verified local execution only when its gate is available", async () => {
    expect(await probeOllamaModelReadiness(null, { ...installed,
      getRuntimeHealth: async () => ({ localGateApplies: true, runtimeHealth: { state: "available", message: null } }),
    })).toMatchObject({ executionReady: true, executionMessage: null });
  });
  it("keeps remote models independent of the local pause and requires consent", async () => {
    const remote = { ...installed, getRuntimeHealth: async () => ({ localGateApplies: false, runtimeHealth: { state: "completion_unknown" as const, message: "Local processing is paused." } }) };
    expect(await probeOllamaModelReadiness(null, remote)).toMatchObject({ executionReady: false, executionMessage: expect.stringContaining("remote processing is disabled") });
    expect(await probeOllamaModelReadiness(null, { ...remote, remoteProcessingEnabled: true })).toMatchObject({ executionReady: true, executionMessage: "The selected Ollama model runs remotely with your permission." });
  });
  it("distinguishes runtime loss, missing models, and unknown probes", async () => {
    await expect(
      probeOllamaModelReadiness(null, {
        getRuntimeStatus: async () => false,
        listInstalledModels: async () => [],
        listCatalog: async () => [],
      }),
    ).resolves.toEqual({
      modelId: DEFAULT_OLLAMA_MODEL_ID,
      runtimeReady: false,
      modelReady: null,
      executionReady: null,
      executionMessage: null,
    });
    await expect(
      probeOllamaModelReadiness(null, {
        getRuntimeStatus: async () => true,
        listInstalledModels: async () => [],
        listCatalog: async () => [],
      }),
    ).resolves.toMatchObject({ runtimeReady: true, modelReady: false });
    await expect(
      probeOllamaModelReadiness(null, {
        getRuntimeStatus: async () => true,
        listInstalledModels: async () => {
          throw new Error("probe failed");
        },
        listCatalog: async () => [],
      }),
    ).resolves.toMatchObject({ runtimeReady: true, modelReady: null });
  });

  it("accepts custom installed tags and enforces curated readiness", async () => {
    await expect(
      probeOllamaModelReadiness("gemma4:e4b", {
        getRuntimeStatus: async () => true,
        listInstalledModels: async () => ["gemma4:e4b"],
        listCatalog: async () => [],
      }),
    ).resolves.toMatchObject({ modelReady: true });
    await expect(
      probeOllamaModelReadiness(DEFAULT_OLLAMA_MODEL_ID, {
        getRuntimeStatus: async () => true,
        listInstalledModels: async () => [DEFAULT_OLLAMA_MODEL_ID],
        listCatalog: async () => [catalogEntry({ ready: false })],
      }),
    ).resolves.toMatchObject({ modelReady: false });
  });
});
