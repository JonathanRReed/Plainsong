import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/views/settings-view-simple";

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
  },
  transcription: {
    defaultProvider: "whisper",
    selectedModelId: "base.en",
    allowWhisperFallback: false,
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    language: null,
    numSpeakers: 0,
    saveRawTranscript: false,
    dictationSaveToInbox: true,
    dictationProfile: "speed" as const,
    dictationProjectId: "inbox",
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
  migrateToEncryptedStorage: vi.fn(),
  openPermissionSettings: vi.fn(),
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
    render(<SettingsView />);

    await screen.findByText("Configure Nautilus preferences");
    expect(tauri.getSettings).toHaveBeenCalledTimes(1);
    expect(tauri.getBackupConfig).toHaveBeenCalledTimes(1);
    expect(tauri.listBackups).not.toHaveBeenCalled();
    expect(tauri.getPermissionDiagnostics).not.toHaveBeenCalled();
    expect(tauri.getSecurityStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    await waitFor(() => {
      expect(tauri.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
      expect(tauri.getSecurityStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    await waitFor(() => {
      expect(tauri.listBackups).toHaveBeenCalledTimes(1);
    });
  });

  it("debounces rapid settings changes into a single save", async () => {
    const tauri = await import("@/lib/tauri");
    render(<SettingsView />);

    await screen.findByText("Configure Nautilus preferences");
    vi.useFakeTimers();
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    fireEvent.click(switches[0]);

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
    render(<SettingsView />);

    await screen.findByText("Configure Nautilus preferences");
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    await screen.findByText("Security and Privacy");

    const exportRootInput = screen.getByPlaceholderText("/Users/you/Documents/Nautilus");
    fireEvent.change(exportRootInput, {
      target: { value: "/Users/test/Nautilus" },
    });
    fireEvent.blur(exportRootInput);

    await waitFor(() => {
      expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    });
  });
});
