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
    cloudFolder: "PlainsongBackups",
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
  getDictationShortcutCapabilityStatus: vi.fn(async () => ({
    nativeShortcutAvailable: false,
  })),
  getShortcutConflicts: vi.fn(async () => ({
    conflicts: [],
  })),
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
  downloadWhisperModel: vi.fn(async () => { }),
  isDiarizationModelAvailable: vi.fn(async () => true),
  downloadDiarizationModel: vi.fn(async () => {}),
  listDiarizationModels: vi.fn(async () => [
    { id: "ecapa_tdnn_speaker", label: "ECAPA-TDNN 512", description: "Recommended", installed: true },
  ]),
  isSileroVadModelDownloaded: vi.fn(async () => false),
  downloadSileroVadModel: vi.fn(async () => {}),
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

  it("renders settings before backup config finishes loading", async () => {
    const backend = await import("@/lib/backend");
    let resolveBackupConfig: (
      value: Awaited<ReturnType<typeof backend.getBackupConfig>>,
    ) => void = () => {};
    const slowBackupConfig = new Promise<
      Awaited<ReturnType<typeof backend.getBackupConfig>>
    >((resolve) => {
      resolveBackupConfig = resolve;
    });
    vi.mocked(backend.getBackupConfig).mockReturnValueOnce(slowBackupConfig);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    expect(
      await screen.findByText(
        "Tune transcription, AI, privacy, storage, and app behavior",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Storage"));
    expect(screen.getByText("Loading backup controls...")).toBeInTheDocument();

    resolveBackupConfig({
      enabled: true,
      intervalHours: 24,
      maxBackups: 7,
      backupDir: null,
      cloudSync: false,
      cloudProvider: null,
      cloudRemoteName: null,
      cloudFolder: "PlainsongBackups",
      icloudPath: null,
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

    const exportRootInput = screen.getByPlaceholderText("/Users/you/Documents/Plainsong");
    fireEvent.change(exportRootInput, {
      target: { value: "/Users/test/Plainsong" },
    });
    fireEvent.blur(exportRootInput);

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("offers a real hold-to-talk option once the native shortcut helper is available", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: true,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    await screen.findAllByText("Capture and transcription");

    const hotkeySelect = await screen.findByLabelText("Hotkey behavior");
    expect(hotkeySelect.tagName).toBe("SELECT");
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Hold-to-talk (hold to record, release to stop)",
      ),
    ).toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Hands-free (starts automatically when you speak, no shortcut needed)",
      ),
    ).toBeInTheDocument();

    fireEvent.change(hotkeySelect, { target: { value: "hold_to_talk" } });

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const lastSave = saveCalls[saveCalls.length - 1]?.[0] as
      | { transcription?: { dictationPushToTalk?: boolean } }
      | undefined;
    expect(lastSave?.transcription?.dictationPushToTalk).toBe(true);
  });

  it("keeps the honest toggle-only copy when the native shortcut helper is unavailable, but still offers a selector without hold-to-talk", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: false,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    await screen.findAllByText("Capture and transcription");

    const hotkeySelect = await screen.findByLabelText("Hotkey behavior");
    expect(hotkeySelect.tagName).toBe("SELECT");
    expect(
      within(hotkeySelect as HTMLSelectElement).queryByText(
        "Hold-to-talk (hold to record, release to stop)",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Toggle (press to start, press again to stop)",
      ),
    ).toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Hands-free (starts automatically when you speak, no shortcut needed)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/press to start, press again to stop/).length,
    ).toBeGreaterThan(0);
  });

  it("offers hands-free independent of native shortcut helper availability, and saves it distinctly from hold-to-talk/toggle", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: false,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    await screen.findAllByText("Capture and transcription");

    const hotkeySelect = await screen.findByLabelText("Hotkey behavior");
    fireEvent.change(hotkeySelect, { target: { value: "hands_free" } });

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const lastSave = saveCalls[saveCalls.length - 1]?.[0] as
      | {
          transcription?: {
            dictationPushToTalk?: boolean;
            dictationHandsFreeEnabled?: boolean;
          };
        }
      | undefined;
    expect(lastSave?.transcription?.dictationHandsFreeEnabled).toBe(true);
    expect(lastSave?.transcription?.dictationPushToTalk).toBe(false);
  });

  it("keeps Silero VAD opt-in: offers a download button (not a silent switch) until the model is present, then lets the user select it", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.isSileroVadModelDownloaded).mockResolvedValue(false);

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Transcription"));
    await screen.findAllByText("Capture and transcription");

    await waitFor(() => {
      expect(backend.isSileroVadModelDownloaded).toHaveBeenCalled();
    });

    // Model not downloaded yet: Silero is not selectable, only a download
    // affordance is shown (no silent/automatic download).
    expect(backend.downloadSileroVadModel).not.toHaveBeenCalled();
    const downloadButton = await screen.findByText(/Download Silero/);
    expect(screen.queryByText("Silero (accurate)")).not.toBeInTheDocument();

    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(backend.downloadSileroVadModel).toHaveBeenCalledTimes(1);
    });

    // Once downloaded, the Silero option becomes available and selecting it
    // persists dictationVadBackend: "silero" via the normal save path.
    await screen.findByText("Silero (accurate)");
    fireEvent.click(screen.getByText("Silero (accurate)"));

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const lastSave = saveCalls[saveCalls.length - 1]?.[0] as
      | { transcription?: { dictationVadBackend?: string } }
      | undefined;
    expect(lastSave?.transcription?.dictationVadBackend).toBe("silero");
  });

  it("defaults VAD backend to energy-threshold when unset, requiring no download", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.isSileroVadModelDownloaded).mockResolvedValue(false);

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("Transcription"));
    await screen.findAllByText("Capture and transcription");

    const energyOption = await screen.findByText("Energy-threshold");
    expect(energyOption.className).toContain("border-rust/40");
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

    const restoreButton = screen.getByRole("button", { name: "Restore Latest Profile Snapshot" });
    await waitFor(() => {
      expect(restoreButton).toBeEnabled();
    });
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(backend.restoreBackupDefault).toHaveBeenCalledWith("settings_20260314_120000");
    });
  });

  it("ships only the Plainsong palette — no alternate color-scheme picker", async () => {
    // Plainsong's brand is one vellum/ink palette with a single gold accent and
    // rust rubric; the old multi-theme picker (Rose Pine, Catppuccin, …) was
    // removed deliberately. Light vs dark stays available via the theme toggle.
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    expect(screen.queryByLabelText("Color scheme")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Rose Pine Night" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Catppuccin Mocha" })).not.toBeInTheDocument();
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

  it("switches local Ollama analysis without keeping a stale cloud model id", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        remoteProcessingEnabled: true,
        llmProvider: "openai",
        llmModelId: "gpt-4o",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.listOllamaModels).mockResolvedValueOnce([
      "llama3.2",
      "mistral",
    ]);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("Default analysis provider");

    const providerSection = screen
      .getByText("Default analysis provider")
      .closest("div");
    expect(providerSection).not.toBeNull();
    const providerSelect = within(providerSection as HTMLElement).getByRole(
      "combobox",
    );
    expect(providerSelect).toHaveValue("openai");

    fireEvent.change(providerSelect, { target: { value: "ollama" } });

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          privacy: expect.objectContaining({
            llmProvider: "ollama",
            llmModelId: "llama3.2",
          }),
        }),
      );
    });
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

  it("warns inline when two shortcuts are bound to the same key combination", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
        openWindow: "Ctrl+Shift+Space",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await screen.findByText("Global keyboard shortcuts");

    expect(
      await screen.findByText(/This conflicts with Dictation — only one will work\./),
    ).toBeInTheDocument();
  });

  it("shows no shortcut conflict warning when every binding is distinct", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        toggleRecording: "Ctrl+Shift+R",
        toggleDictation: "Ctrl+Shift+Space",
        toggleDictationAlternates: [],
        openWindow: "Ctrl+Shift+N",
        quickExport: "Ctrl+Shift+E",
        focusSearch: "Ctrl+Shift+F",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("Tune transcription, AI, privacy, storage, and app behavior");
    await screen.findByText("Global keyboard shortcuts");

    expect(screen.queryByText(/This conflicts with/)).not.toBeInTheDocument();
  });
});
