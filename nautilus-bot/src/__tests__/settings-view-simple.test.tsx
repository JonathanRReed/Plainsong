import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/views/settings-view-simple";
import { ToastProvider } from "@/components/toast";
import { OPEN_ONBOARDING_EVENT } from "@/lib/onboarding";
import { OPEN_MAIN_VIEW_EVENT } from "@/lib/navigation";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";

const readinessContext = vi.hoisted(() => ({
  productReadiness: {
    evidenceObservedAt: 1,
    dictation: {
      domain: "dictation",
      state: "ready",
      cause: null,
    },
    meetings: {
      domain: "meetings",
      state: "ready",
      cause: null,
    },
    fullCapture: {
      domain: "full_capture",
      state: "ready",
      cause: null,
    },
    overall: {
      domain: "overall",
      state: "ready",
      cause: null,
    },
  } as ProductReadinessSnapshot,
}));

const baseSettings = {
  audio: {
    preferredInputDevice: null,
    dictationInputOverrideEnabled: false,
    dictationInputDevice: null,
    meetingInputOverrideEnabled: false,
    meetingInputDevice: null,
  },
  transcription: {
    defaultProvider: "whisper",
    selectedModelId: "base.en",
    enableDiarization: true,
    language: null,
    dictationSaveToInbox: true,
    dictationProfile: "normal_speed" as const,
    dictationProjectId: "inbox",
    // Auto-stop-on-silence is a consumer of the VAD backend, so the "VAD
    // accuracy" picker (exercised below) renders with this fixture.
    dictationSilenceTimeoutSeconds: 5,
    silenceSkipEnabled: false,
    memorySearchMode: "fts" as const,
    embeddingModel: "nomic-embed-text",
    enableAutoAnalysis: true,
  },
  ui: {
    alwaysOnTop: false,
    minimizeToTray: true,
    showDictationPopup: true,
    showRecordingPopup: true,
    colorScheme: "default",
  },
  export: {},
  privacy: {
    remoteProcessingEnabled: false,
    dictationAi: { provider: "ollama", modelId: null },
    meetingsAi: { provider: "ollama", modelId: null },
    exportRoot: null,
    vaultInitialized: false,
    vaultSalt: null,
  },
  shortcuts: {
    toggleDictation: "Ctrl+Shift+Space",
    toggleDictationAlternates: [],
    openWindow: "Ctrl+Shift+N",
  },
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

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

// Captures the "settings-changed" listener the view registers, so tests can
// simulate another writer's broadcast (see the settings-changed race test
// below) without a real sidecar.
const electronEventListeners = new Map<
  string,
  (event: { payload: unknown }) => void
>();

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      electronEventListeners.set(eventName, handler);
      return () => {
        electronEventListeners.delete(eventName);
      };
    },
  ),
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
    enabled: false,
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
  getSystemAudioCapability: vi.fn(async () => ({
    backend: "core_audio_process_tap",
    nativeOsSupported: true,
    nativeOsEnabled: true,
    routeDevice: "MacBook Pro Speakers",
    routeId: "coreaudio:BuiltInSpeakerDevice",
    nativeSampleRate: 48000,
    nativeChannels: 2,
    readiness: "unverified",
    ready: false,
    reason: null,
    actionableReason: "Run Test system audio.",
  })),
  repairCursorInsertPermissions: vi.fn(async () => ({
    microphoneReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
  })),
  getBackupSetupReport: vi.fn(),
  getAsrProviders: vi.fn(async () => []),
  getAsrProviderInventory: vi.fn(async () => []),
  listDownloadedModels: vi.fn(async () => []),
  downloadAsrModels: vi.fn(async () => {}),
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
    recordingsEncryptedCount: 0,
    recordingsStoredCount: 0,
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
  isSileroVadModelDownloaded: vi.fn(async () => false),
  downloadSileroVadModel: vi.fn(async () => {}),
  migrateToEncryptedStorage: vi.fn(),
  openPermissionSettings: vi.fn(),
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
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
  testSystemAudioCapture: vi.fn(async () => ({
    capability: {
      backend: "core_audio_process_tap",
      nativeOsSupported: true,
      nativeOsEnabled: true,
      routeDevice: "MacBook Pro Speakers",
      routeId: "coreaudio:BuiltInSpeakerDevice",
      nativeSampleRate: 48000,
      nativeChannels: 2,
      readiness: "ready",
      ready: true,
      reason: null,
      actionableReason: null,
    },
    callbacks: 100,
    capturedFrames: 48000,
    nonSilentFrames: 45000,
    peak: 0.04,
    expectedToneHz: 997,
    detectedToneAmplitude: 0.04,
    verificationMethod: "known_tone",
  })),
  unlockVault: vi.fn(),
  verifyBackupCloudConnection: vi.fn(),
}));

describe("SettingsView performance behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronEventListeners.clear();
    readinessContext.productReadiness.dictation = {
      domain: "dictation",
      state: "ready",
      cause: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazy-loads heavy security/storage data by tab", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
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

  it("shows a plain retry path when the initial settings load fails", async () => {
    const backend = await import("@/lib/backend");
    const getSettings = vi.mocked(backend.getSettings);
    getSettings
      .mockReset()
      .mockRejectedValueOnce(
        new Error("get_settings JSON-RPC failed at /Users/test/settings.json"),
      )
      .mockResolvedValue({ ...baseSettings } as unknown as Awaited<
        ReturnType<typeof backend.getSettings>
      >);

    render(<ToastProvider><SettingsView /></ToastProvider>);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Settings could not load");
    expect(alert).toHaveTextContent(/could not open your settings right now/i);
    expect(alert).not.toHaveTextContent(/get_settings|JSON-RPC|\/Users\/test/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(
      await screen.findByText("How Plainsong listens, writes, and what it keeps."),
    ).toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it("gives visible settings controls accessible names", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    for (const name of [
      "Keep running after close",
      "Always on top",
      "While dictating",
      "While recording a meeting",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }
    for (const name of [
      "Dictation shortcut",
      "Paste last result shortcut",
      "Copy last result shortcut",
      "Open window shortcut",
    ]) {
      expect(screen.getByRole("textbox", { name })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText("Transcription"));
    await screen.findByText("Microphones");
    for (const name of [
      "Use a different microphone for dictation",
      "Use a different microphone for meetings",
      "Separate speakers",
      "Smart Format",
      "Spoken commands",
      "Snippets",
      "Learn from your corrections",
      "Name meetings for me",
      "Also copy dictated text to the clipboard",
      "Skip silence",
    ]) {
      expect(await screen.findByRole("switch", { name })).toBeInTheDocument();
    }
    for (const name of [
      "App-wide microphone",
      "Dictation microphone override",
      "Meeting microphone override",
      "Transcription language",
      "How the dictation shortcut works",
    ]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText("Privacy & Security"));
    expect(
      await screen.findByRole("switch", {
        name: "Use cloud AI for summaries and answers",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: "Ask macOS for permission when needed",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Storage"));
    for (const name of [
      "Auto-delete dictation recordings",
      "Meeting audio",
      "Auto-delete meeting data",
      "When a meeting is auto-deleted, remove",
    ]) {
      expect(await screen.findByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(
      await screen.findByRole("switch", {
        name: "Allow uploading to cloud storage",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Cloud storage service" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("AI & Keys"));
    expect(
      await screen.findByRole("switch", {
        name: "Summarize every meeting automatically",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "API key service" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Method" })).toBeInTheDocument();
  });

  it("invalidates ASR runtime probes before refreshing permission diagnostics", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Privacy & Security"));
    await screen.findByText("macOS permissions");
    vi.clearAllMocks();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(backend.refreshAsrRuntimeProbes).toHaveBeenCalledTimes(1);
      expect(backend.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
      expect(backend.getAsrProviders).toHaveBeenCalledTimes(1);
    });
    expect(
      vi.mocked(backend.refreshAsrRuntimeProbes).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(backend.getAsrProviders).mock.invocationCallOrder[0]);
  });

  it("does not probe local Ollama for a key or query Ollama Cloud without one", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    expect(backend.hasProviderSecret).not.toHaveBeenCalledWith("ollama");

    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("API keys");
    await waitFor(() => {
      expect(backend.hasProviderSecret).toHaveBeenCalledWith("ollama-cloud");
    });
    expect(backend.listOllamaCloudModels).not.toHaveBeenCalled();
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
        "How Plainsong listens, writes, and what it keeps.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Storage"));
    expect(screen.getByText("Loading backup controls…")).toBeInTheDocument();

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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await waitFor(() => {
      expect(backend.getPermissionDiagnostics).toHaveBeenCalled();
    });

    expect(screen.getAllByText(/^Dictation$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Ready$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Mic$/)).not.toBeInTheDocument();
  });

  it("uses canonical text-insertion readiness even when the local probes look ready", async () => {
    readinessContext.productReadiness.dictation = {
      domain: "dictation",
      state: "needs_action",
      cause: {
        id: "cursor_insertion",
        message: "Text insertion needs Accessibility access for the current mode.",
        action: {
          id: "repair_cursor_insertion",
          label: "Repair text insertion",
          destination: "setup",
        },
      },
    };

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    const chip = screen.getByText("Text insertion").parentElement;
    expect(chip).toHaveTextContent("Text insertion·Needs setup");
  });

  it("renders the Transcription tab without the removed audio-tuning placebo controls", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    // AudioSettings.autoGainControl / manualGainDb (and the other audio-tuning
    // fields) were removed from the backend schema; the paired controls must
    // be gone too, not reading `undefined` off settings.audio.
    expect(screen.queryByText("Auto gain control")).not.toBeInTheDocument();
    expect(screen.queryByText(/Manual gain/)).not.toBeInTheDocument();
    expect(screen.queryByText("Noise suppression")).not.toBeInTheDocument();
    expect(screen.queryByText("Voice activity detection")).not.toBeInTheDocument();
  });

  it("marks system audio ready only after the explicit tone test returns verified callbacks", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    expect(
      await screen.findByText(
        /has not yet confirmed macOS permission and real sound coming through/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open privacy settings" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run the test" }));

    await waitFor(() => {
      expect(backend.testSystemAudioCapture).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/Heard the 997 Hz test tone through/i),
    ).toBeInTheDocument();
    // "Verified through macOS itself" is how the Core Audio process tap
    // backend is now named in the UI.
    expect(
      screen.getByText(/Verified through macOS itself/i),
    ).toBeInTheDocument();
  });

  it("reports how many recordings are encrypted rather than claiming all of them are", async () => {
    const backend = await import("@/lib/backend");
    // A vault was migrated at some point, but capture writes plain WAVs, so
    // the two recordings made since are not encrypted.
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      privacy: { ...baseSettings.privacy, vaultInitialized: true },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.getSecurityStatus).mockResolvedValue({
      vaultInitialized: true,
      vaultUnlocked: true,
      databaseEncrypted: true,
      recordingsEncrypted: false,
      recordingsEncryptedCount: 4,
      recordingsStoredCount: 6,
      llmProvider: "ollama",
      remoteProcessingEnabled: false,
      exportRoot: null,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Privacy & Security"));

    expect(await screen.findByText("4 of 6 encrypted")).toBeInTheDocument();
    expect(
      screen.getByText(/still plaintext/i)
    ).toBeInTheDocument();
    // The bare claim the bytes on disk contradict.
    expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
    expect(screen.getByText("Apple Speech")).toBeInTheDocument();
    expect(
      screen.getByText(/turns off its fall back to Apple's servers/i),
    ).toBeInTheDocument();
  });

  it("keeps the encrypted-recordings counts across an unrelated settings save", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      privacy: { ...baseSettings.privacy, vaultInitialized: true },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.getSecurityStatus).mockResolvedValue({
      vaultInitialized: true,
      vaultUnlocked: true,
      databaseEncrypted: true,
      recordingsEncrypted: true,
      recordingsEncryptedCount: 6,
      recordingsStoredCount: 6,
      llmProvider: "ollama",
      remoteProcessingEnabled: false,
      exportRoot: null,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Privacy & Security"));
    await screen.findByText("6 of 6 encrypted");

    // Toggling an unrelated setting on the same page triggers the debounced
    // whole-object save; the encrypted-status readout must not flip to
    // "not encrypted" just because privacy.encryptRecordings no longer exists
    // on the saved Settings object.
    const remoteProcessingRow = screen
      .getByText("Use cloud AI for summaries and answers")
      .closest(".flex.items-center.justify-between");
    const remoteProcessingSwitch = within(
      remoteProcessingRow as HTMLElement,
    ).getByRole("switch");
    fireEvent.click(remoteProcessingSwitch);

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });

    expect(screen.getByText("6 of 6 encrypted")).toBeInTheDocument();
  });

  it("debounces rapid settings changes into a single save", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Only allow exports into this folder");

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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
    expect(hotkeySelect.tagName).toBe("SELECT");
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Hold to record, release to stop",
      ),
    ).toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Start on its own when you speak",
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
    expect(hotkeySelect.tagName).toBe("SELECT");
    expect(
      within(hotkeySelect as HTMLSelectElement).queryByText(
        "Hold to record, release to stop",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Press to start, press again to stop",
      ),
    ).toBeInTheDocument();
    expect(
      within(hotkeySelect as HTMLSelectElement).getByText(
        "Start on its own when you speak",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Press to start, press again to stop/).length,
    ).toBeGreaterThan(0);
  });

  it("offers hands-free independent of native shortcut helper availability, and saves it distinctly from hold-to-talk/toggle", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: false,
    });

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await waitFor(() => {
      expect(backend.getDictationShortcutCapabilityStatus).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    await waitFor(() => {
      expect(backend.isSileroVadModelDownloaded).toHaveBeenCalled();
    });

    // Model not downloaded yet: Silero is not selectable, only a download
    // affordance is shown (no silent/automatic download).
    expect(backend.downloadSileroVadModel).not.toHaveBeenCalled();
    const downloadButton = await screen.findByText(/Download Silero/);
    expect(screen.queryByText("Silero")).not.toBeInTheDocument();

    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(backend.downloadSileroVadModel).toHaveBeenCalledTimes(1);
    });

    // Once downloaded, the Silero option becomes available and selecting it
    // persists dictationVadBackend: "silero" via the normal save path.
    await screen.findByText("Silero");
    fireEvent.click(screen.getByText("Silero"));

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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    // The per-tab header that used to describe this tab was removed as a
    // restatement of the tab tile above it; the tab's first section heading
    // is now the marker that the Transcription tab has rendered.
    await screen.findByText("Microphones");

    const energyOption = await screen.findByText("Loudness");
    expect(energyOption.className).toContain("border-rust/40");
  });

  it("presents settings-only snapshots and can restore the latest one", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));
    // The "Settings snapshots" sub-heading was folded into the one "Backups"
    // group; wait on that group, then assert the settings-only snapshot is
    // still presented separately from the full backup.
    await screen.findByText("Backups");

    expect(screen.getByText("Latest settings snapshot")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Settings and shortcuts only — no recordings or transcripts/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/dictionary entries|snippets/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snapshot settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload latest snapshot" })).toBeInTheDocument();

    const restoreButton = screen.getByRole("button", { name: "Restore latest snapshot" });
    await waitFor(() => {
      expect(restoreButton).toBeEnabled();
    });
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(backend.restoreBackupDefault).toHaveBeenCalledWith("settings_20260314_120000");
    });
  });

  it("states that backups and cloud uploads are manual without promising scheduling", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Backups");

    expect(
      screen.getByText(
        /a copy is made only when you press one of the buttons below/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/schedule|scheduled/i)).not.toBeInTheDocument();
    expect(screen.getByText("Allow uploading to cloud storage")).toBeInTheDocument();
    expect(
      screen.getByText(/Uploads still only happen when you press one/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Automatic backups")).not.toBeInTheDocument();
    expect(screen.queryByText("Backup interval (hours)")).not.toBeInTheDocument();
    expect(screen.getByText("Backups to keep on this Mac")).toBeInTheDocument();
    expect(screen.queryByText(/dictation flows/i)).not.toBeInTheDocument();
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
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

  it("merges another writer's settings-changed broadcast without clobbering an unsaved local edit", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.useFakeTimers();

    // Start an edit whose debounced save has not landed yet, so the ui
    // section is still "dirty" (draft != last-known-persisted).
    const alwaysOnTopRow = screen.getByText("Always on top").closest(".flex.items-center.justify-between");
    fireEvent.click(within(alwaysOnTopRow as HTMLElement).getByRole("switch"));

    // Simulate a different writer (e.g. the Key Manager) saving elsewhere
    // and the sidecar broadcasting the resulting whole-settings snapshot.
    // Its ui section still reflects the old on-disk value (alwaysOnTop:
    // false) because that writer never touched ui.
    const settingsChangedHandler = electronEventListeners.get("settings-changed");
    expect(settingsChangedHandler).toBeDefined();
    await act(async () => {
      settingsChangedHandler?.({
        payload: {
          ...baseSettings,
          privacy: {
            ...baseSettings.privacy,
            meetingsAi: { provider: "anthropic", modelId: null },
          },
        },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The pending local edit must win for the section it touched...
    expect(backend.saveSettings).toHaveBeenCalled();
    const calls = vi.mocked(backend.saveSettings).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.alwaysOnTop).toBe(true);
    // ...while the untouched section still picks up the broadcast instead
    // of being reverted by this view's own stale whole-object save.
    expect(lastCall?.[0]?.privacy?.meetingsAi?.provider).toBe("anthropic");
  });

  it("keeps the Key Manager's credential-provider selector independent of the default analysis provider", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("AI & Keys"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The lane pickers themselves moved to the Models tab; what this tab still
    // states is where an automatic summary goes, which is the same setting.
    const analysisDisclosure = screen
      .getByText("Summarize every meeting automatically")
      .closest(".flex.items-start.justify-between") as HTMLElement;
    const credentialProviderSelect = screen
      .getByText("API keys")
      .closest("div")
      ?.querySelector("select") as HTMLSelectElement;
    expect(analysisDisclosure.textContent).toContain("Ollama on this machine");

    const saveCallsBeforeChange = vi.mocked(backend.saveSettings).mock.calls.length;
    fireEvent.change(credentialProviderSelect, {
      target: { value: "anthropic" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(credentialProviderSelect.value).toBe("anthropic");
    // Picking a different provider to manage credentials for must not
    // silently steer the app's actual analysis provider away from ollama --
    // this selector no longer writes settings.privacy.meetingsAi, so it must
    // not trigger a settings save at all.
    expect(analysisDisclosure.textContent).toContain("Ollama on this machine");
    expect(vi.mocked(backend.saveSettings).mock.calls.length).toBe(
      saveCallsBeforeChange,
    );
    for (const [savedSettings] of vi.mocked(backend.saveSettings).mock.calls) {
      expect(savedSettings.privacy.meetingsAi.provider).toBe("ollama");
    }
  });

  it("discloses automatic meeting analysis and lets it be turned off", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        remoteProcessingEnabled: true,
        meetingsAi: { provider: "anthropic", modelId: null },
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));

    // On by default, so it has to name the destination rather than sit
    // undisclosed in the settings schema.
    const row = (
      await screen.findByText("Summarize every meeting automatically")
    ).closest(".flex.items-start.justify-between");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Anthropic");
    expect(row?.textContent).toContain("without asking");

    fireEvent.click(within(row as HTMLElement).getByRole("switch"));

    // Opening the AI tab saves on its own — each lane pins an explicit model
    // as soon as its provider's list arrives — so neither "saveSettings was
    // called" nor "the newest call" identifies the toggle's write. Wait for
    // the write that actually carries it.
    await waitFor(() => {
      const toggledSave = vi
        .mocked(backend.saveSettings)
        .mock.calls.find(
          ([next]) => next?.transcription?.enableAutoAnalysis === false,
        );
      expect(toggledSave).toBeDefined();
    });

    // ...and nothing lands after it that quietly turns analysis back on.
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const lastCall = saveCalls[saveCalls.length - 1];
    expect(lastCall?.[0]?.transcription?.enableAutoAnalysis).toBe(false);

    // The switch itself has to agree. The model-coercion pass writes a whole
    // Settings object once a provider's model list arrives, and React flushes
    // it after this click but before the re-render — built from its own
    // closure it would put the switch back on and re-enable the very thing
    // the user just turned off.
    expect(within(row as HTMLElement).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("clears the stale 'no stored key' warning as soon as a key is saved for the default analysis provider", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        remoteProcessingEnabled: true,
        meetingsAi: { provider: "anthropic", modelId: null },
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.hasProviderSecret).mockResolvedValue(false);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));

    // Key Manager auto-seeds its provider to the current default analysis
    // provider (anthropic here), so the warning should already be visible
    // without any manual provider selection.
    await screen.findByText(/No key saved for/);
    const credentialProviderSelect = screen
      .getByText("API keys")
      .closest("div")
      ?.querySelector("select") as HTMLSelectElement;
    expect(credentialProviderSelect.value).toBe("anthropic");

    fireEvent.change(screen.getByPlaceholderText("Paste the key here"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => {
      expect(backend.setProviderSecret).toHaveBeenCalledWith(
        "anthropic",
        "sk-test-123",
      );
    });

    // The stale-warning bug left this visible until the user changed the
    // default analysis provider away and back; it must clear immediately.
    await waitFor(() => {
      expect(screen.queryByText(/No key saved for/)).not.toBeInTheDocument();
    });
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Setup");

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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("Searching your transcripts");

    // "Open Relationship Memory" was removed as a duplicate: its handler was
    // byte-identical to Open Memory's (both requestMainView("dashboard")), so
    // it was a second label for one destination, not a second destination.
    fireEvent.click(screen.getByRole("button", { name: /open memory/i }));
    fireEvent.click(screen.getByRole("button", { name: /open meetings/i }));

    expect(events).toEqual(["dashboard", "recordings"]);

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, handler as EventListener);
  });

  it("switches local Ollama analysis without keeping a stale cloud model id", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        remoteProcessingEnabled: true,
        meetingsAi: { provider: "openai", modelId: "gpt-4o" },
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Models"));
    await screen.findByText("Who writes summaries, answers, and actions");

    const providerSection = screen
      .getByText("Who writes summaries, answers, and actions")
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
            meetingsAi: { provider: "ollama", modelId: "llama3.2" },
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    await screen.findByText("Languages you dictate in");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Dictate in French/i,
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

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Keyboard shortcuts");

    expect(
      await screen.findByText(
        /Same keys as Dictation — only one of them will work\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows no shortcut conflict warning when every binding is distinct", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        toggleDictation: "Ctrl+Shift+Space",
        toggleDictationAlternates: [],
        openWindow: "Ctrl+Shift+N",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Keyboard shortcuts");

    expect(screen.queryByText(/Same keys as/)).not.toBeInTheDocument();
  });
});
