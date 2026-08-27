import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationView } from "@/components/views/dictation-view";
import {
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS,
  SPOKEN_COMMAND_PREFIX_LABEL,
} from "@/lib/selected-text-actions";
import { DICTATION_PROFILE_TILES } from "@/lib/dictation-profiles";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";
import type { Recording } from "@/types";
import { OPEN_MAIN_VIEW_EVENT } from "@/lib/navigation";

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

/**
 * This jsdom setup ships no `window.localStorage` either, and the view remembers
 * its one-time cards there. A real in-memory store (rather than spies) is what
 * lets a test assert the part that matters: that a card closed once stays closed
 * the next time the view is mounted.
 */
const localStorageStub = (() => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
})();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: localStorageStub,
});

const toast = vi.fn();
const readinessContext = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  engineNotice: null as {
    title: string;
    message: string;
    recovering: boolean;
  } | null,
  dismissEngineNotice: vi.fn(),
  productReadiness: {
    evidenceObservedAt: 1,
    dictation: { domain: "dictation", state: "ready", cause: null },
    meetings: { domain: "meetings", state: "ready", cause: null },
    meetingsCapture: {
      domain: "meetings_capture",
      state: "ready",
      cause: null,
    },
    fullCapture: { domain: "full_capture", state: "ready", cause: null },
    overall: { domain: "overall", state: "ready", cause: null },
  } as ProductReadinessSnapshot,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast,
  }),
}));

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

const backendMocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
  transcriptionOverrides: {} as Record<string, unknown>,
  saveSettings: vi.fn(async () => {}),
  refetchDictationHistory: vi.fn(),
  recordings: [] as Recording[],
  deleteRecording: vi.fn(async () => {}),
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
    // The sidecar's own default, and the one the fixture must carry: turning
    // it on replaces the reader's clipboard on every dictation.
    dictationCopyToClipboard: false,
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
    recordings: backendMocks.recordings,
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
  deleteRecording: backendMocks.deleteRecording,
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviders: vi.fn(async () => backendMocks.asrProviders),
  downloadAsrModels: backendMocks.downloadAsrModels,
}));

vi.mock("@/lib/backend/dictation", () => ({
  EXTERNAL_APP_CORRECTION_SOURCE: "external_app_readback",
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

function createSavedDictation(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "dictation-1",
    title: "Project update",
    projectId: "inbox",
    duration: 12,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:12.000Z",
    sourceType: "dictation",
    audioPath: "/tmp/dictation.wav",
    status: "completed",
    ...overrides,
  };
}

describe("DictationView modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test starts on a machine that has never seen this view before —
    // the one-time cards below are remembered in localStorage.
    window.localStorage.clear();
    backendMocks.eventListeners.clear();
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.recordings = [];
    readinessContext.engineNotice = null;
    readinessContext.productReadiness = {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: { domain: "meetings", state: "ready", cause: null },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "ready",
        cause: null,
      },
      fullCapture: { domain: "full_capture", state: "ready", cause: null },
      overall: { domain: "overall", state: "ready", cause: null },
    };
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

  it("blocks capture and routes repair from the canonical dictation cause", async () => {
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      dictation: {
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
      },
      overall: {
        domain: "overall",
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
      },
    };
    const navigationListener = vi.fn();
    window.addEventListener(OPEN_MAIN_VIEW_EVENT, navigationListener);

    render(<DictationView />);

    const notice = await screen.findByRole("alert", {
      name: "Dictation needs attention",
    });
    expect(notice).toHaveTextContent(
      "Text insertion needs Accessibility access for the current mode.",
    );
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Setup needed")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Text insertion needs Accessibility access for the current mode.",
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Repair text insertion" }));
    expect(
      (navigationListener.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toEqual({ view: "setup" });

    expect(backendMocks.startDictation).not.toHaveBeenCalled();

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, navigationListener);
  });

  it("does not describe a runtime failure as an absent model", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.asrProviders[0].runtimeStatus = "error";
    backendMocks.asrProviders[0].runtimeMessage =
      "Moonshine model exists but failed to initialize.";
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      dictation: {
        domain: "dictation",
        state: "blocked",
        cause: {
          id: "dictation_route",
          message: "Moonshine model exists but failed to initialize.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
    };

    render(<DictationView />);

    expect(
      await screen.findAllByText(
        "Moonshine model exists but failed to initialize.",
      ),
    ).toHaveLength(1);
    expect(
      screen.queryByText("Dictation has no model yet"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/is not on this Mac/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review models" }),
    ).toBeEnabled();
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
    // ux-5: picking any profile used to write `true` here, permanently
    // replacing the reader's clipboard on every dictation from then on.
    expect(latestSettings.transcription.dictationCopyToClipboard).toBe(false);
    expect(latestSettings.transcription.dictationCommandModeEnabled).toBe(false);
  });

  it("never turns clipboard copying on just because a profile was picked", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    for (const name of [
      "Profile: General",
      "Profile: Writing",
      "Profile: Notes",
      "Profile: Meeting Follow-up",
      "Profile: Coding",
      "Profile: Quiet",
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<
      [any]
    >;
    for (const [settings] of saveCalls) {
      expect(settings.transcription.dictationCopyToClipboard).toBe(false);
    }
  });

  it("makes clipboard copying an explicit choice that admits what it costs", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    const toggle = await screen.findByRole("switch", {
      name: /also copy every dictation to the clipboard/i,
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/does not put the previous contents back/i),
    ).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<
      [any]
    >;
    expect(
      saveCalls[saveCalls.length - 1]![0].transcription
        .dictationCopyToClipboard,
    ).toBe(true);
  });

  it("saves the current setup as a reusable custom mode", async () => {
    render(<DictationView />);

    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Slack & Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Profile: Custom" }));

    const nameInput = await screen.findByLabelText("Profile name");
    fireEvent.change(nameInput, { target: { value: "Sales Follow-up" } });
    fireEvent.change(screen.getByLabelText("Website this profile is for"), {
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

  it("opens a saved dictation from a keyboard-accessible history control", async () => {
    const user = userEvent.setup();
    const recording = createSavedDictation();
    backendMocks.recordings = [recording];

    render(<DictationView />);

    const openButton = await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    });
    const copyButton = screen.getByRole("button", { name: "Copy Project update" });
    const deleteButton = screen.getByRole("button", { name: "Delete Project update" });
    expect(openButton.tagName).toBe("BUTTON");
    expect(openButton).not.toContainElement(copyButton);
    expect(openButton).not.toContainElement(deleteButton);

    openButton.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Project update" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument();
    });

    openButton.focus();
    await user.keyboard(" ");
    expect(
      await screen.findByRole("dialog", { name: "Project update" }),
    ).toBeInTheDocument();
  });

  it("requires confirmation before deleting a saved dictation", async () => {
    backendMocks.recordings = [createSavedDictation()];

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Project update" }),
    );
    expect(backendMocks.deleteRecording).not.toHaveBeenCalled();

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete this dictation?",
    });
    expect(confirmDialog).toHaveTextContent("Project update");
    expect(confirmDialog).toHaveTextContent(/cannot be undone/i);

    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));
    expect(backendMocks.deleteRecording).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Project update" }),
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Delete this dictation?" }),
      ).getByRole("button", { name: "Delete dictation" }),
    );

    await waitFor(() => {
      expect(backendMocks.deleteRecording).toHaveBeenCalledWith("dictation-1");
      expect(backendMocks.refetchDictationHistory).toHaveBeenCalled();
    });
  });

  it("uses the same delete confirmation from the saved-dictation dialog", async () => {
    backendMocks.recordings = [createSavedDictation()];

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const detailDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    fireEvent.click(
      within(detailDialog).getByRole("button", { name: "Delete" }),
    );
    expect(backendMocks.deleteRecording).not.toHaveBeenCalled();

    let confirmDialog = await screen.findByRole("dialog", {
      name: "Delete this dictation?",
    });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("dialog", { name: "Project update" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Project update" }),
      ).getByRole("button", { name: "Delete" }),
    );
    confirmDialog = await screen.findByRole("dialog", {
      name: "Delete this dictation?",
    });
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete dictation" }),
    );

    await waitFor(() => {
      expect(backendMocks.deleteRecording).toHaveBeenCalledWith("dictation-1");
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument();
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

  it("does not label a cold local model as primed before warmup acknowledges", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-state-changed");

    await act(async () => {
      handler?.({
        payload: {
          phase: "preparing",
          message: "Loading the selected dictation model",
          modelReadiness: "loading",
          captureReady: false,
        },
      });
    });

    expect(await screen.findByText("Loading local model")).toBeInTheDocument();
    expect(screen.queryByText("Model primed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await waitFor(() => {
      expect(backendMocks.invoke).toHaveBeenCalledWith("force_stop_dictation");
    });

    await act(async () => {
      handler?.({
        payload: {
          phase: "primed",
          message: "Local model ready. Opening the microphone.",
          modelReadiness: "ready",
          captureReady: false,
        },
      });
    });

    expect(await screen.findByText("Model primed")).toBeInTheDocument();
    expect(screen.getByText("Local model ready. Opening the microphone.")).toBeInTheDocument();
    expect(screen.queryByText("--:--")).toBeNull();
  });

  it("shows every measured latency segment for the latest dictation", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");

    await act(async () => {
      handler?.({
        payload: {
          text: "Measured result",
          pasted: true,
          copied: false,
          actualProvider: "whisper",
          acknowledgementLatencyMs: 42,
          captureReadyLatencyMs: 210,
          firstStablePartialLatencyMs: 910,
          finalTranscriptLatencyMs: 330,
          startupLatencyMs: 210,
          latencyMs: 300,
          insertLatencyMs: 30,
          endToEndMs: 1_240,
        },
      });
    });

    for (const label of [
      "Acknowledged",
      "Capture ready",
      "First preview",
      "Final transcript",
      "Total time",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
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

  // ── ux-8: corrections made where the text actually landed ────────────────
  //
  // "Learns automatically from your corrections" only ever fired when the user
  // retyped inside Plainsong's own result box. These cover the other half: what
  // the sidecar reads back out of Slack/Gmail/an editor shows up in its own
  // section, says which app it came from, and is never applied without a click.

  /** One suggestion the sidecar read back out of another app's field. */
  function externalSuggestion(overrides: Record<string, unknown> = {}) {
    return {
      id: "external-1",
      originalText: "cuban netties",
      correctedText: "kubernetes",
      spokenForm: "cuban netties",
      replacement: "kubernetes",
      appTarget: "Slack",
      source: "external_app_readback",
      createdAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      updatedAt: new Date("2026-03-14T10:00:00Z").toISOString(),
      ...overrides,
    };
  }

  /** The section a suggestion has to be inside, not merely somewhere on screen. */
  function externalSuggestionsSection() {
    const heading = screen.getByText("Suggested from other apps");
    const section = heading.closest("div.border-t");
    if (!section) {
      throw new Error("The other-apps section has no container to scope to.");
    }
    return within(section as HTMLElement);
  }

  it("shows a correction read back from another app in its own section, naming the app", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
    ]);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    expect(
      await section.findByText(/cuban netties -> kubernetes/i),
    ).toBeInTheDocument();
    expect(section.getByText(/Corrected in Slack/i)).toBeInTheDocument();
  });

  it("keeps corrections made inside Plainsong out of the other-apps section", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
      {
        id: "in-app-1",
        originalText: "jon will join",
        correctedText: "John will join",
        spokenForm: "jon",
        replacement: "John",
        appTarget: "Slack",
        source: null,
        createdAt: new Date("2026-03-14T09:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T09:00:00Z").toISOString(),
      },
    ]);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    expect(
      await section.findByText(/cuban netties -> kubernetes/i),
    ).toBeInTheDocument();
    expect(section.queryByText(/jon -> John/i)).not.toBeInTheDocument();
    // The in-app edit is still in the inbox above, unchanged.
    expect(screen.getByText(/jon -> John/i)).toBeInTheDocument();
  });

  it("adds a correction read back from another app to the dictionary only when approved", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
    ]);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    await section.findByText(/cuban netties -> kubernetes/i);
    // Nothing has been learned from merely showing it.
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();

    fireEvent.click(section.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith(
        "external-1",
      );
    });
  });

  it("drops a correction read back from another app when it is dismissed", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
    ]);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    await section.findByText(/cuban netties -> kubernetes/i);
    fireEvent.click(section.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith(
        "external-1",
      );
    });
    await waitFor(() => {
      expect(
        externalSuggestionsSection().queryByText(
          /cuban netties -> kubernetes/i,
        ),
      ).not.toBeInTheDocument();
    });
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();
  });

  it("states plainly that nothing is being read while the setting is off", async () => {
    render(<DictationView />);
    await openConfigTab("Corrections");

    const toggle = await screen.findByRole("checkbox", {
      name: /Learn from corrections you make in other apps/i,
    });
    expect(toggle).not.toBeChecked();
    expect(
      externalSuggestionsSection().getByText(
        /Plainsong is not reading any other app's text/i,
      ),
    ).toBeInTheDocument();
  });

  it("says exactly what turning the setting on lets Plainsong read", async () => {
    render(<DictationView />);
    await openConfigTab("Corrections");

    const copy = await screen.findByText(
      /Plainsong re-reads the one field it just typed into/i,
    );
    // The promises the copy has to make, in the user's own words.
    expect(copy).toHaveTextContent(/only that field/i);
    expect(copy).toHaveTextContent(/only for the 8 seconds after the insert/i);
    expect(copy).toHaveTextContent(/on this machine; nothing is sent anywhere/i);
    expect(copy).toHaveTextContent(
      /If you switch apps or put the cursor in another field, Plainsong stops and reads nothing/i,
    );
  });

  it("does not claim candidates go unwritten until they are approved", async () => {
    // They are written to the suggestions table the moment a readback
    // completes — that is what the inbox reads from. The copy has to describe
    // what is stored, where, and when it goes away, not imply nothing is.
    render(<DictationView />);
    await openConfigTab("Corrections");

    const copy = await screen.findByText(
      /Plainsong re-reads the one field it just typed into/i,
    );
    expect(copy).toHaveTextContent(
      /The only thing written down is the word-level changes it finds, held here for your review/i,
    );
    expect(copy).toHaveTextContent(/never the sentence they came out of/i);
    expect(copy).toHaveTextContent(
      /anything you don't approve is deleted within a week/i,
    );
    expect(copy).not.toHaveTextContent(/Nothing is kept except/i);
  });

  it("persists the other-apps setting when it is switched on", async () => {
    render(<DictationView />);
    await openConfigTab("Corrections");

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /Learn from corrections you make in other apps/i,
      }),
    );

    await waitFor(() => {
      const calls = backendMocks.saveSettings.mock.calls as unknown as Array<
        [{ transcription: { dictationLearnFromExternalCorrections?: boolean } }]
      >;
      const saved = calls[calls.length - 1]?.[0];
      expect(saved?.transcription.dictationLearnFromExternalCorrections).toBe(
        true,
      );
    });
  });

  it("does not raise the other-apps card before the habit is there", async () => {
    // The default fixture has three dictations behind it.
    render(<DictationView />);
    await openConfigTab("Corrections");

    await screen.findByText("Correction inbox");
    expect(
      screen.queryByText("Corrections you make elsewhere"),
    ).not.toBeInTheDocument();
  });

  /** Put enough dictations behind the fixture for the card to be offered. */
  async function withEnoughDictationsForTheCard() {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationInsights).mockResolvedValueOnce({
      totalDictations: 12,
      dictatedWords: 900,
      averageWordsPerDictation: 75,
      activeDays: 6,
      lastSevenDaysDictations: 9,
      commandsUsed: 2,
      backtracksUsed: 1,
      snippetsTriggered: 3,
      topAppTarget: "Slack",
      topAppTargetCount: 7,
    });
  }

  it("raises the other-apps card once, and never again after it is closed", async () => {
    await withEnoughDictationsForTheCard();
    const first = render(<DictationView />);
    await openConfigTab("Corrections");

    expect(
      await screen.findByText("Corrections you make elsewhere"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(
      screen.queryByText("Corrections you make elsewhere"),
    ).not.toBeInTheDocument();
    // Closing it must not turn anything on.
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
    first.unmount();

    await withEnoughDictationsForTheCard();
    render(<DictationView />);
    await openConfigTab("Corrections");
    await screen.findByText("Correction inbox");
    expect(
      screen.queryByText("Corrections you make elsewhere"),
    ).not.toBeInTheDocument();
  });

  it("turns the setting on from the card and stops offering it", async () => {
    await withEnoughDictationsForTheCard();
    render(<DictationView />);
    await openConfigTab("Corrections");

    fireEvent.click(
      await screen.findByRole("button", { name: "Turn it on" }),
    );

    await waitFor(() => {
      const calls = backendMocks.saveSettings.mock.calls as unknown as Array<
        [{ transcription: { dictationLearnFromExternalCorrections?: boolean } }]
      >;
      const saved = calls[calls.length - 1]?.[0];
      expect(saved?.transcription.dictationLearnFromExternalCorrections).toBe(
        true,
      );
    });
    expect(
      screen.queryByText("Corrections you make elsewhere"),
    ).not.toBeInTheDocument();
  });

  it("never raises the other-apps card when the setting is already on", async () => {
    backendMocks.transcriptionOverrides.dictationLearnFromExternalCorrections =
      true;
    await withEnoughDictationsForTheCard();

    render(<DictationView />);
    await openConfigTab("Corrections");

    await screen.findByText("Correction inbox");
    expect(
      screen.queryByText("Corrections you make elsewhere"),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("checkbox", {
        name: /Learn from corrections you make in other apps/i,
      }),
    ).toBeChecked();
  });

  it("refreshes the inbox when the sidecar queues a readback suggestion", async () => {
    const backend = await import("@/lib/backend/dictation");
    render(<DictationView />);
    await openConfigTab("Corrections");
    await screen.findByText("Correction inbox");

    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
    ]);
    const handler = backendMocks.eventListeners.get(
      "dictation-correction-suggestions-changed",
    );
    expect(handler).toBeTypeOf("function");
    await act(async () => {
      handler?.({ payload: { queued: 1, appTarget: "Slack" } });
    });

    expect(
      await externalSuggestionsSection().findByText(
        /cuban netties -> kubernetes/i,
      ),
    ).toBeInTheDocument();
  });

  /** Put the fixture on a multilingual route so the picker has a list at all. */
  function selectMultilingualRoute() {
    backendMocks.transcriptionOverrides.defaultProvider = "whisper";
    backendMocks.transcriptionOverrides.selectedModelId = "large-v3-turbo";
    backendMocks.transcriptionOverrides.dictationProvider = "whisper";
    backendMocks.transcriptionOverrides.dictationModelId = "large-v3-turbo";
  }

  async function pickLanguage(comboboxName: RegExp | string, option: RegExp) {
    fireEvent.click(await screen.findByRole("combobox", { name: comboboxName }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  }

  it("tells the reader in plain words when the transcription engine is lost", async () => {
    // ux-10: engine loss reached users as "Sidecar process exited (code=…,
    // signal=…)", and only on the Setup view — never here, where they dictate.
    readinessContext.engineNotice = {
      title: "The local transcription engine stopped",
      message: "Plainsong is restarting it now.",
      recovering: true,
    };

    render(<DictationView />);

    expect(
      await screen.findByText("The local transcription engine stopped"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/code=/)).not.toBeInTheDocument();

    const banner = screen.getByRole("status", {
      name: "The local transcription engine stopped",
    });
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(readinessContext.dismissEngineNotice).toHaveBeenCalled();
  });

  it("persists the session language separately from flow profiles", async () => {
    selectMultilingualRoute();
    render(<DictationView />);

    await openConfigTab("Capture");
    await pickLanguage("Session language", /^Spanish$/);

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.language).toBe("es");
  });

  it("locks auto dictation to a single active language when the set has one item", async () => {
    selectMultilingualRoute();
    render(<DictationView />);

    await openConfigTab("Capture");
    await pickLanguage(/add a language you speak/i, /^French$/);
    fireEvent.click(screen.getByRole("button", { name: /start dictation/i }));

    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          languageOverride: "fr",
        })
      );
    });
  });

  it("offers the whole language set the selected model accepts", async () => {
    // ux-6: the picker was a hardcoded seven against models that accept ~100.
    selectMultilingualRoute();
    render(<DictationView />);

    await openConfigTab("Capture");
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Session language" }),
    );

    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(50);
    expect(screen.getByRole("option", { name: /^Auto detect$/ })).toBeInTheDocument();
    // None of these were reachable from the old seven.
    for (const language of ["Ukrainian", "Swahili", "Vietnamese", "Cantonese"]) {
      expect(
        screen.getByRole("option", { name: new RegExp(`^${language}$`) }),
      ).toBeInTheDocument();
    }
  });

  it("stops at the selected model's boundary instead of the widest list", async () => {
    // Parakeet v3 covers 25 European languages; Mandarin is not one of them,
    // and offering it would promise a transcript the model cannot produce.
    backendMocks.transcriptionOverrides.defaultProvider = "parakeet";
    backendMocks.transcriptionOverrides.selectedModelId = "parakeet-tdt-0.6b-v3";
    backendMocks.transcriptionOverrides.dictationProvider = "parakeet";
    backendMocks.transcriptionOverrides.dictationModelId = "parakeet-tdt-0.6b-v3";
    render(<DictationView />);

    await openConfigTab("Capture");
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Session language" }),
    );

    expect(screen.getByRole("option", { name: /^Ukrainian$/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Chinese$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Hindi$/ })).not.toBeInTheDocument();
  });

  it("explains an English-only model instead of showing one lonely option", async () => {
    // The fixture's own route is distil-large-v3.5, which is English-only.
    render(<DictationView />);

    await openConfigTab("Capture");

    expect(
      await screen.findByText(/transcribes English only/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Session language" }),
    ).not.toBeInTheDocument();
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
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";

    render(<DictationView />);

    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    expect(
      screen.getByText(/UsefulSensors Moonshine · Moonshine Base is not on this Mac/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download usefulsensors moonshine/i }),
    ).toBeEnabled();

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
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";
    backendMocks.downloadAsrModels.mockImplementationOnce(async () => {
      backendMocks.asrProviders = backendMocks.buildAsrProviders();
    });

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", { name: /download usefulsensors moonshine/i }),
    );

    await waitFor(() => {
      expect(backendMocks.downloadAsrModels).toHaveBeenCalledWith(
        "moonshine",
        "moonshine-base"
      );
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
    const card = toggle.closest(".rounded-md");
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
