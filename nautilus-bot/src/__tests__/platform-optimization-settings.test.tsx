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
  repairCursorInsertPermissions: vi.fn(async () => ({})),
}));

const providerFixture = [
  {
    providerType: "whisper",
    name: "Whisper",
    description: "Local Whisper provider",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Whisper",
      version: "base.en",
      sizeMb: 142,
      parameters: "74M",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com",
    },
    selectedModelId: "base.en",
    modelOptions: [
      { id: "tiny", label: "tiny (fastest)" },
      { id: "tiny.en", label: "tiny.en (fastest, English)" },
      { id: "base", label: "base (balanced)" },
      { id: "base.en", label: "base.en (balanced, English)" },
      { id: "small", label: "small (better accuracy)" },
      { id: "small.en", label: "small.en (better accuracy, English)" },
      { id: "medium", label: "medium (high accuracy)" },
      { id: "medium.en", label: "medium.en (high accuracy, English)" },
      { id: "large-v3-turbo", label: "large-v3-turbo (fast + accurate)" },
      { id: "large-v3", label: "large-v3 (best accuracy)" },
    ],
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
    providerType: "moonshine",
    name: "UsefulSensors Moonshine",
    description: "Fast local dictation",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Moonshine Base",
      version: "base",
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
    engineDiagnostics: {
      activeEngine: "provider_default",
      availableEngines: ["provider_default", "macos_mlx_sidecar"],
      notes: [],
    },
  },
  {
    providerType: "whisper_candle",
    name: "Whisper Candle",
    description: "Native Candle Whisper runtime",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Whisper Large V3 Turbo",
      version: "whisper-large-v3-turbo",
      sizeMb: 3100,
      parameters: "809M",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://example.com/whisper-candle",
    },
    selectedModelId: "whisper-large-v3-turbo",
    modelOptions: [
      {
        id: "whisper-large-v3-turbo",
        label: "Whisper Large V3 Turbo via Candle (experimental)",
      },
    ],
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
        meetingRoutePolicy: "prefer_local",
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
      accessibilityTrusted: true,
      postEventReady: true,
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
        meetingRoutePolicy: "prefer_local",
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

  it("surfaces recommended solo local model lanes", async () => {
    render(<AsrProviderManager />);

    expect(await screen.findByText("Recommended local model lanes")).toBeInTheDocument();
    expect(screen.getByText("Fast local dictation")).toBeInTheDocument();
    expect(screen.getAllByText("UsefulSensors Moonshine").length).toBeGreaterThan(0);
    expect(screen.getByText("Higher-quality local")).toBeInTheDocument();
    expect(screen.getByText("Apple Silicon acceleration")).toBeInTheDocument();
    expect(screen.getByText("Current solo routes")).toBeInTheDocument();
  });

  it("treats Apple Native as dictation-only when persisting transcription route settings", async () => {
    render(<AsrProviderManager />);

    const sharedProviderSelect = (await screen.findByText("Shared provider"))
      .parentElement?.querySelector("select");
    expect(sharedProviderSelect).toBeTruthy();

    fireEvent.change(sharedProviderSelect as HTMLSelectElement, {
      target: { value: "macos_apple_speech" },
    });

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const savedPayload =
      saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
    expect(savedPayload.transcription.defaultProvider).toBe("macos_apple_speech");
    expect(savedPayload.transcription.dictationProvider).toBe("macos_apple_speech");
    expect(savedPayload.transcription.useSharedAsrSelection).toBe(false);
    expect(savedPayload.transcription.meetingProvider).toBe("distil_whisper");
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
        meetingRoutePolicy: "prefer_local",
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
      accessibilityTrusted: false,
      postEventReady: true,
      automationReady: false,
      cursorInsertionReady: true,
      preferredInsertStrategy: "simulated_typing",
      lastCursorInsertStatus: {
        succeeded: false,
        copiedOnly: true,
        failureKind: "post_event_access",
        successfulStrategy: null,
        attemptedStrategies: [],
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
      screen.getAllByText("Copied to clipboard. macOS blocked keystroke paste.").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Direct text unverified")).toBeInTheDocument();
  });

  it("prefers live permission diagnostics over stale Apple Native provider status", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_asr_providers") {
        return providerFixture.map((provider) =>
          provider.providerType === "macos_apple_speech"
            ? {
                ...provider,
                runtimeStatus: "error",
                runtimeMessage: "Apple native speech permission has not been granted yet.",
                runtimeDetails: {
                  setupAction:
                    "Grant Speech Recognition permission in macOS System Settings, or choose another ASR provider.",
                },
              }
            : provider
        );
      }
      if (cmd === "get_default_asr_provider") return "macos_apple_speech";
      if (cmd === "list_asr_benchmarks") return [];
      return null;
    });
    getSettingsMock.mockResolvedValue({
      transcription: {
        defaultProvider: "macos_apple_speech",
        selectedModelId: "macos_apple_speech",
        useSharedAsrSelection: true,
        dictationProvider: "macos_apple_speech",
        dictationModelId: "macos_apple_speech",
        meetingProvider: "macos_apple_speech",
        meetingModelId: "macos_apple_speech",
        meetingRoutePolicy: "prefer_local",
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
      accessibilityTrusted: false,
      postEventReady: true,
      automationReady: false,
      cursorInsertionReady: true,
      preferredInsertStrategy: "simulated_typing",
      notes: [],
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Native setup")).toBeInTheDocument();
    expect(
      screen.queryByText(/Shared route: Apple native speech permission has not been granted yet\./)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Meetings use meeting-grade ASR only. Apple Native Speech, Windows Native Speech, Moonshine, Whisper Candle, and standard Whisper are dictation-only, so meetings will use a separate stronger model instead."
      )
    ).toBeInTheDocument();
  });

  it("keeps Whisper out of the meeting provider choices", async () => {
    getSettingsMock.mockResolvedValue({
      transcription: {
        defaultProvider: "whisper",
        selectedModelId: "base.en",
        useSharedAsrSelection: false,
        dictationProvider: "whisper",
        dictationModelId: "base.en",
        meetingProvider: "whisper",
        meetingModelId: "small.en",
        meetingRoutePolicy: "prefer_local",
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: false, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: [],
        },
      },
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Meeting provider")).toBeInTheDocument();
    const meetingProviderSelect = screen
      .getByText("Meeting provider")
      .parentElement?.querySelector("select");
    expect(meetingProviderSelect).toBeTruthy();
    const optionValues = Array.from(
      (meetingProviderSelect as HTMLSelectElement).querySelectorAll("option")
    ).map((option) => option.getAttribute("value") ?? "");
    expect(optionValues).not.toContain("whisper");
    expect(optionValues).toContain("distil_whisper");
  });

  it("keeps Whisper Candle out of shared meeting-compatible routes", async () => {
    getSettingsMock.mockResolvedValue({
      transcription: {
        defaultProvider: "whisper_candle",
        selectedModelId: "whisper-large-v3-turbo",
        useSharedAsrSelection: true,
        dictationProvider: "whisper_candle",
        dictationModelId: "whisper-large-v3-turbo",
        meetingProvider: "whisper_candle",
        meetingModelId: "whisper-large-v3-turbo",
        meetingRoutePolicy: "prefer_local",
        platformOptimization: {
          mode: "auto",
          fallbackPolicy: "local_only",
          macos: { appleNativeEnabled: false, mlxEnabled: true },
          windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
          manualEnginePriority: [],
        },
      },
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Meeting provider")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Meetings use meeting-grade ASR only. Apple Native Speech, Windows Native Speech, Moonshine, Whisper Candle, and standard Whisper are dictation-only, so meetings will use a separate stronger model instead."
      )
    ).toBeInTheDocument();

    const sharedProviderSelect = screen
      .getByText("Dictation provider")
      .parentElement?.querySelector("select");
    expect(sharedProviderSelect).toBeTruthy();
    expect((sharedProviderSelect as HTMLSelectElement).value).toBe("whisper_candle");

    const meetingProviderSelect = screen
      .getByText("Meeting provider")
      .parentElement?.querySelector("select");
    expect(meetingProviderSelect).toBeTruthy();
    const optionValues = Array.from(
      (meetingProviderSelect as HTMLSelectElement).querySelectorAll("option")
    ).map((option) => option.getAttribute("value") ?? "");
    expect(optionValues).not.toContain("whisper_candle");
    expect(optionValues).toContain("distil_whisper");
  });

  it("persists meeting route policy changes", async () => {
    render(<AsrProviderManager />);

    const meetingPolicySelect = await screen.findByDisplayValue("Prefer local");
    fireEvent.change(meetingPolicySelect, { target: { value: "best_available" } });

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const savedPayload =
      saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
    expect(savedPayload.transcription.meetingRoutePolicy).toBe("best_available");
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
      accessibilityTrusted: true,
      postEventReady: true,
      automationReady: false,
      cursorInsertionReady: true,
      notes: [],
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Native setup")).toBeInTheDocument();
    expect(
      screen.queryByText("Cursor insertion is not ready yet. Enable Nautilus in Privacy & Security > Accessibility so it can insert text into the target app.")
    ).not.toBeInTheDocument();
  });
});
