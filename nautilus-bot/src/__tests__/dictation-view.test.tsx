import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationView } from "@/components/views/dictation-view";
import {
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS,
  SPOKEN_COMMAND_PREFIX_LABEL,
} from "@/lib/selected-text-actions";
import { DICTATION_PROFILE_TILES } from "@/lib/dictation-profiles";

/** Radix tabs activate on mouse-down, not click. */
async function openConfigTab(name: string) {
  fireEvent.mouseDown(await screen.findByRole("tab", { name }), { button: 0 });
}

const speechSynthesisMock = {
  speak: vi.fn(),
  cancel: vi.fn(),
};

/** jsdom ships no clipboard; the latest-result card writes to it. */
const clipboardWriteText = vi.fn(async () => {});

const toast = vi.fn();

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast,
  }),
}));

const backendMocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
  transcriptionOverrides: {} as Record<string, unknown>,
  saveSettings: vi.fn(async () => {}),
  refetchDictationHistory: vi.fn(),
  startDictation: vi.fn(async () => {}),
  stopDictation: vi.fn(async () => ""),
  invoke: vi.fn(async () => ({ pasted: true, copied: false })),
  asrProviders: [] as any[],
  downloadAsrModels: vi.fn(async () => {}),
  buildSettings: () => ({
  audio: {
    sampleRate: 16000,
    channels: 1,
    captureSystemAudio: true,
    captureMicrophone: true,
  },
  transcription: {
    defaultProvider: "distil_whisper",
    selectedModelId: "distil-large-v3.5",
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
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
    dictationCopyToClipboard: true,
    dictationCommandModeEnabled: true,
    dictationCommandPrefix: "command",
    dictationInsertionMode: "auto" as const,
    dictationActiveLanguages: [],
    dictationContextSource: "none" as const,
    dictationModePreset: "voice" as const,
    dictationSelectedCustomModeId: null,
    dictationCustomModes: [],
    dictationSnippetsEnabled: true,
    dictationAutoLearnCorrections: true,
    dictationRetentionPreset: "never" as const,
    dictationRetentionCustomHours: 24,
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
    autoDeleteDays: 0,
    requirePassword: false,
    auditLogging: true,
    cloudSync: false,
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
  updates: {
    channel: "stable" as const,
    autoCheck: true,
    lastCheckAt: null,
    lastSeenVersion: null,
  },
  defaultTemplate: "meeting",
  theme: "system" as const,
  }),
  buildAsrProviders: () => [
    {
      providerType: "moonshine",
      name: "UsefulSensors Moonshine",
      description: "Fast local dictation",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "moonshine-base",
      modelOptions: [{ id: "moonshine-base", label: "Moonshine Base" }],
      downloadStatus: "Downloaded",
      runtimeStatus: "ready",
      runtimeMessage: null,
      runtimeDetails: {},
      modelInfo: {
        name: "Moonshine Base",
        version: "1",
        sizeMb: 100,
        parameters: "base",
        languages: ["en"],
        license: "Apache-2.0",
        sourceUrl: "https://example.com/moonshine",
      },
    },
    {
      providerType: "openai_cloud",
      name: "OpenAI Cloud",
      description: "Cloud multilingual",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "gpt-4o-transcribe",
      modelOptions: [{ id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" }],
      downloadStatus: "Downloaded",
      runtimeStatus: "ready",
      runtimeMessage: null,
      runtimeDetails: {},
      modelInfo: {
        name: "GPT-4o Transcribe",
        version: "1",
        sizeMb: 0,
        parameters: "cloud",
        languages: ["multilingual"],
        license: "Commercial",
        sourceUrl: "https://example.com/openai",
      },
    },
  ],
  getSettings: vi.fn(),
}));

backendMocks.getSettings.mockImplementation(async () => {
  const settings = backendMocks.buildSettings();
  Object.assign(settings.transcription, backendMocks.transcriptionOverrides);
  return settings;
});

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    backendMocks.eventListeners.set(eventName, handler);
    return () => {
      backendMocks.eventListeners.delete(eventName);
    };
  }),
  invoke: backendMocks.invoke,
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    isRecording: false,
    formattedDuration: "0:00",
    startDictation: backendMocks.startDictation,
    stopDictation: backendMocks.stopDictation,
  }),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [{ id: "inbox", name: "Inbox" }],
  }),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings: [],
    isLoading: false,
    refetch: backendMocks.refetchDictationHistory,
  }),
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: backendMocks.getSettings,
  saveSettings: backendMocks.saveSettings,
}));

vi.mock("@/lib/backend/recordings", () => ({
  getTranscript: vi.fn(),
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviders: vi.fn(async () => backendMocks.asrProviders),
  downloadAsrModels: backendMocks.downloadAsrModels,
}));

vi.mock("@/lib/backend/dictation", () => ({
  getDictationHistoryDetails: vi.fn(async () => null),
  getDictationInsights: vi.fn(async () => ({
    totalDictations: 3,
    dictatedWords: 120,
    averageWordsPerDictation: 40,
    activeDays: 2,
    lastSevenDaysDictations: 3,
    commandsUsed: 1,
    backtracksUsed: 1,
    snippetsTriggered: 2,
    topAppTarget: "Slack",
    topAppTargetCount: 2,
  })),
  captureSelectedTextForPlayback: vi.fn(async () => "Read this selected sentence"),
  reprocessDictationText: vi.fn(),
  listDictationDictionaryEntries: vi.fn(async () => []),
  createDictationDictionaryEntry: vi.fn(),
  updateDictationDictionaryEntry: vi.fn(),
  deleteDictationDictionaryEntry: vi.fn(),
  exportDictationDictionaryCsv: vi.fn(async () => "spoken_form,replacement\nopen ai,OpenAI"),
  importDictationDictionaryCsv: vi.fn(async () => ({
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
  })),
  listDictationCorrectionSuggestions: vi.fn(async () => []),
  queueDictationCorrectionSuggestion: vi.fn(async () => ({
    queued: true,
    action: "created",
    spokenForm: "jon",
    replacement: "John",
    suggestion: {
      id: "suggestion-1",
      originalText: "jon will join",
      correctedText: "John will join",
      spokenForm: "jon",
      replacement: "John",
      appTarget: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })),
  approveDictationCorrectionSuggestion: vi.fn(async () => ({
    learned: true,
    action: "created",
    spokenForm: "jon",
    replacement: "John",
    entry: {
      id: "learned-1",
      spokenForm: "jon",
      replacement: "John",
      appScope: null,
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })),
  rejectDictationCorrectionSuggestion: vi.fn(async () => {}),
  learnDictationCorrection: vi.fn(async () => ({
    learned: true,
    action: "created",
    spokenForm: "jon",
    replacement: "John",
    entry: {
      id: "learned-1",
      spokenForm: "jon",
      replacement: "John",
      appScope: null,
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })),
  listDictationSnippets: vi.fn(async () => []),
  createDictationSnippet: vi.fn(),
  updateDictationSnippet: vi.fn(),
  deleteDictationSnippet: vi.fn(),
  listDictationCommandPresets: vi.fn(async () => []),
  upsertDictationCommandPreset: vi.fn(async (preset: any) => preset),
  deleteDictationCommandPreset: vi.fn(),
}));

describe("DictationView modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendMocks.eventListeners.clear();
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    for (const key of Object.keys(backendMocks.transcriptionOverrides)) {
      delete backendMocks.transcriptionOverrides[key];
    }
    speechSynthesisMock.speak.mockClear();
    speechSynthesisMock.cancel.mockClear();
    clipboardWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    Object.assign(window, {
      speechSynthesis: speechSynthesisMock,
      SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
        text: string;
        rate = 1;
        pitch = 1;
        lang = "";
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        constructor(text = "") {
          this.text = text;
        }
      },
    });
  });

  it("offers one profile grid with exactly one active tile", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");

    const tiles = screen.getAllByRole("button", { name: /^Profile: / });
    expect(tiles).toHaveLength(DICTATION_PROFILE_TILES.length);

    // The two grids this page used to stack both rendered a "General" tile and
    // both marked it Active, which is the pattern STYLE.md forbids.
    expect(screen.getAllByRole("button", { name: "Profile: General" })).toHaveLength(1);
    expect(tiles.filter((tile) => tile.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    expect(screen.getAllByText("Active")).toHaveLength(1);

    // Everything both grids used to reach is still one click away.
    for (const name of [
      "Profile: General",
      "Profile: Slack & Chat",
      "Profile: Writing",
      "Profile: Notes",
      "Profile: Meeting Follow-up",
      "Profile: Coding",
      "Profile: Quiet",
      "Profile: Custom",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("moves the active marker to the ready-made profile that was installed", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    expect(
      screen.getByRole("button", { name: "Profile: General" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Profile: Coding" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Profile: Coding" }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(
      screen.getByRole("button", { name: "Profile: General" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen
        .getAllByRole("button", { name: /^Profile: / })
        .filter((tile) => tile.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);
  });

  it("puts capture above the configuration tabs", async () => {
    render(<DictationView />);

    const startButton = await screen.findByRole("button", { name: /start dictation/i });
    const firstTab = screen.getByRole("tab", { name: "Profiles" });

    expect(
      startButton.compareDocumentPosition(firstTab) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps a hands-free choice and states one hotkey behavior", async () => {
    backendMocks.transcriptionOverrides.dictationHandsFreeEnabled = true;

    render(<DictationView />);

    // Header chip and capture instruction resolve from the same helper, so the
    // page cannot claim two behaviors at once.
    expect(await screen.findByText("hands-free")).toBeInTheDocument();
    expect(screen.getByText(/hands-free dictation/i)).toBeInTheDocument();

    // The one-option select that used to live here could only write
    // pushToTalk:false/handsFree:false, silently destroying this choice.
    await openConfigTab("Capture");
    expect(screen.queryByLabelText("Hotkey behavior")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Change in Settings" }),
    ).toBeInTheDocument();
  });

  it("offers only the two insertion behaviors that actually differ", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    const select = (await screen.findByLabelText(
      "Insertion mode",
    )) as HTMLSelectElement;
    // "paste" and "inline" took the same code path as "auto" — three names for
    // one behavior — so they are gone rather than sitting here as choices that
    // change nothing.
    expect(
      Array.from(select.options).map((option) => option.value),
    ).toEqual(["auto", "clipboard_only"]);
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toEqual(["Insert at cursor", "Clipboard only"]);
  });

  it("offers keep warm as the on/off it now actually is", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    const select = (await screen.findByLabelText(
      "Keep warm",
    )) as HTMLSelectElement;
    // "Short" and "Long" described a prewarm that ran unconditionally, so
    // neither of them (nor "Off") changed anything. The setting now gates the
    // prewarm, and there is one thing to gate.
    expect(
      Array.from(select.options).map((option) => option.value),
    ).toEqual(["on", "off"]);
  });

  it("suppresses batch live preview when Apple Speech is selected", async () => {
    backendMocks.transcriptionOverrides.dictationProvider = "macos_apple_speech";
    backendMocks.transcriptionOverrides.dictationModelId = "macos_apple_speech";
    backendMocks.transcriptionOverrides.dictationLivePreviewEnabled = true;

    render(<DictationView />);
    await openConfigTab("Capture");

    const select = (await screen.findByLabelText(
      "Live preview",
    )) as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select).toHaveValue("off");
    expect(
      screen.getByText(/waits for the final on-device result/i),
    ).toBeInTheDocument();
  });

  it("describes keep warm as the speed choice it is, not a memory choice", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    // Off only skips the prewarm. The first transcription still loads the
    // model into the process-global cache and nothing in the app evicts it,
    // so "Off" costs latency once and saves no memory at all.
    expect(
      await screen.findByText(/stays in memory until you quit/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/frees the memory/i)).toBeNull();
  });

  it("reads a saved profile left on a retired insertion mode as the behavior it gets", async () => {
    backendMocks.transcriptionOverrides.dictationCustomModes = [
      {
        id: "sales",
        name: "Sales Follow-up",
        description: "",
        baseModePreset: "email",
        customPrompt: null,
        profile: "normal_speed",
        routePreference: null,
        languageOverride: null,
        livePreviewEnabled: null,
        // Written before "paste" was retired; the sidecar migrates this on
        // load, but the renderer must not render a blank chip if it ever sees
        // the old value.
        insertionMode: "paste",
        contextSource: "none",
        saveToInbox: false,
        copyToClipboard: false,
        commandModeEnabled: false,
        dictationProvider: null,
        dictationModelId: null,
        aiProvider: null,
        aiModelId: null,
        activationAppMatcher: null,
        activationDomainMatcher: null,
      },
    ];

    render(<DictationView />);

    await openConfigTab("Profiles");

    // Scoped to the saved-profile card: the active-setup summary above it
    // renders its own "Result:" chip from the top-level setting.
    const card = (await screen.findByText("Sales Follow-up")).closest(
      "div.rounded-md",
    );
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText("Result:").parentElement
        ?.textContent,
    ).toBe("Result: Insert at cursor");

    fireEvent.click(screen.getByRole("button", { name: "Use profile" }));

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<
      [any]
    >;
    const latestSettings = saveCalls[saveCalls.length - 1]![0];
    // Applying the profile must not write the retired value back out, and the
    // picker it drives has no "paste" option to select.
    expect(latestSettings.transcription.dictationInsertionMode).toBe("auto");
  });

  it("applies Messages mode defaults and persists them", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Slack & Chat" }));

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestCall = saveCalls[saveCalls.length - 1];
    expect(latestCall).toBeTruthy();
    const latestSettings = latestCall![0];
    expect(latestSettings.transcription.dictationModePreset).toBe("messages");
    expect(latestSettings.transcription.dictationProfile).toBe("normal_speed");
    // "paste" was retired: it was a second name for the insert path "auto"
    // already took.
    expect(latestSettings.transcription.dictationInsertionMode).toBe("auto");
    expect(latestSettings.transcription.dictationContextSource).toBe("none");
    expect(latestSettings.transcription.dictationSaveToInbox).toBe(false);
    expect(latestSettings.transcription.dictationCopyToClipboard).toBe(true);
    expect(latestSettings.transcription.dictationCommandModeEnabled).toBe(false);
  });

  it("saves the current setup as a reusable custom mode", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Slack & Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Profile: Custom" }));

    const nameInput = await screen.findByLabelText("Profile name");
    fireEvent.change(nameInput, { target: { value: "Sales Follow-up" } });
    fireEvent.change(screen.getByLabelText("Auto-activate for domain"), {
      target: { value: "gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save current setup/i }));

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationModePreset).toBe("custom");
    expect(latestSettings.transcription.dictationSelectedCustomModeId).toBeTruthy();
    expect(latestSettings.transcription.dictationCustomModes).toHaveLength(1);
    expect(latestSettings.transcription.dictationCustomModes[0].name).toBe("Sales Follow-up");
    expect(latestSettings.transcription.dictationCustomModes[0].baseModePreset).toBe("messages");
    expect(latestSettings.transcription.dictationCustomModes[0].activationDomainMatcher).toBe(
      "gmail.com"
    );
  });

  it("installs a recommended app style as a custom mode", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    await screen.findByText("Recommended flow profiles");
    expect(screen.queryByText(/App undefined/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /install and use/i })[0]);

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationModePreset).toBe("custom");
    expect(latestSettings.transcription.dictationSelectedCustomModeId).toBe("builtin-slack-replies");
    expect(latestSettings.transcription.dictationCustomModes).toHaveLength(1);
    expect(latestSettings.transcription.dictationCustomModes[0].name).toBe("Slack Replies");
    expect(latestSettings.transcription.dictationCustomModes[0].baseModePreset).toBe("messages");
    expect(latestSettings.transcription.dictationCustomModes[0].activationAppMatcher).toBe("Slack");
    expect(latestSettings.transcription.dictationCustomModes[0].customPrompt).toMatch(/slack reply/i);
    expect(latestSettings.transcription.dictationContextSource).toBe("application_context");
    expect(latestSettings.transcription.dictationProvider).toBe("distil_whisper");
    expect(latestSettings.transcription.dictationModelId).toBe("distil-large-v3.5");
  });

  it("refreshes dictation history when a dictation result event arrives", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          text: "Ship it",
          actualProvider: "distil_whisper",
        },
      });
    });

    await waitFor(() => {
      expect(backendMocks.refetchDictationHistory).toHaveBeenCalled();
    });
  });

  it("can read the latest result aloud from the dictation hero surface", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          text: "Ship the beta update after lunch.",
          actualProvider: "distil_whisper",
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Read aloud" }));

    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalled();
      expect(speechSynthesisMock.speak).toHaveBeenCalled();
    });
  });

  it("can read selected text aloud from the capture card", async () => {
    const backend = await import("@/lib/backend/dictation");

    render(<DictationView />);

    fireEvent.click(await screen.findByRole("button", { name: "Read selected text" }));

    await waitFor(() => {
      expect(backend.captureSelectedTextForPlayback).toHaveBeenCalled();
      expect(speechSynthesisMock.cancel).toHaveBeenCalled();
      expect(speechSynthesisMock.speak).toHaveBeenCalled();
    });
  });

  it("surfaces dictation lifecycle state in the capture card", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-state-changed");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          phase: "transcribing",
          message: "Turning speech into text now.",
          preview: "draft follow-up",
          resolvedModeLabel: "Meeting Follow-up",
        },
      });
    });

    expect((await screen.findAllByText("Transcribing")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("draft follow-up").length).toBeGreaterThan(0);
    expect(screen.getByText("Runtime mode: Meeting Follow-up")).toBeInTheDocument();
  });

  it("surfaces auto-activated app matcher details in the latest result", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          text: "Reply sent",
          actualProvider: "distil_whisper",
          appTarget: "Slack",
          activationMatcher: "slack",
        },
      });
    });

    expect(await screen.findByText("Auto mode: slack")).toBeInTheDocument();
    expect(screen.getByText("Target app: Slack")).toBeInTheDocument();
  });

  it("learns a corrected latest-result word on blur", async () => {
    const backend = await import("@/lib/backend/dictation");
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");

    await act(async () => {
      handler?.({
        payload: {
          text: "please email jon tomorrow",
          actualProvider: "distil_whisper",
        },
      });
    });

    const editor = screen.getByDisplayValue("please email jon tomorrow");
    fireEvent.change(editor, { target: { value: "please email John tomorrow" } });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalledWith({
        originalText: "please email jon tomorrow",
        correctedText: "please email John tomorrow",
        appTarget: null,
        force: false,
      });
    });

    expect(await screen.findByText("Queued for review: jon -> John")).toBeInTheDocument();
  });

  it("groups duplicate correction suggestions and clears the group together", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      {
        id: "suggestion-1",
        originalText: "jon will join",
        correctedText: "John will join",
        spokenForm: "jon",
        replacement: "John",
        appTarget: "Slack",
        createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      },
      {
        id: "suggestion-2",
        originalText: "jon can ship it",
        correctedText: "John can ship it",
        spokenForm: "jon",
        replacement: "John",
        appTarget: "Slack",
        createdAt: new Date("2026-03-14T11:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T11:00:00Z").toISOString(),
      },
    ]);

    render(<DictationView />);

    await openConfigTab("Corrections");
    expect(await screen.findByText(/2 similar edits/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve all" }));

    await waitFor(() => {
      expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith("suggestion-1");
      expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith("suggestion-2");
    });
  });

  it("persists the session language separately from flow profiles", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");
    fireEvent.change(screen.getByLabelText("Session language"), {
      target: { value: "es" },
    });

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.language).toBe("es");
  });

  it("locks auto dictation to a single active language when the set has one item", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");
    fireEvent.click(screen.getByRole("button", { name: "Toggle French active language" }));
    fireEvent.click(screen.getByRole("button", { name: /start dictation/i }));

    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          languageOverride: "fr",
        })
      );
    });
  });

  it("surfaces a start failure when dictation cannot begin", async () => {
    backendMocks.startDictation.mockRejectedValueOnce(
      new Error("Microphone permission is not ready.")
    );

    render(<DictationView />);

    await screen.findByRole("button", { name: /start dictation/i });
    fireEvent.click(screen.getByRole("button", { name: /start dictation/i }));

    expect((await screen.findAllByText("Microphone permission is not ready.")).length).toBeGreaterThan(0);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("names the missing model instead of letting the hotkey fail silently", async () => {
    // A brand-new install ships no weights, and start_dictation errors out
    // before it emits any dictation state -- so without this banner the user
    // presses the shortcut and literally nothing happens, forever.
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";

    render(<DictationView />);

    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    expect(
      screen.getByText(/UsefulSensors Moonshine · Moonshine Base is not on this Mac/i),
    ).toBeInTheDocument();

    // And the shortcut press says so out loud rather than only in the console.
    fireEvent.keyDown(window, {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("Dictation can't start yet"),
      "error",
    );
  });

  it("downloads the missing dictation model from the banner and then clears it", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.downloadAsrModels.mockImplementationOnce(async () => {
      backendMocks.asrProviders = backendMocks.buildAsrProviders();
    });

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", { name: /download usefulsensors moonshine/i }),
    );

    await waitFor(() => {
      expect(backendMocks.downloadAsrModels).toHaveBeenCalledWith("moonshine");
    });
    await waitFor(() => {
      expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();
    });
  });

  it("stays quiet when the dictation route already has its model", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";

    render(<DictationView />);

    await screen.findByRole("button", { name: /start dictation/i });
    expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("creates dictionary entries and round-trips dictionary CSV", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.createDictationDictionaryEntry).mockResolvedValueOnce({
      id: "dict-1",
      spokenForm: "open ai",
      replacement: "OpenAI",
      appScope: "Slack",
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
    });

    render(<DictationView />);

    await openConfigTab("Dictionary");
    fireEvent.change(screen.getByPlaceholderText("Say (e.g. open ai)"), {
      target: { value: "open ai" },
    });
    fireEvent.change(screen.getByPlaceholderText("Insert (e.g. OpenAI)"), {
      target: { value: "OpenAI" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("App scope (optional)")[0], {
      target: { value: "Slack" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await waitFor(() => {
      expect(backend.createDictationDictionaryEntry).toHaveBeenCalledWith({
        spokenForm: "open ai",
        replacement: "OpenAI",
        appScope: "Slack",
        caseSensitive: false,
        enabled: true,
      });
    });
    expect(await screen.findByDisplayValue("OpenAI")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByText("Export Dictionary CSV")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/open ai,OpenAI/)).toBeInTheDocument();
    expect(backend.exportDictationDictionaryCsv).toHaveBeenCalled();
  });

  it("imports dictionary CSV through the merge dialog", async () => {
    const backend = await import("@/lib/backend/dictation");

    render(<DictationView />);

    await openConfigTab("Dictionary");
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));

    expect(await screen.findByText("Import Dictionary CSV")).toBeInTheDocument();
    const csvEditor = screen.getByDisplayValue(/spoken_form,replacement/);
    fireEvent.change(csvEditor, {
      target: { value: "spoken_form,replacement\nopen ai,OpenAI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import & Merge" }));

    await waitFor(() => {
      expect(backend.importDictationDictionaryCsv).toHaveBeenCalledWith(
        "spoken_form,replacement\nopen ai,OpenAI",
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText("Import complete: 1 created.").length).toBeGreaterThan(0);
    });
  });

  it("creates phrase expansion snippets", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.createDictationSnippet).mockResolvedValueOnce({
      id: "snippet-1",
      trigger: "brb",
      expansion: "be right back",
      appScope: "Slack",
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
    });

    render(<DictationView />);

    await openConfigTab("Snippets");
    fireEvent.change(screen.getByPlaceholderText("Trigger (e.g. brb)"), {
      target: { value: "brb" },
    });
    fireEvent.change(screen.getByPlaceholderText("Expansion (e.g. be right back)"), {
      target: { value: "be right back" },
    });
    fireEvent.change(screen.getByPlaceholderText("App scope (optional)"), {
      target: { value: "Slack" },
    });
    const snippetSection = screen.getByTestId("snippet-section");
    fireEvent.click(within(snippetSection as HTMLElement).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(backend.createDictationSnippet).toHaveBeenCalledWith({
        trigger: "brb",
        expansion: "be right back",
        appScope: "Slack",
        caseSensitive: false,
        enabled: true,
      });
    });
    expect(await screen.findByDisplayValue("be right back")).toBeInTheDocument();
  });

  it("toggles category-aware dictation formatting", async () => {
    render(<DictationView />);

    await openConfigTab("Destinations");
    const toggle = await screen.findByText("Format for destination app");
    const card = toggle.closest(".rounded-2xl");
    expect(card).toBeTruthy();
    const switchControl = within(card as HTMLElement).getByRole("switch");
    expect(switchControl).toHaveAttribute("aria-checked", "true");

    fireEvent.click(switchControl);

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationCategoryFormattingEnabled).toBe(false);
  });

  it("adds and removes a per-app category override", async () => {
    render(<DictationView />);

    await openConfigTab("Destinations");
    const appMatcherInput = await screen.findByPlaceholderText("App matcher (e.g. slack)");
    fireEvent.change(appMatcherInput, {
      target: { value: "notion" },
    });
    const overridesSection = screen.getByTestId("category-override-section");
    fireEvent.click(
      within(overridesSection as HTMLElement).getByRole("button", { name: "Add" }),
    );

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    let saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    let latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationAppCategoryOverrides).toHaveLength(1);
    expect(latestSettings.transcription.dictationAppCategoryOverrides[0]).toMatchObject({
      appMatcher: "notion",
      category: "messaging",
      enabled: true,
    });

    const overrideRow = (await screen.findByDisplayValue("notion")).closest(
      ".space-y-2",
    );
    expect(overrideRow).toBeTruthy();
    fireEvent.click(
      within(overrideRow as HTMLElement).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
      latestSettings = saveCalls[saveCalls.length - 1]?.[0];
      expect(latestSettings.transcription.dictationAppCategoryOverrides).toHaveLength(0);
    });
  });

  it("persists command preset prompt edits", async () => {
    const backend = await import("@/lib/backend/dictation");

    render(<DictationView />);

    await openConfigTab("Text actions");
    const rewriteShorter = await screen.findByText("Rewrite Shorter");
    const presetCard = rewriteShorter.closest(".rounded-md");
    expect(presetCard).toBeTruthy();
    const promptEditor = within(presetCard as HTMLElement).getByRole("textbox");

    fireEvent.change(promptEditor, {
      target: { value: "Make this shorter and keep product names exact." },
    });
    fireEvent.blur(promptEditor);

    await waitFor(() => {
      expect(backend.upsertDictationCommandPreset).toHaveBeenCalledWith(
        {
          commandKey: "rewrite_shorter",
          systemPrompt: "Make this shorter and keep product names exact.",
          enabled: true,
        },
      );
    });
  });

  it("exposes every spoken-command preset from the shared catalog", async () => {
    render(<DictationView />);

    await openConfigTab("Text actions");

    // The editor used to hard-code three presets while the catalog carried the
    // full set, so the rest were unreachable from the UI.
    expect(SELECTED_TEXT_COMMAND_PRESET_ACTIONS.length).toBeGreaterThan(3);
    for (const action of SELECTED_TEXT_COMMAND_PRESET_ACTIONS) {
      expect(
        screen.getByLabelText(action.commandPresetLabel),
      ).toBeInTheDocument();
    }
  });

  it("keeps exactly one editable spoken-command prefix", async () => {
    render(<DictationView />);

    await openConfigTab("Text actions");
    expect(screen.getAllByLabelText(SPOKEN_COMMAND_PREFIX_LABEL)).toHaveLength(1);

    // The read-only copy that used to shadow it is gone.
    await openConfigTab("Capture");
    expect(screen.queryByText(SPOKEN_COMMAND_PREFIX_LABEL)).toBeNull();
    expect(screen.queryByText("command")).toBeNull();
  });

  it("copies the text on screen and never re-pastes the stored capture from this window", async () => {
    const backend = await import("@/lib/backend/dictation");
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");

    await act(async () => {
      handler?.({
        payload: { text: "Ship it", actualProvider: "distil_whisper" },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Copy again" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Ship it");
    });

    // `repaste_dictation_result` re-resolves the frontmost app, and a button in
    // this window can only be clicked while Plainsong itself is frontmost — it
    // would insert into Plainsong while reporting it reached the target app.
    expect(backendMocks.invoke).not.toHaveBeenCalledWith(
      "repaste_dictation_result",
      expect.anything(),
    );

    // Blur auto-learns the edit, which resets the correction baseline. The
    // sidecar's stored capture is untouched by that, so the staleness warning
    // must survive the reset instead of quietly disarming with it.
    const editor = screen.getByDisplayValue("Ship it");
    fireEvent.change(editor, { target: { value: "Ship it tomorrow" } });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Learn correction" }),
      ).toBeDisabled();
    });
    expect(
      screen.getByText(/You changed this after capture/),
    ).toBeInTheDocument();

    clipboardWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy again" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Ship it tomorrow");
    });
  });

  it("gives the page body real headings, not styled paragraphs", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });

    // Every section label used to be a CardTitle, which renders a real <h3>.
    // The reorganized page must still be navigable by heading.
    expect(
      screen.getByRole("heading", { name: "Dictation", level: 1 }),
    ).toBeInTheDocument();
    for (const name of [
      "Capture",
      "The main path",
      "Dictation coach",
      "Recent dictations",
      "Set up dictation",
    ]) {
      expect(
        screen.getByRole("heading", { name, level: 2 }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole("heading", { name: "Pick a profile", level: 3 }),
    ).toBeInTheDocument();

    await openConfigTab("Dictionary");
    expect(
      await screen.findByRole("heading", { name: "Dictionary", level: 3 }),
    ).toBeInTheDocument();
  });

  it("shows a recently learned list sourced from existing dictionary entries", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationDictionaryEntries).mockResolvedValueOnce([
      {
        id: "dict-older",
        spokenForm: "jon",
        replacement: "John",
        appScope: null,
        caseSensitive: false,
        enabled: true,
        categoryScope: null,
        createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
        updatedAt: new Date("2026-01-01T10:00:00Z").toISOString(),
      },
      {
        id: "dict-newer",
        spokenForm: "open ai",
        replacement: "OpenAI",
        appScope: null,
        caseSensitive: false,
        enabled: true,
        categoryScope: null,
        createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      },
    ]);

    render(<DictationView />);

    await openConfigTab("Dictionary");
    const recentlyLearned = await screen.findByTestId(
      "recently-learned-dictionary",
    );
    expect(
      within(recentlyLearned).getByText("Recently learned"),
    ).toBeInTheDocument();

    const items = within(recentlyLearned).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Newer updatedAt entry (open ai -> OpenAI) should be listed first.
    expect(items[0]).toHaveTextContent("open ai");
    expect(items[0]).toHaveTextContent("OpenAI");
    expect(items[1]).toHaveTextContent("jon");
    expect(items[1]).toHaveTextContent("John");
  });

  it("only claims a clipboard copy when the text was left on the clipboard", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    // "Copy to clipboard" off (the default) restores the previous clipboard
    // after the paste, so promising a copy sends the user to Cmd+V for
    // whatever they had copied before dictating.
    await act(async () => {
      handler?.({
        payload: {
          text: "Ship it",
          pasted: true,
          copied: false,
          actualProvider: "distil_whisper",
        },
      });
    });

    expect(
      (await screen.findAllByText("Paste command sent")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("Paste command sent (also copied to clipboard)"),
    ).toBeNull();

    await act(async () => {
      handler?.({
        payload: {
          text: "Ship it again",
          pasted: true,
          copied: true,
          actualProvider: "distil_whisper",
        },
      });
    });

    expect(
      (await screen.findAllByText("Paste command sent (also copied to clipboard)"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("shows Fix capitalization only for a case-only diff of the latest result", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          text: "hello world",
          actualProvider: "distil_whisper",
        },
      });
    });

    const learnButton = await screen.findByRole("button", {
      name: "Learn correction",
    });
    const textarea = learnButton
      .closest(".space-y-4")
      ?.querySelector("textarea");
    expect(textarea).toBeTruthy();

    // Unedited text: no pending correction of any kind yet.
    expect(
      screen.queryByRole("button", { name: "Fix capitalization" }),
    ).not.toBeInTheDocument();

    fireEvent.change(textarea as HTMLTextAreaElement, {
      target: { value: "Hello World" },
    });

    expect(
      await screen.findByRole("button", { name: "Fix capitalization" }),
    ).toBeInTheDocument();

    fireEvent.change(textarea as HTMLTextAreaElement, {
      target: { value: "Hello there world" },
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Fix capitalization" }),
      ).not.toBeInTheDocument();
    });
  });

  it("sets a category scope on a new dictionary entry", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.createDictationDictionaryEntry).mockResolvedValueOnce({
      id: "dict-scoped",
      spokenForm: "standup",
      replacement: "stand-up",
      appScope: null,
      caseSensitive: false,
      enabled: true,
      categoryScope: "worklog",
      createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
    });

    render(<DictationView />);

    await openConfigTab("Dictionary");
    fireEvent.change(screen.getByPlaceholderText("Say (e.g. open ai)"), {
      target: { value: "standup" },
    });
    fireEvent.change(screen.getByPlaceholderText("Insert (e.g. OpenAI)"), {
      target: { value: "stand-up" },
    });

    const dictionarySection = screen.getByTestId("dictionary-section");
    const categoryTrigger = within(
      dictionarySection as HTMLElement,
    ).getByRole("combobox");
    fireEvent.click(categoryTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Project tools" }));

    fireEvent.click(
      within(dictionarySection as HTMLElement).getAllByRole("button", {
        name: "Add",
      })[0],
    );

    await waitFor(() => {
      expect(backend.createDictationDictionaryEntry).toHaveBeenCalledWith({
        spokenForm: "standup",
        replacement: "stand-up",
        appScope: null,
        caseSensitive: false,
        enabled: true,
        categoryScope: "worklog",
      });
    });
  });
});
