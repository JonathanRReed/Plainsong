import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    preferredInputDevice: null,
    dictationInputOverrideEnabled: false,
    dictationInputDevice: null,
    meetingInputOverrideEnabled: false,
    meetingInputDevice: null,
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
    minimizeToTray: true,
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

vi.mock("@/lib/backend", () => ({
  createBackupDefault: vi.fn(),
  createSettingsBackupDefault: vi.fn(),
  clearProviderSecret: vi.fn(),
  listAudioInputDevices: vi.fn(async () => ({
    devices: [
      {
        deviceId: "input-0-built-in microphone",
        deviceName: "Built-in Microphone",
        transportType: "builtin",
        isDefault: true,
        isAvailable: true,
        isBluetoothLike: false,
        channelCount: 1,
        sampleRate: 16000,
      },
    ],
    appWideSelectedDeviceId: null,
    dictationOverrideEnabled: false,
    dictationSelectedDeviceId: null,
    meetingOverrideEnabled: false,
    meetingSelectedDeviceId: null,
  })),
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
  listBackups: vi.fn(async () => [
    {
      id: "settings_20260314_120000",
      timestamp: "2026-03-14T12:00:00.000Z",
      sizeBytes: 1024,
      itemsCount: 6,
      backupType: "settings",
    },
    {
      id: "backup_20260314_110000",
      timestamp: "2026-03-14T11:00:00.000Z",
      sizeBytes: 2048,
      itemsCount: 20,
      backupType: "full",
    },
  ]),
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
  restoreBackupDefault: vi.fn(async () => {}),
  syncBackupToCloud: vi.fn(),
  unlockVault: vi.fn(),
  verifyBackupCloudConnection: vi.fn(),
  validateLicense: vi.fn(async () => ({
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
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    expect(backend.getSettings).toHaveBeenCalledTimes(1);
    expect(backend.getBackupConfig).toHaveBeenCalledTimes(1);
    expect(backend.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
    expect(backend.listBackups).not.toHaveBeenCalled();
    expect(backend.getSecurityStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Privacy & Security"));
    await waitFor(() => {
      expect(backend.getSecurityStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText("Storage"));
    await waitFor(() => {
      expect(backend.listBackups).toHaveBeenCalledTimes(1);
    });
  });

  it("shows dictation readiness instead of blaming the mic for local routes", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      transcription: {
        ...baseSettings.transcription,
        defaultProvider: "moonshine",
        selectedModelId: "moonshine-tiny",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.getPermissionDiagnostics).mockResolvedValue({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      cursorInsertionReady: true,
      automationReady: true,
      notes: [],
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await waitFor(() => {
      expect(backend.getPermissionDiagnostics).toHaveBeenCalled();
    });

    expect(screen.getAllByText(/^Dictation$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Ready$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Mic$/)).not.toBeInTheDocument();
  });

  it("debounces rapid settings changes into a single save", async () => {
    const backend = await import("@/lib/backend");
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
    expect(backend.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("flushes text-field saves immediately on blur", async () => {
    const backend = await import("@/lib/backend");
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
      expect(backend.saveSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("shows personal profile sync actions and can restore the latest profile snapshot", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Personal Profile Sync");

    expect(screen.getByText("Latest profile snapshot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Profile Snapshot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync Latest Profile Snapshot" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore Latest Profile Snapshot" }));

    await waitFor(() => {
      expect(backend.restoreBackupDefault).toHaveBeenCalledWith("settings_20260314_120000");
    });
  });

  it("shows only basic color schemes for trial users", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.validateLicense).mockResolvedValue({
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
    const backend = await import("@/lib/backend");
    vi.mocked(backend.validateLicense).mockResolvedValue({
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

    expect(backend.saveSettings).toHaveBeenCalled();
    const calls = vi.mocked(backend.saveSettings).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.colorScheme).toBe("rose-pine");
  });

  it("persists the always-on-top toggle from desktop settings", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    vi.useFakeTimers();

    const alwaysOnTopRow = screen.getByText("Always on top").closest(".flex.items-center.justify-between");
    expect(alwaysOnTopRow).not.toBeNull();
    fireEvent.click(within(alwaysOnTopRow as HTMLElement).getByRole("switch"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(backend.saveSettings).toHaveBeenCalled();
    const calls = vi.mocked(backend.saveSettings).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.alwaysOnTop).toBe(true);
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

  it("opens memory and meetings views from AI settings", async () => {
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
    await screen.findByText("Memory Search");

    fireEvent.click(screen.getByRole("button", { name: /open memory/i }));
    fireEvent.click(screen.getByRole("button", { name: /open relationship memory/i }));
    fireEvent.click(screen.getByRole("button", { name: /open meetings/i }));

    expect(events).toEqual(["dashboard", "dashboard", "recordings"]);

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, handler as EventListener);
  });

  it("persists the dictation active language set from transcription settings", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Transcription"));
    await screen.findByText("Dictation active language set");

    fireEvent.click(
      screen.getByRole("button", {
        name: /toggle French in dictation active languages/i,
      })
    );

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings?.transcription.dictationActiveLanguages).toEqual(["fr"]);
  });
});
