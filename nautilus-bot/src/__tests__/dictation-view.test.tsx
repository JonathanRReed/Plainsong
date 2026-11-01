import type { DictationDraft } from "@/lib/backend/dictation-drafts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationView } from "@/components/views/dictation-view";
import {
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS,
  SPOKEN_COMMAND_PREFIX_LABEL,
} from "@/lib/selected-text-actions";
import { DICTATION_PROFILE_TILES } from "@/lib/dictation-profiles";
import {
  buildProductReadinessSnapshot,
  type ProductReadinessEvidence,
  type ProductReadinessSnapshot,
} from "@/features/readiness/product-readiness";
import type {
  DictationDictionaryEntry,
  DictationReprocessOutcome,
} from "@/lib/backend/dictation";
import type { CorrectionApprovalDictionarySnapshot, DictationCorrectionSuggestion } from "@/lib/backend";
import type { Recording } from "@/types";
import type { Settings } from "@/types/settings";
import { OPEN_MAIN_VIEW_EVENT, canLeaveMainView, queueDictationHistoryRequest, consumePendingDictationHistoryRequest } from "@/lib/navigation";
import * as backend from "@/lib/backend";
import * as dictationApi from "@/lib/backend/dictation";

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
  productReadinessEvidence: null as ProductReadinessEvidence | null,
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

const audioPlayerMock = vi.hoisted(() => ({
  props: [] as Array<{
    recordingId: string;
    waveform: number[];
    durationHint?: number;
    onError?: () => void;
  }>,
  mountedRecordingIds: [] as string[],
  unmountedRecordingIds: [] as string[],
}));

vi.mock("@/components/meetings/audio-player", async () => {
  const { useEffect } = await import("react");

  return {
    AudioPlayer: (props: {
      recordingId: string;
      waveform: number[];
      durationHint?: number;
      onError?: () => void;
    }) => {
      audioPlayerMock.props.push(props);
      useEffect(() => {
        audioPlayerMock.mountedRecordingIds.push(props.recordingId);
        return () => {
          audioPlayerMock.unmountedRecordingIds.push(props.recordingId);
        };
      }, []);

      return (
        <div
          data-testid="original-audio-player"
          data-recording-id={props.recordingId}
          data-duration-hint={props.durationHint}
          data-waveform={JSON.stringify(props.waveform)}
        >
          <button type="button" onClick={props.onError}>
            Simulate original audio error
          </button>
        </div>
      );
    },
  };
});

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
  privacyOverrides: {} as Record<string, unknown>,
  saveSettings: vi.fn(async (_settings: Settings) => {}),
  updateSettings: vi.fn<(mutator: (draft: Settings) => void) => Promise<void>>(),
  settingsWriteTail: Promise.resolve(),
  persistedSettings: null as Settings | null,
  setDictationExternalCorrectionLearning: vi.fn(async (enabled: boolean) => enabled),
  refetchDictationHistory: vi.fn(),
  recordings: [] as Recording[],
  recordingsError: null as string | null,
  deleteRecording: vi.fn(async () => {}),
  startDictation: vi.fn(async () => {}),
  stopDictation: vi.fn(async () => ""),
  invoke: vi.fn(async (_command: string, _params?: unknown): Promise<unknown> => ({ pasted: true, copied: false })),
  asrProviders: [] as any[],
  getAsrProviders: vi.fn(),
  downloadAsrModels: vi.fn(async () => {}),
  listOllamaModelCatalog: vi.fn(async () => [] as any[]),
  listOllamaModels: vi.fn(async () => [] as string[]),
  getNativeTextModelStatus: vi.fn(),
  getLocalTextRuntimeHealth: vi.fn(),
  cancelAnalysisRun: vi.fn(async () => {}),
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
  getDictationHistoryDetails: vi.fn(async (): Promise<any> => null),
  searchDictationHistory: vi.fn(async (_query: string): Promise<any[]> => []),
  getRecording: vi.fn(async (_recordingId: string): Promise<Recording | null> => null),
  reprocessDictationText: vi.fn(async (_text: string, _mode: string, _appTarget?: string | null, _options?: { runId?: string }): Promise<any> => null),
  reprocessDictation: vi.fn(async (): Promise<any> => null),
  getTranscript: vi.fn(async (_recordingId: string): Promise<any> => null),
  getDictationEdit: vi.fn(async (_recordingId: string) => ({ text: null as string | null })),
  listDictationDrafts: vi.fn(async (): Promise<DictationDraft[]> => []),
  saveDictationDraft: vi.fn(async (): Promise<void> => undefined),
  clearDictationDraft: vi.fn(async () => true),
  stageSavedDictationResult: vi.fn(async () => ({ text: "Edited latest text" })),
  saveDictationEdit: vi.fn(async (_recordingId: string, text: string | null) => ({ text })),
}));

function resetDictationIoMocks() {
  backendMocks.settingsWriteTail = Promise.resolve();
  backendMocks.persistedSettings = null;
  for (const value of Object.values(dictationApi)) {
    if (vi.isMockFunction(value)) value.mockReset();
  }
  backendMocks.getTranscript.mockReset().mockResolvedValue(null);
  backendMocks.getDictationEdit.mockReset().mockResolvedValue({ text: null });
  backendMocks.saveDictationEdit.mockReset().mockImplementation(async (_recordingId, text) => ({ text }));
  backendMocks.getRecording.mockReset().mockResolvedValue(null);
  backendMocks.getDictationHistoryDetails.mockReset().mockResolvedValue(null);
  backendMocks.searchDictationHistory.mockReset().mockResolvedValue([]);
  backendMocks.listDictationDrafts.mockReset().mockResolvedValue([]);
  backendMocks.saveDictationDraft.mockReset().mockResolvedValue(undefined);
  backendMocks.clearDictationDraft.mockReset().mockResolvedValue(true);
  backendMocks.stageSavedDictationResult.mockReset().mockResolvedValue({ text: "Edited latest text" });
  backendMocks.reprocessDictationText.mockReset().mockResolvedValue(null);
  backendMocks.reprocessDictation.mockReset().mockResolvedValue(null);
}

backendMocks.getSettings.mockImplementation(async () => {
  if (backendMocks.persistedSettings) return structuredClone(backendMocks.persistedSettings);
  const settings = backendMocks.buildSettings();
  Object.assign(settings.transcription, backendMocks.transcriptionOverrides);
  Object.assign(settings.privacy, backendMocks.privacyOverrides);
  return settings;
});
backendMocks.updateSettings.mockImplementation((mutator) => {
  const write = backendMocks.settingsWriteTail.then(async () => {
    const loaded = await backendMocks.getSettings();
    const settings = structuredClone(backendMocks.persistedSettings ?? loaded);
    mutator(settings);
    await backendMocks.saveSettings(structuredClone(settings));
    backendMocks.persistedSettings = settings;
  });
  backendMocks.settingsWriteTail = write.catch(() => {});
  return write;
});
backendMocks.getAsrProviders.mockImplementation(
  async () => backendMocks.asrProviders,
);

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    backendMocks.eventListeners.set(eventName, handler);
    return () => {
      backendMocks.eventListeners.delete(eventName);
    };
  }),
  invoke: backendMocks.invoke,
}));

const recordingSessionState = vi.hoisted(() => ({
  isRecording: false,
  recordingMode: null as "dictation" | "meeting" | null,
  meetingPhase: "idle" as "idle" | "preparing" | "recording" | "stopping" | "processing" | "ready" | "error" | "cancelled" | "recoverable",
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    isRecording: recordingSessionState.isRecording,
    recordingMode: recordingSessionState.recordingMode,
    meetingPhase: recordingSessionState.meetingPhase,
    formattedDuration: "0:00",
    startDictation: backendMocks.startDictation,
    stopDictation: backendMocks.stopDictation,
  }),
  useRecordingSession: () => ({
    isRecording: recordingSessionState.isRecording,
    recordingMode: recordingSessionState.recordingMode,
    meetingPhase: recordingSessionState.meetingPhase,
    startDictation: backendMocks.startDictation,
    stopDictation: backendMocks.stopDictation,
  }),
  RecordingDurationText: () => "0:00",
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
    error: backendMocks.recordingsError,
    refetch: backendMocks.refetchDictationHistory,
  }),
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: backendMocks.getSettings,
  updateSettings: backendMocks.updateSettings,
  setDictationExternalCorrectionLearning: backendMocks.setDictationExternalCorrectionLearning,
}));

vi.mock("@/lib/backend/recordings", () => ({
  getRecording: backendMocks.getRecording,
  getTranscript: backendMocks.getTranscript,
  deleteRecording: backendMocks.deleteRecording,
}));

vi.mock("@/lib/backend/dictation-drafts", () => ({
  listDictationDrafts: backendMocks.listDictationDrafts,
  saveDictationDraft: backendMocks.saveDictationDraft,
  clearDictationDraft: backendMocks.clearDictationDraft,
}));

vi.mock("@/lib/backend/dictation-shortcut-result", () => ({ stageSavedDictationResult: backendMocks.stageSavedDictationResult }));

vi.mock("@/lib/backend/dictation-edits", () => ({
  getDictationEdit: backendMocks.getDictationEdit,
  saveDictationEdit: backendMocks.saveDictationEdit,
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviders: backendMocks.getAsrProviders,
  listDownloadedModels: vi.fn(async () => []),
  downloadAsrModels: backendMocks.downloadAsrModels,
}));

vi.mock("@/lib/backend/ai", () => ({
  cancelAnalysisRun: backendMocks.cancelAnalysisRun,
  getLivePreviewEngineStatus: vi.fn(async () => null),
  getNativeTextModelStatus: backendMocks.getNativeTextModelStatus,
  getLocalTextRuntimeHealth: backendMocks.getLocalTextRuntimeHealth,
  listOllamaModelCatalog: backendMocks.listOllamaModelCatalog,
  listOllamaModels: backendMocks.listOllamaModels,
}));

vi.mock("@/lib/backend/dictation", () => ({
  EXTERNAL_APP_CORRECTION_SOURCE: "external_app_readback",
  getDictationHistoryDetails: backendMocks.getDictationHistoryDetails,
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
  reprocessDictationText: backendMocks.reprocessDictationText,
  searchDictationHistory: backendMocks.searchDictationHistory,
  reprocessDictation: backendMocks.reprocessDictation,
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
      approvalDictionary: { kind: "missing" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })),
  approveDictationCorrectionSuggestion: vi.fn(async () => ({
    learned: true,
    action: "created",
    undoToken: "undo-token-1",
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
  undoDictationCorrectionApproval: vi.fn(async (_token: string): Promise<{
    entryId: string;
    entry: any | null;
  }> => ({ entryId: "learned-1", entry: null })),
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

function createSavedTranscript(
  recordingId: string,
  fullText: string,
) {
  return {
    id: `transcript-${recordingId}`,
    recordingId,
    segments: [],
    fullText,
    language: "en",
    confidence: 0.93,
    model: "parakeet",
    modelId: "parakeet-tdt-0.6b-v3",
    requestedProvider: "parakeet",
    actualProvider: "parakeet",
    createdAt: "2026-08-01T12:00:12.000Z",
  };
}

function correctionSuggestionFixture(
  id: string,
  spokenForm: string,
  replacement: string,
  originalText = `Please email ${spokenForm} tomorrow.`,
  approvalDictionary: CorrectionApprovalDictionarySnapshot = { kind: "missing" },
) {
  return {
    id,
    originalText,
    correctedText: originalText.replace(spokenForm, replacement),
    spokenForm,
    replacement,
    appTarget: "Mail",
    source: null,
    approvalDictionary,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
  };
}

function dictionaryEntryFixture(
  overrides: Partial<DictationDictionaryEntry> = {},
): DictationDictionaryEntry {
  return {
    id: "learned-1",
    spokenForm: "jon",
    replacement: "John",
    appScope: null,
    caseSensitive: false,
    enabled: true,
    categoryScope: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function forceStopCalls() {
  return backendMocks.invoke.mock.calls.filter(
    ([command]) => command === "force_stop_dictation",
  );
}

function readyProductEvidence(
  overrides: Partial<ProductReadinessEvidence> = {},
): ProductReadinessEvidence {
  return {
    observedAt: 1,
    loading: false,
    error: null,
    settingsLoaded: true,
    providersLoaded: true,
    microphonePermissionReady: true,
    microphoneDeviceReady: true,
    dictationRouteReady: true,
    dictationRouteReason: null,
    cursorInsertionRequired: true,
    cursorInsertionReady: true,
    meetingRouteReady: true,
    meetingRouteReason: null,
    meetingNotesRoute: "ready",
    meetingNotesRouteReason: null,
    systemAudioState: "ready",
    ...overrides,
  };
}

function useMissingLocalDictationRoute(
  overrides: Partial<ProductReadinessEvidence> = {},
) {
  const evidence = readyProductEvidence({
    dictationRouteReady: false,
    dictationRouteReason: "Download the local speech model.",
    ...overrides,
  });
  readinessContext.productReadinessEvidence = evidence;
  readinessContext.productReadiness = buildProductReadinessSnapshot(evidence);
  backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
  backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
  backendMocks.transcriptionOverrides.dictationProvider = "moonshine";
  backendMocks.transcriptionOverrides.dictationModelId = "moonshine-base";
  backendMocks.transcriptionOverrides.dictationRoutePreference = "local";
  backendMocks.transcriptionOverrides.dictationRouteOverrideEnabled = true;
  backendMocks.asrProviders = backendMocks.buildAsrProviders();
  backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
  backendMocks.asrProviders[0].runtimeStatus = "missing_model";
}

async function chooseOneOffRoute(name: "This Mac" | "The cloud" | "Profile default") {
  await openConfigTab("Profiles");
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("DictationView modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDictationIoMocks();
    backendMocks.invoke.mockImplementation(async () => ({ pasted: true, copied: false }));
    // Every test starts on a machine that has never seen this view before —
    // the one-time cards below are remembered in localStorage.
    window.localStorage.clear();
    backendMocks.eventListeners.clear();
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.getAsrProviders.mockImplementation(
      async () => backendMocks.asrProviders,
    );
    backendMocks.recordings = [];
    backendMocks.recordingsError = null;
    recordingSessionState.isRecording = false;
    recordingSessionState.recordingMode = null;
    recordingSessionState.meetingPhase = "idle";
    backendMocks.listOllamaModelCatalog.mockResolvedValue([]);
    backendMocks.listOllamaModels.mockResolvedValue([]);
    backendMocks.getNativeTextModelStatus.mockResolvedValue(null);
    backendMocks.getLocalTextRuntimeHealth.mockResolvedValue({
      localGateApplies: true,
      runtimeHealth: { state: "available", message: null },
    });
    readinessContext.engineNotice = null;
    readinessContext.productReadinessEvidence = null;
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
    for (const key of Object.keys(backendMocks.privacyOverrides)) {
      delete backendMocks.privacyOverrides[key];
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

  it("switches the capture profile without opening setup", async () => {
    render(<DictationView />);
    const picker = await screen.findByRole("combobox", { name: "Capture profile" });
    await waitFor(() => expect(picker).toHaveTextContent("General"));
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Writing" }));
    await waitFor(() => expect(picker).toHaveTextContent("Writing"));
    expect(screen.getByRole("button", { name: "Profile: Writing" })).toHaveAttribute("aria-pressed", "true");
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

  it("explains that Writing needs a capable rewrite model", async () => {
    backendMocks.privacyOverrides.dictationAi = {
      provider: "bundled_local",
      modelId: "s1-mini",
    };
    const navigationListener = vi.fn();
    window.addEventListener(OPEN_MAIN_VIEW_EVENT, navigationListener);

    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));

    expect(
      await screen.findByRole("alert", {
        name: "Writing needs a rewrite model",
      }),
    ).toHaveTextContent(/can clean up dictation.*cannot follow rewrite instructions/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose rewrite model" }),
    );
    const navigationEvent = navigationListener.mock.calls[
      navigationListener.mock.calls.length - 1
    ]?.[0] as CustomEvent;
    expect(
      navigationEvent.detail,
    ).toEqual({ view: "settings" });

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, navigationListener);
  });

  it("allows Writing with a ready native text model while Ollama is stopped", async () => {
    const ollamaStatus = vi.spyOn(backend, "getOllamaStatus").mockResolvedValue(false);
    backendMocks.privacyOverrides.dictationAi = {
      provider: "native_text",
      modelId: "qwen3-4b-instruct-2507-q4_k_m",
    };
    backendMocks.getNativeTextModelStatus.mockResolvedValue({
      modelId: "qwen3-4b-instruct-2507-q4_k_m",
      runtimePresent: true,
      runtimeHealth: { state: "available", message: null },
      ready: true,
      memoryAvailableBytes: 20_000_000_000,
      canLoadNow: true,
    });

    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));

    await waitFor(() => expect(backendMocks.getNativeTextModelStatus).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Checking rewrite model" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("alert", { name: "Rewrite model is not ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Writing needs a rewrite model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose rewrite model" })).not.toBeInTheDocument();
    expect(ollamaStatus).not.toHaveBeenCalled();
    ollamaStatus.mockRestore();
  });

  it.each(["completion_unknown", "storage_error", "busy"])("retains the Writing Ollama execution cause: %s", async (state) => {
    const cause = state === "busy" ? "Another local text operation is running." : "Local AI is paused.";
    backendMocks.privacyOverrides.dictationAi = {
      provider: "ollama", modelId: "qwen3.5:4b",
    };
    backendMocks.listOllamaModels.mockResolvedValue(["qwen3.5:4b"]);
    backendMocks.getLocalTextRuntimeHealth.mockResolvedValue({
      localGateApplies: true, runtimeHealth: { state, message: cause },
    });
    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));
    expect(await screen.findByRole(state === "busy" ? "status" : "alert", {
      name: state === "busy" ? "Rewrite model is not ready" : "Ollama is not ready",
    })).toHaveTextContent(cause);
    expect(screen.queryByText(/Start Ollama and choose/)).not.toBeInTheDocument();
    expect(backendMocks.getLocalTextRuntimeHealth).toHaveBeenCalledWith("qwen3.5:4b");
  });

  it.each([false, true])("uses remote consent for Writing with an Ollama alias: %s", async (remoteProcessingEnabled) => {
    backendMocks.privacyOverrides.dictationAi = {
      provider: "ollama", modelId: "remote:latest",
    };
    backendMocks.privacyOverrides.remoteProcessingEnabled = remoteProcessingEnabled;
    backendMocks.listOllamaModels.mockResolvedValue(["remote:latest"]);
    backendMocks.getLocalTextRuntimeHealth.mockResolvedValue({
      localGateApplies: false,
      runtimeHealth: { state: "completion_unknown", message: "Local AI is paused." },
    });
    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));
    await waitFor(() => expect(backendMocks.getLocalTextRuntimeHealth).toHaveBeenCalledWith("remote:latest"));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Checking rewrite model" })).not.toBeInTheDocument());
    const warning = screen.queryByRole("alert", { name: "Ollama is not ready" });
    if (remoteProcessingEnabled) {
      expect(warning).not.toBeInTheDocument();
    } else {
      expect(warning).toHaveTextContent("The selected Ollama model runs remotely, but remote processing is disabled.");
      expect(screen.queryByText(/Start Ollama and choose/)).not.toBeInTheDocument();
    }
  });

  it.each(["completion_unknown", "storage_error", "busy"])("retains the Writing native execution cause: %s", async (state) => {
    const cause = state === "busy" ? "Another local text operation is running." : "The previous local text operation has not finished.";
    backendMocks.privacyOverrides.dictationAi = { provider: "native_text", modelId: null };
    backendMocks.getNativeTextModelStatus.mockResolvedValue({
      modelId: "qwen3-4b-instruct-2507-q4_k_m", runtimePresent: true, ready: true,
      runtimeHealth: { state, message: cause },
      memoryAvailableBytes: 20_000_000_000, canLoadNow: true,
    });
    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));
    expect(await screen.findByRole(state === "busy" ? "status" : "alert", { name: "Rewrite model is not ready" }))
      .toHaveTextContent(cause);
    expect(screen.queryByText(/credentials|Start Ollama and choose/)).not.toBeInTheDocument();
  });

  it.each([
    [{ ready: false }, "Download and verify the built-in text model before using this profile."],
    [{ canLoadNow: false }, "Not enough free memory right now. Close apps you aren't using, or try again later."],
  ] as const)("names the Writing native file or memory blocker: %o", async (override, message) => {
    backendMocks.privacyOverrides.dictationAi = { provider: "native_text", modelId: null };
    backendMocks.getNativeTextModelStatus.mockResolvedValue({
      modelId: "qwen3-4b-instruct-2507-q4_k_m", runtimePresent: true, ready: true,
      runtimeHealth: { state: "available", message: null },
      memoryAvailableBytes: 20_000_000_000, canLoadNow: true, ...override,
    });
    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));
    expect(await screen.findByRole("alert", { name: "Rewrite model is not ready" })).toHaveTextContent(message);
    expect(screen.queryByText(/credentials/)).not.toBeInTheDocument();
  });

  it("checks the selected Ollama model and refreshes after model settings change", async () => {
    backendMocks.privacyOverrides.dictationAi = {
      provider: "ollama",
      modelId: "missing:latest",
    };
    backendMocks.listOllamaModelCatalog.mockResolvedValue([
      {
        id: "qwen3.5:4b",
        installed: true,
        ready: true,
        lanes: ["dictation"],
      },
    ]);
    backendMocks.listOllamaModels.mockResolvedValue(["qwen3.5:4b"]);

    render(<DictationView />);
    await openConfigTab("Profiles");
    fireEvent.click(screen.getByRole("button", { name: "Profile: Writing" }));

    expect(
      await screen.findByRole("alert", { name: "Ollama is not ready" }),
    ).toBeInTheDocument();

    const changedSettings = backendMocks.buildSettings();
    Object.assign(changedSettings.transcription, {
      dictationProfile: "power_rewrite",
      dictationModePreset: "email",
    });
    changedSettings.privacy.dictationAi = {
      provider: "ollama",
      modelId: null,
    };
    act(() => {
      backendMocks.eventListeners.get("settings-changed")?.({
        payload: changedSettings,
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("alert", { name: "Ollama is not ready" }),
      ).not.toBeInTheDocument();
    });
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
    expect(screen.queryByText("Ready to record")).not.toBeInTheDocument();
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

  it("shows the primary binding hold override when global capture is toggle", async () => {
    const settings: Settings = await backendMocks.getSettings();
    settings.shortcuts.toggleDictation = "RightCommand";
    settings.shortcuts.dictationBindings = [{
      id: "primary",
      trigger: { kind: "key", accelerator: "RightCommand" },
      action: { kind: "dictation", modeId: null, behavior: "hold" },
    }];
    settings.transcription.dictationPushToTalk = false;
    settings.transcription.dictationHandsFreeEnabled = false;
    backendMocks.persistedSettings = settings;

    render(<DictationView />);

    expect(await screen.findByText("hold to talk")).toBeInTheDocument();
    expect(screen.getByText(/Hold Right Command to record, release to transcribe and paste/)).toBeInTheDocument();
    expect(settings.transcription.dictationPushToTalk).toBe(false);
    expect(settings.transcription.dictationHandsFreeEnabled).toBe(false);
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

    fireEvent.click(
      await screen.findByRole("combobox", { name: "Insertion mode" }),
    );
    // "paste" and "inline" took the same code path as "auto" — three names for
    // one behavior — so they are gone rather than sitting here as choices that
    // change nothing.
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
    ).toEqual(["Insert at cursor", "Clipboard only"]);
  });

  it("offers keep warm as the on/off it now actually is", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    fireEvent.click(
      await screen.findByRole("combobox", { name: "Keep warm" }),
    );
    // "Short" and "Long" described a prewarm that ran unconditionally, so
    // neither of them (nor "Off") changed anything. The setting now gates the
    // prewarm, and there is one thing to gate.
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
    ).toEqual(["On", "Off"]);
  });

  it("offers how long to keep the speech model ready, automatic first", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    const select = await screen.findByRole("combobox", {
      name: "Keep speech model ready for",
    });
    // One preselected recommendation that follows the Mac's memory, and the
    // memory each choice keeps in use is stated rather than left to guess.
    expect(select).toHaveTextContent("Automatic (recommended)");
    expect(screen.getByText(/Memory pressure or other local models can release it sooner, even on Always/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic keeps Parakeet ready for up to 30 minutes/i)).toBeInTheDocument();
    fireEvent.click(select);
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
    ).toEqual([
      "Automatic (recommended)",
      "2 minutes",
      "5 minutes",
      "10 minutes",
      "30 minutes",
      "1 hour",
      "Always",
    ]);
  });

  it("saves the speech residency choice and restores it after reopening", async () => {
    const view = render(<DictationView />);
    await openConfigTab("Capture");
    fireEvent.click(await screen.findByRole("combobox", { name: "Keep speech model ready for" }));
    fireEvent.click(await screen.findByRole("option", { name: "Always" }));
    await waitFor(() => expect(backendMocks.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ transcription: expect.objectContaining({ speechModelKeepReady: "always" }) }),
    ));
    view.unmount();
    render(<DictationView />);
    await openConfigTab("Capture");
    expect(await screen.findByRole("combobox", { name: "Keep speech model ready for" })).toHaveTextContent("Always");
  });

  it("suppresses batch live preview when Apple Speech is selected", async () => {
    backendMocks.transcriptionOverrides.dictationProvider = "macos_apple_speech";
    backendMocks.transcriptionOverrides.dictationModelId = "macos_apple_speech";
    backendMocks.transcriptionOverrides.dictationLivePreviewEnabled = true;

    render(<DictationView />);
    await openConfigTab("Capture");

    const select = await screen.findByRole("combobox", {
      name: "Live preview",
    });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("Wait for the finished text");
    expect(
      screen.getByText(/waits for the final on-device result/i),
    ).toBeInTheDocument();
  });

  it("explains speech and cleanup release when keep warm is off", async () => {
    render(<DictationView />);

    await openConfigTab("Capture");

    const copy = await screen.findByText(/other speech models release after transcription/i);
    expect(copy).toBeInTheDocument();
    expect(copy.textContent).toMatch(/when memory allows/i);
    expect(copy.textContent).toMatch(/built-in cleanup after a minute idle/i);
    expect(screen.queryByText(/stays in memory until you quit/i)).toBeNull();
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
    const settings = backendMocks.buildSettings();
    settings.transcription.dictationCopyToClipboard = true;
    const pendingSettings = deferred<typeof settings>();
    const loadSettings = backendMocks.getSettings.getMockImplementation();
    backendMocks.getSettings.mockImplementation(() => pendingSettings.promise);
    try {
      render(<DictationView />);

      await openConfigTab("Profiles");
      const toggle = await screen.findByRole("switch", {
        name: /also copy every dictation to the clipboard/i,
      });
      expect(toggle).not.toBeChecked();
      expect(
        screen.getByText(/does not put the previous contents back/i),
      ).toBeInTheDocument();

      await act(async () => pendingSettings.resolve(settings));
      expect(toggle).toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(backendMocks.saveSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            transcription: expect.objectContaining({ dictationCopyToClipboard: false }),
          }),
        );
      });
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
    } finally {
      backendMocks.getSettings.mockImplementation(loadSettings!);
    }
  });

  it.each(["an older audio-enable read", "an unrelated clipboard preference read"])(
    "keeps dictation audio off after %s finishes late",
    async (scenario) => {
      const unrelated = scenario === "an unrelated clipboard preference read";
      backendMocks.transcriptionOverrides.dictationKeepAudio = unrelated;
      render(<DictationView />);
      await openConfigTab("Capture");
      const audio = await screen.findByRole("switch", {
        name: "Keep dictation audio for Process again",
      });
      await waitFor(() => expect(audio).toHaveAttribute("aria-checked", String(unrelated)));
      const settings: Settings = await backendMocks.getSettings();
      const delayedRead = deferred<Settings>();
      const read = backendMocks.getSettings.getMockImplementation();
      try {
        if (unrelated) await openConfigTab("Profiles");
        backendMocks.getSettings.mockImplementationOnce(() => delayedRead.promise);
        fireEvent.click(unrelated
          ? screen.getByRole("switch", { name: /also copy every dictation to the clipboard/i })
          : audio);
        await act(async () => {});
        if (unrelated) await openConfigTab("Capture");
        fireEvent.click(screen.getByRole("switch", { name: "Keep dictation audio for Process again" }));
        await act(async () => delayedRead.resolve(settings));
        await waitFor(() => expect(backendMocks.saveSettings).toHaveBeenCalledTimes(2));
        const calls = backendMocks.saveSettings.mock.calls;
        expect(calls[calls.length - 1][0].transcription.dictationKeepAudio).toBe(false);
        expect(backendMocks.persistedSettings?.transcription.dictationKeepAudio).toBe(false);
        if (unrelated) expect(backendMocks.persistedSettings?.transcription.dictationCopyToClipboard).toBe(true);
        expect(screen.getByRole("switch", { name: "Keep dictation audio for Process again" })).not.toBeChecked();
      } finally {
        backendMocks.getSettings.mockReset().mockImplementation(read!);
      }
    },
  );

  it("keeps the selected profile and mode when only audio retention changes", async () => {
    backendMocks.transcriptionOverrides.dictationKeepAudio = true;
    backendMocks.transcriptionOverrides.dictationSelectedCustomModeId = "selected-profile";
    backendMocks.transcriptionOverrides.dictationModePreset = "custom";
    backendMocks.transcriptionOverrides.language = "fr";
    render(<DictationView />);
    await openConfigTab("Capture");
    const audio = await screen.findByRole("switch", {
      name: "Keep dictation audio for Process again",
    });
    await waitFor(() => expect(audio).toBeChecked());
    fireEvent.click(audio);
    await waitFor(() => expect(backendMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ transcription: expect.objectContaining({
        dictationKeepAudio: false,
        dictationSelectedCustomModeId: "selected-profile",
        dictationModePreset: "custom",
        language: "fr",
      }) }),
    ));
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
    fireEvent.click(screen.getByRole("button", { name: "Profile: Custom" }));
    fireEvent.change(screen.getByLabelText("Website this profile is for"), {
      target: { value: "unrelated.example" },
    });
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
    expect(latestSettings.transcription.dictationCustomModes[0].activationDomainMatcher).toBeNull();
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

  it("does not claim insertion when native paste was only dispatched", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: {
        text: "Keep the Friday meeting.", pasted: true, copied: false,
        outcome: "paste_dispatched", insertionModeUsed: "auto",
      } });
    });
    expect(await screen.findByText("Last dictation: insertion needs a look")).toBeInTheDocument();
    expect(screen.getByText("Plainsong couldn't confirm the text landed. Check the field before inserting again.")).toBeInTheDocument();
    expect(screen.queryByText("Inserted into the target app.")).not.toBeInTheDocument();
    expect(screen.queryByText("Last dictation: inserted cleanly")).not.toBeInTheDocument();
  });

  describe("delivery receipt status", () => {
    async function emitTextReady(payload: Record<string, unknown>) {
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({ payload });
      });
    }

    async function renderReadyView() {
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      expect(backendMocks.eventListeners.get("dictation-text-ready")).toBeTruthy();
    }

    it("reports copied-only delivery receipt status as copied to clipboard", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Keep the Friday meeting.",
        pasted: false,
        copied: true,
        insertionModeUsed: "auto",
      });

      expect(await screen.findByText("Last dictation: copied to clipboard")).toBeInTheDocument();
      expect(screen.getByText("Copied to the clipboard and ready to paste.")).toBeInTheDocument();
      expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: insertion needs a look")).not.toBeInTheDocument();
    });

    it("keeps an unknown delivery receipt status as result ready", async () => {
      await renderReadyView();
      await emitTextReady({ text: "Keep the Friday meeting." });

      expect(await screen.findByText("Last dictation: result ready")).toBeInTheDocument();
      expect(screen.getByText("Result is ready to review.")).toBeInTheDocument();
      expect(screen.getByText("Where the text came from, where it went, and how long it took.")).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: inserted cleanly")).not.toBeInTheDocument();
    });

    it("keeps copied fallback delivery receipt status on the attention path", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Keep the Friday meeting.",
        pasted: false,
        copied: true,
        pasteError: "Target app rejected the paste.",
      });

      expect(await screen.findByText("Last dictation: insertion needs a look")).toBeInTheDocument();
      expect(screen.getByText("Target app rejected the paste.")).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: copied to clipboard")).not.toBeInTheDocument();
    });

    it("keeps focus-change delivery text in the editor with copy recovery", async () => {
      await renderReadyView();
      const text = "  Keep these exact words.\n\nSecond line stays.  ";
      await emitTextReady({
        text,
        pasted: false,
        copied: false,
        outcome: "error",
        pasteError:
          "Focus changed while dictation was processing. Your words are ready to copy in Plainsong.",
      });

      expect(
        screen.getByRole("textbox", { name: "Latest dictation result" }),
      ).toHaveValue(text);
      expect(
        await screen.findByText(
          "Text kept in Plainsong. Use Copy result to paste it where you want.",
        ),
      ).toBeInTheDocument();
      const next = screen.getByText(
        "Next: Use Copy result, click the field you want, then paste. Your text stays in Plainsong.",
      );
      expect(next).toBeInTheDocument();
      expect(next).not.toHaveTextContent("Clipboard only");
    });

    it("uses the same copy recovery for a generic failed native insertion", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Generic failure words",
        pasted: false,
        copied: false,
        outcome: "error",
        pasteError: "macOS could not insert at the cursor.",
      });

      expect(
        await screen.findByText(
          "Text kept in Plainsong. Use Copy result to paste it where you want.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Next: Use Copy result, click the field you want, then paste. Your text stays in Plainsong.",
        ),
      ).toBeInTheDocument();
    });

    it("does not require another copy after a copied fallback", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Already copied words",
        pasted: false,
        copied: true,
        outcome: "error",
        pasteError: "Target app rejected the paste.",
      });

      expect(
        await screen.findByText(
          "Next: Click the field you want, then paste. Your text stays in Plainsong.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Next: Use Copy result, click the field you want/),
      ).not.toBeInTheDocument();
    });

    it("keeps unconfirmed insertion guidance separate from copy recovery", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Dispatched words",
        pasted: true,
        copied: false,
        outcome: "paste_dispatched",
        pasteError: "Paste command sent; delivery unconfirmed",
      });

      expect(
        await screen.findByText(
          "Next: Check the target field before inserting again. The text stays in your latest result.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Use Copy result, click the field/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Click the field you want, then paste/)).not.toBeInTheDocument();
    });

    it("resets delivery receipt status when the next result omits delivery flags", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "First result.",
        pasted: true,
        copied: false,
        timing: { insertionConfirmed: true },
      });
      expect(await screen.findByText("Last dictation: inserted cleanly")).toBeInTheDocument();

      await emitTextReady({ text: "Second result." });

      expect(await screen.findByText("Last dictation: result ready")).toBeInTheDocument();
      expect(screen.getByText("Result is ready to review.")).toBeInTheDocument();
      expect(screen.getByText("Where the text came from, where it went, and how long it took.")).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: inserted cleanly")).not.toBeInTheDocument();
    });

    it("keeps confirmed insertion delivery receipt status as inserted cleanly", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Keep the Friday meeting.",
        pasted: true,
        copied: false,
        timing: { insertionConfirmed: true },
      });

      expect(await screen.findByText("Last dictation: inserted cleanly")).toBeInTheDocument();
      expect(screen.getByText("Inserted into the target app.")).toBeInTheDocument();
      expect(screen.getByText("Paste command sent")).toBeInTheDocument();
    });

    it("names the speech models when the sidecar reports a fallback, and says how to get the chosen one back", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Keep the Friday meeting.",
        pasted: true,
        copied: false,
        timing: { insertionConfirmed: true },
        isFallback: true,
        requestedProvider: "openai_cloud",
        actualProvider: "moonshine",
        fallbackReason: "No API key is saved for this service.",
      });

      expect(await screen.findByText("Last dictation: used a different speech model")).toBeInTheDocument();
      expect(
        screen.getByText(/You chose OpenAI Cloud, so Plainsong used UsefulSensors Moonshine for this dictation\./),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Next: To use OpenAI Cloud next time, finish its setup in Settings > Models."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/openai_cloud|'moonshine'/)).not.toBeInTheDocument();

      // The next result without the flag is judged on its own, not on words
      // like "model" in its messages.
      await emitTextReady({
        text: "Second result.",
        pasted: true,
        copied: false,
        timing: { insertionConfirmed: true },
      });
      expect(await screen.findByText("Last dictation: inserted cleanly")).toBeInTheDocument();
    });

    it("keeps dispatched and refused delivery receipt status on the attention path", async () => {
      await renderReadyView();
      await emitTextReady({
        text: "Dispatched result.",
        pasted: true,
        copied: false,
        outcome: "paste_dispatched",
      });
      expect(await screen.findByText("Last dictation: insertion needs a look")).toBeInTheDocument();
      expect(screen.getByText("Plainsong couldn't confirm the text landed. Check the field before inserting again.")).toBeInTheDocument();
      expect(screen.getByText("Paste command sent; delivery unconfirmed")).toBeInTheDocument();

      await emitTextReady({
        text: "Refused result.",
        pasted: false,
        copied: false,
        outcome: "secure_field",
      });

      expect(screen.getByText("Last dictation: insertion needs a look")).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: result ready")).not.toBeInTheDocument();
    });

    it("does not let read aloud or shortcut actions change delivery receipt status", async () => {
      await renderReadyView();
      await emitTextReady({
        recordingId: "recording-latest",
        text: "Keep the Friday meeting.",
        pasted: false,
        copied: true,
      });
      const title = await screen.findByText("Last dictation: copied to clipboard");
      const detail = screen.getByText("Copied to clipboard");

      fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
      fireEvent.click(screen.getByRole("button", { name: "Use for Paste last result" }));
      await waitFor(() => {
        expect(backendMocks.stageSavedDictationResult).toHaveBeenCalledWith("recording-latest");
      });

      expect(title).toBeInTheDocument();
      expect(detail).toBeInTheDocument();
      expect(screen.queryByText("Last dictation: insertion needs a look")).not.toBeInTheDocument();
    });
  });

  it("starts in-app capture as a preview and never claims insertion", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    fireEvent.click(screen.getByRole("button", { name: /start dictation/i }));
    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(expect.objectContaining({ deliveryMode: "preview" }));
    });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    await act(async () => {
      handler?.({ payload: { text: "Keep the Friday meeting.", actualProvider: "parakeet", insertionModeUsed: "preview", pasted: false, copied: false } });
    });
    expect(await screen.findByText("Last dictation: preview ready")).toBeInTheDocument();
    expect(screen.queryByText("Last dictation: inserted cleanly")).not.toBeInTheDocument();
    const details = screen.getByTestId("latest-dictation-details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Dictation details"));
    expect(details).toHaveAttribute("open");
    fireEvent.click(screen.getByText("Dictation details"));
    expect(details).not.toHaveAttribute("open");
  });

  it("latest saved edit persists an edited result to recording history", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Edited latest text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));

    await waitFor(() => {
      expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
        "recording-latest",
        "Edited latest text",
        null,
      );
    });
    expect(await screen.findByText("Changes saved to history.")).toBeInTheDocument();
  });

  it("latest keyboard save persists edited text with Command+Enter", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Edited from the keyboard" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
        "recording-latest",
        "Edited from the keyboard",
        null,
      );
    });
    expect(await screen.findByText("Changes saved to history.")).toBeInTheDocument();
  });

  it("latest keyboard save ignores plain Enter and composition Enter", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Still composing this edit" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });

    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("latest keyboard save ignores unchanged text", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Latest dictation result" }),
      { key: "Enter", metaKey: true },
    );

    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("latest keyboard save waits for a pending save", async () => {
    const pendingSave = deferred<{ text: string | null }>();
    backendMocks.saveDictationEdit.mockReturnValueOnce(pendingSave.promise);
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "One pending edit" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledOnce());
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(backendMocks.saveDictationEdit).toHaveBeenCalledOnce();

    await act(async () => {
      pendingSave.resolve({ text: "One pending edit" });
      await pendingSave.promise;
    });
  });

  it("latest keyboard save does not overwrite an unresolved conflict", async () => {
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      {
        recordingId: "recording-conflict",
        title: "Conflicting draft",
        text: "My unfinished edit",
        expectedSavedText: null,
      },
    ]);
    backendMocks.getTranscript.mockResolvedValueOnce(
      createSavedTranscript("recording-conflict", "Original text"),
    );
    backendMocks.getDictationEdit.mockResolvedValueOnce({
      text: "Newer saved correction",
    });
    render(<DictationView />);

    fireEvent.click(await screen.findByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await screen.findByRole("region", { name: "Saved version changed" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Latest dictation result" }),
      { key: "Enter", metaKey: true },
    );

    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("latest keyboard save retries after a failed save", async () => {
    backendMocks.saveDictationEdit
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValueOnce({ text: "Retry this edit" });
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Retry this edit" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(await screen.findByText("Save failed")).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Changes saved to history.")).toBeInTheDocument();
  });

  it("saved shortcut text requires a saved edit and stages the persisted recording", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });
    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Edited latest text" } });
    const shortcut = screen.getByRole("button", { name: "Use for Paste last result" });
    expect(shortcut).toBeDisabled();
    expect(screen.getByText(/has not been updated to this edit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await screen.findByText("Changes saved to history.");
    expect(shortcut).toBeEnabled();
    fireEvent.click(shortcut);
    await waitFor(() => expect(backendMocks.stageSavedDictationResult).toHaveBeenCalledWith("recording-latest"));
    expect(await screen.findByText('Saved text is ready for "Paste last result".')).toBeInTheDocument();
    expect(screen.queryByText(/has not been updated to this edit/)).not.toBeInTheDocument();
  });

  it("latest change review restores recognizer output as an editable draft", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Send John $50.", rawTranscript: "Send Jon $15." },
      });
    });
    fireEvent.click(screen.getByText("Review changes"));
    expect(screen.getAllByText("Original").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Restore original" }));
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Send Jon $15.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith("recording-latest", "Send Jon $15.", null));
  });

  it("saved shortcut text keeps an empty edited result available to restore", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });
    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "" } });
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to history" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use for Paste last result" })).toBeDisabled();
    const copy = screen.getByRole("button", { name: "Copy result" });
    expect(copy).toBeDisabled();
    fireEvent.click(copy);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "Restored text" } });
    expect(editor).toHaveValue("Restored text");
  });

  describe("latest copy ownership", () => {
    it("copies the editor text exactly and acknowledges the current copy", async () => {
      const exactText = "  Keep  spacing.\nSecond line.  \n";
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-copy", text: exactText },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledWith(exactText);
        expect(toast).toHaveBeenCalledWith(
          "Result copied. Paste it where you want it.",
          "success",
        );
      });
    });

    it("keeps one copy pending across an edit and new capture, then copies the new text", async () => {
      const firstCopy = deferred<void>();
      clipboardWriteText
        .mockReturnValueOnce(firstCopy.promise)
        .mockResolvedValueOnce(undefined);
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-a", text: "Original text" },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      const editor = screen.getByRole("textbox", {
        name: "Latest dictation result",
      });
      fireEvent.change(editor, { target: { value: "Edited while copying" } });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-b", text: "New capture" },
        });
      });

      const pendingButton = screen.getByRole("button", { name: "Copying…" });
      expect(pendingButton).toBeDisabled();
      fireEvent.click(pendingButton);
      expect(clipboardWriteText).toHaveBeenCalledTimes(1);

      await act(async () => {
        firstCopy.resolve();
        await firstCopy.promise;
      });
      const retryButton = screen.getByRole("button", { name: "Copy result" });
      expect(retryButton).toBeEnabled();
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledTimes(2);
      });
      expect(clipboardWriteText).toHaveBeenLastCalledWith("New capture");
    });

    it("suppresses stale success after the editor revision changes", async () => {
      const pendingCopy = deferred<void>();
      clipboardWriteText.mockReturnValueOnce(pendingCopy.promise);
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-copy", text: "Same text" },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      const editor = screen.getByRole("textbox", {
        name: "Latest dictation result",
      });
      fireEvent.change(editor, { target: { value: "Temporary edit" } });
      fireEvent.change(editor, { target: { value: "Same text" } });
      await act(async () => {
        pendingCopy.resolve();
        await pendingCopy.promise;
      });

      expect(toast).not.toHaveBeenCalledWith(
        "Result copied. Paste it where you want it.",
        "success",
      );
    });

    it("suppresses stale errors after a new capture with the same text", async () => {
      const pendingCopy = deferred<void>();
      clipboardWriteText.mockReturnValueOnce(pendingCopy.promise);
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-a", text: "Same text" },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-b", text: "Same text" },
        });
      });
      expect(
        screen.getByRole("textbox", { name: "Latest dictation result" }),
      ).toHaveValue("Same text");
      await act(async () => {
        pendingCopy.reject(new Error("Clipboard denied"));
        try {
          await pendingCopy.promise;
        } catch {
          // The component owns the rejection; this await only flushes it.
        }
      });

      expect(toast).not.toHaveBeenCalledWith(
        "Could not copy the result. Select the text and copy it manually.",
        "error",
      );
    });

    it("keeps the editor available after a current failure and allows retry", async () => {
      clipboardWriteText
        .mockRejectedValueOnce(new Error("Clipboard denied"))
        .mockResolvedValueOnce(undefined);
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-copy", text: "Retry this text" },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith(
          "Could not copy the result. Select the text and copy it manually.",
          "error",
        );
      });
      const editor = screen.getByRole("textbox", {
        name: "Latest dictation result",
      });
      expect(editor).toBeEnabled();
      fireEvent.change(editor, { target: { value: "Retry this edited text" } });
      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledTimes(2);
        expect(toast).toHaveBeenCalledWith(
          "Result copied. Paste it where you want it.",
          "success",
        );
      });
      expect(clipboardWriteText).toHaveBeenLastCalledWith(
        "Retry this edited text",
      );
    });
  });

  it("latest style preview adopts only after review and saves to the same recording", async () => {
    backendMocks.reprocessDictationText.mockResolvedValue({
      outputText: "Polished latest text", modePreset: "voice", usedAi: true,
      provider: "local", modelId: "test-model",
    });
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-latest", text: "Original latest text" },
      });
    });
    fireEvent.click(screen.getByText("Try another style"));
    expect(backendMocks.reprocessDictationText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
    await screen.findByRole("button", { name: "Use preview" });
    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    expect(editor).toHaveValue("Original latest text");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use preview" }));
    expect(editor).toHaveValue("Polished latest text");
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith("recording-latest", "Polished latest text", null));
  });

  describe("latest style preview undo", () => {
    const manualText = "  Keep this spacing.\n\nSecond line stays here.  ";
    const previewText = "Keep this spacing. Second line stays here.";

    async function adoptStylePreview() {
      backendMocks.reprocessDictationText.mockResolvedValueOnce({
        outputText: previewText,
        modePreset: "voice",
        usedAi: true,
        provider: "local",
        modelId: "test-model",
      });
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: {
            recordingId: "recording-latest",
            text: "Original latest text",
          },
        });
      });
      const editor = screen.getByRole("textbox", {
        name: "Latest dictation result",
      });
      fireEvent.change(editor, { target: { value: manualText } });
      fireEvent.click(screen.getByText("Try another style"));
      fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use preview" }));
      expect(editor).toHaveValue(previewText);
      return {
        editor,
        undo: screen.getByRole("button", { name: "Undo style preview" }),
      };
    }

    it("restores the exact manual text and copies it without other side effects", async () => {
      const dictationBackend = await import("@/lib/backend/dictation");
      const { editor, undo } = await adoptStylePreview();

      fireEvent.click(undo);

      expect(editor).toHaveValue(manualText);
      await waitFor(() =>
        expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
          "recording-latest",
          manualText,
          null,
        ),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      });
      await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(manualText));
      expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
      expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
      expect(dictationBackend.learnDictationCorrection).not.toHaveBeenCalled();
      expect(
        backendMocks.invoke.mock.calls.some(
          ([command]) => command === "repaste_dictation_result",
        ),
      ).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
      await waitFor(() =>
        expect(dictationBackend.learnDictationCorrection).toHaveBeenLastCalledWith({
          originalText: "Original latest text",
          correctedText: manualText,
          appTarget: null,
          force: true,
        }),
      );
    });

    it("invalidates undo after the user types and ignores the stale control", async () => {
      const { editor, undo } = await adoptStylePreview();
      const newerManualText = "I changed the preview myself.";

      fireEvent.change(editor, { target: { value: newerManualText } });

      expect(
        screen.queryByRole("button", { name: "Undo style preview" }),
      ).not.toBeInTheDocument();
      fireEvent.click(undo);
      expect(editor).toHaveValue(newerManualText);
    });

    it("invalidates undo when a newer capture replaces the result", async () => {
      const { editor, undo } = await adoptStylePreview();

      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: {
            recordingId: "recording-newer",
            text: "Words from the newer capture.",
          },
        });
      });

      expect(
        screen.queryByRole("button", { name: "Undo style preview" }),
      ).not.toBeInTheDocument();
      fireEvent.click(undo);
      expect(editor).toHaveValue("Words from the newer capture.");
    });

    it("restores unsaved words after the preview was saved", async () => {
      const { editor, undo } = await adoptStylePreview();
      fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
      await waitFor(() =>
        expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
          "recording-latest",
          previewText,
          null,
        ),
      );

      fireEvent.click(undo);

      expect(editor).toHaveValue(manualText);
      expect(screen.getByRole("button", { name: "Save to history" })).toBeEnabled();
      expect(screen.getByText("Not saved to history")).toBeInTheDocument();
      expect(backendMocks.saveDictationEdit).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
          "recording-latest",
          manualText,
          previewText,
        ),
      );
    });
  });

  describe("latest selective restoration", () => {
    const original = "Send the red report to Maya on Monday.";
    const draft = "Send the blue report to Maya on Friday.";

    async function showLatestChanges(rawTranscript: string | null = original) {
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-latest", text: original, rawTranscript: rawTranscript ?? undefined },
        });
      });
      const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
      fireEvent.change(editor, { target: { value: draft } });
      fireEvent.click(screen.getByText("Restore individual changes"));
      return editor;
    }

    it("restores one recognizer change and undoes it without delivering or teaching the draft", async () => {
      const backend = await import("@/lib/backend/dictation");
      const editor = await showLatestChanges();
      const review = screen.getByText("Restore individual changes").closest("details")!;
      expect(within(review).getAllByText("Original")).toHaveLength(2);
      fireEvent.click(within(review).getByRole("button", { name: "Restore change 1" }));
      expect(editor).toHaveValue("Send the red report to Maya on Friday.");
      fireEvent.blur(editor);
      await act(async () => {});
      expect(backend.queueDictationCorrectionSuggestion).not.toHaveBeenCalled();
      fireEvent.click(within(review).getByRole("button", { name: "Undo restoration" }));
      expect(editor).toHaveValue(draft);
      fireEvent.blur(editor);
      await act(async () => {});
      expect(backend.queueDictationCorrectionSuggestion).not.toHaveBeenCalled();
      expect(backend.learnDictationCorrection).not.toHaveBeenCalled();
      expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
      expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
      expect(clipboardWriteText).not.toHaveBeenCalled();
      expect(backendMocks.invoke.mock.calls.some(([command]) => command === "repaste_dictation_result")).toBe(false);
      await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith("recording-latest", draft, null));
    });

    it("blocks restoration during a pending history save", async () => {
      let finishSave!: () => void;
      backendMocks.saveDictationEdit.mockImplementationOnce(() => new Promise<{ text: string | null }>((resolve) => {
        finishSave = () => resolve({ text: draft });
      }));
      const editor = await showLatestChanges(null);
      const review = screen.getByText("Restore individual changes").closest("details")!;
      expect(within(review).getAllByText("Original")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
      await waitFor(() => expect(within(review).getByRole("button", { name: "Restore change 1" })).toBeDisabled());
      fireEvent.click(within(review).getByRole("button", { name: "Restore change 1" }));
      expect(editor).toHaveValue(draft);
      await act(async () => finishSave());
    });

    it("clears selective undo when a new capture has the same recording and text", async () => {
      const editor = await showLatestChanges();
      fireEvent.click(screen.getByRole("button", { name: "Restore change 1" }));
      const restored = "Send the red report to Maya on Friday.";
      const undo = screen.getByRole("button", { name: "Undo restoration" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "recording-latest", text: restored, rawTranscript: original },
        });
      });
      expect(screen.queryByRole("button", { name: "Undo restoration" })).not.toBeInTheDocument();
      fireEvent.click(undo);
      expect(editor).toHaveValue(restored);
    });
  });

  describe("latest original restore undo", () => {
    const processedText = "Cleaned latest result.";
    const rawText = "cleaned latest result";
    const manualText = "  Keep my manual spacing.  \n\nSecond line stays.  ";

    async function restoreLatestOriginal() {
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: {
            recordingId: "recording-latest",
            text: processedText,
            rawTranscript: rawText,
          },
        });
      });
      const editor = screen.getByRole("textbox", {
        name: "Latest dictation result",
      });
      fireEvent.change(editor, { target: { value: manualText } });
      fireEvent.click(screen.getByText("Review changes"));
      fireEvent.click(screen.getByRole("button", { name: "Restore original" }));
      expect(editor).toHaveValue(rawText);
      return {
        editor,
        undo: screen.getByRole("button", { name: "Undo restore" }),
      };
    }

    it("restores the exact manual draft without saving, copying, pasting, or learning", async () => {
      const dictationBackend = await import("@/lib/backend/dictation");
      const { editor, undo } = await restoreLatestOriginal();

      fireEvent.click(undo);

      expect(editor).toHaveValue(manualText);
      expect(screen.getByText("Restore undone. Your previous draft is back.")).toBeInTheDocument();
      await waitFor(() =>
        expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
          "recording-latest",
          manualText,
          null,
        ),
      );
      expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
      expect(clipboardWriteText).not.toHaveBeenCalled();
      expect(dictationBackend.learnDictationCorrection).not.toHaveBeenCalled();
      expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
      expect(
        backendMocks.invoke.mock.calls.some(
          ([command]) => command === "repaste_dictation_result",
        ),
      ).toBe(false);
    });

    it("does not auto-queue the restored original and restores the correction source on undo", async () => {
      const backend = await import("@/lib/backend/dictation");
      const { editor, undo } = await restoreLatestOriginal();

      fireEvent.blur(editor);
      await act(async () => {});
      expect(backend.queueDictationCorrectionSuggestion).not.toHaveBeenCalled();

      fireEvent.click(undo);
      const genuineEdit = "A genuine edit after undo.";
      fireEvent.change(editor, { target: { value: genuineEdit } });
      fireEvent.blur(editor);

      await waitFor(() => {
        expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalledWith({
          originalText: processedText,
          correctedText: genuineEdit,
          appTarget: null,
          force: false,
        });
      });
      expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
      expect(clipboardWriteText).not.toHaveBeenCalled();
      expect(backend.learnDictationCorrection).not.toHaveBeenCalled();
    });

    it("invalidates restore undo after the user types", async () => {
      const { editor, undo } = await restoreLatestOriginal();

      fireEvent.change(editor, { target: { value: "A newer manual edit." } });

      expect(screen.queryByRole("button", { name: "Undo restore" })).not.toBeInTheDocument();
      fireEvent.click(undo);
      expect(editor).toHaveValue("A newer manual edit.");
    });

    it("invalidates restore undo when a new capture replaces the result", async () => {
      const { editor, undo } = await restoreLatestOriginal();

      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: {
            recordingId: "recording-newer",
            text: "Words from the newer capture.",
          },
        });
      });

      expect(screen.queryByRole("button", { name: "Undo restore" })).not.toBeInTheDocument();
      fireEvent.click(undo);
      expect(editor).toHaveValue("Words from the newer capture.");
    });
  });

  it("unfinished edits remain recoverable after another capture arrives", async () => {
    backendMocks.getTranscript.mockResolvedValue({ id: "t-a", recordingId: "recording-a", segments: [], fullText: "Original A", language: "en", confidence: 1, model: "test" });
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { recordingId: "recording-a", text: "Original A" } });
    });
    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Unfinished A" } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith("recording-a", "Unfinished A", null));
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { recordingId: "recording-b", text: "Original B" } });
    });
    expect(editor).toHaveValue("Original B");
    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(editor).toHaveValue("Unfinished A"));
    expect(screen.getByText(/has not been updated to this edit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith("recording-a", "Unfinished A", null));
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalledWith("recording-b", expect.anything(), expect.anything());
  });

  it("does not restore or re-journal a draft after it is discarded while resume is pending", async () => {
    const lateTranscript = deferred<ReturnType<typeof createSavedTranscript>>();
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      {
        recordingId: "recording-a",
        title: "Draft A",
        text: "Unfinished A",
        expectedSavedText: null,
      },
    ]);
    backendMocks.getTranscript.mockReturnValueOnce(lateTranscript.promise);

    render(<DictationView />);
    await screen.findByText("Unfinished edits (1)");
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-current", text: "Current result" },
      });
    });
    backendMocks.saveDictationDraft.mockClear();

    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(backendMocks.getTranscript).toHaveBeenCalledWith("recording-a"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    await waitFor(() =>
      expect(backendMocks.clearDictationDraft).toHaveBeenCalledWith(
        "recording-a",
        "Unfinished A",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Unfinished edits (1)")).not.toBeInTheDocument(),
    );

    await act(async () => {
      lateTranscript.resolve(
        createSavedTranscript("recording-a", "Original A"),
      );
      await lateTranscript.promise;
    });

    expect(
      screen.getByRole("textbox", { name: "Latest dictation result" }),
    ).toHaveValue("Current result");
    expect(backendMocks.saveDictationDraft).not.toHaveBeenCalled();
  });

  it("keeps a draft after discard fails and ignores the old resume while allowing another resume", async () => {
    const lateTranscript = deferred<ReturnType<typeof createSavedTranscript>>();
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      {
        recordingId: "recording-a",
        title: "Draft A",
        text: "Unfinished A",
        expectedSavedText: null,
      },
    ]);
    backendMocks.getTranscript
      .mockReturnValueOnce(lateTranscript.promise)
      .mockResolvedValueOnce(
        createSavedTranscript("recording-a", "Original A"),
      );
    backendMocks.clearDictationDraft.mockRejectedValueOnce(
      new Error("draft store unavailable"),
    );

    render(<DictationView />);
    await screen.findByText("Unfinished edits (1)");
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-current", text: "Current result" },
      });
    });
    backendMocks.saveDictationDraft.mockClear();

    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(backendMocks.getTranscript).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    expect(await screen.findByText("draft store unavailable")).toBeInTheDocument();

    await act(async () => {
      lateTranscript.resolve(
        createSavedTranscript("recording-a", "Original A"),
      );
      await lateTranscript.promise;
    });

    expect(screen.getByText("Unfinished A")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Latest dictation result" }),
    ).toHaveValue("Current result");
    expect(backendMocks.saveDictationDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Latest dictation result" }),
      ).toHaveValue("Unfinished A"),
    );
    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(2);
    expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "recording-a",
      "Unfinished A",
      null,
    );
  });

  it("continues a pending resume when an unrelated draft is discarded", async () => {
    const lateTranscript = deferred<ReturnType<typeof createSavedTranscript>>();
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      {
        recordingId: "recording-a",
        title: "Draft A",
        text: "Unfinished A",
        expectedSavedText: null,
      },
      {
        recordingId: "recording-b",
        title: "Draft B",
        text: "Unfinished B",
        expectedSavedText: null,
      },
    ]);
    backendMocks.getTranscript.mockReturnValueOnce(lateTranscript.promise);

    render(<DictationView />);
    await screen.findByText("Unfinished edits (2)");
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-current", text: "Current result" },
      });
    });
    backendMocks.saveDictationDraft.mockClear();

    fireEvent.click(screen.getByText("Unfinished edits (2)"));
    const draftA = screen.getByText("Draft A").closest("article")!;
    const draftB = screen.getByText("Draft B").closest("article")!;
    fireEvent.click(within(draftB).getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(backendMocks.getTranscript).toHaveBeenCalledWith("recording-b"),
    );
    fireEvent.click(within(draftA).getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    await waitFor(() =>
      expect(backendMocks.clearDictationDraft).toHaveBeenCalledWith(
        "recording-a",
        "Unfinished A",
      ),
    );

    await act(async () => {
      lateTranscript.resolve(
        createSavedTranscript("recording-b", "Original B"),
      );
      await lateTranscript.promise;
    });

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Latest dictation result" }),
      ).toHaveValue("Unfinished B"),
    );
    expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "recording-b",
      "Unfinished B",
      null,
    );
  });

  it("copies an offline unfinished draft verbatim without opening or processing it", async () => {
    const draftText = `  First offline line.\nSecond line keeps its indentation and punctuation.\n${"Long recovery text stays available without an engine. ".repeat(3)}\nFinal offline line.  `;
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      {
        recordingId: "recording-offline-draft",
        title: "Offline recovery draft",
        text: draftText,
        expectedSavedText: null,
      },
    ]);
    backendMocks.getTranscript.mockRejectedValue(new Error("transcript engine unavailable"));
    backendMocks.getDictationEdit.mockRejectedValue(new Error("saved edit unavailable"));
    backendMocks.reprocessDictationText.mockRejectedValue(new Error("processing engine unavailable"));
    backendMocks.reprocessDictation.mockRejectedValue(new Error("processing engine unavailable"));

    render(<DictationView />);
    await screen.findByText("Unfinished edits (1)");
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: {
          recordingId: "recording-current",
          text: "Current latest result must stay here.",
        },
      });
    });
    const latestResult = screen.getByRole("textbox", {
      name: "Latest dictation result",
    });
    expect(latestResult).toHaveValue("Current latest result must stay here.");

    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    const fullDraftDisclosure = screen.getByText("View full draft").closest("details")!;
    fireEvent.click(within(fullDraftDisclosure).getByText("View full draft"));
    const fullDraft = await within(fullDraftDisclosure).findByText(
      (_, element) => element?.tagName === "PRE" && element.textContent === draftText,
    );
    expect(fullDraft.textContent).toBe(draftText);

    clipboardWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));

    expect(await screen.findByText("Draft copied.")).toHaveAttribute("role", "status");
    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledWith(draftText);
    expect(screen.getByText("Offline recovery draft")).toBeInTheDocument();
    expect(fullDraft.textContent).toBe(draftText);
    expect(latestResult).toHaveValue("Current latest result must stay here.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictationText).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();
    expect(backendMocks.getTranscript).not.toHaveBeenCalled();
    expect(backendMocks.getDictationEdit).not.toHaveBeenCalled();
  });

  it("reports a pending recovery write before confirming its local save", async () => {
    const pending = deferred<void>();
    backendMocks.saveDictationDraft.mockReturnValueOnce(pending.promise);
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-pending", text: "Original text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "Draft waiting for storage" } });

    const recovery = await screen.findByLabelText("Draft recovery");
    expect(recovery).toHaveAttribute("role", "status");
    expect(recovery).toHaveTextContent("Saving a recovery copy on this Mac…");
    expect(recovery).not.toHaveTextContent("Recovery copy saved on this Mac.");
    expect(screen.getByText("Not saved to history")).toBeInTheDocument();

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });

    expect(await screen.findByText("Recovery copy saved on this Mac.")).toBeInTheDocument();
    expect(screen.getByText("Not saved to history")).toBeInTheDocument();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("keeps a failed recovery inline and retries the current draft text", async () => {
    backendMocks.saveDictationDraft
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockRejectedValueOnce(new Error("updated write failed"))
      .mockResolvedValueOnce(undefined);
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-retry", text: "Original text" },
      });
    });

    const editor = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(editor, { target: { value: "First unsaved draft" } });
    const firstAlert = await screen.findByRole("alert", { name: "Draft recovery" });
    expect(firstAlert).toHaveTextContent(
      "Recovery copy couldn't be saved. Keep this window open or copy your text.",
    );

    fireEvent.change(editor, { target: { value: "Fresh current draft" } });
    await waitFor(() => {
      expect(backendMocks.saveDictationDraft).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert", { name: "Draft recovery" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry recovery save" }));

    expect(await screen.findByText("Recovery copy saved on this Mac.")).toBeInTheDocument();
    expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
      "recording-retry",
      "Fresh current draft",
      null,
    );
    expect(editor).toHaveValue("Fresh current draft");
    expect(screen.getByText("Not saved to history")).toBeInTheDocument();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("removes an old recovery error from the inline result after a new capture", async () => {
    backendMocks.saveDictationDraft.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-old", text: "Old capture" },
      });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Latest dictation result" }), {
      target: { value: "Old unsaved edit" },
    });
    expect(await screen.findByRole("alert", { name: "Draft recovery" })).toBeInTheDocument();

    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "recording-new", text: "New capture" },
      });
    });

    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("New capture");
    expect(screen.queryByLabelText("Draft recovery")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry recovery save" })).not.toBeInTheDocument();
    const unfinishedEdits = screen.getByText("Unfinished edits (1)").closest("details");
    expect(unfinishedEdits).not.toHaveAttribute("open");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("unfinished edits are not stored when the capture opted out of history", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { recordingId: null, text: "Private capture" } });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Latest dictation result" }), { target: { value: "Private edit" } });
    expect(backendMocks.saveDictationDraft).not.toHaveBeenCalled();
  });

  it("unfinished edits require an explicit choice before replacing a newer saved correction", async () => {
    backendMocks.listDictationDrafts.mockResolvedValueOnce([{ recordingId: "recording-a", title: "Older dictation", text: "My unfinished edit", expectedSavedText: null }]);
    backendMocks.getTranscript.mockResolvedValue({ id: "t-a", recordingId: "recording-a", segments: [], fullText: "Original A", language: "en", confidence: 1, model: "test" });
    backendMocks.getDictationEdit.mockResolvedValueOnce({ text: "Newer saved correction text" });
    render(<DictationView />);
    await screen.findByText("Unfinished edits (1)");
    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await screen.findByRole("region", { name: "Saved version changed" });
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("My unfinished edit");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith("recording-a", "My unfinished edit", "Newer saved correction text"));
  });

  it("dictation departure waits for pending unfinished edits", async () => {
    const pending = deferred<void>();
    backendMocks.saveDictationDraft.mockReturnValueOnce(pending.promise);
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { recordingId: "recording-a", text: "Original A" } });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Latest dictation result" }), { target: { value: "Pending edit" } });
    let finished = false;
    const leaving = canLeaveMainView("dictation").then((allowed) => { finished = true; return allowed; });
    await act(async () => { await Promise.resolve(); });
    expect(finished).toBe(false);
    await act(async () => { pending.resolve(undefined); });
    expect(await leaving).toBe(true);
  });

  it("dictation departure keeps failed unfinished edits visible", async () => {
    backendMocks.saveDictationDraft.mockRejectedValue(new Error("storage unavailable"));
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { recordingId: "recording-a", text: "Original A" } });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Latest dictation result" }), { target: { value: "Keep my edit" } });
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("dictation"); });
    expect(allowed).toBe(false);
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Keep my edit");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("couldn't be stored"), "error");
    backendMocks.saveDictationDraft.mockResolvedValue(undefined);
  });

  it("latest saved edit is unavailable without a recording id", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "Unsaved latest text" },
      });
    });

    expect(screen.queryByRole("button", { name: "Save to history" })).not.toBeInTheDocument();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("starts one cloud capture when the saved local route is missing", async () => {
    useMissingLocalDictationRoute();
    backendMocks.privacyOverrides.remoteProcessingEnabled = true;

    render(<DictationView />);
    await chooseOneOffRoute("The cloud");

    const startButton = screen.getByRole("button", { name: /start dictation/i });
    await waitFor(() => expect(startButton).toBeEnabled());
    expect(screen.getByText("Cloud for this capture")).toBeInTheDocument();

    fireEvent.click(startButton);

    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryMode: "preview",
          routePreference: "cloud",
        }),
      );
    });
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("starts preview capture while the shortcut still needs Accessibility access", async () => {
    const evidence = readyProductEvidence({
      cursorInsertionRequired: true,
      cursorInsertionReady: false,
    });
    readinessContext.productReadinessEvidence = evidence;
    readinessContext.productReadiness = buildProductReadinessSnapshot(evidence);

    expect(readinessContext.productReadiness.dictation).toMatchObject({
      state: "needs_action",
      cause: { id: "cursor_insertion" },
    });

    render(<DictationView />);

    const startButton = await screen.findByRole("button", {
      name: /start dictation/i,
    });
    expect(startButton).toBeEnabled();
    expect(
      screen.getByText(
        "Use Start to keep text here. The shortcut needs Accessibility access to insert into other apps.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(startButton);

    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryMode: "preview" }),
      );
    });
  });

  it("keeps a one-off cloud capture blocked when remote processing is disabled", async () => {
    useMissingLocalDictationRoute();
    backendMocks.privacyOverrides.remoteProcessingEnabled = false;

    render(<DictationView />);
    await chooseOneOffRoute("The cloud");

    expect(
      await screen.findByText(/remote processing is disabled/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start dictation/i }),
    ).not.toBeInTheDocument();
    expect(backendMocks.startDictation).not.toHaveBeenCalled();
  });

  it("keeps a one-off cloud capture blocked when no cloud route is ready", async () => {
    useMissingLocalDictationRoute();
    backendMocks.privacyOverrides.remoteProcessingEnabled = true;
    backendMocks.asrProviders = [backendMocks.asrProviders[0]];

    render(<DictationView />);
    await chooseOneOffRoute("The cloud");

    expect(
      await screen.findByText(/no cloud speech route is ready/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start dictation/i }),
    ).not.toBeInTheDocument();
    expect(backendMocks.startDictation).not.toHaveBeenCalled();
  });

  it.each([
    [
      { microphonePermissionReady: false },
      /microphone access is required/i,
    ],
    [
      { settingsLoaded: false },
      /could not confirm settings and transcription engines/i,
    ],
  ] as const)(
    "does not let a ready cloud route bypass another capture blocker: %o",
    async (evidenceOverride, expectedMessage) => {
      useMissingLocalDictationRoute(evidenceOverride);
      backendMocks.privacyOverrides.remoteProcessingEnabled = true;

      render(<DictationView />);
      await chooseOneOffRoute("The cloud");

      expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /start dictation/i }),
      ).not.toBeInTheDocument();
      expect(backendMocks.startDictation).not.toHaveBeenCalled();
    },
  );

  it("lets a one-off preview route bypass cursor insertion readiness", async () => {
    useMissingLocalDictationRoute({ cursorInsertionReady: false });
    backendMocks.privacyOverrides.remoteProcessingEnabled = true;

    render(<DictationView />);
    await chooseOneOffRoute("The cloud");

    const startButton = screen.getByRole("button", { name: /start dictation/i });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(backendMocks.startDictation).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryMode: "preview",
          routePreference: "cloud",
        }),
      );
    });
  });

  it("keeps Profile default blocked by its missing local route", async () => {
    useMissingLocalDictationRoute();
    backendMocks.privacyOverrides.remoteProcessingEnabled = true;

    render(<DictationView />);
    await chooseOneOffRoute("The cloud");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start dictation/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Profile default" }));

    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start dictation/i }),
    ).not.toBeInTheDocument();
    expect(backendMocks.startDictation).not.toHaveBeenCalled();
  });

  it("tells a cloud dictation route that dictionary terms travel with the audio", async () => {
    // The dictionary now reaches the recognizer. For a cloud route that
    // means the terms leave the machine, and for ElevenLabs it costs extra;
    // both belong where the route is chosen, not only in developer docs.
    backendMocks.transcriptionOverrides.defaultProvider = "elevenlabs_scribe";
    backendMocks.transcriptionOverrides.dictationProvider = "elevenlabs_scribe";

    render(<DictationView />);

    fireEvent.click(await screen.findByRole("tab", { name: "Profiles" }));

    expect(
      await screen.findByText(
        /dictionary terms and snippet triggers are sent with the audio.*ElevenLabs bills 20% more/,
      ),
    ).toBeInTheDocument();
  });

  it("does not call a secure-field refusal 'ready to review'", async () => {
    // The sidecar refused to write into a password field. Nothing was
    // inserted or copied, so the status line must say that instead of the
    // generic ready message, and the paste status carries the reason.
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          text: "hunter two",
          outcome: "secure_field",
          pasted: false,
          copied: false,
          pasteError:
            "The field in front is a password or secure input, so Plainsong did not insert or copy the words. They are kept in your dictation history.",
          actualProvider: "distil_whisper",
        },
      });
    });

    expect(
      await screen.findAllByText(/password or secure input/),
    ).not.toHaveLength(0);
    expect(screen.queryByText("Result is ready to review.")).not.toBeInTheDocument();
  });

  it("shows a safe saved dictation load error and retries the read", async () => {
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockRejectedValueOnce(new Error("native dump with private transcript"));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't load this saved dictation. Try again.");
    expect(within(dialog).queryByText("No transcript is available for this dictation.")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/native dump/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("No transcript is available for this dictation.")).toBeInTheDocument();
    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("retries failed history metadata without claiming the transcript is missing", async () => {
    const recording = createSavedDictation();
    backendMocks.recordings = [recording];
    backendMocks.getTranscript.mockResolvedValue(createSavedTranscript(recording.id, "Saved transcript"));
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockRejectedValueOnce(new Error("private metadata dump"));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't load this saved dictation. Try again.");
    expect(within(dialog).queryByText("No transcript is available for this dictation.")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByDisplayValue("Saved transcript")).toBeInTheDocument();
  });

  it("ignores a saved dictation load failure after the dialog closes", async () => {
    const pending = deferred<ReturnType<typeof createSavedTranscript>>();
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockResolvedValue(null).mockReturnValueOnce(pending.promise);
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());
    await act(async () => { pending.reject(new Error("stale private dump")); });
    fireEvent.click(screen.getByRole("button", { name: "Open saved dictation: Project update" }));
    const reopened = await screen.findByRole("dialog", { name: "Project update" });
    expect(await within(reopened).findByText("No transcript is available for this dictation.")).toBeInTheDocument();
    expect(within(reopened).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
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

    await waitFor(() => expect(openButton).toHaveFocus());
    await user.keyboard(" ");
    expect(
      await screen.findByRole("dialog", { name: "Project update" }),
    ).toBeInTheDocument();
  });

  it("requires confirmation before deleting a saved dictation", async () => {
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.recordingsError = null;

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

  describe("saved dictation deletion recovery", () => {
    async function openDeleteConfirmation() {
      fireEvent.click(
        await screen.findByRole("button", { name: "Delete Project update" }),
      );
      return await screen.findByRole("dialog", {
        name: "Delete this dictation?",
      });
    }

    it("allows only one delete request while deletion is pending", async () => {
      const pendingDelete = deferred<void>();
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.deleteRecording.mockReturnValueOnce(pendingDelete.promise);

      render(<DictationView />);

      const confirmDialog = await openDeleteConfirmation();
      fireEvent.click(
        within(confirmDialog).getByRole("button", { name: "Delete dictation" }),
      );

      const deletingButton = within(confirmDialog).getByRole("button", {
        name: "Deleting…",
      });
      expect(deletingButton).toBeDisabled();
      expect(within(confirmDialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      fireEvent.click(deletingButton);
      expect(backendMocks.deleteRecording).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingDelete.resolve(undefined);
        await pendingDelete.promise;
      });
      await waitFor(() => expect(confirmDialog).not.toBeInTheDocument());
    });

    it("keeps the confirmation open with an inline error and allows retry", async () => {
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.deleteRecording
        .mockRejectedValueOnce(new Error("disk busy"))
        .mockResolvedValueOnce(undefined);

      render(<DictationView />);

      const confirmDialog = await openDeleteConfirmation();
      fireEvent.click(
        within(confirmDialog).getByRole("button", { name: "Delete dictation" }),
      );

      expect(
        await within(confirmDialog).findByRole("alert"),
      ).toHaveTextContent(
        "Could not delete this dictation. It is still saved. Try again.",
      );
      fireEvent.click(
        within(confirmDialog).getByRole("button", { name: "Delete dictation" }),
      );

      await waitFor(() => {
        expect(backendMocks.deleteRecording).toHaveBeenCalledTimes(2);
        expect(confirmDialog).not.toBeInTheDocument();
      });
    });

    it("does not report deletion failure when only the history refresh fails", async () => {
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.deleteRecording.mockResolvedValueOnce(undefined);
      backendMocks.refetchDictationHistory.mockRejectedValueOnce(
        new Error("refresh unavailable"),
      );

      render(<DictationView />);

      const confirmDialog = await openDeleteConfirmation();
      fireEvent.click(
        within(confirmDialog).getByRole("button", { name: "Delete dictation" }),
      );

      await waitFor(() => expect(confirmDialog).not.toBeInTheDocument());
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/^Dictation deleted\./),
        "error",
      );
      expect(toast).not.toHaveBeenCalledWith(
        expect.stringMatching(/still in your history/i),
        "error",
      );
      expect(
        screen.queryByText(
          "Could not delete this dictation. It is still saved. Try again.",
        ),
      ).not.toBeInTheDocument();
    });

    it("warns when deletion will also remove an unfinished edit", async () => {
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.listDictationDrafts.mockResolvedValueOnce([
        {
          recordingId: "dictation-1",
          title: "Project update",
          text: "Unfinished project update",
          expectedSavedText: null,
        },
      ]);

      render(<DictationView />);
      await screen.findByText("Unfinished edits (1)");

      const confirmDialog = await openDeleteConfirmation();
      expect(confirmDialog).toHaveTextContent(/unfinished edit.*deleted from recovery/i);
    });
  });

  it("groups history by day with short times and a preview, not a raw status", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    backendMocks.recordings = [
      createSavedDictation({
        id: "today-1",
        title: "Dictation - today",
        createdAt: now.toISOString(),
        transcript: {
          id: "t-today-1",
          recordingId: "today-1",
          segments: [],
          fullText: "Ship the release notes after lunch.",
          language: "en",
          confidence: 1,
          model: "test",
        },
      }),
      createSavedDictation({
        id: "yesterday-1",
        title: "Dictation - yesterday",
        createdAt: yesterday.toISOString(),
        status: "error",
      }),
    ];

    render(<DictationView />);

    expect(
      await screen.findByRole("heading", { name: "Today", level: 3 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Yesterday", level: 3 }),
    ).toBeInTheDocument();
    // The words, not the generic title, lead the row.
    expect(
      screen.getByText("Ship the release notes after lunch."),
    ).toBeInTheDocument();
    // A finished dictation says nothing about its status; a failed one does.
    expect(screen.queryByText(/completed/)).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("pages history with Show more instead of stopping at 25", async () => {
    backendMocks.recordings = Array.from({ length: 30 }, (_, index) =>
      createSavedDictation({ id: `d-${index}`, title: `Note ${index}` }),
    );

    render(<DictationView />);

    await screen.findByRole("button", { name: "Open saved dictation: Note 0" });
    expect(
      screen.queryByRole("button", { name: "Open saved dictation: Note 29" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 25 of 30/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(
      screen.getByRole("button", { name: "Open saved dictation: Note 29" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("confirms a history copy in place", async () => {
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockResolvedValueOnce({
      fullText: "  Project update text\nwith spacing.  \n",
    });

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy Project update" }),
    );

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        "  Project update text\nwith spacing.  \n",
      );
    });
    expect(
      await screen.findByRole("button", { name: "Copy Project update" }),
    ).toHaveTextContent("Copied");
  });

  it.each([null, { fullText: "" }, { fullText: "  \n\t  " }])(
    "does not copy a history item without saved text: %j",
    async (savedTranscript) => {
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.getTranscript.mockResolvedValueOnce(savedTranscript);

      render(<DictationView />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Copy Project update" }),
      );

      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith(
          "No text was saved. Open this dictation to check whether its audio can be processed again.",
          "error",
        );
      });
      expect(clipboardWriteText).not.toHaveBeenCalled();
    },
  );

  it("does not let a pending history read overwrite a latest-result copy", async () => {
    const historyTranscript = deferred<any>();
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockReturnValueOnce(historyTranscript.promise);

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy Project update" }),
    );
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    await act(async () => {
      handler?.({ payload: { text: "Newest result", pasted: true, copied: false } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Copy result" }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Newest result");
    });
    await act(async () => {
      historyTranscript.resolve({ fullText: "Older history" });
      await historyTranscript.promise;
    });

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it("does not let a pending history read overwrite a saved-result dialog copy", async () => {
    const historyTranscript = deferred<any>();
    backendMocks.recordings = [
      createSavedDictation({ id: "dictation-a", title: "First note" }),
      createSavedDictation({ id: "dictation-b", title: "Second note" }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) => {
      if (recordingId === "dictation-a") return historyTranscript.promise;
      return createSavedTranscript("dictation-b", "Dialog text");
    });

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy First note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open saved dictation: Second note" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Second note" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Copy" })[1]);

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Dialog text");
    });
    await act(async () => {
      historyTranscript.resolve({ fullText: "Older history" });
      await historyTranscript.promise;
    });

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it("does not finish a pending history copy after the view unmounts", async () => {
    const historyTranscript = deferred<any>();
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockReturnValueOnce(historyTranscript.promise);

    const view = render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy Project update" }),
    );
    view.unmount();

    await act(async () => {
      historyTranscript.resolve({ fullText: "Late text" });
      await historyTranscript.promise;
    });

    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
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

  it("keeps a manual edit when the history refresh callback changes without a new result", async () => {
    const originalRefetch = backendMocks.refetchDictationHistory;
    const view = render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { sessionId: 51, acknowledgedAtMs: 3000, text: "Original recognized text.", outcome: "previewed" },
      });
    });
    const editor = await screen.findByLabelText("Latest dictation result");
    fireEvent.change(editor, { target: { value: "Meaning-preserving manual correction." } });
    try {
      backendMocks.refetchDictationHistory = vi.fn();
      await act(async () => { view.rerender(<DictationView />); });
      expect(editor).toHaveValue("Meaning-preserving manual correction.");
    } finally {
      backendMocks.refetchDictationHistory = originalRefetch;
    }
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

  it("stops history read aloud when the history dialog closes", async () => {
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockResolvedValue(
      createSavedTranscript(
        "dictation-1",
        "Ship the quarterly budget summary to finance.",
      ),
    );

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Read aloud" }),
    );
    await waitFor(() => expect(speechSynthesisMock.speak).toHaveBeenCalled());
    speechSynthesisMock.cancel.mockClear();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalledTimes(1);
    });
  });

  it("stops history read aloud when another history entry opens", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    vi.mocked(dictationBackend.getDictationHistoryDetails).mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Ship the quarterly budget summary to finance."
          : "Recovered customer follow-up.",
      ),
    );
    backendMocks.reprocessDictation.mockResolvedValue({
      recording: createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
      }),
      transcript: createSavedTranscript(
        "dictation-2",
        "Recovered customer follow-up.",
      ),
      finalText: "Recovered customer follow-up.",
      rawText: "Recovered customer follow-up.",
      modePreset: "voice",
      customModeId: null,
      customModeName: null,
      provider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      usedAi: false,
    });

    render(<DictationView />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    fireEvent.click(
      await within(firstDialog).findByRole("button", { name: "Read aloud" }),
    );
    await waitFor(() => expect(speechSynthesisMock.speak).toHaveBeenCalled());
    speechSynthesisMock.cancel.mockClear();

    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Process again" }),
    );
    fireEvent.click(
      await within(firstDialog).findByRole("button", { name: "Open it" }),
    );

    await screen.findByRole("dialog", { name: "Customer follow-up" });
    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalledTimes(1);
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

  describe("dictation start ownership", () => {
    beforeEach(() => {
      backendMocks.invoke.mockImplementation(async (command: string) =>
        command === "get_dictation_overlay_state"
          ? { phase: "idle" }
          : { pasted: true, copied: false },
      );
    });

    it("sends one request and disables the start control while start is pending", async () => {
      const pendingStart = deferred<void>();
      backendMocks.startDictation.mockReturnValueOnce(pendingStart.promise);
      render(<DictationView />);

      const startButton = await screen.findByRole("button", {
        name: "Start dictation",
      });
      fireEvent.click(startButton);

      const startingButton = screen.getByRole("button", { name: "Starting…" });
      expect(startingButton).toBeDisabled();
      expect(screen.getByText("Starting dictation")).toBeInTheDocument();
      expect(screen.getByText("Waiting for capture to start.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop dictation" })).not.toBeInTheDocument();
      fireEvent.click(startingButton);
      expect(backendMocks.startDictation).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingStart.resolve(undefined);
        await pendingStart.promise;
      });
    });

    it("allows retry after the current start request fails", async () => {
      const pendingStart = deferred<void>();
      backendMocks.startDictation.mockReturnValueOnce(pendingStart.promise);
      render(<DictationView />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Start dictation" }),
      );
      await act(async () => {
        pendingStart.reject(new Error("Microphone did not start"));
        await pendingStart.promise.catch(() => {});
      });

      expect(
        await screen.findByRole("button", { name: "Retry dictation" }),
      ).toBeEnabled();
    });

    it("offers cancellation when preparing owns a pending start", async () => {
      const pendingStart = deferred<void>();
      backendMocks.startDictation.mockReturnValueOnce(pendingStart.promise);
      render(<DictationView />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Start dictation" }),
      );
      await act(async () => {
        backendMocks.eventListeners.get("dictation-state-changed")?.({
          payload: { phase: "preparing", sessionId: 84 },
        });
      });

      expect(
        await screen.findByRole("button", { name: "Cancel dictation" }),
      ).toBeEnabled();

      await act(async () => {
        pendingStart.resolve(undefined);
        await pendingStart.promise;
      });
    });
  });

  describe("dictation meeting separation", () => {
    it.each(["preparing", "recording", "stopping"] as const)(
      "blocks dictation while a meeting is %s",
      async (meetingPhase) => {
        recordingSessionState.recordingMode = "meeting";
        recordingSessionState.meetingPhase = meetingPhase;
        recordingSessionState.isRecording = meetingPhase === "recording";
        render(<DictationView />);

        const blocked = await screen.findByRole("button", {
          name: "Meeting in progress",
        });
        expect(blocked).toBeDisabled();
        expect(
          screen.getByText("Stop the meeting before starting dictation."),
        ).toBeInTheDocument();
        fireEvent.click(blocked);
        expect(backendMocks.startDictation).not.toHaveBeenCalled();
      },
    );

    it("keeps the latest words editable and copyable during a meeting", async () => {
      const view = render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({
          payload: { recordingId: "dictation-latest", text: "Original latest words" },
        });
      });
      recordingSessionState.recordingMode = "meeting";
      recordingSessionState.meetingPhase = "recording";
      recordingSessionState.isRecording = true;
      view.rerender(<DictationView />);
      const editor = screen.getByRole("textbox", { name: "Latest dictation result" });

      fireEvent.change(editor, { target: { value: "Edited while meeting continues" } });
      expect(editor).toHaveValue("Edited while meeting continues");
      fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
      await waitFor(() =>
        expect(clipboardWriteText).toHaveBeenCalledWith("Edited while meeting continues"),
      );
    });

    it("restores Start dictation after the meeting ends", async () => {
      recordingSessionState.recordingMode = "meeting";
      recordingSessionState.meetingPhase = "stopping";
      const view = render(<DictationView />);
      expect(
        await screen.findByRole("button", { name: "Meeting in progress" }),
      ).toBeDisabled();

      recordingSessionState.recordingMode = null;
      recordingSessionState.meetingPhase = "ready";
      view.rerender(<DictationView />);

      expect(screen.getByRole("button", { name: /Start dictation|Retry dictation|Start next dictation/ })).toBeEnabled();
    });

    it("blocks a stale start control without consuming the one-off route", async () => {
      useMissingLocalDictationRoute();
      backendMocks.privacyOverrides.remoteProcessingEnabled = true;
      const view = render(<DictationView />);
      await chooseOneOffRoute("The cloud");
      const staleStart = await screen.findByRole("button", { name: /Start dictation/i });
      await waitFor(() => expect(staleStart).toBeEnabled());
      expect(screen.getByText("Cloud for this capture")).toBeInTheDocument();

      recordingSessionState.recordingMode = "meeting";
      recordingSessionState.meetingPhase = "recording";
      recordingSessionState.isRecording = true;
      view.rerender(<DictationView />);
      expect(screen.getByRole("button", { name: "Meeting in progress" })).toBeDisabled();
      fireEvent.click(staleStart);
      expect(backendMocks.startDictation).not.toHaveBeenCalled();
      expect(screen.getByText("Cloud for this capture")).toBeInTheDocument();

      recordingSessionState.recordingMode = null;
      recordingSessionState.meetingPhase = "ready";
      recordingSessionState.isRecording = false;
      view.rerender(<DictationView />);
      expect(screen.getByText("Cloud for this capture")).toBeInTheDocument();
      expect(backendMocks.startDictation).not.toHaveBeenCalled();
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
    expect(screen.getByText("Mode in use: Meeting Follow-up")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Capture profile" })).toBeDisabled();
  });

  it("keeps a late stop result behind a text-ready edit", async () => {
    const pendingStop = deferred<string>();
    backendMocks.stopDictation.mockReturnValueOnce(pendingStop.promise);
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "recording", message: "Capture is live." },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));

    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "Event result", actualProvider: "parakeet" },
      });
    });
    const result = await screen.findByRole("textbox", { name: "Latest dictation result" });
    fireEvent.change(result, { target: { value: "My edit" } });

    await act(async () => {
      pendingStop.resolve("Stale stop result");
      await pendingStop.promise;
    });

    expect(result).toHaveValue("My edit");
    expect(screen.getByText(/You changed this after capture\./)).toBeInTheDocument();
  });

  it("keeps a newer text-ready event ahead of a late stop result", async () => {
    const pendingStop = deferred<string>();
    backendMocks.stopDictation.mockReturnValueOnce(pendingStop.promise);
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "recording" },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "First event", actualProvider: "parakeet" },
      });
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "Newer event", actualProvider: "parakeet" },
      });
    });

    await act(async () => {
      pendingStop.resolve("Stale stop result");
      await pendingStop.promise;
    });

    expect(await screen.findByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Newer event");
  });

  it("ignores a canceled start failure after a newer recording owns the session", async () => {
    const startA = deferred<void>();
    backendMocks.startDictation.mockReturnValueOnce(startA.promise);
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    fireEvent.click(await screen.findByRole("button", { name: /start dictation/i }));
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "preparing", sessionId: 41 } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel dictation" }));

    await act(async () => {
      stateHandler?.({ payload: { phase: "recording", sessionId: 42 } });
    });
    await act(async () => {
      startA.reject(new Error("Start A failed"));
      await startA.promise.catch(() => {});
    });

    expect(screen.queryByText("Start A failed")).not.toBeInTheDocument();
  });

  it("keeps a successful text-ready result when an old stop fails", async () => {
    const pendingStop = deferred<string>();
    backendMocks.stopDictation.mockReturnValueOnce(pendingStop.promise);
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 51 },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "Successful result", sessionId: 51, actualProvider: "parakeet" },
      });
    });

    await act(async () => {
      pendingStop.reject(new Error("Old stop failed"));
      await pendingStop.promise.catch(() => {});
    });

    expect(await screen.findByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Successful result");
    expect(screen.queryByText("Old stop failed")).not.toBeInTheDocument();
  });

  it("passes the preparing session id when canceling dictation", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "preparing", sessionId: 42 } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel dictation" }));

    await waitFor(() => {
      expect(backendMocks.invoke).toHaveBeenCalledWith("force_stop_dictation", { sessionId: 42 });
    });
  });

  it("cancels the current transcription without stopping capture or changing phase optimistically", async () => {
    const pendingCancel = deferred<unknown>();
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    backendMocks.invoke.mockImplementation(async (command: string) =>
      command === "force_stop_dictation"
        ? pendingCancel.promise
        : { pasted: true, copied: false },
    );
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "transcribing", sessionId: 71 },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));

    expect(forceStopCalls()).toEqual([["force_stop_dictation", { sessionId: 71 }]]);
    expect(backendMocks.stopDictation).not.toHaveBeenCalled();
    expect(screen.getAllByText("Transcribing").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      pendingCancel.resolve(undefined);
      await pendingCancel.promise;
    });
    expect(screen.getByRole("button", { name: "Cancel dictation" })).toBeEnabled();
  });

  it("sends only one cancellation while the current session request is pending", async () => {
    const pendingCancel = deferred<unknown>();
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    backendMocks.invoke.mockImplementation(async (command: string) =>
      command === "force_stop_dictation"
        ? pendingCancel.promise
        : { pasted: true, copied: false },
    );
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "stopping", sessionId: 72 },
      });
    });
    const cancel = screen.getByRole("button", { name: "Cancel dictation" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);

    expect(forceStopCalls()).toEqual([["force_stop_dictation", { sessionId: 72 }]]);

    await act(async () => {
      pendingCancel.resolve(undefined);
      await pendingCancel.promise;
    });
  });

  it("shows a cancellation failure and allows retrying the same session", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    let cancellationAttempts = 0;
    backendMocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "force_stop_dictation") return { pasted: true, copied: false };
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) throw new Error("bridge unavailable");
      return undefined;
    });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "transcribing", sessionId: 73 },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not cancel this dictation. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));

    await waitFor(() => expect(forceStopCalls()).toHaveLength(2));
    expect(forceStopCalls()[1]).toEqual(["force_stop_dictation", { sessionId: 73 }]);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not offer processing cancellation during delivery or without a valid session id", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "transcribing" } });
    });
    expect(screen.queryByRole("button", { name: "Cancel dictation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    await act(async () => {
      stateHandler?.({ payload: { phase: "delivering", sessionId: 74 } });
    });
    expect(screen.queryByRole("button", { name: "Cancel dictation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inserting…" })).toBeDisabled();
    expect(forceStopCalls()).toHaveLength(0);
  });

  it("lets a new session cancel while the old acknowledgement remains pending", async () => {
    const oldCancel = deferred<unknown>();
    const newCancel = deferred<unknown>();
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    let cancellationAttempts = 0;
    backendMocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "force_stop_dictation") return { pasted: true, copied: false };
      cancellationAttempts += 1;
      return cancellationAttempts === 1 ? oldCancel.promise : newCancel.promise;
    });
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "transcribing", sessionId: 75 } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));

    await act(async () => {
      stateHandler?.({ payload: { phase: "preparing", sessionId: 76 } });
      stateHandler?.({ payload: { phase: "stopping", sessionId: 76 } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(forceStopCalls()[1]).toEqual(["force_stop_dictation", { sessionId: 76 }]);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      oldCancel.resolve(undefined);
      await oldCancel.promise;
    });
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      newCancel.reject(new Error("new cancellation failed"));
      await newCancel.promise.catch(() => {});
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not cancel this dictation. Try again.",
    );
  });

  it("blocks a stale cancel callback after a newer phase owns the session", async () => {
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    backendMocks.invoke.mockClear();
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "transcribing", sessionId: 77 } });
    });
    const staleCancel = screen.getByRole("button", { name: "Cancel dictation" });

    await act(async () => {
      stateHandler?.({ payload: { phase: "delivering", sessionId: 77 } });
    });
    fireEvent.click(staleCancel);

    expect(forceStopCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Inserting…" })).toBeDisabled();
  });

  it("keeps the current start failure visible after a preparing event for its own session", async () => {
    const pendingStart = deferred<void>();
    backendMocks.startDictation.mockReturnValueOnce(pendingStart.promise);
    render(<DictationView />);

    await screen.findByRole("button", { name: /start dictation/i });
    fireEvent.click(screen.getByRole("button", { name: /start dictation/i }));
    const stateHandler = backendMocks.eventListeners.get("dictation-state-changed");
    await act(async () => {
      stateHandler?.({ payload: { phase: "preparing", sessionId: 61 } });
    });
    await act(async () => {
      pendingStart.reject(new Error("Current start failed"));
      await pendingStart.promise.catch(() => {});
    });

    expect((await screen.findAllByText("Current start failed")).length).toBeGreaterThan(0);
  });

  it("uses the stop return text when no newer result arrives", async () => {
    const pendingStop = deferred<string>();
    backendMocks.stopDictation.mockReturnValueOnce(pendingStop.promise);
    render(<DictationView />);

    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-state-changed")?.({
        payload: { phase: "recording" },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));

    await act(async () => {
      pendingStop.resolve("Fallback stop result");
      await pendingStop.promise;
    });

    expect(await screen.findByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Fallback stop result");
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
    expect(screen.queryByText("Opening microphone")).toBeNull();

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

    expect(await screen.findByText("Opening microphone")).toBeInTheDocument();
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
      "Speech recognized",
      "Whole session",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("shows stop-to-insertion time only for confirmed app delivery", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");
    await act(async () => { handler?.({ payload: {
      text: "Delivered", pasted: true, copied: false, insertionModeUsed: "auto", endToEndMs: 22000,
      timing: { stopCommandReceivedAtEpochMs: 1, insertionConfirmed: true, insertionConfirmedMs: 3038, formatOutcome: "applied" },
    } }); });
    expect(await screen.findByText("Inserted after stop")).toBeInTheDocument();
    expect(screen.getByText("3.0s")).toBeInTheDocument();
    expect(screen.getByText("Whole session")).toBeInTheDocument();
    for (const data of [
      { pasted: true, insertionConfirmed: false, insertionConfirmedMs: 3038 },
      { pasted: false, insertionConfirmed: true, insertionConfirmedMs: 3038 },
      { pasted: true, insertionConfirmed: true, insertionConfirmedMs: -1 },
      { pasted: true, insertionConfirmed: true, insertionConfirmedMs: Number.NaN },
    ]) {
      await act(async () => { handler?.({ payload: {
        text: "Next result", pasted: data.pasted, timing: { stopCommandReceivedAtEpochMs: 1, insertionConfirmed: data.insertionConfirmed, insertionConfirmedMs: data.insertionConfirmedMs, formatOutcome: "applied" },
      } }); });
      expect(screen.queryByText("Inserted after stop")).not.toBeInTheDocument();
    }
  });

  it("keeps cleanup warnings visible and measures text readiness after cleanup", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    const warning = "AI formatting was unavailable or changed your words; the local transcript was kept.";
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: {
        text: "Keep the Friday meeting.", actualProvider: "whisper",
        insertionModeUsed: "preview", pasted: false, copied: false,
        finalTranscriptLatencyMs: 330, warnings: [warning],
        timing: { stopCommandReceivedAtEpochMs: 1, asrCompleteMs: 330,
          formatCompleteMs: 2400, formatOutcome: "failed", insertionConfirmed: false },
      } });
    });
    expect(await screen.findByText("Last dictation: finished with a note")).toBeInTheDocument();
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText(`Result is ready to review. ${warning}`)).toBeInTheDocument();
    expect(screen.getByText("Text ready after stop")).toBeInTheDocument();
    expect(screen.getByText("2.4s")).toBeInTheDocument();
    expect(screen.queryByText("Last dictation: preview ready")).not.toBeInTheDocument();
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: {
        text: "Next result", insertionModeUsed: "preview", warnings: [],
      } });
    });
    expect(await screen.findByText("Last dictation: preview ready")).toBeInTheDocument();
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(screen.queryByText("Text ready after stop")).not.toBeInTheDocument();
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

    expect(await screen.findByText("Profile rule: slack")).toBeInTheDocument();
    expect(screen.getByText("Target app: Slack")).toBeInTheDocument();
    expect(screen.queryByText(/^Return:/)).not.toBeInTheDocument();
  });

  it("says whether Return was sent only when the binding asked for it", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    const handler = backendMocks.eventListeners.get("dictation-text-ready");

    await act(async () => {
      handler?.({ payload: { text: "Ship it", pasted: true, appTarget: "Slack", submitAfterInsertSent: true } });
    });
    expect(await screen.findByText("Return: Sent")).toBeInTheDocument();

    await act(async () => {
      handler?.({ payload: { text: "Hold on", pasted: true, appTarget: "Slack", submitAfterInsertSent: false } });
    });
    expect(await screen.findByText("Return: Not sent")).toBeInTheDocument();
    expect(screen.queryByText("Return: Sent")).not.toBeInTheDocument();
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

    expect(await screen.findByText("Queued for review: jon → John")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn correction" })).toBeEnabled();
    fireEvent.blur(editor);
    await act(async () => {});
    expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() => expect(backend.learnDictationCorrection).toHaveBeenCalledWith({
      originalText: "please email jon tomorrow", correctedText: "please email John tomorrow",
      appTarget: null, force: true,
    }));
  });

  it("offers direct latest-result learning Undo without opening Corrections", async () => {
    const backend = await import("@/lib/backend/dictation");
    const before = dictionaryEntryFixture({ replacement: "Jonathan" });
    const after = dictionaryEntryFixture({ updatedAt: "2026-10-20T10:01:00.000Z" });
    vi.mocked(backend.listDictationDictionaryEntries).mockResolvedValueOnce([before]);
    vi.mocked(backend.learnDictationCorrection).mockResolvedValueOnce({
      learned: true, action: "updated", spokenForm: "jon", replacement: "John",
      entry: after, undoToken: "direct-undo",
    });
    vi.mocked(backend.undoDictationCorrectionApproval).mockResolvedValueOnce({ entryId: before.id, entry: before });
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: {
        text: "please email jon tomorrow", actualProvider: "distil_whisper",
      } });
    });
    fireEvent.change(screen.getByDisplayValue("please email jon tomorrow"), {
      target: { value: "please email John tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    const undo = await screen.findByRole("button", { name: "Undo correction: jon → John" });
    expect(backend.learnDictationCorrection).toHaveBeenCalledTimes(1);
    fireEvent.click(undo);
    await waitFor(() => expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledWith("direct-undo"));
    expect(await screen.findByText("Undone: jon → John")).toBeInTheDocument();
    await openConfigTab("Dictionary");
    expect(await screen.findByRole("group", { name: "Dictionary entry: jon to Jonathan" })).toBeInTheDocument();
  });

  it("keeps explicit learning status when an older automatic queue reply arrives", async () => {
    const backend = await import("@/lib/backend/dictation");
    const request = { originalText: "please email jon tomorrow", correctedText: "please email John tomorrow", appTarget: null, force: false };
    const queued = await vi.mocked(backend.queueDictationCorrectionSuggestion).getMockImplementation()!(request);
    let release!: (value: typeof queued) => void;
    vi.mocked(backend.queueDictationCorrectionSuggestion).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => { backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { text: request.originalText, actualProvider: "distil_whisper" } }); });
    const editor = screen.getByDisplayValue(request.originalText);
    fireEvent.change(editor, { target: { value: request.correctedText } });
    fireEvent.blur(editor);
    await waitFor(() => expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await screen.findByText("Learned: jon → John");
    await act(async () => { release(queued); });
    expect(screen.getByText("Learned: jon → John")).toBeInTheDocument();
    expect(screen.queryByText("Queued for review: jon → John")).not.toBeInTheDocument();
  });

  it("ignores a late latest-result correction success after newer dictation arrives", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const lateLearn = deferred<
      Awaited<ReturnType<typeof dictationBackend.learnDictationCorrection>>
    >();
    vi.mocked(dictationBackend.learnDictationCorrection).mockReturnValueOnce(
      lateLearn.promise,
    );

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
    fireEvent.change(screen.getByDisplayValue("please email jon tomorrow"), {
      target: { value: "please email John tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      handler?.({
        payload: {
          text: "please email sara tomorrow",
          actualProvider: "distil_whisper",
        },
      });
    });
    expect(
      screen.getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    await act(async () => {
      lateLearn.resolve({
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
          createdAt: "2026-08-01T12:01:00.000Z",
          updatedAt: "2026-08-01T12:01:00.000Z",
        },
      });
      await lateLearn.promise;
    });

    expect(screen.queryByText("Learned: jon → John")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("please email sara tomorrow")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    await openConfigTab("Dictionary");
    const recentlyLearned = await screen.findByTestId(
      "recently-learned-dictionary",
    );
    expect(recentlyLearned).toHaveTextContent("jon");
    expect(recentlyLearned).toHaveTextContent("John");

    const currentEditor = screen.getByDisplayValue("please email sara tomorrow");
    fireEvent.change(currentEditor, {
      target: { value: "please email Sarah tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenLastCalledWith({
        originalText: "please email sara tomorrow",
        correctedText: "please email Sarah tomorrow",
        appTarget: null,
        force: true,
      }),
    );
  });

  it("ignores a late latest-result correction failure after newer dictation arrives", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const lateLearn = deferred<
      Awaited<ReturnType<typeof dictationBackend.learnDictationCorrection>>
    >();
    vi.mocked(dictationBackend.learnDictationCorrection).mockReturnValueOnce(
      lateLearn.promise,
    );

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
    fireEvent.change(screen.getByDisplayValue("please email jon tomorrow"), {
      target: { value: "please email John tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      handler?.({
        payload: {
          text: "please email sara tomorrow",
          actualProvider: "distil_whisper",
        },
      });
    });
    await act(async () => {
      lateLearn.reject(new Error("A correction failed"));
      try {
        await lateLearn.promise;
      } catch {
        // The component converts the rejected request into status text.
      }
    });

    expect(screen.queryByText("A correction failed")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByDisplayValue("please email sara tomorrow"), {
      target: { value: "please email Sarah tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenLastCalledWith({
        originalText: "please email sara tomorrow",
        correctedText: "please email Sarah tomorrow",
        appTarget: null,
        force: true,
      }),
    );
  });

  it("ignores a late automatic latest-result correction status after newer dictation arrives", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    const lateQueue = deferred<
      Awaited<ReturnType<typeof dictationBackend.queueDictationCorrectionSuggestion>>
    >();
    vi.mocked(
      dictationBackend.queueDictationCorrectionSuggestion,
    ).mockReturnValueOnce(lateQueue.promise);

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
    const firstEditor = screen.getByDisplayValue("please email jon tomorrow");
    fireEvent.change(firstEditor, {
      target: { value: "please email John tomorrow" },
    });
    fireEvent.blur(firstEditor);
    await waitFor(() =>
      expect(
        dictationBackend.queueDictationCorrectionSuggestion,
      ).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      handler?.({
        payload: {
          text: "please email sara tomorrow",
          actualProvider: "distil_whisper",
        },
      });
    });
    await act(async () => {
      lateQueue.resolve({
        queued: true,
        action: "created",
        spokenForm: "jon",
        replacement: "John",
        suggestion: {
          id: "suggestion-1",
          originalText: "please email jon tomorrow",
          correctedText: "please email John tomorrow",
          spokenForm: "jon",
          replacement: "John",
          appTarget: null,
          createdAt: "2026-08-01T12:01:00.000Z",
          updatedAt: "2026-08-01T12:01:00.000Z",
        },
      });
      await lateQueue.promise;
    });

    expect(
      screen.queryByText("Queued for review: jon → John"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    const currentEditor = screen.getByDisplayValue("please email sara tomorrow");
    fireEvent.change(currentEditor, {
      target: { value: "please email Sarah tomorrow" },
    });
    fireEvent.blur(currentEditor);
    await waitFor(() =>
      expect(
        dictationBackend.queueDictationCorrectionSuggestion,
      ).toHaveBeenLastCalledWith({
        originalText: "please email sara tomorrow",
        correctedText: "please email Sarah tomorrow",
        appTarget: null,
        force: false,
      }),
    );
  });

  it.each(["initial", "event"])("keeps the newest correction list when an older %s read finishes late", async (olderRead) => {
    const backend = await import("@/lib/backend/dictation");
    const stale = deferred<Awaited<ReturnType<typeof backend.listDictationCorrectionSuggestions>>>();
    if (olderRead === "initial") {
      vi.mocked(backend.listDictationCorrectionSuggestions).mockReturnValueOnce(stale.promise);
    } else {
      vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([]);
    }
    render(<DictationView />);
    await openConfigTab("Corrections");
    const changed = backendMocks.eventListeners.get("dictation-correction-suggestions-changed");
    expect(changed).toBeDefined();
    if (olderRead === "event") {
      vi.mocked(backend.listDictationCorrectionSuggestions).mockReturnValueOnce(stale.promise);
      await act(async () => { changed?.({ payload: {} }); });
    }
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("newest", "sara", "Sarah"),
    ]);
    await act(async () => { changed?.({ payload: {} }); });
    expect(await screen.findByText(/sara → Sarah/)).toBeInTheDocument();
    await act(async () => {
      stale.resolve([correctionSuggestionFixture("older", "jon", "John")]);
      await stale.promise;
    });
    expect(screen.getByText(/sara → Sarah/)).toBeInTheDocument();
    expect(screen.queryByText(/jon → John/)).not.toBeInTheDocument();
  });

  it.each(["Approve", "Dismiss"])("does not restore a correction after %s when an older queue reply arrives", async (action) => {
    const backend = await import("@/lib/backend/dictation");
    const suggestion = { ...correctionSuggestionFixture("suggestion-1", "jon", "John"), appTarget: null, source: "external_app_readback" };
    const queued = deferred<Awaited<ReturnType<typeof backend.queueDictationCorrectionSuggestion>>>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([suggestion]);
    vi.mocked(backend.queueDictationCorrectionSuggestion).mockReturnValueOnce(queued.promise);
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({ payload: { text: suggestion.originalText, actualProvider: "distil_whisper" } });
    });
    const editor = screen.getByDisplayValue(suggestion.originalText);
    fireEvent.change(editor, { target: { value: suggestion.correctedText } });
    fireEvent.blur(editor);
    await waitFor(() => expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalledTimes(1));
    await openConfigTab("Corrections");
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
    await act(async () => {
      queued.resolve({ queued: true, action: "updated", spokenForm: "jon", replacement: "John", suggestion });
      await queued.promise;
    });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
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
        approvalDictionary: { kind: "missing" },
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
        approvalDictionary: { kind: "missing" },
        createdAt: new Date("2026-03-14T11:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T11:00:00Z").toISOString(),
      },
    ]);

    render(<DictationView />);

    await openConfigTab("Corrections");
    expect(await screen.findByText(/2 similar edits/i)).toBeInTheDocument();

    const stale = deferred<Awaited<ReturnType<typeof backend.listDictationCorrectionSuggestions>>>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockReturnValueOnce(stale.promise);
    await act(async () => {
      backendMocks.eventListeners.get("dictation-correction-suggestions-changed")?.({ payload: {} });
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve all" }));

    await waitFor(() => {
      expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith(
        "suggestion-1",
        { kind: "missing" },
      );
      expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith("suggestion-2");
    });
    await waitFor(() => expect(screen.queryByText(/2 similar edits/i)).not.toBeInTheDocument());
    await act(async () => {
      stale.resolve([
        correctionSuggestionFixture("suggestion-1", "jon", "John"),
        correctionSuggestionFixture("suggestion-2", "jon", "John"),
      ]);
      await stale.promise;
    });
    expect(screen.queryByRole("button", { name: "Approve all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("correction approval undo removes a newly created dictionary entry", async () => {
    const backend = await import("@/lib/backend/dictation");
    const user = userEvent.setup();
    const entry = dictionaryEntryFixture();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockResolvedValueOnce({
      learned: true,
      action: "created",
      undoToken: "undo-created",
      spokenForm: "jon",
      replacement: "John",
      entry,
    });
    vi.mocked(backend.undoDictationCorrectionApproval).mockResolvedValueOnce({
      entryId: entry.id,
      entry: null,
    });

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await screen.findByRole("button", {
      name: "Undo correction: jon → John",
    });
    await openConfigTab("Dictionary");
    expect(
      await screen.findByRole("group", { name: "Dictionary entry: jon to John" }),
    ).toBeInTheDocument();

    await openConfigTab("Corrections");
    const undoButton = screen.getByRole("button", { name: "Undo correction: jon → John" });
    undoButton.focus();
    await user.keyboard(" ");

    await waitFor(() =>
      expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledWith(
        "undo-created",
      ),
    );
    expect(await screen.findByText("Undone: jon → John")).toBeInTheDocument();
    expect(screen.getByText("Undone: jon → John").closest('[role="status"]')).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Undo correction: jon → John" }),
    ).not.toBeInTheDocument();

    await openConfigTab("Dictionary");
    expect(
      screen.queryByRole("group", { name: "Dictionary entry: jon to John" }),
    ).not.toBeInTheDocument();
    const dictionary = screen.getByTestId("dictionary-section");
    expect(within(dictionary).getByText("Undone: jon → John")).toBeInTheDocument();
    expect(within(dictionary).queryByText("Learned: jon → John")).not.toBeInTheDocument();
  });

  it("correction approval undo restores every edited dictionary field", async () => {
    const backend = await import("@/lib/backend/dictation");
    const before = dictionaryEntryFixture({
      id: "existing-1",
      spokenForm: "Jon",
      replacement: "Jonathan",
      appScope: "Mail",
      caseSensitive: true,
      enabled: false,
      categoryScope: "notes",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-06-01T09:00:00.000Z",
    });
    const after = dictionaryEntryFixture({
      id: before.id,
      createdAt: before.createdAt,
      updatedAt: "2026-10-12T10:01:00.000Z",
    });
    vi.mocked(backend.listDictationDictionaryEntries).mockResolvedValue([before]);
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John", undefined, {
        kind: "entry",
        entryId: before.id,
        revision: 1,
        spokenForm: before.spokenForm,
        replacement: before.replacement,
      }),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockResolvedValueOnce({
      learned: true,
      action: "updated",
      undoToken: "undo-updated",
      spokenForm: "jon",
      replacement: "John",
      entry: after,
    });
    vi.mocked(backend.undoDictationCorrectionApproval).mockResolvedValueOnce({
      entryId: before.id,
      entry: before,
    });

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const undoButton = await screen.findByRole("button", {
      name: "Undo correction: jon → John",
    });
    fireEvent.click(undoButton);

    await waitFor(() =>
      expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledWith(
        "undo-updated",
      ),
    );
    expect(await screen.findByText("Undone: jon → John")).toBeInTheDocument();

    await openConfigTab("Dictionary");
    const restored = await screen.findByRole("group", {
      name: "Dictionary entry: Jon to Jonathan",
    });
    expect(within(restored).getByLabelText("Only in app")).toHaveValue("Mail");
    expect(within(restored).getByLabelText("Case-sensitive")).toBeChecked();
    expect(within(restored).getByLabelText("Enabled")).not.toBeChecked();
    expect(
      within(restored).getByRole("combobox", { name: "Destination category" }),
    ).toHaveTextContent("Notes");
    const dictionary = screen.getByTestId("dictionary-section");
    expect(within(dictionary).getByText("Undone: jon → John")).toBeInTheDocument();
    expect(within(dictionary).queryByText("Updated: jon → John")).not.toBeInTheDocument();
  });

  it("previews the checked global scope and replaced value before approval", async () => {
    const backend = await import("@/lib/backend/dictation");
    const snapshot = { kind: "entry", entryId: "existing-1", revision: 3,
      spokenForm: "Jon", replacement: "Jonathan" } satisfies CorrectionApprovalDictionarySnapshot;
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("existing-suggestion", "Jon", "John", undefined, snapshot),
      correctionSuggestionFixture("new-suggestion", "Sara", "Sarah"),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockRejectedValueOnce(new Error("Your dictionary changed after this suggestion was shown."));
    render(<DictationView />);
    await openConfigTab("Corrections");
    expect(await screen.findByText("Replaces Jon → Jonathan")).toBeInTheDocument();
    expect(screen.getAllByText(/Applies everywhere/)).toHaveLength(2);
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith("existing-suggestion", snapshot));
    expect(await screen.findByRole("button", { name: "Refresh corrections" })).toBeInTheDocument();
    expect(screen.getByText("Replaces Jon → Jonathan")).toBeInTheDocument();
  });

  it("correction approval undo shows a conflict and keeps the receipt for retry", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockResolvedValueOnce({
      learned: true,
      action: "created",
      undoToken: "undo-retry",
      spokenForm: "jon",
      replacement: "John",
      entry: dictionaryEntryFixture(),
    });
    vi.mocked(backend.undoDictationCorrectionApproval)
      .mockRejectedValueOnce(new Error("This entry changed after approval."))
      .mockResolvedValueOnce({ entryId: "learned-1", entry: null });

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Undo correction: jon → John",
      }),
    );

    expect(
      await screen.findByText("This entry changed after approval."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole("button", {
      name: "Undo correction: jon → John",
    });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("Undone: jon → John")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo correction: jon → John" }),
    ).not.toBeInTheDocument();
  });

  it("correction approval undo keeps the Undo action single-flight", async () => {
    const backend = await import("@/lib/backend/dictation");
    const user = userEvent.setup();
    const pending = deferred<{
      entryId: string;
      entry: DictationDictionaryEntry | null;
    }>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockResolvedValueOnce({
      learned: true,
      action: "created",
      undoToken: "undo-pending",
      spokenForm: "jon",
      replacement: "John",
      entry: dictionaryEntryFixture(),
    });
    vi.mocked(backend.undoDictationCorrectionApproval).mockReturnValueOnce(
      pending.promise,
    );

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const undoButton = await screen.findByRole("button", {
      name: "Undo correction: jon → John",
    });
    undoButton.focus();
    await user.keyboard(" ");

    expect(undoButton).toHaveAttribute("aria-disabled", "true");
    expect(undoButton).toHaveFocus();
    await user.keyboard(" ");
    expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledTimes(1);
    const learningToggle = screen.getByRole("checkbox", { name: "Suggest corrections from edits" });
    learningToggle.focus();

    await act(async () => {
      pending.resolve({ entryId: "learned-1", entry: null });
    });
    expect(await screen.findByText("Undone: jon → John")).toBeInTheDocument();
    expect(learningToggle).toHaveFocus();
  });

  it("correction approval undo locks an existing dictionary row while approval is pending", async () => {
    const backend = await import("@/lib/backend/dictation");
    const before = dictionaryEntryFixture({
      id: "existing-1",
      spokenForm: "Jon",
      replacement: "Jonathan",
      appScope: "Mail",
      caseSensitive: true,
      enabled: false,
      categoryScope: "notes",
    });
    const after = dictionaryEntryFixture({
      id: before.id,
      spokenForm: "jon",
      replacement: "John",
      appScope: null,
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: before.createdAt,
      updatedAt: "2026-10-12T10:01:00.000Z",
    });
    const approval = deferred<Awaited<
      ReturnType<typeof backend.approveDictationCorrectionSuggestion>
    >>();
    vi.mocked(backend.listDictationDictionaryEntries).mockResolvedValue([before]);
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John", undefined, {
        kind: "entry",
        entryId: before.id,
        revision: 1,
        spokenForm: before.spokenForm,
        replacement: before.replacement,
      }),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockReturnValueOnce(
      approval.promise,
    );

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await openConfigTab("Dictionary");
    const row = await screen.findByRole("group", {
      name: "Dictionary entry: Jon to Jonathan",
    });
    expect(within(row).getByLabelText("Replace with")).toBeDisabled();
    expect(within(row).getByLabelText("Only in app")).toBeDisabled();
    expect(within(row).getByLabelText("Case-sensitive")).toBeDisabled();

    await act(async () => {
      approval.resolve({
        learned: true,
        action: "updated",
        undoToken: "undo-pending-approval",
        spokenForm: "jon",
        replacement: "John",
        entry: after,
      });
    });
    await waitFor(() =>
      expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledTimes(1),
    );
  });

  it("correction approval undo still works when duplicate cleanup fails", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
      correctionSuggestionFixture(
        "suggestion-2",
        "jon",
        "John",
        "Please invite jon to the review.",
      ),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockResolvedValueOnce({
      learned: true,
      action: "created",
      undoToken: "undo-after-cleanup-error",
      spokenForm: "jon",
      replacement: "John",
      entry: dictionaryEntryFixture(),
    });
    vi.mocked(backend.rejectDictationCorrectionSuggestion).mockRejectedValueOnce(
      new Error("Duplicate cleanup failed."),
    );
    vi.mocked(backend.undoDictationCorrectionApproval).mockResolvedValueOnce({
      entryId: "learned-1",
      entry: null,
    });

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(await screen.findByRole("button", { name: "Approve all" }));

    expect(
      await screen.findByText(
        "Learned: jon → John. Some duplicate suggestions could not be removed.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Undo correction: jon → John",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("jon → John")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith(
      "suggestion-2",
    );

    await openConfigTab("Dictionary");
    expect(
      await screen.findByRole("group", { name: "Dictionary entry: jon to John" }),
    ).toBeInTheDocument();
    await openConfigTab("Corrections");

    fireEvent.click(
      screen.getByRole("button", { name: "Undo correction: jon → John" }),
    );
    await waitFor(() =>
      expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledWith(
        "undo-after-cleanup-error",
      ),
    );
  });

  it("correction approval undo approves each distinct group once", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
      correctionSuggestionFixture(
        "suggestion-2",
        "jon",
        "John",
        "Please invite jon to the review.",
      ),
      correctionSuggestionFixture("suggestion-3", "sara", "Sarah"),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion)
      .mockResolvedValueOnce({
        learned: true,
        action: "created",
        undoToken: "undo-jon",
        spokenForm: "jon",
        replacement: "John",
        entry: dictionaryEntryFixture(),
      })
      .mockResolvedValueOnce({
        learned: true,
        action: "created",
        undoToken: "undo-sara",
        spokenForm: "sara",
        replacement: "Sarah",
        entry: dictionaryEntryFixture({
          id: "learned-2",
          spokenForm: "sara",
          replacement: "Sarah",
        }),
      });

    render(<DictationView />);
    await openConfigTab("Corrections");
    // The inbox-wide action has its own name, distinct from a row's
    // "Approve all" for its similar edits.
    fireEvent.click(screen.getByRole("button", { name: "Approve whole inbox" }));

    await screen.findByRole("button", { name: "Undo correction: jon → John" });
    await screen.findByRole("button", { name: "Undo correction: sara → Sarah" });
    const approved = vi.mocked(
      backend.approveDictationCorrectionSuggestion,
    ).mock.calls.map(([id, snapshot]) => ({ id, snapshot }));
    const approvedIds = approved.map(({ id }) => id);
    expect(approvedIds).toHaveLength(2);
    expect(approvedIds).toEqual(expect.arrayContaining(["suggestion-1", "suggestion-3"]));
    expect(approved.every(({ snapshot }) => snapshot.kind === "missing")).toBe(true);
    expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledTimes(1);
    expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith(
      "suggestion-2",
    );
  });

  it("keeps a later same-entry suggestion pending when the earlier approval makes its snapshot stale", async () => {
    const backend = await import("@/lib/backend/dictation");
    const firstEntry = dictionaryEntryFixture({
      id: "shared-entry",
      spokenForm: "jon",
      replacement: "John",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-10-12T10:01:00.000Z",
    });
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      correctionSuggestionFixture("suggestion-1", "jon", "John"),
      correctionSuggestionFixture(
        "suggestion-2",
        "jon",
        "Jonny",
        "Please invite jon to the review.",
      ),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion)
      .mockResolvedValueOnce({
        learned: true,
        action: "created",
        undoToken: "undo-john",
        spokenForm: "jon",
        replacement: "John",
        entry: firstEntry,
      });
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockRejectedValueOnce(
      new Error("Your dictionary changed after this suggestion was shown. Refresh the suggestions and review it again. Your dictionary is unchanged."),
    );

    render(<DictationView />);
    await openConfigTab("Corrections");
    fireEvent.click(screen.getByRole("button", { name: "Approve whole inbox" }));

    expect(await screen.findByText("Learned: jon → John")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your dictionary changed after this suggestion was shown. Refresh the suggestions and review it again. Your dictionary is unchanged.",
    );
    expect(
      screen.getByRole("button", { name: "Undo correction: jon → John" }),
    ).toBeInTheDocument();
    expect(screen.getByText("jon → Jonny")).toBeInTheDocument();
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenNthCalledWith(
      1,
      "suggestion-1",
      { kind: "missing" },
    );
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenNthCalledWith(
      2,
      "suggestion-2",
      { kind: "missing" },
    );

    await openConfigTab("Dictionary");
    expect(
      await screen.findByRole("group", { name: "Dictionary entry: jon to John" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Dictionary entry: jon to Jonny" }),
    ).not.toBeInTheDocument();
  });

  // ── ux-8: corrections made where the text actually landed ────────────────
  //
  // "Learns automatically from your corrections" only ever fired when the user
  // retyped inside Plainsong's own result box. These cover the other half: what
  // the sidecar reads back out of Slack/Gmail/an editor shows up in its own
  // section, says which app it came from, and is never applied without a click.

  /** One suggestion the sidecar read back out of another app's field. */
  function externalSuggestion(overrides: Partial<DictationCorrectionSuggestion> = {}): DictationCorrectionSuggestion {
    return {
      id: "external-1",
      originalText: "cuban netties",
      correctedText: "kubernetes",
      spokenForm: "cuban netties",
      replacement: "kubernetes",
      appTarget: "Slack",
      source: "external_app_readback",
      approvalDictionary: { kind: "missing" },
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
      await section.findByText(/cuban netties → kubernetes/i),
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
        approvalDictionary: { kind: "missing" },
        createdAt: new Date("2026-03-14T09:00:00Z").toISOString(),
        updatedAt: new Date("2026-03-14T09:00:00Z").toISOString(),
      },
    ]);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    expect(
      await section.findByText(/cuban netties → kubernetes/i),
    ).toBeInTheDocument();
    expect(section.queryByText(/jon → John/i)).not.toBeInTheDocument();
    // The in-app edit is still in the inbox above, unchanged.
    expect(screen.getByText(/jon → John/i)).toBeInTheDocument();
  });

  it("adds a correction read back from another app to the dictionary only when approved and keeps keyboard focus", async () => {
    const backend = await import("@/lib/backend/dictation");
    const user = userEvent.setup();
    const approval = deferred<Awaited<ReturnType<typeof backend.approveDictationCorrectionSuggestion>>>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion(),
      externalSuggestion({ id: "in-app-same-words", source: null }),
    ]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockReturnValueOnce(approval.promise);

    render(<DictationView />);
    await openConfigTab("Corrections");

    const section = externalSuggestionsSection();
    await section.findByText(/cuban netties → kubernetes/i);
    expect(screen.getAllByText(/cuban netties → kubernetes/i)).toHaveLength(2);
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();

    const approve = section.getByRole("button", { name: "Approve" });
    approve.focus();
    await user.keyboard(" ");
    expect(approve).toHaveFocus();
    await user.keyboard(" ");
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledExactlyOnceWith(
      "external-1",
      { kind: "missing" },
    );

    await act(async () => {
      approval.resolve({
        learned: true,
        action: "created",
        undoToken: "undo-external-focus",
        spokenForm: "cuban netties",
        replacement: "kubernetes",
        entry: dictionaryEntryFixture({ spokenForm: "cuban netties", replacement: "kubernetes" }),
      });
    });

    expect(await screen.findByRole("button", { name: "Undo correction: cuban netties → kubernetes" })).toHaveFocus();
    expect(externalSuggestionsSection().queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("does not move focus back when external correction approval finishes after the user leaves", async () => {
    const backend = await import("@/lib/backend/dictation");
    const user = userEvent.setup();
    const approval = deferred<Awaited<ReturnType<typeof backend.approveDictationCorrectionSuggestion>>>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([externalSuggestion()]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockReturnValueOnce(approval.promise);

    render(<DictationView />);
    await openConfigTab("Corrections");
    const approve = await externalSuggestionsSection().findByRole("button", { name: "Approve" });
    approve.focus();
    await user.keyboard(" ");
    const learningToggle = screen.getByRole("checkbox", { name: "Suggest corrections from edits" });
    learningToggle.focus();
    expect(learningToggle).toHaveFocus();

    await act(async () => {
      approval.resolve({
        learned: true,
        action: "created",
        undoToken: "undo-external-left",
        spokenForm: "cuban netties",
        replacement: "kubernetes",
        entry: dictionaryEntryFixture({ spokenForm: "cuban netties", replacement: "kubernetes" }),
      });
    });

    expect(await screen.findByRole("button", { name: "Undo correction: cuban netties → kubernetes" })).toBeInTheDocument();
    expect(learningToggle).toHaveFocus();
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledExactlyOnceWith(
      "external-1",
      { kind: "missing" },
    );
  });

  it("requires a fresh approval snapshot before learning a suggestion", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationCorrectionSuggestions)
      .mockResolvedValueOnce([externalSuggestion({ approvalDictionary: null })])
      .mockResolvedValueOnce([
        externalSuggestion({ approvalDictionary: { kind: "missing" } }),
      ]);

    render(<DictationView />);
    await openConfigTab("Corrections");
    const section = externalSuggestionsSection();
    await section.findByText(/cuban netties → kubernetes/i);
    fireEvent.click(section.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh corrections before approving this suggestion.",
    );
    expect(screen.getByRole("button", { name: "Refresh corrections" })).toBeEnabled();
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();
    expect(section.getByText(/cuban netties → kubernetes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh corrections" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    fireEvent.click(
      externalSuggestionsSection().getByRole("button", { name: "Approve" }),
    );
    await waitFor(() => {
      expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith(
        "external-1",
        { kind: "missing" },
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
    await section.findByText(/cuban netties → kubernetes/i);
    const stale = deferred<Awaited<ReturnType<typeof backend.listDictationCorrectionSuggestions>>>();
    vi.mocked(backend.listDictationCorrectionSuggestions).mockReturnValueOnce(stale.promise);
    await act(async () => {
      backendMocks.eventListeners.get("dictation-correction-suggestions-changed")?.({ payload: {} });
    });
    fireEvent.click(section.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith(
        "external-1",
      );
    });
    await waitFor(() => {
      expect(
        externalSuggestionsSection().queryByText(
          /cuban netties → kubernetes/i,
        ),
      ).not.toBeInTheDocument();
    });
    await act(async () => {
      stale.resolve([externalSuggestion()]);
      await stale.promise;
    });
    expect(externalSuggestionsSection().queryByText(/cuban netties → kubernetes/i)).not.toBeInTheDocument();
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

  it("explains what the other-app correction setting reads and when", async () => {
    render(<DictationView />);
    await openConfigTab("Corrections");

    const copy = await screen.findByText(
      /Plainsong checks only the field it just typed into for up to 8 seconds/i,
    );
    expect(copy).toHaveTextContent(/Some apps support only a single check at 4 seconds/i);
    expect(copy).toHaveTextContent(/on this machine; nothing is sent anywhere/i);
    expect(copy).toHaveTextContent(/Only word changes are saved for review, never the surrounding sentence/i);
    expect(copy).toHaveTextContent(/Switching apps or fields stops capture/i);
  });

  it("does not claim candidates go unwritten until they are approved", async () => {
    // They are written to the suggestions table the moment a readback
    // completes — that is what the inbox reads from. The copy has to describe
    // what is stored, where, and when it goes away, not imply nothing is.
    render(<DictationView />);
    await openConfigTab("Corrections");

    const copy = await screen.findByText(
      /Word changes Plainsong saw you make where it inserted/i,
    );
    expect(copy).toHaveTextContent(/Approving one adds it to the dictionary/i);
    expect(copy).toHaveTextContent(/dismissing drops it/i);
    expect(copy).toHaveTextContent(/left unreviewed for a week expires on its own/i);
    expect(copy).not.toHaveTextContent(/surrounding sentence/i);
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
      expect(backendMocks.setDictationExternalCorrectionLearning).toHaveBeenCalledWith(true);
    });
  });

  it("sends rapid correction consent choices without a whole-settings write", async () => {
    render(<DictationView />);
    await openConfigTab("Corrections");
    const toggle = await screen.findByRole("checkbox", {
      name: /Learn from corrections you make in other apps/i,
    });
    const setConsent = backendMocks.setDictationExternalCorrectionLearning.getMockImplementation();
    const writes: boolean[] = [];
    backendMocks.setDictationExternalCorrectionLearning.mockImplementation(async (enabled) => {
      writes.push(enabled);
      return enabled;
    });
    try {
      fireEvent.click(toggle);
      await act(async () => {});
      fireEvent.click(toggle);
      await act(async () => {});
      await waitFor(() => expect(writes).toEqual([true, false]));
      expect(backendMocks.saveSettings).not.toHaveBeenCalled();
      expect(toggle).not.toBeChecked();
    } finally {
      backendMocks.setDictationExternalCorrectionLearning.mockImplementation(setConsent!);
    }
  });

  it("keeps newer correction consent broadcasts after a delayed initial read", async () => {
    const read = backendMocks.getSettings.getMockImplementation();
    const settings = backendMocks.buildSettings();
    const pendingRead = deferred<typeof settings>();
    backendMocks.getSettings.mockImplementation(() => pendingRead.promise);
    try {
      render(<DictationView />);
      await openConfigTab("Corrections");
      const toggle = await screen.findByRole("checkbox", {
        name: /Learn from corrections you make in other apps/i,
      });
      await waitFor(() => expect(backendMocks.eventListeners.has("settings-changed")).toBe(true));
      await act(async () => {
        backendMocks.eventListeners.get("settings-changed")?.({ payload: {
          ...settings,
          transcription: { ...settings.transcription, dictationLearnFromExternalCorrections: true },
        } });
      });
      expect(toggle).toBeChecked();
      await act(async () => pendingRead.resolve(settings));
      expect(toggle).toBeChecked();
      expect(screen.queryByText(/Plainsong is not reading any other app's text/i)).not.toBeInTheDocument();
    } finally {
      backendMocks.getSettings.mockReset().mockImplementation(read!);
    }
  });

  it.each([true, false])("reports a failed correction opt-out with readback available: %s", async (readbackAvailable) => {
    backendMocks.transcriptionOverrides.dictationLearnFromExternalCorrections = true;
    const setConsent = backendMocks.setDictationExternalCorrectionLearning.getMockImplementation();
    const read = backendMocks.getSettings.getMockImplementation();
    backendMocks.setDictationExternalCorrectionLearning.mockRejectedValueOnce(new Error("Disk unavailable"));
    render(<DictationView />);
    await openConfigTab("Corrections");
    const toggle = await screen.findByRole("checkbox", {
      name: /Learn from corrections you make in other apps/i,
    });
    await waitFor(() => expect(toggle).toBeChecked());
    if (!readbackAvailable) backendMocks.getSettings.mockRejectedValueOnce(new Error("Disconnected"));
    try {
      fireEvent.click(toggle);
      await waitFor(() => expect(toast).toHaveBeenCalledWith(
        "Couldn't save correction learning. Check the switch and try again.", "error",
      ));
      if (readbackAvailable) {
        expect(toggle).toBeChecked();
      } else {
        expect(screen.getByRole("status")).toHaveTextContent(
          "Couldn't confirm whether correction learning is on. Try the checkbox again.",
        );
        expect(screen.queryByText(/Plainsong is not reading any other app's text/i)).not.toBeInTheDocument();
      }
    } finally {
      backendMocks.getSettings.mockImplementation(read!);
      backendMocks.setDictationExternalCorrectionLearning.mockReset().mockImplementation(setConsent!);
    }
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
      expect(backendMocks.setDictationExternalCorrectionLearning).toHaveBeenCalledWith(true);
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

  it("offers queued external corrections with a pending badge, explicit approval, Undo and Dismiss", async () => {
    const backend = await import("@/lib/backend/dictation");
    const approval = deferred<Awaited<ReturnType<typeof backend.approveDictationCorrectionSuggestion>>>();
    const jon = externalSuggestion({ id: "external-jon", spokenForm: "Jon", replacement: "John",
      originalText: "Jon", correctedText: "John" });
    const sara = externalSuggestion({ id: "external-sara", spokenForm: "Sara", replacement: "Sarah",
      originalText: "Sara", correctedText: "Sarah" });
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([jon, sara]);
    vi.mocked(backend.approveDictationCorrectionSuggestion).mockReturnValueOnce(approval.promise);
    vi.mocked(backend.undoDictationCorrectionApproval).mockResolvedValueOnce({ entryId: "learned-1", entry: null });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-correction-suggestions-changed")?.({ payload: { queued: 2 } });
    });
    const learnNotice = (await screen.findByText(/You changed “Jon” to “John”/)).closest('[role="status"]') as HTMLElement;
    expect(learnNotice).toHaveTextContent("You changed “Jon” to “John” in Slack. Learn this for every app?");
    expect(screen.getByRole("tab", { name: "Corrections" })).toHaveAccessibleDescription("2 pending corrections");
    expect(backend.learnDictationCorrection).not.toHaveBeenCalled();
    expect(backend.approveDictationCorrectionSuggestion).not.toHaveBeenCalled();
    // Two waiting, so the notice offers the whole list as well as this one.
    expect(within(learnNotice).getByRole("button", { name: "Review all (2)" })).toBeInTheDocument();
    const approve = within(learnNotice).getByRole("button", { name: "Learn it" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledTimes(1);
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledWith(jon.id, jon.approvalDictionary);
    await act(async () => {
      approval.resolve({ learned: true, action: "created", spokenForm: "Jon", replacement: "John",
        entry: dictionaryEntryFixture({ spokenForm: "Jon" }), undoToken: "external-undo" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo correction: Jon → John" }));
    await waitFor(() => expect(backend.undoDictationCorrectionApproval).toHaveBeenCalledWith("external-undo"));
    expect(screen.getByRole("tab", { name: "Corrections" })).toHaveAccessibleDescription("1 pending correction");
    const saraNotice = screen.getByText(/You changed “Sara” to “Sarah”/).closest('[role="status"]') as HTMLElement;
    expect(within(saraNotice).queryByRole("button", { name: /Review all/ })).not.toBeInTheDocument();
    fireEvent.click(within(saraNotice).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(backend.rejectDictationCorrectionSuggestion).toHaveBeenCalledWith(sara.id));
    await waitFor(() => expect(screen.queryByText(/You changed “Sara” to “Sarah”/)).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Corrections" })).not.toHaveAccessibleDescription();
    expect(backend.learnDictationCorrection).not.toHaveBeenCalled();
    expect(backend.approveDictationCorrectionSuggestion).toHaveBeenCalledTimes(1);
  });

  it("opens the Corrections tab from the learn notice's Review all", async () => {
    const backend = await import("@/lib/backend/dictation");
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    vi.mocked(backend.listDictationCorrectionSuggestions).mockResolvedValueOnce([
      externalSuggestion({ id: "external-jon", spokenForm: "Jon", replacement: "John", originalText: "Jon", correctedText: "John" }),
      externalSuggestion({ id: "external-sara", spokenForm: "Sara", replacement: "Sarah", originalText: "Sara", correctedText: "Sarah" }),
    ]);
    await act(async () => {
      backendMocks.eventListeners.get("dictation-correction-suggestions-changed")?.({ payload: { queued: 2 } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review all (2)" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Corrections" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.queryByText(/You changed “Jon” to “John”/)).not.toBeInTheDocument();
    expect(await screen.findByText("Suggested from other apps")).toBeInTheDocument();
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
        /cuban netties → kubernetes/i,
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

    // The settings and model probes resolve on a loaded machine's schedule.
    expect(
      await screen.findByText("Dictation has no model yet", {}, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Moonshine Base \(English\) is not on this Mac/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download moonshine base/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Change speech model" }),
    ).toBeEnabled();

    // And the shortcut press says so out loud rather than only in the console.
    fireEvent.keyDown(window, {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("Dictation can't start yet"),
      "error",
    ));
  });

  it("answers a shortcut pressed the moment the missing-model banner appears", async () => {
    // The banner commits before React runs the passive effects of that
    // render. A press in between must still see the missing model.
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";

    const pressed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.body.textContent?.includes("Dictation has no model yet")) return;
        observer.disconnect();
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ",
          code: "Space",
          ctrlKey: true,
          shiftKey: true,
        }));
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    render(<DictationView />);
    await pressed;

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
      await screen.findByRole("button", { name: /download moonshine base/i }),
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

  it("refreshes a missing route when an external model download finishes", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";

    render(<DictationView />);

    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    await waitFor(() => {
      expect(backendMocks.eventListeners.has("asr-download-progress")).toBe(true);
    });

    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    await act(async () => {
      backendMocks.eventListeners.get("asr-download-progress")?.({
        payload: ["moonshine", 100],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /start dictation/i }),
      ).toBeEnabled();
    });
  });

  it("refreshes route readiness when another settings surface changes providers", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";

    render(<DictationView />);

    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    await waitFor(() => {
      expect(backendMocks.eventListeners.has("settings-changed")).toBe(true);
    });

    backendMocks.transcriptionOverrides.defaultProvider = "openai_cloud";
    backendMocks.transcriptionOverrides.selectedModelId = "gpt-4o-transcribe";
    const changed = backendMocks.buildSettings();
    Object.assign(changed.transcription, backendMocks.transcriptionOverrides);
    await act(async () => {
      backendMocks.eventListeners.get("settings-changed")?.({ payload: changed });
    });

    await waitFor(() => {
      expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();
    });
  });

  it("keeps the newest route refresh when an older probe finishes last", async () => {
    backendMocks.transcriptionOverrides.defaultProvider = "moonshine";
    backendMocks.transcriptionOverrides.selectedModelId = "moonshine-base";
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.asrProviders[0].downloadStatus = "NotDownloaded";
    backendMocks.asrProviders[0].runtimeStatus = "missing_model";

    render(<DictationView />);
    expect(await screen.findByText("Dictation has no model yet")).toBeInTheDocument();
    await waitFor(() => {
      expect(backendMocks.eventListeners.has("readiness-invalidated")).toBe(true);
    });
    backendMocks.getSettings.mockClear();
    backendMocks.getAsrProviders.mockClear();

    const firstSettings = deferred<any>();
    const firstProviders = deferred<any[]>();
    const secondSettings = deferred<any>();
    const secondProviders = deferred<any[]>();
    backendMocks.getSettings
      .mockImplementationOnce(() => firstSettings.promise)
      .mockImplementationOnce(() => secondSettings.promise);
    backendMocks.getAsrProviders
      .mockImplementationOnce(() => firstProviders.promise)
      .mockImplementationOnce(() => secondProviders.promise);

    await act(async () => {
      backendMocks.eventListeners.get("readiness-invalidated")?.({ payload: null });
    });
    await waitFor(() => expect(backendMocks.getAsrProviders).toHaveBeenCalledTimes(1));
    await act(async () => {
      backendMocks.eventListeners.get("readiness-invalidated")?.({ payload: null });
    });
    await waitFor(() => expect(backendMocks.getAsrProviders).toHaveBeenCalledTimes(2));

    const settings = backendMocks.buildSettings();
    Object.assign(settings.transcription, backendMocks.transcriptionOverrides);
    await act(async () => {
      secondSettings.resolve(settings);
      secondProviders.resolve(backendMocks.buildAsrProviders());
    });
    await waitFor(() => {
      expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();
    });

    const staleProviders = backendMocks.buildAsrProviders();
    staleProviders[0].downloadStatus = "NotDownloaded";
    staleProviders[0].runtimeStatus = "missing_model";
    await act(async () => {
      firstSettings.resolve(settings);
      firstProviders.resolve(staleProviders);
    });
    expect(screen.queryByText("Dictation has no model yet")).not.toBeInTheDocument();
  });

  it("ignores incomplete and non-finite download progress", async () => {
    render(<DictationView />);
    await waitFor(() => {
      expect(backendMocks.eventListeners.has("asr-download-progress")).toBe(true);
    });
    await waitFor(() => expect(backendMocks.getAsrProviders).toHaveBeenCalled());
    backendMocks.getSettings.mockClear();
    backendMocks.getAsrProviders.mockClear();

    await act(async () => {
      for (const progress of [0, 99.9, Number.NaN, Number.POSITIVE_INFINITY]) {
        backendMocks.eventListeners.get("asr-download-progress")?.({
          payload: ["moonshine", progress],
        });
      }
    });

    expect(backendMocks.getAsrProviders).not.toHaveBeenCalled();
    expect(backendMocks.getSettings).not.toHaveBeenCalled();
  });

  it("ignores a route probe that finishes after unmount", async () => {
    const view = render(<DictationView />);
    await waitFor(() => {
      expect(backendMocks.eventListeners.has("readiness-invalidated")).toBe(true);
    });
    await waitFor(() => expect(backendMocks.getAsrProviders).toHaveBeenCalled());
    backendMocks.getSettings.mockClear();
    backendMocks.getAsrProviders.mockClear();

    const lateSettings = deferred<any>();
    const lateProviders = deferred<any[]>();
    backendMocks.getSettings.mockImplementationOnce(() => lateSettings.promise);
    backendMocks.getAsrProviders.mockImplementationOnce(() => lateProviders.promise);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () => {
      backendMocks.eventListeners.get("readiness-invalidated")?.({ payload: null });
    });
    await waitFor(() => expect(backendMocks.getAsrProviders).toHaveBeenCalled());
    view.unmount();

    const settings = backendMocks.buildSettings();
    const unreadableAfterUnmount = new Proxy(settings, {
      get(target, property, receiver) {
        if (property === "transcription") {
          throw new Error("late route response was read after unmount");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await act(async () => {
      lateSettings.resolve(unreadableAfterUnmount);
      lateProviders.resolve(backendMocks.buildAsrProviders());
      await Promise.resolve();
    });

    expect(warn).not.toHaveBeenCalledWith(
      "Failed to check the dictation route readiness:",
      expect.objectContaining({
        message: "late route response was read after unmount",
      }),
    );
    warn.mockRestore();
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
    fireEvent.change(screen.getByPlaceholderText("Heard as (e.g. open ai)"), {
      target: { value: "open ai" },
    });
    fireEvent.change(screen.getByPlaceholderText("Replace with (e.g. OpenAI)"), {
      target: { value: "OpenAI" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("Only in app (optional)")[0], {
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

  it("gives each dictionary row and control an accessible name", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.listDictationDictionaryEntries).mockResolvedValueOnce([
      {
        id: "dict-accessibility",
        spokenForm: "jon",
        replacement: "John",
        appScope: null,
        caseSensitive: false,
        enabled: true,
        categoryScope: null,
        createdAt: "2026-03-14T10:00:00.000Z",
        updatedAt: "2026-03-14T10:00:00.000Z",
      },
    ]);
    render(<DictationView />);

    await openConfigTab("Dictionary");

    const row = await screen.findByRole("group", {
      name: "Dictionary entry: jon to John",
    });
    expect(within(row).getByRole("textbox", { name: "Heard as" })).toHaveValue("jon");
    expect(within(row).getByRole("textbox", { name: "Replace with" })).toHaveValue("John");
    expect(within(row).getByRole("textbox", { name: "Only in app" })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Destination category" })).toBeInTheDocument();
  });

  describe("dictionary add ownership", () => {
    const createdEntry = (id: string, spokenForm: string, replacement: string) => ({
      id, spokenForm, replacement, appScope: null, caseSensitive: false,
      enabled: true, categoryScope: null,
      createdAt: "2026-03-14T10:00:00.000Z",
      updatedAt: "2026-03-14T10:00:00.000Z",
    });

    it("submits one exact immutable payload for duplicate Add clicks", async () => {
      const create = deferred<any>();
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry).mockReturnValueOnce(create.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      fireEvent.change(screen.getByPlaceholderText("Heard as (e.g. open ai)"), { target: { value: "  standup  " } });
      fireEvent.change(screen.getByPlaceholderText("Replace with (e.g. OpenAI)"), { target: { value: "  stand-up  " } });
      fireEvent.change(screen.getAllByPlaceholderText("Only in app (optional)")[0], { target: { value: "  Slack  " } });
      fireEvent.click(screen.getByLabelText("Case-sensitive match"));
      const section = screen.getByTestId("dictionary-section");
      fireEvent.click(within(section).getByRole("combobox", { name: "New dictionary entry destination category" }));
      fireEvent.click(await screen.findByRole("option", { name: "Project tools" }));

      const add = within(section).getByRole("button", { name: "Add" });
      fireEvent.click(add);
      fireEvent.click(add);
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenCalledTimes(1);
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenCalledWith({
        spokenForm: "standup", replacement: "stand-up", appScope: "Slack",
        caseSensitive: true, enabled: true, categoryScope: "worklog",
      });
      expect(add).toBeDisabled();

      await act(async () => {
        create.resolve({ ...createdEntry("dict-exact", "standup", "stand-up"), appScope: "Slack", caseSensitive: true, categoryScope: "worklog" });
        await create.promise;
      });
      expect(await screen.findByText(/Saved “standup”/)).toBeInTheDocument();
    });

    it("does not clear an A-B-A draft after an older success", async () => {
      const create = deferred<any>();
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry).mockReturnValueOnce(create.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = screen.getByPlaceholderText("Heard as (e.g. open ai)");
      const replacement = screen.getByPlaceholderText("Replace with (e.g. OpenAI)");
      fireEvent.change(spoken, { target: { value: "open ai" } });
      fireEvent.change(replacement, { target: { value: "OpenAI" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.change(spoken, { target: { value: "open ay" } });
      fireEvent.change(spoken, { target: { value: "open ai" } });

      await act(async () => {
        create.resolve(createdEntry("dict-aba", "open ai", "OpenAI"));
        await create.promise;
      });
      expect(spoken).toHaveValue("open ai");
      expect(replacement).toHaveValue("OpenAI");
      expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
    });

    it("keeps the current failed draft and retries it exactly once", async () => {
      const first = deferred<any>();
      const retry = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = screen.getByPlaceholderText("Heard as (e.g. open ai)");
      const replacement = screen.getByPlaceholderText("Replace with (e.g. OpenAI)");
      fireEvent.change(spoken, { target: { value: "open ai" } });
      fireEvent.change(replacement, { target: { value: "OpenAI" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { first.reject(new Error("database unavailable")); await first.promise.catch(() => undefined); });

      expect(spoken).toHaveValue("open ai");
      expect(replacement).toHaveValue("OpenAI");
      const retryButton = screen.getByRole("button", { name: "Retry add" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenCalledTimes(2);
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenNthCalledWith(2, {
        spokenForm: "open ai", replacement: "OpenAI", appScope: null,
        caseSensitive: false, enabled: true,
      });

      await act(async () => { retry.resolve(createdEntry("dict-retry", "open ai", "OpenAI")); await retry.promise; });
      expect(spoken).toHaveValue("");
      expect(replacement).toHaveValue("");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      consoleWarn.mockRestore();
    });

    it("retries an older failed entry without clearing the newer draft", async () => {
      const first = deferred<any>();
      const retry = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = screen.getByPlaceholderText("Heard as (e.g. open ai)");
      const replacement = screen.getByPlaceholderText("Replace with (e.g. OpenAI)");
      fireEvent.change(spoken, { target: { value: "old phrase" } });
      fireEvent.change(replacement, { target: { value: "Old Phrase" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { first.reject(new Error("database unavailable")); await first.promise.catch(() => undefined); });

      fireEvent.change(spoken, { target: { value: "new phrase" } });
      fireEvent.change(replacement, { target: { value: "New Phrase" } });
      fireEvent.click(screen.getByRole("button", { name: "Retry previous entry" }));
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenNthCalledWith(2, {
        spokenForm: "old phrase", replacement: "Old Phrase", appScope: null,
        caseSensitive: false, enabled: true,
      });
      await act(async () => { retry.resolve(createdEntry("dict-old-retry", "old phrase", "Old Phrase")); await retry.promise; });
      expect(spoken).toHaveValue("new phrase");
      expect(replacement).toHaveValue("New Phrase");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      consoleWarn.mockRestore();
    });

    it("keeps failure A through failure and recovery of B, then retries A without clearing C", async () => {
      const failA = deferred<any>();
      const failB = deferred<any>();
      const retryB = deferred<any>();
      const retryA = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry)
        .mockReturnValueOnce(failA.promise)
        .mockReturnValueOnce(failB.promise)
        .mockReturnValueOnce(retryB.promise)
        .mockReturnValueOnce(retryA.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = screen.getByPlaceholderText("Heard as (e.g. open ai)");
      const replacement = screen.getByPlaceholderText("Replace with (e.g. OpenAI)");

      fireEvent.change(spoken, { target: { value: "alpha name" } });
      fireEvent.change(replacement, { target: { value: "Alpha Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { failA.reject(new Error("A failed")); await failA.promise.catch(() => undefined); });

      fireEvent.change(spoken, { target: { value: "beta name" } });
      fireEvent.change(replacement, { target: { value: "Beta Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { failB.reject(new Error("B failed")); await failB.promise.catch(() => undefined); });
      expect(screen.getAllByRole("alert")).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "Retry add: beta name → Beta Name" }));
      await act(async () => { retryB.resolve(createdEntry("dict-beta", "beta name", "Beta Name")); await retryB.promise; });
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByText(/Save wasn't confirmed for “alpha name”/)).toBeInTheDocument();

      fireEvent.change(spoken, { target: { value: "charlie name" } });
      fireEvent.change(replacement, { target: { value: "Charlie Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Retry previous entry" }));
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenNthCalledWith(4, {
        spokenForm: "alpha name", replacement: "Alpha Name", appScope: null,
        caseSensitive: false, enabled: true,
      });
      await act(async () => { retryA.resolve(createdEntry("dict-alpha", "alpha name", "Alpha Name")); await retryA.promise; });

      expect(spoken).toHaveValue("charlie name");
      expect(replacement).toHaveValue("Charlie Name");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      consoleWarn.mockRestore();
    });

    it("recovers a lost acknowledgement idempotently without dropping another failure or draft", async () => {
      const lostAck = deferred<any>();
      const failB = deferred<any>();
      const retryA = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.createDictationDictionaryEntry)
        .mockReturnValueOnce(lostAck.promise)
        .mockReturnValueOnce(failB.promise)
        .mockReturnValueOnce(retryA.promise);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = screen.getByPlaceholderText("Heard as (e.g. open ai)");
      const replacement = screen.getByPlaceholderText("Replace with (e.g. OpenAI)");

      fireEvent.change(spoken, { target: { value: "alpha name" } });
      fireEvent.change(replacement, { target: { value: "Alpha Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { lostAck.reject(new Error("response lost after commit")); await lostAck.promise.catch(() => undefined); });

      fireEvent.change(spoken, { target: { value: "beta name" } });
      fireEvent.change(replacement, { target: { value: "Beta Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await act(async () => { failB.reject(new Error("B failed")); await failB.promise.catch(() => undefined); });

      fireEvent.change(spoken, { target: { value: "charlie name" } });
      fireEvent.change(replacement, { target: { value: "Charlie Name" } });
      fireEvent.click(screen.getByRole("button", { name: "Retry previous entry: alpha name → Alpha Name" }));
      expect(dictationBackend.createDictationDictionaryEntry).toHaveBeenNthCalledWith(3, {
        spokenForm: "alpha name", replacement: "Alpha Name", appScope: null,
        caseSensitive: false, enabled: true,
      });

      await act(async () => {
        retryA.resolve(createdEntry("dict-alpha-existing", "alpha name", "Alpha Name"));
        await retryA.promise;
      });
      expect(screen.getAllByDisplayValue("Alpha Name")).toHaveLength(1);
      expect(spoken).toHaveValue("charlie name");
      expect(replacement).toHaveValue("Charlie Name");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByText(/Save wasn't confirmed for “beta name”/)).toBeInTheDocument();
      expect(await screen.findByText(/Saved “alpha name”/)).toBeInTheDocument();
      consoleWarn.mockRestore();
    });
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

  it("preserves newer snippet drafts and orders row saves", async () => {
    const backend = await import("@/lib/backend/dictation");
    const row = { id: "snippet-edit", trigger: "brb", expansion: "be right back", appScope: null,
      caseSensitive: false, enabled: true, categoryScope: null,
      createdAt: "2026-03-14T10:00:00Z", updatedAt: "2026-03-14T10:00:00Z" };
    vi.mocked(backend.listDictationSnippets).mockResolvedValueOnce([row]);
    const first = deferred<typeof row>();
    const second = deferred<typeof row>();
    vi.mocked(backend.updateDictationSnippet).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<DictationView />);
    await openConfigTab("Snippets");
    const trigger = await screen.findByDisplayValue("brb");
    const expansion = screen.getByDisplayValue("be right back");
    fireEvent.change(trigger, { target: { value: "first" } });
    fireEvent.blur(trigger);
    fireEvent.change(trigger, { target: { value: "newer trigger" } });
    fireEvent.change(expansion, { target: { value: "newer expansion" } });
    fireEvent.blur(expansion);
    expect(backend.updateDictationSnippet).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ ...row, trigger: "first" }));
    expect(trigger).toHaveValue("newer trigger");
    expect(expansion).toHaveValue("newer expansion");
    await waitFor(() => expect(backend.updateDictationSnippet).toHaveBeenCalledTimes(2));
    expect(backend.updateDictationSnippet).toHaveBeenLastCalledWith(row.id, { expansion: "newer expansion" });
    await act(async () => second.resolve({ ...row, trigger: "first", expansion: "newer expansion" }));
    expect(trigger).toHaveValue("newer trigger");
  });

  it("keeps snippet drafts after failure and retries the current row", async () => {
    const backend = await import("@/lib/backend/dictation");
    const row = { id: "snippet-retry", trigger: "brb", expansion: "be right back", appScope: null,
      caseSensitive: false, enabled: true, categoryScope: null,
      createdAt: "2026-03-14T10:00:00Z", updatedAt: "2026-03-14T10:00:00Z" };
    vi.mocked(backend.listDictationSnippets).mockResolvedValueOnce([row, { ...row, id: "other", trigger: "other trigger" }]);
    const failed = deferred<typeof row>();
    vi.mocked(backend.updateDictationSnippet).mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce({ ...row, trigger: "latest", expansion: "local expansion" });
    render(<DictationView />);
    await openConfigTab("Snippets");
    const trigger = await screen.findByDisplayValue("brb");
    fireEvent.change(trigger, { target: { value: "submitted" } });
    fireEvent.blur(trigger);
    fireEvent.change(trigger, { target: { value: "latest" } });
    fireEvent.change(screen.getAllByDisplayValue("be right back")[0], { target: { value: "local expansion" } });
    fireEvent.change(screen.getByDisplayValue("other trigger"), { target: { value: "other draft" } });
    const listCalls = vi.mocked(backend.listDictationSnippets).mock.calls.length;
    await act(async () => failed.reject(new Error("save failed")));
    expect(await screen.findByText("Some changes aren't saved yet. Your local draft is still here.")).toBeInTheDocument();
    expect(trigger).toHaveValue("latest");
    expect(screen.getByDisplayValue("other draft")).toBeInTheDocument();
    expect(backend.listDictationSnippets).toHaveBeenCalledTimes(listCalls);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(backend.updateDictationSnippet).toHaveBeenLastCalledWith(row.id, {
      trigger: "latest", expansion: "local expansion", appScope: null, caseSensitive: false, enabled: true, categoryScope: null,
    }));
    await waitFor(() => expect(screen.queryByText("Save wasn't confirmed. Your local changes are still here.")).not.toBeInTheDocument());
    expect(screen.getByDisplayValue("other draft")).toBeInTheDocument();
  });

  it("snippet creation coalesces pending adds and preserves the next draft", async () => {
    const backend = await import("@/lib/backend/dictation");
    const created = { id: "snippet-create", trigger: "first", expansion: "first expansion", appScope: null,
      caseSensitive: false, enabled: true, categoryScope: null,
      createdAt: "2026-03-14T10:00:00Z", updatedAt: "2026-03-14T10:00:00Z" };
    const pending = deferred<typeof created>();
    vi.mocked(backend.createDictationSnippet).mockReturnValueOnce(pending.promise);
    render(<DictationView />);
    await openConfigTab("Snippets");
    const trigger = screen.getByPlaceholderText("Trigger (e.g. brb)");
    const expansion = screen.getByPlaceholderText("Expansion (e.g. be right back)");
    fireEvent.change(trigger, { target: { value: "first" } });
    fireEvent.change(expansion, { target: { value: "first expansion" } });
    const section = within(screen.getByTestId("snippet-section"));
    fireEvent.click(section.getByRole("button", { name: "Add" }));
    fireEvent.click(section.getByRole("button", { name: "Adding…" }));
    expect(backend.createDictationSnippet).toHaveBeenCalledTimes(1);
    expect(section.getByRole("button", { name: "Adding…" })).toBeDisabled();
    fireEvent.change(trigger, { target: { value: "next" } });
    fireEvent.change(expansion, { target: { value: "next expansion" } });
    fireEvent.change(screen.getByPlaceholderText("Only in app (optional)"), { target: { value: "Mail" } });
    fireEvent.click(section.getByRole("checkbox", { name: "Case-sensitive trigger" }));
    await act(async () => pending.resolve(created));
    expect(trigger).toHaveValue("next");
    expect(expansion).toHaveValue("next expansion");
    expect(screen.getByPlaceholderText("Only in app (optional)")).toHaveValue("Mail");
    expect(section.getByRole("checkbox", { name: "Case-sensitive trigger" })).toBeChecked();
    expect(await screen.findByDisplayValue("first expansion")).toBeInTheDocument();
  });

  it("snippet creation keeps failed inputs and retries the current draft", async () => {
    const backend = await import("@/lib/backend/dictation");
    const created = { id: "snippet-retried", trigger: "new trigger", expansion: "new expansion", appScope: null,
      caseSensitive: false, enabled: true, categoryScope: null,
      createdAt: "2026-03-14T10:00:00Z", updatedAt: "2026-03-14T10:00:00Z" };
    vi.mocked(backend.createDictationSnippet).mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(created);
    render(<DictationView />);
    await openConfigTab("Snippets");
    const trigger = screen.getByPlaceholderText("Trigger (e.g. brb)");
    const expansion = screen.getByPlaceholderText("Expansion (e.g. be right back)");
    fireEvent.change(trigger, { target: { value: "first" } });
    fireEvent.change(expansion, { target: { value: "first expansion" } });
    const section = within(screen.getByTestId("snippet-section"));
    fireEvent.click(section.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Add wasn't confirmed. Your local inputs are still here. Try again.")).toBeInTheDocument();
    expect(trigger).toHaveValue("first");
    expect(expansion).toHaveValue("first expansion");
    fireEvent.change(trigger, { target: { value: "new trigger" } });
    fireEvent.change(expansion, { target: { value: "new expansion" } });
    fireEvent.click(section.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(backend.createDictationSnippet).toHaveBeenLastCalledWith({
      trigger: "new trigger", expansion: "new expansion", appScope: null, caseSensitive: false, enabled: true,
    }));
    await waitFor(() => expect(trigger).toHaveValue(""));
    expect(expansion).toHaveValue("");
    expect(screen.queryByText("Add wasn't confirmed. Your local inputs are still here. Try again.")).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("Only in app (optional)"), {
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

  it("defaults Voice to digits and saves an explicit words choice", async () => {
    render(<DictationView />);

    await openConfigTab("Destinations");
    const section = await screen.findByTestId("numbers-as-digits-section");
    expect(
      within(section).getByText("Numbers as digits"),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        "On by default: digits for data, words for small prose numbers.",
      ),
    ).toBeInTheDocument();

    const voiceSwitch = within(section).getByRole("switch", {
      name: "General: numbers as digits",
    });
    expect(voiceSwitch).toHaveAttribute("aria-checked", "true");
    const writingSwitch = within(section).getByRole("switch", {
      name: "Writing: numbers as digits",
    });
    expect(writingSwitch).toHaveAttribute("aria-checked", "true");

    fireEvent.click(voiceSwitch);

    await waitFor(() => {
      expect(backendMocks.saveSettings).toHaveBeenCalled();
    });
    const saveCalls = backendMocks.saveSettings.mock.calls as unknown as Array<
      [any]
    >;
    const latestSettings = saveCalls[saveCalls.length - 1]?.[0];
    expect(latestSettings.transcription.dictationNumbersAsDigits).toMatchObject({
      voice: false,
    });
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

  it("command preset persistence keeps newer drafts and serializes saves", async () => {
    const backend = await import("@/lib/backend/dictation");
    const first = deferred<any>();
    const second = deferred<any>();
    vi.mocked(backend.upsertDictationCommandPreset)
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<DictationView />);
    await openConfigTab("Text actions");
    const row = (await screen.findByText("Rewrite Shorter")).closest(".rounded-md") as HTMLElement;
    const editor = within(row).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "First prompt" } });
    fireEvent.blur(editor);
    fireEvent.change(editor, { target: { value: "Second prompt" } });
    fireEvent.blur(editor);
    fireEvent.change(editor, { target: { value: "Newest unsaved draft" } });
    expect(backend.upsertDictationCommandPreset).toHaveBeenCalledTimes(1);
    expect(within(row).getByText("Saving changes…")).toBeVisible();
    await act(async () => {
      first.resolve({ commandKey: "rewrite_shorter", systemPrompt: "First prompt", enabled: true });
      await first.promise;
    });
    expect(backend.upsertDictationCommandPreset).toHaveBeenCalledTimes(2);
    expect(editor).toHaveValue("Newest unsaved draft");
    await act(async () => {
      second.resolve({ commandKey: "rewrite_shorter", systemPrompt: "Second prompt", enabled: true });
      await second.promise;
    });
    expect(editor).toHaveValue("Newest unsaved draft");
    expect(within(row).getByText("Unsaved changes")).toBeVisible();
  });

  it("command preset persistence retries failed save and reset without losing drafts", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.upsertDictationCommandPreset).mockRejectedValueOnce(new Error("private backend detail"));
    render(<DictationView />);
    await openConfigTab("Text actions");
    const row = (await screen.findByText("Rewrite Shorter")).closest(".rounded-md") as HTMLElement;
    const editor = within(row).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Keep my draft" } });
    fireEvent.blur(editor);
    await within(row).findByRole("button", { name: "Retry save" });
    expect(editor).toHaveValue("Keep my draft");
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "Retry latest draft" } });
    fireEvent.click(within(row).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(backend.upsertDictationCommandPreset).toHaveBeenLastCalledWith({ commandKey: "rewrite_shorter", systemPrompt: "Retry latest draft", enabled: true }));
    await waitFor(() => expect(within(row).queryByText("Saving changes…")).not.toBeInTheDocument());
    vi.mocked(backend.deleteDictationCommandPreset).mockRejectedValueOnce(new Error("reset failed"));
    fireEvent.click(within(row).getByRole("button", { name: "Reset" }));
    await within(row).findByRole("button", { name: "Retry reset" });
    expect(editor).toHaveValue("Retry latest draft");
    fireEvent.click(within(row).getByRole("button", { name: "Retry reset" }));
    await waitFor(() => expect(editor).not.toHaveValue("Retry latest draft"));
  });

  it("command preset persistence preserves typing during a reset", async () => {
    const backend = await import("@/lib/backend/dictation");
    const reset = deferred<void>();
    vi.mocked(backend.deleteDictationCommandPreset).mockReturnValueOnce(reset.promise);
    render(<DictationView />);
    await openConfigTab("Text actions");
    const row = (await screen.findByText("Rewrite Shorter")).closest(".rounded-md") as HTMLElement;
    const editor = within(row).getByRole("textbox");
    fireEvent.click(within(row).getByRole("button", { name: "Reset" }));
    fireEvent.change(editor, { target: { value: "Typed while resetting" } });
    await act(async () => { reset.resolve(); await reset.promise; });
    expect(editor).toHaveValue("Typed while resetting");
    expect(within(row).getByText("Unsaved changes")).toBeVisible();
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

    fireEvent.click(await screen.findByRole("button", { name: "Copy result" }));
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

    // Queueing is not learning. Explicit learning resets the correction
    // baseline, while the stored capture and its staleness warning stay intact.
    const editor = screen.getByDisplayValue("Ship it");
    fireEvent.change(editor, { target: { value: "Ship it tomorrow" } });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalled();
    });
    expect(screen.getByRole("button", { name: "Learn correction" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Learn correction" }),
      ).toBeDisabled();
    });
    expect(
      screen.getByText(/You changed this after capture/),
    ).toBeInTheDocument();

    clipboardWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Ship it tomorrow");
    });
  });

  it("does not show the default hotkey before settings say which one is bound", async () => {
    const loadSettings = backendMocks.getSettings.getMockImplementation();
    backendMocks.getSettings.mockImplementation(() => new Promise(() => {}));
    try {
      render(<DictationView />);
      expect(
        await screen.findByText("Loading your shortcut…"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Shift/)).not.toBeInTheDocument();
    } finally {
      backendMocks.getSettings.mockImplementation(loadSettings!);
    }
  });

  it("keeps tips collapsed for first-time and returning dictation users", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationInsights).mockResolvedValueOnce({
      totalDictations: 0,
      dictatedWords: 0,
      averageWordsPerDictation: 0,
      activeDays: 0,
      lastSevenDaysDictations: 0,
      commandsUsed: 0,
      backtracksUsed: 0,
      snippetsTriggered: 0,
      topAppTarget: null,
      topAppTargetCount: 0,
    });
    const { unmount } = render(<DictationView />);
    // Wait for the insights to land so the check is not just the first paint.
    await screen.findByText("Speaking speed");
    expect(screen.queryByRole("heading", { name: "The main path" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fix the last insert with your voice")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show tips" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { name: "Recent dictations" })).toBeInTheDocument();
    unmount();

    // The default fixture has dictations on record.
    render(<DictationView />);
    await screen.findByRole("heading", { name: "Recent dictations" });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "The main path" }),
      ).not.toBeInTheDocument();
    });
  });

  it("uses the catalog's concise Parakeet label beside capture", async () => {
    backendMocks.transcriptionOverrides = {
      defaultProvider: "parakeet", selectedModelId: "parakeet-tdt-0.6b-v3",
      useSharedAsrSelection: true,
    };
    backendMocks.asrProviders = [{
      providerType: "parakeet", name: "NVIDIA Parakeet",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)" }],
      runtimeStatus: "ready",
    }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    // The only Parakeet v3 this build offers: no "Compatible" to tell it apart.
    expect(await within(hero).findByText("Parakeet v3")).toBeInTheDocument();
    expect(within(hero).queryByText(/25 EU languages|Compatible/)).not.toBeInTheDocument();
  });

  it("calls ONNX Parakeet plain Parakeet v3 beside capture where GGUF Parakeet is also offered", async () => {
    backendMocks.transcriptionOverrides = {
      defaultProvider: "parakeet", selectedModelId: "parakeet-tdt-0.6b-v3",
      useSharedAsrSelection: true,
    };
    backendMocks.asrProviders = [{
      providerType: "parakeet", name: "NVIDIA Parakeet",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3 (25 EU languages, recommended)" }],
      runtimeStatus: "ready",
    }, {
      providerType: "transcribe_cpp", name: "transcribe.cpp", inferenceEnabled: true,
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3-q8_0", label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp" }],
      runtimeStatus: "missing_model",
    }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(await within(hero).findByText("Parakeet v3")).toBeInTheDocument();
    expect(within(hero).queryByText(/Compatible/)).not.toBeInTheDocument();
  });

  it.each([
    { provider: "whistle", preference: "local", override: false, next: "local", visible: true },
    { provider: "whistle", preference: "cloud", override: false, next: "local", visible: false },
    { provider: "whistle", preference: "local", override: true, next: "cloud", visible: false },
    { provider: "parakeet", preference: "local", override: false, next: "local", visible: false },
    { provider: "whistle", preference: "local", override: false, next: "local", visible: false, customCloud: true },
  ] as const)("shows the Whistle audio limit only for a local Whistle capture: $provider/$preference/$next", async (testCase) => {
    const { provider, preference, override, visible } = testCase;
    backendMocks.transcriptionOverrides = {
      useSharedAsrSelection: true, defaultProvider: provider,
      selectedModelId: "test-model", dictationRoutePreference: preference,
      dictationRouteOverrideEnabled: override,
      ...("customCloud" in testCase ? {
        dictationModePreset: "custom", dictationSelectedCustomModeId: "cloud-profile",
        dictationCustomModes: [{ id: "cloud-profile", name: "Cloud profile", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false, routePreference: "cloud", dictationProvider: "whistle", dictationModelId: "test-model" }],
      } : {}),
    };
    backendMocks.asrProviders = [{ providerType: provider, name: provider === "whistle" ? "Whistle" : "Parakeet", modelOptions: [{ id: "test-model", label: "Test model" }], runtimeStatus: "ready" }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    await within(hero).findByText("Test model");
    if (override) {
      await chooseOneOffRoute("The cloud");
    }
    const limit = /Whistle accepts up to 30 seconds of audio/;
    await waitFor(() => expect(Boolean(within(hero).queryByText(limit))).toBe(visible));
  });

  it("shows the active custom profile speech route instead of the shared global model", async () => {
    backendMocks.transcriptionOverrides = {
      useSharedAsrSelection: true,
      dictationModePreset: "custom",
      dictationSelectedCustomModeId: "custom-local-route",
      dictationCustomModes: [{ id: "custom-local-route", name: "Local profile", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false,
        dictationProvider: "qwen3_asr", dictationModelId: "qwen3-asr-0.6b" }],
    };
    backendMocks.asrProviders = [{
      providerType: "qwen3_asr", name: "Qwen3-ASR",
      modelOptions: [{ id: "qwen3-asr-0.6b", label: "Qwen3-ASR 0.6B" }], runtimeStatus: "ready",
    }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(await within(hero).findByText(/Qwen3-ASR 0\.6B/)).toBeInTheDocument();
  });

  it("keeps shared speech selection when a custom profile only overrides its unused dictation model", async () => {
    backendMocks.transcriptionOverrides = {
      useSharedAsrSelection: true,
      dictationModePreset: "custom",
      dictationSelectedCustomModeId: "inherit-route",
      dictationCustomModes: [{ id: "inherit-route", name: "Inherited speech", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false,
        dictationModelId: "qwen3-asr-0.6b" }],
    };
    backendMocks.asrProviders = [{ providerType: "distil_whisper", name: "Distil Whisper",
      modelOptions: [{ id: "distil-large-v3.5", label: "Distil Large v3.5" }], runtimeStatus: "ready" }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(await within(hero).findByText("Distil-Whisper Large (English)")).toBeInTheDocument();
  });

  it("updates the capture profile picker from external settings without saving back", async () => {
    render(<DictationView />);
    const picker = await screen.findByRole("combobox", { name: "Capture profile" });
    await waitFor(() => expect(backendMocks.eventListeners.has("settings-changed")).toBe(true));
    const changed = backendMocks.buildSettings();
    Object.assign(changed.transcription, { dictationModePreset: "custom" });
    Object.assign(changed.transcription, { dictationSelectedCustomModeId: "external-profile" });
    Object.assign(changed.transcription, { dictationCustomModes: [{ id: "external-profile", name: "External local profile", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false }] });
    await act(async () => { backendMocks.eventListeners.get("settings-changed")?.({ payload: changed }); });
    expect(picker).toHaveTextContent("External local profile");
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps an unsaved profile edit across unrelated settings broadcasts", async () => {
    const mode = { id: "draft-profile", name: "Saved profile name", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false };
    backendMocks.transcriptionOverrides = { dictationModePreset: "custom", dictationSelectedCustomModeId: mode.id, dictationCustomModes: [mode] };
    render(<DictationView />);
    await openConfigTab("Profiles");
    const name = await screen.findByLabelText("Profile name");
    await waitFor(() => expect(name).toHaveValue(mode.name));
    fireEvent.change(name, { target: { value: "Unsaved profile edit" } });
    const changed = backendMocks.buildSettings();
    Object.assign(changed.transcription, backendMocks.transcriptionOverrides);
    changed.privacy.remoteProcessingEnabled = true;
    await act(async () => { backendMocks.eventListeners.get("settings-changed")?.({ payload: JSON.parse(JSON.stringify(changed)) }); });
    expect(name).toHaveValue("Unsaved profile edit");
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("shows basic formatting when ordinary native cleanup lacks memory headroom", async () => {
    backendMocks.transcriptionOverrides = { dictationAiFormatting: true };
    backendMocks.privacyOverrides.dictationAi = { provider: "native_text", modelId: null };
    backendMocks.getNativeTextModelStatus.mockResolvedValue({
      modelId: "qwen3-4b-instruct-2507-q4_k_m", runtimePresent: true, ready: true,
      runtimeHealth: { state: "available", message: null },
      memoryAvailableBytes: 4_000_000_000, canLoadNow: false,
    });
    render(<DictationView />);
    const notice = await screen.findByRole("status", { name: "AI cleanup is unavailable" });
    expect(notice).toHaveTextContent("Basic local formatting will be used.");
    expect(notice).toHaveTextContent("Not enough free memory right now.");
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(within(hero).getByText("Basic formatting")).toBeInTheDocument();
    expect(within(hero).queryByText("AI cleanup")).not.toBeInTheDocument();
    backendMocks.getNativeTextModelStatus.mockReturnValue(new Promise(() => {}));
    const changed = backendMocks.buildSettings();
    await act(async () => {
      backendMocks.eventListeners.get("settings-changed")?.({
        payload: {
          ...changed,
          privacy: {
            ...changed.privacy,
            dictationAi: { provider: "native_text", modelId: "another-local-model" },
          },
        },
      });
    });
    expect(screen.queryByRole("status", { name: "AI cleanup is unavailable" })).not.toBeInTheDocument();
    expect(within(hero).getByText("AI cleanup")).toBeInTheDocument();
    expect(backendMocks.startDictation).not.toHaveBeenCalled();
  });

  it("shows the selected shared speech model and opt-in AI cleanup near capture", async () => {
    backendMocks.privacyOverrides.dictationAi = { provider: "native_text", modelId: null };
    backendMocks.getNativeTextModelStatus.mockResolvedValue({
      modelId: "qwen3-4b-instruct-2507-q4_k_m",
      runtimePresent: true,
      ready: true,
      runtimeHealth: { state: "available", message: null },
      canLoadNow: true,
    });
    backendMocks.transcriptionOverrides = {
      useSharedAsrSelection: true,
      dictationProvider: "whisper",
      dictationModelId: "large-v3-turbo",
      dictationAiFormatting: true,
    };
    backendMocks.asrProviders = [{
      providerType: "distil_whisper",
      name: "Distil Whisper",
      modelOptions: [{ id: "distil-large-v3.5", label: "Distil Large v3.5" }],
      runtimeStatus: "ready",
    }];
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(await within(hero).findByText("Distil-Whisper Large (English)")).toBeInTheDocument();
    await waitFor(() => expect(backendMocks.getNativeTextModelStatus).toHaveBeenCalled());
    expect(await within(hero).findByText("AI cleanup")).toBeInTheDocument();
    expect(within(hero).queryByText(/large-v3-turbo/)).not.toBeInTheDocument();
    backendMocks.transcriptionOverrides.dictationAiFormatting = false;
    await act(async () => {
      backendMocks.eventListeners.get("settings-changed")?.({ payload: {
        ...backendMocks.buildSettings(),
        transcription: { ...backendMocks.buildSettings().transcription, dictationAiFormatting: false },
      } });
    });
    expect(within(hero).getByText("Basic formatting")).toBeInTheDocument();
    backendMocks.transcriptionOverrides.dictationProfile = "power_rewrite";
    await act(async () => {
      backendMocks.eventListeners.get("settings-changed")?.({ payload: {
        ...backendMocks.buildSettings(),
        transcription: { ...backendMocks.buildSettings().transcription, dictationAiFormatting: false, dictationProfile: "power_rewrite" },
      } });
    });
    expect(within(hero).getByText("Rewrite")).toBeInTheDocument();
  });

  it.each([
    { dictationCustomPrompt: "Rewrite as clear prose." },
    {
      dictationModePreset: "custom",
      dictationSelectedCustomModeId: "rewrite-mode",
      dictationCustomModes: [{ id: "rewrite-mode", name: "Rewrite mode", description: "", profile: "power_rewrite", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false }],
    },
  ])("reports rewriting when the saved prompt or custom profile enables it", async (overrides) => {
    backendMocks.transcriptionOverrides = {
      dictationProfile: "normal_speed",
      dictationAiFormatting: false,
      ...overrides,
    };
    render(<DictationView />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(await within(hero).findByText("Rewrite")).toBeInTheDocument();
    expect(within(hero).queryByText("No AI formatting")).not.toBeInTheDocument();
  });

  it("keeps coaching out of the way after dictation and lets users reopen it", async () => {
    render(<DictationView />);
    const show = await screen.findByRole("button", { name: "Show tips" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Fix the last insert with your voice")).not.toBeInTheDocument();
    await userEvent.click(show);
    expect(screen.getByText("Fix the last insert with your voice")).toBeInTheDocument();
    const hide = screen.getByRole("button", { name: "Hide tips" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(hide);
    expect(screen.queryByText("Fix the last insert with your voice")).not.toBeInTheDocument();
  });

  it("labels each coach tip's action for what it does, with one button for a tip that only closes", async () => {
    backendMocks.transcriptionOverrides = { dictationCommandModeEnabled: false };
    render(<DictationView />);
    await userEvent.click(await screen.findByRole("button", { name: "Show tips" }));
    const tips = document.getElementById("dictation-coach-tips")!;
    expect(within(tips).queryByRole("button", { name: "Show me later" })).not.toBeInTheDocument();
    expect(within(tips).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    const gotIt = within(tips).getAllByRole("button", { name: "Got it" });
    expect(gotIt).toHaveLength(2);
    await userEvent.click(gotIt[0]);
    await userEvent.click(within(tips).getByRole("button", { name: "Got it" }));
    expect(within(tips).getByRole("button", { name: "Turn on Command mode" })).toBeInTheDocument();
    expect(within(tips).getByRole("button", { name: "Add the Coding profile" })).toBeInTheDocument();
    expect(within(tips).getByText(/Adding the Coding profile also switches to it\./)).toBeInTheDocument();
    expect(within(tips).getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  });

  it("shows the speech model's dictionary note on the Dictionary tab and names its fields", async () => {
    render(<DictationView />);
    await openConfigTab("Dictionary");
    const dictionary = await screen.findByTestId("dictionary-section");
    expect(within(dictionary).getByText(/does not take vocabulary hints/)).toBeInTheDocument();
    expect(within(dictionary).getByRole("textbox", { name: "Heard as" })).toHaveAttribute("placeholder", "Heard as (e.g. open ai)");
    expect(within(dictionary).getByRole("textbox", { name: "Replace with" })).toHaveAttribute("placeholder", "Replace with (e.g. OpenAI)");
    expect(within(dictionary).getByRole("textbox", { name: "Only in app (optional)" })).toBeInTheDocument();
  });

  it("quick-adds the selected words as the replacement and puts the cursor in Heard as", async () => {
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { text: "Send it to Jon today.", actualProvider: "distil_whisper" },
      });
    });
    const editor = await screen.findByRole("textbox", { name: "Latest dictation result" }) as HTMLTextAreaElement;
    editor.setSelectionRange(11, 14);
    fireEvent.click(screen.getByRole("button", { name: "Quick add to dictionary" }));
    const dictionary = await screen.findByTestId("dictionary-section");
    const heardAs = within(dictionary).getByRole("textbox", { name: "Heard as" });
    expect(heardAs).toHaveValue("");
    await waitFor(() => expect(heardAs).toHaveFocus());
    expect(within(dictionary).getByRole("textbox", { name: "Replace with" })).toHaveValue("Jon");
    expect(within(dictionary).getByRole("status")).toHaveTextContent(
      "Replace with is filled in. Type what Plainsong heard in Heard as, then choose Add.",
    );
  });

  it("marks the selected route button pressed", async () => {
    render(<DictationView />);
    await openConfigTab("Profiles");
    const local = await screen.findByRole("button", { name: "On this Mac" });
    const cloud = screen.getByRole("button", { name: "In the cloud" });
    expect([local.getAttribute("aria-pressed"), cloud.getAttribute("aria-pressed")].sort()).toEqual(["false", "true"]);
  });

  it("asks before deleting a saved profile", async () => {
    backendMocks.transcriptionOverrides = {
      dictationCustomModes: [{ id: "saved-profile", name: "Standup notes", description: "", profile: "normal_speed", customPrompt: null, insertionMode: "auto", contextSource: "none", saveToInbox: true, copyToClipboard: false, commandModeEnabled: false,
        dictationProvider: "moonshine", dictationModelId: "moonshine-base", activationAppMatcher: "Slack" }],
    };
    render(<DictationView />);
    await openConfigTab("Profiles");
    expect(await screen.findByText(/UsefulSensors Moonshine · .* · Switches on automatically in Slack/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete profile Standup notes" }));
    const confirm = screen.getByRole("group", { name: "Confirm deleting Standup notes" });
    expect(within(confirm).getByRole("button", { name: "Keep profile" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep profile" }));
    expect(screen.getByText("Standup notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete profile Standup notes" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm deleting Standup notes" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Standup notes")).not.toBeInTheDocument());
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

    fireEvent.click(await screen.findByRole("button", { name: "Copy result" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Ship it");
      expect(toast).toHaveBeenCalledWith(
        "Result copied. Paste it where you want it.",
        "success",
      );
    });
    expect(
      (await screen.findAllByText("Paste command sent")).length,
    ).toBeGreaterThan(0);

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

  it("learns a case-only edit of the latest result through Learn correction alone", async () => {
    const backend = await import("@/lib/backend/dictation");
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

    // Unedited text: nothing to learn yet.
    expect(learnButton).toBeDisabled();

    fireEvent.change(textarea as HTMLTextAreaElement, {
      target: { value: "Hello World" },
    });

    // The capitalization fix is an ordinary correction: one button covers
    // it, and the old duplicate "Fix capitalization" is gone.
    await waitFor(() => expect(learnButton).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Fix capitalization" }),
    ).not.toBeInTheDocument();
    fireEvent.click(learnButton);
    await waitFor(() => expect(backend.learnDictationCorrection).toHaveBeenCalled());
    expect(vi.mocked(backend.learnDictationCorrection).mock.calls.at(-1)?.[0]).toMatchObject({
      originalText: "hello world",
      correctedText: "Hello World",
      force: true,
    });
  });

  describe("dictionary row edit ownership", () => {
    const entry = (updates: Record<string, unknown> = {}) => ({
      id: "dict-row",
      spokenForm: "jon",
      replacement: "John",
      appScope: null,
      caseSensitive: false,
      enabled: true,
      categoryScope: null,
      createdAt: "2026-03-14T10:00:00.000Z",
      updatedAt: "2026-03-14T10:00:00.000Z",
      ...updates,
    });

    async function renderDictionaryRow() {
      const dictationBackend = await import("@/lib/backend/dictation");
      vi.mocked(dictationBackend.listDictationDictionaryEntries).mockResolvedValueOnce([entry()]);
      render(<DictationView />);
      await openConfigTab("Dictionary");
      const spoken = await screen.findByDisplayValue("jon");
      const row = spoken.parentElement?.parentElement as HTMLElement;
      return { dictationBackend, spoken, row };
    }

    it("does not let one field acknowledgement erase a newer draft in another field", async () => {
      const save = deferred<any>();
      const { dictationBackend, spoken } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry).mockReturnValueOnce(save.promise);
      const replacement = screen.getByDisplayValue("John");
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      fireEvent.change(replacement, { target: { value: "Jonathan" } });

      await act(async () => {
        save.resolve(entry({ spokenForm: "john", replacement: "John", updatedAt: "2026-03-14T10:01:00.000Z" }));
        await save.promise;
      });
      expect(replacement).toHaveValue("Jonathan");
      expect(spoken).toHaveValue("john");
    });

    it("preserves a same-field A-B-A edit from an older acknowledgement", async () => {
      const save = deferred<any>();
      const { dictationBackend, spoken } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry).mockReturnValueOnce(save.promise);
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      fireEvent.change(spoken, { target: { value: "jonathan" } });
      fireEvent.change(spoken, { target: { value: "john" } });

      await act(async () => {
        save.resolve(entry({ spokenForm: "server-normalized", updatedAt: "2026-03-14T10:01:00.000Z" }));
        await save.promise;
      });
      expect(spoken).toHaveValue("john");
    });

    it("runs queued field writes in order and keeps the final values", async () => {
      const first = deferred<any>();
      const second = deferred<any>();
      const { dictationBackend, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      fireEvent.click(within(row).getByLabelText("Case-sensitive"));
      fireEvent.click(within(row).getByLabelText("Enabled"));
      expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(1);

      await act(async () => {
        first.resolve(entry({ caseSensitive: true, enabled: true, updatedAt: "2026-03-14T10:01:00.000Z" }));
        await first.promise;
      });
      await waitFor(() =>
        expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(2),
      );
      await act(async () => {
        second.resolve(entry({ caseSensitive: true, enabled: false, updatedAt: "2026-03-14T10:02:00.000Z" }));
        await second.promise;
      });
      expect(within(row).getByLabelText("Case-sensitive")).toBeChecked();
      expect(within(row).getByLabelText("Enabled")).not.toBeChecked();
    });

    it("keeps local rows after failure and retries the latest normalized six fields", async () => {
      const first = deferred<any>();
      const retry = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { dictationBackend, spoken, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry)
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(entry({ caseSensitive: true }))
        .mockResolvedValueOnce(entry({ caseSensitive: true, enabled: false }))
        .mockResolvedValueOnce(entry({ caseSensitive: true, enabled: false, categoryScope: "worklog" }))
        .mockReturnValueOnce(retry.promise);
      fireEvent.change(spoken, { target: { value: "  john  " } });
      fireEvent.blur(spoken);
      await act(async () => { first.reject(new Error("save failed")); await first.promise.catch(() => undefined); });
      expect(await within(row).findByRole("alert")).toHaveTextContent("Save wasn't confirmed");

      fireEvent.change(screen.getByDisplayValue("John"), { target: { value: "  Jonathan  " } });
      fireEvent.change(within(row).getByPlaceholderText("Only in app"), { target: { value: "  Slack  " } });
      fireEvent.click(within(row).getByLabelText("Case-sensitive"));
      fireEvent.click(within(row).getByLabelText("Enabled"));
      fireEvent.click(within(row).getByRole("combobox"));
      fireEvent.click(await screen.findByRole("option", { name: "Project tools" }));
      fireEvent.click(await within(row).findByRole("button", { name: "Retry save" }));
      await waitFor(() =>
        expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenLastCalledWith(
          "dict-row",
          {
            spokenForm: "john",
            replacement: "Jonathan",
            appScope: "Slack",
            caseSensitive: true,
            enabled: false,
            categoryScope: "worklog",
          },
        ),
      );
      await act(async () => {
        retry.resolve(entry({ spokenForm: "john", replacement: "Jonathan", appScope: "Slack", caseSensitive: true, enabled: false, categoryScope: "worklog" }));
        await retry.promise;
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      consoleWarn.mockRestore();
    });

    it("keeps retry recovery when a newer draft is typed during the retry", async () => {
      const retry = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { dictationBackend, spoken, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry)
        .mockRejectedValueOnce(new Error("save failed"))
        .mockReturnValueOnce(retry.promise)
        .mockResolvedValueOnce(entry({ spokenForm: "john", replacement: "Jonathan" }));
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      fireEvent.click(await within(row).findByRole("button", { name: "Retry save" }));
      const replacement = screen.getByDisplayValue("John");
      fireEvent.change(replacement, { target: { value: "Jonathan" } });
      await act(async () => {
        retry.resolve(entry({ spokenForm: "john" }));
        await retry.promise;
      });
      expect(replacement).toHaveValue("Jonathan");
      expect(within(row).getByRole("alert")).toHaveTextContent("Save wasn't confirmed");
      fireEvent.click(within(row).getByRole("button", { name: "Retry save" }));
      await waitFor(() => expect(dictationBackend.updateDictationDictionaryEntry)
        .toHaveBeenLastCalledWith("dict-row", expect.objectContaining({ replacement: "Jonathan" })));
      await waitFor(() => expect(within(row).queryByRole("alert")).not.toBeInTheDocument());
      consoleWarn.mockRestore();
    });

    it("queues one full retry behind a pending field save", async () => {
      const fieldSave = deferred<any>();
      const retry = deferred<any>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { dictationBackend, spoken, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry)
        .mockRejectedValueOnce(new Error("save failed"))
        .mockReturnValueOnce(fieldSave.promise)
        .mockReturnValueOnce(retry.promise);
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      await within(row).findByRole("button", { name: "Retry save" });
      const replacement = screen.getByDisplayValue("John");
      fireEvent.change(replacement, { target: { value: "Jonathan" } });
      fireEvent.blur(replacement);
      const retryButton = within(row).getByRole("button", { name: "Retry save" });
      expect(retryButton).toBeEnabled();
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(retryButton).toBeDisabled();
      expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(2);
      await act(async () => {
        fieldSave.resolve(entry({ spokenForm: "john", replacement: "Jonathan" }));
        await fieldSave.promise;
      });
      await waitFor(() => expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(3));
      expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenLastCalledWith(
        "dict-row", expect.objectContaining({ spokenForm: "john", replacement: "Jonathan", enabled: true }),
      );
      await act(async () => {
        retry.resolve(entry({ spokenForm: "john", replacement: "Jonathan" }));
        await retry.promise;
      });
      expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(3);
      expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
      consoleWarn.mockRestore();
    });

    it("clears a failed field warning only when a later save confirms that field", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { dictationBackend, spoken, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry)
        .mockRejectedValueOnce(new Error("save failed"))
        .mockResolvedValueOnce(entry({ caseSensitive: true }))
        .mockResolvedValueOnce(entry({ spokenForm: "jonathan", caseSensitive: true }));
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      await within(row).findByRole("alert");
      fireEvent.click(within(row).getByLabelText("Case-sensitive"));
      await waitFor(() => expect(dictationBackend.updateDictationDictionaryEntry).toHaveBeenCalledTimes(2));
      expect(within(row).getByRole("alert")).toHaveTextContent("Save wasn't confirmed");
      fireEvent.change(spoken, { target: { value: "jonathan" } });
      fireEvent.blur(spoken);
      await waitFor(() => expect(within(row).queryByRole("alert")).not.toBeInTheDocument());
      expect(spoken).toHaveValue("jonathan");
      consoleWarn.mockRestore();
    });

    it("preserves edits after a failed removal and allows one retry", async () => {
      const first = deferred<void>();
      const retry = deferred<void>();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { dictationBackend, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.deleteDictationDictionaryEntry)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise);
      const replacement = screen.getByDisplayValue("John");
      fireEvent.change(replacement, { target: { value: "Jonathan" } });
      const remove = within(row).getByRole("button", { name: "Remove" });
      fireEvent.click(remove);
      fireEvent.click(remove);
      expect(dictationBackend.deleteDictationDictionaryEntry).toHaveBeenCalledTimes(1);
      expect(within(row).getByRole("button", { name: "Removing…" })).toBeDisabled();
      await act(async () => {
        first.reject(new Error("delete failed"));
        await first.promise.catch(() => undefined);
      });
      expect(replacement).toHaveValue("Jonathan");
      expect(within(row).getByRole("alert")).toHaveTextContent("Removal wasn't confirmed");
      const retryRemove = within(row).getByRole("button", { name: "Retry remove" });
      expect(retryRemove).toBeEnabled();
      fireEvent.click(retryRemove);
      fireEvent.click(retryRemove);
      expect(dictationBackend.deleteDictationDictionaryEntry).toHaveBeenCalledTimes(2);
      expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => {
        retry.resolve();
        await retry.promise;
      });
      expect(screen.queryByDisplayValue("Jonathan")).not.toBeInTheDocument();
      expect(dictationBackend.deleteDictationDictionaryEntry).toHaveBeenLastCalledWith("dict-row");
      consoleWarn.mockRestore();
    });

    it("does not resurrect a removed row after a late save acknowledgement", async () => {
      const save = deferred<any>();
      const { dictationBackend, spoken, row } = await renderDictionaryRow();
      vi.mocked(dictationBackend.updateDictationDictionaryEntry).mockReturnValueOnce(save.promise);
      vi.mocked(dictationBackend.deleteDictationDictionaryEntry).mockResolvedValueOnce(undefined);
      fireEvent.change(spoken, { target: { value: "john" } });
      fireEvent.blur(spoken);
      fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByDisplayValue("john")).not.toBeInTheDocument());

      await act(async () => {
        save.resolve(entry({ spokenForm: "john", updatedAt: "2026-03-14T10:01:00.000Z" }));
        await save.promise;
      });
      expect(screen.queryByDisplayValue("john")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("Heard as (e.g. open ai)"), {
      target: { value: "standup" },
    });
    fireEvent.change(screen.getByPlaceholderText("Replace with (e.g. OpenAI)"), {
      target: { value: "stand-up" },
    });

    const dictionarySection = screen.getByTestId("dictionary-section");
    const categoryTrigger = within(dictionarySection).getByRole("combobox", {
      name: "New dictionary entry destination category",
    });
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

describe("DictationView history search and Process again", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDictationIoMocks();
    backendMocks.invoke.mockImplementation(async () => ({ pasted: true, copied: false }));
    window.localStorage.clear();
    backendMocks.eventListeners.clear();
    backendMocks.asrProviders = backendMocks.buildAsrProviders();
    backendMocks.recordings = [createSavedDictation()];
    backendMocks.recordingsError = null;
    backendMocks.getDictationHistoryDetails.mockResolvedValue(null);
    for (const key of Object.keys(backendMocks.transcriptionOverrides)) {
      delete backendMocks.transcriptionOverrides[key];
    }
    backendMocks.getTranscript.mockResolvedValue(
      createSavedTranscript(
        "dictation-1",
        "Ship the quarterly budget summary to finance.",
      ),
    );
    backendMocks.getRecording.mockResolvedValue(null);
    backendMocks.reprocessDictationText.mockResolvedValue(null);
    audioPlayerMock.props.length = 0;
    audioPlayerMock.mountedRecordingIds.length = 0;
    audioPlayerMock.unmountedRecordingIds.length = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  describe("exact saved result review", () => {
    it("consumes a parked request after mounting without reprocessing or insertion", async () => {
      queueDictationHistoryRequest("dictation-1");
      render(<DictationView />);
      const dialog = await screen.findByRole("dialog", { name: "Project update" });
      expect(await within(dialog).findByLabelText("Saved result")).toHaveValue("Ship the quarterly budget summary to finance.");
      expect(consumePendingDictationHistoryRequest()).toBeNull();
      expect(backendMocks.reprocessDictationText).not.toHaveBeenCalled();
      expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();
      expect(backendMocks.invoke).not.toHaveBeenCalledWith("repaste_dictation_result", expect.anything());
    });

    it.each([null, createSavedDictation({ id: "unavailable", sourceType: "meeting" })])("refuses a deleted or non-dictation request", async (recording) => {
      backendMocks.getRecording.mockResolvedValue(recording);
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      act(() => queueDictationHistoryRequest("unavailable"));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("That saved dictation is no longer available.", "error"));
      expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument();
    });

    it("keeps the current history draft when its save fails during an exact request", async () => {
      backendMocks.recordings = [createSavedDictation(), createSavedDictation({ id: "dictation-2", title: "Customer follow-up" })];
      render(<DictationView />);
      fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
      const dialog = await screen.findByRole("dialog", { name: "Project update" });
      const editor = await within(dialog).findByLabelText("Saved result");
      fireEvent.change(editor, { target: { value: "Unfinished saved draft." } });
      backendMocks.saveDictationEdit.mockRejectedValueOnce(new Error("Save unavailable"));
      act(() => queueDictationHistoryRequest("dictation-2"));
      await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalled());
      expect(screen.getByRole("dialog", { name: "Project update" })).toBeInTheDocument();
      expect(editor).toHaveValue("Unfinished saved draft.");
      expect(screen.queryByRole("dialog", { name: "Customer follow-up" })).not.toBeInTheDocument();
    });
  });

  it("loads original audio only after an explicit click and can hide it", async () => {
    backendMocks.getDictationHistoryDetails.mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const listen = await within(dialog).findByRole("button", {
      name: "Listen to original audio",
    });

    expect(audioPlayerMock.props).toHaveLength(0);
    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(1);
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();

    fireEvent.click(listen);

    const player = await within(dialog).findByTestId("original-audio-player");
    expect(player).toHaveAttribute("data-recording-id", "dictation-1");
    expect(player).toHaveAttribute("data-duration-hint", "12");
    expect(player).toHaveAttribute("data-waveform", "[]");
    expect(audioPlayerMock.mountedRecordingIds).toEqual(["dictation-1"]);
    expect(backendMocks.getTranscript).toHaveBeenCalledTimes(1);
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Hide original audio" }));

    await waitFor(() => {
      expect(within(dialog).queryByTestId("original-audio-player")).not.toBeInTheDocument();
      expect(audioPlayerMock.unmountedRecordingIds).toEqual(["dictation-1"]);
    });
  });

  it("reviews retained audio when transcription failed without starting other work", async () => {
    backendMocks.getDictationHistoryDetails.mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);
    backendMocks.recordings = [createSavedDictation({
      id: "failed-dictation",
      title: "Failed dictation",
      duration: 7,
      status: "error",
    })];
    backendMocks.getTranscript.mockResolvedValue(null);

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Failed dictation",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Failed dictation" });

    expect(within(dialog).getByText(
      "Listen to what was recorded before correcting or processing it again.",
    )).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Saved result")).not.toBeInTheDocument();
    expect(audioPlayerMock.props).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", {
      name: "Listen to original audio",
    }));

    const player = await within(dialog).findByTestId("original-audio-player");
    expect(player).toHaveAttribute("data-recording-id", "failed-dictation");
    expect(player).toHaveAttribute("data-duration-hint", "7");
    expect(backendMocks.reprocessDictationText).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("releases original audio when history closes and does not open the next source", async () => {
    backendMocks.getDictationHistoryDetails.mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        duration: 21,
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(recordingId, recordingId === "dictation-1"
        ? "Ship the quarterly budget summary to finance."
        : "Send the customer a revised timeline."),
    );

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const firstDialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.click(await within(firstDialog).findByRole("button", {
      name: "Listen to original audio",
    }));
    await within(firstDialog).findByTestId("original-audio-player");

    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(audioPlayerMock.unmountedRecordingIds).toEqual(["dictation-1"]);
    });

    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Customer follow-up",
    }));
    const secondDialog = await screen.findByRole("dialog", { name: "Customer follow-up" });
    await within(secondDialog).findByRole("button", { name: "Listen to original audio" });
    expect(within(secondDialog).queryByTestId("original-audio-player")).not.toBeInTheDocument();
    expect(audioPlayerMock.mountedRecordingIds).toEqual(["dictation-1"]);
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it.each([false, null])("does not offer original audio when availability is %s", async (audioAvailable) => {
    backendMocks.getDictationHistoryDetails.mockResolvedValue({
      audioAvailable,
      pipelineStageKeys: [],
    } as any);

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByLabelText("Saved result");

    expect(within(dialog).queryByRole("button", {
      name: "Listen to original audio",
    })).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("original-audio-player")).not.toBeInTheDocument();
    expect(audioPlayerMock.props).toHaveLength(0);
  });

  it("shows a playback error without changing text and retries only on request", async () => {
    backendMocks.getDictationHistoryDetails.mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    const originalText = "Ship the quarterly budget summary to finance.";
    expect(editor).toHaveValue(originalText);

    fireEvent.click(await within(dialog).findByRole("button", {
      name: "Listen to original audio",
    }));
    fireEvent.click(await within(dialog).findByRole("button", {
      name: "Simulate original audio error",
    }));

    expect(await within(dialog).findByText(
      "Original audio could not be opened. Your text is unchanged.",
    )).toHaveAttribute("role", "alert");
    expect(editor).toHaveValue(originalText);
    expect(audioPlayerMock.mountedRecordingIds).toEqual(["dictation-1"]);
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry original audio" }));

    await waitFor(() => {
      expect(audioPlayerMock.unmountedRecordingIds).toEqual(["dictation-1"]);
      expect(audioPlayerMock.mountedRecordingIds).toEqual(["dictation-1", "dictation-1"]);
    });
    expect(within(dialog).queryByText(
      "Original audio could not be opened. Your text is unchanged.",
    )).not.toBeInTheDocument();
    expect(editor).toHaveValue(originalText);
  });

  it("recovers history typing after the view is interrupted before saving", async () => {
    const savedCorrection = "Previously saved correction.";
    const draftText = "Unfinished history words.\nKeep this line too.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: savedCorrection });
    const view = render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.change(await within(dialog).findByLabelText("Saved result"), { target: { value: draftText } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1", draftText, savedCorrection,
    ));
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    view.unmount();
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      { recordingId: "dictation-1", title: "Project update", text: draftText, expectedSavedText: savedCorrection },
    ]);
    render(<DictationView />);
    await screen.findByText("Unfinished edits (1)");
    fireEvent.click(screen.getByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("textbox", { name: "Latest dictation result" })).toHaveValue(draftText);
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("journals history typing after saved corrections fail to load and preserves conflicts on resume", async () => {
    const draftText = "Unfinished words after a failed read.\nKeep this line too.";
    const storedCorrection = "Existing saved correction must remain.";
    backendMocks.getDictationEdit.mockRejectedValueOnce(new Error("Saved edit lookup failed"));
    const view = render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: draftText } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1", draftText, null,
    ));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    view.unmount();
    backendMocks.listDictationDrafts.mockResolvedValueOnce([
      { recordingId: "dictation-1", title: "Project update", text: draftText, expectedSavedText: null },
    ]);
    backendMocks.getDictationEdit.mockResolvedValue({ text: storedCorrection });
    render(<DictationView />);
    fireEvent.click(await screen.findByText("Unfinished edits (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const conflict = await screen.findByRole("region", { name: "Saved version changed" });
    expect(within(conflict).getByText(storedCorrection)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue(draftText);
    expect(screen.getByRole("button", { name: "Save to history" })).toBeDisabled();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    fireEvent.click(within(conflict).getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to history" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
      "dictation-1", draftText, storedCorrection,
    ));
  });

  it("keeps the original-text recovery copy after saved corrections fail to load", async () => {
    backendMocks.getDictationEdit.mockRejectedValueOnce(new Error("Saved edit lookup failed"));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByRole("textbox", { name: "Saved result" });
    const original = "Ship the quarterly budget summary to finance.";
    expect(editor).toHaveValue(original);
    fireEvent.change(editor, { target: { value: "A temporary edit." } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1", "A temporary edit.", null,
    ));
    fireEvent.change(editor, { target: { value: original } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
      "dictation-1", original, null,
    ));
    expect(backendMocks.clearDictationDraft).not.toHaveBeenCalled();
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 0, ""])("keeps failed-read ownership after a falsy rejection reason %s", async (reason) => {
    backendMocks.getDictationEdit.mockRejectedValueOnce(reason);
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    await within(dialog).findByText("Couldn't load saved corrections. Reopen this dictation before saving changes.");
    fireEvent.change(editor, { target: { value: "Draft after a failed read." } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1", "Draft after a failed read.", null,
    ));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    const original = "Ship the quarterly budget summary to finance.";
    fireEvent.change(editor, { target: { value: original } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
      "dictation-1", original, null,
    ));
    expect(backendMocks.clearDictationDraft).not.toHaveBeenCalled();
  });

  it("restores the read failure warning when journaling succeeds after saved corrections fail to load", async () => {
    backendMocks.getDictationEdit.mockRejectedValueOnce(new Error("Saved edit lookup failed"));
    backendMocks.saveDictationDraft.mockRejectedValueOnce(new Error("Draft write failed"));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "First retained draft." } });
    await within(dialog).findByText("Couldn't store a recovery copy. Keep this window open or save your changes to history.");
    fireEvent.change(editor, { target: { value: "Second retained draft." } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenLastCalledWith(
      "dictation-1", "Second retained draft.", null,
    ));
    await within(dialog).findByText("Couldn't load saved corrections. Reopen this dictation before saving changes.");
    expect(editor).toHaveValue("Second retained draft.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("clears the recovery copy when history typing returns to its saved correction", async () => {
    const savedCorrection = "Previously saved correction.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: savedCorrection });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Unfinished history words." } });
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalled());
    fireEvent.change(editor, { target: { value: savedCorrection } });
    await waitFor(() => expect(backendMocks.clearDictationDraft).toHaveBeenCalledWith(
      "dictation-1", "Unfinished history words.",
    ));
    await waitFor(() => expect(screen.queryByText("Unfinished edits (1)")).not.toBeInTheDocument());
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("keeps history typing saveable when storing its recovery copy fails", async () => {
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationDraft.mockRejectedValueOnce(new Error("Recovery storage unavailable"));
    backendMocks.saveDictationEdit.mockImplementation(async (_id: string, text: string | null) => ({ text }));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Unfinished history words." } });
    expect(await within(dialog).findByText("Couldn't store a recovery copy. Keep this window open or save your changes to history.")).toBeInTheDocument();
    expect(editor).toHaveValue("Unfinished history words.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
      "dictation-1", "Unfinished history words.", null,
    ));
  });

  it("clears a failed history recovery warning after a successful later journal", async () => {
    const recoveryError = "Couldn't store a recovery copy. Keep this window open or save your changes to history.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationDraft.mockRejectedValueOnce(new Error("Storage unavailable"));
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "First unfinished words." } });
    await within(dialog).findByText(recoveryError);
    fireEvent.change(editor, { target: { value: "New unfinished words." } });
    await waitFor(() => expect(within(dialog).queryByText(recoveryError)).not.toBeInTheDocument());
    expect(editor).toHaveValue("New unfinished words.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("clears a failed history recovery warning when its exact draft is discarded", async () => {
    const saved = "Previously saved correction.";
    const recoveryError = "Couldn't store a recovery copy. Keep this window open or save your changes to history.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: saved });
    backendMocks.saveDictationDraft.mockRejectedValueOnce(new Error("Storage unavailable"));
    backendMocks.clearDictationDraft.mockResolvedValue(true);
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Failed draft." } });
    await within(dialog).findByText(recoveryError);
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(within(dialog).queryByText(recoveryError)).not.toBeInTheDocument());
    expect(backendMocks.clearDictationDraft).toHaveBeenCalledWith("dictation-1", "Failed draft.");
    expect(editor).toHaveValue(saved);
  });

  it("excludes history restoration from learning and learns subsequent typing from restored text", async () => {
    const backend = await import("@/lib/backend/dictation");
    const original = "Ship the quarterly budget summary to finance.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: "Previously saved correction." });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore original" }));
    expect(editor).toHaveValue(original);
    fireEvent.blur(editor);
    await act(async () => {});
    expect(backend.queueDictationCorrectionSuggestion).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Learn correction" })).toBeDisabled();
    const corrected = "Ship the quarterly budget summary to Finance.";
    fireEvent.change(editor, { target: { value: corrected } });
    fireEvent.blur(editor);
    await waitFor(() => expect(backend.queueDictationCorrectionSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ originalText: original, correctedText: corrected, force: false }),
    ));
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
  });

  it("saved dictation edit persists across close and reopen", async () => {
    let storedText: string | null = null;
    backendMocks.getDictationEdit.mockImplementation(async () => ({ text: storedText }));
    backendMocks.saveDictationEdit.mockImplementation(async (_id: string, text: string | null) => {
      storedText = text;
      return { text };
    });

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Edited saved text." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Open saved dictation: Project update" }));
    const reopened = await screen.findByRole("dialog", { name: "Project update" });
    expect(await within(reopened).findByLabelText("Saved result")).toHaveValue("Edited saved text.");
  });

  it("stops calling the latest result saved once its history entry is deleted", async () => {
    backendMocks.recordings = [createSavedDictation()];
    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "dictation-1", text: "Ship the budget summary." },
      });
    });
    expect(await screen.findByText("Saved in history")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use for Paste last result" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const detailDialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.click(within(detailDialog).getByRole("button", { name: "Delete" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete this dictation?" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete dictation" }));
    await waitFor(() => expect(backendMocks.deleteRecording).toHaveBeenCalledWith("dictation-1"));

    await waitFor(() => expect(screen.queryByText("Saved in history")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Use for Paste last result" })).not.toBeInTheDocument();
    // The words stay on the card to copy.
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Ship the budget summary.");
  });

  it("syncs a saved history correction into the untouched matching latest result", async () => {
    const original = "Ship the quarterly budget summary to finance.";
    const corrected = "Ship the revised quarterly budget summary to finance.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationEdit.mockImplementation(async (_id: string, text: string | null) => ({ text }));

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "dictation-1", text: original },
      });
    });
    const latest = screen.getByRole("textbox", { name: "Latest dictation result" });
    const shortcut = screen.getByRole("button", { name: "Use for Paste last result" });
    const copyAgain = screen.getByRole("button", { name: "Copy result" });

    fireEvent.click(screen.getByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.change(await within(dialog).findByLabelText("Saved result"), {
      target: { value: corrected },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
      "dictation-1",
      corrected,
      null,
    ));
    await waitFor(() => expect(latest).toHaveValue(corrected));
    expect(shortcut).toBeEnabled();
    expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();

    clipboardWriteText.mockClear();
    fireEvent.click(copyAgain);
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(corrected));
    expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
  });

  it("keeps an A to C to A latest edit made while a matching history save is pending", async () => {
    const original = "Ship the quarterly budget summary to finance.";
    const pendingSave = deferred<{ text: string | null }>();
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationEdit.mockReturnValueOnce(pendingSave.promise);

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "dictation-1", text: original },
      });
    });
    const latest = screen.getByRole("textbox", { name: "Latest dictation result" });

    fireEvent.click(screen.getByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.change(await within(dialog).findByLabelText("Saved result"), {
      target: { value: "Saved correction B" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledOnce());

    fireEvent.change(latest, { target: { value: "Manual draft C" } });
    fireEvent.change(latest, { target: { value: original } });
    await act(async () => {
      pendingSave.resolve({ text: "Saved correction B" });
      await pendingSave.promise;
    });

    expect(latest).toHaveValue(original);
    expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
  });

  it("does not replace a newer capture when an older matching history save finishes", async () => {
    const pendingSave = deferred<{ text: string | null }>();
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationEdit.mockReturnValueOnce(pendingSave.promise);

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: {
          recordingId: "dictation-1",
          text: "Ship the quarterly budget summary to finance.",
        },
      });
    });
    const latest = screen.getByRole("textbox", { name: "Latest dictation result" });

    fireEvent.click(screen.getByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.change(await within(dialog).findByLabelText("Saved result"), {
      target: { value: "Saved correction B" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledOnce());

    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "dictation-2", text: "New capture C" },
      });
    });
    await act(async () => {
      pendingSave.resolve({ text: "Saved correction B" });
      await pendingSave.promise;
    });

    expect(latest).toHaveValue("New capture C");
    expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
  });

  it("syncs a restored original into the untouched matching latest result", async () => {
    const original = "Ship the quarterly budget summary to finance.";
    const corrected = "Ship the revised quarterly budget summary to finance.";
    backendMocks.getDictationEdit.mockResolvedValue({ text: null });
    backendMocks.saveDictationEdit.mockImplementation(async (_id: string, text: string | null) => ({ text }));

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: { recordingId: "dictation-1", text: original },
      });
    });
    const latest = screen.getByRole("textbox", { name: "Latest dictation result" });
    fireEvent.click(screen.getByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const savedResult = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(savedResult, { target: { value: corrected } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(latest).toHaveValue(corrected));
    await within(dialog).findByText("Changes saved.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore original" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenLastCalledWith(
      "dictation-1",
      null,
      corrected,
    ));
    await waitFor(() => expect(latest).toHaveValue(original));
    expect(backendMocks.stageSavedDictationResult).not.toHaveBeenCalled();
  });

  it("rebases an adopted preview draft after saving its history edit", async () => {
    let storedText: string | null = "Saved A";
    backendMocks.getDictationEdit.mockImplementation(async () => ({ text: storedText }));
    backendMocks.saveDictationEdit.mockImplementation(async (_id: string, text: string | null) => {
      storedText = text;
      return { text };
    });
    backendMocks.saveDictationDraft.mockResolvedValue(undefined);
    backendMocks.clearDictationDraft.mockResolvedValue(true);
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "Preview C",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "History B" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Use Result" }));

    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
      "Saved A",
    ));

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
      "History B",
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Preview C");
  });

  it("clears an adopted preview recovery copy only after the same text is saved", async () => {
    const pendingSave = deferred<{ text: string | null }>();
    backendMocks.getDictationEdit.mockResolvedValue({ text: "Saved A" });
    backendMocks.saveDictationEdit.mockReturnValueOnce(pendingSave.promise);
    backendMocks.saveDictationDraft.mockResolvedValue(undefined);
    backendMocks.clearDictationDraft.mockResolvedValue(true);
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "Preview C",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Use Result" }));
    fireEvent.change(editor, { target: { value: "Preview C" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(backendMocks.saveDictationEdit).toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
      "Saved A",
    ));
    expect(backendMocks.clearDictationDraft).not.toHaveBeenCalled();

    await act(async () => {
      pendingSave.resolve({ text: "Preview C" });
      await pendingSave.promise;
    });

    await waitFor(() => expect(backendMocks.clearDictationDraft).toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());
  });

  it("does not rebase an adopted preview draft when its history edit fails", async () => {
    backendMocks.getDictationEdit.mockResolvedValue({ text: "Saved A" });
    backendMocks.saveDictationEdit.mockRejectedValue(new Error("Save failed"));
    backendMocks.saveDictationDraft.mockResolvedValue(undefined);
    backendMocks.clearDictationDraft.mockResolvedValue(true);
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "Preview C",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "History B" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Use Result" }));
    await waitFor(() => expect(backendMocks.saveDictationDraft).toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
      "Saved A",
    ));

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(await within(dialog).findByText(/Save failed|couldn't save/i)).toBeInTheDocument();
    expect(backendMocks.saveDictationDraft).not.toHaveBeenCalledWith(
      "dictation-1",
      "Preview C",
      "History B",
    );
    expect(backendMocks.clearDictationDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Latest dictation result" })).toHaveValue("Preview C");
  });

  it("saved dictation edit copy preserves exact spacing", async () => {
    backendMocks.getDictationEdit.mockResolvedValue({ text: "  Edited   saved text.\n" });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Copy" })[0]);
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("  Edited   saved text.\n"));
  });

  it("failed saved dictation edit keeps the dialog open with the draft", async () => {
    backendMocks.saveDictationEdit.mockRejectedValue(new Error("Save failed"));
    render(<DictationView />);
    const opener = await screen.findByRole("button", { name: "Open saved dictation: Project update" });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Draft that must remain." } });
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    expect(await within(dialog).findByDisplayValue("Draft that must remain.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Save failed|couldn't save/i)).toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it.each([true, false])("explains audio retry fallback only after AI failure: %s", async (failed) => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue({ audioAvailable: true, pipelineStageKeys: [] } as any);
    backendMocks.reprocessDictation.mockResolvedValue({ recording: createSavedDictation({ id: "redo" }), transcript: null,
      finalText: "Recovered words", rawText: "Recovered words", modePreset: "email", provider: "whisper", modelId: "large-v3-turbo", usedAi: false, aiRewriteFailed: failed });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByRole("button", { name: "Process again" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Process again" }));
    await within(dialog).findByText("Saved as a new dictation");
    const warning = within(dialog).queryByText("AI rewrite wasn't applied. This entry uses the recognized text with local formatting.");
    if (failed) expect(warning).toHaveAttribute("role", "status");
    else expect(warning).not.toBeInTheDocument();
  });

  it("retries with a downloaded model without changing speech settings", async () => {
    const dictation = await import("@/lib/backend/dictation");
    vi.mocked(dictation.getDictationHistoryDetails).mockResolvedValue({ audioAvailable: true, pipelineStageKeys: [] } as any);
    const asr = await import("@/lib/backend/asr");
    vi.mocked(asr.listDownloadedModels).mockResolvedValueOnce([{ name: "ggml-large-v3-turbo.bin", provider: "whisper", path: "/models/whisper/ggml-large-v3-turbo.bin", sizeBytes: 100 }]);
    backendMocks.asrProviders = [{ ...backendMocks.buildAsrProviders()[0], providerType: "whisper", name: "Whisper", isAvailable: false,
      selectedModelId: "base.en", modelOptions: [{ id: "large-v3-turbo", label: "Whisper Turbo" }] }];
    backendMocks.reprocessDictation.mockResolvedValue({ recording: createSavedDictation({ id: "redo" }), transcript: null,
      finalText: "Recovered words", rawText: "Recovered words", modePreset: "voice", provider: "whisper", modelId: "large-v3-turbo", usedAi: false });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByRole("option", { name: "Whisper Large Turbo" });
    fireEvent.change(within(dialog).getByLabelText("Speech model for this retry"), { target: { value: "whisper:large-v3-turbo" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Process again" }));
    await waitFor(() => expect(backendMocks.reprocessDictation).toHaveBeenCalledWith({ historyId: "dictation-1", modeId: "voice", provider: "whisper", modelId: "large-v3-turbo" }));
    expect(backendMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("shows actionable model guidance when Process again cannot start", async () => {
    const dictation = await import("@/lib/backend/dictation");
    backendMocks.getTranscript.mockResolvedValue(null);
    vi.mocked(dictation.getDictationHistoryDetails).mockResolvedValue({
      audioAvailable: true,
      pipelineStageKeys: [],
    } as any);
    backendMocks.reprocessDictation.mockRejectedValue(
      new Error(
        "Error invoking remote method 'sidecar:invoke': Error: Whisper Base (English) isn't ready for process again. Whisper model not downloaded yet. Download a Whisper model in Settings > Models.",
      ),
    );

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const processAgain = await within(dialog).findByRole("button", {
      name: "Process again",
    });

    fireEvent.click(processAgain);

    expect(
      await within(dialog).findByText(
        "Whisper Base (English) isn't ready for process again. Whisper model not downloaded yet. Download a Whisper model in Settings > Models.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/sidecar:invoke/)).not.toBeInTheDocument();
    expect(processAgain).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "Project update" })).toBe(dialog);
    expect(within(dialog).queryByText("Saved as a new dictation")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Copy result" })).not.toBeInTheDocument();
    expect(backendMocks.refetchDictationHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["raw", "Matched what Plainsong heard"],
    ["final", "Matched the original result"],
    ["corrected", "Matched saved corrections"],
  ])(
    "searches saved dictations, marks a %s match, and opens the hit",
    async (matchedField, expectedLabel) => {
      backendMocks.searchDictationHistory.mockResolvedValue([
        {
          recordingId: "dictation-1",
          recordingTitle: "Project update",
          createdAt: "2026-08-01T12:00:00.000Z",
          snippet: "Ship the quarterly [[budget]] summary to finance.",
          matchedField,
          score: -1.2,
        },
      ]);

      render(<DictationView />);
      const field = await screen.findByLabelText("Search saved dictations");
      fireEvent.change(field, { target: { value: "budget" } });

      await waitFor(() => {
        expect(backendMocks.searchDictationHistory).toHaveBeenCalledWith("budget", {
          limit: 25,
        });
      });

      const hit = await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      });
      // The marked run is a real <mark>, not a bracketed literal the reader has
      // to decode, and the row says which side of the entry matched.
      const marked = within(hit).getByText("budget");
      expect(marked.tagName).toBe("MARK");
      expect(hit).not.toHaveTextContent("[[");
      expect(hit).toHaveTextContent(expectedLabel);

      fireEvent.click(hit);
      expect(
        await screen.findByRole("dialog", { name: "Project update" }),
      ).toBeInTheDocument();
    },
  );

  it("opens a search hit that is absent from the cached history list", async () => {
    backendMocks.recordings = [];
    backendMocks.searchDictationHistory.mockResolvedValue([
      {
        recordingId: "dictation-remote",
        recordingTitle: "Remote project update",
        createdAt: "2026-08-02T12:00:00.000Z",
        snippet: "Send the [[budget]] update.",
        matchedField: "final",
        score: -1,
      },
    ]);
    backendMocks.getRecording.mockResolvedValue(
      createSavedDictation({
        id: "dictation-remote",
        title: "Remote project update",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    );

    render(<DictationView />);
    fireEvent.change(await screen.findByLabelText("Search saved dictations"), {
      target: { value: "budget" },
    });
    const opener = await screen.findByRole("button", { name: "Open saved dictation: Remote project update" });
    fireEvent.click(opener);

    expect(backendMocks.getRecording).toHaveBeenCalledWith("dictation-remote");
    const dialog = await screen.findByRole("dialog", { name: "Remote project update" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it.each([
    ["a deleted recording", null],
    [
      "a recording from another source",
      createSavedDictation({ id: "meeting-1", sourceType: "meeting" }),
    ],
  ])("reports %s when opening an uncached search hit", async (_case, recording) => {
    backendMocks.recordings = [];
    backendMocks.searchDictationHistory.mockResolvedValue([
      {
        recordingId: "missing-dictation",
        recordingTitle: "Missing update",
        createdAt: "2026-08-02T12:00:00.000Z",
        snippet: "Missing [[budget]] update.",
        matchedField: "final",
        score: -1,
      },
    ]);
    backendMocks.getRecording.mockResolvedValue(recording);

    render(<DictationView />);
    fireEvent.change(await screen.findByLabelText("Search saved dictations"), {
      target: { value: "budget" },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Missing update",
      }),
    );

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "That saved dictation is no longer available.",
        "error",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a lookup failure when opening an uncached search hit", async () => {
    backendMocks.recordings = [];
    backendMocks.searchDictationHistory.mockResolvedValue([
      {
        recordingId: "unavailable-dictation",
        recordingTitle: "Unavailable update",
        createdAt: "2026-08-02T12:00:00.000Z",
        snippet: "Unavailable [[budget]] update.",
        matchedField: "final",
        score: -1,
      },
    ]);
    backendMocks.getRecording.mockRejectedValue(new Error("database offline"));

    render(<DictationView />);
    fireEvent.change(await screen.findByLabelText("Search saved dictations"), {
      target: { value: "budget" },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Unavailable update",
      }),
    );

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Couldn't open that saved dictation.",
        "error",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores an old lookup after the query changes and a newer hit opens", async () => {
    backendMocks.recordings = [];
    const oldLookup = deferred<Recording | null>();
    backendMocks.searchDictationHistory.mockImplementation(async (query: string) => [
      {
        recordingId: query === "first" ? "dictation-first" : "dictation-second",
        recordingTitle: query === "first" ? "First result" : "Second result",
        createdAt: "2026-08-02T12:00:00.000Z",
        snippet: `Matched [[${query}]].`,
        matchedField: "final",
        score: -1,
      },
    ]);
    backendMocks.getRecording.mockImplementation(async (recordingId: string) => {
      if (recordingId === "dictation-first") return await oldLookup.promise;
      return createSavedDictation({
        id: "dictation-second",
        title: "Second result",
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    });

    render(<DictationView />);
    const field = await screen.findByLabelText("Search saved dictations");
    fireEvent.change(field, { target: { value: "first" } });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: First result",
      }),
    );

    fireEvent.change(field, { target: { value: "second" } });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Second result",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Second result" }),
    ).toBeInTheDocument();

    await act(async () => {
      oldLookup.resolve(
        createSavedDictation({ id: "dictation-first", title: "First result" }),
      );
      await oldLookup.promise;
    });

    expect(screen.getByRole("dialog", { name: "Second result" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "First result" })).not.toBeInTheDocument();
  });

  it("says so plainly when nothing matches, and never fires a request per keystroke", async () => {
    backendMocks.searchDictationHistory.mockResolvedValue([]);

    render(<DictationView />);
    const field = await screen.findByLabelText("Search saved dictations");
    fireEvent.change(field, { target: { value: "b" } });
    fireEvent.change(field, { target: { value: "bu" } });
    fireEvent.change(field, { target: { value: "budgetary" } });

    expect(await screen.findByText(/No saved dictation matches/)).toBeInTheDocument();
    // Debounced: the two abandoned prefixes never reached the sidecar.
    expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(1);
    expect(backendMocks.searchDictationHistory).toHaveBeenCalledWith("budgetary", {
      limit: 25,
    });
  });

  describe("history search request ownership", () => {
    const hit = (title: string, recordingId: string) => ({
      recordingId,
      recordingTitle: title,
      createdAt: "2026-08-02T12:00:00.000Z",
      snippet: `Matched [[${title}]].`,
      matchedField: "final",
      score: -1,
    });

    it("retries the current failed query once and shows the successful result", async () => {
      const retry = deferred<any[]>();
      backendMocks.searchDictationHistory
        .mockRejectedValueOnce(new Error("history index unavailable"))
        .mockReturnValueOnce(retry.promise);
      render(<DictationView />);
      fireEvent.change(await screen.findByLabelText("Search saved dictations"), {
        target: { value: "budget" },
      });

      const retryButton = await screen.findByRole("button", { name: "Retry search" });
      expect(screen.getByText("Search failed: history index unavailable")).toBeInTheDocument();
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(2);
      expect(retryButton).not.toBeInTheDocument();
      expect(screen.getByText("Searching…")).toBeInTheDocument();

      await act(async () => {
        retry.resolve([hit("Recovered result", "dictation-recovered")]);
        await retry.promise;
      });
      expect(
        await screen.findByRole("button", {
          name: "Open saved dictation: Recovered result",
        }),
      ).toBeInTheDocument();
    });

    it("clears an old failure immediately when the query changes", async () => {
      const nextSearch = deferred<any[]>();
      backendMocks.searchDictationHistory
        .mockRejectedValueOnce(new Error("old query failed"))
        .mockReturnValueOnce(nextSearch.promise);
      render(<DictationView />);
      const field = await screen.findByLabelText("Search saved dictations");
      fireEvent.change(field, { target: { value: "first query" } });
      expect(await screen.findByText("Search failed: old query failed")).toBeInTheDocument();

      fireEvent.change(field, { target: { value: "second query" } });
      expect(screen.queryByText("Search failed: old query failed")).not.toBeInTheDocument();
      expect(screen.getByText("Searching…")).toBeInTheDocument();
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(2));
      await act(async () => {
        nextSearch.resolve([]);
        await nextSearch.promise;
      });
    });

    it("suppresses stale A-B-A successes and failures", async () => {
      const firstA = deferred<any[]>();
      const queryB = deferred<any[]>();
      const secondA = deferred<any[]>();
      backendMocks.searchDictationHistory
        .mockReturnValueOnce(firstA.promise)
        .mockReturnValueOnce(queryB.promise)
        .mockReturnValueOnce(secondA.promise);
      render(<DictationView />);
      const field = await screen.findByLabelText("Search saved dictations");

      fireEvent.change(field, { target: { value: "alpha" } });
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(1));
      fireEvent.change(field, { target: { value: "beta" } });
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(2));
      fireEvent.change(field, { target: { value: "alpha" } });
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(3));
      expect(backendMocks.searchDictationHistory.mock.calls.map(([query]) => query)).toEqual([
        "alpha",
        "beta",
        "alpha",
      ]);

      await act(async () => {
        firstA.resolve([hit("Stale alpha", "dictation-stale")]);
        queryB.reject(new Error("stale beta failure"));
        await Promise.allSettled([firstA.promise, queryB.promise]);
      });
      expect(screen.queryByText("Stale alpha")).not.toBeInTheDocument();
      expect(screen.queryByText(/stale beta failure/)).not.toBeInTheDocument();

      await act(async () => {
        secondA.resolve([hit("Current alpha", "dictation-current")]);
        await secondA.promise;
      });
      expect(
        await screen.findByRole("button", { name: "Open saved dictation: Current alpha" }),
      ).toBeInTheDocument();
    });

    it("clears results and stops search UI when the query is cleared", async () => {
      backendMocks.searchDictationHistory.mockResolvedValueOnce([
        hit("Budget result", "dictation-budget"),
      ]);
      render(<DictationView />);
      const field = await screen.findByLabelText("Search saved dictations");
      fireEvent.change(field, { target: { value: "budget" } });
      expect(
        await screen.findByRole("button", { name: "Open saved dictation: Budget result" }),
      ).toBeInTheDocument();

      fireEvent.change(field, { target: { value: "" } });
      expect(screen.queryByRole("button", { name: "Open saved dictation: Budget result" })).not.toBeInTheDocument();
      expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
      expect(screen.queryByText(/Search failed:/)).not.toBeInTheDocument();
    });

    it("suppresses an older result after history refreshes", async () => {
      const oldSearch = deferred<any[]>();
      const refreshedSearch = deferred<any[]>();
      backendMocks.searchDictationHistory
        .mockReturnValueOnce(oldSearch.promise)
        .mockReturnValueOnce(refreshedSearch.promise);
      const view = render(<DictationView />);
      fireEvent.change(await screen.findByLabelText("Search saved dictations"), {
        target: { value: "budget" },
      });
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(1));

      backendMocks.recordings = [
        ...backendMocks.recordings,
        createSavedDictation({ id: "dictation-new", title: "New capture" }),
      ];
      view.rerender(<DictationView />);
      await waitFor(() => expect(backendMocks.searchDictationHistory).toHaveBeenCalledTimes(2));
      expect(backendMocks.searchDictationHistory.mock.calls.map(([query]) => query)).toEqual([
        "budget",
        "budget",
      ]);
      await act(async () => {
        oldSearch.resolve([hit("Stale before refresh", "dictation-stale")]);
        await oldSearch.promise;
      });
      expect(screen.queryByText("Stale before refresh")).not.toBeInTheDocument();

      await act(async () => {
        refreshedSearch.resolve([]);
        await refreshedSearch.promise;
      });
      expect(await screen.findByText(/No saved dictation matches/)).toBeInTheDocument();
    });
  });

  it("runs a saved dictation's kept audio again and shows what it saved", async () => {
    const backend = await import("@/lib/backend/dictation");
    (backend.getDictationHistoryDetails as any).mockResolvedValue({
      modePreset: "voice",
      modeLabel: "Voice",
      baseModePreset: "voice",
      baseModeLabel: "Voice",
      customModeId: null,
      customModeName: null,
      contextSource: null,
      contextAppName: null,
      appTarget: "Slack",
      activationMatcher: null,
      commandApplied: null,
      dictionaryAppliedCount: 0,
      snippetAppliedCount: 0,
      formattingApplied: false,
      recentInsertReused: false,
      pipelineStageKeys: [],
      promptSource: null,
      promptPreview: null,
      requestedProvider: "parakeet",
      actualProvider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      routePreference: "local",
      resolvedHosting: "local",
      startupLatencyMs: 320,
      transcriptionLatencyMs: 900,
      insertLatencyMs: 40,
      endToEndMs: 1300,
      audioAvailable: true,
    });
    backendMocks.reprocessDictation.mockResolvedValue({
      recording: createSavedDictation({ id: "dictation-2", title: "Redo" }),
      transcript: null,
      finalText: "- Ship the quarterly budget summary",
      rawText: "ship the quarterly budget summary",
      modePreset: "notes",
      customModeId: null,
      customModeName: null,
      provider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      usedAi: false,
      reprocessedFromId: "dictation-1",
      reprocessedFromCreatedAt: "2026-08-01T12:00:00.000Z",
      transcriptionLatencyMs: 780,
    });

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Project update" });

    fireEvent.change(
      await within(dialog).findByLabelText("Style for the new entry"),
      { target: { value: "notes" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Process again" }),
    );

    await waitFor(() => {
      expect(backendMocks.reprocessDictation).toHaveBeenCalledWith({
        historyId: "dictation-1",
        modeId: "notes",
      });
    });

    expect(
      await within(dialog).findByText("- Ship the quarterly budget summary"),
    ).toBeInTheDocument();
    // The new entry is a saved dictation, not something pasted anywhere.
    expect(within(dialog).getByText("Saved as a new dictation")).toBeInTheDocument();
    // And the list is reloaded so the new entry is actually visible.
    expect(backendMocks.refetchDictationHistory).toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy result" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        "- Ship the quarterly budget summary",
      );
    });
  });

  it("ignores a late text reprocess result after another dictation opens", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue(null);
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Ship the quarterly budget summary to finance."
          : "Send the customer a revised timeline.",
      ),
    );
    const oldReprocess = deferred<{
      modePreset: string;
      outputText: string;
      usedAi: boolean;
      provider: string | null;
      modelId: string | null;
    }>();
    backendMocks.reprocessDictationText.mockReturnValueOnce(oldReprocess.promise);

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    await within(firstDialog).findByDisplayValue(
      "Ship the quarterly budget summary to finance.",
    );
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Reprocess" }),
    );

    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    await within(secondDialog).findByDisplayValue(
      "Send the customer a revised timeline.",
    );

    await act(async () => {
      oldReprocess.resolve({
        modePreset: "email",
        outputText: "Stale quarterly budget preview",
        usedAi: true,
        provider: "ollama",
        modelId: "qwen3.5:4b",
      });
      await oldReprocess.promise;
    });

    expect(
      within(secondDialog).queryByText("Stale quarterly budget preview"),
    ).not.toBeInTheDocument();
    expect(
      within(secondDialog).queryByRole("button", { name: "Use Result" }),
    ).not.toBeInTheDocument();
  });

  describe("process again ownership", () => {
    const outcome = (id: string, text: string): DictationReprocessOutcome => ({
      recording: createSavedDictation({ id, title: `${text} entry` }),
      transcript: createSavedTranscript(id, text),
      finalText: text,
      rawText: text.toLowerCase(),
      modePreset: "voice",
      customModeId: null,
      customModeName: null,
      provider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      usedAi: false,
      reprocessedFromId: "dictation-1",
      reprocessedFromCreatedAt: "2026-08-01T12:00:00.000Z",
      transcriptionLatencyMs: 780,
    });

    beforeEach(() => {
      backendMocks.reprocessDictation.mockReset().mockResolvedValue(
        outcome("redo-default", "Recovered words"),
      );
      backendMocks.refetchDictationHistory.mockReset().mockResolvedValue(undefined);
      backendMocks.getDictationHistoryDetails.mockResolvedValue({
        audioAvailable: true,
        pipelineStageKeys: [],
      } as any);
    });

    const openProjectUpdate = async () => {
      fireEvent.click(await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }));
      const dialog = await screen.findByRole("dialog", { name: "Project update" });
      await within(dialog).findByRole("button", { name: "Process again" });
      return dialog;
    };

    const configureSecondDictation = () => {
      backendMocks.recordings = [
        createSavedDictation(),
        createSavedDictation({
          id: "dictation-2",
          title: "Customer follow-up",
          createdAt: "2026-08-02T12:00:00.000Z",
        }),
      ];
      backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
        createSavedTranscript(
          recordingId,
          recordingId === "dictation-1"
            ? "Ship the quarterly budget summary to finance."
            : "Send the customer a revised timeline.",
        ),
      );
    };

    it("blocks duplicate work across dialog close and reopen", async () => {
      const process = deferred<DictationReprocessOutcome>();
      backendMocks.reprocessDictation.mockReturnValueOnce(process.promise);
      render(<DictationView />);
      let dialog = await openProjectUpdate();
      const button = within(dialog).getByRole("button", { name: "Process again" });

      fireEvent.click(button);
      fireEvent.click(button);
      expect(backendMocks.reprocessDictation).toHaveBeenCalledTimes(1);
      expect(within(dialog).getByLabelText("Style for the new entry")).toBeDisabled();
      expect(within(dialog).getByLabelText("Speech model for this retry")).toBeDisabled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());
      fireEvent.click(await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }));
      dialog = await screen.findByRole("dialog", { name: "Project update" });
      expect(within(dialog).getByRole("button", { name: "Processing again…" })).toBeDisabled();
      expect(backendMocks.reprocessDictation).toHaveBeenCalledTimes(1);

      await act(async () => process.resolve(outcome("redo-a", "Recovered A")));
      expect(await within(dialog).findByRole("button", { name: "Process again" })).toBeEnabled();
      expect(within(dialog).queryByText("Recovered A")).not.toBeInTheDocument();
    });

    it("blocks meeting B until meeting A's job settles", async () => {
      configureSecondDictation();
      const first = deferred<DictationReprocessOutcome>();
      backendMocks.reprocessDictation
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(outcome("redo-b", "Recovered B"));
      render(<DictationView />);
      const firstDialog = await openProjectUpdate();
      fireEvent.click(within(firstDialog).getByRole("button", { name: "Process again" }));
      fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }));
      const secondDialog = await screen.findByRole("dialog", { name: "Customer follow-up" });
      expect(await within(secondDialog).findByText(
        "Process again is still running for Project update.",
      )).toBeInTheDocument();
      expect(within(secondDialog).getByRole("button", { name: "Another retry is running…" })).toBeDisabled();

      await act(async () => first.resolve(outcome("redo-a", "Recovered A")));
      const retryB = await within(secondDialog).findByRole("button", { name: "Process again" });
      fireEvent.click(retryB);
      await waitFor(() => expect(backendMocks.reprocessDictation).toHaveBeenLastCalledWith({
        historyId: "dictation-2",
        modeId: "voice",
      }));
    });

    it("unlocks retry after processing failure", async () => {
      backendMocks.reprocessDictation
        .mockRejectedValueOnce(new Error("Recognizer unavailable"))
        .mockResolvedValueOnce(outcome("redo-retry", "Recovered on retry"));
      render(<DictationView />);
      const dialog = await openProjectUpdate();
      fireEvent.click(within(dialog).getByRole("button", { name: "Process again" }));

      expect(await within(dialog).findByText("Recognizer unavailable")).toBeInTheDocument();
      const retry = within(dialog).getByRole("button", { name: "Process again" });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);

      expect(await within(dialog).findByText("Recovered on retry")).toBeInTheDocument();
      expect(backendMocks.reprocessDictation).toHaveBeenCalledTimes(2);
    });

    it("preserves the saved new entry when history refresh rejects", async () => {
      backendMocks.reprocessDictation.mockResolvedValueOnce(
        outcome("redo-refresh", "Saved despite refresh failure"),
      );
      backendMocks.refetchDictationHistory.mockImplementationOnce(async () => {
        backendMocks.recordingsError = "History could not reload. Cached dictations are still shown.";
        throw new Error("History refresh failed");
      });
      render(<DictationView />);
      const dialog = await openProjectUpdate();
      fireEvent.click(within(dialog).getByRole("button", { name: "Process again" }));

      expect(await within(dialog).findByText("Saved despite refresh failure")).toBeInTheDocument();
      expect(within(dialog).getByText("Saved as a new dictation")).toBeInTheDocument();
      expect(within(dialog).getByText(
        "The new entry was saved, but history could not refresh. Reload Dictation to update the list.",
      )).toHaveAttribute("role", "status");
      expect(within(dialog).queryByText(/processing failed/i)).not.toBeInTheDocument();
      expect(backendMocks.reprocessDictation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "History could not reload. Cached dictations are still shown.",
      );
      fireEvent.click(within(screen.getByRole("alert")).getByRole("button", {
        name: "Retry history",
      }));
      await waitFor(() => expect(backendMocks.refetchDictationHistory).toHaveBeenCalledTimes(2));
    });

    it("does not describe a failed initial history load as empty history", async () => {
      backendMocks.recordings = [];
      backendMocks.recordingsError = "Could not load history";
      render(<DictationView />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Could not load history");
      expect(within(alert).getByRole("button", { name: "Retry history" })).toBeEnabled();
      expect(screen.queryByText(/No dictations yet/)).not.toBeInTheDocument();
    });

    it("hides meeting A's late successful outcome from meeting B", async () => {
      configureSecondDictation();
      const first = deferred<DictationReprocessOutcome>();
      backendMocks.reprocessDictation.mockReturnValueOnce(first.promise);
      render(<DictationView />);
      const firstDialog = await openProjectUpdate();
      fireEvent.click(within(firstDialog).getByRole("button", { name: "Process again" }));
      fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project update" })).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }));
      const secondDialog = await screen.findByRole("dialog", { name: "Customer follow-up" });

      await act(async () => first.resolve(outcome("redo-stale", "Stale saved result")));

      await waitFor(() => expect(backendMocks.refetchDictationHistory).toHaveBeenCalledTimes(1));
      expect(within(secondDialog).queryByText("Stale saved result")).not.toBeInTheDocument();
      expect(within(secondDialog).queryByText("Saved as a new dictation")).not.toBeInTheDocument();
    });
  });

  it("hides a late Process again result after another dictation opens but refreshes history", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue({
      modePreset: "voice",
      modeLabel: "Voice",
      baseModePreset: "voice",
      baseModeLabel: "Voice",
      customModeId: null,
      customModeName: null,
      contextSource: null,
      contextAppName: null,
      appTarget: null,
      activationMatcher: null,
      commandApplied: null,
      dictionaryAppliedCount: 0,
      snippetAppliedCount: 0,
      formattingApplied: false,
      recentInsertReused: false,
      pipelineStageKeys: [],
      promptSource: null,
      promptPreview: null,
      requestedProvider: "parakeet",
      actualProvider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      routePreference: "local",
      resolvedHosting: "local",
      startupLatencyMs: 320,
      transcriptionLatencyMs: 900,
      insertLatencyMs: 40,
      endToEndMs: 1300,
      audioAvailable: true,
    });
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Ship the quarterly budget summary to finance."
          : "Send the customer a revised timeline.",
      ),
    );
    const oldProcessAgain = deferred<DictationReprocessOutcome>();
    backendMocks.reprocessDictation.mockReturnValueOnce(oldProcessAgain.promise);

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    await within(firstDialog).findByDisplayValue(
      "Ship the quarterly budget summary to finance.",
    );
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Process again" }),
    );

    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    await within(secondDialog).findByDisplayValue(
      "Send the customer a revised timeline.",
    );

    await act(async () => {
      oldProcessAgain.resolve({
        recording: createSavedDictation({
          id: "dictation-3",
          title: "Old redo",
        }),
        transcript: createSavedTranscript(
          "dictation-3",
          "Stale saved audio result",
        ),
        finalText: "Stale saved audio result",
        rawText: "stale saved audio result",
        modePreset: "voice",
        customModeId: null,
        customModeName: null,
        provider: "parakeet",
        modelId: "parakeet-tdt-0.6b-v3",
        usedAi: false,
        reprocessedFromId: "dictation-1",
        reprocessedFromCreatedAt: "2026-08-01T12:00:00.000Z",
        transcriptionLatencyMs: 780,
      });
      await oldProcessAgain.promise;
    });

    await waitFor(() => {
      expect(backendMocks.refetchDictationHistory).toHaveBeenCalledTimes(1);
    });
    expect(
      within(secondDialog).queryByText("Stale saved audio result"),
    ).not.toBeInTheDocument();
    expect(
      within(secondDialog).queryByText("Saved as a new dictation"),
    ).not.toBeInTheDocument();
  });

  it.each([true, false])("reports unchanged style output without implying edits: AI=%s", async (usedAi) => {
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email", outputText: "Ship the quarterly budget summary to finance.",
      usedAi, aiRewriteFailed: false, provider: usedAi ? "ollama" : null,
      modelId: usedAi ? "qwen3.5:9b" : null,
    });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByDisplayValue("Ship the quarterly budget summary to finance.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    expect(await within(dialog).findByText("No changes")).toBeInTheDocument();
    expect(within(dialog).getByText(usedAi ? "AI returned your text without changes." : "This style left your text unchanged.")).toHaveAttribute("role", "status");
    expect(within(dialog).getByRole("button", { name: "Use Result" })).toBeDisabled();
    expect(within(dialog).queryByText(/AI tuned/)).not.toBeInTheDocument();
  });

  it.each([
    ["null result", null],
    ["non-object result", 17],
    ["non-string output", { modePreset: "email", outputText: 17 }],
    ["non-string mode", { outputText: "Preview text", modePreset: 17 }],
    ["empty output", { modePreset: "email", outputText: "" }],
    ["whitespace-only output", { modePreset: "email", outputText: " \n\t" }],
  ])("rejects %s and allows a valid style preview retry", async (_case, invalidResult) => {
    backendMocks.reprocessDictationText
      .mockResolvedValueOnce(invalidResult)
      .mockResolvedValueOnce({
        modePreset: "email",
        outputText: "Valid quarterly budget preview",
        usedAi: true,
        provider: "ollama",
        modelId: "qwen3.5:4b",
      });

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: {
          recordingId: "recording-latest",
          text: "Latest draft must remain.",
        },
      });
    });
    const latestEditor = screen.getByRole("textbox", {
      name: "Latest dictation result",
    });

    fireEvent.click(screen.getByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const savedEditor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(savedEditor, {
      target: { value: "Saved history draft must remain." },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    expect(await within(dialog).findByText(
      "Couldn't create a style preview. Your text is unchanged.",
    )).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Use Result" })).not.toBeInTheDocument();
    expect(savedEditor).toHaveValue("Saved history draft must remain.");
    expect(latestEditor).toHaveValue("Latest draft must remain.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    expect(await within(dialog).findByText("Valid quarterly budget preview")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Use Result" })).toBeEnabled();
    expect(within(dialog).queryByText(
      "Couldn't create a style preview. Your text is unchanged.",
    )).not.toBeInTheDocument();
    expect(savedEditor).toHaveValue("Saved history draft must remain.");
    expect(latestEditor).toHaveValue("Latest draft must remain.");
    expect(backendMocks.saveDictationEdit).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it.each([true, false])("distinguishes failed AI rewrites from local formatting: %s", async (failed) => {
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email", outputText: "Ship the quarterly budget summary to finance.",
      usedAi: false, aiRewriteFailed: failed, provider: null, modelId: null,
    });
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByDisplayValue("Ship the quarterly budget summary to finance.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Use Result" })).toBeDisabled());
    const message = within(dialog).queryByText("AI rewrite wasn't applied. Basic formatting is shown instead.");
    if (failed) expect(message).toHaveAttribute("role", "status");
    else expect(message).not.toBeInTheDocument();
  });

  it("distinguishes saved text from the recognizer output", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue({
      audioAvailable: false, pipelineStageKeys: [], rawTranscript: "ship ship the quarterly budget summary to finance",
    } as any);
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open saved dictation: Project update" }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    expect(await within(dialog).findByLabelText("Saved result")).toHaveValue("Ship the quarterly budget summary to finance.");
    expect(within(dialog).getByText("Show recognizer output").closest("details")).not.toHaveAttribute("open");
    expect(within(dialog).getByLabelText("Raw recognition")).toHaveTextContent("ship ship the quarterly budget summary to finance");
  });

  it("clears a completed text preview when another style is chosen", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue(null);
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "Quarterly budget email preview",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByDisplayValue(
      "Ship the quarterly budget summary to finance.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    expect(
      await within(dialog).findByText("Quarterly budget email preview"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Use Result" }),
    ).toBeEnabled();
    expect(within(dialog).getByText("Style preview")).toBeInTheDocument();
    expect(within(dialog).queryByText("No changes")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/AI edited/)).toBeInTheDocument();


    fireEvent.change(within(dialog).getByLabelText("Try another style"), {
      target: { value: "notes" },
    });

    expect(
      within(dialog).queryByText("Quarterly budget email preview"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Use Result" }),
    ).not.toBeInTheDocument();
  });

  it("reprocesses the current correction without changing the stored transcript", async () => {
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "Please email John tomorrow.",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });
    backendMocks.getTranscript.mockResolvedValue(
      createSavedTranscript("dictation-1", "Please email Jon tomorrow."),
    );

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");
    fireEvent.change(editor, { target: { value: "Please email John tomorrow." } });
    fireEvent.change(within(dialog).getByLabelText("Try another style"), {
      target: { value: "email" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    await waitFor(() => {
      expect(backendMocks.reprocessDictationText).toHaveBeenCalledWith(
        "Please email John tomorrow.",
        "email",
        null,
        {
          runId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        },
      );
    });
    expect(await within(dialog).findByText("No changes")).toBeInTheDocument();
    expect(within(dialog).getByText("AI returned your text without changes.")).toHaveAttribute("role", "status");
    expect(editor).toHaveValue("Please email John tomorrow.");
    expect((await backendMocks.getTranscript.mock.results[0].value).fullText).toBe(
      "Please email Jon tomorrow.",
    );
  });

  it("uses an adopted style preview as the latest correction baseline", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    backendMocks.getDictationHistoryDetails.mockResolvedValue(null);
    backendMocks.reprocessDictationText.mockResolvedValue({
      modePreset: "email",
      outputText: "please email sara tomorrow",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen3.5:4b",
    });

    render(<DictationView />);
    await screen.findByRole("tab", { name: "Profiles" });
    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: {
          text: "please email jon tomorrow",
          actualProvider: "distil_whisper",
          pasted: true,
          copied: false,
          insertionModeUsed: "auto",
          appTarget: "TextEdit",
          finalTranscriptLatencyMs: 300,
          timing: {
            asrCompleteMs: 300,
            formatCompleteMs: 360,
            insertionConfirmed: true,
            insertionConfirmedMs: 110,
          },
        },
      });
    });
    expect(
      await screen.findByText("Last dictation: inserted cleanly"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("latest-dictation-details")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    await within(dialog).findByDisplayValue(
      "Ship the quarterly budget summary to finance.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    expect(
      await within(dialog).findByText("please email sara tomorrow"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use Result" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument(),
    );

    const currentEditor = screen.getByDisplayValue("please email sara tomorrow");
    expect(
      screen.getByText(
        "A style preview. Save or copy it when you are ready to use it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Copy this text, or save it and choose "Use for Paste last result" before switching apps.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Last dictation: inserted cleanly"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("latest-dictation-details"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    fireEvent.change(currentEditor, {
      target: { value: "please email Sarah tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenLastCalledWith({
        originalText: "please email sara tomorrow",
        correctedText: "please email Sarah tomorrow",
        appTarget: null,
        force: true,
      }),
    );

    await act(async () => {
      backendMocks.eventListeners.get("dictation-text-ready")?.({
        payload: {
          text: "please email maya tomorrow",
          actualProvider: "distil_whisper",
          pasted: true,
          copied: false,
          insertionModeUsed: "auto",
          appTarget: "TextEdit",
          finalTranscriptLatencyMs: 280,
          timing: {
            asrCompleteMs: 280,
            formatCompleteMs: 340,
            insertionConfirmed: true,
            insertionConfirmedMs: 90,
          },
        },
      });
    });

    expect(
      screen.getByText("Your last dictation."),
    ).toBeInTheDocument();
    expect(screen.getByText(/To put this into another app/)).toBeInTheDocument();
    expect(
      screen.getByText("Last dictation: inserted cleanly"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("latest-dictation-details")).toBeInTheDocument();
  });

  it("clears a completed style preview and error when the editor changes", async () => {
    backendMocks.reprocessDictationText
      .mockResolvedValueOnce({
        modePreset: "email",
        outputText: "Quarterly budget email preview",
        usedAi: true,
        provider: "ollama",
        modelId: "qwen3.5:4b",
      })
      .mockRejectedValueOnce(new Error("Rewrite unavailable"));

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    const editor = await within(dialog).findByLabelText("Saved result");

    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    expect(await within(dialog).findByText("Quarterly budget email preview")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "Corrected budget text." } });
    expect(within(dialog).queryByText("Quarterly budget email preview")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Use Result" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    expect(await within(dialog).findByText("Rewrite unavailable")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "Another corrected budget text." } });
    expect(within(dialog).queryByText("Rewrite unavailable")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "does not show a stale pending reprocess %s after an A to B to A edit",
    async (completion) => {
      const pending = deferred<any>();
      backendMocks.reprocessDictationText.mockReturnValueOnce(pending.promise);

      render(<DictationView />);
      fireEvent.click(await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }));
      const dialog = await screen.findByRole("dialog", { name: "Project update" });
      const editor = await within(dialog).findByLabelText("Saved result");
      const original = "Ship the quarterly budget summary to finance.";

      fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
      expect(within(dialog).getByRole("button", { name: "Reprocessing…" })).toBeDisabled();
      fireEvent.change(editor, { target: { value: "Temporary edit." } });
      fireEvent.change(editor, { target: { value: original } });
      expect(within(dialog).getByRole("button", { name: "Reprocessing…" })).toBeDisabled();

      await act(async () => {
        if (completion === "resolve") {
          pending.resolve({
            modePreset: "email",
            outputText: "Stale style preview",
            usedAi: true,
            provider: "ollama",
            modelId: "qwen3.5:4b",
          });
          await pending.promise;
        } else {
          pending.reject(new Error("Stale rewrite error"));
          try {
            await pending.promise;
          } catch {
            // The component handles the rejected request.
          }
        }
      });

      await waitFor(() => {
        expect(within(dialog).getByRole("button", { name: "Reprocess" })).toBeEnabled();
      });
      expect(within(dialog).queryByText("Stale style preview")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Stale rewrite error")).not.toBeInTheDocument();
    },
  );

  it("cancels a pending style preview once and ignores its late result", async () => {
    const pending = deferred<any>();
    backendMocks.reprocessDictationText.mockReturnValueOnce(pending.promise);

    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    await within(dialog).findByLabelText("Saved result");

    fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    await waitFor(() => {
      expect(backendMocks.reprocessDictationText).toHaveBeenCalledOnce();
    });
    const options = backendMocks.reprocessDictationText.mock.calls[0]?.[3];
    expect(options?.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel preview" }),
    );
    const cancelling = within(dialog).getByRole("button", {
      name: "Cancelling…",
    });
    expect(cancelling).toBeDisabled();
    fireEvent.click(cancelling);
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledOnce();
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledWith(options?.runId);
    expect(
      within(dialog).getByRole("button", { name: "Reprocessing…" }),
    ).toBeDisabled();

    await act(async () => {
      pending.resolve({
        modePreset: "email",
        outputText: "Late cancelled preview",
        usedAi: true,
        provider: "ollama",
        modelId: "qwen3.5:4b",
      });
      await pending.promise;
    });

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Reprocess" })).toBeEnabled();
    });
    expect(within(dialog).queryByText("Late cancelled preview")).not.toBeInTheDocument();
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledOnce();
  });

  it("does not call the backend for whitespace-only editable text", async () => {
    render(<DictationView />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Open saved dictation: Project update",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Project update" });
    fireEvent.change(await within(dialog).findByLabelText("Saved result"), {
      target: { value: "  \n\t" },
    });

    const reprocess = within(dialog).getByRole("button", { name: "Reprocess" });
    expect(reprocess).toBeDisabled();
    fireEvent.click(reprocess);
    expect(backendMocks.reprocessDictationText).not.toHaveBeenCalled();
  });

  it("ignores a late transcript load from an earlier history selection", async () => {
    const backend = await import("@/lib/backend/dictation");
    vi.mocked(backend.getDictationHistoryDetails).mockResolvedValue(null);
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    const oldTranscript = deferred<ReturnType<typeof createSavedTranscript>>();
    backendMocks.getTranscript.mockImplementation((recordingId: string) =>
      recordingId === "dictation-1"
        ? oldTranscript.promise
        : Promise.resolve(
            createSavedTranscript(
              "dictation-2",
              "Send the customer a revised timeline.",
            ),
          ),
    );

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    const currentTranscript = await within(secondDialog).findByLabelText(
      "Saved result",
    );
    expect(currentTranscript).toHaveValue(
      "Send the customer a revised timeline.",
    );

    await act(async () => {
      oldTranscript.resolve(
        createSavedTranscript(
          "dictation-1",
          "Ship the quarterly budget summary to finance.",
        ),
      );
      await oldTranscript.promise;
    });

    expect(currentTranscript).toHaveValue(
      "Send the customer a revised timeline.",
    );
    expect(secondDialog).not.toHaveTextContent(
      "Ship the quarterly budget summary to finance.",
    );
  });

  it("ignores a late history correction success after another dictation opens", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Please email jon tomorrow."
          : "Send the customer a revised timeline.",
      ),
    );
    const lateLearn = deferred<
      Awaited<ReturnType<typeof dictationBackend.learnDictationCorrection>>
    >();
    vi.mocked(dictationBackend.learnDictationCorrection).mockReturnValueOnce(
      lateLearn.promise,
    );

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    const firstEditor = await within(firstDialog).findByLabelText("Saved result");
    fireEvent.change(firstEditor, {
      target: { value: "Please email John tomorrow." },
    });
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Learn correction" }),
    );
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    const secondEditor = await within(secondDialog).findByLabelText("Saved result");
    expect(secondEditor).toHaveValue("Send the customer a revised timeline.");
    expect(
      within(secondDialog).getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    await act(async () => {
      lateLearn.resolve({
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
          createdAt: "2026-08-01T12:01:00.000Z",
          updatedAt: "2026-08-01T12:01:00.000Z",
        },
      });
      await lateLearn.promise;
    });

    expect(secondDialog).not.toHaveTextContent("Learned: jon → John");
    expect(
      within(secondDialog).getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();

    fireEvent.change(secondEditor, {
      target: { value: "Send the customer a revised timeline tomorrow." },
    });
    fireEvent.click(
      within(secondDialog).getByRole("button", { name: "Learn correction" }),
    );
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenLastCalledWith({
        originalText: "Send the customer a revised timeline.",
        correctedText: "Send the customer a revised timeline tomorrow.",
        appTarget: null,
        force: true,
      }),
    );
  });

  it("ignores a late history correction failure after another dictation opens", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Please email jon tomorrow."
          : "Send the customer a revised timeline.",
      ),
    );
    const lateLearn = deferred<
      Awaited<ReturnType<typeof dictationBackend.learnDictationCorrection>>
    >();
    vi.mocked(dictationBackend.learnDictationCorrection).mockReturnValueOnce(
      lateLearn.promise,
    );

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    fireEvent.change(await within(firstDialog).findByLabelText("Saved result"), {
      target: { value: "Please email John tomorrow." },
    });
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Learn correction" }),
    );
    await waitFor(() =>
      expect(dictationBackend.learnDictationCorrection).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    await within(secondDialog).findByDisplayValue(
      "Send the customer a revised timeline.",
    );

    await act(async () => {
      lateLearn.reject(new Error("A correction failed"));
      try {
        await lateLearn.promise;
      } catch {
        // The component converts the rejected request into status text.
      }
    });

    expect(secondDialog).not.toHaveTextContent("A correction failed");
    expect(
      within(secondDialog).getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();
  });

  it("ignores a late automatic history correction status after another dictation opens", async () => {
    const dictationBackend = await import("@/lib/backend/dictation");
    backendMocks.recordings = [
      createSavedDictation(),
      createSavedDictation({
        id: "dictation-2",
        title: "Customer follow-up",
        createdAt: "2026-08-02T12:00:00.000Z",
      }),
    ];
    backendMocks.getTranscript.mockImplementation(async (recordingId: string) =>
      createSavedTranscript(
        recordingId,
        recordingId === "dictation-1"
          ? "Please email jon tomorrow."
          : "Send the customer a revised timeline.",
      ),
    );
    const lateQueue = deferred<
      Awaited<ReturnType<typeof dictationBackend.queueDictationCorrectionSuggestion>>
    >();
    vi.mocked(
      dictationBackend.queueDictationCorrectionSuggestion,
    ).mockReturnValueOnce(lateQueue.promise);

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const firstDialog = await screen.findByRole("dialog", {
      name: "Project update",
    });
    const firstEditor = await within(firstDialog).findByLabelText("Saved result");
    fireEvent.change(firstEditor, {
      target: { value: "Please email John tomorrow." },
    });
    fireEvent.blur(firstEditor);
    await waitFor(() =>
      expect(
        dictationBackend.queueDictationCorrectionSuggestion,
      ).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Project update" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open saved dictation: Customer follow-up",
      }),
    );
    const secondDialog = await screen.findByRole("dialog", {
      name: "Customer follow-up",
    });
    await within(secondDialog).findByDisplayValue(
      "Send the customer a revised timeline.",
    );

    await act(async () => {
      lateQueue.resolve({
        queued: true,
        action: "created",
        spokenForm: "jon",
        replacement: "John",
        suggestion: {
          id: "suggestion-1",
          originalText: "Please email jon tomorrow.",
          correctedText: "Please email John tomorrow.",
          spokenForm: "jon",
          replacement: "John",
          appTarget: null,
          createdAt: "2026-08-01T12:01:00.000Z",
          updatedAt: "2026-08-01T12:01:00.000Z",
        },
      });
      await lateQueue.promise;
    });

    expect(secondDialog).not.toHaveTextContent(
      "Queued for review: jon → John",
    );
    expect(
      within(secondDialog).getByRole("button", { name: "Learn correction" }),
    ).toBeDisabled();
  });

  it("names the setting instead of offering a button when no audio was kept", async () => {
    const backend = await import("@/lib/backend/dictation");
    (backend.getDictationHistoryDetails as any).mockResolvedValue({
      modePreset: "voice",
      modeLabel: "Voice",
      baseModePreset: "voice",
      baseModeLabel: "Voice",
      customModeId: null,
      customModeName: null,
      contextSource: null,
      contextAppName: null,
      appTarget: null,
      activationMatcher: null,
      commandApplied: null,
      dictionaryAppliedCount: 0,
      snippetAppliedCount: 0,
      formattingApplied: false,
      recentInsertReused: false,
      pipelineStageKeys: [],
      promptSource: null,
      promptPreview: null,
      requestedProvider: "parakeet",
      actualProvider: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
      routePreference: "local",
      resolvedHosting: "local",
      startupLatencyMs: null,
      transcriptionLatencyMs: null,
      insertLatencyMs: null,
      endToEndMs: null,
      audioAvailable: null,
    });

    render(<DictationView />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved dictation: Project update",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Project update" });

    expect(
      await within(dialog).findByText(/Keep dictation audio for Process again/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Process again" }),
    ).not.toBeInTheDocument();
    expect(backendMocks.reprocessDictation).not.toHaveBeenCalled();
  });

  describe("dictation source context", () => {
    async function emitTextReady(payload: Record<string, unknown>) {
      await act(async () => {
        backendMocks.eventListeners.get("dictation-text-ready")?.({ payload });
      });
    }

    async function emitPreparing(payload: Record<string, unknown>) {
      await act(async () => {
        backendMocks.eventListeners.get("dictation-state-changed")?.({
          payload: { phase: "preparing", ...payload },
        });
      });
    }

    async function emitDone(payload: Record<string, unknown>) {
      await act(async () => {
        backendMocks.eventListeners.get("dictation-state-changed")?.({
          payload: { phase: "done", ...payload },
        });
      });
    }

    async function previewLatestStyle() {
      fireEvent.click(screen.getByText("Try another style"));
      fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
      await waitFor(() =>
        expect(backendMocks.reprocessDictationText).toHaveBeenCalled(),
      );
    }

    it("keeps receipt metadata with capture A while live context prepares capture B", async () => {
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });

      await emitTextReady({
        recordingId: "recording-a",
        text: "Capture A",
        actualProvider: "provider-a",
        modelId: "model-a",
        providerModelLabel: "Engine A",
        appTarget: "Mail",
        activationMatcher: "mail-rule-a",
        contextChars: 17,
      });
      await emitPreparing({
        sessionId: 2,
        appTarget: "Slack",
        activationMatcher: "slack-rule-b",
        providerModelLabel: "Engine B",
      });

      const details = screen.getByTestId("latest-dictation-details");
      expect(within(details).getByText("Mail")).toBeInTheDocument();
      expect(within(details).getByText("Engine A")).toBeInTheDocument();
      expect(within(details).getByText("mail-rule-a")).toBeInTheDocument();
      expect(within(details).getByText("17 characters")).toBeInTheDocument();
      expect(within(details).queryByText("Slack")).not.toBeInTheDocument();
      expect(within(details).queryByText("Engine B")).not.toBeInTheDocument();
      expect(within(details).queryByText("slack-rule-b")).not.toBeInTheDocument();
      expect(
        screen.getByText(
          'Matched your "slack-rule-b" rule for Slack.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/read context from Slack/i),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Used 17 characters of context/i),
      ).not.toBeInTheDocument();

      await emitTextReady({ recordingId: "recording-b", text: "Capture B" });

      const nextDetails = screen.getByTestId("latest-dictation-details");
      expect(within(nextDetails).queryByText("Mail")).not.toBeInTheDocument();
      expect(within(nextDetails).queryByText("Engine A")).not.toBeInTheDocument();
      expect(within(nextDetails).queryByText("provider-a · model-a")).not.toBeInTheDocument();
      expect(within(nextDetails).queryByText("mail-rule-a")).not.toBeInTheDocument();
    });

    it("uses capture A's target when learning its correction after live context changes", async () => {
      const dictationBackend = await import("@/lib/backend/dictation");
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });

      await emitTextReady({
        recordingId: "recording-a",
        text: "please email jon tomorrow",
        appTarget: "Mail",
      });
      await emitPreparing({ appTarget: "Slack", activationMatcher: "slack-rule-b" });
      fireEvent.change(screen.getByDisplayValue("please email jon tomorrow"), {
        target: { value: "please email John tomorrow" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Learn correction" }));

      await waitFor(() =>
        expect(dictationBackend.learnDictationCorrection).toHaveBeenCalledWith({
          originalText: "please email jon tomorrow",
          correctedText: "please email John tomorrow",
          appTarget: "Mail",
          force: true,
        }),
      );
    });

    it("uses the captured target for a style preview", async () => {
      backendMocks.reprocessDictationText.mockResolvedValue({
        modePreset: "voice",
        outputText: "Preview A",
        usedAi: true,
        provider: "local",
        modelId: "test-model",
      });
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });

      await emitTextReady({
        recordingId: "recording-a",
        text: "Capture A",
        appTarget: "Mail",
      });
      await emitPreparing({ appTarget: "Slack", activationMatcher: "slack-rule-b" });
      await emitDone({ appTarget: "Slack", activationMatcher: "slack-rule-b" });
      await previewLatestStyle();

      expect(backendMocks.reprocessDictationText).toHaveBeenLastCalledWith(
        "Capture A",
        "voice",
        "Mail",
        expect.objectContaining({ runId: expect.any(String) }),
      );
    });

    it("uses no previous target for an unfinished draft with unknown source metadata", async () => {
      backendMocks.listDictationDrafts.mockResolvedValueOnce([
        {
          recordingId: "recording-draft",
          title: "Older draft",
          text: "Recovered draft",
          expectedSavedText: null,
        },
      ]);
      backendMocks.getTranscript.mockResolvedValueOnce(
        createSavedTranscript("recording-draft", "Original draft"),
      );
      backendMocks.reprocessDictationText.mockResolvedValue({
        modePreset: "voice",
        outputText: "Draft preview",
        usedAi: true,
        provider: "local",
        modelId: "test-model",
      });
      render(<DictationView />);
      await screen.findByText("Unfinished edits (1)");

      await emitTextReady({
        recordingId: "recording-a",
        text: "Capture A",
        appTarget: "Mail",
      });
      await emitPreparing({ appTarget: "Slack", activationMatcher: "slack-rule-b" });
      await emitDone({ appTarget: "Slack", activationMatcher: "slack-rule-b" });
      fireEvent.click(screen.getByText("Unfinished edits (1)"));
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Latest dictation result" }))
          .toHaveValue("Recovered draft"),
      );
      backendMocks.reprocessDictationText.mockClear();
      await previewLatestStyle();

      expect(backendMocks.reprocessDictationText).toHaveBeenLastCalledWith(
        "Recovered draft",
        "voice",
        null,
        expect.objectContaining({ runId: expect.any(String) }),
      );
    });

    it("uses saved history source metadata after adopting a history preview", async () => {
      backendMocks.recordings = [createSavedDictation()];
      backendMocks.getTranscript.mockResolvedValue(
        createSavedTranscript("dictation-1", "History original"),
      );
      backendMocks.getDictationHistoryDetails.mockResolvedValue({
        modePreset: "voice",
        modeLabel: "Voice",
        baseModePreset: "voice",
        baseModeLabel: "Voice",
        customModeId: null,
        customModeName: null,
        contextSource: "application_context",
        appTarget: "History Mail",
        activationMatcher: "history-mail-rule",
        contextAppName: "Mail",
        commandApplied: null,
        dictionaryAppliedCount: 0,
        snippetAppliedCount: 0,
        formattingApplied: false,
        recentInsertReused: false,
        pipelineStageKeys: [],
        promptSource: null,
        promptPreview: null,
        requestedProvider: "parakeet",
        actualProvider: "parakeet",
        modelId: "parakeet-tdt-0.6b-v3",
        routePreference: "local",
        resolvedHosting: "local",
        startupLatencyMs: null,
        transcriptionLatencyMs: null,
        insertLatencyMs: null,
        endToEndMs: null,
        audioAvailable: false,
      } as any);
      backendMocks.reprocessDictationText
        .mockResolvedValueOnce({
          modePreset: "voice",
          outputText: "Adopted history preview",
          usedAi: true,
          provider: "local",
          modelId: "test-model",
        })
        .mockResolvedValueOnce({
          modePreset: "voice",
          outputText: "Second preview",
          usedAi: true,
          provider: "local",
          modelId: "test-model",
        });
      render(<DictationView />);
      await screen.findByRole("tab", { name: "Profiles" });
      await emitTextReady({ text: "Live result", appTarget: "Slack" });

      fireEvent.click(
        screen.getByRole("button", { name: "Open saved dictation: Project update" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Project update" });
      await within(dialog).findByDisplayValue("History original");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reprocess" }));
      await within(dialog).findByText("Adopted history preview");
      fireEvent.click(within(dialog).getByRole("button", { name: "Use Result" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Project update" }))
          .not.toBeInTheDocument(),
      );
      backendMocks.reprocessDictationText.mockClear();
      await previewLatestStyle();

      expect(backendMocks.reprocessDictationText).toHaveBeenLastCalledWith(
        "Adopted history preview",
        "voice",
        "history-mail-rule",
        expect.objectContaining({ runId: expect.any(String) }),
      );
    });
  });
});
