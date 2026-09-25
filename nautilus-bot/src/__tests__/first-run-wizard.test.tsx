import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dictationShortcutConflictMessage,
  FirstRunWizard,
} from "@/components/first-run-wizard";
import { AI_NOTES_OPT_OUT_STORAGE_KEY } from "@/lib/ai-notes-preference";
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
  const ready = provider === "distil_whisper" || provider === "parakeet";

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

vi.mock("@/lib/backend/ai", () => ({
  getOllamaStatus: vi.fn(async () => true),
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
  saveSettings: vi.fn(async (nextSettings) => {
    currentSettings = structuredClone(nextSettings);
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

  it("opens full onboarding with an explicit model download step", async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: /dictation model/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/^step 1 of 7$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download and continue/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/one-time download/i)).toBeInTheDocument();
    // Sizes are converted to the decimal MB/GB Finder uses, not relabelled:
    // the capability table's 2888 MiB is 3.03 GB and 639 MiB is 670 MB.
    expect(screen.getByText("3.0 GB")).toBeInTheDocument();
    expect(screen.getByText("670 MB")).toBeInTheDocument();
    expect(screen.queryByText(/MiB|GiB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already ships with/i)).not.toBeInTheDocument();
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
      name: /download and continue/i,
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
      name: /download and continue/i,
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
      name: /download and continue/i,
    });
    expect(downloadButton).toBeDisabled();
    fireEvent.click(downloadButton);
    expect(asrBackend.downloadAsrModels).not.toHaveBeenCalled();
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
      name: /dictation model/i,
    });
    await waitFor(() => expect(modelHeading).toHaveFocus());
    // The step announcement is the first live region in the dialog; a step
    // may add its own below it.
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Step 1 of 7: Dictation model",
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

  it("runs the first dictation inside Plainsong without system delivery", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const startDictation = vi.mocked(dictationBackend.startDictation);
    const stopDictation = vi.mocked(dictationBackend.stopDictation);

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/download and continue/i);
    await passMicrophoneStep();
    await screen.findByRole("heading", { name: /try dictation here/i });
    fireEvent.click(
      screen.getByRole("button", { name: /start a test/i })
    );
    await waitFor(() => {
      expect(startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryMode: "preview",
          saveToInbox: true,
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
  });

  it("hydrates an already-downloaded local model instead of offering it again", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    vi.mocked(asrBackend.getAsrProviders).mockResolvedValueOnce([
      ...providers,
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
      await screen.findByText(/downloaded and ready to use/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^continue$/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /download and continue/i })
    ).not.toBeInTheDocument();
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
    await clickPrimary(/^continue$/i);
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
    await clickPrimary(/^continue$/i);
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

    // Apple Speech has no row on the model step, so it opens on base.en; a
    // retry has to fetch that, not the Parakeet default.
    const { unmount } = render(<FirstRunWizard onComplete={onComplete} />);
    await reachReadyAfterSkippingModel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download speech model/i }));
    });
    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    expect(await screen.findByText(/still downloading/i)).toBeInTheDocument();

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
      await screen.findByText(/model download failed: network unavailable\. try again/i),
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
    currentSettings.transcription.dictationProvider = "moonshine";
    currentSettings.transcription.dictationModelId = "moonshine-base";

    render(<FirstRunWizard onComplete={vi.fn()} />);
    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    expect(
      await screen.findByRole("heading", { name: /try dictation here/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^download$/i);

    expect(downloadAsrModels).toHaveBeenCalledWith("moonshine", "moonshine-base");
    await waitFor(() => {
      expect(currentSettings.transcription.dictationProvider).toBe("moonshine");
    });
    expect(currentSettings.transcription.dictationModelId).toBe("moonshine-base");
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
      await screen.findByRole("button", { name: /download and continue/i })
    );
    expect(downloadAsrModels).toHaveBeenCalledWith("whisper", "base.en");
    expect(
      screen.getByRole("heading", { name: /dictation model/i })
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

  it("does not downgrade an already-working route when the model download is skipped", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);

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
    await clickPrimary(/parakeet tdt 0\.6b v3/i);
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

    await clickPrimary(/download and continue/i);
    // The download-and-continue click kicks off an async model download
    // before the step advances; wait for that transition to actually land
    // (mirroring the explicit wait other tests in this file use for the same
    // step) instead of racing the next click against it.
    await passMicrophoneStep();
    expect(
      await screen.findByRole("heading", { name: /try dictation here/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^continue$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i }),
    ).toBeInTheDocument();
    await clickPrimary(/^continue$/i);
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i }),
    ).toBeInTheDocument();
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
    const meetingProviders = (): AsrProviderInfo[] =>
      providers.map((provider) =>
        provider.providerType === "distil_whisper"
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
      if (providerType === "distil_whisper") {
        meetingModelDownloaded = true;
      }
    });

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^continue$/i);
    expect(
      await screen.findByRole("heading", { name: /meeting setup/i })
    ).toBeInTheDocument();

    await clickPrimary(/download meeting model/i);

    expect(downloadAsrModels).toHaveBeenCalledWith(
      "distil_whisper",
      "distil-large-v3"
    );
    await passMeetingNotesStep();
    expect(
      await screen.findByRole("heading", { name: /^ready$/i })
    ).toBeInTheDocument();
    expect(currentSettings.transcription.useSharedAsrSelection).toBe(false);
    expect(currentSettings.transcription.meetingProvider).toBe(
      "distil_whisper"
    );
    expect(currentSettings.transcription.meetingModelId).toBe(
      "distil-large-v3"
    );
  });

  it("keeps meeting setup open and offers a retry after a failed download", async () => {
    const asrBackend = await import("@/lib/backend/asr");
    const getAsrProviders = vi.mocked(asrBackend.getAsrProviders);
    const downloadAsrModels = vi.mocked(asrBackend.downloadAsrModels);
    let meetingModelDownloaded = false;
    getAsrProviders.mockImplementation(async (): Promise<AsrProviderInfo[]> =>
      providers.map((provider) =>
        provider.providerType === "distil_whisper"
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
        if (providerType === "distil_whisper") {
          meetingModelDownloaded = true;
        }
      });

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await clickPrimary(/skip model download/i);
    await passMicrophoneStep();
    await clickPrimary(/^continue$/i);
    await clickPrimary(/^continue$/i);
    await screen.findByRole("heading", { name: /meeting setup/i });
    await clickPrimary(/download meeting model/i);

    expect(
      await screen.findByText(
        /meeting model download failed: network unavailable/i
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

    await clickPrimary(/download and continue/i);

    expect(
      await screen.findByText(/download failed: network unavailable/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /dictation model/i })
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
    fireEvent.click(screen.getByRole("radio", { name: /press to toggle/i }));
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
    const tapToLock = screen.getByLabelText(/tap to lock/i);
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
    await clickPrimary(/^continue$/i);
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

  it("announces a hotkey save failure and retries without losing the shortcut", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");
    vi.mocked(backend.saveSettings).mockRejectedValueOnce(
      new Error("Settings file is locked")
    );

    render(<FirstRunWizard mode="dictation" onComplete={onComplete} />);

    await clickPrimary(/continue/i);
    await clickPrimary(/continue/i);
    const shortcutInput = await screen.findByLabelText("Dictation shortcut");
    fireEvent.keyDown(shortcutInput, { key: "J", metaKey: true, shiftKey: true });
    await clickPrimary(/finish/i);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /failed to save hotkey: settings file is locked/i
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
      screen.getByText(/not tested yet\. the test plays a short, quiet tone/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test system audio/i })).toBeInTheDocument();

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
    await clickPrimary(/^continue$/i);
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
    getSystemAudioCapability.mockResolvedValueOnce({
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
    });

    render(<FirstRunWizard mode="meetings" onComplete={vi.fn()} />);

    expect(
      await screen.findByText(/not tested yet\. the test plays a short, quiet tone/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open system-audio privacy settings/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /test system audio/i }));

    await waitFor(() => {
      expect(testSystemAudioCapture).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/heard the test tone through macbook pro speakers/i),
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
    fireEvent.click(await screen.findByRole("button", { name: /test system audio/i }));

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
    expect(currentSettings.transcription.meetingModelId).toBe("distil-large-v3");
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
    currentSettings.transcription.meetingModelId = "distil-large-v3";
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
      expect(backend.saveSettings).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith({
        markOnboardingComplete: false,
        meetingsCompleted: true,
        deferred: false,
      });
    });
  });

  it("keeps meeting choices and the wizard open when saving fails, then clears the error on retry", async () => {
    const onComplete = vi.fn();
    const backend = await import("@/lib/backend/settings");
    const saveSettings = vi.mocked(backend.saveSettings);
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();

    currentSettings.transcription.useSharedAsrSelection = false;
    currentSettings.transcription.meetingProvider = "distil_whisper";
    currentSettings.transcription.meetingModelId = "distil-large-v3";

    saveSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async (nextSettings) => {
        await retrySave.promise;
        currentSettings = structuredClone(nextSettings) as ReturnType<typeof createSettings>;
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
      expect(saveSettings).toHaveBeenCalledTimes(1);
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
      expect(saveSettings).toHaveBeenCalledTimes(2);
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
    // would otherwise show a permanent, unfixable rust gate.
    expect(
      screen.queryByRole("button", {
        name: "Open macOS Accessibility settings for Keyboard fallback",
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
        name: "Open macOS Accessibility settings for Keyboard fallback",
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
      screen.getByText(/the apple speech route refuses to transcribe/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/plainsong never falls back to this one on its own/i),
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

  describe("meeting notes step", () => {
    async function openNotesStep() {
      // A meeting-grade route is already configured, so the meeting-setup step
      // offers Continue rather than a model download.
      currentSettings.transcription.useSharedAsrSelection = false;
      currentSettings.transcription.meetingProvider = "distil_whisper";
      currentSettings.transcription.meetingModelId = "distil-large-v3";

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
        await screen.findByText(/ollama is not running, so notes will not be written yet/i),
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
        await screen.findByText(/could not reach ollama to check/i),
      ).toBeInTheDocument();
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

    it("clears a stale opt-out when the reader picks a route again", async () => {
      const ai = await import("@/lib/backend/ai");
      vi.mocked(ai.getOllamaStatus).mockResolvedValue(true);
      storage.set(AI_NOTES_OPT_OUT_STORAGE_KEY, "true");

      await openNotesStep();
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /on this mac/i }));
      });
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(storage.has(AI_NOTES_OPT_OUT_STORAGE_KEY)).toBe(false);
      });
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
        fireEvent.click(screen.getByRole("radio", { name: /on this mac/i }));
      });
      await clickPrimary(/finish meeting setup/i);

      await waitFor(() => {
        expect(currentSettings.privacy.meetingsAi).toEqual({
          provider: "ollama",
          modelId: null,
        });
      });
    });

    it("opens on the configured cloud lane and points at AI & Keys", async () => {
      currentSettings.privacy.meetingsAi = {
        provider: "anthropic",
        modelId: null,
      };

      await openNotesStep();

      expect(
        await screen.findByText(/currently set to anthropic/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /open ai & keys settings/i }),
      ).toBeInTheDocument();
    });
  });
});
