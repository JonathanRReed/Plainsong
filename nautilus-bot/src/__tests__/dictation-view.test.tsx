import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationView } from "@/components/views/dictation-view";

const tauriMocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
  saveSettings: vi.fn(async () => {}),
  refetchDictationHistory: vi.fn(),
  getSettings: vi.fn(async () => ({
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
    dictationCopyToClipboard: true,
    dictationCommandModeEnabled: true,
    dictationCommandPrefix: "command",
    dictationInsertionMode: "auto" as const,
    dictationContextSource: "none" as const,
    dictationModePreset: "voice" as const,
    dictationSelectedCustomModeId: null,
    dictationCustomModes: [],
    dictationSnippetsEnabled: true,
    dictationRetentionPreset: "never" as const,
    dictationRetentionCustomHours: 24,
    memorySearchMode: "fts" as const,
    embeddingModel: "nomic-embed-text",
  },
  ui: {
    alwaysOnTop: false,
    showInDock: true,
    minimizeToTray: true,
    startMinimized: false,
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
  updates: {
    channel: "stable" as const,
    autoCheck: true,
    lastCheckAt: null,
    lastSeenVersion: null,
  },
  defaultTemplate: "meeting",
  theme: "system" as const,
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    tauriMocks.eventListeners.set(eventName, handler);
    return () => {
      tauriMocks.eventListeners.delete(eventName);
    };
  }),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    isRecording: false,
    formattedDuration: "0:00",
    startDictation: vi.fn(),
    stopDictation: vi.fn(async () => ""),
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
    refetch: tauriMocks.refetchDictationHistory,
  }),
}));

vi.mock("@/lib/tauri", () => ({
  getSettings: tauriMocks.getSettings,
  saveSettings: tauriMocks.saveSettings,
  getTranscript: vi.fn(),
  reprocessDictationText: vi.fn(),
  listDictationSnippets: vi.fn(async () => []),
  createDictationSnippet: vi.fn(),
  updateDictationSnippet: vi.fn(),
  deleteDictationSnippet: vi.fn(),
  listDictationCommandPresets: vi.fn(async () => []),
  upsertDictationCommandPreset: vi.fn(),
  deleteDictationCommandPreset: vi.fn(),
}));

describe("DictationView modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.eventListeners.clear();
  });

  it("renders the new mode presets", async () => {
    render(<DictationView />);

    await screen.findByText("Modes");
    expect(screen.getByRole("button", { name: /voice/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /messages/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /meeting follow-up/i })).toBeInTheDocument();
  });

  it("applies Messages mode defaults and persists them", async () => {
    render(<DictationView />);

    await screen.findByText("Modes");
    fireEvent.click(screen.getByRole("button", { name: /messages/i }));

    await waitFor(() => {
      expect(tauriMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = tauriMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestCall = saveCalls[saveCalls.length - 1];
    expect(latestCall).toBeTruthy();
    const latestSettings = latestCall![0];
    expect(latestSettings.transcription.dictationModePreset).toBe("messages");
    expect(latestSettings.transcription.dictationProfile).toBe("normal_speed");
    expect(latestSettings.transcription.dictationInsertionMode).toBe("paste");
    expect(latestSettings.transcription.dictationContextSource).toBe("none");
    expect(latestSettings.transcription.dictationSaveToInbox).toBe(false);
    expect(latestSettings.transcription.dictationCopyToClipboard).toBe(true);
    expect(latestSettings.transcription.dictationCommandModeEnabled).toBe(false);
  });

  it("saves the current setup as a reusable custom mode", async () => {
    render(<DictationView />);

    await screen.findByText("Modes");
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));

    const nameInput = await screen.findByLabelText("Mode name");
    fireEvent.change(nameInput, { target: { value: "Sales Follow-up" } });
    fireEvent.change(screen.getByLabelText("Auto-activate for domain"), {
      target: { value: "gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save current setup/i }));

    await waitFor(() => {
      expect(tauriMocks.saveSettings).toHaveBeenCalled();
    });

    const saveCalls = tauriMocks.saveSettings.mock.calls as unknown as Array<[any]>;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationModePreset).toBe("custom");
    expect(latestSettings.transcription.dictationSelectedCustomModeId).toBeTruthy();
    expect(latestSettings.transcription.dictationCustomModes).toHaveLength(1);
    expect(latestSettings.transcription.dictationCustomModes[0].name).toBe("Sales Follow-up");
    expect(latestSettings.transcription.dictationCustomModes[0].activationDomainMatcher).toBe(
      "gmail.com"
    );
  });

  it("refreshes dictation history when a dictation result event arrives", async () => {
    render(<DictationView />);

    await screen.findByText("Modes");
    const handler = tauriMocks.eventListeners.get("dictation-text-ready");
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
      expect(tauriMocks.refetchDictationHistory).toHaveBeenCalled();
    });
  });

  it("surfaces auto-activated app matcher details in the latest result", async () => {
    render(<DictationView />);

    await screen.findByText("Modes");
    const handler = tauriMocks.eventListeners.get("dictation-text-ready");
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
});
