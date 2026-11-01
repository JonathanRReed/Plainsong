import { applySettingsPatch, type SettingsPatch } from "@/lib/settings-patch";
import type { Settings } from "@/types/settings";
import type { SavedPrompt } from "@/lib/saved-prompts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SettingsView } from "@/components/views/settings-view-simple";
import { SETTINGS_INDEX, SETTINGS_SECTIONS } from "@/components/settings/settings-sections";
import { settingAnchorId } from "@/components/ui/settings-control";
import { ToastProvider } from "@/components/toast";
import { OPEN_ONBOARDING_EVENT } from "@/lib/onboarding";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";

/**
 * Settings uses the custom Select (a Radix listbox) rather than a native
 * `<select>`, so a choice is made the way a reader makes it: open the menu,
 * pick the option.
 */
async function openOptionSelect(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(trigger);
  return screen.findByRole("listbox");
}

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
  const listbox = await openOptionSelect(trigger);
  fireEvent.click(within(listbox).getByRole("option", { name }));
}

/** Opens one Settings section from the list on the left. */
function openSection(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

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

vi.mock("@/lib/backend/audio-storage", () => ({
  getAudioStorageStatus: vi.fn().mockResolvedValue({ audioBytes: 0, bytesSaved: 0, pendingTracks: 0 }),
  freeMeetingAudio: vi.fn(),
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
  AsrProviderManager: () => <div>Speech model diagnostics</div>,
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
const settingsSave = vi.fn(async (_settings: Settings): Promise<void> => {});
let patchStore: Settings | null = null;

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
      electronEventListeners.set(eventName, (event) => {
        if (eventName === "settings-changed") patchStore = event.payload as Settings;
        handler(event);
      });
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
  listOllamaModelCatalog: vi.fn(async () => []),
  getCuratedOllamaModelCatalog: vi.fn(async () => []),
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
      id: "campplus_speaker",
      label: "CAM++",
      description: "Smaller and faster. Remembers voices.",
      installed: false,
    },
  ]),
  getDiarizationModelPlan: vi.fn(async () => null),
  deleteModelFile: vi.fn(async () => {}),
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
  patchSettings: vi.fn(async (patch: SettingsPatch) => {
    const backend = await import("@/lib/backend");
    const results = vi.mocked(backend.getSettings).mock.results;
    const loaded = await results[results.length - 1]?.value;
    if (!loaded) throw new Error("Settings must load before saving");
    const next = applySettingsPatch(patchStore ?? loaded, patch);
    await settingsSave(next);
    patchStore = applySettingsPatch(patchStore ?? loaded, patch);
  }),
  setSavedPrompts: vi.fn(async (prompts: readonly SavedPrompt[]) => [...prompts]),
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
  // General carries the update status and the beta switch.
  getUpdateStatus: vi.fn(async () => ({ status: "idle" })),
  getUpdateChannel: vi.fn(async () => "stable"),
  setUpdateChannel: vi.fn(async () => {}),
  checkForUpdates: vi.fn(async () => ({ status: "idle" })),
  installUpdate: vi.fn(async () => {}),
}));

describe("SettingsView performance behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchStore = null;
    settingsSave.mockReset().mockResolvedValue(undefined);
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

  it("loads the heavy privacy and backup data only when Privacy & data opens", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    expect(backend.getSettings).toHaveBeenCalledTimes(1);
    expect(backend.getBackupConfig).toHaveBeenCalledTimes(1);
    expect(backend.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
    expect(backend.listBackups).not.toHaveBeenCalled();
    expect(backend.getSecurityStatus).not.toHaveBeenCalled();

    openSection("Privacy & data");
    await waitFor(() => {
      expect(backend.getSecurityStatus).toHaveBeenCalledTimes(1);
      expect(backend.listBackups).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps nearby spelling off until the user enables it", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Dictation");
    const control = await screen.findByRole("switch", { name: "Spell names from nearby text" });
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Use text on screen near where you're typing to spell names correctly. Stays on this Mac.")).toBeInTheDocument();
    fireEvent.click(control);
    await waitFor(() => expect(backend.patchSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(backend.patchSettings).mock.calls[0][0].operations).toEqual([
      { op: "set", path: ["transcription", "dictationNearbySpelling"], value: true },
    ]);
    await waitFor(() => expect(control).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(control);
    await waitFor(() => expect(backend.patchSettings).toHaveBeenCalledTimes(2));
    expect(patchStore?.transcription.dictationNearbySpelling).toBe(false);
  });

  it("moves between sections with the arrow keys and names the open one", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    const tablist = screen.getByRole("tablist", { name: "Settings sections" });
    const general = within(tablist).getByRole("tab", { name: "General" });
    expect(general).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      general.id,
    );
    // Only the open section sits in the Tab order; arrows do the rest.
    expect(
      within(tablist)
        .getAllByRole("tab")
        .filter((tab) => tab.getAttribute("tabindex") === "0"),
    ).toEqual([general]);

    // The list is vertical, so Down moves to the next section.
    fireEvent.keyDown(general, { key: "ArrowDown" });
    const dictation = within(tablist).getByRole("tab", { name: "Dictation" });
    expect(dictation).toHaveAttribute("aria-selected", "true");
    expect(dictation).toHaveFocus();
    await screen.findByRole("heading", { name: "Your words" });

    fireEvent.keyDown(dictation, { key: "End" });
    const advanced = within(tablist).getByRole("tab", { name: "Advanced" });
    expect(advanced).toHaveFocus();
    expect(advanced).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(advanced, { key: "Home" });
    expect(general).toHaveFocus();
    fireEvent.keyDown(general, { key: "ArrowUp" });
    expect(advanced).toHaveAttribute("aria-selected", "true");
  });

  it("keeps Settings on screen when the sidecar replies without a conflicts list", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getShortcutConflicts).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof backend.getShortcutConflicts>>,
    );

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await waitFor(() => {
      expect(backend.getShortcutConflicts).toHaveBeenCalled();
    });
    // The broadcast can be just as short.
    await act(async () => {
      electronEventListeners.get("shortcut-conflicts-changed")?.({
        payload: {},
      });
    });
    openSection("Shortcuts");
    expect(await screen.findByText("Dictation shortcuts")).toBeInTheDocument();
  });

  it("turns a renderer bug into a plain sentence instead of engine text", async () => {
    const backend = await import("@/lib/backend");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(backend.getSecurityStatus).mockRejectedValueOnce(
      new TypeError("Cannot read properties of null (reading 'token')"),
    );

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");

    expect(
      await screen.findByText("Failed to load security details"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("hides paths and stack traces from security errors", async () => {
    const backend = await import("@/lib/backend");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(backend.getSecurityStatus).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'sidecar:invoke': Error: Failed to read /Users/test/vault.bin\n    at readVault (vault.ts:12:3)",
    ));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
    expect(await screen.findByText("Failed to load security details")).toBeInTheDocument();
    expect(screen.queryByText(/\/Users\/test|at readVault/)).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("still shows a backend's own explanation when it has one", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSecurityStatus).mockRejectedValueOnce(
      new Error("Error invoking remote method 'sidecar:invoke': Error: The vault is busy migrating. Try again in a minute."),
    );

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");

    expect(
      await screen.findByText(
        "The vault is busy migrating. Try again in a minute.",
      ),
    ).toBeInTheDocument();
  });

  it("ignores a delayed initial read after a broadcast and local edit", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    let finishRead: (settings: Settings) => void = () => {};
    vi.mocked(backend.getSettings).mockReturnValueOnce(new Promise<Settings>((resolve) => {
      finishRead = resolve;
    }));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await waitFor(() => expect(electronEventListeners.has("settings-changed")).toBe(true));
    await act(async () => { electronEventListeners.get("settings-changed")?.({ payload: {
      ...initial, ui: { ...initial.ui, alwaysOnTop: false, minimizeToTray: false },
    } }); });
    const alwaysOnTop = await screen.findByRole("switch", { name: "Keep the window on top" });
    fireEvent.click(alwaysOnTop);
    await act(async () => { finishRead({
      ...initial, ui: { ...initial.ui, alwaysOnTop: false, minimizeToTray: true },
    }); });
    expect(alwaysOnTop).toBeChecked();
    expect(screen.getByRole("switch", { name: "Keep running in the menu bar" })).not.toBeChecked();
    await waitFor(() => expect(settingsSave).toHaveBeenCalled());
    expect(patchStore?.ui.alwaysOnTop).toBe(true);
    expect(patchStore?.ui.minimizeToTray).toBe(false);
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

  it("saves an optional captured meeting length while preserving other settings", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");
    const input = await screen.findByRole("spinbutton", { name: "Longest meeting, in minutes" });
    expect(input).toHaveValue(0);
    expect(input).toHaveAttribute("max", "240");
    expect(input).toHaveAccessibleDescription(/Counts recorded time, not pauses.*warns you before it stops.*saved and transcribed as usual.*0 means no limit/);
    fireEvent.change(input, { target: { value: "30.5" } });
    await waitFor(() => expect(settingsSave).toHaveBeenCalledWith(expect.objectContaining({
      transcription: expect.objectContaining({ defaultProvider: "whisper" }),
      meetings: expect.objectContaining({ maxRecordingMinutes: 31, autoStopAfterSilenceMinutes: 15, callDetectionEnabled: true }),
    })));
    fireEvent.change(input, { target: { value: "999" } });
    await waitFor(() => expect(settingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ meetings: expect.objectContaining({ maxRecordingMinutes: 240 }) })));
    fireEvent.change(input, { target: { value: "0" } });
    await waitFor(() => expect(settingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ meetings: expect.objectContaining({ maxRecordingMinutes: 0 }) })));
  });

  it("saves Keep running after close through settings alone", async () => {
    // The toggle used to fire `app:set_minimize_to_tray` alongside the save.
    // Its handler was deleted, so the call could only ever reject into an
    // empty catch; the setting already travels on `settings-changed`.
    const electron = await import("@/lib/electron");
    const invoke = vi.mocked(electron.invoke);
    const saveSettings = vi.mocked(settingsSave);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");

    fireEvent.click(
      screen.getByRole("switch", { name: "Keep running in the menu bar" }),
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
      "Keep running in the menu bar",
      "Keep the window on top",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }
    for (const name of [
      "App-wide microphone",
      "Dictation microphone override",
      "Meeting microphone override",
      "Language you speak",
    ]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    for (const name of [
      "Use a different microphone for dictation",
      "Use a different microphone for meetings",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }

    openSection("Dictation");
    for (const name of [
      "Show the dictation pill",
      "Mute other audio while dictating",
      "AI cleanup",
      "Spoken commands",
      "Snippets",
      // Two correction-learning switches, named for where each one looks.
      // The old single "Learn from your corrections" claimed both and only
      // ever did the first.
      "Suggest corrections from edits in Plainsong",
      "Learn from corrections you make in other apps",
      "Also copy to the clipboard",
    ]) {
      expect(await screen.findByRole("switch", { name })).toBeInTheDocument();
    }

    openSection("Meetings");
    for (const name of [
      "Show the meeting window",
      "Tell speakers apart",
      "Name meetings for me",
      "Summarize every meeting automatically",
    ]) {
      expect(await screen.findByRole("switch", { name })).toBeInTheDocument();
    }

    openSection("Shortcuts");
    for (const name of [
      "Paste last result shortcut",
      "Copy last result shortcut",
      "Open window shortcut",
    ]) {
      expect(await screen.findByRole("textbox", { name })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("combobox", { name: "How the dictation shortcut works" }),
    ).toBeInTheDocument();

    openSection("Privacy & data");
    for (const name of [
      "Allow cloud AI processing",
      "Ask macOS for permission when needed",
    ]) {
      expect(await screen.findByRole("switch", { name })).toBeInTheDocument();
    }
    for (const name of [
      "Auto-delete dictations",
      "After transcription",
      "Delete meeting audio after",
      "What auto-delete removes",
    ]) {
      expect(await screen.findByRole("combobox", { name })).toBeInTheDocument();
    }
    // The service picker appears once uploading is allowed.
    fireEvent.click(
      await screen.findByRole("switch", {
        name: "Allow uploading to cloud storage",
      }),
    );
    expect(
      await screen.findByRole("combobox", { name: "Cloud storage service" }),
    ).toBeInTheDocument();

    openSection("Search & AI");
    expect(
      await screen.findByRole("combobox", { name: "API key service" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "How Ask finds passages" }),
    ).toBeInTheDocument();

    openSection("Advanced");
    expect(
      await screen.findByRole("switch", { name: "Skip silence" }),
    ).toBeInTheDocument();
  });

  it("downloads the selected Nemotron model when ECAPA is already installed", async () => {
    const backend = await import("@/lib/backend");
    const catalog = [
      {
        id: "ecapa_tdnn_speaker",
        label: "ECAPA-TDNN 512",
        description: "Speaker embeddings with clustering (~25 MB)",
        installed: true,
      },
      {
        id: "nemotron3_diarization",
        label: "Nemotron 3 Diarization (experimental)",
        description: "Local, up to eight speakers with overlap (~400 MB)",
        installed: false,
      },
    ];
    vi.mocked(backend.listDiarizationModels)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(catalog);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");

    const modelPicker = await screen.findByRole("combobox", {
      name: "Speaker model",
    });
    await chooseOption(modelPicker, /Nemotron 3 Diarization/);

    const download = await screen.findByRole("button", {
      name: /Download speaker model/,
    });
    fireEvent.click(download);

    await waitFor(() => {
      expect(backend.downloadDiarizationModel).toHaveBeenCalledTimes(1);
      expect(backend.downloadDiarizationModel).toHaveBeenCalledWith(
        "nemotron3_diarization",
      );
    });
  });

  it("shows the model picker before any diarization model is installed", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.isDiarizationModelAvailable).mockResolvedValueOnce(false);
    const catalog = [
      {
        id: "ecapa_tdnn_speaker",
        label: "ECAPA-TDNN 512",
        description: "Speaker embeddings with clustering (~25 MB)",
        installed: false,
      },
      {
        id: "nemotron3_diarization",
        label: "Nemotron 3 Diarization (experimental)",
        description: "Local, up to eight speakers with overlap (~400 MB)",
        installed: false,
      },
    ];
    vi.mocked(backend.listDiarizationModels)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(catalog);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");

    const modelPicker = await screen.findByRole("combobox", {
      name: "Speaker model",
    });
    await chooseOption(modelPicker, /Nemotron 3 Diarization/);
    fireEvent.click(
      await screen.findByRole("button", { name: /Download speaker model/ }),
    );

    await waitFor(() => {
      expect(backend.downloadDiarizationModel).toHaveBeenCalledTimes(1);
      expect(backend.downloadDiarizationModel).toHaveBeenCalledWith(
        "nemotron3_diarization",
      );
    });
  });

  it("shows a saved ERes2NetV2 choice as no longer offered and removes its file on request", async () => {
    const backend = await import("@/lib/backend");
    const filePath = "/tmp/plainsong-test/models/diarization/eres2netv2_speaker.onnx";
    // mockReset restores each factory default, so later tests see the usual settings.
    onTestFinished(() => {
      vi.mocked(backend.getSettings).mockReset();
      vi.mocked(backend.getDiarizationModelPlan).mockReset();
      vi.mocked(backend.listDownloadedModels).mockReset();
    });
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      transcription: {
        ...baseSettings.transcription,
        enableDiarization: true,
        diarizationModelId: "eres2netv2_speaker",
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.getDiarizationModelPlan).mockResolvedValue({
      selectedModelId: "ecapa_tdnn_speaker",
      selectedLabel: "ECAPA-TDNN 512",
      selectedDownloadSize: "25 MB",
      selectedInstalled: true,
      runModelId: "ecapa_tdnn_speaker",
      fallbackNotice: "ERes2NetV2 is turned off while its license is unresolved, so this meeting used another speaker model on this Mac. Choose one in Settings > Meetings > Speaker model.",
    });
    vi.mocked(backend.listDownloadedModels).mockResolvedValue([
      { name: "Speaker embedding ERes2NetV2", provider: "diarization", path: filePath, sizeBytes: 28_000_000 },
    ]);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");

    const modelPicker = await screen.findByRole("combobox", { name: "Speaker model" });
    expect(modelPicker).toHaveTextContent("ERes2NetV2 (no longer offered)");
    expect(
      await screen.findByText("ERes2NetV2 is no longer offered, so meetings use ECAPA-TDNN 512. Choose a model here to replace it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download speaker model/ })).not.toBeInTheDocument();
    const listbox = await openOptionSelect(modelPicker);
    expect(within(listbox).getByRole("option", { name: "ERes2NetV2 (no longer offered)" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(await screen.findByText(/An earlier ERes2NetV2 download \(28 MB\) is still on this Mac/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove ERes2NetV2 file" }));
    await waitFor(() => {
      expect(backend.deleteModelFile).toHaveBeenCalledWith(filePath);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Remove ERes2NetV2 file" })).not.toBeInTheDocument();
    });
    expect(backend.downloadDiarizationModel).not.toHaveBeenCalled();
  });

  it("shows spoken commands as disabled when the setting is absent", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Dictation");

    expect(await screen.findByRole("switch", { name: "Spoken commands" })).not.toBeChecked();
  });

  it("invalidates ASR runtime probes before refreshing permission diagnostics", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
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

  it.each(["Models", "Search & AI"])("does not fetch cloud catalogs when %s opens with local lanes", async (section) => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: { ...baseSettings.privacy, remoteProcessingEnabled: true },
    } as Awaited<ReturnType<typeof backend.getSettings>>);
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection(section);
    await act(async () => { await Promise.resolve(); });
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
    expect(backend.listAnthropicModels).not.toHaveBeenCalled();
    expect(backend.listGeminiModels).not.toHaveBeenCalled();
    expect(backend.listDeepSeekModels).not.toHaveBeenCalled();
    expect(backend.listOllamaCloudModels).not.toHaveBeenCalled();
  });

  it("fetches only the cloud catalog explicitly chosen in API keys", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: { ...baseSettings.privacy, remoteProcessingEnabled: true },
    } as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.listAnthropicModels).mockResolvedValueOnce(["claude-test"]);
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Search & AI");
    await chooseOption(screen.getByRole("combobox", { name: "API key service" }), "Anthropic");
    await waitFor(() => expect(backend.listAnthropicModels).toHaveBeenCalledTimes(1));
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
    expect(backend.listGeminiModels).not.toHaveBeenCalled();
    expect(backend.listDeepSeekModels).not.toHaveBeenCalled();
    expect(backend.listOllamaCloudModels).not.toHaveBeenCalled();
  });

  it("refreshes a saved cloud provider only when its lane refresh button is clicked", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        remoteProcessingEnabled: true,
        meetingsAi: { provider: "openai", modelId: "gpt-catalog-test-model" },
      },
    } as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.listOpenAiModels).mockResolvedValueOnce(["gpt-catalog-test-model"]);
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Models");
    const refresh = await screen.findByRole("button", { name: "Refresh models for Who writes summaries, answers, and actions" });
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(backend.listOpenAiModels).not.toHaveBeenCalled();
    fireEvent.click(refresh);
    await waitFor(() => expect(backend.listOpenAiModels).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("option", { name: "gpt-catalog-test-model" })).toBeInTheDocument();
    expect(backend.listAnthropicModels).not.toHaveBeenCalled();
    expect(backend.listGeminiModels).not.toHaveBeenCalled();
    expect(backend.listDeepSeekModels).not.toHaveBeenCalled();
    expect(backend.listOllamaCloudModels).not.toHaveBeenCalled();
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

    openSection("Search & AI");
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
    openSection("Privacy & data");
    expect(screen.getByText("Loading backup settings…")).toBeInTheDocument();

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
    expect(chip).toHaveTextContent(/Text insertion\s*·\s*Needs setup/);
  });

  it("renders no removed audio-tuning placebo controls in any section", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    // AudioSettings.autoGainControl / manualGainDb (and the other audio-tuning
    // fields) were removed from the backend schema; the paired controls must
    // be gone too, not reading `undefined` off settings.audio.
    for (const section of ["General", "Dictation", "Meetings", "Advanced"]) {
      openSection(section);
      await screen.findByRole("heading", { level: 2, name: section });
      expect(screen.queryByText("Auto gain control")).not.toBeInTheDocument();
      expect(screen.queryByText(/Manual gain/)).not.toBeInTheDocument();
      expect(screen.queryByText("Noise suppression")).not.toBeInTheDocument();
      expect(screen.queryByText("Voice activity detection")).not.toBeInTheDocument();
    }
  });

  it("marks meeting audio ready only after the silent check returns verified callbacks", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");
    expect(
      await screen.findByText(/needs your OK to record the meeting audio/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every sound this Mac plays during the meeting, music, videos and notifications included, and it works with headphones\./i),
    ).toBeInTheDocument();
    // Nothing has been refused, so System Settings has nothing to fix yet.
    expect(
      within(document.getElementById(settingAnchorId("system-audio"))!).queryByRole("button", { name: "Open System Settings" }),
    ).not.toBeInTheDocument();
    expect(backend.testSystemAudioCapture).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Allow meeting audio" }));

    await waitFor(() => {
      expect(backend.testSystemAudioCapture).toHaveBeenCalledTimes(1);
    });
    expect(
      (await screen.findAllByText(/Ready\. Records all audio playing on this Mac, including other apps and notification sounds, with or without headphones\./i)).length,
    ).toBeGreaterThan(0);
  });

  it("sends a refused meeting-audio permission to System Settings, with a way to check again", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSystemAudioCapability).mockResolvedValueOnce({
      backend: "core_audio_process_tap",
      nativeOsSupported: true,
      nativeOsEnabled: true,
      routeDevice: "MacBook Pro Speakers",
      routeId: "coreaudio:BuiltInSpeakerDevice",
      nativeSampleRate: 48000,
      nativeChannels: 2,
      readiness: "unverified",
      ready: false,
      reason: "permission_denied",
      actionableReason: null,
      permission: "denied",
    } as never);
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");
    expect(
      await screen.findByText(/macOS is blocking Plainsong from recording meeting audio/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow meeting audio" }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(document.getElementById(settingAnchorId("system-audio"))!).getByRole("button", { name: "Open System Settings" }));
    expect(backend.openPermissionSettings).toHaveBeenCalledWith("system_audio");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(backend.testSystemAudioCapture).toHaveBeenCalledTimes(1);
    });
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
    openSection("Privacy & data");

    expect((await screen.findAllByText(/4 of 6 encrypted/i)).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/still plaintext/i)
    ).toBeInTheDocument();
    // The bare claim the bytes on disk contradict.
    expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
    expect(
      screen.getByText(/with server fallback off/i),
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
    openSection("Privacy & data");
    await screen.findAllByText(/6 of 6 encrypted/i);

    // Toggling an unrelated setting on the same page triggers the debounced
    // whole-object save; the encrypted-status readout must not flip to
    // "not encrypted" just because privacy.encryptRecordings no longer exists
    // on the saved Settings object.
    const remoteProcessingSwitch = screen.getByRole("switch", {
      name: "Allow cloud AI processing",
    });
    fireEvent.click(remoteProcessingSwitch);

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });

    expect(screen.getAllByText(/6 of 6 encrypted/i).length).toBeGreaterThan(0);
  });

  it("debounces rapid settings changes into a single save", async () => {
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
    expect(settingsSave).toHaveBeenCalledTimes(1);
  });

  it("requires the native folder picker instead of accepting a raw export path", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
    await screen.findByRole("button", { name: "Choose export folder" });

    expect(
      screen.queryByPlaceholderText("/Users/you/Documents/Plainsong"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose export folder" }));

    await waitFor(() => {
      expect(backend.selectExportLocation).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalledWith(
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

    // The shared behavior sits in Shortcuts, directly above the bindings
    // whose "Follows the setting above" names it.
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
    expect(hotkeySelect).toHaveAttribute("role", "combobox");
    const hotkeyOptions = await openOptionSelect(hotkeySelect);
    expect(
      within(hotkeyOptions).getByRole("option", {
        name: "Start on its own when you speak",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(hotkeyOptions).getByRole("option", {
        name: "Hold to record, release to stop",
      }),
    );

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(settingsSave).mock.calls;
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

    // The shared behavior sits in Shortcuts, directly above the bindings
    // whose "Follows the setting above" names it.
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
    expect(hotkeySelect).toHaveAttribute("role", "combobox");
    const hotkeyOptions = await openOptionSelect(hotkeySelect);
    expect(
      within(hotkeyOptions).queryByRole("option", {
        name: "Hold to record, release to stop",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(hotkeyOptions).getByRole("option", {
        name: "Press to start, press again to stop",
      }),
    ).toBeInTheDocument();
    expect(
      within(hotkeyOptions).getByRole("option", {
        name: "Start on its own when you speak",
      }),
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

    // The shared behavior sits in Shortcuts, directly above the bindings
    // whose "Follows the setting above" names it.
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

    const hotkeySelect = await screen.findByLabelText(
      "How the dictation shortcut works",
    );
    await chooseOption(hotkeySelect, "Start on its own when you speak");

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(settingsSave).mock.calls;
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
    openSection("Advanced");
    await screen.findByRole("heading", { name: "Speech detection" });

    await waitFor(() => {
      expect(backend.isSileroVadModelDownloaded).toHaveBeenCalled();
    });

    // Model not downloaded yet: Silero is not selectable, only a download
    // affordance is shown (no silent/automatic download).
    expect(backend.downloadSileroVadModel).not.toHaveBeenCalled();
    const downloadButton = await screen.findByRole("button", {
      name: "Voice detection model, 2 MB",
    });
    expect(
      screen.queryByRole("button", { name: "Voice detection model" }),
    ).not.toBeInTheDocument();

    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(backend.downloadSileroVadModel).toHaveBeenCalledTimes(1);
    });

    // Once downloaded, the Silero option becomes available and selecting it
    // persists dictationVadBackend: "silero" via the normal save path.
    fireEvent.click(
      await screen.findByRole("button", { name: "Voice detection model" }),
    );

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(settingsSave).mock.calls;
    const lastSave = saveCalls[saveCalls.length - 1]?.[0] as
      | { transcription?: { dictationVadBackend?: string } }
      | undefined;
    expect(lastSave?.transcription?.dictationVadBackend).toBe("silero");
  });

  it("preserves cloud opt-out while the Silero download finishes", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    const enabled = {
      ...initial,
      privacy: { ...initial.privacy, remoteProcessingEnabled: true },
    };
    vi.mocked(backend.getSettings).mockResolvedValueOnce(enabled);
    vi.mocked(backend.isSileroVadModelDownloaded).mockResolvedValue(false);
    let finish = () => {};
    vi.mocked(backend.downloadSileroVadModel).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Advanced");
    fireEvent.click(
      await screen.findByRole("button", { name: "Voice detection model, 2 MB" }),
    );
    await waitFor(() => expect(backend.downloadSileroVadModel).toHaveBeenCalledTimes(1));
    await act(async () => {
      electronEventListeners.get("settings-changed")?.({ payload: {
        ...enabled,
        privacy: { ...enabled.privacy, remoteProcessingEnabled: false },
      } });
      finish();
    });
    await waitFor(() => expect(backend.patchSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(backend.patchSettings).mock.calls[0][0].operations).toEqual([
      { op: "set", path: ["transcription", "dictationVadBackend"], value: "silero" },
    ]);
    expect(patchStore?.privacy.remoteProcessingEnabled).toBe(false);
  });

  it("defaults VAD backend to energy-threshold when unset, requiring no download", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.isSileroVadModelDownloaded).mockResolvedValue(false);

    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Advanced");

    const energyOption = await screen.findByRole("button", { name: "Loudness" });
    expect(energyOption).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Voice detection model, 2 MB" }),
    ).toBeInTheDocument();
  });

  it("presents settings-only snapshots and can restore the latest one", async () => {
    const backend = await import("@/lib/backend");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
    // The "Settings snapshots" sub-heading was folded into the one "Backups"
    // group; wait on that group, then assert the settings-only snapshot is
    // still presented separately from the full backup.
    await screen.findByText("Backups");

    expect(screen.getByText("Settings snapshot")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Settings and shortcuts only — no recordings or transcripts/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/dictionary entries|snippets/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snapshot settings" })).toBeInTheDocument();

    const restoreButton = screen.getByRole("button", { name: "Restore latest snapshot" });
    await waitFor(() => {
      expect(restoreButton).toBeEnabled();
    });
    // Restoring replaces every preference at once, so it asks first.
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(restoreButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(backend.restoreBackupDefault).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(backend.restoreBackupDefault).toHaveBeenCalledWith("settings_20260314_120000");
    });
    confirm.mockRestore();
  });

  it("states that backups and cloud uploads are manual without promising scheduling", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
    await screen.findByText("Backups");

    expect(
      screen.getByText(
        /a copy is made only when you press a button here/i,
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
    expect(screen.getByText(
      /cannot restore full backups from or into a vault-encrypted database; settings snapshots restore preferences only\./,
    )).toBeInTheDocument();
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

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsSave).toHaveBeenCalled();
    const calls = vi.mocked(settingsSave).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.alwaysOnTop).toBe(true);
  });

  it("renders command line and MCP access in Advanced, off, with the sentence that says what it allows", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Advanced");
    expect(
      await screen.findByRole("heading", { name: "Command line and MCP access" }),
    ).toBeInTheDocument();
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

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Advanced");
    await screen.findByRole("switch", { name: "Allow the plainsong command and MCP server" });
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("switch", { name: "Allow the plainsong command and MCP server" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsSave).toHaveBeenCalled();
    const calls = vi.mocked(settingsSave).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.automation?.localToolsEnabled).toBe(true);
    // Nothing else in the payload moved.
    expect(lastCall?.[0]?.ui?.minimizeToTray).toBe(true);
  });

  it("merges another writer's settings-changed broadcast without clobbering an unsaved local edit", async () => {

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.useFakeTimers();

    // Start an edit whose debounced save has not landed yet, so the ui
    // section is still "dirty" (draft != last-known-persisted).
    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));

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
    expect(settingsSave).toHaveBeenCalled();
    const calls = vi.mocked(settingsSave).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.ui?.alwaysOnTop).toBe(true);
    // ...while the untouched section still picks up the broadcast instead
    // of being reverted by this view's own stale whole-object save.
    expect(lastCall?.[0]?.privacy?.meetingsAi?.provider).toBe("anthropic");
  });

  it("keeps the Key Manager's credential-provider selector independent of the default analysis provider", async () => {

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    // Where an automatic summary goes is stated in Meetings.
    openSection("Meetings");
    const analysisDescription = (
      await screen.findByRole("switch", { name: "Summarize every meeting automatically" })
    ).getAttribute("aria-describedby");
    const describedText = () =>
      document.getElementById(analysisDescription ?? "")?.textContent ?? "";
    expect(describedText()).toContain("Ollama on this machine");
    openSection("Search & AI");
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const credentialProviderSelect = screen.getByRole("combobox", {
      name: "API key service",
    });
    const saveCallsBeforeChange = vi.mocked(settingsSave).mock.calls.length;
    // Synchronous open-and-pick: `findBy*` polls on real timers, which are
    // faked here.
    fireEvent.click(credentialProviderSelect);
    fireEvent.click(screen.getByRole("option", { name: "Anthropic" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(credentialProviderSelect).toHaveTextContent("Anthropic");
    // Picking a different provider to manage credentials for must not
    // silently steer the app's actual analysis provider away from ollama --
    // this selector no longer writes settings.privacy.meetingsAi, so it must
    // not trigger a settings save at all.
    expect(vi.mocked(settingsSave).mock.calls.length).toBe(
      saveCallsBeforeChange,
    );
    for (const [savedSettings] of vi.mocked(settingsSave).mock.calls) {
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
    openSection("Meetings");

    // On by default, so it has to name the destination rather than sit
    // undisclosed in the settings schema.
    const toggle = await screen.findByRole("switch", {
      name: "Summarize every meeting automatically",
    });
    expect(toggle).toHaveAccessibleDescription(/Anthropic/);
    expect(toggle).toHaveAccessibleDescription(/without asking/);

    fireEvent.click(toggle);

    // Opening Settings saves on its own — each lane pins an explicit model
    // as soon as its provider's list arrives — so neither "saveSettings was
    // called" nor "the newest call" identifies the toggle's write. Wait for
    // the write that actually carries it.
    await waitFor(() => {
      const toggledSave = vi
        .mocked(settingsSave)
        .mock.calls.find(
          ([next]) => next?.transcription?.enableAutoAnalysis === false,
        );
      expect(toggledSave).toBeDefined();
    });

    // ...and nothing lands after it that quietly turns analysis back on.
    const saveCalls = vi.mocked(settingsSave).mock.calls;
    const lastCall = saveCalls[saveCalls.length - 1];
    expect(lastCall?.[0]?.transcription?.enableAutoAnalysis).toBe(false);

    // The switch itself has to agree. The model-coercion pass writes a whole
    // Settings object once a provider's model list arrives, and React flushes
    // it after this click but before the re-render — built from its own
    // closure it would put the switch back on and re-enable the very thing
    // the user just turned off.
    expect(toggle).toHaveAttribute(
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
    openSection("Search & AI");

    // Key Manager auto-seeds its provider to the current default analysis
    // provider (anthropic here), so the warning should already be visible
    // without any manual provider selection.
    await screen.findByText(/No key saved for/);
    expect(
      screen.getByRole("combobox", { name: "API key service" }),
    ).toHaveTextContent("Anthropic");

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
    // Full setup lives in General, where someone looking for it would start;
    // each part's own setup sits with that part.
    fireEvent.click(await screen.findByRole("button", { name: /run setup again/i }));
    openSection("Dictation");
    fireEvent.click(await screen.findByRole("button", { name: /fix dictation setup/i }));
    openSection("Meetings");
    fireEvent.click(await screen.findByRole("button", { name: /set up meetings/i }));

    expect(events).toEqual(["full", "dictation", "meetings"]);

    window.removeEventListener(OPEN_ONBOARDING_EVENT, handler as EventListener);
  });

  it("switches local Ollama analysis without keeping or replacing a stale cloud model id", async () => {
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
    openSection("Models");
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
      expect(settingsSave).toHaveBeenCalledWith(
        expect.objectContaining({
          privacy: expect.objectContaining({
            meetingsAi: { provider: "ollama", modelId: null },
          }),
        }),
      );
    });
  });

  it("keeps the service's default model as null when Ollama models load", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        dictationAi: { provider: "ollama", modelId: null },
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.listOllamaModels).mockResolvedValueOnce([
      "llama3.2",
      "mistral",
    ]);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.mocked(settingsSave).mockClear();
    openSection("Models");
    await waitFor(() => expect(backend.listOllamaModels).toHaveBeenCalled());

    expect(settingsSave).not.toHaveBeenCalled();
  });

  it("does not overwrite an unknown stored model when Models opens", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValueOnce({
      ...baseSettings,
      privacy: {
        ...baseSettings.privacy,
        dictationAi: { provider: "ollama", modelId: "custom-model:latest" },
      },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    vi.mocked(backend.listOllamaModels).mockResolvedValueOnce(["llama3.2"]);

    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    vi.mocked(settingsSave).mockClear();
    openSection("Models");
    await waitFor(() => expect(backend.listOllamaModels).toHaveBeenCalled());

    expect(settingsSave).not.toHaveBeenCalled();
  });

  it("persists the dictation active language set from transcription settings", async () => {

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    // General, under the language; behind its own disclosure.
    await screen.findByText("Languages you dictate in");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Dictate in French/i,
      })
    );

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });

    const saveCalls = vi.mocked(settingsSave).mock.calls;
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
    openSection("Shortcuts");

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
    openSection("Shortcuts");

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
    openSection("Shortcuts");

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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

    // Each menu shows the option its stored value names.
    expect(await screen.findByLabelText("Dictation action")).toHaveTextContent(
      "Dictation in the selected profile",
    );
    expect(await screen.findByLabelText("Binding 2 action")).toHaveTextContent(
      "Dictation · Writing",
    );
    expect(screen.getByLabelText("Binding 2 behavior")).toHaveTextContent(
      "Hold to record, release to stop",
    );
    expect(await screen.findByLabelText("Binding 3 action")).toHaveTextContent(
      "Next profile",
    );

    // The third binding is Ctrl+Shift+Space written in a different order, so
    // it collides with the primary one and says so in the row.
    expect(
      await screen.findByText(
        /Same trigger as Dictation — this one is removed when settings save\./,
      ),
    ).toBeInTheDocument();
  });

  it("saves Press Return after inserting per binding and keeps it through an action change", async () => {
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
            id: "chat",
            trigger: { kind: "key", accelerator: "Ctrl+Alt+M" },
            action: { kind: "dictation", modeId: "messages", behavior: "hold" },
          },
          {
            id: "cycle",
            trigger: { kind: "key", accelerator: "Ctrl+Alt+N" },
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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    vi.mocked(settingsSave).mockClear();

    const primary = await screen.findByRole("checkbox", {
      name: "Press Return after inserting (Dictation)",
    });
    const chat = screen.getByRole("checkbox", {
      name: "Press Return after inserting (Binding 2)",
    });
    expect(primary).not.toBeChecked();
    expect(chat).not.toBeChecked();
    expect(chat).toHaveAccessibleDescription(
      "Presses Return once Plainsong confirms the text is in the same field. In chat and AI prompt boxes this sends the message before you can review it. Off by default. To send only sometimes, add a second binding with this on.",
    );
    // Cycle and cancel bindings never insert text, so they have no checkbox.
    expect(screen.getAllByRole("checkbox", { name: /Press Return after inserting/ })).toHaveLength(2);

    const savedBindings = () => {
      const calls = vi.mocked(settingsSave).mock.calls;
      return (calls[calls.length - 1]?.[0] as unknown as {
        shortcuts: { dictationBindings: Array<{ id: string; action: Record<string, unknown> }> };
      }).shortcuts.dictationBindings;
    };

    fireEvent.click(chat);
    await waitFor(() => expect(settingsSave).toHaveBeenCalled());
    expect(savedBindings().find((binding) => binding.id === "chat")?.action).toEqual({
      kind: "dictation",
      modeId: "messages",
      behavior: "hold",
      submitAfterInsert: true,
    });
    expect(savedBindings().find((binding) => binding.id === "primary")?.action).not.toHaveProperty(
      "submitAfterInsert",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Press Return after inserting (Binding 2)" }),
      ).toBeChecked(),
    );

    await chooseOption(
      screen.getByRole("combobox", { name: "Binding 2 action" }),
      "Dictation · Writing",
    );
    await waitFor(() =>
      expect(savedBindings().find((binding) => binding.id === "chat")?.action).toEqual({
        kind: "dictation",
        modeId: "email",
        behavior: "hold",
        submitAfterInsert: true,
      }),
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Press Return after inserting (Binding 2)" }),
    );
    await waitFor(() =>
      expect(savedBindings().find((binding) => binding.id === "chat")?.action).toMatchObject({
        submitAfterInsert: false,
      }),
    );
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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    vi.mocked(settingsSave).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Add binding" }));

    // The row is on screen and listening, and nothing was written.
    const recorder = await screen.findByLabelText("Binding 2 trigger");
    expect(recorder).toHaveValue("Listening...");
    await screen.findByText("No keys recorded yet.");
    expect(settingsSave).not.toHaveBeenCalled();

    fireEvent.keyDown(recorder, {
      key: "E",
      code: "KeyE",
      ctrlKey: true,
      altKey: true,
    });

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(settingsSave).mock.calls;
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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    vi.mocked(settingsSave).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Add binding" }));
    await screen.findByLabelText("Binding 2 trigger");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove binding 2 binding" }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText("Binding 2 trigger")).not.toBeInTheDocument();
    });
    expect(settingsSave).not.toHaveBeenCalled();
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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");

    const behavior = await screen.findByLabelText("Dictation behavior");
    // The stored value is still what the row shows, and the option it names
    // exists -- disabled, saying why.
    expect(behavior).toHaveTextContent("Hold to record (needs Accessibility)");
    expect(
      screen.getByText(
        /Hold works once Accessibility is on for Plainsong\. Until then, this binding presses to start and presses again to stop\./,
      ),
    ).toBeInTheDocument();
    // The warning carries its own way to the switch it names.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open System Settings to turn on Accessibility for dictation hold",
      }),
    );
    expect(backend.openPermissionSettings).toHaveBeenCalledWith("accessibility");
    // A hold binding uses the lock options even while the shared behavior is
    // press to start and stop.
    expect(screen.getByRole("switch", { name: "Double-tap to lock" })).toBeInTheDocument();
    const behaviorOptions = await openOptionSelect(behavior);
    expect(
      within(behaviorOptions).getByRole("option", {
        name: "Hold to record (needs Accessibility)",
      }),
    ).toHaveAttribute("aria-disabled", "true");
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
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    vi.mocked(settingsSave).mockClear();

    const recorder = await screen.findByLabelText("Dictation shortcut");
    // No focus event first: this is the very first interaction with the row.
    fireEvent.mouseDown(recorder, { button: 3 });

    await waitFor(() => {
      expect(settingsSave).toHaveBeenCalled();
    });
    const saveCalls = vi.mocked(settingsSave).mock.calls;
    const saved = saveCalls[saveCalls.length - 1]?.[0] as unknown as {
      shortcuts: { dictationBindings: Array<{ trigger: Record<string, unknown> }> };
    };
    expect(saved.shortcuts.dictationBindings[0].trigger).toEqual({
      kind: "mouse",
      button: 4,
      modifiers: [],
    });
  });

  it("retries a failed settings save from the latest draft", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    vi.mocked(backend.getSettings).mockResolvedValue({ ...initial, theme: "system", ui: { ...initial.ui, alwaysOnTop: false } });
    vi.mocked(settingsSave).mockReset().mockResolvedValue(undefined).mockRejectedValueOnce(
      new Error("Error invoking remote method 'sidecar:invoke': Error: Failed to create temp settings file"),
    );
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));
    const retry = await screen.findByRole("button", { name: "Retry saving" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't save your settings. Check available storage and folder access, then retry.",
    );
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.getByRole("switch", { name: "Keep the window on top" })).toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await act(async () => { electronEventListeners.get("settings-changed")?.({ payload: {
      ...initial, theme: "light", ui: { ...initial.ui, alwaysOnTop: false },
    } }); });
    vi.mocked(settingsSave).mockRejectedValueOnce(new Error("Failed to commit settings file"));
    fireEvent.click(retry);
    const secondRetry = await screen.findByRole("button", { name: "Retry saving" });
    await waitFor(() => expect(settingsSave).toHaveBeenCalledTimes(2));
    expect(vi.mocked(settingsSave).mock.calls[1][0].theme).toBe("light");
    expect(screen.getByRole("switch", { name: "Keep the window on top" })).toBeChecked();
    let finish = () => {};
    vi.mocked(settingsSave).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(secondRetry);
    await waitFor(() => expect(settingsSave).toHaveBeenCalledTimes(3));
    expect(vi.mocked(settingsSave).mock.calls[2][0].ui.alwaysOnTop).toBe(true);
    expect(vi.mocked(settingsSave).mock.calls[2][0].theme).toBe("light");
    expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull();
    await act(async () => { finish(); });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps newer edits while a settings retry is in flight", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    vi.mocked(backend.getSettings).mockResolvedValue({ ...initial, ui: { ...initial.ui, alwaysOnTop: false, minimizeToTray: true } });
    vi.mocked(settingsSave).mockReset().mockResolvedValue(undefined).mockRejectedValueOnce(new Error("Failed to commit settings file"));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));
    const retry = await screen.findByRole("button", { name: "Retry saving" });
    let finish = () => {};
    vi.mocked(settingsSave).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(retry);
    await waitFor(() => expect(settingsSave).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("switch", { name: "Keep running in the menu bar" }));
    await act(async () => { finish(); });
    await screen.findByText("All changes saved");
    expect(settingsSave).toHaveBeenCalledTimes(3);
    const saved = vi.mocked(settingsSave).mock.calls[2][0];
    expect(saved.ui.alwaysOnTop).toBe(true);
    expect(saved.ui.minimizeToTray).toBe(false);
    expect(screen.getByRole("switch", { name: "Keep the window on top" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Keep running in the menu bar" })).not.toBeChecked();
  });

  it("persists off after an off-on-off edit while the first write is in flight", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...initial, ui: { ...initial.ui, alwaysOnTop: false },
    });
    let finish = () => {};
    settingsSave.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    const toggle = await screen.findByRole("switch", { name: "Keep the window on top" });
    fireEvent.click(toggle);
    await waitFor(() => expect(settingsSave).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle);
    await act(async () => { finish(); });
    await waitFor(() => expect(settingsSave).toHaveBeenCalledTimes(2));
    expect(patchStore?.ui.alwaysOnTop).toBe(false);
    expect(toggle).not.toBeChecked();
    const patches = vi.mocked(backend.patchSettings).mock.calls;
    expect(applySettingsPatch({ ui: { alwaysOnTop: true, minimizeToTray: false } }, patches[1][0]))
      .toEqual({ ui: { alwaysOnTop: false, minimizeToTray: false } });
  });

  it.each([false, true])("adopts a later canonical privacy choice after save acknowledgment, pending edit %s", async (pendingEdit) => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    const enabled = {
      ...initial,
      ui: { ...initial.ui, alwaysOnTop: false },
      privacy: { ...initial.privacy, remoteProcessingEnabled: true },
    };
    vi.mocked(backend.getSettings).mockResolvedValueOnce(enabled);
    let finish = () => {};
    vi.mocked(backend.patchSettings).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Privacy & data");
    const consent = await screen.findByRole("switch", { name: "Allow cloud AI processing" });
    fireEvent.click(consent);
    await waitFor(() => expect(backend.patchSettings).toHaveBeenCalledTimes(1));
    await act(async () => {
      electronEventListeners.get("settings-changed")?.({ payload: {
        ...enabled, privacy: { ...enabled.privacy, remoteProcessingEnabled: false },
      } });
      electronEventListeners.get("settings-changed")?.({ payload: { ...enabled } });
    });
    expect(consent).not.toBeChecked();
    if (pendingEdit) {
      openSection("General");
      fireEvent.click(await screen.findByRole("switch", { name: "Keep the window on top" }));
    }
    await act(async () => { finish(); });
    await screen.findByText("All changes saved");
    if (pendingEdit) {
      expect(screen.getByRole("switch", { name: "Keep the window on top" })).toBeChecked();
      expect(patchStore?.ui.alwaysOnTop).toBe(true);
      expect(patchStore?.privacy.remoteProcessingEnabled).toBe(true);
      openSection("Privacy & data");
    }
    expect(await screen.findByRole("switch", { name: "Allow cloud AI processing" })).toBeChecked();
  });

  it("accepts a same-section broadcast while keeping only the locally dirty field", async () => {
    const backend = await import("@/lib/backend");
    const initial = await backend.getSettings();
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...initial, ui: { ...initial.ui, alwaysOnTop: false, minimizeToTray: true },
    });
    render(<ToastProvider><SettingsView /></ToastProvider>);
    const toggle = await screen.findByRole("switch", { name: "Keep the window on top" });
    fireEvent.click(toggle);
    await act(async () => { electronEventListeners.get("settings-changed")?.({ payload: {
      ...initial, ui: { ...initial.ui, alwaysOnTop: false, minimizeToTray: false },
    } }); });
    expect(toggle).toBeChecked();
    expect(screen.getByRole("switch", { name: "Keep running in the menu bar" })).not.toBeChecked();
    await waitFor(() => expect(settingsSave).toHaveBeenCalled());
    expect(patchStore?.ui.alwaysOnTop).toBe(true);
    expect(patchStore?.ui.minimizeToTray).toBe(false);
  });

  it("retains the canonical prompt baseline when an event precedes save completion", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    let finish = () => {};
    vi.mocked(settingsSave).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));
    await waitFor(() => expect(settingsSave).toHaveBeenCalled());
    const broadcast = (name: string) => electronEventListeners.get("settings-changed")?.({ payload: {
      ...baseSettings, ui: { ...baseSettings.ui, alwaysOnTop: true },
      ai: { savedPrompts: [{ id: "canonical", name, prompt: "Native sanitized text", scope: "both" }] },
    } });
    await act(async () => { broadcast("Native rewrite"); });
    await act(async () => { finish(); });
    await act(async () => { broadcast("Later native rewrite"); });
    openSection("Search & AI");
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    expect(await screen.findByText("Later native rewrite")).toBeTruthy();
  });

  it("retains other canonical settings when their event precedes save completion", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    let finish = () => {};
    vi.mocked(settingsSave).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("switch", { name: "Keep the window on top" }));
    await waitFor(() => expect(settingsSave).toHaveBeenCalled());
    await act(async () => { electronEventListeners.get("settings-changed")?.({ payload: {
      ...baseSettings, theme: "light", ui: { ...baseSettings.ui, alwaysOnTop: true },
    } }); });
    await act(async () => { finish(); });
    expect(screen.getByText("All changes saved")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
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
    openSection("Search & AI");
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");

    vi.mocked(backend.setSavedPrompts).mockRejectedValueOnce(
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
    openSection("Search & AI");
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");

    vi.mocked(backend.setSavedPrompts).mockResolvedValueOnce([
      { id: "canonical", name: "Native canonical result", prompt: "Stored text", scope: "both" },
    ]);
    vi.mocked(settingsSave).mockClear();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide Decisions made" }),
    );

    await waitFor(() => {
      const written = vi
        .mocked(backend.setSavedPrompts)
        .mock.calls.find(([next]) =>
          next.some((prompt) => prompt.hidden === true),
        );
      expect(written).toBeDefined();
    });
    expect(await within(dialog).findByText("Native canonical result")).toBeTruthy();
    expect(settingsSave).not.toHaveBeenCalled();
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("blocks rapid saved-prompt writes while the setter is pending", async () => {
    const backend = await import("@/lib/backend");

    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Search & AI");
    fireEvent.click(await screen.findByRole("button", { name: "Manage prompts" }));
    const dialog = await screen.findByRole("dialog");
    const saveSettings = vi.mocked(backend.setSavedPrompts);
    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());

    let finishFirstSave: (() => void) | undefined;
    saveSettings.mockClear();
    saveSettings.mockImplementationOnce(
      () =>
        new Promise<SavedPrompt[]>((resolve) => {
          finishFirstSave = () => resolve([...saveSettings.mock.calls[0][0]]);
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

    await act(async () => { finishFirstSave?.(); });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "Hide Open questions" })).not.toBeDisabled();
  });

  // ── Translate to English (roadmap item B7a) ────────────────────────────
  it("refuses translate-to-English on an English-only whisper model and says why", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Dictation");

    // baseSettings selects whisper `base.en`, which has no translate task.
    const toggle = await screen.findByRole("switch", {
      name: "Translate to English",
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(
        /This speech model is English-only and cannot translate\./,
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

  it("gives every switch and select in every section a sentence of its own", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    for (const section of SETTINGS_SECTIONS) {
      openSection(section.label);
      await screen.findByRole("heading", { level: 2, name: section.label });
      // Let lazily loaded rows (backups, models) arrive before counting.
      await act(async () => {
        await Promise.resolve();
      });
      expectEveryControlExplained(section.label);
    }
  });

  /**
   * Two switches once wrote `privacy.remoteProcessingEnabled`, with two
   * different descriptions. A reader could not tell whether that was one
   * consent or two. It has one home, Privacy & data, and Search & AI reports
   * its state and sends you there.
   */
  it("keeps the cloud-AI consent switch in exactly one place", async () => {
    render(
      <ToastProvider>
        <SettingsView />
      </ToastProvider>,
    );

    await screen.findByText("How Plainsong listens, writes, and what it keeps.");

    openSection("Search & AI");
    await screen.findByText("API keys");
    expect(
      screen.queryByRole("switch", {
        name: "Allow cloud AI processing",
      }),
    ).toBeNull();
    expect(screen.getByText("Cloud AI is off")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open Privacy & data/ }),
    ).toBeInTheDocument();

    openSection("Privacy & data");
    expect(
      await screen.findByRole("switch", {
        name: "Allow cloud AI processing",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Dictation can also send/),
    ).toHaveTextContent("selected text, nearby app text and the app's name");
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
    openSection("Privacy & data");

    const retention = await screen.findByRole("combobox", {
      name: "Auto-delete dictations",
    });
    const description = describedText(retention);
    expect(description).toMatch(/the text in History/i);
    expect(description).toMatch(/same setting appears in Dictation/i);
  });
});

describe("SettingsView mic-test URL ownership", () => {
  const recorders: MockMicRecorder[] = [];
  class MockMicRecorder {
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["recorded audio"]) });
      this.onstop?.();
    }
  }
  const createUrl = vi.fn();
  const revokeUrl = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    electronEventListeners.clear();
    recorders.length = 0;
    createUrl.mockReset().mockReturnValueOnce("blob:mic-test-1")
      .mockReturnValueOnce("blob:mic-test-2").mockReturnValueOnce("blob:mic-test-3");
    revokeUrl.mockReset();
    const micLevel = await import("@/hooks/use-mic-level");
    vi.spyOn(micLevel, "useMicLevel").mockReturnValue({
      state: "live", level: 0.5, heard: true, error: null, usingSystemDefault: false,
      start: vi.fn(async () => {}), stop: vi.fn(),
      getStream: vi.fn(() => ({} as MediaStream)),
    });
    vi.stubGlobal("MediaRecorder", MockMicRecorder);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openMicTest() {
    const view = render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    await screen.findByRole("button", { name: "Record 3s" });
    vi.useFakeTimers();
    return view;
  }

  function recordAndFinish() {
    fireEvent.click(screen.getByRole("button", { name: "Record 3s" }));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole("button", { name: "Record 3s" })).toBeEnabled();
  }

  it("mic-test URL ownership revokes the current playback URL on unmount", async () => {
    const view = await openMicTest();
    recordAndFinish();
    expect(view.container.querySelector("audio")).toHaveAttribute("src", "blob:mic-test-1");
    expect(revokeUrl).not.toHaveBeenCalled();
    view.unmount();
    expect(revokeUrl.mock.calls).toEqual([["blob:mic-test-1"]]);
  });

  it("mic-test URL ownership revokes each superseded recording exactly once", async () => {
    const view = await openMicTest();
    recordAndFinish();
    fireEvent.click(screen.getByRole("button", { name: "Record 3s" }));
    expect(view.container.querySelector("audio")).toBeNull();
    expect(revokeUrl.mock.calls).toEqual([["blob:mic-test-1"]]);
    act(() => { vi.advanceTimersByTime(3000); });
    recordAndFinish();
    expect(view.container.querySelector("audio")).toHaveAttribute("src", "blob:mic-test-3");
    expect(revokeUrl.mock.calls).toEqual([["blob:mic-test-1"], ["blob:mic-test-2"]]);
    view.unmount();
    expect(createUrl).toHaveBeenCalledTimes(3);
    expect(revokeUrl.mock.calls).toEqual([["blob:mic-test-1"], ["blob:mic-test-2"], ["blob:mic-test-3"]]);
  });

  it("mic-test URL ownership rejects a late recorder stop after unmount", async () => {
    const view = await openMicTest();
    fireEvent.click(screen.getByRole("button", { name: "Record 3s" }));
    expect(recorders).toHaveLength(1);
    view.unmount();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(recorders[0].state).toBe("inactive");
    expect(createUrl).not.toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
  });
  it("saves right-side presets and reports missing native helper", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValue({ nativeShortcutAvailable: false });
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    await chooseOption(screen.getByRole("combobox", { name: "Dictation trigger type" }), "Right Command on its own");
    await waitFor(() => expect(settingsSave).toHaveBeenLastCalledWith(expect.objectContaining({
      shortcuts: expect.objectContaining({ dictationBindings: expect.arrayContaining([
        expect.objectContaining({ trigger: { kind: "key", accelerator: "RightCommand" } }),
      ]) }),
    })));
    expect(await screen.findByText(/modifier on its own needs the native shortcut helper/i)).toBeInTheDocument();
    await chooseOption(screen.getByRole("combobox", { name: "Dictation trigger type" }), "Right Option on its own");
    await waitFor(() => expect(settingsSave).toHaveBeenLastCalledWith(expect.objectContaining({
      shortcuts: expect.objectContaining({ toggleDictation: "RightOption" }),
    })));
  });

  it("hides the hold lock options while nothing uses hold", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    expect(screen.queryByRole("switch", { name: "Double-tap to lock" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Tap to lock" })).not.toBeInTheDocument();
  });

  it("saves double-tap locking without changing the legacy single-tap choice", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSettings).mockResolvedValue({
      ...baseSettings,
      transcription: { ...baseSettings.transcription, dictationPushToTalk: true },
    } as unknown as Awaited<ReturnType<typeof backend.getSettings>>);
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Shortcuts");
    await screen.findByText("Dictation shortcuts");
    const control = await screen.findByRole("switch", { name: "Double-tap to lock" });
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    await waitFor(() => expect(settingsSave).toHaveBeenLastCalledWith(expect.objectContaining({
      transcription: expect.objectContaining({ dictationDoubleTapToLock: true }),
    })));
  });

});

/**
 * The shape of Settings as a whole: eight sections in a fixed order, every
 * setting in the search index still reachable at its own anchor, and no
 * engineering words on screen. These are the promises the October 2026
 * reorganization made; see docs/settings-inventory-2026-10-22.md.
 */
describe("Settings structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchStore = null;
    electronEventListeners.clear();
  });

  async function renderSettings() {
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
  }

  async function openAndSettle(section: (typeof SETTINGS_SECTIONS)[number]) {
    openSection(section.label);
    await screen.findByRole("heading", { level: 2, name: section.label });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("lists the eight sections, most used first, and each one renders under its own heading", async () => {
    await renderSettings();
    const tabs = within(
      screen.getByRole("tablist", { name: "Settings sections" }),
    ).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "General",
      "Dictation",
      "Meetings",
      "Models",
      "Shortcuts",
      "Search & AI",
      "Privacy & data",
      "Advanced",
    ]);
    for (const section of SETTINGS_SECTIONS) {
      await openAndSettle(section);
      expect(screen.getByRole("tabpanel")).toHaveAttribute(
        "aria-labelledby",
        `settings-tab-${section.id}`,
      );
      expect(screen.getByText(section.summary)).toBeInTheDocument();
      // Each group inside is a titled region a screen reader can jump to.
      expect(
        within(screen.getByRole("tabpanel")).getAllByRole("heading", { level: 3 })
          .length,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every setting in the search index reachable at its own anchor", async () => {
    await renderSettings();
    const missing: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      await openAndSettle(section);
      for (const entry of SETTINGS_INDEX) {
        if (entry.section !== section.id || entry.sectionOnly || entry.conditional) {
          continue;
        }
        if (!document.getElementById(settingAnchorId(entry.id))) {
          missing.push(`${section.label} > ${entry.label} (setting-${entry.id})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("finds a setting by name and lands on it, opening the disclosure it sits in", async () => {
    await renderSettings();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "spoken commands" },
    });
    const results = await screen.findByRole("region", { name: "Search results" });
    fireEvent.click(within(results).getByRole("button", { name: /Spoken commands/ }));

    expect(screen.getByRole("tab", { name: "Dictation" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => {
      const row = document.getElementById(settingAnchorId("spoken-commands"));
      expect(row).not.toBeNull();
      expect(row?.closest("details")?.open).toBe(true);
    });
  });

  it("says nothing on screen in engineering words, even behind More options", async () => {
    const banned =
      /\b(graphics chips?|processors?|GPUs?|CPUs?|GGUF|ONNX|runtimes?|upstream|transducers?|embedders?|embeddings?|admission|headroom|inference|diari[sz]ation|VAD|LLMs?|ASR|sidecar|backend|providers?|quantiz\w*)\b/i;
    await renderSettings();
    const found: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      await openAndSettle(section);
      const panel = screen.getByRole("tabpanel");
      for (const details of panel.querySelectorAll("details")) {
        details.open = true;
      }
      const match = (panel.textContent ?? "").match(banned);
      if (match) {
        const at = (panel.textContent ?? "").indexOf(match[0]);
        found.push(
          `${section.label}: "${match[0]}" in “…${(panel.textContent ?? "").slice(Math.max(0, at - 60), at + 40)}…”`,
        );
      }
    }
    expect(found).toEqual([]);
  });
  it("announces a failed meeting audio check and allows retry", async () => {
    const backend = await import("@/lib/backend");
    vi.mocked(backend.getSystemAudioCapability).mockRejectedValueOnce(new Error("probe failed"));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    await screen.findByText("How Plainsong listens, writes, and what it keeps.");
    openSection("Meetings");
    expect((await screen.findByText(/Couldn't check meeting audio/)).closest('[role="alert"]')).not.toBeNull();
    const retry = within(document.getElementById(settingAnchorId("system-audio"))!).getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(backend.testSystemAudioCapture).toHaveBeenCalled());
  });

});
