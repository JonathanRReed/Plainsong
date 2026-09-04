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
  getCliToolStatus: vi.fn(async () => ({
    binaryPath: "/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli",
    binaryPresent: true,
    linkPath: "/usr/local/bin/plainsong",
    installed: false,
    stale: false,
    occupied: false,
    manualCommand:
      "sudo ln -sfn '/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli' /usr/local/bin/plainsong",
  })),
  installCliTool: vi.fn(async () => ({
    status: "manual",
    reason: "Plainsong cannot write to /usr/local/bin without administrator rights.",
    command:
      "sudo ln -sfn '/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli' /usr/local/bin/plainsong",
  })),
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
  listDiarizationModels: vi.fn(async () => [
    {
      id: "ecapa_tdnn_speaker",
      label: "ECAPA-TDNN 512",
      description: "Fast and accurate, recommended for most use cases (~25 MB)",
      installed: true,
    },
    {
      id: "eres2netv2_speaker",
      label: "ERes2NetV2 (int8)",
      description: "Modern int8-quantized embedder, 192-dim, compact (~28 MB)",
      installed: false,
    },
  ]),
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
  selectExportLocation: vi.fn(async () => ({
    id: "approved-export-location",
    label: "Plainsong exports",
    approved: true,
  })),
  selectBackupLocation: vi.fn(async () => ({
    id: "approved-backup-location",
    label: "Beta backups",
    approved: true,
  })),
  selectCloudBackupLocation: vi.fn(async () => ({
    id: "approved-cloud-location",
    label: "gdrive:PlainsongBackups",
    approved: true,
  })),
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

  it("saves Keep running after close through settings alone", async () => {
    // The toggle used to fire `app:set_minimize_to_tray` alongside the save.
    // Its handler was deleted, so the call could only ever reject into an
    // empty catch; the setting already travels on `settings-changed`.
    const electron = await import("@/lib/electron");
    const backend = await import("@/lib/backend");
    const invoke = vi.mocked(electron.invoke);
    const saveSettings = vi.mocked(backend.saveSettings);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");

    fireEvent.click(
      screen.getByRole("switch", { name: "Keep running after close" }),
    );

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalled();
    });
    const saved = saveSettings.mock.calls[
      saveSettings.mock.calls.length - 1
    ][0] as { ui: { minimizeToTray: boolean } };
    expect(saved.ui.minimizeToTray).toBe(false);
    for (const [command] of invoke.mock.calls) {
      expect(command).not.toBe("app:set_minimize_to_tray");
    }
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
      // Two correction-learning switches, named for where each one looks.
      // The old single "Learn from your corrections" claimed both and only
      // ever did the first.
      "Learn from corrections you make in Plainsong",
      "Learn from corrections you make in other apps",
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
    expect(
      screen.getByRole("combobox", { name: "How search finds a meeting" }),
    ).toBeInTheDocument();
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

  it("does not contact remote model providers while remote processing is disabled", async () => {
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(backend.listOllamaCloudModels).not.toHaveBeenCalled();
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
    expect(backend.listAnthropicModels).not.toHaveBeenCalled();
    expect(backend.listGeminiModels).not.toHaveBeenCalled();
    expect(backend.listDeepSeekModels).not.toHaveBeenCalled();
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

  it("requires the native folder picker instead of accepting a raw export path", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Approved export folder");

    expect(
      screen.queryByPlaceholderText("/Users/you/Documents/Plainsong"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose export folder" }));

    await waitFor(() => {
      expect(backend.selectExportLocation).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          privacy: expect.objectContaining({
            exportRoot: null,
            exportLocationId: "approved-export-location",
            exportLocationLabel: "Plainsong exports",
            exportLocationApproved: true,
          }),
        }),
      );
    });
    expect(await screen.findByText("Plainsong exports")).toBeInTheDocument();
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

  it("renders command line and MCP access in General, off, with the sentence that says what it allows", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    expect(screen.getByText("Command line and MCP access")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Apps you run on this Mac, such as a terminal or an AI assistant, can read your meeting notes and transcripts\. Nothing leaves the machine unless that app sends it\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow the plainsong command and MCP server" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // The install action is a real button, not a link, and the status line
    // names the next action.
    expect(screen.getByRole("button", { name: "Install command-line tool" })).toBeInTheDocument();
    await screen.findByText(/Not installed\. Installing adds \/usr\/local\/bin\/plainsong/);
  });

  it("persists the command line and MCP switch as automation.localToolsEnabled", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("switch", { name: "Allow the plainsong command and MCP server" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(backend.saveSettings).toHaveBeenCalled();
    const calls = vi.mocked(backend.saveSettings).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.automation?.localToolsEnabled).toBe(true);
    // Nothing else in the payload moved.
    expect(lastCall?.[0]?.ui?.minimizeToTray).toBe(true);
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

    fireEvent.click(screen.getByRole("button", { name: /show setup again/i }));
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

  // ── Dictation binding table (roadmap item B4) ──────────────────────────
  // Electron registers the dictation bindings before Open window, so a
  // per-profile binding on Open window's keys took them and left only a
  // console error. The row now says so, naming the binding that won.
  it("warns that a non-primary dictation binding takes another shortcut's keys", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
        openWindow: "Ctrl+Alt+E",
        dictationBindings: [
          {
            id: "primary",
            trigger: { kind: "key", accelerator: "Ctrl+Shift+Space" },
            action: { kind: "dictation", modeId: null, behavior: "inherit" },
          },
          {
            id: "email",
            trigger: { kind: "key", accelerator: "Ctrl+Alt+E" },
            action: { kind: "dictation", modeId: "email", behavior: "inherit" },
          },
        ],
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
        /Same keys as Dictation \u00b7 Writing \u2014 only one of them will work\./,
      ),
    ).toBeInTheDocument();
  });

  it("lists every dictation binding with its action and flags a duplicate trigger", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: true,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
        dictationBindings: [
          {
            id: "primary",
            trigger: { kind: "key", accelerator: "Ctrl+Shift+Space" },
            action: { kind: "dictation", modeId: null, behavior: "inherit" },
          },
          {
            id: "email",
            trigger: { kind: "key", accelerator: "Ctrl+Alt+E" },
            action: { kind: "dictation", modeId: "email", behavior: "hold" },
          },
          {
            id: "clash",
            trigger: { kind: "key", accelerator: "Shift+Ctrl+Space" },
            action: { kind: "cycleMode" },
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");

    const primaryAction = (await screen.findByLabelText(
      "Dictation action",
    )) as HTMLSelectElement;
    expect(primaryAction.value).toBe("dictation");
    const secondAction = (await screen.findByLabelText(
      "Binding 2 action",
    )) as HTMLSelectElement;
    expect(secondAction.value).toBe("dictation:email");
    expect(
      (screen.getByLabelText("Binding 2 behavior") as HTMLSelectElement).value,
    ).toBe("hold");
    const thirdAction = (await screen.findByLabelText(
      "Binding 3 action",
    )) as HTMLSelectElement;
    expect(thirdAction.value).toBe("cycleMode");

    // The third binding is Ctrl+Shift+Space written in a different order, so
    // it collides with the primary one and says so in the row.
    expect(
      await screen.findByText(
        /Same trigger as Dictation — this one is removed when settings save\./,
      ),
    ).toBeInTheDocument();
  });

  it("says a mouse binding needs the native helper while the helper is down", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: false,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        dictationBindings: [
          {
            id: "mouse",
            trigger: { kind: "mouse", button: 4 },
            action: { kind: "dictation", modeId: null, behavior: "hold" },
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");

    expect(
      await screen.findByText(
        /Mouse buttons need the native shortcut helper, which is not running\./,
      ),
    ).toBeInTheDocument();
  });

  // A row with an empty accelerator is dropped by the sidecar's
  // `reconcile_keyboard_shortcuts`, so writing one produced a row that
  // showed in the draft settings, never reached the file, and disappeared on
  // the next reload with no explanation. "Add binding" now holds the row in
  // local state until the recorder captures a trigger.
  it("keeps a new binding unsaved until the recorder captures a trigger, then saves it", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: true,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");
    vi.mocked(backend.saveSettings).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Add binding" }));

    // The row is on screen and listening, and nothing was written.
    const recorder = await screen.findByLabelText("Binding 2 trigger");
    expect(recorder).toHaveValue("Listening...");
    await screen.findByText("No keys recorded yet.");
    expect(backend.saveSettings).not.toHaveBeenCalled();

    fireEvent.keyDown(recorder, {
      key: "E",
      code: "KeyE",
      ctrlKey: true,
      altKey: true,
    });

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const saved = saveCalls[saveCalls.length - 1]?.[0] as unknown as {
      shortcuts: {
        toggleDictation: string;
        dictationBindings: Array<{ trigger: { accelerator?: string } }>;
      };
    };
    expect(saved.shortcuts.dictationBindings).toHaveLength(2);
    expect(saved.shortcuts.dictationBindings[0].trigger.accelerator).toBe(
      "Ctrl+Shift+Space",
    );
    expect(saved.shortcuts.dictationBindings[1].trigger.accelerator).toBe(
      "Ctrl+Alt+E",
    );
    expect(saved.shortcuts.toggleDictation).toBe("Ctrl+Shift+Space");
    // No save anywhere in this flow may carry a triggerless row.
    for (const [payload] of saveCalls) {
      const bindings =
        (payload as unknown as {
          shortcuts?: { dictationBindings?: Array<{ trigger: { accelerator?: string } }> };
        }).shortcuts?.dictationBindings ?? [];
      for (const binding of bindings) {
        expect(binding.trigger.accelerator?.trim()).not.toBe("");
      }
    }
  });

  it("drops an abandoned new binding without saving anything", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: true,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");
    vi.mocked(backend.saveSettings).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Add binding" }));
    await screen.findByLabelText("Binding 2 trigger");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove binding 2 binding" }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText("Binding 2 trigger")).not.toBeInTheDocument();
    });
    expect(backend.saveSettings).not.toHaveBeenCalled();
  });

  // Hiding the "hold" option left a saved hold row rendering a <select> with
  // no matching option, which browsers show as the first one -- so the row
  // read "Follows the setting above" while the stored behavior was hold.
  it("keeps a saved hold binding readable on a machine with no native helper", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: false,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
        dictationBindings: [
          {
            id: "primary",
            trigger: { kind: "key", accelerator: "Ctrl+Shift+Space" },
            action: { kind: "dictation", modeId: null, behavior: "hold" },
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");

    const behavior = (await screen.findByLabelText(
      "Dictation behavior",
    )) as HTMLSelectElement;
    // The stored value is still what the row shows, and the option it names
    // exists -- disabled, saying why.
    expect(behavior.value).toBe("hold");
    const holdOption = within(behavior).getByRole("option", {
      name: "Hold to record (needs the native helper)",
    }) as HTMLOptionElement;
    expect(holdOption.disabled).toBe(true);
    expect(
      screen.getByText(
        /Hold needs the native shortcut helper, which is not running, so this binding presses to start and presses again to stop until it is\./,
      ),
    ).toBeInTheDocument();
  });

  // `mousedown` fires before `focus`, so requiring the recorder to already be
  // listening threw away the first click on an unfocused row: the user had to
  // click once to focus and again to bind.
  it("binds an extra mouse button on the first click, without focusing first", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({
      nativeShortcutAvailable: true,
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      shortcuts: {
        ...baseSettings.shortcuts,
        toggleDictation: "Ctrl+Shift+Space",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByText("Dictation bindings");
    vi.mocked(backend.saveSettings).mockClear();

    const recorder = await screen.findByLabelText("Dictation shortcut");
    // No focus event first: this is the very first interaction with the row.
    fireEvent.mouseDown(recorder, { button: 3 });

    await waitFor(() => {
      expect(backend.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(backend.saveSettings).mock.calls;
    const saved = saveCalls[saveCalls.length - 1]?.[0] as unknown as {
      shortcuts: { dictationBindings: Array<{ trigger: Record<string, unknown> }> };
    };
    expect(saved.shortcuts.dictationBindings[0].trigger).toEqual({
      kind: "mouse",
      button: 4,
      modifiers: [],
    });
  });

  // ── Saved prompts ─────────────────────────────────────────────────────
  /**
   * The dialog takes `onPersist`'s answer as the truth about the write. This
   * view used to hand back `true` before any I/O, so a read-only settings
   * file looked exactly like a successful save.
   */
  it("shows a failed saved-prompt write inside the dialog instead of claiming it saved", async () => {
    const backend = await import("@/lib/backend");
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");

    vi.mocked(backend.saveSettings).mockRejectedValueOnce(
      new Error("Settings file is read-only"),
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide Decisions made" }),
    );

    expect(
      await within(dialog).findByText("Settings file is read-only"),
    ).toBeTruthy();
  });

  it("reports a saved-prompt write that landed", async () => {
    const backend = await import("@/lib/backend");
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide Decisions made" }),
    );

    await waitFor(() => {
      const written = vi
        .mocked(backend.saveSettings)
        .mock.calls.find(([next]) =>
          (next?.ai?.savedPrompts ?? []).some((prompt) => prompt.hidden === true),
        );
      expect(written).toBeDefined();
    });
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("serializes rapid saved-prompt writes through the settings scheduler", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("AI & Keys"));
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");
    const saveSettings = vi.mocked(backend.saveSettings);
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());

    let finishFirstSave: (() => void) | undefined;
    saveSettings.mockClear();
    saveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstSave = resolve;
        }),
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide Decisions made" }),
    );
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide Open questions" }),
    );
    await act(async () => Promise.resolve());
    expect(saveSettings).toHaveBeenCalledTimes(1);

    finishFirstSave?.();
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    const finalWrite = saveSettings.mock.calls[1]?.[0];
    expect(
      finalWrite?.ai?.savedPrompts?.filter((prompt) => prompt.hidden),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Decisions made" }),
        expect.objectContaining({ name: "Open questions" }),
      ]),
    );
  });

  // ── Translate to English (roadmap item B7a) ────────────────────────────
  it("refuses translate-to-English on an English-only whisper model and says why", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Transcription"));
    await screen.findByText("Microphones");

    // baseSettings selects whisper `base.en`, which has no translate task.
    const toggle = await screen.findByRole("switch", {
      name: "Translate to English",
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(
        /This model is English-only and cannot translate\./,
      ),
    ).toBeInTheDocument();
  });
});

/**
 * The lane U2 contract, asserted rather than promised.
 *
 * The complaint was "not being shown what something does". A label names a
 * control; only the sentence under it says what happens to you. Wiring that
 * sentence with `aria-describedby` makes it audible to a screen reader *and*
 * checkable from here -- a control whose helper text someone deletes fails
 * this test instead of shipping.
 *
 * Scope: switches and selects, which are the controls that change a stored
 * setting. Read-only shortcut recorders and the API-key field are named by
 * their own section's prose and are exempt. `AsrProviderManager` is mocked in
 * this file, so the engine-status section is covered by
 * `platform-optimization-settings.test.tsx` instead.
 */
describe("Settings copy clarity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronEventListeners.clear();
  });

  const describedText = (element: Element): string => {
    const ids = (element.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    return ids
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  };

  const expectEveryControlExplained = (label: string) => {
    const controls = [
      ...screen.queryAllByRole("switch"),
      ...screen.queryAllByRole("combobox"),
    ];
    expect(controls.length).toBeGreaterThan(0);
    const unexplained = controls
      .filter((control) => describedText(control).length === 0)
      .map(
        (control) =>
          control.getAttribute("aria-label") ??
          document.getElementById(
            control.getAttribute("aria-labelledby") ?? "",
          )?.textContent ??
          control.outerHTML.slice(0, 120),
      );
    expect(
      unexplained,
      `${label}: every switch and select needs one sentence saying what it does`,
    ).toEqual([]);
  };

  it("gives every switch and select on every tab a sentence of its own", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    expectEveryControlExplained("General");

    fireEvent.click(screen.getByText("Transcription"));
    await screen.findByText("Microphones");
    expectEveryControlExplained("Transcription");

    fireEvent.click(screen.getByText("Privacy & Security"));
    await screen.findByText("macOS permissions");
    expectEveryControlExplained("Privacy & Security");

    fireEvent.click(screen.getByText("Storage"));
    await screen.findByText("Backups");
    expectEveryControlExplained("Storage");

    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("API keys");
    expectEveryControlExplained("AI & Keys");
  });

  /**
   * Two switches wrote `privacy.remoteProcessingEnabled` -- one on Privacy &
   * Security, one on AI & Keys -- with two different descriptions. A reader
   * could not tell whether that was one consent or two. It has one home now,
   * and AI & Keys reports its state and sends you there.
   */
  it("keeps the cloud-AI consent switch in exactly one place", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");

    fireEvent.click(screen.getByText("AI & Keys"));
    await screen.findByText("API keys");
    expect(
      screen.queryByRole("switch", {
        name: "Use cloud AI for summaries and answers",
      }),
    ).toBeNull();
    expect(screen.getByText("Cloud AI is off")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open Privacy & Security/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Privacy & Security"));
    expect(
      await screen.findByRole("switch", {
        name: "Use cloud AI for summaries and answers",
      }),
    ).toBeInTheDocument();
  });

  /**
   * The Storage copy has to name what auto-delete actually removes.
   * `enforce_dictation_retention_policy` calls `delete_recording`, so the
   * dictation's text goes with its audio -- and the same control also stands
   * in Dictation, which the copy now says out loud.
   */
  it("says that dictation auto-delete takes the text, and that the control is shared", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByText("Storage"));

    const retention = await screen.findByRole("combobox", {
      name: "Auto-delete dictation recordings",
    });
    const description = describedText(retention);
    expect(description).toMatch(/the text in History/i);
    expect(description).toMatch(/same setting appears in Dictation/i);
  });
});
