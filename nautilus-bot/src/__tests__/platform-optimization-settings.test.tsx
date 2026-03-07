import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AsrProviderManager } from "@/components/asr-provider-manager";

const invokeMock = vi.fn();
const getSettingsMock = vi.fn();
const saveSettingsMock = vi.fn();
const getPermissionDiagnosticsMock = vi.fn();

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
  getPermissionDiagnostics: (...args: unknown[]) => getPermissionDiagnosticsMock(...args),
  openPermissionSettings: vi.fn(async () => {}),
  requestDictationPermissions: vi.fn(async () => ({})),
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
  {
    providerType: "macos_apple_speech",
    name: "Apple Native Speech",
    description: "Use macOS native speech recognition.",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Apple Native",
      version: "system",
      sizeMb: 0,
      parameters: "managed by macOS",
      languages: ["en"],
      license: "Apple",
      sourceUrl: "https://developer.apple.com/documentation/speech",
    },
    selectedModelId: "macos_apple_speech",
    modelOptions: [{ id: "macos_apple_speech", label: "Built into macOS" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
    engineDiagnostics: {
      activeEngine: "provider_default",
      availableEngines: ["provider_default", "macos_apple_speech"],
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
        defaultProvider: "distil_whisper",
        selectedModelId: "distil-large-v3.5",
        useSharedAsrSelection: true,
        dictationProvider: "distil_whisper",
        dictationModelId: "distil-large-v3.5",
        meetingProvider: "distil_whisper",
        meetingModelId: "distil-large-v3.5",
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
    getPermissionDiagnosticsMock.mockResolvedValue({
      microphoneReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      automationReady: false,
      notes: [],
    });
  });

  it("persists fallback policy changes", async () => {
    render(<AsrProviderManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Show tools" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Show tools" }));
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

  it("keeps Apple Native in the main route flow and out of advanced native toggles", async () => {
    const appleSettings = {
      transcription: {
        defaultProvider: "macos_apple_speech",
        selectedModelId: "macos_apple_speech",
        useSharedAsrSelection: true,
        dictationProvider: "macos_apple_speech",
        dictationModelId: "macos_apple_speech",
        meetingProvider: "macos_apple_speech",
        meetingModelId: "macos_apple_speech",
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: true, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: ["macos_apple_speech"],
        },
      },
    };
    getSettingsMock.mockResolvedValue(appleSettings);

    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Native setup")).toBeInTheDocument();
    expect(screen.getByText("Built into macOS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show tools" }));

    expect(screen.queryByText("macOS Apple Speech engine")).not.toBeInTheDocument();
    expect(screen.queryByText("Windows SDK dictation engine")).not.toBeInTheDocument();
  });

  it("surfaces the latest clipboard-only insert fallback reason", async () => {
    getSettingsMock.mockResolvedValue({
      transcription: {
        defaultProvider: "macos_apple_speech",
        selectedModelId: "macos_apple_speech",
        useSharedAsrSelection: true,
        dictationProvider: "macos_apple_speech",
        dictationModelId: "macos_apple_speech",
        meetingProvider: "macos_apple_speech",
        meetingModelId: "macos_apple_speech",
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: true, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: [],
        },
      },
    });
    getPermissionDiagnosticsMock.mockResolvedValue({
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: false,
      automationReady: true,
      lastCursorInsertStatus: {
        succeeded: false,
        copiedOnly: true,
        failureKind: "post_event_access",
        message: "Copied to clipboard. macOS blocked keystroke paste.",
        observedAtMs: Date.now(),
      },
      notes: [],
    });

    render(<AsrProviderManager />);

    expect(
      await screen.findByText("Latest dictation fell back to clipboard-only.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Copied to clipboard. macOS blocked keystroke paste.")
    ).toBeInTheDocument();
  });

  it("treats Accessibility as the insertion gate even when Automation is unavailable", async () => {
    getSettingsMock.mockResolvedValue({
      transcription: {
        defaultProvider: "macos_apple_speech",
        selectedModelId: "macos_apple_speech",
        useSharedAsrSelection: true,
        dictationProvider: "macos_apple_speech",
        dictationModelId: "macos_apple_speech",
        meetingProvider: "macos_apple_speech",
        meetingModelId: "macos_apple_speech",
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: true, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: [],
        },
      },
    });
    getPermissionDiagnosticsMock.mockResolvedValue({
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      automationReady: false,
      notes: [],
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Native setup")).toBeInTheDocument();
    expect(
      screen.queryByText("Cursor insertion still depends on Accessibility. Automation is only used as a fallback if direct event posting is blocked.")
    ).not.toBeInTheDocument();
  });
});
