import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AsrProviderManager } from "@/components/asr-provider-manager";

const invokeMock = vi.fn();
const getSettingsMock = vi.fn();
const saveSettingsMock = vi.fn();
const getPermissionDiagnosticsMock = vi.fn();

vi.mock("@/lib/electron", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/backend", () => ({
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
  repairLocalModelCache: vi.fn(async () => ({ repairedCount: 0, removedPaths: [], notes: [] })),
  getAsrProviderInventory: vi.fn(async () => invokeMock("get_asr_provider_inventory")),
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
  getPermissionDiagnostics: (...args: unknown[]) => getPermissionDiagnosticsMock(...args),
  openPermissionSettings: vi.fn(async () => {}),
  openInstalledPlainsongApp: vi.fn(async () => {}),
  requestAppleSpeechPermission: vi.fn(async () => ({})),
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
    name: "Apple Speech (On-Device)",
    description: "Dictation-only Apple Speech with server fallback disabled.",
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
    modelOptions: [
      { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
    platformReadiness: {
      status: "ready",
      ready: true,
      platformSupported: true,
      helperPresent: true,
      authorization: "authorized",
      locale: "en_US",
      localeSupported: true,
      onDeviceAvailable: true,
      recognizerAvailable: true,
      message: "Apple Speech is ready for on-device dictation in locale 'en_US'.",
      setupAction: null,
    },
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
      if (cmd === "get_asr_providers" || cmd === "get_asr_provider_inventory") return providerFixture;
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
    const user = userEvent.setup();
    render(<AsrProviderManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Show tools" }));
    const fallbackTrigger = await screen.findByRole("combobox", { name: /fallback policy/i });
    await user.click(fallbackTrigger);
    const failFastOption = await screen.findByRole("option", { name: /fail fast/i });
    await user.click(failFastOption);

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const savedPayload =
      saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
    expect(savedPayload.transcription.platformOptimization.fallbackPolicy).toBe("fail_fast");
  });

  it("persists ordered manual engine priority", async () => {
    const user = userEvent.setup();
    render(<AsrProviderManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Show tools" }));
    const modeTrigger = await screen.findByRole("combobox", { name: /^mode$/i });
    await user.click(modeTrigger);
    const manualOption = await screen.findByRole("option", { name: /manual/i });
    await user.click(manualOption);

    const addButton = await screen.findByRole("button", { name: "Add engine" });
    await user.click(addButton);

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalled();
    });

    const engineTrigger = await screen.findByRole("combobox", { name: /engine priority 1/i });
    await user.click(engineTrigger);
    const foundryOption = await screen.findByRole("option", { name: /windows foundry/i });
    await user.click(foundryOption);

    await waitFor(() => {
      const savedPayload =
        saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
      expect(savedPayload.transcription.platformOptimization.manualEnginePriority).toEqual([
        "windows_foundry_local",
      ]);
    });

    await user.click(addButton);

    await waitFor(() => {
      const savedPayload =
        saveSettingsMock.mock.calls[saveSettingsMock.mock.calls.length - 1]?.[0];
      expect(savedPayload.transcription.platformOptimization.manualEnginePriority).toEqual([
        "windows_foundry_local",
        "provider_default",
      ]);
    });
  });

  it("keeps Apple Native setup here and out of advanced native toggles", async () => {
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
    getPermissionDiagnosticsMock.mockResolvedValue({
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      accessibilityTrusted: true,
      postEventReady: true,
      automationReady: false,
      notes: [],
    });

    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Speech setup")).toBeInTheDocument();

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
      if (cmd === "get_asr_providers" || cmd === "get_asr_provider_inventory") {
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

    expect(await screen.findByText("Apple Speech setup")).toBeInTheDocument();
    expect(
      screen.queryByText(/Shared route: Apple native speech permission has not been granted yet\./)
    ).not.toBeInTheDocument();
    expect(screen.getByText("Ready for transcription")).toBeInTheDocument();
  });

  /**
   * macOS named this permission when speech recognition meant sending audio to
   * Apple. Plainsong runs both Apple engines with server recognition off, so
   * telling the reader only that it is "required for transcription" left the
   * older meaning standing (STYLE.md §6: copy describes what the app actually
   * does; no unearned implications either way).
   */
  it("says what granting Speech Recognition actually permits", async () => {
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

    render(<AsrProviderManager />);

    const detail = await screen.findByText(/records your consent to on-device processing/i);
    expect(detail).toBeInTheDocument();
    expect(detail.textContent).toMatch(/not permission to use a server/i);
    // It is a sentence, not a label, so it sits on the text-sm body floor
    // (STYLE.md section 2 and section 7).
    expect(detail.className).toContain("text-sm");
    expect(detail.className).not.toContain("text-xs");
    // The claim it replaced said nothing about where the audio goes.
    expect(
      screen.queryByText("Required for Apple Speech transcription."),
    ).not.toBeInTheDocument();
  });

  it("persists meeting route policy changes", async () => {
    render(<AsrProviderManager />);

    const meetingPolicyTrigger = await screen.findByRole("combobox", { name: /meeting quality policy/i });
    await userEvent.click(meetingPolicyTrigger);
    const bestOption = await screen.findByRole("option", { name: /best available/i });
    await userEvent.click(bestOption);

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

    expect(await screen.findByText("Apple Speech setup")).toBeInTheDocument();
    expect(
      screen.queryByText("Cursor insertion is not ready yet. Enable Plainsong in Privacy & Security > Accessibility so it can insert text into the target app.")
    ).not.toBeInTheDocument();
  });
});
