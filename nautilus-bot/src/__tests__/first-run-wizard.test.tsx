import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { MEETING_ONBOARDING_STORAGE_KEY } from "@/lib/onboarding";
import { listen } from "@/lib/electron";
import type { AsrProviderInfo } from "@/types";

const providers: AsrProviderInfo[] = [
  {
    providerType: "macos_apple_speech",
    name: "Apple Native",
    description: "Native dictation",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Apple Native",
      version: "1",
      sizeMb: 0,
      parameters: "n/a",
      languages: ["en"],
      license: "Apple",
      sourceUrl: "https://developer.apple.com",
    },
    selectedModelId: "apple-default",
    modelOptions: [{ id: "apple-default", label: "Apple Native" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "distil_whisper",
    name: "Distil Whisper",
    description: "Meeting-grade",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Distil Whisper",
      version: "1",
      sizeMb: 756,
      parameters: "large-v3-distilled",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://huggingface.co",
    },
    selectedModelId: "distil-large-v3",
    modelOptions: [{ id: "distil-large-v3", label: "Large V3" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
];

const createSettings = () => ({
  audio: {},
  transcription: {
    defaultProvider: "macos_apple_speech",
    selectedModelId: "apple-default",
    useSharedAsrSelection: true,
    dictationProvider: "macos_apple_speech",
    dictationModelId: "apple-default",
    meetingProvider: "macos_apple_speech",
    meetingModelId: "apple-default",
    providerModelIds: {},
    enableDiarization: true,
    language: null,
    silenceSkipEnabled: false,
    dictationCopyToClipboard: true,
    dictationAutoRequestPermissions: true,
    dictationPushToTalk: true,
    dictationHandsFreeEnabled: false,
    dictationAiFormatting: false,
    dictationCustomPrompt: null,
    meetingCustomPrompt: null,
    meetingAutoNameEnabled: true,
    meetingAutoNameModel: null,
    dictationSaveToInbox: true,
    dictationProfile: "normal_speed" as const,
    dictationProjectId: "inbox",
    dictationRetentionPreset: "never" as const,
    dictationRetentionCustomHours: 24,
    meetingAudioStorageMode: "always" as const,
    meetingRetentionPreset: "never" as const,
    meetingRetentionCustomMonths: 1,
    meetingRetentionDeleteMode: "audio_only" as const,
    dictationSilenceTimeoutSeconds: 0,
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
    llmProvider: "ollama",
    llmModelId: null,
    exportRoot: null,
    vaultInitialized: false,
    vaultSalt: null,
  },
  shortcuts: {
    toggleRecording: "Ctrl+Shift+R",
    toggleDictation: "Cmd+Shift+Space",
    toggleDictationAlternates: [],
    openWindow: "Ctrl+Shift+N",
    quickExport: "Ctrl+Shift+E",
    focusSearch: "Ctrl+Shift+F",
  },
  updates: {
    channel: "stable" as const,
    autoCheck: true,
    lastCheckAt: null,
    lastSeenVersion: null,
  },
  theme: "system" as const,
});

let currentSettings = createSettings();
const storage = new Map<string, string>();

function getMeetingVerificationResult() {
  const provider = currentSettings.transcription.meetingProvider;
  const ready = provider === "distil_whisper" || provider === "parakeet" || provider === "voxtral";

  if (ready) {
    return {
      ok: true,
      title: "Meeting verification",
      summary: "Meeting route is ready.",
      details: [],
    };
  }

  return {
    ok: false,
    title: "Meeting verification",
    summary: "Meetings need a meeting-grade ASR route.",
    details: ["Apple Native is dictation-only for meetings."],
  };
}

vi.mock("@/lib/backend/asr", () => ({
  downloadAsrModels: vi.fn(async () => {}),
  getAsrProviders: vi.fn(async () => providers),
}));

vi.mock("@/lib/backend/recordings", () => ({
  checkSystemAudioAvailability: vi.fn(async () => true),
  getLoopbackDeviceName: vi.fn(async () => "BlackHole 2ch"),
}));

vi.mock("@/lib/backend/settings", () => ({
  getPermissionDiagnostics: vi.fn(async () => ({
    microphoneReady: true,
    microphonePermissionReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
    runningFromDiskImage: false,
  })),
  getSettings: vi.fn(async () => structuredClone(currentSettings)),
  openInstalledPlainsongApp: vi.fn(async () => {}),
  openPermissionSettings: vi.fn(async () => {}),
  requestDictationPermissions: vi.fn(async () => ({
    microphoneReady: true,
    microphonePermissionReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
    runningFromDiskImage: false,
  })),
  saveSettings: vi.fn(async (nextSettings) => {
    currentSettings = structuredClone(nextSettings);
  }),
  verifyMeetingSetup: vi.fn(async () => getMeetingVerificationResult()),
}));

async function clickPrimary(label: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  });
}

describe("FirstRunWizard", () => {
  beforeEach(() => {
    currentSettings = createSettings();
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
    vi.clearAllMocks();
  });

  it("completes the full onboarding in dictation-only mode, downloading the fast default when nothing was configured", async () => {
    const onComplete = vi.fn();

    // Start from an unconfigured dictation route (the shipped default) so
    // the background base.en fetch is expected to actually run.
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={onComplete} />);

    await clickPrimary(/start with dictation/i);
    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: true,
        meetingsCompleted: false,
      });
    });

    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+Space");
    // Continuing past the model step without clicking "Download" still fetches
    // the fast shipped default (whisper/base.en) in the background, so the
    // persisted dictation route isn't left permanently un-downloaded.
    await waitFor(() => {
      expect(currentSettings.transcription.dictationProvider).toBe("whisper");
    });
    expect(currentSettings.transcription.dictationModelId).toBe("base.en");
    // The wizard's hotkey step only manages the shortcut key, not the
    // interaction mode -- any existing hold-to-talk/hands-free preference
    // (set from Settings) is left untouched, not silently reset to toggle.
    expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("does not overwrite an already-configured, different dictation provider when just passing through the model step", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    // The default test fixture already has "macos_apple_speech" configured
    // as the dictation provider -- simulating a user who already has a
    // working, non-default route set up (e.g. from Settings).
    expect(currentSettings.transcription.dictationProvider).toBe("macos_apple_speech");

    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await clickPrimary(/continue/i); // dictation-model -> hotkey (no download clicked)
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    // The user's existing route must survive untouched -- no silent
    // downgrade to whisper/base.en, and no redundant download kicked off.
    expect(currentSettings.transcription.dictationProvider).toBe("macos_apple_speech");
    expect(currentSettings.transcription.dictationModelId).toBe("apple-default");
    expect(downloadAsrModels).not.toHaveBeenCalled();
  });

  it("does not disable Continue/Finish on later steps while the background default download is still running", async () => {
    const onComplete = vi.fn();
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let resolveDownload: (() => void) | undefined;
    downloadAsrModels.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDownload = resolve; })
    );

    // mode="dictation" has no "Skip for now" escape hatch, so if the
    // background download blocked Continue/Finish here the user would be
    // stuck until it finished or errored.
    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await clickPrimary(/continue/i); // dictation-model -> hotkey, kicks off background download

    const finishButton = await screen.findByRole("button", { name: /finish/i });
    expect(finishButton).not.toBeDisabled();

    await act(async () => {
      resolveDownload?.();
    });
  });

  it("reflects the existing hotkey mode instead of resetting it to toggle", async () => {
    const onComplete = vi.fn();

    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    // Hold-to-talk is a real, working mode configured from Settings (see
    // settings-view-simple.tsx); the wizard must describe it accurately
    // instead of assuming everyone is on toggle.
    expect(screen.getByText("Hotkey behavior")).toBeInTheDocument();
    expect(
      screen.getByText(/hold the shortcut to record, release to stop/i)
    ).toBeInTheDocument();
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: false,
      });
    });

    // Re-running onboarding must not silently clobber the existing preference.
    expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("repairs the meetings route in meetings-only onboarding", async () => {
    const onComplete = vi.fn();

    render(<FirstRunWizard mode="meetings" onComplete={onComplete} />);

    await screen.findByText(/meeting transcription route/i);
    expect(
      screen.getByText(/meetings need a meeting-grade asr route/i)
    ).toBeInTheDocument();

    await clickPrimary(/use recommended route/i);
    await waitFor(() => {
      expect(currentSettings.transcription.meetingProvider).toBe("distil_whisper");
    });

    await clickPrimary(/finish meeting setup/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: true,
      });
    });

    expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    expect(currentSettings.transcription.meetingModelId).toBe("distil-large-v3");
    expect(storage.get(MEETING_ONBOARDING_STORAGE_KEY)).toBe("true");
  });

  it("runs the dictation repair flow without marking full onboarding complete", async () => {
    const onComplete = vi.fn();

    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    expect(screen.queryByText(/choose your setup/i)).not.toBeInTheDocument();

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: false,
      });
    });
  });

  it("opens the matching macOS permission settings from the wizard", async () => {
    const backend = await import("@/lib/backend/settings");
    const getPermissionDiagnostics = vi.mocked(backend.getPermissionDiagnostics);
    const openPermissionSettings = vi.mocked(backend.openPermissionSettings);

    getPermissionDiagnostics.mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      automationReady: true,
      notes: [],
      runningFromDiskImage: false,
    });

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Fix Speech recognition" }));

    await waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("speech");
    });
    expect(screen.getByText("Opened macOS Speech Recognition settings.")).toBeInTheDocument();
  });

  it("opens the installed app when the wizard detects the DMG copy", async () => {
    const backend = await import("@/lib/backend/settings");
    const getPermissionDiagnostics = vi.mocked(backend.getPermissionDiagnostics);
    const openInstalledPlainsongApp = vi.mocked(backend.openInstalledPlainsongApp);

    getPermissionDiagnostics.mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      automationReady: true,
      notes: [],
      runningFromDiskImage: true,
    });

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open installed app" }));

    await waitFor(() => {
      expect(openInstalledPlainsongApp).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByText("Opened the installed Plainsong app from /Applications.")
    ).toBeInTheDocument();
  });

  it("reads the Keyboard fallback gate from postEventReady and fixes it via the Accessibility pane", async () => {
    // collect_permission_diagnostics hardcodes automationReady=false on macOS
    // forever, so the gate must key off postEventReady (the field that is
    // actually populated by CGPreflightPostEventAccess) instead.
    const backend = await import("@/lib/backend/settings");
    const getPermissionDiagnostics = vi.mocked(backend.getPermissionDiagnostics);
    const openPermissionSettings = vi.mocked(backend.openPermissionSettings);

    getPermissionDiagnostics.mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      automationReady: false,
      postEventReady: true,
      notes: [],
      runningFromDiskImage: false,
    });

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await screen.findByText("Keyboard fallback");
    // Ready via postEventReady even though the always-false automationReady
    // would otherwise show a permanent, unfixable red gate.
    expect(screen.queryByRole("button", { name: "Fix Keyboard fallback" })).not.toBeInTheDocument();

    getPermissionDiagnostics.mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      automationReady: false,
      postEventReady: false,
      notes: [],
      runningFromDiskImage: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Re-check permissions" }));

    fireEvent.click(await screen.findByRole("button", { name: "Fix Keyboard fallback" }));

    await waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("accessibility");
    });
  });

  it("labels Speech recognition as optional instead of a required blocking gate", async () => {
    const backend = await import("@/lib/backend/settings");
    const getPermissionDiagnostics = vi.mocked(backend.getPermissionDiagnostics);

    getPermissionDiagnostics.mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      automationReady: true,
      postEventReady: true,
      notes: [],
      runningFromDiskImage: false,
    });

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await screen.findByText("Speech recognition");
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(
      screen.getByText(/only needed if plainsong falls back to apple's native speech engine/i)
    ).toBeInTheDocument();
  });

  it("offers whisper base.en as the pre-selected fast default with real progress", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let resolveDownload: (() => void) | undefined;
    downloadAsrModels.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDownload = resolve; })
    );

    let progressHandler: ((event: { payload: [string, number] }) => void) | undefined;
    vi.mocked(listen).mockImplementationOnce(((_event: string, handler: (event: { payload: [string, number] }) => void) => {
      progressHandler = handler;
      return Promise.resolve(() => {});
    }) as typeof listen);

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i);

    const downloadButton = await screen.findByRole("button", { name: /download whisper base\.en/i });
    await act(async () => {
      fireEvent.click(downloadButton);
    });

    expect(progressHandler).toBeDefined();
    act(() => {
      progressHandler?.({ payload: ["whisper", 42] });
    });

    expect(await screen.findByText(/42%/)).toBeInTheDocument();

    // Let the still-open download promise resolve so it doesn't leak into
    // later tests/act warnings.
    await act(async () => {
      resolveDownload?.();
    });
  });

  it("renders as an accessible modal dialog", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
  });
});
