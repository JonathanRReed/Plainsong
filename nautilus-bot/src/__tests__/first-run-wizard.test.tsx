import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { MEETING_ONBOARDING_STORAGE_KEY } from "@/lib/onboarding";
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
    defaultProvider: "macos_apple_speech",
    selectedModelId: "apple-default",
    useSharedAsrSelection: true,
    dictationProvider: "macos_apple_speech",
    dictationModelId: "apple-default",
    meetingProvider: "macos_apple_speech",
    meetingModelId: "apple-default",
    providerModelIds: {},
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    language: null,
    numSpeakers: 0,
    speakerNamingMethod: "auto" as const,
    diarizationModelId: "ecapa_tdnn_speaker",
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
    saveRawTranscript: false,
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
  defaultTemplate: "meeting",
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

  it("completes the full onboarding in dictation-only mode", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");
    const saveSettings = vi.mocked(backend.saveSettings);

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

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+Space");
    expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("persists hands-free mode from onboarding", async () => {
    const onComplete = vi.fn();

    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    fireEvent.change(screen.getByLabelText("Hotkey behavior"), {
      target: { value: "hands_free" },
    });
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: false,
      });
    });

    expect(currentSettings.transcription.dictationPushToTalk).toBe(false);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(true);
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
});
