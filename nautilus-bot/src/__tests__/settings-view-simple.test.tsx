import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/views/settings-view-simple";
import { ToastProvider } from "@/components/toast";
import { OPEN_ONBOARDING_EVENT } from "@/lib/onboarding";
import { OPEN_MAIN_VIEW_EVENT } from "@/lib/navigation";

const baseSettings = {
  audio: {
    sampleRate: 16000,
    channels: 1,
    captureSystemAudio: true,
    captureMicrophone: true,
    noiseSuppression: true,
    voiceActivityDetection: true,
    silenceTimeoutSeconds: 3,
    autoGainControl: true,
    manualGainDb: 0,
  },
  transcription: {
    defaultProvider: "whisper",
    selectedModelId: "base.en",
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    language: null,
    numSpeakers: 0,
    saveRawTranscript: false,
    dictationSaveToInbox: true,
    dictationProfile: "normal_speed" as const,
    dictationProjectId: "inbox",
    speakerNamingMethod: "auto" as const,
    silenceSkipEnabled: false,
    memorySearchMode: "fts" as const,
    embeddingModel: "nomic-embed-text",
  },
  ui: {
    alwaysOnTop: false,
    showInDock: true,
    minimizeToTray: true,
    startMinimized: false,
    windowPosition: null,
    windowSize: null,
    fontSize: 14,
    showDictationPopup: true,
    showRecordingPopup: true,
    colorScheme: "default",
  },
  export: {
    defaultFormat: "markdown",
    autoExport: false,
    exportDirectory: null,
    includeTimestamps: true,
    includeSpeakers: true,
    openAfterExport: false,
  },
  privacy: {
    encryptRecordings: false,
    autoDeleteDays: 0,
    requirePassword: false,
    auditLogging: true,
    cloudSync: false,
    remoteProcessingEnabled: false,
    llmProvider: "ollama",
    llmModelId: null,
    exportRoot: null,
    vaultInitialized: false,
    vaultSalt: null,
  },
  shortcuts: {
    toggleRecording: "Ctrl+Shift+R",
    toggleDictation: "Ctrl+Shift+Space",
    toggleDictationAlternates: [],
    openWindow: "Ctrl+Shift+N",
    quickExport: "Ctrl+Shift+E",
    focusSearch: "Ctrl+Shift+F",
  },
  defaultTemplate: "meeting",
  theme: "system" as const,
};

vi.mock("@/components/asr-provider-manager", () => ({
  AsrProviderManager: () => <div>ASR</div>,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    theme: "system",
    setTheme: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", () => ({
  createBackupDefault: vi.fn(),
  clearProviderSecret: vi.fn(),
  getBackupConfig: vi.fn(async () => ({
    enabled: true,
    intervalHours: 24,
    maxBackups: 7,
    backupDir: null,
    cloudSync: false,
    cloudProvider: null,
    cloudRemoteName: null,
    cloudFolder: "NautilusBackups",
    icloudPath: null,
  })),
  getPermissionDiagnostics: vi.fn(async () => ({
    microphoneReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
  })),
  repairCursorInsertPermissions: vi.fn(async () => ({
    microphoneReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
  })),
  getBackupSetupReport: vi.fn(),
  getOllamaStatus: vi.fn(async () => true),
  getSecurityStatus: vi.fn(async () => ({
    vaultInitialized: false,
    vaultUnlocked: false,
    databaseEncrypted: false,
    recordingsEncrypted: false,
    llmProvider: "ollama",
    remoteProcessingEnabled: false,
    exportRoot: null,
  })),
  getSettings: vi.fn(async () => ({ ...baseSettings })),
  hasProviderSecret: vi.fn(async () => false),
  lockVault: vi.fn(),
  listBackups: vi.fn(async () => []),
  listOllamaModels: vi.fn(async () => ["llama3.2"]),
  listOllamaCloudModels: vi.fn(async () => []),
  listOpenAiModels: vi.fn(async () => []),
  listAnthropicModels: vi.fn(async () => []),
  listGeminiModels: vi.fn(async () => []),
  listDeepSeekModels: vi.fn(async () => []),
  listDownloadedModels: vi.fn(async () => []),
  downloadWhisperModel: vi.fn(async () => { }),
  isDiarizationModelAvailable: vi.fn(async () => true),
  downloadDiarizationModel: vi.fn(async () => {}),
  listDiarizationModels: vi.fn(async () => [
    { id: "ecapa_tdnn_speaker", label: "ECAPA-TDNN 512", description: "Recommended", installed: true },
  ]),
  migrateToEncryptedStorage: vi.fn(),
  openPermissionSettings: vi.fn(),
  requestDictationPermissions: vi.fn(async () => ({
    microphoneReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
  })),
  saveSettings: vi.fn(async () => { }),
  saveBackupConfig: vi.fn(),
  setProviderSecret: vi.fn(async () => { }),
  syncBackupToCloud: vi.fn(),
  unlockVault: vi.fn(),
  verifyBackupCloudConnection: vi.fn(),
  validateLicense: vi.fn(async () => ({
    key: "",
    instanceId: "",
    tier: "none",
    valid: false,
    lsStatus: "",
    activationsLimit: 5,
    activationsUsage: 0,
    lastValidatedAt: "",
    trialDaysRemaining: 30,
    nagRequired: false,
    trialActive: true,
  })),
  deactivateLicense: vi.fn(async () => { }),
}));

describe("SettingsView performance behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazy-loads heavy security/storage data by tab", async () => {
    const tauri = await import("@/lib/tauri");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    expect(tauri.getSettings).toHaveBeenCalledTimes(1);
    expect(tauri.getBackupConfig).toHaveBeenCalledTimes(1);
    expect(tauri.listBackups).not.toHaveBeenCalled();
    expect(tauri.getPermissionDiagnostics).not.toHaveBeenCalled();
    expect(tauri.getSecurityStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Privacy & Security"));
    await waitFor(() => {
      expect(tauri.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
      expect(tauri.getSecurityStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText("Storage"));
    await waitFor(() => {
      expect(tauri.listBackups).toHaveBeenCalledTimes(1);
    });
  });

  it("debounces rapid settings changes into a single save", async () => {
    const tauri = await import("@/lib/tauri");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    vi.useFakeTimers();
    // Get a switch that actually triggers updateSettings, not the power-user toggle.
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);
    fireEvent.click(switches[1]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("flushes text-field saves immediately on blur", async () => {
    const tauri = await import("@/lib/tauri");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Retention, backups, export paths, and cleanup tools");

    const exportRootInput = screen.getByPlaceholderText("/Users/you/Documents/Nautilus");
    fireEvent.change(exportRootInput, {
      target: { value: "/Users/test/Nautilus" },
    });
    fireEvent.blur(exportRootInput);

    await waitFor(() => {
      expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("shows only basic color schemes for trial users", async () => {
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.validateLicense).mockResolvedValue({
      key: "",
      instanceId: "",
      tier: "none",
      valid: false,
      lsStatus: "",
      activationsLimit: 5,
      activationsUsage: 0,
      lastValidatedAt: "",
      trialDaysRemaining: 30,
      nagRequired: false,
      trialActive: true,
    });

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    const select = screen.getByLabelText("Color scheme");
    expect(select).toHaveValue("default");
    expect(screen.queryByText("Rose Pine Night (Pro)")).not.toBeInTheDocument();
  });

  it("persists selected color scheme for paid users", async () => {
    const tauri = await import("@/lib/tauri");
    vi.mocked(tauri.validateLicense).mockResolvedValue({
      key: "pro-license",
      instanceId: "instance",
      tier: "pro",
      valid: true,
      lsStatus: "active",
      activationsLimit: 5,
      activationsUsage: 1,
      lastValidatedAt: "",
      trialDaysRemaining: 0,
      nagRequired: false,
      trialActive: false,
    });

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    vi.useFakeTimers();

    const select = screen.getByLabelText("Color scheme");
    fireEvent.change(select, { target: { value: "rose-pine" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(tauri.saveSettings).toHaveBeenCalled();
    const calls = vi.mocked(tauri.saveSettings).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.colorScheme).toBe("rose-pine");
  });

  it("reopens the modular onboarding flows from guided setup", async () => {
    const events: Array<string | undefined> = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<{ mode?: string }>).detail?.mode);
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, handler as EventListener);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Guided setup");

    fireEvent.click(screen.getByRole("button", { name: /rerun onboarding/i }));
    fireEvent.click(screen.getByRole("button", { name: /fix dictation setup/i }));
    fireEvent.click(screen.getByRole("button", { name: /set up meetings/i }));

    expect(events).toEqual(["full", "dictation", "meetings"]);

    window.removeEventListener(OPEN_ONBOARDING_EVENT, handler as EventListener);
  });

  it("opens the memory workspace from AI settings", async () => {
    const events: Array<string | undefined> = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<{ view?: string }>).detail?.view);
    };
    window.addEventListener(OPEN_MAIN_VIEW_EVENT, handler as EventListener);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("Cross-meeting memory chat");

    fireEvent.click(screen.getByRole("button", { name: /open memory workspace/i }));

    expect(events).toEqual(["dashboard"]);

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, handler as EventListener);
  });
});
