import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  dictationShortcutConflictMessage,
  FirstRunWizard,
} from "@/components/first-run-wizard";
import { AI_NOTES_OPT_OUT_STORAGE_KEY } from "@/lib/ai-notes-preference";
import { invoke, listen } from "@/lib/electron";
import type { AsrProviderInfo } from "@/types";
import type { NativeTextModelStatus } from "@/lib/backend/ai";

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
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "Large V3.5" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  // The speech step lists what the sidecar offers, so the fixture offers what
  // every build does: Parakeet v3 (the recommended model where GGUF Parakeet
  // isn't listed) and Whisper, neither downloaded yet.
  {
    providerType: "parakeet",
    name: "NVIDIA Parakeet",
    description: "Local Parakeet",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Parakeet TDT 0.6B v3",
      version: "1",
      sizeMb: 639,
      parameters: "0.6B",
      languages: ["en"],
      license: "CC-BY-4.0",
      sourceUrl: "https://huggingface.co",
    },
    selectedModelId: "parakeet-tdt-0.6b-v3",
    modelOptions: [
      { id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)" },
      { id: "parakeet-tdt-ctc-110m", label: "Parakeet TDT CTC 110M legacy (English only)" },
    ],
    downloadStatus: "NotDownloaded",
    runtimeStatus: "missing_model",
    runtimeDetails: {},
  },
  {
    providerType: "whisper",
    name: "Whisper",
    description: "Local Whisper",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Whisper",
      version: "1",
      sizeMb: 142,
      parameters: "base.en",
      languages: ["en"],
      license: "MIT",
      sourceUrl: "https://huggingface.co",
    },
    selectedModelId: "base.en",
    modelOptions: [
      { id: "base.en", label: "base.en (balanced, English)" },
      { id: "small", label: "small (better accuracy)" },
      { id: "small.en", label: "small.en (better accuracy, English)" },
      { id: "large-v3-turbo", label: "large-v3-turbo (fast + accurate)" },
    ],
    downloadStatus: "NotDownloaded",
    runtimeStatus: "missing_model",
    runtimeDetails: {},
  },
];

function unifiedProvider(
  overrides: Partial<AsrProviderInfo> = {},
): AsrProviderInfo {
  return {
    providerType: "transcribe_cpp",
    name: "Unified EN",
    description: "Local transcribe.cpp speech recognition",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Parakeet Unified EN",
      version: "1",
      sizeMb: 640,
      parameters: "0.6B Q8_0",
      languages: ["en"],
      license: "NVIDIA Open Model License",
      sourceUrl: "https://huggingface.co",
    },
    selectedModelId: "parakeet-unified-en-0.6b-q8_0",
    modelOptions: [
      {
        id: "parakeet-unified-en-0.6b-q8_0",
        label: "Parakeet Unified EN 0.6B Q8_0",
      },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
    ...overrides,
  };
}

const createSettings = (dictationRetentionPreset: "immediate" | "never" = "never") => ({
  audio: {},
  transcription: {
    // Dictation on the ONNX Parakeet default an older settings file names
    // without anyone choosing it, with meetings on a dictation-only engine.
    defaultProvider: "parakeet",
    selectedModelId: "parakeet-tdt-0.6b-v3",
    useSharedAsrSelection: false,
    dictationProvider: "parakeet",
    dictationModelId: "parakeet-tdt-0.6b-v3",
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
    dictationRetentionPreset,
    dictationRetentionCustomHours: 24,
    meetingAudioStorageMode: "always" as "always" | "transcript_only",
    meetingRetentionPreset: "never" as "1m" | "2m" | "3m" | "custom" | "never",
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
    muteMediaWhileDictating: false,
  },
  export: {},
  privacy: {
    remoteProcessingEnabled: false,
    dictationAi: { provider: "ollama", modelId: null } as {
      provider: string;
      modelId: string | null;
    },
    meetingsAi: { provider: "ollama", modelId: null } as {
      provider: string;
      modelId: string | null;
    },
    exportRoot: null,
    vaultInitialized: false,
    vaultSalt: null,
  },
  shortcuts: {
    toggleDictation: "Cmd+Shift+Space",
    openWindow: "Ctrl+Shift+N",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getMeetingVerificationResult() {
  const provider = currentSettings.transcription.meetingProvider;
  const ready =
    provider === "distil_whisper" || provider === "parakeet" || provider === "transcribe_cpp";

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

function speakerPlan(installed: boolean) {
  return {
    selectedModelId: "pyannote_community1",
    selectedLabel: "pyannote community-1",
    selectedDownloadSize: "33 MB",
    selectedInstalled: installed,
    runModelId: installed ? "pyannote_community1" : null,
    fallbackNotice: null,
  };
}

vi.mock("@/lib/backend/asr", () => ({
  downloadAsrModels: vi.fn(async () => {}),
  downloadDiarizationModel: vi.fn(async () => {}),
  getAsrProviders: vi.fn(async () => providers),
  getDiarizationModelPlan: vi.fn(async () => speakerPlan(true)),
  // Which models are on disk, per model. Empty unless a test puts files there.
  listDownloadedModels: vi.fn(async () => []),
}));

function nativeTextStatus(): NativeTextModelStatus {
  return {
    provider: "native_text",
    modelId: "native-meeting-model",
    displayName: "Built-in text model",
    downloadBytes: 100,
    bytesOnDisk: 100,
    ready: true,
    missingFiles: [],
    runtimePresent: true,
    memoryAvailableBytes: 1000,
    canLoadNow: true,
    runtimeHealth: { state: "available", message: null },
    qualified: true,
    contextTokens: 4096,
  };
}

vi.mock("@/lib/backend/ai", () => ({
  getNativeTextModelStatus: vi.fn(async () => nativeTextStatus()),
  downloadNativeTextModel: vi.fn(),
  cancelNativeTextModelDownload: vi.fn(),
  deleteNativeTextModel: vi.fn(),
  getOllamaStatus: vi.fn(async () => true),
  getLocalTextRuntimeHealth: vi.fn(async () => ({ localGateApplies: true, runtimeHealth: { state: "available", message: null } })),
  listOllamaModels: vi.fn(async () => ["qwen3.5:4b"]),
  listOllamaModelCatalog: vi.fn(async () => []),
  getCuratedOllamaModelCatalog: vi.fn(async () => []),
}));

vi.mock("@/lib/backend/dictation", () => ({
  getDictationAudioLevel: vi.fn(async () => 0),
  startDictation: vi.fn(async () => {}),
  stopDictation: vi.fn(async () => "This is my first Plainsong dictation."),
}));

vi.mock("@/lib/backend/recordings", () => ({
  listAudioInputDevices: vi.fn(async () => ({
    devices: [
      {
        deviceId: "BuiltInMicrophoneDevice",
        deviceName: "MacBook Pro Microphone",
        transportType: "builtin",
        isDefault: true,
        isAvailable: true,
        isBluetoothLike: false,
      },
      {
        deviceId: "usb-podcast-mic",
        deviceName: "Podcast Mic",
        transportType: "usb",
        isDefault: false,
        isAvailable: true,
        isBluetoothLike: false,
      },
    ],
    dictationOverrideEnabled: false,
    meetingOverrideEnabled: false,
  })),
  getSystemAudioCapability: vi.fn(async () => ({
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
  })),
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
}));

/**
 * The calendar row on the permissions step reads a snapshot; the probe cannot
 * raise a macOS prompt (see electron/main.ts's get_calendar_snapshot), so the
 * wizard calls it on mount like the other two.
 */
vi.mock("@/lib/backend/calendar", () => ({
  getCalendarSnapshot: vi.fn(async () => ({
    authorization: "authorized" as const,
    observedAt: 0,
    events: [],
    calendars: [],
    errorCode: null,
  })),
  openCalendarPrivacySettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/backend/settings", () => ({
  getDictationShortcutCapabilityStatus: vi.fn(async () => ({
    nativeShortcutAvailable: true,
  })),
  recordOnboardingState: vi.fn(async () => ({})),
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
  updateSettings: vi.fn(async (mutate) => {
    const nextSettings = structuredClone(currentSettings);
    mutate(nextSettings);
    currentSettings = nextSettings;
  }),
  verifyMeetingSetup: vi.fn(async () => getMeetingVerificationResult()),
}));

/**
 * The microphone check sits between the model step and the first practice
 * dictation in full onboarding. jsdom has no microphone, so the step shows its
 * "could not start" state; these flow tests only need to pass through it.
 */
async function passMicrophoneStep() {
  expect(
    await screen.findByRole("heading", { name: /microphone check/i }),
  ).toBeInTheDocument();
  await clickPrimary(/^continue$/i);
}

/** The fixture providers with Distil-Whisper not downloaded. */
function providersWithoutDistil(): AsrProviderInfo[] {
  return providers.map((provider) =>
    provider.providerType === "distil_whisper"
      ? { ...provider, downloadStatus: "NotDownloaded", runtimeStatus: "missing_model" }
      : provider,
  );
}

/** Dictation on Apple Speech, ready on this Mac: a working, deliberate choice. */
function useAppleSpeechDictation() {
  currentSettings.transcription.defaultProvider = "macos_apple_speech";
  currentSettings.transcription.selectedModelId = "apple-default";
  currentSettings.transcription.dictationProvider = "macos_apple_speech";
  currentSettings.transcription.dictationModelId = "apple-default";
}

/** Choose a speech model on the model step: each one is a radio option. */
async function chooseModel(label: RegExp) {
  const option = await screen.findByRole("radio", { name: label });
  await waitFor(() => expect(option).toBeEnabled());
  await act(async () => {
    fireEvent.click(option);
  });
}

async function clickPrimary(label: RegExp) {
  const button = screen.getByRole("button", { name: label });
  await waitFor(() => expect(button).toBeEnabled());
  await act(async () => {
    fireEvent.click(button);
  });
}

/**
 * The meeting-notes step sits between meeting setup and the closing summary, so
 * every full-onboarding walkthrough passes through it. Keeping the default
 * choice untouched here is deliberate: these tests assert the surrounding flow,
 * not the notes decision, which has its own tests below.
 */
async function passMeetingNotesStep() {
  expect(
    await screen.findByRole("heading", { name: /meeting notes/i }),
  ).toBeInTheDocument();
  await clickPrimary(/^continue$/i);
}

describe("dictationShortcutConflictMessage", () => {
  it("blocks a dictation shortcut that disables another configured action", () => {
    expect(
      dictationShortcutConflictMessage(
        {
          toggleDictation: "Cmd+Shift+Space",
          openWindow: "Cmd+Shift+P",
          repasteLastDictation: "Cmd+Ctrl+V",
          recopyLastDictation: "Cmd+Ctrl+C",
        },
        "Cmd+Shift+P"
      )
    ).toContain("conflicts with Open window");
  });

  it("accepts a distinct dictation shortcut", () => {
    expect(
      dictationShortcutConflictMessage(
        {
          openWindow: "Cmd+Shift+P",
          repasteLastDictation: "Cmd+Ctrl+V",
          recopyLastDictation: "Cmd+Ctrl+C",
        },
        "Cmd+Shift+Space"
      )
    ).toBeNull();
  });
});

describe("FirstRunWizard", () => {
  it("does not offer native Moonshine or persist its displayed replacement before a download", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const settingsBackend = await import("@/lib/backend/settings");
    currentSettings.transcription.dictationProvider = "moonshine";
    currentSettings.transcription.dictationModelId = "moonshine-base";
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers,
      unifiedProvider({
        providerType: "moonshine",
        selectedModelId: "moonshine-base",
        modelOptions: [{ id: "moonshine-base", label: "Moonshine Base" }],
        inferenceEnabled: false,
      }),
    ]);

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    expect(screen.queryByRole("radio", { name: /moonshine base/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your previous speech model is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/is on this Mac and ready\./)).not.toBeInTheDocument();
    expect(settingsBackend.updateSettings).not.toHaveBeenCalled();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationProvider).toBe("moonshine");
  });

  beforeEach(async () => {
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
    const ai = await import("@/lib/backend/ai");
    vi.mocked(ai.getNativeTextModelStatus).mockReset().mockResolvedValue(nativeTextStatus());
    vi.mocked(ai.downloadNativeTextModel).mockReset();
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockReset().mockResolvedValue(providers);
    vi.mocked(asrBackend.getDiarizationModelPlan).mockReset().mockResolvedValue(speakerPlan(true));
    vi.mocked(asrBackend.downloadDiarizationModel).mockReset().mockResolvedValue(undefined);
    vi.mocked(asrBackend.listDownloadedModels).mockReset().mockResolvedValue([]);
    vi.mocked(invoke).mockReset();
  });

  describe("speaker model in meeting setup", () => {
    it("names the speaker model and downloads it only when the reader chooses it", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      let installed = false;
      vi.mocked(asrBackend.getDiarizationModelPlan).mockImplementation(async () => speakerPlan(installed));
      vi.mocked(asrBackend.downloadDiarizationModel).mockImplementation(async () => {
        installed = true;
      });
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

      expect(
        await screen.findByText(/The speaker model \(33 MB\) tells voices apart/),
      ).toHaveTextContent("Nothing downloads until you choose Download speaker model.");
      const button = await screen.findByRole("button", { name: "Download speaker model (33 MB)" });
      expect(asrBackend.downloadDiarizationModel).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(button);
      });
      await waitFor(() =>
        expect(asrBackend.downloadDiarizationModel).toHaveBeenCalledWith("pyannote_community1"),
      );
      expect(asrBackend.downloadDiarizationModel).toHaveBeenCalledTimes(1);
    });

    it("covers the speech and speaker models with one download click", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      const parakeet: AsrProviderInfo = {
        ...providers[1], providerType: "parakeet", name: "Parakeet",
        selectedModelId: "parakeet-tdt-0.6b-v3",
        modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" }],
        downloadStatus: "NotDownloaded", runtimeStatus: "missing_model",
      };
      let speechDownloaded = false;
      vi.mocked(asrBackend.getAsrProviders).mockImplementation(async () => [
        speechDownloaded
          ? { ...parakeet, downloadStatus: "Downloaded", runtimeStatus: "ready" }
          : parakeet,
      ]);
      vi.mocked(asrBackend.downloadAsrModels).mockImplementation(async () => {
        speechDownloaded = true;
      });
      vi.mocked(asrBackend.getDiarizationModelPlan).mockResolvedValue(speakerPlan(false));
      currentSettings.transcription.meetingProvider = "parakeet";
      currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

      expect(
        await screen.findByRole("button", { name: "Download meeting models (670 MB + 33 MB)" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/gets it with the speech model; nothing downloads until you choose that/),
      ).toBeInTheDocument();
      await clickPrimary(/^download meeting models/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("parakeet", "parakeet-tdt-0.6b-v3"),
      );
      await waitFor(() =>
        expect(asrBackend.downloadDiarizationModel).toHaveBeenCalledWith("pyannote_community1"),
      );
    });

    it("downloads no speaker model when meetings are skipped", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getDiarizationModelPlan).mockResolvedValue(speakerPlan(false));
      render(<FirstRunWizard onComplete={vi.fn()} />);

      await clickPrimary(/skip model download/i);
      await passMicrophoneStep();
      await clickPrimary(/^continue$/i);
      await clickPrimary(/^set up meetings$/i);
      await screen.findByRole("button", { name: "Download speaker model (33 MB)" });
      await clickPrimary(/^skip meetings$/i);

      await screen.findByRole("heading", { name: /^ready$/i });
      expect(asrBackend.downloadDiarizationModel).not.toHaveBeenCalled();
    });

    it("says why a speaker download failed and then lets the reader continue without labels", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getDiarizationModelPlan).mockResolvedValue(speakerPlan(false));
      vi.mocked(asrBackend.downloadDiarizationModel).mockRejectedValue(
        new Error(
          "pyannote community-1 can't be downloaded yet: Plainsong's model release doesn't have this file yet (pyannote-community-1-embedding.onnx, HTTP 404).",
        ),
      );
      const onComplete = vi.fn();
      render(<FirstRunWizard mode="meetings" onComplete={onComplete} />);

      await screen.findByRole("button", { name: "Download speaker model (33 MB)" });
      await clickPrimary(/^download speaker model \(33 MB\)$/i);
      expect(await screen.findByText(/model release doesn't have this file yet/)).toBeInTheDocument();
      expect(screen.getByText(/didn't download\. You can continue/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try the download again" })).toBeInTheDocument();

      await clickPrimary(/^continue without speaker labels$/i);
      expect(asrBackend.downloadDiarizationModel).toHaveBeenCalledTimes(1);
    });
  });

  it("finishes fresh local dictation without meeting setup, an account, or cloud keys", async () => {
    const backend = await import("@/lib/backend/settings");
    const calendar = await import("@/lib/backend/calendar");
    const asr = await import("@/lib/backend/asr");
    vi.mocked(calendar.getCalendarSnapshot).mockResolvedValueOnce({
      authorization: "not_determined", observedAt: 0, events: [], calendars: [], errorCode: null,
    });
    currentSettings.transcription.defaultProvider = "parakeet";
    currentSettings.transcription.selectedModelId = "parakeet-tdt-0.6b-v3";
    currentSettings.transcription.dictationProvider = "parakeet";
    currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3";
    const meetingsBefore = {
      provider: currentSettings.transcription.meetingProvider,
      modelId: currentSettings.transcription.meetingModelId,
      ai: structuredClone(currentSettings.privacy.meetingsAi),
    };
    const onComplete = vi.fn();
    render(<FirstRunWizard onComplete={onComplete} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i })).toHaveAttribute("aria-checked", "true");
    // The others are listed, unselected; none is experimental.
    expect(screen.getByRole("radio", { name: /whisper base \(english\)/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio", { name: /experimental/i })).not.toBeInTheDocument();
    await clickPrimary(/^download.* and continue$/i);
    await passMicrophoneStep();
    await clickPrimary(/start a test/i);
    await clickPrimary(/finish and transcribe/i);
    await screen.findByText("This is my first Plainsong dictation.");
    await clickPrimary(/^continue$/i);
    fireEvent.keyDown(screen.getByLabelText("Dictation shortcut"), { key: "d", metaKey: true, shiftKey: true });
    const pauseAudio = screen.getByRole("checkbox", { name: /mute other audio while you dictate/i });
    expect(pauseAudio).not.toBeChecked();
    fireEvent.click(pauseAudio);
    expect(onComplete).not.toHaveBeenCalled();
    vi.mocked(backend.updateSettings).mockRejectedValueOnce(new Error("Settings locked"));
    await clickPrimary(/^start dictating$/i);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings locked");
    expect(onComplete).not.toHaveBeenCalled();
    await clickPrimary(/^start dictating$/i);
    // Start dictating passes through Ready, which is the only step that
    // reports insertion readiness and a skipped or failed download.
    await screen.findByRole("heading", { name: /^ready$/i });
    expect(screen.getByText("Typing into other apps")).toBeInTheDocument();
    expect(screen.getByText(/Not set up, as you chose/)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    await clickPrimary(/^start using plainsong$/i);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({ markOnboardingComplete: true, meetingsCompleted: false, deferred: false });
    expect(currentSettings.transcription.dictationProvider).toBe("parakeet");
    expect(currentSettings.transcription.dictationModelId).toBe("parakeet-tdt-0.6b-v3");
    expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+D");
    expect(currentSettings.ui.muteMediaWhileDictating).toBe(true);
    expect(currentSettings.privacy.remoteProcessingEnabled).toBe(false);
    // Meetings were on a dictation-only engine; the step said one download
    // covers both, so they move to the model just downloaded. Nothing else
    // about meetings changes.
    expect(meetingsBefore.provider).toBe("macos_apple_speech");
    expect(currentSettings.transcription.meetingProvider).toBe("parakeet");
    expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3");
    expect(currentSettings.privacy.meetingsAi).toEqual(meetingsBefore.ai);
    expect(backend.recordOnboardingState).not.toHaveBeenCalled();
    expect(backend.verifyMeetingSetup).not.toHaveBeenCalled();
    expect(calendar.openCalendarPrivacySettings).not.toHaveBeenCalled();
    expect(asr.downloadAsrModels).toHaveBeenCalledExactlyOnceWith("parakeet", "parakeet-tdt-0.6b-v3");
    expect(screen.queryByRole("heading", { name: /meeting setup|meeting notes/i })).not.toBeInTheDocument();
  });

  it("opens full onboarding with an explicit model download step", async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: /^speech model$/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/^step 1 of 7$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^download.* and continue$/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/one-time download/i)).toBeInTheDocument();
    // Two labelled sections: what does both, then what is for dictation only.
    const both = await screen.findByRole("group", { name: "Dictation and meetings" });
    const dictationOnly = screen.getByRole("group", { name: "Dictation only" });
    expect(both).toHaveAccessibleDescription("One model does both");
    expect(dictationOnly).toHaveAccessibleDescription("Meetings need a second model");
    // Parakeet v3 is built for 25 European languages; English is what was tested.
    expect(screen.getByText(
      "Tested in English. Also built for 24 other European languages.",
    )).toBeInTheDocument();
    // The recommended model covers both, so the step says one download does.
    expect(screen.getByText("One download covers dictation and meetings.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Meetings will use")).not.toBeInTheDocument();
    expect(screen.queryByText(/multilingual|upstream|verified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/one download covers both|selected model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/graphics chip|processor|GGUF|ONNX|Compatible/i)).not.toBeInTheDocument();
    // This build lists no GGUF Parakeet route, so the wizard does not offer it.
    expect(screen.queryByRole("radio", { name: /739 MB/ })).not.toBeInTheDocument();
    // Every other model this Mac can run is listed in its section, one line
    // each, without a click: what sets it apart and its size. The section
    // says "dictation only" once; no line repeats it.
    expect(screen.queryByRole("button", { name: /choose another model/i })).not.toBeInTheDocument();
    const options = screen.getAllByRole("radio");
    expect(options[0]).toHaveAccessibleName(/^recommended parakeet v3/i);
    expect(within(both).getAllByRole("radio").slice(1).map((option) => option.textContent)).toEqual([
      "Whisper Small — Mid-size download, about 100 languages489 MB",
      "Whisper Large Turbo — About 100 languages, larger download1.7 GB",
      "Distil-Whisper Large (English) — English only, large download, slower on long meetings3.0 GB",
    ]);
    expect(within(dictationOnly).getAllByRole("radio").map((option) => option.textContent)).toEqual([
      "Apple Native — Built into macOS, nothing to downloadBuilt in",
      "Whisper Base (English) — Small download, English only149 MB",
      "Whisper Small (English) — Mid-size download, English only489 MB",
    ]);
    expect(within(both).getAllByRole("radio")[0]).toBe(options[0]);
    for (const option of options) {
      expect(option).not.toHaveTextContent(/dictation only/i);
    }
    // Experimental models are in Settings, not here.
    expect(screen.queryByRole("radio", { name: /parakeet 110m|experimental/i })).not.toBeInTheDocument();
    expect(screen.getByText("670 MB")).toBeInTheDocument();
    expect(screen.queryByText(/MiB|GiB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already ships with/i)).not.toBeInTheDocument();
  });

  describe("on a Mac that can run GGUF Parakeet", () => {
    // What an Apple Silicon build lists: the transcribe.cpp provider with the
    // GGUF Parakeet route, not downloaded yet.
    const ggufProvider = unifiedProvider({
      name: "transcribe.cpp",
      selectedModelId: "parakeet-tdt-0.6b-v3-q8_0",
      modelOptions: [
        { id: "parakeet-tdt-0.6b-v3-q8_0", label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp" },
        { id: "parakeet-unified-en-0.6b-q8_0", label: "Parakeet Unified EN 0.6B Q8_0" },
      ],
      downloadStatus: "NotDownloaded",
      runtimeStatus: "missing_model",
    });
    const ggufOnDisk: AsrProviderInfo = { ...ggufProvider, downloadStatus: "Downloaded", runtimeStatus: "ready" };
    const onnxParakeet: AsrProviderInfo = {
      ...providers[1], providerType: "parakeet", name: "Parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" }],
      downloadStatus: "NotDownloaded", runtimeStatus: "missing_model",
    };
    const onnxOnDisk: AsrProviderInfo = { ...onnxParakeet, downloadStatus: "Downloaded", runtimeStatus: "ready" };

    function useFreshAppleSiliconSettings() {
      // `Settings::fresh_install` on Apple Silicon: dictation and meetings on
      // GGUF, the shared default on ONNX Parakeet.
      currentSettings.transcription.useSharedAsrSelection = false;
      currentSettings.transcription.defaultProvider = "parakeet";
      currentSettings.transcription.selectedModelId = "parakeet-tdt-0.6b-v3";
      currentSettings.transcription.dictationProvider = "transcribe_cpp";
      currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3-q8_0";
      currentSettings.transcription.meetingProvider = "transcribe_cpp";
      currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3-q8_0";
    }

    function useBeta6Settings() {
      // An install made before meetings moved: dictation on GGUF, meetings
      // and the shared default on ONNX Parakeet.
      useFreshAppleSiliconSettings();
      currentSettings.transcription.meetingProvider = "parakeet";
      currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
    }

    it("states every byte the Parakeet download fetches where the sidecar reports a different size", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      // Neural Engine v3 632,169,729 + vocabulary 102,802,576, in place of the GGUF.
      const withNeuralEngine: AsrProviderInfo = {
        ...ggufProvider,
        modelDownloadBytes: { "parakeet-tdt-0.6b-v3-q8_0": 734_972_305 },
      };
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([withNeuralEngine, onnxParakeet]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Download 735 MB and continue" })).toBeEnabled(),
      );
      const gguf = screen.getByRole("radio", { name: /^recommended parakeet v3/i });
      expect(gguf).toHaveTextContent("735 MB");
      expect(screen.queryByText(/739 MB/)).not.toBeInTheDocument();
    });

    it("recommends and downloads one GGUF Parakeet model for dictation and meetings", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxParakeet]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());

      const gguf = screen.getByRole("radio", { name: /^recommended parakeet v3/i });
      expect(gguf).toHaveAttribute("aria-checked", "true");
      expect(gguf).toHaveTextContent(/recommended/i);
      expect(gguf).toHaveTextContent("739 MB");
      expect(gguf).toHaveTextContent("Parakeet v3");
      expect(screen.getByText("One download covers dictation and meetings.")).toBeInTheDocument();
      expect(gguf).toHaveTextContent("Tested in English. Also built for 24 other European languages.");
      expect(gguf).not.toHaveTextContent(/multilingual|upstream/i);
      // How the model schedules work is not a reason to choose it.
      expect(gguf).not.toHaveTextContent(/one recording at a time/i);
      expect(gguf).not.toHaveTextContent(/separate model/i);
      // Nothing on the step asks the reader to choose hardware or a format.
      expect(screen.queryByText(/graphics chip|processor|GPU|CPU|GGUF|ONNX/i)).not.toBeInTheDocument();
      expect(gguf).not.toHaveTextContent(/graphics chip|processor|GGUF|ONNX/i);
      // The ONNX build of the same model is never a second choice.
      expect(
        screen.getAllByRole("radio").filter((option) => /Parakeet v3/.test(option.textContent ?? "")),
      ).toHaveLength(1);
      expect(screen.queryByText(/Compatible|any Mac|670 MB/)).not.toBeInTheDocument();

      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith(
          "transcribe_cpp",
          "parakeet-tdt-0.6b-v3-q8_0",
        ),
      );
      await waitFor(() => expect(currentSettings.transcription.dictationProvider).toBe("transcribe_cpp"));
      expect(currentSettings.transcription.dictationModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
      // Meetings stay on the GGUF route the new install named; the shared
      // default stays the ONNX fallback.
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
      expect(currentSettings.transcription.defaultProvider).toBe("parakeet");
      expect(currentSettings.transcription.selectedModelId).toBe("parakeet-tdt-0.6b-v3");
    });

    function useOlderOnnxSettings() {
      // What serde fills an older settings file with: everything on ONNX
      // Parakeet, whether or not anyone chose it.
      currentSettings.transcription.defaultProvider = "parakeet";
      currentSettings.transcription.selectedModelId = "parakeet-tdt-0.6b-v3";
      currentSettings.transcription.dictationProvider = "parakeet";
      currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3";
    }

    it("opens on the recommended model when older settings name an ONNX Parakeet that isn't on this Mac", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxParakeet]);
      useOlderOnnxSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());

      // The recommended card is the selected one, and there is no second
      // Parakeet v3 to choose instead.
      expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i }))
        .toHaveAttribute("aria-checked", "true");
      expect(screen.queryByText(/Compatible/)).not.toBeInTheDocument();
      // Nothing is on this Mac yet, so there is no current model to keep working.
      expect(screen.queryByText(/keeps working/)).not.toBeInTheDocument();
      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith(
          "transcribe_cpp",
          "parakeet-tdt-0.6b-v3-q8_0",
        ),
      );
    });

    it("reads an ONNX Parakeet already on this Mac as Parakeet v3, and offers its faster version", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxOnDisk]);
      useOlderOnnxSettings();
      currentSettings.transcription.meetingProvider = "parakeet";
      currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i }))
          .toHaveAttribute("aria-checked", "true"),
      );
      expect(screen.queryByText(/Compatible/)).not.toBeInTheDocument();
      expect(screen.getByText(/Your current Parakeet v3 keeps working until this finishes/)).toBeInTheDocument();
      // Nothing downloads until the reader presses the button.
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith(
          "transcribe_cpp",
          "parakeet-tdt-0.6b-v3-q8_0",
        ),
      );
      // Both lanes that used the ONNX build move to the faster one.
      await waitFor(() => expect(currentSettings.transcription.dictationProvider).toBe("transcribe_cpp"));
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
      expect(currentSettings.transcription.defaultProvider).toBe("parakeet");
    });

    it("moves a new install's meetings to the meeting-capable model chosen instead", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxParakeet, providers[3]]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
      fireEvent.click(screen.getByRole("radio", { name: /^whisper small(?! \()/i }));
      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith("whisper", "small"),
      );
      await waitFor(() => expect(currentSettings.transcription.dictationProvider).toBe("whisper"));
      // The GGUF model is not on this Mac, so a reader who skips meeting
      // setup can still record meetings with the model just downloaded.
      expect(currentSettings.transcription.meetingProvider).toBe("whisper");
      expect(currentSettings.transcription.meetingModelId).toBe("small");
      expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    });

    it("leaves a new install's meetings on GGUF when the chosen model is for dictation only", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      const whisper: AsrProviderInfo = {
        ...providers[1], providerType: "whisper", name: "Whisper",
        selectedModelId: "base.en",
        modelOptions: [{ id: "base.en", label: "Base English" }],
      };
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxParakeet, whisper]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
      fireEvent.click(screen.getByRole("radio", { name: /^whisper base \(english\)/i }));
      expect(screen.getByRole("radio", { name: /^whisper base \(english\)/i }))
        .toHaveTextContent("Small download, English only");
      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() => expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en"));
      await waitFor(() => expect(currentSettings.transcription.dictationProvider).toBe("whisper"));
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
    });

    it("keeps meetings on a GGUF model already on disk when dictation moves to another model", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufOnDisk, onnxParakeet, providers[3]]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("radio", { name: /^whisper small(?! \()/i })).toBeEnabled());
      fireEvent.click(screen.getByRole("radio", { name: /^whisper small(?! \()/i }));
      await clickPrimary(/^download.* and continue$/i);
      await waitFor(() => expect(currentSettings.transcription.dictationProvider).toBe("whisper"));
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
    });

    it("calls meetings ready on the GGUF model already on disk, with no ONNX download", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufOnDisk, onnxParakeet]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      expect(await screen.findByText("Ready. Meetings are transcribed on this Mac.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/670 MB/)).not.toBeInTheDocument();
      await clickPrimary(/continue/i);
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
    });

    it("offers the GGUF model a beta.6 install dictates with instead of an ONNX download", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufOnDisk, onnxParakeet]);
      useBeta6Settings();
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      expect(await screen.findByText(/recommended model is already on this Mac\. It is the one you dictate with/i))
        .toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
      await clickPrimary(/continue/i);
      await waitFor(() => expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp"));
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    });

    it("keeps a beta.6 install's ready ONNX meeting route", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufOnDisk, onnxOnDisk]);
      useBeta6Settings();
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      expect(await screen.findByText("Ready. Meetings are transcribed on this Mac.")).toBeInTheDocument();
      await clickPrimary(/continue/i);
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
      expect(currentSettings.transcription.meetingProvider).toBe("parakeet");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3");
    });

    it("downloads GGUF Parakeet, not ONNX, when meeting setup finds neither on disk", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([ggufProvider, onnxParakeet]);
      useFreshAppleSiliconSettings();
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      expect(await screen.findByText(/^not downloaded yet/i)).toBeInTheDocument();
      await clickPrimary(/download meeting model \(739 MB\)/i);
      await waitFor(() =>
        expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"),
      );
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalledWith("parakeet", expect.anything());
      expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
      expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
    });

    describe("a dictation-only model with a meetings model beside it", () => {
      const GGUF_ID = "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0";
      const whisperModels: AsrProviderInfo = {
        ...providers[3],
        modelOptions: [
          { id: "tiny", label: "tiny" },
          { id: "base.en", label: "base.en" },
          { id: "small", label: "small" },
        ],
      };
      const FILES: Record<string, { name: string; provider: string; path: string; sizeBytes: number }> = {
        "whisper:tiny": { name: "ggml-tiny.bin", provider: "whisper", path: "/m/whisper/ggml-tiny.bin", sizeBytes: 1 },
        "whisper:small": { name: "ggml-small.bin", provider: "whisper", path: "/m/whisper/ggml-small.bin", sizeBytes: 1 },
        [GGUF_ID]: {
          name: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
          provider: "transcribe_cpp",
          path: "/m/transcribe_cpp/parakeet-tdt-0.6b-v3-Q8_0.gguf",
          sizeBytes: 1,
        },
      };

      /**
       * Providers and files that follow what has been downloaded, so later
       * steps see the models the speech step fetched.
       */
      async function useModelsOnDisk(onDisk: Set<string>) {
        const asrBackend = await import("@/lib/backend/asr");
        vi.mocked(asrBackend.getAsrProviders).mockImplementation(async () => [
          onDisk.has(GGUF_ID) ? ggufOnDisk : ggufProvider,
          onnxParakeet,
          whisperModels,
        ]);
        vi.mocked(asrBackend.listDownloadedModels).mockImplementation(async () =>
          [...onDisk].map((routeId) => FILES[routeId]).filter(Boolean),
        );
        vi.mocked(asrBackend.downloadAsrModels).mockImplementation(async (providerType, modelId) => {
          onDisk.add(`${providerType}:${modelId}`);
        });
        return asrBackend;
      }

      async function restoreDownloads() {
        const asrBackend = await import("@/lib/backend/asr");
        vi.mocked(asrBackend.downloadAsrModels).mockImplementation(async () => {});
      }

      async function openOnTiny() {
        render(<FirstRunWizard onComplete={vi.fn()} />);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled(),
        );
        await chooseModel(/^whisper tiny/i);
      }

      it("lists Whisper Tiny as dictation only and offers the recommended meetings model under the list", async () => {
        await useModelsOnDisk(new Set());
        useFreshAppleSiliconSettings();
        render(<FirstRunWizard onComplete={vi.fn()} />);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Download 739 MB and continue" })).toBeEnabled(),
        );
        // Recommended: one download covers both, and there is no meetings picker.
        expect(screen.getByText("One download covers dictation and meetings.")).toBeInTheDocument();
        expect(screen.queryByLabelText("Meetings will use")).not.toBeInTheDocument();
        expect(within(screen.getByRole("group", { name: "Dictation only" })).getByRole("radio", { name: /^whisper tiny/i }))
          .toBeInTheDocument();

        await chooseModel(/^whisper tiny/i);
        const picker = screen.getByLabelText("Meetings will use");
        expect(picker).toHaveValue(GGUF_ID);
        expect(picker).toHaveAccessibleDescription(
          "Whisper Tiny is for dictation only. Meetings need a model of their own.",
        );
        // Every meeting-capable model, then "later"; nothing dictation-only.
        expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
          "Parakeet v3 — recommended, 739 MB",
          "Whisper Small — 489 MB",
          "Set up meetings later",
        ]);
        expect(
          screen.getByText("Whisper Tiny is for dictation only. Choose a model for meetings below the list."),
        ).toHaveAttribute("role", "status");
        expect(screen.queryByText("One download covers dictation and meetings.")).not.toBeInTheDocument();
        // The button counts both downloads.
        expect(screen.getByRole("button", { name: "Download 79 MB + 739 MB and continue" })).toBeEnabled();

        // Back to a model that covers both: the picker goes away again.
        await chooseModel(/^whisper small/i);
        expect(screen.queryByLabelText("Meetings will use")).not.toBeInTheDocument();
        expect(screen.getByText("One download covers dictation and meetings.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Download 489 MB and continue" })).toBeEnabled();
        expect(
          screen.queryByText("Whisper Tiny is for dictation only. Choose a model for meetings below the list."),
        ).not.toBeInTheDocument();
      });

      it("downloads both models with one click and saves each lane, then shows the meetings model in meeting setup", async () => {
        const onDisk = new Set<string>();
        const asrBackend = await useModelsOnDisk(onDisk);
        useFreshAppleSiliconSettings();
        currentSettings.transcription.useSharedAsrSelection = true;
        try {
          await openOnTiny();
          // Nothing downloads on a selection.
          expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
          await clickPrimary(/^download 79 MB \+ 739 MB and continue$/i);
          await passMicrophoneStep();
          expect(vi.mocked(asrBackend.downloadAsrModels).mock.calls).toEqual([
            ["whisper", "tiny"],
            ["transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"],
          ]);
          expect(currentSettings.transcription).toMatchObject({
            useSharedAsrSelection: false,
            dictationProvider: "whisper",
            dictationModelId: "tiny",
            meetingProvider: "transcribe_cpp",
            meetingModelId: "parakeet-tdt-0.6b-v3-q8_0",
          });

          await clickPrimary(/^continue$/i);
          await clickPrimary(/^set up meetings$/i);
          expect(await screen.findByRole("heading", { name: /meeting setup/i })).toBeInTheDocument();
          expect(await screen.findByText("Ready. Meetings are transcribed on this Mac.")).toBeInTheDocument();
          expect(screen.getByLabelText("Meetings use")).toHaveValue(GGUF_ID);
          expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
        } finally {
          await restoreDownloads();
        }
      });

      it("downloads only the dictation model when meetings are set up later, and offers meetings again in meeting setup", async () => {
        const onDisk = new Set<string>();
        const asrBackend = await useModelsOnDisk(onDisk);
        useFreshAppleSiliconSettings();
        try {
          await openOnTiny();
          fireEvent.change(screen.getByLabelText("Meetings will use"), { target: { value: "later" } });
          expect(screen.getByText(/Dictation works without it\. Meeting setup, a few steps on, offers a meetings model again/))
            .toBeInTheDocument();
          await clickPrimary(/^download 79 MB and continue$/i);
          await passMicrophoneStep();
          expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith("whisper", "tiny");
          // Meetings still name the recommended model, not downloaded yet.
          expect(currentSettings.transcription.meetingProvider).toBe("transcribe_cpp");
          expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");

          await clickPrimary(/^continue$/i);
          await clickPrimary(/^set up meetings$/i);
          expect(await screen.findByText(/^not downloaded yet\./i)).toHaveTextContent("one-time 739 MB download");
          const picker = screen.getByLabelText("Meetings use");
          expect(picker).toHaveValue(GGUF_ID);
          // The reader can pick another meetings model here instead.
          fireEvent.change(picker, { target: { value: "whisper:small" } });
          expect(await screen.findByText(/^not downloaded yet\./i)).toHaveTextContent("one-time 489 MB download");
          await clickPrimary(/^download meeting model \(489 MB\)$/i);
          await waitFor(() =>
            expect(asrBackend.downloadAsrModels).toHaveBeenLastCalledWith("whisper", "small"),
          );
          await waitFor(() => expect(currentSettings.transcription.meetingModelId).toBe("small"));
          expect(currentSettings.transcription.meetingProvider).toBe("whisper");
          expect(currentSettings.transcription.dictationModelId).toBe("tiny");
          expect(asrBackend.downloadAsrModels).not.toHaveBeenCalledWith(
            "transcribe_cpp",
            "parakeet-tdt-0.6b-v3-q8_0",
          );
        } finally {
          await restoreDownloads();
        }
      });

      it("offers a meetings model already on this Mac first, and counts only the dictation download", async () => {
        const asrBackend = await useModelsOnDisk(new Set(["whisper:small"]));
        useFreshAppleSiliconSettings();
        try {
          await openOnTiny();
          const picker = screen.getByLabelText("Meetings will use");
          expect(picker).toHaveValue("whisper:small");
          expect(within(picker).getByRole("option", { name: "Whisper Small — on this Mac" })).toBeInTheDocument();
          expect(screen.getByRole("button", { name: "Download 79 MB and continue" })).toBeEnabled();
          // Switching to the recommended one adds its size to the button.
          fireEvent.change(picker, { target: { value: GGUF_ID } });
          expect(screen.getByRole("button", { name: "Download 79 MB + 739 MB and continue" })).toBeEnabled();
          fireEvent.change(picker, { target: { value: "whisper:small" } });
          await clickPrimary(/^download 79 MB and continue$/i);
          await passMicrophoneStep();
          expect(asrBackend.downloadAsrModels).toHaveBeenCalledExactlyOnceWith("whisper", "tiny");
          expect(currentSettings.transcription).toMatchObject({
            useSharedAsrSelection: false,
            dictationProvider: "whisper",
            dictationModelId: "tiny",
            meetingProvider: "whisper",
            meetingModelId: "small",
          });
        } finally {
          await restoreDownloads();
        }
      });

      it("keeps the dictation model and stays on the step when the meetings download fails", async () => {
        const asrBackend = await useModelsOnDisk(new Set());
        useFreshAppleSiliconSettings();
        vi.mocked(asrBackend.downloadAsrModels).mockImplementation(async (providerType) => {
          if (providerType === "transcribe_cpp") throw new Error("network went away");
        });
        try {
          await openOnTiny();
          await clickPrimary(/^download 79 MB \+ 739 MB and continue$/i);
          expect(await screen.findByRole("alert")).toHaveTextContent(
            "Parakeet v3 didn't download. network went away. Or choose Set up meetings later.",
          );
          expect(screen.getByRole("heading", { name: /^speech model$/i })).toBeInTheDocument();
          expect(currentSettings.transcription.dictationModelId).toBe("tiny");
          expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3-q8_0");
          expect(screen.getByRole("button", { name: "Retry download" })).toBeEnabled();
          // Deferring meetings lets the reader continue with dictation alone.
          fireEvent.change(screen.getByLabelText("Meetings will use"), { target: { value: "later" } });
          await clickPrimary(/^continue$/i);
          expect(await screen.findByRole("heading", { name: /microphone check/i })).toBeInTheDocument();
          expect(asrBackend.downloadAsrModels).toHaveBeenCalledTimes(2);
        } finally {
          await restoreDownloads();
        }
      });
    });

    it("leaves GGUF Parakeet out where the build cannot run it", async () => {
      const asrBackend = await import("@/lib/backend/asr");
      vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([
        { ...ggufProvider, inferenceEnabled: false },
        onnxParakeet,
      ]);
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
      // One Parakeet card, the ONNX one, recommended and named plainly.
      expect(screen.queryByRole("radio", { name: /parakeet v3 compatible/i })).not.toBeInTheDocument();
      expect(screen.queryByText("739 MB")).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i }))
        .toHaveTextContent("670 MB");
    });
  });

  it.each([
    ["whisper", "base.en", /^whisper base \(english\)/i],
    ["whisper", "small", /^whisper small(?! \()/i],
    ["whisper", "large-v3-turbo", /^whisper large turbo/i],
  ] as const)("downloads the explicit onboarding choice %s/%s", async (provider, modelId, label) => {
    const asrBackend = await import("@/lib/backend/asr");
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByRole("heading", { name: /^speech model$/i });
    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: label }));
    await clickPrimary(/^download.* and continue$/i);
    await waitFor(() => expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith(provider, modelId));
  });

  it.each([
    ["whisper", "base.en", /^whisper base \(english\)/i],
    ["whisper", "small", /^whisper small(?! \()/i],
    ["whisper", "large-v3-turbo", /^whisper large turbo/i],
  ] as const)("restores the exact onboarding choice %s/%s on reopen", async (provider, modelId, label) => {
    currentSettings.transcription.dictationProvider = provider;
    currentSettings.transcription.dictationModelId = modelId;
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByText("Current model")).not.toBeInTheDocument();
  });

  it.each([false, true])("checks exact unselected meeting-model readiness, installed=%s", async (installed) => {
    const asrBackend = await import("@/lib/backend/asr");
    const whisper: AsrProviderInfo = {
      ...providers[1], providerType: "whisper", name: "Whisper",
      selectedModelId: "base.en",
      modelOptions: [{ id: "base.en", label: "Base English" }, { id: "large-v3-turbo", label: "Large Turbo" }],
    };
    const parakeet: AsrProviderInfo = {
      ...providers[1], providerType: "parakeet", name: "Parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" }],
      downloadStatus: "NotDownloaded", runtimeStatus: "missing_model",
    };
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([whisper, parakeet]);
    vi.mocked(invoke).mockResolvedValue({
      providerType: "whisper", selectedModelId: "large-v3-turbo",
      runtimeStatus: installed ? "ready" : "missing_model", runtimeDetails: {}, runtimeMessage: null,
    });
    currentSettings.transcription.meetingProvider = "parakeet";
    currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_asr_runtime_diagnostics", {
      providerType: "whisper", modelId: "large-v3-turbo",
    }));
    if (installed) {
      expect(await screen.findByText(/recommended model is already on this Mac/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
      await clickPrimary(/continue/i);
      expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
      expect(currentSettings.transcription.meetingModelId).toBe("large-v3-turbo");
    } else {
      expect(await screen.findByText(/^not downloaded yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/recommended model is already on this Mac/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download meeting model (670 MB)" })).toBeInTheDocument();
      await clickPrimary(/download meeting model/i);
      await waitFor(() => expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("parakeet", "parakeet-tdt-0.6b-v3"));
    }
  });

  it("keeps a ready configured Parakeet route without checking unrelated Whisper variants", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const parakeet: AsrProviderInfo = {
      ...providers[1], providerType: "parakeet", name: "Parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" }],
    };
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([parakeet, {
      ...providers[1], providerType: "whisper", selectedModelId: "base.en",
      modelOptions: [{ id: "base.en", label: "Base English" }, { id: "large-v3-turbo", label: "Large Turbo" }],
    }]);
    vi.mocked(invoke).mockRejectedValue(new Error("Unrelated Whisper diagnostics unavailable"));
    currentSettings.transcription.meetingProvider = "parakeet";
    currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
    expect(await screen.findByText("Ready. Meetings are transcribed on this Mac.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
    await clickPrimary(/continue/i);
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.meetingModelId).toBe("parakeet-tdt-0.6b-v3");
  });

  it("keeps unknown exact meeting-model readiness out of download claims", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([{
      ...providers[1], providerType: "whisper", selectedModelId: "base.en",
      modelOptions: [{ id: "base.en", label: "Base English" }, { id: "large-v3-turbo", label: "Large Turbo" }],
    }]);
    vi.mocked(invoke).mockRejectedValue(new Error("Model check unavailable"));
    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Check meeting setup again" });
    expect(screen.queryByText(/recommended model is already on this Mac/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download meeting model/i })).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
  });

  it("says a saved model this build can't run is unavailable, without changing the saved selection", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const settingsBackend = await import("@/lib/backend/settings");
    currentSettings.transcription.dictationProvider = "whistle";
    currentSettings.transcription.dictationModelId = "whistle-2.0.0";
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([...providers, {
      ...providers[1], providerType: "whistle", name: "Cactus Whistle",
      selectedModelId: "whistle-2.0.0", inferenceEnabled: false, isAvailable: false,
      downloadStatus: "NotDownloaded", runtimeStatus: "missing_model",
      modelOptions: [{ id: "whistle-2.0.0", label: "Whistle 2.0" }],
    }]);
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    expect(screen.getByText(/your previous speech model is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /cactus whistle/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i })).toHaveAttribute("aria-checked", "true");
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    expect(settingsBackend.updateSettings).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationProvider).toBe("whistle");
  });

  it("leaves experimental models for Settings rather than the first-run list", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue([...providers, {
      ...providers[1], providerType: "whistle", name: "Cactus Whistle",
      selectedModelId: "whistle-2.0.0", inferenceEnabled: true, isAvailable: false,
      downloadStatus: "NotDownloaded", runtimeStatus: "missing_model",
      modelOptions: [{ id: "whistle-2.0.0", label: "Whistle 2.0" }],
    }]);
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    expect(screen.queryByRole("radio", { name: /cactus whistle|parakeet 110m/i })).not.toBeInTheDocument();
  });

  it("preserves an existing ready Distil route without offering a new large download", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    currentSettings.transcription.dictationProvider = "distil_whisper";
    currentSettings.transcription.dictationModelId = "distil-large-v3.5";
    render(<FirstRunWizard onComplete={vi.fn()} />);
    // Distil-Whisper is one of the models the step lists, so it is simply the
    // selected one, already downloaded.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^distil-whisper large/i })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByText("Current model")).not.toBeInTheDocument();
    expect(await screen.findByText(/is on this Mac and ready\./)).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    expect(await screen.findByRole("heading", { name: /microphone check/i })).toBeInTheDocument();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationModelId).toBe("distil-large-v3.5");
  });

  it("waits for the persisted model selection before starting a download", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const providerDiscovery = deferred<AsrProviderInfo[]>();
    vi.mocked(asrBackend.getAsrProviders).mockImplementationOnce(
      () => providerDiscovery.promise,
    );
    currentSettings.transcription.dictationProvider = "parakeet";
    currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    const downloadButton = screen.getByRole("button", {
      name: /^download.* and continue$/i,
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(downloadButton);
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();

    await act(async () => {
      providerDiscovery.resolve(providers);
    });

    await waitFor(() => expect(downloadButton).toBeEnabled());
    fireEvent.click(downloadButton);
    await waitFor(() => {
      expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-0.6b-v3",
      );
    });
  });

  it("keeps model download disabled when settings hydration fails", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const settingsBackend = await import("@/lib/backend/settings");
    vi.mocked(settingsBackend.getSettings).mockRejectedValueOnce(
      new Error("settings unavailable"),
    );

    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(
      await screen.findByRole("alert", { name: /model setup unavailable/i }),
    ).toBeInTheDocument();
    const downloadButton = screen.getByRole("button", {
      name: /^download.* and continue$/i,
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(downloadButton);
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
  });

  it("keeps model download disabled when provider hydration fails", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockRejectedValueOnce(
      new Error("providers unavailable"),
    );

    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(
      await screen.findByRole("alert", { name: /model setup unavailable/i }),
    ).toBeInTheDocument();
    const downloadButton = screen.getByRole("button", {
      name: /^download.* and continue$/i,
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(downloadButton);
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
  });

  it("rechecks failed settings in place without downloading or saving", async () => {
    const settingsBackend = await import("@/lib/backend/settings");
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(settingsBackend.getSettings).mockRejectedValueOnce(new Error("startup waiting"));
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByRole("alert", { name: /model setup unavailable/i });

    fireEvent.click(screen.getByRole("button", { name: /check model setup again/i }));

    await waitFor(() => expect(screen.queryByRole("alert", { name: /model setup unavailable/i })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled();
    expect(settingsBackend.getSettings).toHaveBeenCalledTimes(2);
    expect(settingsBackend.updateSettings).not.toHaveBeenCalled();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
  });

  it("keeps downloads gated during a retry and preserves the reader's model choice", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const discovery = deferred<AsrProviderInfo[]>();
    currentSettings.transcription.dictationProvider = "transcribe_cpp";
    currentSettings.transcription.dictationModelId =
      "parakeet-unified-en-0.6b-q8_0";
    vi.mocked(asrBackend.getAsrProviders)
      .mockRejectedValueOnce(new Error("startup waiting"))
      .mockImplementationOnce(() => discovery.promise);
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByRole("alert", { name: /model setup unavailable/i });
    // Nothing to choose from, and nothing to download, until the list loads.
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /check model setup again/i }));
    expect(screen.getByText(/checking model setup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeDisabled();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();

    await act(async () => discovery.resolve([...providers, unifiedProvider()]));

    // The experimental model already in use stays the current choice.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /current model/i })).toHaveAttribute("aria-checked", "true"),
    );
    const whisper = screen.getByRole("radio", { name: /whisper base \(english\)/i });
    fireEvent.click(whisper);
    await waitFor(() => expect(screen.getByRole("button", { name: /^download.* and continue$/i })).toBeEnabled());
    expect(whisper).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Current model")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^download.* and continue$/i }));
    await waitFor(() => expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en"));
  });

  it("does not carry an installed model's readiness to a different selection", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    currentSettings.transcription.dictationProvider = "parakeet";
    currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3";
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce(
      providers.map((provider) =>
        provider.providerType === "parakeet"
          ? { ...provider, isAvailable: true, downloadStatus: "Downloaded", runtimeStatus: "ready" }
          : provider,
      ),
    );
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByText(/is on this Mac and ready\./);
    fireEvent.click(screen.getByRole("radio", { name: /whisper base \(english\)/i }));

    expect(screen.queryByText(/is on this Mac and ready\./)).not.toBeInTheDocument();
    const download = screen.getByRole("button", { name: /^download.* and continue$/i });
    expect(download).toBeEnabled();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    fireEvent.click(download);
    await waitFor(() => expect(asrBackend.downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en"));
  });

  it("hydrates meeting privacy settings when provider hydration fails", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockRejectedValueOnce(
      new Error("providers unavailable"),
    );
    currentSettings.transcription.meetingAudioStorageMode = "transcript_only";
    currentSettings.transcription.meetingRetentionPreset = "1m";

    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Meeting audio")).toHaveValue(
        "transcript_only",
      );
      expect(screen.getByLabelText("Delete old meetings")).toHaveValue("1m");
    });
  });

  it("announces each step and moves focus to the new heading", async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);

    const modelHeading = await screen.findByRole("heading", {
      name: /^speech model$/i,
    });
    await waitFor(() => expect(modelHeading).toHaveFocus());
    // The step announcement is the first live region in the dialog; a step
    // may add its own below it.
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Step 1 of 7: Speech model",
    );

    await clickPrimary(/skip model download/i);

    const micHeading = await screen.findByRole("heading", {
      name: /microphone check/i,
    });
    await waitFor(() => expect(micHeading).toHaveFocus());
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Step 2 of 7: Microphone check",
    );
  });

  it("explains that the microphone action requests all dictation permissions", async () => {
    const backend = await import("@/lib/backend/settings");
    vi.mocked(backend.getPermissionDiagnostics).mockResolvedValueOnce({
      microphoneReady: false,
      microphonePermissionReady: false,
      speechRecognitionReady: false,
      accessibilityReady: false,
      automationReady: false,
      postEventReady: false,
      notes: [],
      runningFromDiskImage: false,
    });

    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();

    expect(
      await screen.findByText(/macOS may ask for Microphone.*then Accessibility/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /request dictation permissions/i }),
    );

    await waitFor(() => {
      expect(backend.requestDictationPermissions).toHaveBeenCalledTimes(1);
    });
  });

  it("hides diagnostics when requesting permissions fails and permits retry", async () => {
    const backend = await import("@/lib/backend/settings");
    vi.mocked(backend.getPermissionDiagnostics).mockResolvedValueOnce({
      microphoneReady: false, microphonePermissionReady: false,
      speechRecognitionReady: false, accessibilityReady: false,
      automationReady: false, postEventReady: false, notes: [], runningFromDiskImage: false,
    });
    vi.mocked(backend.requestDictationPermissions).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'sidecar:invoke': Error: CoreML failed\n    at check (/Users/test/permissions.ts:12:3)",
    ));
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    fireEvent.click(screen.getByRole("button", { name: /request dictation permissions/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check permissions. Try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/CoreML|\/Users|sidecar/);
    const retry = screen.getByRole("button", { name: /request dictation permissions/i });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByText("Asked macOS for permission and checked again.")).toBeInTheDocument();
  });

  it("shows the practice result without saving it to Inbox or delivering it", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const startDictation = vi.mocked(dictationBackend.startDictation);
    const stopDictation = vi.mocked(dictationBackend.stopDictation);

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/^download.* and continue$/i);
    await passMicrophoneStep();
    await screen.findByRole("heading", { name: /try dictation here/i });
    fireEvent.click(
      screen.getByRole("button", { name: /start a test/i })
    );
    await waitFor(() => {
      expect(startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryMode: "preview",
          saveToInbox: false,
          projectId: "inbox",
        })
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: /finish and transcribe/i })
    );

    await waitFor(() => {
      expect(stopDictation).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText("This is my first Plainsong dictation.")
    ).toBeInTheDocument();
    expect(screen.getByText(/6 words, written on this Mac/i)).toBeInTheDocument();

    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();
    expect(
      await screen.findByText("Ready, and your test dictation worked."),
    ).toBeInTheDocument();
  });

  function emitPracticeEvent(event: string, payload: unknown) {
    const subscriptions = vi.mocked(listen).mock.calls.filter(([name]) => name === event);
    act(() => {
      for (const [, handler] of subscriptions) {
        handler({ event, payload, id: 1 });
      }
    });
  }

  async function beginPractice() {
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/^download.* and continue$/i);
    await passMicrophoneStep();
    fireEvent.click(await screen.findByRole("button", { name: /start a test/i }));
    await screen.findByRole("button", { name: /finish and transcribe/i });
    emitPracticeEvent("dictation-state-changed", { phase: "preparing", sessionId: 41 });
    emitPracticeEvent("dictation-state-changed", { phase: "recording", sessionId: 41 });
  }

  it("finishes practice after an external stop and ignores unrelated session results", async () => {
    await beginPractice();
    emitPracticeEvent("dictation-text-ready", { sessionId: 40, text: "Old private text" });
    emitPracticeEvent("dictation-state-changed", { sessionId: 42, phase: "error", message: "Other session" });
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();
    expect(screen.queryByText("Old private text")).not.toBeInTheDocument();
    emitPracticeEvent("dictation-state-changed", { sessionId: 41, phase: "transcribing" });
    expect(screen.queryByRole("button", { name: /finish and transcribe/i })).not.toBeInTheDocument();
    emitPracticeEvent("dictation-text-ready", { sessionId: 41, text: "The external stop worked." });
    emitPracticeEvent("dictation-state-changed", { sessionId: 41, phase: "done", preview: "The external stop worked." });
    expect(await screen.findByText("The external stop worked.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
    emitPracticeEvent("dictation-state-changed", { sessionId: 40, phase: "done", preview: "Old private text" });
    expect(screen.queryByText("Old private text")).not.toBeInTheDocument();
  });

  it.each([
    { phase: "error", message: "The speech model could not load." },
    { phase: "idle", outcome: "aborted", stopReason: "start-cancelled" },
  ])("unlocks practice after its external terminal $phase event", async (terminal) => {
    await beginPractice();
    emitPracticeEvent("dictation-state-changed", { sessionId: 41, ...terminal });
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      terminal.phase === "error" ? "The speech model could not load." : /cancelled/i,
    );
  });

  it("keeps an early terminal practice event when the start promise settles late", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const start = deferred<void>();
    vi.mocked(dictationBackend.startDictation).mockImplementationOnce(() => start.promise);
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/^download.* and continue$/i);
    await passMicrophoneStep();
    fireEvent.click(await screen.findByRole("button", { name: /start a test/i }));
    emitPracticeEvent("dictation-state-changed", { phase: "preparing", sessionId: 51 });
    emitPracticeEvent("dictation-state-changed", { phase: "error", sessionId: 51, message: "Model unavailable" });
    await act(async () => { start.resolve(); await start.promise; });
    expect(screen.getByRole("alert")).toHaveTextContent("Model unavailable");
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
  });

  it("ignores a previous practice stop promise and text after a retry", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const stop = deferred<string>();
    vi.mocked(dictationBackend.stopDictation).mockImplementationOnce(() => stop.promise);
    await beginPractice();
    fireEvent.click(screen.getByRole("button", { name: /finish and transcribe/i }));
    emitPracticeEvent("dictation-state-changed", { sessionId: 41, phase: "error", message: "Please retry" });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    emitPracticeEvent("dictation-state-changed", { sessionId: 42, phase: "preparing" });
    emitPracticeEvent("dictation-state-changed", { sessionId: 42, phase: "recording" });
    emitPracticeEvent("dictation-text-ready", { sessionId: 41, text: "Previous transcript" });
    await act(async () => { stop.resolve("Previous transcript"); await stop.promise; });
    expect(screen.queryByText("Previous transcript")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /finish and transcribe/i })).toBeEnabled();
  });

  it.each(["start", "finish", "runtime"] as const)(
    "explains practice memory refusal without transport internals after %s failure",
    async (failure) => {
      const dictationBackend = await import("@/lib/backend/dictation");
      const message = "Error invoking remote method 'sidecar:invoke': Error: Dictation transcription failed on NVIDIA Parakeet / parakeet-tdt-0.6b-v3: NVIDIA Parakeet failed: Not enough verified memory headroom for native inference working buffers alongside other applications.";
      if (failure === "start") {
        vi.mocked(dictationBackend.startDictation).mockRejectedValueOnce(new Error(message));
      } else if (failure === "finish") {
        vi.mocked(dictationBackend.stopDictation).mockRejectedValueOnce(new Error(message));
      }
      render(<FirstRunWizard onComplete={vi.fn()} />);
      await chooseModel(/^recommended parakeet v3/i);
      await clickPrimary(/^download.* and continue$/i);
      await passMicrophoneStep();
      fireEvent.click(await screen.findByRole("button", { name: /start a test/i }));
      if (failure !== "start") {
        await screen.findByRole("button", { name: /finish and transcribe/i });
        if (failure === "runtime") {
          emitPracticeEvent("dictation-state-changed", { phase: "preparing", sessionId: 61 });
          emitPracticeEvent("dictation-state-changed", { phase: "error", sessionId: 61, message });
        } else {
          fireEvent.click(screen.getByRole("button", { name: /finish and transcribe/i }));
        }
      }
      const error = await screen.findByRole("alert");
      expect(error).toHaveTextContent("Plainsong couldn't confirm enough free memory for local processing.");
      expect(error).not.toHaveTextContent(/sidecar:invoke|working buffers/);
      expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
      const savedShortcut = currentSettings.shortcuts.toggleDictation;
      const savedAudio = structuredClone(currentSettings.audio);
      await clickPrimary(/choose a smaller model/i);
      await screen.findByRole("heading", { name: /^speech model$/i });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Parakeet v3 needed more free memory than this Mac had just now. Pick a smaller model below, or close memory-heavy apps and try again.",
      );
      // Every smaller model is already on screen; nothing to expand.
      expect(screen.getByRole("radio", { name: /^whisper base \(english\)/i })).toBeInTheDocument();
      // Continue with the refused model still selected would loop straight
      // back into the same refusal, so the only way on is a named retry.
      expect(screen.queryByRole("button", { name: /^(continue|download.* and continue)$/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^try this model again$/i })).toBeInTheDocument();
      await chooseModel(/^whisper base \(english\)/i);
      await clickPrimary(/^download.* and continue$/i);
      await screen.findByRole("heading", { name: /try dictation here/i });
      expect(screen.getByRole("alert")).toHaveTextContent("Plainsong couldn't confirm enough free memory");
      expect(currentSettings.transcription.dictationProvider).toBe("whisper");
      expect(currentSettings.transcription.dictationModelId).toBe("base.en");
      expect(currentSettings.shortcuts.toggleDictation).toBe(savedShortcut);
      expect(currentSettings.audio).toEqual(savedAudio);
      const retry = deferred<void>();
      vi.mocked(dictationBackend.startDictation).mockReturnValueOnce(retry.promise);
      await clickPrimary(/^try again$/i);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      await act(async () => retry.resolve());
      await clickPrimary(/finish and transcribe/i);
      await screen.findByText("This is my first Plainsong dictation.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /choose a smaller model/i })).not.toBeInTheDocument();
    },
  );

  it("retries the same model only when the reader asks to after a practice memory refusal", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const asr = await import("@/lib/backend/asr");
    vi.mocked(dictationBackend.startDictation).mockRejectedValueOnce(
      new Error("Dictation transcription failed on NVIDIA Parakeet / parakeet-tdt-0.6b-v3: NVIDIA Parakeet failed: Not enough verified memory headroom for native inference working buffers alongside other applications."),
    );
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await chooseModel(/^recommended parakeet v3/i);
    await clickPrimary(/^download.* and continue$/i);
    await passMicrophoneStep();
    fireEvent.click(await screen.findByRole("button", { name: /start a test/i }));
    await screen.findByRole("alert");
    await clickPrimary(/choose a smaller model/i);
    await screen.findByRole("heading", { name: /^speech model$/i });
    expect(screen.getByRole("radio", { name: /^recommended parakeet v3/i })).toHaveAttribute("aria-checked", "true");
    await clickPrimary(/^try this model again$/i);
    await screen.findByRole("heading", { name: /try dictation here/i });
    expect(asr.downloadAsrModels).toHaveBeenCalledTimes(1);
    expect(currentSettings.transcription.dictationModelId).toBe("parakeet-tdt-0.6b-v3");
    await clickPrimary(/^try again$/i);
    await clickPrimary(/finish and transcribe/i);
    await screen.findByText("This is my first Plainsong dictation.");
  });

  it("hydrates an already-downloaded local model instead of offering it again", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers.filter((provider) => provider.providerType !== "whisper"),
      {
        providerType: "whisper",
        name: "OpenAI Whisper",
        description: "Local Whisper",
        isAvailable: true,
        inferenceEnabled: true,
        modelInfo: {
          name: "Whisper base.en",
          version: "1",
          sizeMb: 142,
          parameters: "base.en",
          languages: ["en"],
          license: "MIT",
          sourceUrl: "https://huggingface.co",
        },
        selectedModelId: "base.en",
        modelOptions: [{ id: "base.en", label: "Whisper base.en" }],
        downloadStatus: "Downloaded",
        runtimeStatus: "ready",
        runtimeDetails: {},
      },
    ]);
    currentSettings.transcription.useSharedAsrSelection = false;
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(
      await screen.findByText(/is on this Mac and ready\./)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^continue$/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^download.* and continue$/i })
    ).not.toBeInTheDocument();
  });

  it("preserves a ready Unified EN route when setup is reopened", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers,
      unifiedProvider(),
    ]);
    currentSettings.transcription.useSharedAsrSelection = false;
    currentSettings.transcription.dictationProvider = "transcribe_cpp";
    currentSettings.transcription.dictationModelId =
      "parakeet-unified-en-0.6b-q8_0";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(await screen.findByText("Current model")).toBeInTheDocument();
    // Named the way the model pickers name it, without the engine or format.
    expect(
      screen.getByText("Parakeet Unified English (experimental)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unified EN")).not.toBeInTheDocument();
    await clickPrimary(/^continue$/i);

    expect(
      await screen.findByRole("heading", { name: /microphone check/i }),
    ).toBeInTheDocument();
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationProvider).toBe(
      "transcribe_cpp",
    );
    expect(currentSettings.transcription.dictationModelId).toBe(
      "parakeet-unified-en-0.6b-q8_0",
    );
  });

  it("does not treat an unavailable existing route as ready", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const download = deferred<void>();
    vi.mocked(asrBackend.downloadAsrModels).mockImplementationOnce(
      () => download.promise,
    );
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers,
      unifiedProvider({ isAvailable: false, runtimeStatus: "error" }),
    ]);
    currentSettings.transcription.dictationProvider = "transcribe_cpp";
    currentSettings.transcription.dictationModelId =
      "parakeet-unified-en-0.6b-q8_0";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    const downloadButton = await screen.findByRole("button", {
      name: /^download.* and continue$/i,
    });
    expect(screen.queryByText("Current model")).not.toBeInTheDocument();
    fireEvent.click(downloadButton);
    expect(
      screen.getByRole("heading", { name: /^speech model$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /try dictation here/i }),
    ).not.toBeInTheDocument();
  });

  it("clears preserved readiness when the reader chooses a replacement", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers,
      unifiedProvider(),
    ]);
    currentSettings.transcription.dictationProvider = "transcribe_cpp";
    currentSettings.transcription.dictationModelId =
      "parakeet-unified-en-0.6b-q8_0";

    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByText("Current model");
    fireEvent.click(screen.getByRole("radio", { name: /whisper base \(english\)/i }));

    expect(screen.queryByText("Current model")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/is on this Mac and ready\./),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^download.* and continue$/i }),
    ).toBeEnabled();
  });

  it("keeps an honest recovery action after the user skips the model download", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={onComplete} />);

    await clickPrimary(/skip model download/i);
    expect(onComplete).not.toHaveBeenCalled();
    expect(downloadAsrModels).not.toHaveBeenCalled();

    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i }),
    ).toBeInTheDocument();
    // The fixture's meeting model is already on this Mac, so the primary
    // action only chooses it -- it does not promise a download.
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();

    expect(
      await screen.findByText(/the model download was skipped/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download speech model/i })
    ).toBeInTheDocument();

    await clickPrimary(/start using plainsong/i);
    expect(onComplete).toHaveBeenCalledWith({
      markOnboardingComplete: true,
      meetingsCompleted: true,
      deferred: false,
    });
    expect(downloadAsrModels).not.toHaveBeenCalled();
  });

  /** Skip the model, then walk every step through to the closing summary. */
  async function reachReadyAfterSkippingModel() {
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i }),
    ).toBeInTheDocument();
  }

  it("lets the reader finish on Ready while the model downloads, and keeps their model", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    const download = deferred<void>();
    downloadAsrModels.mockImplementationOnce(() => download.promise);

    // A saved Whisper Base (English) choice opens selected, so a retry has
    // to fetch that, not the Parakeet default.
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";
    const { unmount } = render(<FirstRunWizard onComplete={onComplete} />);
    await reachReadyAfterSkippingModel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download speech model/i }));
    });
    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    expect(await screen.findByText(/still downloading/i)).toBeInTheDocument();
    expect(
      screen.getByText(/the download must finish before you can try dictation/i),
    ).toBeInTheDocument();

    await clickPrimary(/start using plainsong/i);
    expect(onComplete).toHaveBeenCalledWith({
      markOnboardingComplete: true,
      meetingsCompleted: true,
      deferred: false,
    });

    // Finishing closes the wizard; the download still becomes the route.
    unmount();
    await act(async () => {
      download.resolve();
    });
    await waitFor(() => {
      expect(currentSettings.transcription.dictationProvider).toBe("whisper");
    });
    expect(currentSettings.transcription.dictationModelId).toBe("base.en");
    expect(downloadAsrModels).not.toHaveBeenCalledWith("parakeet", expect.anything());
  });

  it("does not warn about skipping a download for a model already on this Mac", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValue(
      providers.map((provider) =>
        provider.providerType === "parakeet"
          ? { ...provider, downloadStatus: "Downloaded", runtimeStatus: "ready" }
          : provider,
      ),
    );
    render(<FirstRunWizard onComplete={vi.fn()} />);
    expect(await screen.findByText(/Parakeet v3 is on this Mac and ready\./)).toBeInTheDocument();
    expect(screen.queryByText(/dictation won't work until a speech model is downloaded/)).toBeNull();
    expect(screen.queryByText("Download complete.")).toBeNull();
  });

  it("goes back to the step the reader came from, without redoing anything", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    render(<FirstRunWizard onComplete={vi.fn()} />);

    // The first step has nowhere to go back to.
    await screen.findByRole("heading", { name: /speech model/i });
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await screen.findByRole("heading", { name: /try dictation here/i });
    await clickPrimary(/^continue$/i);
    await screen.findByRole("heading", { name: /use it everywhere/i });
    // Straight to Ready, skipping meetings: Back returns here, not to the
    // meeting steps that were never shown.
    await clickPrimary(/^start dictating$/i);
    await screen.findByRole("heading", { name: /^ready$/i });

    await clickPrimary(/^back$/i);
    expect(await screen.findByRole("heading", { name: /use it everywhere/i })).toBeInTheDocument();
    await clickPrimary(/^back$/i);
    expect(await screen.findByRole("heading", { name: /try dictation here/i })).toBeInTheDocument();
    await clickPrimary(/^back$/i);
    await clickPrimary(/^back$/i);
    expect(await screen.findByRole("heading", { name: /speech model/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();
    // Going back never starts a download on its own.
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
  });

  it("lets the reader finish on Ready after a failed download", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.downloadAsrModels).mockRejectedValueOnce(
      new Error("Network unavailable"),
    );

    render(<FirstRunWizard onComplete={onComplete} />);
    await reachReadyAfterSkippingModel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download speech model/i }));
    });
    expect(
      await screen.findByText(/the model didn't download\. network unavailable\. you can also download it later/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /retry speech model download/i }),
    ).toBeInTheDocument();

    await clickPrimary(/start using plainsong/i);
    expect(onComplete).toHaveBeenCalledWith({
      markOnboardingComplete: true,
      meetingsCompleted: true,
      deferred: false,
    });
  });

  it("downloads the reader's selected model from the practice step", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    expect(
      await screen.findByRole("heading", { name: /try dictation here/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^download$/i);

    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    await waitFor(() => {
      expect(currentSettings.transcription.dictationProvider).toBe("whisper");
    });
    expect(currentSettings.transcription.dictationModelId).toBe("base.en");
  });

  it("downloads the selected model before the primary action advances", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    const download = deferred<void>();
    downloadAsrModels.mockImplementationOnce(() => download.promise);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /^download.* and continue$/i })
    );
    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    expect(
      screen.getByRole("heading", { name: /^speech model$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /downloading/i })
    ).toBeDisabled();

    await act(async () => {
      download.resolve();
    });

    expect(
      await screen.findByRole("heading", { name: /microphone check/i })
    ).toBeInTheDocument();
  });

  it("does not downgrade an already-working route when the reader moves on", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    useAppleSpeechDictation();

    render(<FirstRunWizard onComplete={vi.fn()} />);

    // Apple Speech is one of the listed models and already works, so it is
    // the selected one and the step has nothing to download.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^apple native/i })).toHaveAttribute("aria-checked", "true"),
    );
    await clickPrimary(/^continue$/i);
    await screen.findByRole("heading", { name: /microphone check/i });

    expect(downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationProvider).toBe("macos_apple_speech");
    expect(currentSettings.transcription.dictationModelId).toBe("apple-default");
  });

  it("keeps settings saved during a slow model download instead of reverting them", async () => {
    // save_settings is a whole-struct replace. Snapshotting settings before the
    // ~142 MB fetch and writing that snapshot back on completion silently
    // reverted the hotkey onboarding had just taught (and every other field
    // saved while the download ran).
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let resolveDownload: (() => void) | undefined;
    downloadAsrModels.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDownload = resolve; })
    );

    // whisper/base.en is the default route for every install that predates
    // the Parakeet default change (i.e. the entire pre-upgrade user base).
    // ensureDefaultModelDownloading treats it as a default route (alongside
    // parakeet), so this must still trigger the background fetch this test
    // exercises rather than being skipped as a "different, previously
    // configured route".
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await clickPrimary(/continue/i); // -> hotkey, kicks off the background fetch

    const shortcutInput = await screen.findByLabelText("Dictation shortcut");
    fireEvent.keyDown(shortcutInput, { key: "J", metaKey: true, shiftKey: true });
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+J");
    });

    await act(async () => {
      resolveDownload?.();
    });

    // The download completing must not roll the hotkey back to the default.
    await waitFor(() => {
      expect(currentSettings.transcription.dictationModelId).toBe("base.en");
    });
    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+J");
  });

  it("also auto-downloads for a fresh install already on the Parakeet default route", async () => {
    // Companion to the whisper-route test above: parakeet is the *current*
    // default (see settings.rs's default_provider doc), so a fresh install
    // must trigger the same background fetch, using whichever model id the
    // settings-load effect resolved (parakeet-tdt-0.6b-v3), not a
    // hardcoded string.
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let resolveDownload: (() => void) | undefined;
    downloadAsrModels.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDownload = resolve; })
    );

    currentSettings.transcription.dictationProvider = "parakeet";
    currentSettings.transcription.dictationModelId = "parakeet-tdt-0.6b-v3";

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await clickPrimary(/continue/i); // -> hotkey, kicks off the background fetch

    await waitFor(() => {
      expect(downloadAsrModels).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-0.6b-v3",
      );
    });

    await act(async () => {
      resolveDownload?.();
    });

    await waitFor(() => {
      expect(currentSettings.transcription.dictationModelId).toBe(
        "parakeet-tdt-0.6b-v3",
      );
    });
  });

  it("preserves a deliberately selected non-default Whisper model", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "small.en";

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await clickPrimary(/continue/i); // -> hotkey, preserves the existing route

    expect(downloadAsrModels).not.toHaveBeenCalled();
    expect(currentSettings.transcription.dictationProvider).toBe("whisper");
    expect(currentSettings.transcription.dictationModelId).toBe("small.en");
  });

  it("replaces a custom Whisper model when the user selects another model", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "small.en";

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i); // permissions -> dictation-model
    await chooseModel(/^recommended parakeet v3/i);
    await clickPrimary(/continue/i); // -> hotkey, downloads the selected replacement

    await waitFor(() => {
      expect(downloadAsrModels).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-0.6b-v3",
      );
      expect(currentSettings.transcription.dictationProvider).toBe("parakeet");
      expect(currentSettings.transcription.dictationModelId).toBe(
        "parakeet-tdt-0.6b-v3",
      );
    });
  });

  it("downloads base.en for a legacy Whisper route with only selectedModelId", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = undefined as never;
    currentSettings.transcription.selectedModelId = "base.en";

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);
    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);

    await waitFor(() => {
      expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    });
  });

  it("downloads base.en when a legacy Whisper route has no model id", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = undefined as never;
    currentSettings.transcription.selectedModelId = undefined as never;

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);
    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);

    await waitFor(() => {
      expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    });
  });

  it("completes full onboarding only after the explicit model download", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={onComplete} />);

    await clickPrimary(/^download.* and continue$/i);
    // The download-and-continue click kicks off an async model download
    // before the step advances; wait for that transition to actually land
    // (mirroring the explicit wait other tests in this file use for the same
    // step) instead of racing the next click against it.
    await passMicrophoneStep();
    expect(
      await screen.findByRole("heading", { name: /try dictation here/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Downloaded. Practice dictation has not been verified."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ready, and it runs on this Mac.")).not.toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(
      screen.getByText(/both ways of working stay local by default/i),
    ).toBeInTheDocument();
    await clickPrimary(/start using plainsong/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: true,
        meetingsCompleted: true,
        deferred: false,
      });
    });

    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+Space");
    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    expect(currentSettings.transcription.dictationProvider).toBe("whisper");
    expect(currentSettings.transcription.dictationModelId).toBe("base.en");
    // The wizard's hotkey step only manages the shortcut key, not the
    // interaction mode -- any existing hold-to-talk/hands-free preference
    // (set from Settings) is left untouched, not silently reset to toggle.
    expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("downloads a meeting-grade model before full onboarding advances", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const getAsrProviders = vi.mocked(asrBackend.getAsrProviders);
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let meetingModelDownloaded = false;
    // Nothing meeting-capable is on this Mac yet.
    const meetingProviders = (): AsrProviderInfo[] =>
      providersWithoutDistil().map((provider) =>
        provider.providerType === "parakeet"
          ? {
              ...provider,
              downloadStatus: meetingModelDownloaded
                ? ("Downloaded" as const)
                : ("NotDownloaded" as const),
              runtimeStatus: meetingModelDownloaded
                ? ("ready" as const)
                : ("missing_model" as const),
            }
          : provider
      );
    getAsrProviders.mockImplementation(async () => meetingProviders());
    downloadAsrModels.mockImplementation(async (providerType) => {
      if (providerType === "parakeet") {
        meetingModelDownloaded = true;
      }
    });

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i })
    ).toBeInTheDocument();

    await clickPrimary(/download meeting model/i);

    expect(downloadAsrModels).toHaveBeenCalledWith(
      "parakeet",
      "parakeet-tdt-0.6b-v3"
    );
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i })
    ).toBeInTheDocument();
    expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    expect(currentSettings.transcription.meetingProvider).toBe(
      "parakeet"
    );
    expect(currentSettings.transcription.meetingModelId).toBe(
      "parakeet-tdt-0.6b-v3"
    );
  });

  it("keeps meeting setup open and offers a retry after a failed download", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const getAsrProviders = vi.mocked(asrBackend.getAsrProviders);
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let meetingModelDownloaded = false;
    getAsrProviders.mockImplementation(async (): Promise<AsrProviderInfo[]> =>
      providersWithoutDistil().map((provider) =>
        provider.providerType === "parakeet"
          ? {
              ...provider,
              downloadStatus: meetingModelDownloaded
                ? "Downloaded"
                : "NotDownloaded",
              runtimeStatus: meetingModelDownloaded
                ? "ready"
                : "missing_model",
            }
          : provider
      )
    );
    downloadAsrModels
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockImplementationOnce(async (providerType) => {
        if (providerType === "parakeet") {
          meetingModelDownloaded = true;
        }
      });

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/download meeting model/i);

    expect(
      await screen.findByText(
        /the meeting model didn't download\. network unavailable\./i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /meeting setup/i })
    ).toBeInTheDocument();

    await clickPrimary(/retry meeting model download/i);

    expect(downloadAsrModels).toHaveBeenCalledTimes(2);
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i })
    ).toBeInTheDocument();
  });

  it("keeps a failed local model download on the model step until retry succeeds", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    const retryDownload = deferred<void>();
    downloadAsrModels
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockImplementationOnce(() => retryDownload.promise);

    currentSettings.transcription.dictationProvider = "whisper";
    currentSettings.transcription.dictationModelId = "base.en";

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/^download.* and continue$/i);

    expect(
      await screen.findByText(/the download didn't finish\. network unavailable\./i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^speech model$/i })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /retry download/i })
    );
    expect(
      screen.getByRole("button", { name: /downloading/i })
    ).toBeDisabled();

    await act(async () => {
      retryDownload.resolve();
    });

    expect(
      await screen.findByRole("heading", { name: /microphone check/i })
    ).toBeInTheDocument();
  });

  it("does not overwrite an already-configured, different dictation provider when just passing through the model step", async () => {
    const onComplete = vi.fn();
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    // A user who already has a working, non-default route set up (e.g.
    // from Settings).
    useAppleSpeechDictation();

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
    // settings-view-simple.tsx); the wizard opens on it instead of assuming
    // everyone is on toggle.
    expect(screen.getByRole("radio", { name: /hold to talk/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /press to toggle/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: false,
        deferred: false,
      });
    });

    // Re-running onboarding must not silently clobber the existing preference.
    expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("saves press-to-toggle when the reader chooses it", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    const keyboard = userEvent.setup();
    const hold = screen.getByRole("radio", { name: /hold to talk/i });
    const toggle = screen.getByRole("radio", { name: /press to toggle/i });
    hold.focus();
    await keyboard.keyboard("{ArrowRight}");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await keyboard.keyboard("{ArrowLeft}");
    expect(hold).toHaveFocus();
    expect(hold).toHaveAttribute("aria-checked", "true");
    await keyboard.keyboard("{ArrowRight}");
    // Tap to lock belongs to hold-to-talk and goes away with it.
    expect(screen.queryByLabelText(/tap to lock/i)).not.toBeInTheDocument();
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(currentSettings.transcription.dictationPushToTalk).toBe(false);
    });
    expect(currentSettings.transcription.dictationHandsFreeEnabled).toBe(false);
  });

  it("saves hold-to-talk with the reader's tap-to-lock choice", async () => {
    currentSettings.transcription.dictationPushToTalk = false;

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    fireEvent.click(screen.getByRole("radio", { name: /hold to talk/i }));
    const tapToLock = screen.getByLabelText(/^tap to lock/i);
    expect(tapToLock).toBeChecked();
    fireEvent.click(tapToLock);
    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(currentSettings.transcription.dictationPushToTalk).toBe(true);
    });
    expect(
      (currentSettings.transcription as { dictationTapToLock?: boolean })
        .dictationTapToLock,
    ).toBe(false);
  });

  it("says when hold-to-talk cannot work on this Mac yet", async () => {
    const backend = await import("@/lib/backend/settings");
    vi.mocked(backend.getDictationShortcutCapabilityStatus).mockResolvedValueOnce({
      nativeShortcutAvailable: false,
    });

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    expect(
      await screen.findByText(/hold to talk is not available on this mac right now/i),
    ).toBeInTheDocument();
  });

  it("offers hands-free only to someone who already uses it", async () => {
    currentSettings.transcription.dictationHandsFreeEnabled = true;

    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    expect(screen.getByRole("radio", { name: /hands-free/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("shows the shortcut and what was set up on the final step", async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();

    expect(
      await screen.findByRole("heading", { name: /^ready$/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Cmd + Shift + Space")).toBeInTheDocument();
    expect(screen.getByText("Hold to talk.")).toBeInTheDocument();
    expect(screen.getByText(/a quick tap locks it on/i)).toBeInTheDocument();
    expect(screen.getByText("Typing into other apps")).toBeInTheDocument();
    expect(screen.getByText(/written on this mac with ollama/i)).toBeInTheDocument();
  });

  it.each(["immediate", "never"] as const)("describes Ready history without changing %s retention", async (retention) => {
    currentSettings = createSettings(retention);
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/^skip meetings$/i);

    await screen.findByRole("heading", { name: /^ready$/i });
    expect(screen.getByText(/review and copy the latest dictation result/i)).toHaveTextContent("History follows your retention settings.");
    expect(screen.queryByText(/every dictation is also saved in history/i)).not.toBeInTheDocument();
    expect(currentSettings.transcription.dictationRetentionPreset).toBe(retention);
  });

  it("announces a shortcut save failure and retries without losing the shortcut", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");
    vi.mocked(backend.updateSettings).mockRejectedValueOnce(
      new Error("Settings file is locked")
    );

    // A working route, so passing the model step saves nothing else first.
    useAppleSpeechDictation();
    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    const shortcutInput = await screen.findByLabelText("Dictation shortcut");
    fireEvent.keyDown(shortcutInput, { key: "J", metaKey: true, shiftKey: true });
    await clickPrimary(/finish/i);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /failed to save shortcut: settings file is locked/i
    );
    expect(screen.getByLabelText("Dictation shortcut")).toHaveValue("Cmd + Shift + J");
    expect(onComplete).not.toHaveBeenCalled();

    await clickPrimary(/finish/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: false,
        deferred: false,
      });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentSettings.shortcuts.toggleDictation).toBe("Cmd+Shift+J");
  });

  it("gives a first run a plain meeting summary and keeps the diagnostics under Details", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const settingsBackend = await import("@/lib/backend/settings");
    const recordingsBackend = await import("@/lib/backend/recordings");
    // A fresh install: the recommended meeting model is not downloaded yet.
    vi.mocked(asrBackend.getAsrProviders).mockImplementation(async () => [
      providers[0],
      {
        ...providers[1],
        providerType: "parakeet",
        name: "NVIDIA Parakeet",
        selectedModelId: "parakeet-tdt-0.6b-v3",
        modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" }],
        downloadStatus: "NotDownloaded",
        runtimeStatus: "missing_model",
      },
    ]);
    currentSettings.transcription.meetingProvider = "parakeet";
    currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
    // What the sidecar actually says on a first run.
    vi.mocked(settingsBackend.verifyMeetingSetup).mockResolvedValue({
      ok: false,
      title: "Meeting verification",
      summary: "No meeting-grade route is currently ready.",
      details: [
        "Microphone: ready",
        "System audio backend: Core Audio process tap",
        "System audio native format: 48000 Hz / 2 ch",
        "A native route is available, but permission and non-silent callbacks have not been verified.",
      ],
    });
    vi.mocked(recordingsBackend.getSystemAudioCapability).mockResolvedValue({
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
      actionableReason:
        "A native route is available, but permission and non-silent callbacks have not been verified.",
    });

    try {
    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

    const modelSentence = await screen.findByText(/^not downloaded yet\./i);
    // A model nobody has downloaded yet is the normal first-run state: the
    // size is stated, and the row is not marked as a fault.
    expect(modelSentence).toHaveTextContent("one-time 670 MB download");
    expect(modelSentence.closest("li")?.querySelector(".neume-rust")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Download meeting model (670 MB)" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Microphone access is on.")).toBeInTheDocument();
    expect(
      screen.getByText(/needs your OK to record the meeting audio playing on this Mac\. macOS asks once; the check is silent\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every sound this Mac plays during the meeting, music, videos and notifications included, and it works with headphones\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow meeting audio" })).toBeInTheDocument();

    // Every sidecar line is still there for support -- once, and only inside
    // the collapsed Details disclosure.
    const details = screen.getByText("Details").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    for (const line of [
      "No meeting-grade route is currently ready.",
      "System audio backend: Core Audio process tap",
      "System audio native format: 48000 Hz / 2 ch",
    ]) {
      const node = screen.getByText(line);
      expect(details).toContainElement(node);
    }
    expect(
      screen.getAllByText(/permission and non-silent callbacks have not been verified/i),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /use recommended route/i })).not.toBeInTheDocument();
    } finally {
      // clearAllMocks keeps implementations; put the shared fixtures back.
      vi.mocked(asrBackend.getAsrProviders).mockImplementation(async () => providers);
      vi.mocked(settingsBackend.verifyMeetingSetup).mockImplementation(
        async () => getMeetingVerificationResult(),
      );
      vi.mocked(recordingsBackend.getSystemAudioCapability).mockImplementation(
        async () => ({
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
        }),
      );
    }
  });

  it("skips meetings to the Ready summary instead of closing setup", async () => {
    const onComplete = vi.fn();
    const settingsBackend = await import("@/lib/backend/settings");

    render(<FirstRunWizard onComplete={onComplete} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^set up meetings$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/^skip meetings$/i);

    // Straight past the meeting-notes step, which is only about meetings.
    expect(
      await screen.findByRole("heading", { name: /^ready$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^step 7 of 7$/i)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Cmd + Shift + Space")).toBeInTheDocument();
    expect(
      screen.getByText(/not set up, as you chose\. set them up any time from more > setup/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Meeting notes")).not.toBeInTheDocument();
    // The model was skipped too, so the shortcut card does not pretend it
    // works yet.
    expect(
      screen.getByText(/once the speech model is downloaded, put the cursor/i),
    ).toBeInTheDocument();

    await clickPrimary(/start using plainsong/i);
    expect(onComplete).toHaveBeenCalledWith({
      markOnboardingComplete: true,
      meetingsCompleted: false,
      deferred: false,
    });
    // Skipping is not finishing meeting setup: nothing is stamped.
    expect(settingsBackend.recordOnboardingState).not.toHaveBeenCalled();
  });

  it("keeps system audio unverified until the non-silent tone test passes", async () => {
    const recordingsBackend = await import("@/lib/backend/recordings");
    const getSystemAudioCapability = vi.mocked(
      recordingsBackend.getSystemAudioCapability,
    );
    const testSystemAudioCapture = vi.mocked(
      recordingsBackend.testSystemAudioCapture,
    );
    const unverifiedCapability = {
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
    } as const;
    getSystemAudioCapability
      .mockResolvedValueOnce(unverifiedCapability)
      .mockResolvedValueOnce(unverifiedCapability);

    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

    expect(
      await screen.findByText(/needs your OK to record the meeting audio/i),
    ).toBeInTheDocument();
    // Nothing is denied yet, so there is nothing to fix in System Settings.
    expect(
      screen.queryByRole("button", { name: "Open System Settings" }),
    ).not.toBeInTheDocument();
    expect(testSystemAudioCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow meeting audio" }));

    await waitFor(() => {
      expect(testSystemAudioCapture).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/working\. records all audio playing on this mac, including other apps and notification sounds, with or without headphones/i),
    ).toBeInTheDocument();
  });

  it("reports external-audio verification honestly for input-only routes", async () => {
    const recordingsBackend = await import("@/lib/backend/recordings");
    vi.mocked(recordingsBackend.testSystemAudioCapture).mockResolvedValueOnce({
      capability: {
        backend: "virtual_loopback",
        nativeOsSupported: true,
        nativeOsEnabled: true,
        routeDevice: "Stereo Mix",
        routeId: "stereo-mix",
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
      detectedToneAmplitude: 0,
      verificationMethod: "external_audio",
    });

    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /allow meeting audio|check meeting audio/i }));

    expect(
      await screen.findByText(/heard sound through stereo mix/i),
    ).toBeInTheDocument();
  });

  it("repairs the meetings route in meetings-only onboarding", async () => {
    const onComplete = vi.fn();

    render(<FirstRunWizard mode="meetings" onComplete={onComplete} />);

    await screen.findByText(/^speech model for meetings$/i);
    expect(
      await screen.findByText(/the recommended model is already on this mac/i)
    ).toBeInTheDocument();
    // The sidecar's own verdict stays available for support, under Details.
    expect(
      screen.getByText(/meetings need a meeting-grade asr route/i).closest("details"),
    ).not.toBeNull();

    // Continue chooses the model that is already here; nothing downloads.
    await clickPrimary(/^continue$/i);
    await waitFor(() => {
      expect(currentSettings.transcription.meetingProvider).toBe("distil_whisper");
    });
    await screen.findByRole("heading", { name: /meeting notes/i });
    await clickPrimary(/finish meeting setup/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: true,
        deferred: false,
      });
    });

    expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    expect(currentSettings.transcription.meetingModelId).toBe("distil-large-v3.5");
    // The stamp is durable now: it goes into settings.json through the
    // sidecar, not into a renderer localStorage every dev build shares with
    // the packaged app.
    const backend = await import("@/lib/backend/settings");
    expect(backend.recordOnboardingState).toHaveBeenCalledWith({
      event: "meetings_completed",
    });
  });

  it("finishes meeting setup when settings save but the local marker cannot be stored", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");

    currentSettings.transcription.useSharedAsrSelection = false;
    currentSettings.transcription.meetingProvider = "distil_whisper";
    currentSettings.transcription.meetingModelId = "distil-large-v3.5";
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });

    render(<FirstRunWizard mode="meetings" onComplete={onComplete} />);
    const continueButton = await screen.findByRole("button", {
      name: /^continue$/i,
    });
    await waitFor(() => expect(continueButton).toBeEnabled());
    fireEvent.click(continueButton);
    expect(
      await screen.findByRole("heading", { name: /meeting notes/i }),
    ).toBeInTheDocument();
    await clickPrimary(/finish meeting setup/i);

    await waitFor(() => {
      expect(backend.recordOnboardingState).toHaveBeenCalledWith({ event: "meetings_completed" });
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: true,
        deferred: false,
      });
    });
    expect(currentSettings.transcription).toMatchObject({
      meetingAudioStorageMode: "always",
      meetingRetentionPreset: "never",
      meetingRetentionDeleteMode: "audio_only",
    });
  });

  it("keeps meeting choices and the wizard open when saving fails, then clears the error on retry", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");
    const updateSettings = vi.mocked(backend.updateSettings);
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();

    currentSettings.transcription.useSharedAsrSelection = false;
    currentSettings.transcription.meetingProvider = "distil_whisper";
    currentSettings.transcription.meetingModelId = "distil-large-v3.5";

    updateSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async (mutate) => {
        await retrySave.promise;
        const nextSettings = structuredClone(currentSettings);
        mutate(nextSettings);
        currentSettings = nextSettings;
      });

    render(<FirstRunWizard mode="meetings" onComplete={onComplete} />);

    const finishButton = await screen.findByRole("button", {
      name: /^continue$/i,
    });
    fireEvent.change(screen.getByLabelText("Meeting audio"), {
      target: { value: "transcript_only" },
    });
    fireEvent.change(screen.getByLabelText("Delete old meetings"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Months to keep"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("What gets deleted"), {
      target: { value: "audio_and_transcript" },
    });

    fireEvent.click(finishButton);
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      firstSave.reject(new Error("Settings file is locked"));
      await firstSave.promise.catch(() => undefined);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /meeting storage and retention weren't saved: settings file is locked/i
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Meeting audio")).toHaveValue("transcript_only");
    expect(screen.getByLabelText("Delete old meetings")).toHaveValue("custom");
    expect(screen.getByLabelText("Months to keep")).toHaveValue(6);
    expect(screen.getByLabelText("What gets deleted")).toHaveValue(
      "audio_and_transcript"
    );

    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Meeting audio")).toHaveValue("transcript_only");
    expect(screen.getByLabelText("Delete old meetings")).toHaveValue("custom");

    await act(async () => {
      retrySave.resolve();
      await retrySave.promise;
    });

    await clickPrimary(/finish meeting setup/i);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: true,
        deferred: false,
      });
    });
    expect(currentSettings.transcription.meetingAudioStorageMode).toBe("transcript_only");
    expect(currentSettings.transcription.meetingRetentionPreset).toBe("custom");
    expect(currentSettings.transcription.meetingRetentionCustomMonths).toBe(6);
    expect(currentSettings.transcription.meetingRetentionDeleteMode).toBe(
      "audio_and_transcript"
    );
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
        deferred: false,
      });
    });
  });

  it("blocks advancing after Accessibility is revoked despite a prior insertion", async () => {
    const backend = await import("@/lib/backend/settings");
    const diagnostics = vi.mocked(backend.getPermissionDiagnostics);
    const previous = {
      microphoneReady: true, microphonePermissionReady: true,
      speechRecognitionReady: true, accessibilityReady: true,
      accessibilityTrusted: true, cursorInsertionObserved: true,
      automationReady: false, postEventReady: true, notes: [], runningFromDiskImage: false,
    };
    diagnostics.mockResolvedValueOnce(previous);
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);
    await waitFor(() => expect(diagnostics).toHaveBeenCalled());
    const heading = screen.getByRole("dialog").querySelector("h2")?.textContent;
    diagnostics.mockResolvedValueOnce({ ...previous, accessibilityReady: false, accessibilityTrusted: false });
    await clickPrimary(/continue/i);
    expect(await screen.findByRole("alert")).toHaveTextContent("Accessibility was turned off again");
    expect(screen.getByRole("dialog").querySelector("h2")?.textContent).toBe(heading);
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

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open macOS Speech Recognition settings for Speech Recognition",
      }),
    );

    await waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("speech");
    });
    expect(
      screen.getByText(
        "Opened macOS Speech Recognition settings. Plainsong re-checks when you come back.",
      ),
    ).toBeInTheDocument();
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

  it("reads the typing-when-paste-is-blocked gate from postEventReady and fixes it via the Accessibility pane", async () => {
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

    await screen.findByText("Typing when paste is blocked");
    // Ready via postEventReady even though the always-false automationReady
    // would otherwise show a permanent, unfixable rust gate.
    expect(
      screen.queryByRole("button", {
        name: "Open macOS Accessibility settings for Typing when paste is blocked",
      }),
    ).not.toBeInTheDocument();

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

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open macOS Accessibility settings for Typing when paste is blocked",
      }),
    );

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

    await screen.findByText("Speech Recognition");
    // Every optional row is marked, and none of them is drawn as a fault.
    expect(screen.getAllByText("Optional").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/apple speech can't transcribe/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/plainsong never switches to Apple Speech on its own/i),
    ).toBeInTheDocument();
  });

  it("downloads the model chosen in dictation repair, with real progress", async () => {
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

    // Every model is listed without a toggle; the reader picks Whisper.
    await chooseModel(/^whisper base \(english\)/i);
    const downloadButton = await screen.findByRole("button", { name: /download whisper base \(english\)/i });
    await act(async () => {
      fireEvent.click(downloadButton);
    });

    expect(progressHandler).toBeDefined();
    act(() => {
      progressHandler?.({ payload: ["whisper", 42] });
    });

    expect(await screen.findByText(/42%/)).toBeInTheDocument();

    expect(screen.getByRole("progressbar", { name: /Whisper Base \(English\)/i })).toHaveAttribute("aria-valuenow", "42");

    // Let the still-open download promise resolve so it doesn't leak into
    // later tests/act warnings.
    await act(async () => {
      resolveDownload?.();
    });
  });

  it("wraps Shift-Tab from the heading on open and after advancing", async () => {
    render(<FirstRunWizard mode="full" onComplete={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    const checkWrap = async () => {
      const heading = dialog.querySelector<HTMLElement>('h2[tabindex="-1"]');
      expect(heading).not.toBeNull();
      heading?.focus();
      await userEvent.tab({ shift: true });
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter((node) => node.tabIndex >= 0);
      expect(controls.at(-1)).toHaveFocus();
    };
    await checkWrap();
    await userEvent.click(screen.getByRole("button", { name: /skip model download/i }));
    await checkWrap();
  });

  it.each(["full", "dictation", "meetings"] as const)("names setup controls in %s mode", async (mode) => {
    render(<FirstRunWizard mode={mode} onComplete={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName();
    for (const role of ["button", "radio", "radiogroup", "combobox", "progressbar"] as const) {
      for (const control of within(dialog).queryAllByRole(role)) expect(control).toHaveAccessibleName();
    }
  });

  it("renders as an accessible modal dialog", async () => {
    render(<button type="button">Open setup</button>);
    const opener = screen.getByRole("button", { name: "Open setup" });
    opener.focus();
    const wizard = render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    opener.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    wizard.unmount();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  describe("meeting notes step", () => {
    async function openNotesStep() {
      // A meeting-grade route is already configured, so the meeting-setup step
      // offers Continue rather than a model download.
      currentSettings.transcription.useSharedAsrSelection = false;
      currentSettings.transcription.meetingProvider = "distil_whisper";
      currentSettings.transcription.meetingModelId = "distil-large-v3.5";

      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      await screen.findByText(/^speech model for meetings$/i);
      await clickPrimary(/^continue$/i);
      return screen.findByRole("heading", { name: /meeting notes/i });
    }

    it("says plainly that a missing Ollama means no notes, and how to fix it", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(false);

      await openNotesStep();

      expect(
        await screen.findByText(/ollama or the selected model is not ready/i),
      ).toBeInTheDocument();
      expect(screen.getByText("ollama.com/download")).toBeInTheDocument();
      expect(screen.getByText("ollama pull qwen3.5:4b")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /check again/i }),
      ).toBeInTheDocument();
    });

    it("does not claim Ollama is missing when the probe never answered", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockRejectedValue(new Error("no answer"));

      await openNotesStep();

      expect(
        await screen.findByText(/could not confirm ollama and the selected model/i),
      ).toBeInTheDocument();
    });

    it("does not call meeting notes ready while local completion is unknown", async () => {
      const ai = await import("@/lib/backend/ai");
      const message = "An earlier Ollama request may still be running. Local processing is paused.";
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      vi.mocked(ai.getLocalTextRuntimeHealth).mockResolvedValueOnce({ localGateApplies: true, runtimeHealth: { state: "completion_unknown", message } });
      await openNotesStep();
      expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/selected model are ready for meeting notes/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/install ollama from/i)).not.toBeInTheDocument();
      expect(screen.queryByText("ollama.com/download")).not.toBeInTheDocument();
      expect(screen.queryByText("ollama pull qwen3.5:4b")).not.toBeInTheDocument();
      expect(screen.queryByText(/notes are unavailable until/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
    });

    it.each([
      { localGateApplies: true, runtimeHealth: { state: "busy" as const, message: "Another local text operation is running. Try again after it finishes." }, message: "Another local text operation is running. Try again after it finishes." },
      { localGateApplies: false, runtimeHealth: { state: "completion_unknown" as const, message: "Local processing is paused." }, message: "The selected Ollama model runs remotely, but remote processing is disabled." },
    ])("does not offer offline setup advice for $runtimeHealth.state with applicability $localGateApplies", async ({ message, ...status }) => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      vi.mocked(ai.getLocalTextRuntimeHealth).mockResolvedValueOnce(status);
      currentSettings.privacy.remoteProcessingEnabled = false;
      await openNotesStep();
      expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
      expect(screen.getByRole("radio", { name: /use ollama for meeting notes/i })).toBeInTheDocument();
      expect(screen.getByText(/cloud models send text off this Mac and need cloud AI processing allowed/i)).toBeInTheDocument();
      expect(screen.queryByText(/nothing leaves the machine/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/install ollama from/i)).not.toBeInTheDocument();
      expect(screen.queryByText("ollama pull qwen3.5:4b")).not.toBeInTheDocument();
      expect(screen.queryByText(/notes are unavailable until/i)).not.toBeInTheDocument();
    });

    it("does not call meeting notes ready when the selected model is missing", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      vi.mocked(ai.listOllamaModels).mockResolvedValue(["qwen3.5:4b"]);
      currentSettings.privacy.meetingsAi = {
        provider: "ollama",
        modelId: "missing:latest",
      };

      await openNotesStep();

      expect(
        await screen.findByText(/ollama or the selected model is not ready/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/selected model are ready for meeting notes/i),
      ).not.toBeInTheDocument();
      expect(screen.getByText("ollama.com/download")).toBeInTheDocument();
      expect(screen.getByText("ollama pull qwen3.5:4b")).toBeInTheDocument();
    });

    it("disables automatic meeting processing for a transcripts-only choice", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(false);

      await openNotesStep();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("radio", { name: /transcripts only/i }),
        );
      });
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(storage.get(AI_NOTES_OPT_OUT_STORAGE_KEY)).toBe("true");
        expect(currentSettings.transcription.enableAutoAnalysis).toBe(false);
        expect(currentSettings.transcription.meetingAutoNameEnabled).toBe(false);
      });
    });

    it.each([
      { choice: /use ollama for meeting notes/i, provider: "ollama", modelId: "qwen3.5:4b" },
      { choice: /use my own api key/i, provider: "openai", modelId: "gpt-5.2" },
      { choice: /use the built-in text model for meeting notes/i, provider: "native_text", modelId: "native-meeting-model" },
    ])("restores automatic notes when opting back into $provider", async ({ choice, provider, modelId }) => {
      storage.set(AI_NOTES_OPT_OUT_STORAGE_KEY, "true");
      currentSettings.transcription.enableAutoAnalysis = false;
      currentSettings.transcription.meetingAutoNameEnabled = false;
      currentSettings.privacy.meetingsAi = { provider, modelId };

      await openNotesStep();
      fireEvent.click(screen.getByRole("radio", { name: choice }));
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(storage.has(AI_NOTES_OPT_OUT_STORAGE_KEY)).toBe(false);
        expect(currentSettings.transcription.enableAutoAnalysis).toBe(true);
        expect(currentSettings.transcription.meetingAutoNameEnabled).toBe(true);
        expect(currentSettings.privacy.meetingsAi).toEqual({ provider, modelId });
      });
    });

    it.each(["ollama", "openai", "native_text"])("keeps custom processing preferences for an unchanged %s notes choice", async (provider) => {
      currentSettings.transcription.enableAutoAnalysis = false;
      currentSettings.transcription.meetingAutoNameEnabled = false;
      currentSettings.privacy.meetingsAi = { provider, modelId: null };

      await openNotesStep();
      await clickPrimary(/finish meeting setup/i);

      expect(currentSettings.transcription.enableAutoAnalysis).toBe(false);
      expect(currentSettings.transcription.meetingAutoNameEnabled).toBe(false);
      expect(currentSettings.privacy.meetingsAi).toEqual({ provider, modelId: null });
    });

    it("keeps the opt-out when saving the restored backend gates fails", async () => {
      const backend = await import("@/lib/backend/settings");
      storage.set(AI_NOTES_OPT_OUT_STORAGE_KEY, "true");
      currentSettings.transcription.enableAutoAnalysis = false;
      currentSettings.transcription.meetingAutoNameEnabled = false;

      await openNotesStep();
      vi.mocked(backend.updateSettings).mockRejectedValueOnce(new Error("settings unavailable"));
      fireEvent.click(screen.getByRole("radio", { name: /use ollama for meeting notes/i }));
      await clickPrimary(/finish meeting setup/i);

      expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
      expect(storage.get(AI_NOTES_OPT_OUT_STORAGE_KEY)).toBe("true");
      expect(currentSettings.transcription.enableAutoAnalysis).toBe(false);
      expect(currentSettings.transcription.meetingAutoNameEnabled).toBe(false);
    });

    it("offers local model setup without assuming text model files are installed", async () => {
      const ai = await import("@/lib/backend/ai");
      const status = await ai.getNativeTextModelStatus();
      vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue({ ...status, ready: false });
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: "native-meeting-model" };
      currentSettings.transcription.dictationAiFormatting = false;

      await openNotesStep();

      expect(screen.getByRole("radio", { name: /use the built-in text model for meeting notes/i })).toBeInTheDocument();
      expect(screen.getByText("Download it here when you choose. Runs on this Mac without an account.")).toBeInTheDocument();
      expect(await screen.findByText(/download the built-in text model in Models/i)).toBeInTheDocument();
      expect(screen.getByText(/dictation cleanup is separate from meeting notes/i)).toHaveTextContent("Basic formatting handles punctuation and spoken corrections locally.");
      expect(screen.queryByText(/already works|nothing to install|keep your saved local meeting model/i)).not.toBeInTheDocument();
      expect(currentSettings.transcription.dictationAiFormatting).toBe(false);
    });

    it("offers the named built-in model with download and memory costs, and downloads only on click", async () => {
      const ai = await import("@/lib/backend/ai");
      const base = await ai.getNativeTextModelStatus();
      const missing = { ...base, displayName: "Qwen3 4B Instruct", ready: false, downloadBytes: 2_500_000_000, bytesOnDisk: 0, memoryRequiredBytes: 15_000_000_000 };
      vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue(missing);
      vi.mocked(ai.downloadNativeTextModel).mockImplementation(async () => {
        const ready = { ...missing, ready: true, bytesOnDisk: missing.downloadBytes };
        vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue(ready);
        return ready;
      });
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: base.modelId };
      await openNotesStep();
      const offer = await screen.findByRole("region", { name: "Built-in text model" });
      expect(within(offer).getByText("Qwen3 4B Instruct")).toBeInTheDocument();
      expect(within(offer).getByText(/2.5 GB download/)).toBeInTheDocument();
      expect(within(offer).getByText(/15.0 GB needed/)).toBeInTheDocument();
      expect(ai.downloadNativeTextModel).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(within(offer).getByRole("button", { name: "Download text model" })); });
      expect(ai.downloadNativeTextModel).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/built-in text model is ready for meeting notes/i)).toBeInTheDocument();
      expect(within(offer).getByText("Files verified.")).toBeInTheDocument();
    });

    it("includes the notes download in the meeting setup total before either download click", async () => {
      const ai = await import("@/lib/backend/ai");
      const asr = await import("@/lib/backend/asr");
      const base = await ai.getNativeTextModelStatus();
      vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue({ ...base, ready: false, downloadBytes: 2_500_000_000, bytesOnDisk: 0 });
      vi.mocked(asr.getAsrProviders).mockResolvedValue(providers.filter((provider) => provider.providerType === "parakeet"));
      vi.mocked(asr.getDiarizationModelPlan).mockResolvedValue(speakerPlan(false));
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: base.modelId };
      currentSettings.transcription.useSharedAsrSelection = false;
      currentSettings.transcription.meetingProvider = "parakeet";
      currentSettings.transcription.meetingModelId = "parakeet-tdt-0.6b-v3";
      render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);
      expect(await screen.findByText(/Meeting setup downloads 3.2 GB in all/)).toHaveTextContent(
        "Meeting setup downloads 3.2 GB in all. This step downloads 703 MB for speech and speaker labels. Meeting notes need 2.5 GB more, offered in the next step. Nothing downloads until you click a Download button.",
      );
      expect(ai.downloadNativeTextModel).not.toHaveBeenCalled();
      expect(asr.downloadAsrModels).not.toHaveBeenCalled();
      expect(asr.downloadDiarizationModel).not.toHaveBeenCalled();
    });

    it("preserves and checks the saved native notes route when reopening setup", async () => {
      const ai = await import("@/lib/backend/ai");
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: "native-meeting-model" };

      await openNotesStep();
      expect(screen.getByRole("radio", { name: /use the built-in text model for meeting notes/i })).toHaveAttribute("aria-checked", "true");
      expect(await screen.findByText(/built-in text model is ready for meeting notes/i)).toBeInTheDocument();
      expect(ai.getNativeTextModelStatus).toHaveBeenCalled();
      expect(ai.getOllamaStatus).not.toHaveBeenCalled();
      await clickPrimary(/finish meeting setup/i);

      expect(currentSettings.privacy.meetingsAi).toEqual({ provider: "native_text", modelId: "native-meeting-model" });
    });

    it.each([
      { status: { ready: false }, message: /download the built-in text model in Models/i },
      { status: { modelId: "different-native-model" }, message: /download the built-in text model in Models/i },
      { status: { canLoadNow: false }, message: /isn't enough free memory for the built-in text model/i },
      { status: { memoryAvailableBytes: null }, message: /could not confirm there is enough free memory/i },
      { status: { runtimeHealth: { state: "completion_unknown" as const, message: "Native processing is paused." } }, message: /native processing is paused/i },
      { status: { runtimePresent: false }, message: /built-in text model isn't available/i },
    ])("reports native notes readiness without Ollama setup advice for $status", async ({ status, message }) => {
      const ai = await import("@/lib/backend/ai");
      const defaultStatus = await ai.getNativeTextModelStatus();
      vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue({ ...defaultStatus, ...status });
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: "native-meeting-model" };

      await openNotesStep();
      expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
      expect(screen.queryByText(/built-in text model is ready for meeting notes/i)).not.toBeInTheDocument();
      expect(screen.queryByText("ollama.com/download")).not.toBeInTheDocument();
      expect(ai.getOllamaStatus).not.toHaveBeenCalled();
    });

    it("replaces the saved native route only when Ollama is selected", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      currentSettings.privacy.meetingsAi = { provider: "native_text", modelId: "native-meeting-model" };
      await openNotesStep();
      const keyboard = userEvent.setup();
      const native = screen.getByRole("radio", { name: /use the built-in text model for meeting notes/i });
      const ollama = screen.getByRole("radio", { name: /use ollama for meeting notes/i });
      const transcripts = screen.getByRole("radio", { name: /transcripts only/i });
      native.focus();
      await keyboard.keyboard("{ArrowUp}");
      expect(transcripts).toHaveFocus();
      expect(transcripts).toHaveAttribute("aria-checked", "true");
      await keyboard.keyboard("{ArrowDown}");
      expect(native).toHaveFocus();
      expect(native).toHaveAttribute("aria-checked", "true");
      await keyboard.keyboard("{ArrowDown}");
      expect(ollama).toHaveFocus();
      expect(ollama).toHaveAttribute("aria-checked", "true");
      expect(await screen.findByText(/ollama and the selected model are ready for meeting notes/i)).toBeInTheDocument();
      await keyboard.tab({ shift: true });
      expect(screen.getByRole("button", { name: /finish meeting setup/i })).toHaveFocus();
      await keyboard.tab();
      expect(ollama).toHaveFocus();
      await clickPrimary(/finish meeting setup/i);
      expect(currentSettings.privacy.meetingsAi).toEqual({ provider: "ollama", modelId: null });
    });

    it("offers the built-in notes model to an Ollama setup and saves it when chosen", async () => {
      const ai = await import("@/lib/backend/ai");
      currentSettings.privacy.meetingsAi = { provider: "ollama", modelId: "qwen3.5:4b" };

      await openNotesStep();
      await act(async () => {
        fireEvent.click(await screen.findByRole("radio", { name: /use the built-in text model for meeting notes/i }));
      });
      expect(await screen.findByRole("region", { name: "Built-in text model" })).toBeInTheDocument();
      expect(ai.downloadNativeTextModel).not.toHaveBeenCalled();
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(currentSettings.privacy.meetingsAi).toEqual({ provider: "native_text", modelId: null });
      });
    });

    it("does not offer the built-in notes model on a Mac that cannot run it", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getNativeTextModelStatus).mockResolvedValue({ ...nativeTextStatus(), runtimePresent: false, ready: false });

      await openNotesStep();
      expect(screen.getByRole("radio", { name: /use ollama for meeting notes/i })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /transcripts only, no automatic notes/i })).toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: /use the built-in text model/i })).not.toBeInTheDocument();
    });

    it("moves the meetings lane onto the local route without carrying a foreign model id", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      currentSettings.privacy.meetingsAi = {
        provider: "openai",
        modelId: "gpt-5.2",
      };

      await openNotesStep();
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /use ollama for meeting notes/i }));
      });
      expect(
        await screen.findByText(
          /ollama and the selected model are ready for meeting notes/i,
        ),
      ).toBeInTheDocument();
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(currentSettings.privacy.meetingsAi).toEqual({
          provider: "ollama",
          modelId: null,
        });
      });
    });

    it("opens on the configured cloud lane and points at Search & AI", async () => {
      currentSettings.privacy.meetingsAi = {
        provider: "anthropic",
        modelId: null,
      };

      await openNotesStep();

      expect(
        await screen.findByText(/currently set to anthropic/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /open search & ai settings/i }),
      ).toBeInTheDocument();
    });
  });
  it("saves the native shortcut preset and explicit double-tap choice", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);
    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    fireEvent.click(screen.getByRole("button", { name: "Right Command" }));
    fireEvent.click(screen.getByRole("radio", { name: /hold to talk/i }));
    fireEvent.click(screen.getByLabelText(/^double-tap to lock/i));
    await clickPrimary(/finish/i);
    await waitFor(() => expect(currentSettings.transcription).toMatchObject({ dictationDoubleTapToLock: true }));
    expect(currentSettings.shortcuts.toggleDictation.toLowerCase()).toBe("rightcommand");
    expect(currentSettings.transcription).toMatchObject({ dictationTapToLock: true });
  });

});

/**
 * An open wizard sitting on the speech model step is what the packaged idle
 * CPU check measures, so once it has loaded it must not keep asking the
 * backend for anything, keep a timer alive, or animate under the pointer.
 */
describe("FirstRunWizard at rest", () => {
  beforeEach(async () => {
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
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockReset().mockResolvedValue(providers);
    vi.mocked(asrBackend.getDiarizationModelPlan).mockReset().mockResolvedValue(speakerPlan(true));
    vi.mocked(invoke).mockReset();
  });

  /** Every backend call the wizard can make, counted together. */
  async function backendCallCount(): Promise<number> {
    const modules = await Promise.all([
      import("@/lib/backend/asr"),
      import("@/lib/backend/ai"),
      import("@/lib/backend/dictation"),
      import("@/lib/backend/recordings"),
      import("@/lib/backend/calendar"),
      import("@/lib/backend/settings"),
    ]);
    const fns = modules.flatMap((module) =>
      Object.values(module).filter((value) => vi.isMockFunction(value)),
    );
    return [...fns, vi.mocked(invoke), vi.mocked(listen)].reduce(
      (total, fn) => total + fn.mock.calls.length,
      0,
    );
  }

  it("makes no further backend calls and leaves no timer running once the speech model step has loaded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<FirstRunWizard onComplete={vi.fn()} />);
      expect(
        await screen.findByRole("radio", { name: /^recommended parakeet v3/i }),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const settled = await backendCallCount();
      expect(settled).toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(await backendCallCount()).toBe(settled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes the speech model options' colours on hover without a transition", async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await screen.findByRole("radio", { name: /^recommended parakeet v3/i });

    const options = within(screen.getByRole("radiogroup", { name: "Speech model" })).getAllByRole(
      "radio",
    );
    expect(options.length).toBeGreaterThan(1);
    for (const option of options) {
      expect(option.className).not.toMatch(/(^|\s)transition/);
    }
  });
});
