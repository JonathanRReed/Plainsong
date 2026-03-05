import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AsrProviderManager } from "@/components/asr-provider-manager";

const invokeMock = vi.fn();
const getSettingsMock = vi.fn();
const saveSettingsMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/tauri", () => ({
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
  repairLocalModelCache: vi.fn(async () => ({ repairedCount: 0, removedPaths: [], notes: [] })),
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
}));

const providerFixture = [
  {
    providerType: "distil_whisper",
    name: "Distil-Whisper",
    description: "Local provider",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Distil Whisper",
      version: "v3.5",
      sizeMb: 1530,
      parameters: "756M",
      languages: ["en"],
      license: "Apache-2.0",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "Distil Whisper Large v3.5" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
    engineDiagnostics: {
      activeEngine: "provider_default",
      availableEngines: ["provider_default"],
      notes: [],
    },
  },
];

describe("Platform optimization settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_asr_providers") return providerFixture;
      if (cmd === "get_default_asr_provider") return "distil_whisper";
      if (cmd === "list_asr_benchmarks") return [];
      return null;
    });
    getSettingsMock.mockResolvedValue({
      transcription: {
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: false, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: [],
        },
      },
    });
    saveSettingsMock.mockResolvedValue(undefined);
  });

  it("persists fallback policy changes", async () => {
    render(<AsrProviderManager />);

    const fallbackSelect = await screen.findByLabelText("Fallback policy");
    fireEvent.change(fallbackSelect, { target: { value: "fail_fast" } });

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const savedPayload =
      saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
    expect(savedPayload.transcription.platformOptimization.fallbackPolicy).toBe("fail_fast");
  });

  it("persists ordered manual engine priority", async () => {
    render(<AsrProviderManager />);

    const modeSelect = await screen.findByLabelText("Mode");
    fireEvent.change(modeSelect, { target: { value: "manual" } });

    const addButton = await screen.findByRole("button", { name: "Add engine" });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const firstPrioritySelect = screen.getByDisplayValue("Provider default");
    fireEvent.change(firstPrioritySelect, { target: { value: "windows_foundry_local" } });

    await waitFor(() => {
      const savedPayload =
        saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
      expect(savedPayload.transcription.platformOptimization.manualEnginePriority).toEqual([
        "windows_foundry_local",
      ]);
    });

    fireEvent.click(addButton);

    await waitFor(() => {
      const savedPayload =
        saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
      expect(savedPayload.transcription.platformOptimization.manualEnginePriority).toEqual([
        "windows_foundry_local",
        "provider_default",
      ]);
    });
  });
});
