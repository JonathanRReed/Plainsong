// @ts-nocheck - Vitest mock types don't align with TypeScript
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsView } from "@/components/views/recordings-view";
import type { Recording } from "@/types";
import { SUMMARY_GROUNDING_POLICY_VERSION } from "@/types/asr";
import * as backend from "@/lib/backend";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";
import {
  OPEN_RECORDING_WORKSPACE_EVENT,
  OPEN_SETTINGS_TAB_EVENT,
  canLeaveMainView,
  queueMeetingStartRequest,
} from "@/lib/navigation";
import { publishCallCaptureRequest } from "@/lib/call-capture-request";
import { formatDateTime } from "@/lib/format-locale";
import { invoke } from "@/lib/electron";

const speechSynthesisMock = {
  speak: vi.fn(),
  cancel: vi.fn(),
};

const eventListeners = new Map<string, (event: { payload: any }) => void>();
const eventSubscribers = new Map<string, Set<(event: { payload: any }) => void>>();
const toast = vi.fn();
const startMeeting = vi.fn();
const stopMeeting = vi.fn();
const pauseMeeting = vi.fn();
const resumeMeeting = vi.fn();
const readinessContext = vi.hoisted(() => ({
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

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    const subscribers = eventSubscribers.get(eventName) ?? new Set<(event: { payload: any }) => void>();
    subscribers.add(handler);
    eventSubscribers.set(eventName, subscribers);
    eventListeners.set(eventName, (event) => { for (const subscriber of [...subscribers]) subscriber(event); });
    return () => {
      subscribers.delete(handler);
      if (subscribers.size === 0) {
        eventSubscribers.delete(eventName);
        eventListeners.delete(eventName);
      }
    };
  }),
  invoke: vi.fn(),
  once: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
  getCurrentWindow: () => ({
    label: "main",
    setSize: vi.fn(),
    setPosition: vi.fn(),
    hide: vi.fn(),
    startDragging: vi.fn(),
  }),
  LogicalSize: class LogicalSize {
    constructor(public width: number, public height: number) {}
  },
}));

let recordings = [
  {
    id: "r1",
    title: "Weekly sync",
    projectId: "default",
    duration: 120,
    createdAt: "2026-03-06T12:00:00Z",
    updatedAt: "2026-03-06T12:00:00Z",
    sourceType: "meeting",
    audioPath: "/tmp/weekly-sync.wav",
    status: "completed" as const,
    meetingCaptureMode: "me_and_them" as const,
  },
] as Recording[];

let recordingState = {
  isRecording: false,
  recordingId: null as string | null,
  formattedDuration: "00:00",
  meetingPhase: "idle",
  meetingMessage: null as string | null,
  meetingPaused: false,
};
let recordingMode: "dictation" | "meeting" | null = null;
const refetchRecordings = vi.fn();
let recordingsLoading = false;
let recordingsHaveLoaded = true;
let recordingsError: string | null = null;

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings,
    isLoading: recordingsLoading,
    hasLoaded: recordingsHaveLoaded,
    error: recordingsError,
    refetch: refetchRecordings,
  }),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecordingSession: () => ({
    startMeeting,
    stopMeeting,
    pauseMeeting,
    resumeMeeting,
    isRecording: recordingState.isRecording,
    recordingId: recordingState.recordingId,
    meetingPhase: recordingState.meetingPhase,
    meetingMessage: recordingState.meetingMessage,
    meetingPaused: recordingState.meetingPaused,
    recordingMode,
  }),
  RecordingDurationText: () => recordingState.formattedDuration,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast,
  }),
}));

vi.mock("@/components/recording-overlay", () => ({
  ConsentDialog: (props: any) =>
    props.open ? (
      <div role="dialog" aria-label="Meeting consent">
        {props.startBlockedReason ? <p role="status">{props.startBlockedReason}</p> : null}
        {props.startFailureAction ? (
          <button type="button" onClick={props.startFailureAction.onSelect}>
            {`In dialog: ${props.startFailureAction.label}`}
          </button>
        ) : null}
        <button type="button" disabled={Boolean(props.startBlockedReason)}
          onClick={() => props.onStart?.({ systemAudio: true })}>
          Confirm meeting consent
        </button>
        <button onClick={() => props.onOpenChange(false)}>Cancel meeting consent</button>
      </div>
    ) : null,
}));

// Kept thin, but the props are recorded: the transcript panel's contract with
// this view (what it renders, where the reading position is, what provenance it
// may claim) is the thing several of these tests are about.
const transcriptViewerProps = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/components/transcript-viewer", async () => {
  const { useEffect } = await import("react");
  return {
    TranscriptViewer: (props: any) => {
      transcriptViewerProps.current = props;
      // The real viewer reports every hit for the live query in reading order,
      // and it reports them only once the transcript has actually landed. Which
      // of those hits the view then makes current is the thing the deep-link
      // tests are about, so the stand-in has to report them the same way.
      const query = props.highlightQuery?.trim().toLowerCase() ?? "";
      const matchKey = JSON.stringify(
        query
          ? props.segments
              .filter((segment: any) => segment.text.toLowerCase().includes(query))
              .map((segment: any) => ({
                segmentId: segment.id,
                startTime: segment.startTime,
              }))
          : []
      );
      const { onMatchesChange } = props;
      useEffect(() => {
        onMatchesChange?.(JSON.parse(matchKey));
      }, [matchKey, onMatchesChange]);
      return (
        <div>
          <span>{props.segments.length} segments rendered</span>
          <span>provenance: {props.provenance?.source ?? "unset"}</span>
        </div>
      );
    },
    TranscriptSearch: (props: any) => (
      <div>
        <input
          aria-label="Find in transcript"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <span>
          {props.activeMatchIndex + 1} of {props.matchCount}
        </span>
      </div>
    ),
  };
});

vi.mock("@/components/waveform-visualizer", () => ({
  RecordingWaveform: () => null,
  WaveformVisualizer: () => null,
}));

vi.mock("@/components/ai-analysis-panel", () => ({
  AiAnalysisPanel: (props: any) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onChatMessagesChange?.([
            {
              id: "m1",
              role: "user",
              content: "What slipped?",
              templateId: null,
              citations: [],
              createdAt: "2026-03-06T12:00:00Z",
            },
            {
              id: "m2",
              role: "assistant",
              content: "Launch review slipped to Monday.",
              templateId: null,
              citations: [
                {
                  text: "Let's move launch review to Monday",
                  startTime: 2,
                  endTime: 4,
                  recordingId: "r1",
                  certainty: 0.94,
                },
              ],
              createdAt: "2026-03-06T12:01:00Z",
            },
          ])
        }
      >
        Push meeting chat
      </button>
      <button
        type="button"
        onClick={() =>
          props.onChatMessagesChange?.([
            {
              id: "m3",
              role: "user",
              content: "What changed after review?",
              templateId: null,
              citations: [],
              createdAt: "2026-03-06T12:02:00Z",
            },
          ])
        }
      >
        Push newer meeting chat
      </button>
      {props.responseActions
        ?.filter((action: any) =>
          action.isVisible?.({
            response: "Thanks all. Next steps: Jon will send the launch plan by Friday.",
            query: "follow-up",
            templateId: "follow_up",
            citations: [],
          }) ?? true
        )
        .map((action: any) => (
          <button
            key={action.label}
            type="button"
            onClick={() =>
              action.onAction({
                response: "Thanks all. Next steps: Jon will send the launch plan by Friday.",
                query: "follow-up",
                templateId: "follow_up",
                citations: [],
              })
            }
          >
            {action.label}
          </button>
        ))}
      <div>{props.chatMessages?.length ?? 0} chat messages</div>
    </div>
  ),
}));

const customMeetingTemplatesState = vi.hoisted(() => ({
  templates: [] as Array<{
    id: string;
    name: string;
    summaryPrompt: string;
    notesOutline: string[];
  }>,
}));

vi.mock("@/lib/backend", () => ({
  getRecording: vi.fn(async () => ({})) as any,
  getRecordingWaveform: vi.fn() as any,
  openRecordingAudio: vi.fn() as any,
  prepareRecordingPlayback: vi.fn(async (recordingId: string) => ({
    token: "0123456789abcdef0123456789abcdef",
    url: "plainsong://playback/0123456789abcdef0123456789abcdef",
    recordingId,
    protection: "plaintext",
    durationSeconds: 14,
  })) as any,
  releaseRecordingPlayback: vi.fn(async () => {}) as any,
  getSpeakers: vi.fn() as any,
  getTranscript: vi.fn(async () => ({})) as any,
  getMeetingTranscriptDetails: vi.fn(async () => ({})) as any,
  runDiarization: vi.fn() as any,
  renameSpeaker: vi.fn() as any,
  suggestSpeakerVoices: vi.fn(async () => ({
    enabled: false,
    clusters: [],
    nameOptions: [],
  })) as any,
  rememberSpeakerVoice: vi.fn(async () => ({
    profileId: "p-dana",
    displayName: "Dana",
  })) as any,
  rejectSpeakerVoice: vi.fn(async () => {}) as any,
  deleteRecording: vi.fn() as any,
  renameRecording: vi.fn() as any,
  retranscribeRecording: vi.fn() as any,
  retryMeetingAnalysis: vi.fn(async () => {}) as any,
  cancelMeetingNotesWait: vi.fn(async () => ({ cancelled: true })),
  retryMeetingAutoName: vi.fn() as any,
  revalidateRecordingAudio: vi.fn(async () => ({})) as any,
  acknowledgeIncompleteTranscript: vi.fn(async () => ({})) as any,
  setRecordingSourceType: vi.fn() as any,
  importAudioFile: vi.fn(async () => null) as any,
  isDiarizationModelAvailable: vi.fn(async () => false) as any,
  getDiarizationModelPlan: vi.fn() as any,
  downloadDiarizationModel: vi.fn() as any,
  getMeetingChatMessages: vi.fn(async () => []) as any,
  updateMeetingChatMessages: vi.fn(async () => {}) as any,
  askMemory: vi.fn() as any,
  cancelAnalysisRun: vi.fn(async () => {}) as any,
  editTranscriptSpeakerTurn: vi.fn() as any,
  deleteTranscriptSegments: vi.fn() as any,
  deleteMeetingEnhancedNoteDraft: vi.fn(async () => {}),
  getMeetingEnhancedNoteDraft: vi.fn(async () => null),
  saveMeetingEnhancedNoteDraft: vi.fn(async (_id, draft) => draft),
  deleteMeetingEnhancedNoteDraft: vi.fn(async () => null),
  updateRecordingNotes: vi.fn(async () => {}) as any,
  queueMeetingNoteRecovery: vi.fn(async () => {}) as any,
  listMeetingNoteRecovery: vi.fn(async () => []) as any,
  updateRecordingAnalysis: vi.fn(async () => {}) as any,
  updateRecordingTemplate: vi.fn(async () => {}) as any,
  getRelationshipMemory: vi.fn(async () => null) as any,
  getSummaryRegenerationUndo: vi.fn(async () => ({ canUndo: false })) as any,
  undoSummaryRegeneration: vi.fn() as any,
  summarizeRecordingGrounded: vi.fn(async () => ({})) as any,
  extractActionItemsGrounded: vi.fn(async () => ({})) as any,
  exportRecordingV2: vi.fn(async () => ({})) as any,
  openExportPath: vi.fn() as any,
  searchTranscripts: vi.fn(async () => []) as any,
  openPermissionSettings: vi.fn(async () => {}) as any,
  getSettings: vi.fn(async () => ({
    transcription: { meetingCustomTemplates: customMeetingTemplatesState.templates },
  })) as any,
  updateSettings: vi.fn(async (mutate: any) => {
    const settings = { transcription: { meetingCustomTemplates: structuredClone(customMeetingTemplatesState.templates) } };
    mutate(settings);
    customMeetingTemplatesState.templates =
      settings.transcription.meetingCustomTemplates ?? [];
  }) as any,
}));

// The calendar affordance in the Meetings header. Mocked at the backend rather
// than at the component so the view is exercised through the real cue: the
// thing under test is what the view does with the prefill the cue hands it.
const calendarSnapshot = vi.hoisted(() => ({
  current: {
    authorization: "unknown",
    observedAt: 0,
    events: [] as any[],
    calendars: [] as any[],
    errorCode: null,
  },
}));

vi.mock("@/lib/backend/calendar", () => ({
  getCalendarSnapshot: vi.fn(async () => calendarSnapshot.current),
  requestCalendarAccess: vi.fn(async () => calendarSnapshot.current),
  openCalendarPrivacySettings: vi.fn(async () => {}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(backend)) {
    if (vi.isMockFunction(mock)) mock.mockReset();
  }
  vi.mocked(invoke).mockReset();
  backend.getSummaryRegenerationUndo.mockResolvedValue({ canUndo: false });
  // No calendar unless a test says otherwise: the header affordance must be
  // invisible to every other test in this file.
  calendarSnapshot.current = {
    authorization: "unknown",
    observedAt: 0,
    events: [],
    calendars: [],
    errorCode: null,
  };
  eventListeners.clear();
  eventSubscribers.clear();
  customMeetingTemplatesState.templates = [];
  transcriptViewerProps.current = null;
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  // `userEvent.setup()` installs a getter-only clipboard stub on the shared
  // navigator, so a plain assignment throws once any earlier test has used
  // it. Redefining the property works either way.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  Object.assign(globalThis, {
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
  recordingState.isRecording = false;
  recordingState.recordingId = null;
  recordingState.formattedDuration = "00:00";
  recordingState.meetingPhase = "idle";
  recordingState.meetingMessage = null;
  recordingState.meetingPaused = false;
  recordingMode = null;
  recordingsLoading = false;
  recordingsHaveLoaded = true;
  recordingsError = null;
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
  recordings = [
    {
      id: "r1",
      title: "Weekly sync",
      projectId: "default",
      duration: 120,
      createdAt: "2026-03-06T12:00:00Z",
      updatedAt: "2026-03-06T12:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/weekly-sync.wav",
      meetingCaptureMode: "me_and_them",
      status: "completed" as const,
    } as Recording,
  ];
  startMeeting.mockReset();
  stopMeeting.mockReset();
  pauseMeeting.mockReset();
  resumeMeeting.mockReset();
  backend.getRecording.mockResolvedValue({
    ...recordings[0],
    summary: "Test summary",
    actionItems: ["Ship launch checklist"],
  });
  backend.getTranscript.mockResolvedValue({
    id: "t1",
    recordingId: "r1",
    segments: [
      {
        id: "s1",
        startTime: 0,
        endTime: 5,
        text: "Transcript",
        confidence: 0.9,
      },
    ],
    fullText: "Transcript",
    language: "en",
    confidence: 0.9,
    model: "distil-whisper",
  });
  backend.getMeetingTranscriptDetails.mockResolvedValue({
    segmentCount: 1,
    model: "Distil Whisper",
    modelId: "distil-large-v3",
    requestedProvider: "distil_whisper",
    actualProvider: "distil_whisper",
    qualityScore: 0.92,
    transcriptionLatencyMs: 880,
    sourceMode: "me_them",
    hasSourceAwareSpeakers: true,
    hasSpeakerLabels: true,
  });
  backend.getSpeakers.mockResolvedValue([]);
  backend.renameSpeaker.mockResolvedValue(undefined);
  backend.renameRecording.mockReset().mockResolvedValue(undefined);
  backend.suggestSpeakerVoices.mockResolvedValue({
    enabled: false,
    clusters: [],
    nameOptions: [],
  });
  backend.rememberSpeakerVoice.mockResolvedValue({
    profileId: "p-dana",
    displayName: "Dana",
  });
  backend.rejectSpeakerVoice.mockResolvedValue(undefined);
  backend.editTranscriptSpeakerTurn.mockResolvedValue(undefined);
  backend.deleteRecording.mockResolvedValue(undefined);
  backend.searchTranscripts.mockResolvedValue([]);
  backend.getRelationshipMemory.mockResolvedValue(null);
  backend.getMeetingChatMessages.mockResolvedValue([]);
  backend.updateMeetingChatMessages.mockResolvedValue(undefined);
  backend.cancelAnalysisRun.mockResolvedValue(undefined);
  backend.updateRecordingNotes.mockReset().mockResolvedValue(undefined);
  backend.queueMeetingNoteRecovery.mockResolvedValue(undefined);
  backend.listMeetingNoteRecovery.mockResolvedValue([]);
  backend.updateRecordingAnalysis.mockReset().mockResolvedValue(undefined);
  backend.updateRecordingTemplate.mockResolvedValue(undefined);
  backend.summarizeRecordingGrounded.mockResolvedValue({
    summary: "Fresh grounded summary",
    citations: [],
    actualProvider: "ollama",
    model: "test-model",
    processingTimeMs: 1200,
    grounded: true,
    provenance: {
      version: 1,
      groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
      contentHash: "v1:sha256:fresh-summary",
      actualProvider: "ollama",
      actualModel: "test-model",
      promptSource: "meeting_playbook:auto",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [],
      grounded: true,
    },
  });
  backend.extractActionItemsGrounded.mockResolvedValue({
    items: [
      {
        task: "Ship launch checklist",
        assignee: "Jon",
        deadline: "Friday",
        citations: [],
      },
    ],
    actualProvider: "ollama",
    model: "test-model",
    processingTimeMs: 900,
    grounded: true,
    provenance: {
      version: 1,
      groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
      contentHash: "v1:sha256:fresh-actions",
      actualProvider: "ollama",
      actualModel: "test-model",
      promptSource: "plainsong_action_items_v1",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [],
      grounded: true,
      items: [
        {
          contentHash: "v1:sha256:fresh-action",
          citations: [],
          grounded: true,
        },
      ],
    },
  });
  backend.askMemory.mockResolvedValue({
    answer: "Jon keeps pushing for a written launch plan and Friday owner confirmation.",
    citations: [
      {
        text: "Jon asked for a written launch plan before Friday.",
        startTime: 10,
        endTime: 15,
        recordingId: "r1",
        certainty: 0.92,
      },
    ],
  });
  backend.exportRecordingV2.mockResolvedValue({
    format: "markdown",
    redactionLevel: "basic",
    preview: false,
    exportPath: "/tmp/weekly-sync.md",
    content: null,
  });
});

describe("RecordingsView", () => {


  it("shows a loading state before the meetings library has loaded", () => {
    recordings = [];
    recordingsLoading = true;
    recordingsHaveLoaded = false;

    render(<RecordingsView />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading your meetings");
    expect(screen.queryByText("No meetings yet")).not.toBeInTheDocument();
    // The page h1 is also "Meetings", so the count is read out of the totals
    // strip rather than off the first match in the document.
    const totals = screen.getByRole("region", { name: "Meeting totals" });
    expect(within(totals).getByText("Meetings").parentElement).toHaveTextContent("—");
  });

  describe("meeting switcher navigation", () => {
    const addSecondMeeting = () => {
      vi.mocked(invoke).mockImplementation(async (channel: string) => channel === "get_meeting_action_completion" ? { completedTasks: [] } : undefined);
      recordings.push({ ...recordings[0], id: "r2", title: "Launch review" });
      backend.getRecording.mockImplementation(async (id: string) => ({ ...recordings.find(recording => recording.id === id), summary: `Summary for ${id}`, actionItems: ["Ship launch checklist"] }));
    };
    const openSwitcher = async () => {
      await userEvent.setup().click(screen.getByRole("button", { name: "Switch meeting" }));
      return screen.getByRole("button", { name: "Open meeting: Launch review" });
    };
    it("switches workspaces after saving drafts and leaves current selection alone", async () => {
      addSecondMeeting(); const user = userEvent.setup(); render(<RecordingsView />);
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      await screen.findByLabelText("Summary");
      backend.getRecording.mockClear();
      await user.click(screen.getByRole("button", { name: "Switch meeting" }));
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      expect(backend.getRecording).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Save before switching" } });
      await user.click(await openSwitcher());
      await waitFor(() => expect(screen.getByText("Summary for r2")).toBeInTheDocument());
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { summary: "Save before switching" });
    });
    it("keeps the original meeting when draft saving fails", async () => {
      addSecondMeeting(); const user = userEvent.setup(); render(<RecordingsView />);
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      await screen.findByLabelText("Summary");
      backend.updateRecordingAnalysis.mockRejectedValue(new Error("Save failed"));
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Keep my draft" } });
      await user.click(await openSwitcher());
      expect(await screen.findByRole("alert")).toHaveTextContent("Finish your edits");
      await user.keyboard("{Escape}");
      expect(screen.getByLabelText("Summary")).toHaveValue("Keep my draft");
      expect(backend.getRecording).not.toHaveBeenCalledWith("r2");
      backend.updateRecordingAnalysis.mockResolvedValue(undefined);
    });
    it("blocks switching while a task row draft is unfinished", async () => {
      addSecondMeeting(); const user = userEvent.setup(); render(<RecordingsView />);
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      await screen.findByLabelText("Summary");
      const add = await screen.findByRole("button", { name: "Add task" });
      await waitFor(() => expect(add).toBeEnabled()); await user.click(add);
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Keep this task" } });
      await user.click(await openSwitcher());
      expect(await screen.findByRole("alert")).toHaveTextContent("Finish your edits");
      await user.keyboard("{Escape}");
      expect(screen.getByLabelText("Task")).toHaveValue("Keep this task");
      expect(backend.getRecording).not.toHaveBeenCalledWith("r2");
    });
    it.each(["close", "external"])("does not replace a newer %s request after a pending save", async (navigation) => {
      addSecondMeeting();
      recordings.push({ ...recordings[0], id: "r3", title: "Newer meeting" });
      const save = deferred<void>(); const user = userEvent.setup(); render(<RecordingsView />);
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      await screen.findByLabelText("Summary");
      backend.updateRecordingAnalysis.mockReturnValueOnce(save.promise);
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Pending draft" } });
      await user.click(await openSwitcher());
      await screen.findByText("Saving your edits…");
      if (navigation === "close") {
        fireEvent.click(screen.getByRole("button", { name: "All meetings", hidden: true }));
      } else {
        act(() => window.dispatchEvent(new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, { detail: { recordingId: "r3" } })));
      }
      await act(async () => { save.resolve(); });
      if (navigation === "close") {
        await waitFor(() => expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument());
      } else {
        await screen.findByText("Summary for r3");
      }
      expect(backend.getRecording).not.toHaveBeenCalledWith("r2");
    });

    it("does not switch after dismissing a pending save", async () => {
      addSecondMeeting(); const save = deferred<void>(); const user = userEvent.setup(); render(<RecordingsView />);
      await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
      await screen.findByLabelText("Summary");
      backend.updateRecordingAnalysis.mockReturnValueOnce(save.promise);
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Pending draft" } });
      await user.click(await openSwitcher());
      await screen.findByText("Saving your edits…");
      await user.keyboard("{Escape}");
      await act(async () => { save.resolve(); });
      expect(screen.getByLabelText("Summary")).toHaveValue("Pending draft");
      expect(backend.getRecording).not.toHaveBeenCalledWith("r2");
    });
  });

  it.each(["{Enter}", " "])("opens a meeting from its title with %s", async (key) => {
    const user = userEvent.setup();
    render(<RecordingsView />);

    const openMeeting = screen.getByRole("button", { name: "Open meeting: Weekly sync" });
    openMeeting.focus();
    expect(openMeeting).toHaveFocus();
    await user.keyboard(key);

    expect(await screen.findByLabelText("Summary")).toBeInTheDocument();
    expect(backend.getRecording).toHaveBeenCalledWith("r1");
  });

  it("keeps audio playback and meeting options separate from opening the meeting", async () => {
    const user = userEvent.setup();
    render(<RecordingsView />);

    await user.click(screen.getByRole("button", { name: "Play this meeting's audio" }));
    await waitFor(() => expect(backend.openRecordingAudio).toHaveBeenCalledWith("r1"));
    expect(backend.getRecording).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Meeting options" }));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(backend.getRecording).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();
  });

  it("loads and saves action-item completion for the selected meeting", async () => {
    const electronInvoke = vi.mocked(invoke);
    electronInvoke.mockImplementation(async (channel: string, args: any) => {
      if (channel === "get_meeting_action_completion") {
        expect(args).toEqual({ recordingId: "r1" });
        return { completedTasks: ["Ship launch checklist"] };
      }
      if (channel === "set_meeting_action_completed") {
        expect(args).toEqual({
          recordingId: "r1",
          task: "Ship launch checklist",
          completed: false,
        });
        return { completedTasks: [] };
      }
      return undefined;
    });
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    const checkbox = await screen.findByRole("checkbox", { name: "Mark Ship launch checklist incomplete" });
    expect(checkbox).toBeChecked();
    await userEvent.setup().click(checkbox);

    await waitFor(() => {
      expect(electronInvoke).toHaveBeenCalledWith("set_meeting_action_completed", {
        recordingId: "r1",
        task: "Ship launch checklist",
        completed: false,
      });
    });
    expect(checkbox).not.toBeChecked();
  });

  it("keeps an action checkbox checked when saving its completion fails", async () => {
    const electronInvoke = vi.mocked(invoke);
    electronInvoke.mockImplementation(async (channel: string) => {
      if (channel === "get_meeting_action_completion") {
        return { completedTasks: ["Ship launch checklist"] };
      }
      if (channel === "set_meeting_action_completed") {
        throw new Error("save failed");
      }
      return undefined;
    });

    render(<RecordingsView />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    const checkbox = await screen.findByRole("checkbox", { name: "Mark Ship launch checklist incomplete" });
    await user.click(checkbox);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your task text is unchanged"));
    expect(checkbox).toBeChecked();
  });

  it("shows open meeting tasks and restores completed tasks in All tasks", async () => {
    const electronInvoke = vi.mocked(invoke);
    electronInvoke.mockImplementation(async (channel: string) => {
      if (channel === "get_meeting_action_completion") {
        return { completedTasks: ["Ship launch checklist"] };
      }
      return undefined;
    });
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Test summary",
      actionItems: ["Ship launch checklist", "Confirm launch owner"],
    });

    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    expect(screen.getByText("1 open · 1 done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open tasks" }));
    expect(screen.queryByText("Ship launch checklist")).not.toBeInTheDocument();
    expect(screen.getByText("Confirm launch owner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done tasks" }));
    expect(screen.getByText("Ship launch checklist")).toBeInTheDocument();
    expect(screen.queryByText("Confirm launch owner")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done tasks" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
    expect(screen.getByText("Ship launch checklist")).toBeInTheDocument();
    expect(screen.getByText("Confirm launch owner")).toBeInTheDocument();
  });

  it("explains an empty Done tasks filter without changing saved tasks", async () => {
    vi.mocked(invoke).mockImplementation(async (channel: string) => {
      if (channel === "get_meeting_action_completion") return { completedTasks: [] };
      return undefined;
    });
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Done tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Done tasks" }));
    expect(screen.getByText("No tasks are done yet. Mark a task complete to see it here.")).toBeInTheDocument();
    expect(screen.queryByText("Ship launch checklist")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
    expect(screen.getByText("Ship launch checklist")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("set_meeting_action_completed", expect.anything());
  });

  it("keeps the full action editor disabled while a row edit draft is open", async () => {
    vi.mocked(invoke).mockImplementation(async (channel: string) => channel === "get_meeting_action_completion" ? { completedTasks: [] } : undefined);
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    const edit = await screen.findByRole("button", { name: "Edit task: Ship launch checklist" });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Keep my draft" } });
    expect(screen.getByRole("button", { name: "Edit Action items" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save task" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    expect(screen.getByLabelText("Task")).toHaveValue("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Action items" })).toBeEnabled());
  });

  it("blocks leaving an unfinished Add task draft and allows leaving after Cancel", async () => {
    vi.mocked(invoke).mockImplementation(async (channel: string) => channel === "get_meeting_action_completion" ? { completedTasks: [] } : undefined);
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    const add = await screen.findByRole("button", { name: "Add task" });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Keep this task" } });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Finish or cancel the task edit before leaving this meeting.", "error"));
    expect(screen.getByLabelText("Task")).toHaveValue("Keep this task");
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument());
  });

  it("offers Add task when a meeting has no action items", async () => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], actionItems: [] });
    vi.mocked(invoke).mockImplementation(async (channel: string) => channel === "get_meeting_action_completion" ? { completedTasks: [] } : undefined);
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    const add = await screen.findByRole("button", { name: "Add task" });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(screen.getByRole("form", { name: "Add action item" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Action items" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Save task" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Action items" })).toBeEnabled());
  });

  it("adds and deletes tasks with the current stored list and canonical acknowledgements", async () => {
    let items = ["Ship launch checklist"];
    vi.mocked(invoke).mockImplementation(async (channel: string, payload: any) => {
      if (channel === "get_meeting_action_completion") return { completedTasks: ["Ship launch checklist"] };
      if (channel === "add_meeting_action") {
        expect(payload).toEqual({ recordingId: "r1", expectedItems: items, replacement: "Confirm owner (Owner: Sam · Due: Friday)" });
        items = [...items, payload.replacement];
        return { recording: { ...recordings[0], actionItems: items }, completedTasks: ["Ship launch checklist"] };
      }
      if (channel === "delete_meeting_action") {
        expect(payload).toEqual({ recordingId: "r1", expectedItems: items, index: 1 });
        items = items.slice(0, 1);
        return { recording: { ...recordings[0], actionItems: items }, completedTasks: ["Ship launch checklist"] };
      }
      return undefined;
    });
    render(<RecordingsView />);
    await userEvent.setup().click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Add task" });
    fireEvent.click(screen.getByRole("button", { name: "Done tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Confirm owner" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    expect(screen.getByLabelText("Task")).toHaveValue("Confirm owner");
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await screen.findByRole("button", { name: "Delete task: Confirm owner" });
    expect(screen.getByRole("button", { name: "All tasks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Mark Ship launch checklist incomplete" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Delete task: Confirm owner" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Action items" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Confirm delete task" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete task" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete task: Confirm owner" })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Mark Ship launch checklist incomplete" })).toBeChecked();
  });

  it("opens a completed follow-up in All tasks and focuses its exact stored item", async () => {
    const storedTask = "Ship launch checklist (Owner: Jon · Due: Friday)";
    const electronInvoke = vi.mocked(invoke);
    electronInvoke.mockImplementation(async (channel: string) => {
      if (channel === "get_meeting_action_completion") {
        return { completedTasks: [storedTask] };
      }
      return undefined;
    });
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Test summary",
      actionItems: [storedTask, "Confirm launch owner"],
    });
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(<RecordingsView />);

      act(() => {
        window.dispatchEvent(
          new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
            detail: { recordingId: "r1", focusActionItem: storedTask },
          }),
        );
      });

      const taskLabel = await screen.findByText("Ship launch checklist");
      const taskRow = taskLabel.closest("li");
      expect(taskRow).not.toBeNull();
      expect(await screen.findByRole("button", { name: "All tasks" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(taskRow).toHaveAttribute("aria-current", "true");
      await waitFor(() => expect(taskRow).toHaveFocus());
      expect(within(taskRow!).getByText("Owner: Jon")).toBeInTheDocument();
      expect(within(taskRow!).getByText("Due: Friday")).toBeInTheDocument();
      expect(
        within(taskRow!).getByRole("checkbox", {
          name: "Mark Ship launch checklist incomplete",
        }),
      ).toBeChecked();
      expect(electronInvoke).not.toHaveBeenCalledWith(
        "set_meeting_action_completed",
        expect.anything(),
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("explains when a requested follow-up is missing without highlighting another task", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Test summary",
      actionItems: ["Ship launch checklist", "Confirm launch owner"],
    });

    render(<RecordingsView />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: {
            recordingId: "r1",
            focusActionItem: "Send the follow-up packet",
          },
        }),
      );
    });

    const missingFollowup = await screen.findByText(
      "This follow-up isn't in the current action items. Review the meeting below.",
    );
    const actionItems = screen.getByRole("region", { name: "Action items" });
    expect(missingFollowup.parentElement).toContainElement(actionItems);
    expect(actionItems.querySelector('[aria-current="true"]')).toBeNull();
  });

  it("clears a follow-up focus when another meeting opens normally", async () => {
    const storedTask = "Ship launch checklist";
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      actionItems: ["Confirm launch owner"],
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.getRecording.mockImplementation(async (recordingId: string) => {
      if (recordingId === "r1") {
        return { ...recordings[0], summary: "Test summary", actionItems: [storedTask] };
      }
      return { ...launchReview, summary: "Launch summary" };
    });
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();

    try {
      render(<RecordingsView />);
      act(() => {
        window.dispatchEvent(
          new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
            detail: { recordingId: "r1", focusActionItem: storedTask },
          }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(storedTask).closest("li")).toHaveAttribute(
          "aria-current",
          "true",
        );
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
            detail: { recordingId: "r2" },
          }),
        );
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
      });
      expect(screen.getByText("Confirm launch owner").closest("li")).not.toHaveAttribute(
        "aria-current",
      );
      expect(
        screen.queryByText(
          "This follow-up isn't in the current action items. Review the meeting below.",
        ),
      ).not.toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("reports when a follow-up's meeting no longer exists without opening another meeting", async () => {
    const electronInvoke = vi.mocked(invoke);
    backend.getRecording.mockResolvedValue(null);

    render(<RecordingsView />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: {
            recordingId: "missing-recording",
            focusActionItem: "Send the follow-up packet",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "This follow-up's meeting is no longer available.",
        "error",
      );
    });
    expect(screen.getByRole("heading", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    expect(screen.queryByLabelText("Meeting title")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(electronInvoke).not.toHaveBeenCalledWith(
      "set_meeting_action_completed",
      expect.anything(),
    );
  });

  it("reports a follow-up source load failure without opening another meeting", async () => {
    const electronInvoke = vi.mocked(invoke);
    backend.getRecording.mockRejectedValue(new Error("database unavailable"));

    render(<RecordingsView />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: {
            recordingId: "unavailable-recording",
            focusActionItem: "Send the follow-up packet",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Couldn't open this follow-up's meeting. Try again.",
        "error",
      );
    });
    expect(screen.getByRole("heading", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    expect(screen.queryByLabelText("Meeting title")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(electronInvoke).not.toHaveBeenCalledWith(
      "set_meeting_action_completed",
      expect.anything(),
    );
  });

  it("copies an open meeting tasks agenda with pending action items only", async () => {
    const user = userEvent.setup();
    const clipboardWriteText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const electronInvoke = vi.mocked(invoke);
    electronInvoke.mockImplementation(async (channel: string) => {
      if (channel === "get_meeting_action_completion") {
        return { completedTasks: ["Ship launch checklist"] };
      }
      return undefined;
    });
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Test summary",
      actionItems: ["Ship launch checklist", "Confirm launch owner"],
    });

    render(<RecordingsView />);
    await user.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    await screen.findByText("1 open · 1 done");
    const nextAgendaButton = screen.getByRole("button", { name: "Copy next agenda" });
    expect(nextAgendaButton).toBeEnabled();
    await user.click(nextAgendaButton);

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        "Next agenda for Weekly sync\n\n- Review: Confirm launch owner"
      );
    });
  });

  it("shows an actionable load error and retries without claiming the library is empty", () => {
    recordings = [];
    recordingsLoading = false;
    recordingsHaveLoaded = false;
    recordingsError = "The recordings service is unavailable.";

    render(<RecordingsView />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The recordings service is unavailable."
    );
    expect(screen.queryByText("No meetings yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchRecordings).toHaveBeenCalledTimes(1);
  });

  it("blocks meeting capture and opens the canonical model repair destination", async () => {
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      meetings: {
        domain: "meetings",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Choose a meeting-ready speech model.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Choose a meeting-ready speech model.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      fullCapture: {
        domain: "full_capture",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Choose a meeting-ready speech model.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      overall: {
        domain: "overall",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Choose a meeting-ready speech model.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
    };
    const settingsTabListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settingsTabListener);

    render(<RecordingsView />);

    expect(screen.getByRole("button", { name: "New meeting" })).toBeDisabled();
    expect(
      screen.getByRole("alert", { name: "Meetings need attention" }),
    ).toHaveTextContent("Choose a meeting-ready speech model.");
    fireEvent.click(screen.getByRole("button", { name: "Review models" }));
    expect(
      (settingsTabListener.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toEqual({ tab: "models" });

    expect(screen.queryByRole("dialog", { name: "Meeting consent" })).toBeNull();
    expect(startMeeting).not.toHaveBeenCalled();

    window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settingsTabListener);
  });

  it("keeps cached meetings visible during a background refresh", () => {
    recordingsLoading = true;
    recordingsHaveLoaded = true;

    render(<RecordingsView />);

    expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    expect(screen.queryByText("Loading your meetings…")).not.toBeInTheDocument();
    expect(screen.queryByText("No meetings yet")).not.toBeInTheDocument();
  });

  it("keeps recoverable Meeting failures visible with a direct record action", () => {
    recordingState.recordingId = "r1";
    recordingState.meetingPhase = "recoverable";
    recordingState.meetingMessage = "Saved audio remains available for retry.";

    render(<RecordingsView />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Saved audio remains available for retry.",
    );
    expect(screen.getByRole("button", { name: "Open meeting" })).toBeEnabled();
  });

  it("lets the reader dismiss a finished meeting's banner", () => {
    recordingState.recordingId = "r1";
    recordingState.meetingPhase = "recoverable";
    recordingState.meetingMessage = "Saved audio remains available for retry.";

    const view = render(<RecordingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Saved audio remains available for retry.")).not.toBeInTheDocument();

    // A new outcome for the meeting is news again.
    recordingState.meetingPhase = "ready";
    recordingState.meetingMessage = null;
    view.rerender(<RecordingsView />);
    expect(screen.getByText("Meeting ready")).toBeInTheDocument();
  });

  it("calls a discarded empty meeting not saved, not a problem", () => {
    recordingState.recordingId = "r-empty";
    recordingState.meetingPhase = "cancelled";
    recordingState.meetingMessage = "Nothing was recorded, so this meeting wasn't saved.";

    render(<RecordingsView />);

    expect(screen.getByText("Meeting not saved")).toBeInTheDocument();
    expect(screen.queryByText("Meeting needs attention")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the empty state only after a successful empty response", () => {
    recordings = [];
    recordingsLoading = false;
    recordingsHaveLoaded = true;

    render(<RecordingsView />);

    expect(screen.getByText("No meetings yet")).toBeInTheDocument();
  });

  describe("meeting transcription activity", () => {
    const sendProgress = async (recordingId = "r1") => {
      await waitFor(() => expect(eventListeners.has("recording-transcription-progress")).toBe(true));
      await act(async () => eventListeners.get("recording-transcription-progress")?.({
        payload: { recordingId, stage: "chunk_started", chunkIndex: 1, progress: 0.5 },
      }));
    };

    it("keeps partial transcript usable beside real activity and clears terminal updates", async () => {
      recordings[0] = { ...recordings[0], status: "processing" };
      backend.getRecording.mockResolvedValue({ ...recordings[0] });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await waitFor(() => expect(transcriptViewerProps.current?.segments[0]?.text).toBe("Transcript"));
      expect(await screen.findByText("Waiting for a transcription update.")).toBeInTheDocument();
      expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
      await sendProgress("foreign-recording");
      expect(screen.queryByText("Transcribing an audio segment")).not.toBeInTheDocument();
      await sendProgress();
      const stage = await screen.findByText("Transcribing an audio segment");
      expect(stage).toHaveAttribute("role", "status");
      expect(stage.parentElement).toHaveTextContent("Last update just now.");
      expect(stage.parentElement).not.toHaveTextContent("50%");
      expect(transcriptViewerProps.current.segments[0].text).toBe("Transcript");
      await act(async () => eventListeners.get("recording-status-changed")?.({ payload: { recordingId: "r1", status: "completed" } }));
      expect(screen.queryByText("Transcribing an audio segment")).not.toBeInTheDocument();
      expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
    });

    it("uses processing overrides and preserves a fresh retry update when the RPC resolves", async () => {
      recordings[0] = { ...recordings[0], status: "error" };
      backend.getRecording.mockResolvedValue({ ...recordings[0] });
      const retry = deferred<void>();
      backend.retranscribeRecording.mockReturnValueOnce(retry.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await waitFor(() => expect(transcriptViewerProps.current?.segments[0]?.text).toBe("Transcript"));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), { button: 0 });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Retry transcription" }));
      await waitFor(() => expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1"));
      await act(async () => eventListeners.get("recording-status-changed")?.({ payload: { recordingId: "r1", status: "processing" } }));
      await sendProgress();
      expect(await screen.findByText("Transcribing an audio segment")).toBeInTheDocument();
      await act(async () => { retry.resolve(); await retry.promise; });
      expect(screen.getByText("Transcribing an audio segment")).toBeInTheDocument();
      expect(screen.getByText("Last update just now.")).toBeInTheDocument();
    });
  });

  it("meeting transcription activity does not revive a terminal job after a late retry RPC", async () => {
    recordings[0] = { ...recordings[0], status: "error" };
    backend.getRecording.mockResolvedValue({ ...recordings[0] });
    const retry = deferred<void>();
    backend.retranscribeRecording.mockReturnValueOnce(retry.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.segments[0]?.text).toBe("Transcript"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry transcription" }));
    await waitFor(() => expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1"));
    await act(async () => eventListeners.get("recording-status-changed")?.({ payload: { recordingId: "r1", status: "processing" } }));
    expect(await screen.findByText("Last update just now.")).toBeInTheDocument();
    await act(async () => eventListeners.get("recording-status-changed")?.({ payload: { recordingId: "r1", status: "completed" } }));
    expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
    await act(async () => { retry.resolve(); await retry.promise; });
    expect(screen.queryByText("Waiting for a transcription update.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
  });

  it("updates meeting filters immediately when a recording enters processing", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "Processing" }));
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();

    const handler = eventListeners.get("recording-status-changed");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          status: "processing",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Weekly sync")).toBeInTheDocument();
      expect(screen.getAllByText("Processing").length).toBeGreaterThan(1);
    });
  });

  it("surfaces a degraded-transcript note when a completed meeting had a failed chunk or source", async () => {
    render(<RecordingsView />);

    const handler = eventListeners.get("recording-status-changed");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          status: "completed",
          degraded: true,
          message: "2 of 10 transcription chunk(s) failed; transcript may be incomplete",
        },
      });
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "2 of 10 transcription chunk(s) failed; transcript may be incomplete",
        "info"
      );
    });
  });

  it("refreshes the selected meeting from canonical recording data when analysis completes", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    const handler = eventListeners.get("recording-analysis-ready");
    expect(handler).toBeTruthy();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          summary: "Stale event summary",
          actionItems: ["Stale event action"],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Canonical meeting summary")).toBeInTheDocument();
      expect(screen.getByText("Ship launch checklist")).toBeInTheDocument();
    });
  });

  it("loads meeting transcript details when opening a recording", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => {
      expect(backend.getMeetingTranscriptDetails).toHaveBeenCalledWith("r1");
    });
  });

  it("routes transcript time jumps to the current meeting without opening external audio", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.click(await screen.findByText("Browse transcript"));
    const input = await screen.findByRole("textbox", { name: "Jump to transcript time" });
    fireEvent.change(input, { target: { value: "0:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => {
      expect(transcriptViewerProps.current?.sourceNavigation).toMatchObject({
        recordingId: "r1", segmentId: "s1", time: 0,
      });
    });
    const firstRequest = transcriptViewerProps.current.sourceNavigation.requestId;
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => {
      expect(transcriptViewerProps.current.sourceNavigation.requestId).toBeGreaterThan(firstRequest);
    });
    expect(backend.openRecordingAudio).not.toHaveBeenCalled();
  });

  it("returns the saved segments for transcript review", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.onReloadTranscriptForEdit).toBeTypeOf("function"));
    await act(async () => {
      expect(await transcriptViewerProps.current.onReloadTranscriptForEdit()).toEqual([
        { id: "s1", startTime: 0, endTime: 5, text: "Transcript", confidence: 0.9 },
      ]);
    });
  });

  it("scopes saved transcript review to its original recording", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.onReloadTranscriptForEdit).toBeTypeOf("function"));
    const reload = transcriptViewerProps.current.onReloadTranscriptForEdit;
    const pending = deferred<Awaited<ReturnType<typeof backend.getTranscript>>>();
    backend.getTranscript.mockImplementationOnce(() => pending.promise);
    const review = reload();
    expect(backend.getTranscript).toHaveBeenLastCalledWith("r1");
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument());
    await act(async () => {
      pending.resolve({ id: "t1", recordingId: "r1", segments: [{ id: "s1", text: "Late saved text.", startTime: 0, endTime: 5, confidence: 0.9 }], fullText: "Late saved text.", language: "en", confidence: 0.9, model: "distil-whisper" });
      expect(await review).toBeNull();
      expect(await reload()).toBeNull();
    });
  });

  it("saves a speaker-turn edit with one atomic backend command", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    await waitFor(() => {
      expect(transcriptViewerProps.current?.onEditSegment).toBeTypeOf("function");
    });

    await act(async () => {
      await transcriptViewerProps.current.onEditSegment(
        ["s1", "s2"],
        "Corrected whole speaker turn.",
      [{ id: "s1", text: "First original.", startTime: 0, endTime: 1, speakerId: null }, { id: "s2", text: "Second original.", startTime: 1, endTime: 2, speakerId: null }]
      );
    });

    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledTimes(1);
    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledWith(
      "r1",
      ["s1", "s2"],
      "Corrected whole speaker turn.",
      [{ id: "s1", text: "First original.", startTime: 0, endTime: 1, speakerId: null }, { id: "s2", text: "Second original.", startTime: 1, endTime: 2, speakerId: null }]
    );
    expect(backend.deleteTranscriptSegments).not.toHaveBeenCalled();
  });

  it.each(["recording", "transcript"])("acknowledges a committed transcript edit when the %s refresh fails", async (failedRefresh) => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    await waitFor(() => expect(transcriptViewerProps.current?.onEditSegment).toBeTypeOf("function"));
    const onEditSegment = transcriptViewerProps.current.onEditSegment;
    const expectedSegments = [{ id: "s1", text: "Transcript", startTime: 0, endTime: 5, speakerId: null }];
    if (failedRefresh === "recording") {
      backend.getRecording.mockRejectedValueOnce(new Error("Recording refresh unavailable"));
    } else {
      backend.getTranscript.mockRejectedValueOnce(new Error("Transcript refresh unavailable"));
    }
    toast.mockClear();
    await act(async () => {
      await expect(onEditSegment(["s1"], "Saved correction.", expectedSegments)).resolves.toBeUndefined();
    });
    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledTimes(1);
    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledWith("r1", ["s1"], "Saved correction.", expectedSegments);
    expect(toast).toHaveBeenCalledWith("Transcript saved, but the meeting could not refresh. Reopen it to load the saved transcript.", "info");
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("persists a speaker rename before updating local speaker names", async () => {
    const pendingRename = deferred<void>();
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.renameSpeaker.mockReturnValueOnce(pendingRename.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.onRenameSpeaker).toBeInstanceOf(Function));
    await waitFor(() => {
      expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker 1",
      });
    });

    let renamePromise!: Promise<void>;
    act(() => {
      renamePromise = transcriptViewerProps.current.onRenameSpeaker(
        "speaker_0",
        "Alice",
      );
    });

    expect(backend.renameSpeaker).toHaveBeenCalledWith(
      "r1",
      "speaker_0",
      "Alice",
    );
    expect(transcriptViewerProps.current.speakerNames).toEqual({
      speaker_0: "Speaker 1",
    });

    await act(async () => {
      pendingRename.resolve();
      await renamePromise;
    });

    await waitFor(() => {
      expect(transcriptViewerProps.current.speakerNames).toEqual({
        speaker_0: "Alice",
      });
    });
  });

  it("keeps local speaker names unchanged and propagates rename failures", async () => {
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.renameSpeaker.mockRejectedValueOnce(
      new Error("Alias write failed"),
    );

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.onRenameSpeaker).toBeInstanceOf(Function));
    await waitFor(() => {
      expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker 1",
      });
    });

    await expect(
      transcriptViewerProps.current.onRenameSpeaker("speaker_0", "Alice"),
    ).rejects.toThrow("Alias write failed");

    expect(transcriptViewerProps.current.speakerNames).toEqual({
      speaker_0: "Speaker 1",
    });
    expect(toast).toHaveBeenCalledWith("Alias write failed", "error");
  });

  describe("speaker rename ownership", () => {
    beforeEach(() => {
      backend.renameSpeaker.mockReset().mockResolvedValue(undefined);
      backend.rememberSpeakerVoice.mockReset().mockResolvedValue({
        profileId: "p-dana",
        displayName: "Dana",
      });
      backend.suggestSpeakerVoices.mockReset().mockResolvedValue({
        enabled: false,
        clusters: [],
        nameOptions: [],
      });
    });

    const configureTwoMeetings = () => {
      const launchReview = {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
      } as Recording;
      recordings = [recordings[0], launchReview];
      backend.getRecording.mockImplementation(async (recordingId: string) => ({
        ...(recordingId === "r1" ? recordings[0] : launchReview),
        summary: `${recordingId} summary`,
        actionItems: [],
      }));
      backend.getSpeakers.mockImplementation(async (recordingId: string) => [
        {
          id: "speaker_0",
          name: recordingId === "r1" ? "Speaker 1" : "Speaker B",
          color: "#000",
          sampleCount: 1,
        },
      ]);
      return launchReview;
    };

    const openWeeklySpeakerCallback = async () => {
      fireEvent.click(screen.getByText("Weekly sync"));
      await waitFor(() => expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker 1",
      }));
      return transcriptViewerProps.current.onRenameSpeaker as (
        speakerId: string,
        newName: string,
        remember?: boolean,
      ) => Promise<void>;
    };

    it("does not apply meeting A's late rename to meeting B", async () => {
      configureTwoMeetings();
      const rename = deferred<void>();
      backend.renameSpeaker.mockReturnValueOnce(rename.promise);
      render(<RecordingsView />);
      const renameFromA = await openWeeklySpeakerCallback();
      const pending = renameFromA("speaker_0", "Alice");
      expect(backend.renameSpeaker).toHaveBeenCalledWith("r1", "speaker_0", "Alice");

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await waitFor(() => expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker B",
      }));
      await act(async () => rename.resolve());
      await pending;

      expect(transcriptViewerProps.current.speakerNames).toEqual({ speaker_0: "Speaker B" });
      expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("rename"), "error");
    });

    it("rejects a late acknowledgement after an A to B to A transition", async () => {
      configureTwoMeetings();
      const rename = deferred<void>();
      backend.renameSpeaker.mockReturnValueOnce(rename.promise);
      render(<RecordingsView />);
      const renameFromFirstA = await openWeeklySpeakerCallback();
      const pending = renameFromFirstA("speaker_0", "Alice");

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await screen.findByDisplayValue("Launch review");
      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Weekly sync"));
      await waitFor(() => expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker 1",
      }));
      await act(async () => rename.resolve());
      await pending;

      expect(transcriptViewerProps.current.speakerNames).toEqual({ speaker_0: "Speaker 1" });
    });

    it("ignores a late remembered-voice rename from the old meeting", async () => {
      configureTwoMeetings();
      const remembered = deferred<{ profileId: string; displayName: string }>();
      backend.suggestSpeakerVoices.mockResolvedValue({
        enabled: true,
        clusters: [{ speakerId: "speaker_0", appliedProfileId: null, matchState: null, suggestion: null }],
        nameOptions: [],
      });
      backend.rememberSpeakerVoice.mockReturnValueOnce(remembered.promise);
      render(<RecordingsView />);
      const renameFromA = await openWeeklySpeakerCallback();
      await waitFor(() => expect(transcriptViewerProps.current?.speakerVoices).toHaveProperty("speaker_0"));
      const pending = renameFromA("speaker_0", "Dana", true);
      expect(backend.rememberSpeakerVoice).toHaveBeenCalledWith({
        recordingId: "r1",
        speakerId: "speaker_0",
        name: "Dana",
      });

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await waitFor(() => expect(transcriptViewerProps.current?.speakerNames).toEqual({
        speaker_0: "Speaker B",
      }));
      await act(async () => remembered.resolve({ profileId: "p-dana", displayName: "Dana" }));
      await pending;

      expect(transcriptViewerProps.current.speakerNames).toEqual({ speaker_0: "Speaker B" });
    });

    it("rejects persistence failure and allows the badge to retry", async () => {
      backend.getSpeakers.mockResolvedValue([
        { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
      ]);
      backend.renameSpeaker
        .mockRejectedValueOnce(new Error("Alias write failed"))
        .mockResolvedValueOnce(undefined);
      render(<RecordingsView />);
      const renameCurrent = await openWeeklySpeakerCallback();

      await act(async () => {
        await expect(renameCurrent("speaker_0", "Alice")).rejects.toThrow("Alias write failed");
      });
      expect(transcriptViewerProps.current.speakerNames).toEqual({ speaker_0: "Speaker 1" });

      await act(async () => {
        await renameCurrent("speaker_0", "Alice");
      });
      await waitFor(() => expect(transcriptViewerProps.current.speakerNames).toEqual({
        speaker_0: "Alice",
      }));
      expect(backend.renameSpeaker).toHaveBeenCalledTimes(2);
    });

    it("asks again for voice suggestions when the speakers are labelled after opening", async () => {
      backend.getSpeakers.mockResolvedValue([
        { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
      ]);
      render(<RecordingsView />);
      await openWeeklySpeakerCallback();
      await waitFor(() => expect(backend.suggestSpeakerVoices).toHaveBeenCalledWith("r1"));
      const before = backend.suggestSpeakerVoices.mock.calls.length;

      await waitFor(() => expect(eventSubscribers.get("transcript-updated")?.size ?? 0).toBeGreaterThan(0));
      // Another meeting's update is not this meeting's business.
      act(() => {
        eventListeners.get("transcript-updated")?.({ payload: { recordingId: "other", reason: "diarization" } });
      });
      expect(backend.suggestSpeakerVoices.mock.calls.length).toBe(before);

      act(() => {
        eventListeners.get("transcript-updated")?.({ payload: { recordingId: "r1", reason: "diarization" } });
      });
      await waitFor(() => expect(backend.suggestSpeakerVoices.mock.calls.length).toBeGreaterThan(before));
    });

    it("keeps the committed name when remembered-voice metadata refresh fails", async () => {
      backend.getSpeakers.mockResolvedValue([
        { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
      ]);
      render(<RecordingsView />);
      const renameCurrent = await openWeeklySpeakerCallback();
      await waitFor(() => expect(backend.suggestSpeakerVoices).toHaveBeenCalledWith("r1"));
      backend.suggestSpeakerVoices.mockRejectedValueOnce(new Error("Voice metadata unavailable"));
      toast.mockClear();

      await act(async () => {
        await renameCurrent("speaker_0", "Alice");
      });

      expect(transcriptViewerProps.current.speakerNames).toEqual({ speaker_0: "Alice" });
      expect(toast).toHaveBeenCalledWith(
        "Speaker name saved, but remembered-voice details could not refresh.",
        "info",
      );
      expect(toast).not.toHaveBeenCalledWith("Voice metadata unavailable", "error");
    });
  });

  describe("transcript deletion ownership", () => {
    const provenanceFor = (recordingId: string, quote: string) => ({
      version: 1,
      groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
      contentHash: `v1:sha256:${recordingId}`,
      actualProvider: "ollama",
      actualModel: "local-test",
      promptSource: "test",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [{ text: quote, recordingId, startTime: 0, endTime: 5 }],
      grounded: true,
    });

    beforeEach(() => {
      backend.deleteTranscriptSegments.mockReset().mockResolvedValue(1);
    });

    const openMeetingWithProvenance = async (quote = "A grounded quote") => {
      const provenance = provenanceFor("r1", quote);
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "Grounded summary",
        actionItems: [],
        summaryProvenance: provenance,
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByText(quote);
      return transcriptViewerProps.current.onDeleteSegments as (
        segmentIds: string[],
        expectedSegments?: Array<{
          id: string;
          text: string;
          startTime: number;
          endTime: number;
          speakerId: string | null;
        }>,
      ) => Promise<void>;
    };

    it("points at summary statements that name people or products the meeting never mentioned", async () => {
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "Grounded summary",
        actionItems: [],
        summaryProvenance: {
          ...provenanceFor("r1", "A grounded quote"),
          grounded: false,
          unverifiedStatements: [
            { statement: "Marcus will check GDPR.", unknownNames: ["Marcus", "GDPR"] },
          ],
        },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const list = await screen.findByTestId("unverified-summary-statements");
      expect(list).toHaveTextContent("Marcus will check GDPR.");
      expect(list).toHaveTextContent("These names do not appear anywhere in this meeting:");
      expect(list).toHaveTextContent('"Marcus", "GDPR"');
    });

    it("asks for a transcript check on summary statements no source line supports", async () => {
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "Grounded summary",
        actionItems: [],
        summaryProvenance: {
          ...provenanceFor("r1", "A grounded quote"),
          grounded: false,
          unverifiedStatements: [
            { statement: "Its casing is waterproof.", kind: "unsupported", unknownNames: [] },
            { statement: "Marcus will check GDPR.", kind: "invented_name", unknownNames: ["Marcus", "GDPR"] },
          ],
        },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const list = await screen.findByTestId("unverified-summary-statements");
      expect(list).toHaveTextContent("Check this against the transcript:");
      expect(list).toHaveTextContent("Its casing is waterproof.");
      expect(list).toHaveTextContent("These names do not appear anywhere in this meeting:");
      expect(list).toHaveTextContent('"Marcus", "GDPR"');
      expect(list).not.toHaveTextContent('""');
    });

    it("shows unsupported numbers and dates without calling them names", async () => {
      backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "The budget is $45,000 by Thursday.", actionItems: [],
        summaryProvenance: { ...provenanceFor("r1", "A grounded quote"), grounded: false,
          unverifiedStatements: [{ statement: "The budget is $45,000 by Thursday.", kind: "unknown_fact", unknownNames: [], unknownFacts: ["$45,000", "Thursday"] }] } });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const list = await screen.findByTestId("unverified-summary-statements");
      expect(list).toHaveTextContent("Not found in the transcript: $45,000, Thursday");
      expect(list).not.toHaveTextContent("These names do not appear");
    });

    it("propagates persistence failure and keeps current provenance", async () => {
      backend.deleteTranscriptSegments.mockRejectedValueOnce(new Error("Transcript delete failed"));
      const remove = await openMeetingWithProvenance();

      await act(async () => {
        await expect(remove(["s1"])).rejects.toThrow("Transcript delete failed");
      });

      expect(backend.deleteTranscriptSegments).toHaveBeenCalledWith("r1", ["s1"]);
      expect(screen.getByText("A grounded quote")).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith("Transcript delete failed", "error");
    });

    it("forwards the quoted transcript expectations to the guarded delete", async () => {
      const remove = await openMeetingWithProvenance();
      const expectedSegments = [{
        id: "s1",
        text: "Original row",
        startTime: 1,
        endTime: 2,
        speakerId: "speaker-a",
      }];

      await act(async () => {
        await remove(["s1"], expectedSegments);
      });

      expect(backend.deleteTranscriptSegments).toHaveBeenCalledWith(
        "r1",
        ["s1"],
        expectedSegments,
      );
    });

    it.each(["", "Error invoking remote method 'sidecar:invoke': Error: "])(
      "refreshes current transcript rows after a guarded conflict and preserves the rejection: %s", async (prefix) => {
      const conflict = new Error(
        `${prefix}Transcript changed. Review the current turn before deleting it.`,
      );
      backend.deleteTranscriptSegments.mockRejectedValueOnce(conflict);
      const remove = await openMeetingWithProvenance();
      backend.getTranscript.mockResolvedValue({
        id: "t1",
        recordingId: "r1",
        segments: [{
          id: "s1",
          startTime: 0,
          endTime: 5,
          text: "Changed in another window",
          confidence: 0.9,
          speakerId: null,
        }],
        fullText: "Changed in another window",
        language: "en",
        confidence: 0.9,
        model: "distil-whisper",
      });

      await act(async () => {
        await expect(remove(["s1"], [{
          id: "s1",
          text: "Transcript",
          startTime: 0,
          endTime: 5,
          speakerId: null,
        }])).rejects.toBe(conflict);
      });

      await waitFor(() =>
        expect(transcriptViewerProps.current.segments[0].text).toBe(
          "Changed in another window",
        ),
      );
      expect(screen.getByText("A grounded quote")).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith("Transcript changed. Review the current turn before deleting it.", "error");
    });

    it("rejects an unconfirmed zero-row deletion", async () => {
      backend.deleteTranscriptSegments.mockResolvedValueOnce(0);
      const remove = await openMeetingWithProvenance();

      await act(async () => {
        await expect(remove(["s1"])).rejects.toThrow(
          "Plainsong could not confirm that transcript text was removed. The original text is still shown.",
        );
      });

      expect(screen.getByText("A grounded quote")).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith(
        "Plainsong could not confirm that transcript text was removed. The original text is still shown.",
        "error",
      );
    });

    it("does not clear meeting B provenance or show A's late success", async () => {
      const deletion = deferred<number>();
      backend.deleteTranscriptSegments.mockReturnValueOnce(deletion.promise);
      const launchReview = {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
      } as Recording;
      recordings = [recordings[0], launchReview];
      backend.getRecording.mockImplementation(async (recordingId: string) => ({
        ...(recordingId === "r1" ? recordings[0] : launchReview),
        summary: `${recordingId} summary`,
        actionItems: [],
        summaryProvenance: provenanceFor(
          recordingId,
          recordingId === "r1" ? "A grounded quote" : "B grounded quote",
        ),
      }));
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByText("A grounded quote");
      const removeFromA = transcriptViewerProps.current.onDeleteSegments as (
        segmentIds: string[],
      ) => Promise<void>;
      const pending = removeFromA(["s1"]);

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await screen.findByText("B grounded quote");
      await act(async () => deletion.resolve(1));
      await pending;

      expect(screen.getByText("B grounded quote")).toBeInTheDocument();
      expect(toast).not.toHaveBeenCalledWith("Transcript section removed.", "success");
    });

    it("clears current provenance and reports a confirmed removal", async () => {
      const remove = await openMeetingWithProvenance();

      await act(async () => {
        await remove(["s1"]);
      });

      expect(screen.queryByText("A grounded quote")).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith("Transcript section removed.", "success");
    });

    it("keeps a committed deletion successful when refresh fails", async () => {
      const remove = await openMeetingWithProvenance();
      backend.getRecording.mockRejectedValueOnce(new Error("Refresh failed"));

      await act(async () => {
        await expect(remove(["s1"])).resolves.toBeUndefined();
      });

      expect(screen.queryByText("A grounded quote")).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith(
        "Transcript section removed, but the meeting could not refresh. Reopen it to load the saved transcript.",
        "info",
      );
      expect(backend.deleteTranscriptSegments).toHaveBeenCalledTimes(1);
    });
  });

  it("offers a retry-transcription entry point in the row menu for meetings stuck in error", async () => {
    recordings[0] = { ...recordings[0], status: "error" as const };
    backend.retranscribeRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry transcription" }));

    await waitFor(() => {
      expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1");
    });
  });

  it("offers a retry-transcription entry point in the meeting detail panel when errored", async () => {
    recordings[0] = { ...recordings[0], status: "error" as const };
    backend.getRecording.mockResolvedValue({ ...recordings[0] });
    backend.getTranscript.mockResolvedValueOnce(null);
    backend.retranscribeRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    // The transcript is a pane beside the record, not a tab behind it.
    fireEvent.click(await screen.findByRole("button", { name: "Retry transcription" }));

    await waitFor(() => {
      expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1");
    });
  });

  it("shows a pending transcript with a retry from saved audio", async () => {
    recordings[0] = { ...recordings[0], status: "pending", transcriptComplete: false,
      transcriptDegradedReason: "Transcription is pending. The recording is saved. Free some memory, then retry transcription." };
    backend.getRecording.mockResolvedValue({ ...recordings[0] });
    backend.getTranscript.mockResolvedValue(null);
    backend.retranscribeRecording.mockResolvedValue(undefined);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const retry = await screen.findByRole("button", { name: "Retry transcription" });
    expect(screen.getAllByText("Transcription pending").length).toBeGreaterThan(0);
    expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1"));
  });

  it("offers a completed meeting a way back from its audio, and asks before replacing the transcript", async () => {
    // Deleting transcript text is permanent and keeps no snapshot, so the only
    // recovery is re-deriving it from the audio. Gating that on status ===
    // "error" meant a completed meeting could never be re-derived at all.
    backend.retranscribeRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Re-transcribe from audio" }));

    // It overwrites hand-corrected turns, so it is asked about first.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Re-transcribe from the saved audio?");
    expect(dialog).toHaveTextContent("Weekly sync");
    expect(dialog).toHaveTextContent(/replaces the whole transcript/i);
    expect(backend.retranscribeRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Replace and re-transcribe" }));

    await waitFor(() => {
      expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1");
    });
  });

  it("keeps the transcript when the re-transcribe confirmation is declined", async () => {
    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Re-transcribe from audio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep this transcript" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(backend.retranscribeRecording).not.toHaveBeenCalled();
  });

  it("does not offer re-transcription when there is no audio left to re-derive from", async () => {
    recordings[0] = { ...recordings[0], audioPath: undefined } as Recording;

    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(
      screen.queryByRole("menuitem", { name: "Re-transcribe from audio" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Retry transcription" })).not.toBeInTheDocument();
  });

  it.each([
    { name: "capture loss", transcriptComplete: false, captureLoss: true,
      explanation: "Part of this meeting was not captured. Review this result against the available transcript and notes before sharing." },
    { name: "capture warning only", transcriptComplete: true, captureLoss: true,
      explanation: "Part of this meeting was not captured. Review this result against the available transcript and notes before sharing." },
    { name: "incomplete transcript", transcriptComplete: false, captureLoss: false,
      explanation: "This transcript is incomplete. Review this result against the available transcript and notes before sharing." },
    { name: "unknown cause", transcriptComplete: true, captureLoss: false, explanation: null },
  ])("explains recap review from $name without blaming supported quotes", async ({ transcriptComplete, captureLoss, explanation }) => {
    const citation = { text: "Saved supported quote", recordingId: "r1", startTime: 15, endTime: 21 };
    const provenance = {
      version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
      contentHash: "v1:sha256:fixture", actualProvider: "ollama", actualModel: "fixture",
      promptSource: "fixture", completedAt: "2026-07-25T12:00:00.000Z",
      citations: [citation], grounded: false,
    };
    backend.getRecording.mockResolvedValue({
      ...recordings[0], summary: "Saved summary", actionItems: ["Saved follow-up"],
      transcriptComplete,
      captureDegradedSummary: captureLoss ? "Saved capture loss" : null,
      summaryProvenance: provenance,
      actionItemsProvenance: { ...provenance, items: [{ generated: true, grounded: false, citations: [citation] }] },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    if (explanation) {
      await waitFor(() => expect(screen.getAllByText(explanation)).toHaveLength(2));
    } else {
      await screen.findByText("This summary needs review. Check its quoted sources before sharing.");
      expect(screen.getByText("This follow-up needs review. Check its quoted sources before sharing.")).toBeInTheDocument();
      expect(screen.queryByText(/Review this result against the available transcript and notes/)).not.toBeInTheDocument();
    }
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    const quotes = screen.getAllByRole("button", { name: /Saved supported quote/ });
    expect(quotes).toHaveLength(2);
    for (const quote of quotes) {
      expect(quote).toBeEnabled();
      expect(quote).toHaveTextContent("Unverified");
    }
    expect(screen.queryByText(/Some quoted lines could not be found/)).not.toBeInTheDocument();
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
  });

  it.each([
    ["recording", "Delete (stop recording first)"],
    ["processing", "Delete (wait for processing)"],
  ] as const)(
    "disables deletion while a meeting is %s",
    async (status, label) => {
      recordings[0] = { ...recordings[0], status } as Recording;

      render(<RecordingsView />);

      fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
        button: 0,
      });
      const deleteItem = await screen.findByRole("menuitem", { name: label });
      expect(deleteItem).toHaveAttribute("data-disabled");
      fireEvent.click(deleteItem);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(backend.deleteRecording).not.toHaveBeenCalled();
    }
  );

  describe("meeting deletion recovery", () => {
    async function openDeleteDialog() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
        button: 0,
      });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      return screen.findByRole("dialog", { name: "Delete this meeting?" });
    }

    it("blocks duplicate deletion and disables dismissal while pending", async () => {
      const deletion = deferred<void>();
      backend.deleteRecording.mockReturnValueOnce(deletion.promise);
      render(<RecordingsView />);
      const dialog = await openDeleteDialog();
      const deleteButton = within(dialog).getByRole("button", { name: "Delete" });
      const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });

      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      fireEvent.keyDown(dialog, { key: "Escape" });

      expect(backend.deleteRecording).toHaveBeenCalledTimes(1);
      expect(backend.deleteRecording).toHaveBeenCalledWith("r1");
      expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
      expect(cancelButton).toBeDisabled();
      expect(screen.getByRole("dialog", { name: "Delete this meeting?" })).toBeInTheDocument();

      await act(async () => deletion.resolve());
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Delete this meeting?" })).not.toBeInTheDocument();
      });
    });

    it("says the meeting was deleted and puts focus back on the list", async () => {
      backend.deleteRecording.mockResolvedValueOnce(undefined);
      render(<RecordingsView />);
      const dialog = await openDeleteDialog();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Delete this meeting?" })).not.toBeInTheDocument();
      });
      expect(toast).toHaveBeenCalledWith("Deleted “Weekly sync”.", "success");
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Meetings" }));
      });
    });

    it("keeps the confirmed meeting and inline error available for retry", async () => {
      backend.deleteRecording
        .mockRejectedValueOnce(new Error("Database is locked"))
        .mockResolvedValueOnce(undefined);
      render(<RecordingsView />);
      const dialog = await openDeleteDialog();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Database is locked");
      expect(dialog).toHaveTextContent("Weekly sync");
      expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(refetchRecordings).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Delete this meeting?" })).not.toBeInTheDocument();
      });
      expect(backend.deleteRecording).toHaveBeenCalledTimes(2);
    });

    it("closes the workspace only when the open meeting was deleted", async () => {
      const deletion = deferred<void>();
      backend.deleteRecording.mockReturnValueOnce(deletion.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByLabelText("Meeting title");
      const dialog = await openDeleteDialog();
      backend.updateRecordingNotes.mockClear();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await act(async () => deletion.resolve());

      await waitFor(() => {
        expect(screen.queryByLabelText("Meeting title")).not.toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument();
      expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    });

    it("keeps meeting B open when deletion of meeting A finishes", async () => {
      const deletion = deferred<void>();
      const launchReview = {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
      } as Recording;
      recordings = [recordings[0], launchReview];
      backend.getRecording.mockImplementation(async (recordingId: string) => ({
        ...(recordingId === "r1" ? recordings[0] : launchReview),
        summary: `${recordingId} summary`,
        actionItems: [],
      }));
      backend.deleteRecording.mockReturnValueOnce(deletion.promise);
      render(<RecordingsView />);
      const meetingOptions = screen.getAllByRole("button", { name: "Meeting options" });
      fireEvent.pointerDown(meetingOptions.at(-1)!, { button: 0 });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      const dialog = await screen.findByRole("dialog", { name: "Delete this meeting?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      act(() => {
        window.dispatchEvent(new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: "r2" },
        }));
      });
      await waitFor(() => expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review"));
      await act(async () => deletion.resolve());

      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
      expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
    });

    it("reports a refresh failure as an already completed deletion", async () => {
      refetchRecordings.mockRejectedValueOnce(new Error("Refresh failed"));
      render(<RecordingsView />);
      const dialog = await openDeleteDialog();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Delete this meeting?" })).not.toBeInTheDocument();
      });
      expect(refetchRecordings).toHaveBeenCalledTimes(1);
      expect(backend.deleteRecording).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });
  });

  it("only promises the transcript can be re-derived when the audio is still attached", async () => {
    const { unmount } = render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => {
      expect(transcriptViewerProps.current?.deleteRecoveryNote).toMatch(
        /Re-transcribe from audio/
      );
    });
    unmount();

    // With no audio on disk there is no way back, and the delete confirmation
    // must not claim one.
    transcriptViewerProps.current = null;
    recordings[0] = { ...recordings[0], audioPath: undefined } as Recording;
    backend.getRecording.mockResolvedValue({ ...recordings[0] });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() => {
      expect(transcriptViewerProps.current).not.toBeNull();
    });
    expect(transcriptViewerProps.current?.deleteRecoveryNote).toBeUndefined();
  });

  it("persists edited summary and action item blocks from the notes tab", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "User-edited recap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: { value: "Follow up with design\nShip release notes" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", {
        summary: "User-edited recap",
        actionItems: ["Follow up with design", "Ship release notes"],
      });
    });
  });

  describe("meeting summary copy", () => {
    it("copies the exact current edited summary without generating or exporting", async () => {
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "Saved summary",
        actionItems: [],
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByLabelText("Summary");
      const exact = "  Edited summary first line.\n\nSecond  line stays.  ";
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), {
        target: { value: exact },
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy Summary" }));

      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(exact),
      );
      expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
      expect(backend.exportRecordingV2).not.toHaveBeenCalled();
    });

    it("prefixes an ungrounded generated summary but drops the warning after user editing", async () => {
      const generated = "Generated summary.\n\nCheck the final decision.";
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: generated,
        actionItems: [],
        summaryProvenance: {
          version: 1,
          groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
          contentHash: "v1:sha256:ungrounded-summary",
          actualProvider: "ollama",
          actualModel: "local-test",
          promptSource: "meeting_playbook:auto",
          completedAt: "2026-07-25T12:00:00.000Z",
          citations: [],
          grounded: false,
        },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByLabelText("Summary");
      const warning =
        "Needs review: Check the summary against the meeting transcript and notes before relying on it.";

      fireEvent.click(screen.getByRole("button", { name: "Copy Summary" }));
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
          `${warning}\n\n${generated}`,
        ),
      );

      const edited = "  My corrected summary.\n\nKeep this exact ending.  ";
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), {
        target: { value: edited },
      });
      fireEvent.click(screen.getByRole("button", { name: "Copy Summary" }));

      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(edited),
      );
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    });
  });

  it("regenerates summary and action items into the readable record", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "",
      actionItems: [],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
    // The recap is set down as a document, not parked in a text box.
    expect(await screen.findByText("Fresh grounded summary")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Fresh grounded summary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate action items" }));

    await waitFor(() => {
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });
    // Once in the record, once again in the evidence rows underneath it.
    expect(
      (await screen.findAllByText("Ship launch checklist (Owner: Jon · Due: Friday)")).length
    ).toBeGreaterThan(0);
  });

  it("keeps regenerate-again and regenerate-with-another-playbook as separate buttons", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "",
      actionItems: [],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    // Plain regenerate never asks which playbook: it repeats the one already
    // chosen, so a retry costs one click.
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
    expect(backend.updateRecordingTemplate).not.toHaveBeenCalled();

    // The other button changes the playbook first — and it has to land before
    // the request, because the summariser reads the playbook off the record.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Regenerate summary with a different playbook" }),
      { button: 0 }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Standup" }));

    await waitFor(() => {
      expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup");
    });
    expect(
      backend.updateRecordingTemplate.mock.invocationCallOrder[0]
    ).toBeLessThan(backend.summarizeRecordingGrounded.mock.invocationCallOrder[1]);
  });

  it("restores only the previous summary, preserving current notes and tasks", async () => {
    backend.getSummaryRegenerationUndo.mockResolvedValue({ canUndo: true, undoToken: "rewrite-1" });
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "New AI recap", meetingNotes: "Keep my notes", actionItems: ["Keep my task"] });
    backend.undoSummaryRegeneration.mockResolvedValue({ ...recordings[0], summary: "Previous authored recap", meetingNotes: "Stale server notes", actionItems: ["Stale server task"] });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("New AI recap")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Restore previous summary" }));
    expect(await screen.findByText("Previous authored recap")).toBeInTheDocument();
    expect(backend.undoSummaryRegeneration).toHaveBeenCalledWith("r1", "rewrite-1");
    expect(screen.getByText("Keep my task")).toBeInTheDocument();
    expect(screen.queryByText("Stale server task")).not.toBeInTheDocument();
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
  });

  it("keeps the visible summary if undo refuses a stale rewrite", async () => {
    backend.getSummaryRegenerationUndo.mockResolvedValue({ canUndo: true, undoToken: "old-rewrite" });
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Current recap" });
    backend.undoSummaryRegeneration.mockRejectedValueOnce(new Error("The summary changed after regeneration."));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Current recap")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Restore previous summary" }));
    await waitFor(() => expect(backend.undoSummaryRegeneration).toHaveBeenCalled());
    expect(screen.getByText("Current recap")).toBeInTheDocument();
  });

  it("disables undo while editing the summary", async () => {
    backend.getSummaryRegenerationUndo.mockResolvedValue({ canUndo: true, undoToken: "rewrite-1" });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const undo = await screen.findByRole("button", { name: "Restore previous summary" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    expect(undo).toBeDisabled();
    fireEvent.click(undo);
    expect(backend.undoSummaryRegeneration).not.toHaveBeenCalled();
  });

  it("saves the visible draft before a fast regeneration can replace it", async () => {
    let finishSave!: () => void;
    backend.updateRecordingAnalysis.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "My newest draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { summary: "My newest draft." }));
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Summary")).toHaveAttribute("readonly");
    finishSave();
    await waitFor(() => expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1"));
    expect(backend.updateRecordingAnalysis.mock.invocationCallOrder[0]).toBeLessThan(backend.summarizeRecordingGrounded.mock.invocationCallOrder[0]);
  });

  it("keeps a newer playbook choice while regeneration waits for an analysis save", async () => {
    const analysisSave = deferred<void>();
    backend.updateRecordingAnalysis.mockReturnValueOnce(analysisSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Save this summary first." } });
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", {
      summary: "Save this summary first.",
    }));

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Regenerate summary with a different playbook" }),
      { button: 0 }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Standup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveAttribute("readonly"));
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "sales" } });

    await act(async () => { analysisSave.resolve(); await analysisSave.promise; });
    await waitFor(() => expect(screen.getByLabelText("Playbook")).toHaveValue("sales"));
    expect(backend.updateRecordingTemplate).not.toHaveBeenCalledWith("r1", "standup");
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
  });

  it("keeps the draft and skips regeneration when saving it fails", async () => {
    backend.updateRecordingAnalysis.mockRejectedValue(new Error("Draft save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Keep my unsaved draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalled());
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Summary")).toHaveValue("Keep my unsaved draft.");
  });

  it("does not start regeneration after leaving while a draft save is pending", async () => {
    let finishSave!: () => void;
    backend.updateRecordingAnalysis.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Draft before leaving." } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    finishSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
  });

  it("keeps the latest draft when an older autosave finishes and the flush fails", async () => {
    let finishOlderSave!: () => void;
    backend.updateRecordingAnalysis.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOlderSave = resolve; }));
    backend.updateRecordingAnalysis.mockRejectedValue(new Error("Latest draft save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Older draft." } });
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { summary: "Older draft." }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Latest draft must stay." } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    finishOlderSave();
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { summary: "Latest draft must stay." }));
    expect(screen.getByLabelText("Summary")).toHaveValue("Latest draft must stay.");
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();
  });

  it("warns before a regeneration overwrites text Plainsong did not write", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "My own recap, typed by hand." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));

    expect(
      await screen.findByText(/Regenerating the summary replaces the summary you wrote/i)
    ).toBeInTheDocument();
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep what I have" }));
    await waitFor(() => {
      expect(
        screen.queryByText(/Regenerating the summary replaces/i)
      ).not.toBeInTheDocument();
    });
    expect(backend.summarizeRecordingGrounded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
  });

  it("does not replace the visible summary when grounded refresh fails to persist", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Saved summary",
      actionItems: ["Existing follow-up"],
    });
    backend.summarizeRecordingGrounded.mockRejectedValueOnce(
      new Error("Disk write failed")
    );

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Saved summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();

    expect(screen.getByText("Saved summary")).toBeInTheDocument();
    expect(screen.queryByText("Fresh grounded summary")).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Disk write failed", "error");
  });

  it("persists template changes and can apply the matching notes outline", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("group", { name: "Meeting notes" });

    fireEvent.change(screen.getByLabelText("Playbook"), {
      target: { value: "standup" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup");
    });

    fireEvent.click(screen.getByRole("button", { name: "Add its headings to my notes" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Done\n- \n\nPlanned next\n- \n\nBlockers\n- \n\nOwners\n- ", undefined, expect.any(String));
    });
    expect(screen.getByLabelText("Done notes")).toHaveValue("");
    expect(screen.getByLabelText("Blockers notes")).toHaveValue("");
  });

  describe("user-defined meeting templates", () => {
    it("lists a saved custom template in the playbook picker, labeled as the user's own", async () => {
      customMeetingTemplatesState.templates = [
        {
          id: "custom-board-update",
          name: "Board Update",
          summaryPrompt: "Summarize board sentiment, asks, and follow-ups.",
          notesOutline: ["Sentiment", "Asks"],
        },
      ];

      render(<RecordingsView />);

      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      const picker = screen.getByLabelText("Playbook") as HTMLSelectElement;
      expect(
        within(picker).getByRole("option", { name: "Board Update" })
      ).toBeInTheDocument();

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Regenerate summary with a different playbook" }),
        { button: 0 }
      );
      expect(
        await screen.findByRole("menuitem", { name: "Board Update (yours)" })
      ).toBeInTheDocument();
    });

    it("falls back to the active playbook's outline when saving as a template with no note text", async () => {
      render(<RecordingsView />);

      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      fireEvent.click(screen.getByRole("button", { name: "Save as a template" }));
      const dialog = await screen.findByRole("dialog", { name: "Save as a template" });

      fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "Weekly Recipe" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));

      await waitFor(() => {
        expect(backend.updateSettings).toHaveBeenCalled();
      });
      expect(customMeetingTemplatesState.templates).toHaveLength(1);
      expect(customMeetingTemplatesState.templates[0]).toMatchObject({
        name: "Weekly Recipe",
        // "Weekly sync" has no meetingNotes, so there is no note structure to
        // capture -- the active ("auto") playbook's outline is the only
        // sensible seed.
        notesOutline: ["Goals", "Key discussion points", "Decisions", "Follow-ups"],
      });
      expect(
        within(screen.getByLabelText("Playbook") as HTMLSelectElement).getByRole("option", {
          name: "Weekly Recipe",
        })
      ).toBeInTheDocument();
    });

    it("captures the note's own section structure, not just the playbook outline, when notes are not empty", async () => {
      render(<RecordingsView />);

      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("button", { name: "Add section" });

      // A section the user added by hand -- absent from the "auto" playbook's
      // fixed four headings.
      fireEvent.click(screen.getByRole("button", { name: "Add section" }));
      fireEvent.change(screen.getByDisplayValue("Custom section"), {
        target: { value: "Budget ask" },
      });
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Save as a template" }));
      const dialog = await screen.findByRole("dialog", { name: "Save as a template" });
      const outlineField = within(dialog).getByLabelText(
        "Notes outline"
      ) as HTMLTextAreaElement;
      const outlineLines = outlineField.value.split("\n");

      // The user's own section made it into the seed...
      expect(outlineLines).toContain("Budget ask");
      // ...alongside the playbook's own headings, not instead of them -- a
      // bug that fell back to the static playbook outline unconditionally
      // would never include "Budget ask" at all.
      expect(outlineLines.length).toBeGreaterThan(4);

      fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "My Recipe" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));

      await waitFor(() => {
        expect(customMeetingTemplatesState.templates[0]?.notesOutline).toContain(
          "Budget ask"
        );
      });
    });

    it("re-reads persisted settings after saving and warns instead of trusting the optimistic value", async () => {
      // Simulate Rust's save-time sanitization actually changing what was
      // sent (a name too long, in this case) -- the client's own maxLength
      // is a UX nicety, not the only line of defense, so this view must not
      // report success on the optimistic value without checking.
      backend.updateSettings.mockImplementationOnce(async (mutate: any) => {
        const settings = { transcription: { meetingCustomTemplates: structuredClone(customMeetingTemplatesState.templates) } };
        mutate(settings);
        customMeetingTemplatesState.templates =
          settings.transcription.meetingCustomTemplates.map((template: any) => ({
            ...template,
            name: template.name.slice(0, 5),
          }));
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      fireEvent.click(screen.getByRole("button", { name: "Save as a template" }));
      const dialog = await screen.findByRole("dialog", { name: "Save as a template" });
      fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "A Very Long Template Name" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));

      await waitFor(() => {
        expect(customMeetingTemplatesState.templates[0]?.name).toBe("A Ver");
      });
      // This view's own state reflects what actually got persisted, not the
      // optimistic value it sent -- the picker offers the trimmed name.
      await waitFor(() => {
        expect(
          within(screen.getByLabelText("Playbook") as HTMLSelectElement).getByRole(
            "option",
            { name: "A Ver" }
          )
        ).toBeInTheDocument();
      });
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/too long or otherwise invalid and got trimmed/i),
        "info"
      );
    });

    it("caps the name and summary prompt fields to the same limits Rust enforces on save", async () => {
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      fireEvent.click(screen.getByRole("button", { name: "Save as a template" }));
      const dialog = await screen.findByRole("dialog", { name: "Save as a template" });

      expect(within(dialog).getByLabelText("Name")).toHaveAttribute("maxLength", "80");
      expect(within(dialog).getByLabelText("Summary prompt")).toHaveAttribute(
        "maxLength",
        "4000"
      );
    });

    it("warns softly about a duplicate template name without blocking the save", async () => {
      customMeetingTemplatesState.templates = [
        {
          id: "custom-existing",
          name: "Board Update",
          summaryPrompt: "Summarize.",
          notesOutline: ["Notes"],
        },
      ];

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      fireEvent.click(screen.getByRole("button", { name: "Save as a template" }));
      const dialog = await screen.findByRole("dialog", { name: "Save as a template" });
      fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "Board Update" },
      });

      expect(
        within(dialog).getByText(/already have a template named/i)
      ).toBeInTheDocument();

      // A soft warning, not a block -- two templates sharing a name still
      // both save; only their ids need to be unique.
      fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));
      await waitFor(() => {
        expect(customMeetingTemplatesState.templates).toHaveLength(2);
      });
    });

    it("edits and deletes a saved custom template from the manage dialog", async () => {
      customMeetingTemplatesState.templates = [
        {
          id: "custom-board-update",
          name: "Board Update",
          summaryPrompt: "Summarize board sentiment, asks, and follow-ups.",
          notesOutline: ["Sentiment", "Asks"],
        },
      ];

      render(<RecordingsView />);

      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });

      fireEvent.click(screen.getByRole("button", { name: "Manage templates" }));
      const manageDialog = await screen.findByRole("dialog", {
        name: "Your meeting templates",
      });
      fireEvent.click(within(manageDialog).getByRole("button", { name: "Edit Board Update" }));

      const editDialog = await screen.findByRole("dialog", { name: "Edit template" });
      fireEvent.change(within(editDialog).getByLabelText("Name"), {
        target: { value: "Board Update v2" },
      });
      fireEvent.click(within(editDialog).getByRole("button", { name: "Save changes" }));

      await waitFor(() => {
        expect(customMeetingTemplatesState.templates[0]?.name).toBe("Board Update v2");
      });

      fireEvent.click(screen.getByRole("button", { name: "Manage templates" }));
      const reopenedManageDialog = await screen.findByRole("dialog", {
        name: "Your meeting templates",
      });
      fireEvent.click(
        within(reopenedManageDialog).getByRole("button", { name: "Delete Board Update v2" })
      );
      const confirmDialog = await screen.findByRole("dialog", {
        name: "Delete this template?",
      });
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(customMeetingTemplatesState.templates).toHaveLength(0);
      });
    });

    it("does not break a past meeting's display after its custom template is deleted through the manage dialog", async () => {
      customMeetingTemplatesState.templates = [
        {
          id: "custom-deleted-later",
          name: "Retiring Soon",
          summaryPrompt: "Summarize this.",
          notesOutline: ["Notes"],
        },
      ];
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingTemplateId: "custom-deleted-later",
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("group", { name: "Meeting notes" });
      const picker = screen.getByLabelText("Playbook") as HTMLSelectElement;
      expect(picker).toHaveValue("custom-deleted-later");
      expect(
        within(picker).getByRole("option", { name: "Retiring Soon" })
      ).toBeInTheDocument();

      // Driven through the manager dialog's own delete button and its
      // confirmation step -- not by mutating the mock directly -- so this
      // proves the delete affordance itself does the right thing, not just
      // that the workspace tolerates an externally-vanished template.
      fireEvent.click(screen.getByRole("button", { name: "Manage templates" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Delete Retiring Soon" })
      );
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(customMeetingTemplatesState.templates).toHaveLength(0);
      });

      // Back to the still-open meeting: its picker no longer offers the
      // deleted template -- it falls back to a resolvable value instead of
      // showing a phantom selection -- and the workspace itself never
      // stopped displaying.
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => {
        expect(
          within(picker).queryByRole("option", { name: "Retiring Soon" })
        ).not.toBeInTheDocument();
      });
      expect(screen.getByRole("group", { name: "Meeting notes" })).toBeInTheDocument();
    });
  });

  it.each([
    { summary: "Saved summary", actions: [], summaryGrounded: undefined, actionsGrounded: undefined, label: "Summary written", detail: "The summary is written. No action items are listed." },
    { summary: "", actions: ["Send notes"], summaryGrounded: undefined, actionsGrounded: undefined, label: "Actions written", detail: "Action items are listed. No summary is written." },
    { summary: "Saved summary", actions: ["Send notes"], summaryGrounded: true, actionsGrounded: true, label: "Recap ready", detail: "Key lines and next steps are quoted from the transcript. Check them before sharing." },
    { summary: "Saved summary", actions: [], summaryGrounded: false, actionsGrounded: undefined, label: "Needs review", detail: "Check the summary against the quoted sources before sharing." },
    { summary: "Saved summary", actions: ["Send notes"], summaryGrounded: true, actionsGrounded: false, label: "Needs review", detail: "Check the action items against the quoted sources before sharing." },
    { summary: "Saved summary", actions: ["Send notes"], summaryGrounded: false, actionsGrounded: false, label: "Needs review", detail: "Check the summary and action items against the quoted sources before sharing." },
    { summary: "Saved summary", actions: [], summaryGrounded: true, actionsGrounded: undefined, uncitedSummary: true, label: "Needs review", detail: "Check the summary against the quoted sources before sharing." },
    { summary: "", actions: [], notes: "Keep the legal condition.", noTranscript: true, label: "Notes only", detail: "Your notes are available below. This meeting has no transcript yet." },
    { summary: "", actions: [], notes: "", noTranscript: true, label: "Empty", detail: "This meeting has no transcript, notes, or summary yet." },
  ])("states the meeting header from its saved content and review flags: $detail", async ({ summary, actions, notes, noTranscript, summaryGrounded, actionsGrounded, uncitedSummary, label, detail }) => {
    const provenance = (grounded: boolean) => ({ version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "meeting_playbook:auto", completedAt: "2026-07-25T12:00:00.000Z", citations: [{text:"We are on track for launch, pending legal approval.",startTime:15,endTime:21,recordingId:"r1",certainty:0.97}], grounded });
    backend.getRecording.mockResolvedValue({
      ...recordings[0], summary, actionItems: actions, meetingNotes: notes,
      summaryProvenance: summaryGrounded === undefined ? undefined : { ...provenance(summaryGrounded), ...(uncitedSummary ? { citations: [] } : {}) },
      actionItemsProvenance: actionsGrounded === undefined ? undefined : { ...provenance(actionsGrounded), items: actions.map(item => ({ item, citations: provenance(actionsGrounded).citations, grounded: actionsGrounded })) },
    });
    if (noTranscript) backend.getTranscript.mockResolvedValue(null);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText(detail)).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Transcript only")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
    const quoteButtons = screen.queryAllByRole("button", {
      name: /We are on track for launch, pending legal approval/,
    });
    const expectedGrounding = [
      ...(summaryGrounded !== undefined && !uncitedSummary ? [summaryGrounded] : []),
      ...(actionsGrounded !== undefined ? actions.map(() => actionsGrounded) : []),
    ];
    expect(quoteButtons).toHaveLength(expectedGrounding.length);
    quoteButtons.forEach((button, index) => {
      expect(button).toBeEnabled();
      if (!expectedGrounding[index]) expect(button).toHaveTextContent("Unverified");
    });
  });

  it("explains why an older summary needs review while preserving its citations", async () => {
    const citation = { text: "We are on track for launch, pending legal approval.", recordingId: "r1", startTime: 15, endTime: 21 };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Older summary", actionItems: [], summaryProvenance: { version: 1, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "meeting_playbook:auto", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: false } });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("This summary has not been checked under the current meaning checks. Review it against the transcript or regenerate it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /We are on track for launch, pending legal approval/ })).toBeEnabled();
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Older summary");
  });

  it("shows review only on the ungrounded action item while preserving the grounded source control", async () => {
    const citation = {
      text: "Transcript",
      recordingId: "r1",
      startTime: 0,
      endTime: 5,
      certainty: 0.97,
    };
    const provenance = {
      version: 1,
      groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
      contentHash: "v1:sha256:mixed-actions",
      actualProvider: "ollama",
      actualModel: "local-test",
      promptSource: "meeting_playbook:auto",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [citation],
      grounded: false,
      items: [
        { item: "Ship the launch checklist", citations: [citation], grounded: true },
        { item: "Confirm the launch date", citations: [citation], grounded: false },
      ],
    };
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Saved summary",
      actionItems: ["Ship the launch checklist", "Confirm the launch date"],
      actionItemsProvenance: provenance,
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const actionRegion = await screen.findByRole("region", { name: "Action items" });
    await within(actionRegion).findByText("Confirm the launch date");

    const sourceRegion = screen.getByRole("heading", { name: "Where this came from" }).parentElement!;
    const evidence = within(sourceRegion);
    expect(evidence.getAllByRole("button", { name: /Transcript/ })).toHaveLength(2);
    const groundedEntry = evidence.getByText("Ship the launch checklist", { exact: true }).parentElement!;
    const ungroundedEntry = evidence.getByText("Confirm the launch date", { exact: true }).parentElement!;
    const groundedSource = within(groundedEntry).getByRole("button", { name: /Transcript/ });
    const ungroundedSource = within(ungroundedEntry).getByRole("button", { name: /Transcript/ });
    expect(groundedSource).toBeEnabled();
    expect(groundedSource).not.toHaveTextContent("Unverified");
    expect(within(groundedEntry).queryByText(/needs review/i)).not.toBeInTheDocument();
    expect(ungroundedSource).toBeEnabled();
    expect(ungroundedSource).toHaveTextContent("Unverified");
    const reviewMessage = "This follow-up needs review. Check its quoted sources before sharing.";
    expect(within(ungroundedEntry).getByText(reviewMessage, { exact: true })).toBeVisible();
    expect(evidence.getAllByText(reviewMessage, { exact: true })).toHaveLength(1);
  });

  it("uses aggregate grounding for legacy action provenance without per-item flags", async () => {
    const citation = {
      text: "Transcript",
      recordingId: "r1",
      startTime: 0,
      endTime: 5,
      certainty: 0.97,
    };
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Saved summary",
      actionItems: ["Ship the launch checklist"],
      actionItemsProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:legacy-actions",
        actualProvider: "ollama",
        actualModel: "local-test",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [citation],
        grounded: false,
        items: [{ item: "Ship the launch checklist", citations: [citation] }],
      },
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findAllByText("Ship the launch checklist");

    const source = within(screen.getByText("Where this came from").parentElement!).getByRole(
      "button",
      { name: /Transcript/ },
    );
    expect(source).toBeEnabled();
    expect(source).toHaveTextContent("Unverified");
  });

  it("keeps the meeting's working groups without the workflow narration", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    // The Solo Meeting Cockpit, the Review workflow card and the prose-only
    // advice tiles narrated the workflow instead of doing it.
    expect(screen.queryByText("Solo Meeting Cockpit")).not.toBeInTheDocument();
    expect(screen.queryByText("Review workflow")).not.toBeInTheDocument();
    expect(screen.queryByText("Best note pattern")).not.toBeInTheDocument();
    expect(screen.queryByText("Quick option")).not.toBeInTheDocument();
    expect(screen.queryByText("Best use")).not.toBeInTheDocument();

    // Everything that actually did something is still here.
    expect(screen.getAllByRole("button", { name: "Regenerate summary" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Regenerate action items" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Copy recap$/ })).toHaveLength(1);
    expect(await screen.findByText("Before the next one")).toBeInTheDocument();
    expect(screen.getByText("Ask across your earlier meetings")).toBeInTheDocument();
    expect(screen.getByText("Follow-up drafts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy follow-up email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read follow-up aloud" })).toBeInTheDocument();

    // Status is stated once, in the header, not restated per card.
    expect(screen.getAllByText("Recap ready")).toHaveLength(1);
  });

  it.each(["summary", "actions", "both"]) (
    "does not call a complete recap ready when %s verification is missing",
    async (missing) => {
      const citation = { text: "Send the proposal.", recordingId: "r1", startTime: 15, endTime: 21 };
      const provenance = { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: true };
      backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "The proposal is ready.", actionItems: ["Send the proposal."], summaryProvenance: missing === "actions" ? provenance : undefined, actionItemsProvenance: missing === "summary" ? { ...provenance, items: [{ generated: true, grounded: true, citations: [citation] }] } : undefined });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      expect(await screen.findByText("Recap ready")).toBeInTheDocument();
      expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
    },
  );

  it.each(["summary", "actions"])("rechecks visible %s after an edit instead of trusting the original citations", async (field) => {
    const citation = { text: "Send the proposal.", recordingId: "r1", startTime: 15, endTime: 21 };
    const provenance = { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: true };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "The proposal is ready.", actionItems: ["Send the proposal."], summaryProvenance: provenance, actionItemsProvenance: { ...provenance, items: [{ generated: true, grounded: true, citations: [citation] }] } });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Recap ready")).toBeInTheDocument();
    const sourceRegion = screen.getByRole("heading", { name: "Where this came from" }).parentElement!;
    const proposalCitations = () => within(sourceRegion).queryAllByRole("button", { name: /Send the proposal\./ });
    expect(proposalCitations()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: field === "summary" ? "Edit Summary" : "Edit Action items" }));
    fireEvent.change(screen.getByLabelText(field === "summary" ? "Summary" : "Action items"), {target:{value: field === "summary" ? "A different summary." : "Send the proposal.\nCall finance."}});
    expect(await screen.findByText("Recap ready")).toBeInTheDocument();
    expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
    // Editing removes the summary's source attribution; an added task must not
    // borrow citations from the existing task. The header makes no quality claim.
    await waitFor(() => expect(proposalCitations()).toHaveLength(field === "summary" ? 1 : 2));
    if (field === "actions") {
      expect(within(sourceRegion).queryByText("Call finance.", { exact: true })).not.toBeInTheDocument();
    }
  });

  it("does not certify a stored task whose written-note source has changed", async () => {
    const transcriptCitation = { text: "Send the proposal.", recordingId: "r1", startTime: 15, endTime: 21 };
    const noteCitation = { text: "Send the proposal.", recordingId: "r1", sourceKind: "meeting_note", segmentId: "meeting-note:0", startTime: null, endTime: null };
    const provenance = { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [transcriptCitation], grounded: true };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "The proposal is ready.", actionItems: ["Send the proposal."], meetingNotes: "Do not send the proposal.", summaryProvenance: provenance, actionItemsProvenance: { ...provenance, citations: [noteCitation], items: [{ generated: true, grounded: true, citations: [noteCitation] }] } });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
  });

  it("can read the meeting summary aloud from the review surface", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Canonical meeting summary");

    fireEvent.click(screen.getAllByRole("button", { name: "Read aloud" })[0]);

    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalled();
      expect(speechSynthesisMock.speak).toHaveBeenCalled();
    });
  });

  it("can read the meeting follow-up draft aloud from the review toolbar", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Canonical meeting summary");

    fireEvent.click(screen.getByRole("button", { name: "Read follow-up aloud" }));

    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalled();
      expect(speechSynthesisMock.speak).toHaveBeenCalled();
    });
  });

  it("runs cross-meeting recall from the meeting review sidebar", async () => {
    backend.askMemory.mockResolvedValueOnce({
      response: "The launch plan has remained the main follow-through risk.",
      citations: [
        {
          text: "Write the launch plan before Friday.",
          startTime: 10,
          endTime: 15,
          recordingId: "earlier-meeting",
          certainty: 0.92,
        },
      ],
    });
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    const input = await screen.findByLabelText("Ask across your earlier meetings");
    input.focus();
    fireEvent.change(input, {
      target: { value: "What has Jon cared about across recent meetings?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => {
      expect(backend.askMemory).toHaveBeenCalledWith(
        expect.stringContaining("What has Jon cared about across recent meetings?"),
        {
          excludeRecordingId: "r1",
          sourceType: "meeting",
          runId: expect.any(String),
          // Search for the question and the meeting's name, not the summary.
          searchQuery: "Weekly sync: What has Jon cared about across recent meetings?",
        }
      );
    });
    expect(
      await screen.findByText("The launch plan has remained the main follow-through risk.")
    ).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Earlier meetings answer status" })).toHaveTextContent("Answer ready");
    expect(screen.getByRole("region", { name: "Earlier meetings answer" })).toHaveTextContent("The launch plan");
    expect(input).toHaveFocus();
    const citation = screen.getByText("Write the launch plan before Friday.");
    expect(citation).toBeInTheDocument();
    expect(citation.parentElement).toHaveTextContent("earlier-meeting");
  });

  it("opens a recalled source outside the loaded library at its cited transcript position", async () => {
    const sourceMeeting = {
      ...recordings[0],
      id: "earlier-meeting",
      title: "Earlier launch review",
      audioPath: "/tmp/earlier-launch-review.wav",
    } as Recording;
    backend.askMemory.mockResolvedValueOnce({
      response: "The launch plan was assigned last week.",
      citations: [{
        text: "Write the launch plan before Friday.",
        recordingId: sourceMeeting.id,
        sourceKind: "transcript",
        startTime: 37,
        endTime: 42,
      }],
      grounded: true,
    });
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordingId === sourceMeeting.id
        ? { ...sourceMeeting, summary: "Earlier summary", actionItems: [] }
        : { ...recordings[0], summary: "Current summary", actionItems: [] }
    );

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Who owned the launch plan?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    fireEvent.click(await screen.findByRole("button", {
      name: "Open source meeting: earlier-meeting",
    }));

    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Earlier launch review");
      expect(transcriptViewerProps.current?.currentTime).toBe(37);
    });
    expect(screen.getByLabelText("Find in transcript")).toHaveValue(
      "Write the launch plan before Friday.",
    );
    expect(backend.getRecording).toHaveBeenCalledWith("earlier-meeting");
    expect(backend.openRecordingAudio).not.toHaveBeenCalled();
  });

  it("keeps the current meeting open when its notes cannot save before opening a recalled source", async () => {
    const sourceMeeting = {
      ...recordings[0],
      id: "earlier-meeting",
      title: "Earlier launch review",
    } as Recording;
    backend.askMemory.mockResolvedValueOnce({
      response: "The owner was named earlier.",
      citations: [{
        text: "Jon owns the launch plan.",
        recordingId: sourceMeeting.id,
        startTime: 12,
        endTime: 16,
      }],
      grounded: true,
    });
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordingId === sourceMeeting.id
        ? sourceMeeting
        : { ...recordings[0], summary: "Current summary", actionItems: [] }
    );
    backend.updateRecordingNotes.mockRejectedValue(new Error("Notes save failed"));

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.change(await screen.findByLabelText("Goals notes"), {
      target: { value: "Keep this current meeting note." },
    });
    fireEvent.change(screen.getByLabelText("Ask across your earlier meetings"), {
      target: { value: "Who owns the plan?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Open source meeting: earlier-meeting",
    }));

    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.getByLabelText("Goals notes")).toHaveValue("Keep this current meeting note.");
    expect(screen.queryByDisplayValue("Earlier launch review")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "the source meeting is missing",
      loadSource: () => Promise.resolve(null),
      message: "The source meeting is no longer available.",
    },
    {
      name: "the source lookup fails",
      loadSource: () => Promise.reject(new Error("RPC unavailable")),
      message: "Could not open the source meeting. Try again.",
    },
  ])("keeps the current recall workspace when $name", async ({ loadSource, message }) => {
    backend.askMemory.mockResolvedValueOnce({
      response: "An earlier meeting discussed the launch.",
      citations: [{
        text: "Review the launch plan on Friday.",
        recordingId: "unavailable-meeting",
        startTime: 8,
        endTime: 11,
      }],
      grounded: true,
    });
    backend.getRecording.mockImplementation(async (recordingId: string) => {
      if (recordingId === "unavailable-meeting") return loadSource();
      return { ...recordings[0], summary: "Current summary", actionItems: [] };
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.change(await screen.findByLabelText("Ask across your earlier meetings"), {
      target: { value: "What did we decide?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Open source meeting: unavailable-meeting",
    }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(message, "error"));
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.getByText("An earlier meeting discussed the launch.")).toBeInTheDocument();
  });

  it("does not offer source navigation for invalid recall references", async () => {
    backend.askMemory.mockResolvedValueOnce({
      response: "These references cannot be opened.",
      citations: [
        { text: "Missing recording.", recordingId: " ", startTime: 1, endTime: 2 },
        { text: "Negative start.", recordingId: "negative", startTime: -1, endTime: 2 },
        { text: "Backwards range.", recordingId: "backwards", startTime: 4, endTime: 3 },
        { text: "Non-finite range.", recordingId: "infinite", startTime: 1, endTime: Infinity },
        { text: "Written note.", recordingId: "note", sourceKind: "meeting_note", startTime: 1, endTime: 2 },
      ],
      grounded: true,
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.change(await screen.findByLabelText("Ask across your earlier meetings"), {
      target: { value: "Show invalid sources" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("These references cannot be opened.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open source meeting:/ })).not.toBeInTheDocument();
  });

  it("warns about an ungrounded recall answer and includes the warning when copying it", async () => {
    const warning =
      "This answer is not fully grounded. Review it against the earlier meetings before sharing.";
    backend.askMemory.mockResolvedValueOnce({
      response: "The launch date moved to Monday.",
      citations: [
        {
          text: "Move the launch to Monday.",
          recordingId: "earlier-meeting",
          sourceKind: "transcript",
          startTime: 10,
          endTime: 15,
        },
      ],
      grounded: false,
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "When did launch move?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const answer = await screen.findByText("The launch date moved to Monday.");
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText("References from earlier meetings")).toBeInTheDocument();
    fireEvent.click(
      within(answer.closest(".border-l-2") as HTMLElement).getByRole("button", {
        name: "Copy",
      }),
    );
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `${warning}\n\nThe launch date moved to Monday.`,
      );
    });
  });

  it.each([
    {
      name: "an incomplete reference",
      result: {
        response: "The launch moved after this meeting.",
        citations: [
          {
            text: "Move the launch to Monday.",
            recordingId: "r1",
            sourceKind: "transcript",
            startTime: 10,
            endTime: 15,
          },
        ],
        grounded: true,
      },
      warning:
        "Some source references could not be verified. Review this answer against the earlier meetings before sharing.",
    },
    {
      name: "no verified references and unknown grounding",
      result: {
        response: "The launch may have moved after this meeting.",
        citations: [],
        grounded: null,
      },
      warning:
        "This answer has no verified source references. Review it against the earlier meetings before sharing.",
    },
  ])("warns and prefixes copied recall text for $name", async ({ result, warning }) => {
    backend.askMemory.mockResolvedValueOnce(result);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "What changed after this meeting?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const answer = await screen.findByText(result.response);
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.click(
      within(answer.closest(".border-l-2") as HTMLElement).getByRole("button", {
        name: "Copy",
      }),
    );
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `${warning}\n\n${result.response}`,
      );
    });
  });

  it("clears the recall warning after a valid grounded answer and copies only that answer", async () => {
    const warning =
      "This answer is not fully grounded. Review it against the earlier meetings before sharing.";
    backend.askMemory
      .mockResolvedValueOnce({ response: "Unverified first answer.", citations: [], grounded: false })
      .mockResolvedValueOnce({
        response: "Verified second answer.",
        citations: [
          {
            text: "The signed plan is due Friday.",
            recordingId: "earlier-meeting",
            sourceKind: "transcript",
            startTime: 20,
            endTime: 24,
          },
        ],
        grounded: true,
      })
      .mockResolvedValueOnce({
        response: "No earlier meetings matched that question.",
        citations: [],
        grounded: true,
      });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "First question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(warning)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const verifiedAnswer = await screen.findByText("Verified second answer.");
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    fireEvent.click(
      within(verifiedAnswer.closest(".border-l-2") as HTMLElement).getByRole("button", {
        name: "Copy",
      }),
    );
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("Verified second answer.");
    });

    fireEvent.change(input, { target: { value: "Question with no matching earlier meeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const emptyCorpusAnswer = await screen.findByText(
      "No earlier meetings matched that question.",
    );
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    fireEvent.click(
      within(emptyCorpusAnswer.closest(".border-l-2") as HTMLElement).getByRole("button", {
        name: "Copy",
      }),
    );
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
        "No earlier meetings matched that question.",
      );
    });
  });

  it("keeps the prior recall warning through a pending failure and clears it on source change", async () => {
    const warning =
      "This answer is not fully grounded. Review it against the earlier meetings before sharing.";
    const request = deferred<any>();
    backend.askMemory
      .mockResolvedValueOnce({ response: "Prior unverified answer.", citations: [], grounded: false })
      .mockReturnValueOnce(request.promise);
    recordings = [
      recordings[0],
      {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        audioPath: "/tmp/launch-review.wav",
      },
    ];
    backend.getRecording.mockImplementation(async (recordingId) => ({
      ...recordings.find((recording) => recording.id === recordingId)!,
      summary: "Meeting summary",
      actionItems: [],
    }));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "First question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(warning)).toBeInTheDocument();

    input.focus();
    fireEvent.change(input, { target: { value: "Question that fails" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Earlier meetings answer status" })).toHaveTextContent("Asking");
    expect(input).toHaveFocus();
    await act(async () => {
      request.reject(new Error("Recall failed"));
      await request.promise.catch(() => undefined);
    });
    expect(await screen.findByText("Recall failed")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("status", { name: "Earlier meetings answer status" })).toHaveTextContent("Answer failed");
    expect(input).toHaveFocus();
    expect(screen.getByText(warning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Launch review"));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it("cancels the exact recall run and ignores its late success", async () => {
    const request = deferred<any>();
    const cancellation = deferred<void>();
    backend.askMemory.mockReturnValueOnce(request.promise);
    backend.cancelAnalysisRun.mockReturnValueOnce(cancellation.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Find the earlier decision" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const runId = backend.askMemory.mock.calls[0][1].runId;
    fireEvent.click(await screen.findByRole("button", { name: "Cancel recall" }));
    expect(backend.cancelAnalysisRun).toHaveBeenCalledWith(runId);
    const cancelling = screen.getByRole("button", { name: "Cancelling…" });
    expect(cancelling).toBeDisabled();

    await act(async () => cancellation.resolve());
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      request.resolve({
        response: "Late cancelled answer",
        citations: [{ text: "Late citation", recordingId: "old", startTime: 1, endTime: 2 }],
      });
      await request.promise;
    });
    expect(screen.queryByText("Late cancelled answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Late citation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelling…" })).not.toBeInTheDocument();
  });

  it("deduplicates recall submission and preserves the previous answer and current draft", async () => {
    const request = deferred<any>();
    backend.askMemory
      .mockResolvedValueOnce({
        response: "Previous recall answer",
        citations: [
          { text: "Previous recall citation", recordingId: "prior", startTime: 3, endTime: 5 },
        ],
      })
      .mockReturnValueOnce(request.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Previous recall question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Previous recall answer")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Submitted follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(input, { target: { value: "Draft typed while waiting" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });

    expect(backend.askMemory).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Previous recall question")).toBeInTheDocument();
    expect(screen.getByText("Previous recall answer")).toBeInTheDocument();
    expect(screen.getByText("Previous recall citation")).toBeInTheDocument();
    expect(input).toHaveValue("Draft typed while waiting");

    fireEvent.click(screen.getByRole("button", { name: "Cancel recall" }));
    await act(async () => {
      request.reject(new Error("Late cancelled failure"));
      await request.promise.catch(() => undefined);
    });
    expect(screen.queryByText("Late cancelled failure")).not.toBeInTheDocument();
    expect(screen.getByText("Previous recall answer")).toBeInTheDocument();
    expect(input).toHaveValue("Draft typed while waiting");
  });

  it("reports a failed cancellation while waiting for the recall to settle", async () => {
    const request = deferred<any>();
    backend.askMemory.mockReturnValueOnce(request.promise);
    backend.cancelAnalysisRun.mockRejectedValueOnce(new Error("cancel transport failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Recall with slow cancellation" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel recall" }));

    expect(
      await screen.findByText("Could not cancel immediately. Waiting for recall to finish."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      request.resolve({ response: "Cancelled answer after failed cancellation", citations: [] });
      await request.promise;
    });
    expect(screen.queryByText("Cancelled answer after failed cancellation")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Could not cancel immediately. Waiting for recall to finish."),
    ).not.toBeInTheDocument();
  });

  it("cancels active recall once on source changes and unmount", async () => {
    const firstRequest = deferred<any>();
    const secondRequest = deferred<any>();
    backend.askMemory
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    recordings = [
      recordings[0],
      {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        audioPath: "/tmp/launch-review.wav",
      },
    ];
    backend.getRecording.mockImplementation(async (recordingId) => ({
      ...recordings.find((recording) => recording.id === recordingId)!,
      summary: "Meeting summary",
      actionItems: [],
    }));

    const view = render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.change(await screen.findByLabelText("Ask across your earlier meetings"), {
      target: { value: "Question for weekly sync" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const firstRunId = backend.askMemory.mock.calls[0][1].runId;

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Launch review"));
    await waitFor(() => expect(backend.cancelAnalysisRun).toHaveBeenCalledWith(firstRunId));
    expect(backend.cancelAnalysisRun).toHaveBeenCalledTimes(1);
    await act(async () => firstRequest.resolve({ response: "Late weekly answer", citations: [] }));
    expect(screen.queryByText("Late weekly answer")).not.toBeInTheDocument();

    const secondInput = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(secondInput, { target: { value: "Question for launch review" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const secondRunId = backend.askMemory.mock.calls[1][1].runId;
    view.unmount();

    await waitFor(() => expect(backend.cancelAnalysisRun).toHaveBeenCalledWith(secondRunId));
    expect(backend.cancelAnalysisRun).toHaveBeenCalledTimes(2);
    await act(async () => secondRequest.resolve({ response: "Late unmounted answer", citations: [] }));
  });

  it("keeps the current meeting recall while an older meeting request finishes", async () => {
    const older = deferred<any>();
    const current = deferred<any>();
    backend.askMemory
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(current.promise);
    recordings = [
      recordings[0],
      {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        audioPath: "/tmp/launch-review.wav",
      },
    ];
    backend.getRecording.mockImplementation(async (recordingId) => ({
      ...recordings.find((recording) => recording.id === recordingId)!,
      summary: recordingId === "r1" ? "Weekly summary" : "Launch summary",
      actionItems: [],
    }));

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const firstInput = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(firstInput, { target: { value: "Older question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByRole("button", { name: "Asking" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Launch review"));
    const secondInput = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(secondInput, { target: { value: "Current question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await act(async () => {
      older.resolve({
        response: "Stale answer",
        citations: [{ text: "Stale citation", recordingId: "old", startTime: 1, endTime: 2 }],
      });
      await older.promise;
    });
    expect(screen.getByRole("button", { name: "Asking" })).toBeDisabled();
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale citation")).not.toBeInTheDocument();

    await act(async () => {
      current.resolve({
        response: "Current answer",
        citations: [
          { text: "Current citation", recordingId: "r1", startTime: 12, endTime: 14 },
        ],
      });
      await current.promise;
    });
    expect(await screen.findByText("Current answer")).toBeInTheDocument();
    const citation = screen.getByText("Current citation");
    expect(citation).toBeInTheDocument();
    expect(citation.parentElement).toHaveTextContent("Weekly sync");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  it("does not let an older recall error clear the current meeting request", async () => {
    const older = deferred<any>();
    const current = deferred<any>();
    backend.askMemory
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(current.promise);
    recordings = [
      recordings[0],
      {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        audioPath: "/tmp/launch-review.wav",
      },
    ];
    backend.getRecording.mockImplementation(async (recordingId) => ({
      ...recordings.find((recording) => recording.id === recordingId)!,
      summary: "Meeting summary",
      actionItems: [],
    }));

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.change(await screen.findByLabelText("Ask across your earlier meetings"), {
      target: { value: "Older question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Launch review"));
    fireEvent.change(await screen.findByLabelText("Ask across your earlier meetings"), {
      target: { value: "Current question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await act(async () => {
      older.reject(new Error("Older request failed"));
      await older.promise.catch(() => undefined);
    });
    expect(screen.queryByText("Older request failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Asking" })).toBeDisabled();

    await act(async () => {
      current.resolve({ response: "Current answer", citations: [] });
      await current.promise;
    });
    expect(await screen.findByText("Current answer")).toBeInTheDocument();
    expect(screen.queryByText("Older request failed")).not.toBeInTheDocument();
  });

  it("preserves an ABA-edited recall question while the submitted request is pending", async () => {
    const request = deferred<any>();
    backend.askMemory.mockReturnValueOnce(request.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Submitted question" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(input, { target: { value: "Question typed while waiting" } });
    fireEvent.change(input, { target: { value: "Submitted question" } });

    await act(async () => {
      request.resolve({ response: "Submitted answer", citations: [] });
      await request.promise;
    });
    expect(await screen.findByText("Submitted answer")).toBeInTheDocument();
    expect(input).toHaveValue("Submitted question");
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
  });

  it("keeps a recall draft when a citation focuses the meeting already open", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "The launch plan is ready.",
      actionItems: [],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:same-meeting-source",
        actualProvider: "ollama",
        actualModel: "local-test",
        promptSource: "test",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [
          {
            text: "The launch plan is ready.",
            recordingId: "r1",
            startTime: 15,
            endTime: 21,
          },
        ],
        grounded: true,
      },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("Ask across your earlier meetings");
    fireEvent.change(input, { target: { value: "Keep this follow-up question" } });

    fireEvent.click(screen.getByRole("button", { name: /The launch plan is ready\./ }));

    await waitFor(() => expect(transcriptViewerProps.current?.currentTime).toBe(15));
    expect(input).toHaveValue("Keep this follow-up question");
  });

  it.each([null, 1, 3, 6])("requires review for an older summary policy %s", async (policy) => {
    const citation = { text: "Prior checked source.", recordingId: "r1", startTime: 15, endTime: 21 };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Prior generated summary", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: policy, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: true },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    const source = screen.getByRole("button", { name: /Prior checked source/ });
    expect(source).toBeEnabled();
    expect(source).toHaveTextContent("Unverified");
    fireEvent.click(source);
    await waitFor(() => expect(transcriptViewerProps.current?.currentTime).toBe(15));
    expect(screen.getByText(/not been checked under the current meaning checks/)).toBeInTheDocument();
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Prior generated summary");
  });

  it.each([
    { recordingId: "other-meeting", startTime: 15 },
    { recordingId: "r1", startTime: -1 },
    { recordingId: "r1", startTime: Number.NaN },
    { recordingId: "r1", startTime: Number.POSITIVE_INFINITY },
  ])("does not navigate a citation with an invalid destination", async (destination) => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Prior generated summary", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: 3, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [{ text: "Invalid source destination.", endTime: 21, ...destination }], grounded: true },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const source = await screen.findByRole("button", { name: /Invalid source destination/ });
    expect(source).toBeDisabled();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it.each([
    { recordingId: "other-meeting", startTime: 15, endTime: 21 },
    { recordingId: "r1", startTime: -1, endTime: 21 },
    { recordingId: "r1", startTime: 15, endTime: 10 },
    { recordingId: "r1", startTime: 121, endTime: 125 },
    { recordingId: "r1", startTime: 15, endTime: Number.POSITIVE_INFINITY },
  ])("keeps current-policy recaps in review for invalid citation destinations", async (destination) => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Generated recap", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [{ text: "Invalid current source.", ...destination }], grounded: true },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    const source = screen.getByRole("button", { name: /Invalid current source/ });
    expect(source).toBeDisabled();
    expect(source).toHaveTextContent("Unverified");
    fireEvent.click(screen.getByRole("button", { name: "Copy recap" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(navigator.clipboard.writeText.mock.calls.at(-1)[0]).toContain("> Needs review:");
  });

  it("keeps legacy action-item policy in review while current summary quotes remain usable", async () => {
    const summaryCitation = { text: "Current summary source.", recordingId: "r1", startTime: 15, endTime: 21 };
    const actionCitation = { text: "Prior action source.", recordingId: "r1", startTime: 30, endTime: 35 };
    const provenance = { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [summaryCitation], grounded: true };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Current summary", actionItems: ["Send the proposal."], summaryProvenance: provenance,
      actionItemsProvenance: { ...provenance, groundingPolicyVersion: 6, citations: [actionCitation], items: [{ generated: true, grounded: true, citations: [actionCitation] }] },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Current summary source/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Prior action source/ })).toBeEnabled();
    expect(screen.getByText(/These action items have not been checked/)).toBeInTheDocument();
  });

  it("keeps summary source history visible but unverified after a note autosave", async () => {
    const citation = { text: "Original source evidence.", recordingId: "r1", startTime: 15, endTime: 21 };
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Generated summary", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: true },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    expect(screen.getByRole("button", { name: /Original source evidence/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Goals notes"), { target: { value: "Changed goal" } });
    await screen.findByText("Saved just now");
    expect(screen.getByRole("button", { name: /Original source evidence/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Original source evidence/ })).toHaveTextContent("Unverified");
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Generated summary");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("keeps completed meeting details collapsed and available without hiding review status", async () => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Needs source review", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [], grounded: false },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    const details = screen.getByTestId("meeting-secondary-details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Needs review")).toBeVisible();
    fireEvent.click(screen.getByText("Meeting details"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Add attendee" })).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting title")).toBeInTheDocument();
  });

  it("shows Saving until meeting notes persist, then confirms they were saved", async () => {
    const pendingSave = deferred<void>();
    backend.updateRecordingNotes.mockReturnValueOnce(pendingSave.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the scope tight" },
    });

    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nKeep the scope tight", undefined, expect.any(String));
    });
    expect(screen.queryByText("Saved just now")).not.toBeInTheDocument();

    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });

    expect(await screen.findByText("Saved just now")).toBeInTheDocument();
  });

  it("offers a notes retry after persistence fails and clears the failure while retrying", async () => {
    const retrySave = deferred<void>();
    backend.updateRecordingNotes
      .mockRejectedValueOnce(new Error("Notes file is locked"))
      .mockReturnValueOnce(retrySave.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Confirm the launch owner" },
    });

    const notSaved = await screen.findByText(/Not saved/);
    expect(notSaved.closest('[role="status"]')).toHaveTextContent(/Not saved.*Retry/);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      retrySave.resolve();
      await retrySave.promise;
    });

    expect(await screen.findByText("Saved just now")).toBeInTheDocument();
  });

  it("serializes notes writes so an older request cannot outlast a newer edit", async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    backend.updateRecordingNotes
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "First draft" },
    });
    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Newer draft" },
    });
    expect(await screen.findByText("Saving…")).toBeInTheDocument();

    // The newer write waits behind the older one. Revision-gating the label is
    // not enough: if both writes race, the old request can finish last on disk
    // after the UI has already said the newer draft was saved.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });
    expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });

    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText("Saved just now")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      secondSave.resolve();
      await secondSave.promise;
    });

    expect(await screen.findByText("Saved just now")).toBeInTheDocument();
    expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith("r1", "Goals\nNewer draft", undefined, expect.any(String));
  });

  it("saves the last note keystroke before immediately leaving the meeting", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the final decision." },
    });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nKeep the final decision.", undefined, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument());
  });

  it("keeps the notes draft open when saving before leaving fails", async () => {
    backend.updateRecordingNotes.mockRejectedValue(new Error("Notes save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep my unsaved decision." },
    });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    expect(screen.getByLabelText("Goals notes")).toHaveValue("Keep my unsaved decision.");
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("keeps a newer note visible when typing continues during the leave save", async () => {
    let finishSave!: () => void;
    backend.updateRecordingNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), { target: { value: "First decision." } });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Goals notes"), { target: { value: "Latest decision must stay." } });
    finishSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByLabelText("Goals notes")).toHaveValue("Latest decision must stay."));
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("flushes review notes through the shared workspace navigation guard", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), { target: { value: "Save before switching workspace." } });
    let allowed = false;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nSave before switching workspace.", undefined, expect.any(String));
  });

  it("checks the saved note read before ordinary review autosave", async () => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], meetingNotes: "Original note" });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const input = await screen.findByLabelText("General notes notes");
    fireEvent.change(input, { target: { value: "Original note\nTyped condition." } });
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", expect.stringContaining("Typed condition."), undefined, "Original note"));
  });

  it("blocks workspace navigation when review notes cannot be saved", async () => {
    backend.updateRecordingNotes.mockRejectedValue(new Error("Notes save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), { target: { value: "Keep the blocked navigation draft." } });
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(screen.getByLabelText("Goals notes")).toHaveValue("Keep the blocked navigation draft.");
  });

  it("saves an immediate playbook change before closing the meeting", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument());
  });

  it("waits for a pending playbook save before allowing workspace navigation", async () => {
    const save = deferred<void>();
    backend.updateRecordingTemplate.mockReturnValueOnce(save.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));
    const leaving = canLeaveMainView("recordings");
    let settled = false;
    void leaving.then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    let allowed = false;
    await act(async () => { save.resolve(); allowed = await leaving; });
    expect(allowed).toBe(true);
  });

  it("keeps the meeting and playbook draft open when the navigation save fails", async () => {
    backend.updateRecordingTemplate.mockRejectedValue(new Error("Template save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));
    expect(screen.getByLabelText("Playbook")).toHaveValue("standup");
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("flushes meeting chat through the shared workspace navigation guard", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByText("Push meeting chat"));
    let allowed = false;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.updateMeetingChatMessages).toHaveBeenCalledWith("r1", expect.arrayContaining([
      expect.objectContaining({ id: "m2", content: "Launch review slipped to Monday." }),
    ]));
  });

  it("blocks workspace navigation when meeting chat history cannot be saved", async () => {
    backend.updateMeetingChatMessages.mockRejectedValue(new Error("Chat save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByText("Push meeting chat"));
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("saves a newer playbook after an older playbook write finishes", async () => {
    const olderSave = deferred<void>();
    backend.updateRecordingTemplate.mockReturnValueOnce(olderSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "sales" } });
    const leaving = canLeaveMainView("recordings");
    await act(async () => { olderSave.resolve(); });
    let allowed = false;
    await act(async () => { allowed = await leaving; });
    expect(allowed).toBe(true);
    expect(backend.updateRecordingTemplate).toHaveBeenLastCalledWith("r1", "sales");
  });

  it("rejects a stale leave snapshot when the playbook changes behind a pending save", async () => {
    const olderSave = deferred<void>();
    backend.updateRecordingTemplate.mockReturnValueOnce(olderSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));

    const leaving = canLeaveMainView("recordings");
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "sales" } });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });

    let allowed = true;
    await act(async () => { olderSave.resolve(); allowed = await leaving; });
    expect(allowed).toBe(false);
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenLastCalledWith("r1", "sales"));
    expect(backend.updateRecordingTemplate).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Playbook")).toHaveValue("sales");
  });

  it("rejects playbook navigation after an ABA edit while its first save is pending", async () => {
    const firstSave = deferred<void>();
    backend.updateRecordingTemplate.mockReturnValueOnce(firstSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Playbook");

    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });
    const leaving = canLeaveMainView("recordings");
    await waitFor(() => expect(backend.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup"));
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "sales" } });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "standup" } });

    let allowed = true;
    await act(async () => { firstSave.resolve(); allowed = await leaving; });
    expect(allowed).toBe(false);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });
    expect(backend.updateRecordingTemplate.mock.calls.some(([, template]) => template === "sales")).toBe(false);
    expect(backend.updateRecordingTemplate).toHaveBeenLastCalledWith("r1", "standup");
    expect(screen.getByLabelText("Playbook")).toHaveValue("standup");
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("saves newer chat after an older chat write finishes", async () => {
    const olderSave = deferred<void>();
    backend.updateMeetingChatMessages.mockReturnValueOnce(olderSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByText("Push meeting chat"));
    await waitFor(() => expect(backend.updateMeetingChatMessages).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Push newer meeting chat"));
    const leaving = canLeaveMainView("recordings");
    await act(async () => { olderSave.resolve(); });
    let allowed = false;
    await act(async () => { allowed = await leaving; });
    expect(allowed).toBe(true);
    expect(backend.updateMeetingChatMessages).toHaveBeenLastCalledWith("r1", [
      expect.objectContaining({ id: "m3", content: "What changed after review?" }),
    ]);
  });

  it("rejects a stale leave snapshot when chat changes behind a pending save", async () => {
    const olderSave = deferred<void>();
    backend.updateMeetingChatMessages.mockReturnValueOnce(olderSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByText("Push meeting chat"));
    await waitFor(() => expect(backend.updateMeetingChatMessages).toHaveBeenCalledTimes(1));

    const leaving = canLeaveMainView("recordings");
    fireEvent.click(screen.getByText("Push newer meeting chat"));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });

    let allowed = true;
    await act(async () => { olderSave.resolve(); allowed = await leaving; });
    expect(allowed).toBe(false);
    await waitFor(() => expect(backend.updateMeetingChatMessages).toHaveBeenLastCalledWith("r1", [
      expect.objectContaining({ id: "m3", content: "What changed after review?" }),
    ]));
    expect(backend.updateMeetingChatMessages).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("rejects chat navigation after an ABA edit while its first save is pending", async () => {
    const firstSave = deferred<void>();
    backend.updateMeetingChatMessages.mockReturnValueOnce(firstSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));

    fireEvent.click(await screen.findByText("Push meeting chat"));
    const leaving = canLeaveMainView("recordings");
    await waitFor(() => expect(backend.updateMeetingChatMessages).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Push newer meeting chat"));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });
    fireEvent.click(screen.getByText("Push meeting chat"));

    let allowed = true;
    await act(async () => { firstSave.resolve(); allowed = await leaving; });
    expect(allowed).toBe(false);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)); });
    expect(backend.updateMeetingChatMessages.mock.calls.some(([, messages]) =>
      messages.some((message) => message.id === "m3")
    )).toBe(false);
    expect(backend.updateMeetingChatMessages).toHaveBeenLastCalledWith("r1", expect.arrayContaining([
      expect.objectContaining({ id: "m2", content: "Launch review slipped to Monday." }),
    ]));
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  describe("recap save retry", () => {
    const openSummary = async () => {
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByLabelText("Summary");
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      return screen.getByLabelText("Summary") as HTMLTextAreaElement;
    };
    const flush = async () => {
      let allowed = false;
      await act(async () => { allowed = await canLeaveMainView("recordings"); });
      return allowed;
    };

    it("keeps a persistent failed draft and retries it once without another edit", async () => {
      backend.updateRecordingAnalysis.mockRejectedValueOnce(new Error("Save unavailable"));
      const field = await openSummary();
      fireEvent.change(field, { target: { value: "Exact failed recap." } });
      expect(await flush()).toBe(false);
      expect(screen.getByText("Recap not saved. Keep this meeting open.")).toBeInTheDocument();
      vi.useFakeTimers();
      try { await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); }
      finally { vi.useRealTimers(); }
      expect(field).toHaveValue("Exact failed recap.");
      const pending = deferred<void>();
      backend.updateRecordingAnalysis.mockReturnValueOnce(pending.promise);
      const retry = screen.getByRole("button", { name: "Retry save" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2));
      expect(backend.updateRecordingAnalysis).toHaveBeenLastCalledWith("r1", { summary: "Exact failed recap." });
      let leaving!: Promise<boolean>;
      act(() => { leaving = canLeaveMainView("recordings"); });
      await act(async () => { pending.resolve(); await leaving; });
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Recap not saved. Keep this meeting open.")).not.toBeInTheDocument();
      expect(field).toHaveValue("Exact failed recap.");
    });

    it("saves a reverted baseline after the pending older autosave acknowledges", async () => {
      const older = deferred<void>();
      backend.updateRecordingAnalysis.mockReturnValueOnce(older.promise)
        .mockRejectedValueOnce(new Error("Reverted draft save unavailable"));
      const field = await openSummary();
      const baseline = field.value;
      fireEvent.change(field, { target: { value: "Older A." } });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(1));
      fireEvent.change(field, { target: { value: baseline } });
      await act(async () => { older.resolve(); await older.promise; });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2));
      expect(backend.updateRecordingAnalysis).toHaveBeenLastCalledWith("r1", { summary: baseline });
      expect(await screen.findByText("Recap not saved. Keep this meeting open.")).toBeInTheDocument();
      expect(field).toHaveValue(baseline);
      fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
      await waitFor(() => expect(screen.queryByText("Recap not saved. Keep this meeting open.")).not.toBeInTheDocument());
      expect(backend.updateRecordingAnalysis).toHaveBeenLastCalledWith("r1", { summary: baseline });
    });

    it("requires the current ABA edit revision to acknowledge even when text matches", async () => {
      const older = deferred<void>();
      const latest = deferred<void>();
      backend.updateRecordingAnalysis.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
      const field = await openSummary();
      fireEvent.change(field, { target: { value: "A draft." } });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(1));
      fireEvent.change(field, { target: { value: "B draft." } });
      fireEvent.change(field, { target: { value: "A draft." } });
      await act(async () => { older.resolve(); await older.promise; });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Saving recap…")).toBeInTheDocument();
      expect(field).toHaveValue("A draft.");
      await act(async () => { latest.resolve(); await latest.promise; });
      expect(screen.queryByText("Saving recap…")).not.toBeInTheDocument();
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2);
    });

    it("does not attach an old retry failure to newer typing", async () => {
      backend.updateRecordingAnalysis.mockRejectedValueOnce(new Error("First failure"));
      const field = await openSummary();
      fireEvent.change(field, { target: { value: "Old failed draft." } });
      await flush();
      const older = deferred<void>();
      const latest = deferred<void>();
      backend.updateRecordingAnalysis.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
      fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(2));
      fireEvent.change(field, { target: { value: "Newer draft stays here." } });
      await act(async () => { older.reject(new Error("Old retry failure")); await older.promise.catch(() => {}); });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(3));
      expect(screen.queryByText("Recap not saved. Keep this meeting open.")).not.toBeInTheDocument();
      expect(field).toHaveValue("Newer draft stays here.");
      await act(async () => { latest.resolve(); await latest.promise; });
      expect(screen.queryByText("Saving recap…")).not.toBeInTheDocument();
    });

    it("keeps returned action provenance and unrelated fields without invalidating summary Undo", async () => {
      const citation = { text: "Untouched task source.", recordingId: "r1", startTime: 15, endTime: 21 };
      const provenance = { version: 1, groundingPolicyVersion: 3, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [citation], grounded: true,
        items: [{ generated: true, grounded: true, citations: [citation] }, { generated: true, grounded: true, citations: [] }] };
      const original = { ...recordings[0], summary: "Original summary.", meetingNotes: "## Goals\nCurrent notes.", actionItems: ["Keep task.", "Old task."], actionItemsProvenance: provenance };
      backend.getRecording.mockResolvedValue(original);
      backend.getSummaryRegenerationUndo.mockResolvedValue({ canUndo: true, undoToken: "valid-summary-undo" });
      backend.updateRecordingAnalysis.mockResolvedValue({ ...original, title: "Stale returned title", meetingNotes: "Stale returned notes",
        actionItems: ["Keep task.", "New task."], actionItemsProvenance: { ...provenance, items: [provenance.items[0], { generated: false, grounded: false, citations: [] }] } });
      await openSummary();
      await screen.findByRole("button", { name: "Restore previous summary" });
      const undoReads = backend.getSummaryRegenerationUndo.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
      fireEvent.change(screen.getByLabelText("Action items"), { target: { value: "Keep task.\nNew task." } });
      expect(await flush()).toBe(true);
      expect(screen.getByRole("button", { name: /Untouched task source/ })).toBeInTheDocument();
      expect(screen.queryByText("Stale returned title")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Goals notes")).toHaveValue("Current notes.");
      expect(backend.getSummaryRegenerationUndo).toHaveBeenCalledTimes(undoReads);
      expect(screen.getByRole("button", { name: "Restore previous summary" })).toBeInTheDocument();
    });

    it("ignores a closed workspace failure after switching recording scope", async () => {
      const older = deferred<void>();
      backend.updateRecordingAnalysis.mockReturnValueOnce(older.promise);
      const oldView = render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByLabelText("Summary");
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Old meeting draft." } });
      await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalledTimes(1));
      oldView.unmount();
      recordings = [{ ...recordings[0], id: "r2", title: "Other meeting", summary: "Other recap." }];
      backend.getRecording.mockResolvedValue(recordings[0]);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Other meeting"));
      await screen.findByLabelText("Summary");
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      const field = screen.getByLabelText("Summary");
      const notices = toast.mock.calls.length;
      await act(async () => { older.reject(new Error("Old record failure")); await older.promise.catch(() => {}); });
      expect(field).toHaveValue("Other recap.");
      expect(screen.queryByText("Recap not saved. Keep this meeting open.")).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledTimes(notices);
    });

    it("cannot restore a stale pre-save Undo availability response after a manual summary save", async () => {
      const oldAvailability = deferred<{ canUndo: boolean; undoToken: string }>();
      backend.getSummaryRegenerationUndo.mockReturnValueOnce(oldAvailability.promise).mockResolvedValue({ canUndo: false });
      const field = await openSummary();
      fireEvent.change(field, { target: { value: "Manual summary invalidates Undo." } });
      expect(await flush()).toBe(true);
      await act(async () => { oldAvailability.resolve({ canUndo: true, undoToken: "stale-before-save" }); await oldAvailability.promise; });
      expect(screen.queryByRole("button", { name: "Restore previous summary" })).not.toBeInTheDocument();
      expect(backend.getSummaryRegenerationUndo.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("saves an edited summary before workspace navigation", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "My final summary draft." } });
    let allowed = false;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { summary: "My final summary draft." });
  });

  it("keeps an edited summary visible when navigation saving fails", async () => {
    backend.updateRecordingAnalysis.mockRejectedValue(new Error("Summary save failed"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Unsaved summary stays here." } });
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(screen.getByLabelText("Summary")).toHaveValue("Unsaved summary stays here.");
  });

  it("saves edited action items before workspace navigation", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), { target: { value: "Send the notes\nCheck the budget" } });
    let allowed = false;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", { actionItems: ["Send the notes", "Check the budget"] });
  });

  it("keeps newer summary typing visible while navigation save finishes", async () => {
    let finishSave!: () => void;
    backend.updateRecordingAnalysis.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "First summary draft." } });
    let leaving!: Promise<boolean>;
    act(() => { leaving = canLeaveMainView("recordings"); });
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Newer summary must stay." } });
    let allowed = true;
    await act(async () => { finishSave(); allowed = await leaving; });
    expect(allowed).toBe(false);
    expect(screen.getByLabelText("Summary")).toHaveValue("Newer summary must stay.");
  });

  it("rejects navigation when the title changes while a later workspace save awaits", async () => {
    const analysisSave = deferred<void>();
    backend.updateRecordingAnalysis.mockReturnValueOnce(analysisSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Save this summary before leaving." },
    });

    const leaving = canLeaveMainView("recordings");
    await waitFor(() => expect(backend.updateRecordingAnalysis).toHaveBeenCalled());
    const title = screen.getByLabelText("Meeting title");
    title.focus();
    fireEvent.change(title, { target: { value: "Newest meeting title" } });

    let allowed = true;
    await act(async () => {
      analysisSave.resolve();
      allowed = await leaving;
    });

    expect(allowed).toBe(false);
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Newest meeting title");
    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
  });

  it("saves live notes before workspace navigation without stopping capture", async () => {
    recordingState.isRecording = true;
    recordingState.recordingId = "r1";
    render(<RecordingsView />);
    const input = await screen.findByLabelText("Live meeting notes");
    fireEvent.change(input, { target: { value: "Final live decision." } });
    let allowed = false;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Final live decision.", undefined, expect.any(String));
    expect(stopMeeting).not.toHaveBeenCalled();
  });

  it("keeps live notes visible when navigation saving fails", async () => {
    recordingState.isRecording = true;
    recordingState.recordingId = "r1";
    backend.updateRecordingNotes.mockRejectedValue(new Error("Live notes save failed"));
    render(<RecordingsView />);
    const input = await screen.findByLabelText("Live meeting notes");
    fireEvent.change(input, { target: { value: "Unsaved live decision." } });
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(input).toHaveValue("Unsaved live decision.");
    expect(stopMeeting).not.toHaveBeenCalled();
  });

  it("keeps newer live notes visible while the navigation save finishes", async () => {
    recordingState.isRecording = true;
    recordingState.recordingId = "r1";
    let finishSave!: () => void;
    backend.updateRecordingNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<RecordingsView />);
    const input = await screen.findByLabelText("Live meeting notes");
    fireEvent.change(input, { target: { value: "First live decision." } });
    let leaving!: Promise<boolean>;
    act(() => { leaving = canLeaveMainView("recordings"); });
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "Newer live decision must stay." } });
    let allowed = true;
    await act(async () => { finishSave(); allowed = await leaving; });
    expect(allowed).toBe(false);
    expect(input).toHaveValue("Newer live decision must stay.");
    expect(stopMeeting).not.toHaveBeenCalled();
  });

  it("saves the final live note when stop ends capture before autosave", async () => {
    recordingState.isRecording = true;
    recordingState.recordingId = "r1";
    const view = render(<RecordingsView />);
    fireEvent.change(await screen.findByLabelText("Live meeting notes"), { target: { value: "Final decision at stop." } });
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
    expect(stopMeeting).toHaveBeenCalledTimes(1);
    recordingState.isRecording = false;
    recordingState.recordingId = null;
    view.rerender(<RecordingsView />);
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Final decision at stop.", expect.any(String), expect.any(String)));
    await waitFor(() => expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument());
  });

  describe("external meeting note recovery", () => {
    it("saves exact notes to the original meeting when capture ends before autosave", async () => {
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      const exact = "  Final decision.\n\nSecond  line.  ";
      fireEvent.change(await screen.findByLabelText("Live meeting notes"), {
        target: { value: exact },
      });

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);

      await waitFor(() =>
        expect(backend.queueMeetingNoteRecovery).toHaveBeenCalledWith(
          expect.objectContaining({
            recordingId: "meeting-a",
            baseNotes: "",
            notes: exact,
          }),
        ),
      );
      await waitFor(() =>
        expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
          "meeting-a",
          exact,
          expect.any(String),
          "",
        ),
      );
    });

    it("does not queue recovery when the same notes were already autosaved", async () => {
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      const exact = "Already saved before external stop.";
      fireEvent.change(await screen.findByLabelText("Live meeting notes"), {
        target: { value: exact },
      });

      await waitFor(() =>
        expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
          "meeting-a",
          exact,
          undefined,
          "",
        ),
      );
      expect(await screen.findByText("Saved just now")).toBeInTheDocument();
      backend.getRecording.mockRejectedValue(new Error("database unavailable later"));
      backend.queueMeetingNoteRecovery.mockClear();

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);
      await act(async () => { await Promise.resolve(); });

      expect(backend.queueMeetingNoteRecovery).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument();
    });

    it("keeps the only exact copy visible when journal and save both fail", async () => {
      backend.queueMeetingNoteRecovery.mockRejectedValueOnce(
        new Error("journal unavailable"),
      );
      backend.updateRecordingNotes.mockRejectedValueOnce(
        new Error("save unavailable"),
      );
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      const exact = "Do not lose this note.\n\nOwner: Mira";
      fireEvent.change(await screen.findByLabelText("Live meeting notes"), {
        target: { value: exact },
      });

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);

      expect(await screen.findByLabelText("Retained final meeting notes")).toHaveValue(exact);
      expect(screen.getByRole("button", { name: "Retry save" })).toBeEnabled();
    });

    it("does not duplicate a successful local Stop snapshot when ended state arrives", async () => {
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      fireEvent.change(await screen.findByLabelText("Live meeting notes"), {
        target: { value: "One final snapshot" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
      await waitFor(() =>
        expect(backend.queueMeetingNoteRecovery).toHaveBeenCalledTimes(1),
      );
      await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1));

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);
      await act(async () => { await Promise.resolve(); });

      expect(backend.queueMeetingNoteRecovery).toHaveBeenCalledTimes(1);
      expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1);
    });

    it("queues newer words typed after the local Stop snapshot", async () => {
      backend.queueMeetingNoteRecovery.mockRejectedValue(
        new Error("journal unavailable"),
      );
      backend.updateRecordingNotes.mockRejectedValue(
        new Error("save unavailable"),
      );
      const pendingStop = deferred<void>();
      stopMeeting.mockReturnValueOnce(pendingStop.promise);
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      const input = await screen.findByLabelText("Live meeting notes");
      fireEvent.change(input, { target: { value: "Stop snapshot" } });
      fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
      fireEvent.change(input, { target: { value: "Stop snapshot\nNewer final words" } });

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);

      await waitFor(() => expect(backend.queueMeetingNoteRecovery).toHaveBeenCalledTimes(2));
      expect(backend.queueMeetingNoteRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recordingId: "meeting-a",
          notes: "Stop snapshot\nNewer final words",
        }),
      );
      expect(
        screen.getAllByLabelText("Retained final meeting notes").some(
          (draft) => (draft as HTMLTextAreaElement).value === "Stop snapshot\nNewer final words",
        ),
      ).toBe(true);
      await act(async () => {
        pendingStop.resolve(undefined);
        await pendingStop.promise;
      });
    });

    it("saves A during a direct A-to-B transition without overwriting B notes", async () => {
      const saveA = deferred<void>();
      backend.updateRecordingNotes.mockReturnValueOnce(saveA.promise);
      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      const view = render(<RecordingsView />);
      fireEvent.change(await screen.findByLabelText("Live meeting notes"), {
        target: { value: "Meeting A final note" },
      });

      recordingState.recordingId = "meeting-b";
      view.rerender(<RecordingsView />);
      const notesB = await screen.findByLabelText("Live meeting notes");
      await waitFor(() => expect(notesB).toHaveValue(""));
      fireEvent.change(notesB, { target: { value: "Meeting B own note" } });

      await act(async () => {
        saveA.resolve(undefined);
        await saveA.promise;
      });

      expect(notesB).toHaveValue("Meeting B own note");
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "meeting-a",
        "Meeting A final note",
        expect.any(String),
        "",
      );
    });
  });

  it("keeps the leave guard when neither the recovery journal nor final save succeeds", async () => {
    recordingState.isRecording = true; recordingState.recordingId = "r1";
    backend.queueMeetingNoteRecovery.mockRejectedValueOnce(new Error("Journal unavailable"));
    backend.updateRecordingNotes.mockRejectedValueOnce(new Error("Save unavailable"));
    const view = render(<RecordingsView />);
    fireEvent.change(await screen.findByLabelText("Live meeting notes"), { target: { value: "Keep the only copy." } });
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
    recordingState.isRecording = false; recordingState.recordingId = null; view.rerender(<RecordingsView />);
    expect(await screen.findByText("Final notes could not be stored. Keep this workspace open and retry.")).toBeInTheDocument();
    let allowed = true; await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(screen.getByLabelText("Retained final meeting notes")).toHaveValue("Keep the only copy.");
  });

  it("keeps a recovered draft visible and explains a stale-save conflict", async () => {
    const draft = { id: "draft-raced", recordingId: "r1", baseNotes: "", notes: "Recovered condition." };
    const save = deferred<void>();
    const user = userEvent.setup();
    backend.listMeetingNoteRecovery.mockResolvedValue([draft]);
    backend.updateRecordingNotes.mockReturnValueOnce(save.promise);
    render(<RecordingsView />);
    await screen.findByLabelText("Retained final meeting notes");
    const retry = screen.getByRole("button", { name: "Retry save" });
    await user.click(retry);
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1));
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1);
    await act(async () => save.reject(new Error("Meeting notes changed while saving. Retry to merge the latest notes.")));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved notes changed during recovery. Retry save to merge the latest notes.", "error"));
    expect(screen.getByLabelText("Retained final meeting notes")).toHaveValue(draft.notes);
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument());
    expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("merges recovered notes with newer saved edits and checks the version read, dirty editor: %s", async (dirtyEditor) => {
    const draft = { id: "draft-conflict", recordingId: "r1", baseNotes: "Original note", notes: "Original note\nRecovered condition." };
    const save = deferred<void>();
    let storedNotes = "Original note\nNewer saved decision.";
    backend.listMeetingNoteRecovery.mockResolvedValue([draft]);
    backend.getRecording.mockImplementation(async () => ({ ...recordings[0], meetingNotes: storedNotes }));
    backend.updateRecordingNotes.mockImplementationOnce(async (_recordingId, notes) => {
      await save.promise;
      storedNotes = notes;
    });
    render(<RecordingsView />);
    await screen.findByLabelText("Retained final meeting notes");
    fireEvent.click(screen.getByText("Weekly sync"));
    const editor = await screen.findByRole("textbox", { name: "General notes notes" });
    expect(editor).toHaveValue(storedNotes);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", expect.stringContaining("Recovered condition."), draft.id, "Original note\nNewer saved decision."));
    expect(backend.updateRecordingNotes.mock.calls.at(-1)[1]).toContain("Newer saved decision.");
    if (dirtyEditor) fireEvent.change(editor, { target: { value: storedNotes + "\nKeep my unsaved edit." } });
    await act(async () => save.resolve());
    await waitFor(() => expect(editor.value).toContain("Recovered condition."));
    expect(editor.value).toContain("Newer saved decision.");
    if (dirtyEditor) expect(editor.value).toContain("Keep my unsaved edit.");
    else expect(editor).toHaveValue("Original note\nNewer saved decision.\nRecovered condition.");
  });

  it("ignores an older recovery response after a newer refresh consumed its draft", async () => {
    const draft = { id: "late-draft", recordingId: "r1", baseNotes: "", notes: "Already saved condition." };
    let finish!: (drafts: typeof draft[]) => void;
    backend.listMeetingNoteRecovery.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<RecordingsView />);
    await waitFor(() => expect(eventListeners.has("meeting-note-recovery-changed")).toBe(true));
    backend.listMeetingNoteRecovery.mockResolvedValue([]);
    await act(async () => { eventListeners.get("meeting-note-recovery-changed")?.({ payload: { recordingId: "r1" } }); });
    await act(async () => finish([draft]));
    expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument();
  });

  it("refreshes recovery drafts when the popup journals or consumes a final note", async () => {
    render(<RecordingsView />);
    await waitFor(() => expect(eventListeners.has("meeting-note-recovery-changed")).toBe(true));
    const draft = { id: "popup-final", recordingId: "r1", baseNotes: "", notes: "Popup final condition." };
    backend.listMeetingNoteRecovery.mockResolvedValue([draft]);
    await act(async () => { eventListeners.get("meeting-note-recovery-changed")?.({ payload: { recordingId: "r1" } }); });
    expect(await screen.findByLabelText("Retained final meeting notes")).toHaveValue(draft.notes);
    backend.listMeetingNoteRecovery.mockResolvedValue([]);
    await act(async () => { eventListeners.get("meeting-note-recovery-changed")?.({ payload: { recordingId: "r1" } }); });
    await waitFor(() => expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument());
  });

  it("restores journaled final notes after remount and retries using their draft ID", async () => {
    const draft = { id: "draft-recovered", recordingId: "r1", baseNotes: "", notes: "Recovered final condition." };
    backend.listMeetingNoteRecovery.mockResolvedValue([draft]);
    render(<RecordingsView />);
    expect(await screen.findByLabelText("Retained final meeting notes")).toHaveValue(draft.notes);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", draft.notes, draft.id, expect.any(String)));
    await waitFor(() => expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument());
  });

  it("retains failed final notes after capture stops and retries without losing them", async () => {
    recordingState.isRecording = true;
    recordingState.recordingId = "r1";
    backend.updateRecordingNotes.mockRejectedValueOnce(new Error("Final notes save failed"));
    const view = render(<RecordingsView />);
    fireEvent.change(await screen.findByLabelText("Live meeting notes"), { target: { value: "Retain my final decision." } });
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
    expect(stopMeeting).toHaveBeenCalledTimes(1);
    recordingState.isRecording = false;
    recordingState.recordingId = null;
    view.rerender(<RecordingsView />);
    expect(await screen.findByLabelText("Retained final meeting notes")).toHaveValue("Retain my final decision.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry save" })).toBeEnabled());
    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.queryByLabelText("Retained final meeting notes")).not.toBeInTheDocument());
    expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith("r1", "Retain my final decision.", expect.any(String), expect.any(String));
  });

  it("shows the summary recovery advice without Electron transport details", async () => {
    backend.summarizeRecordingGrounded.mockRejectedValueOnce(new Error("Error invoking remote method 'sidecar:invoke': Error: The new recap failed its source checks. Your saved summary was kept."));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    const confirm = screen.queryByRole("button", { name: "Replace and regenerate" });
    if (confirm) fireEvent.click(confirm);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("The new recap failed its source checks. Your saved summary was kept.", "error"));
  });

  it("persists meeting note section edits through the notes autosave flow", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Align launch scope and decide owners" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nAlign launch scope and decide owners", undefined, expect.any(String));
    });
  });

  describe("meeting notes copy", () => {
    it("copies the exact loaded notes and the exact current edit", async () => {
      const clipboardWriteText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      const initialNotes = "Goals\n  Keep the original spacing.  \n";
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: initialNotes,
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const copyButton = await screen.findByRole("button", { name: "Copy notes" });

      fireEvent.click(copyButton);
      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenLastCalledWith(initialNotes);
      });

      fireEvent.change(screen.getByLabelText("Goals notes"), {
        target: { value: "  Keep the edited spacing.  \nAnd this final line." },
      });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenLastCalledWith(
          "Goals\n  Keep the edited spacing.  \nAnd this final line.",
        );
      });
    });

    it("waits for the clipboard acknowledgement and blocks a second write", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nConfirm the launch owner.",
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const copyButton = await screen.findByRole("button", { name: "Copy notes" });

      fireEvent.click(copyButton);
      fireEvent.click(copyButton);

      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      expect(copyButton).toBeDisabled();
      expect(screen.queryByText("Notes copied.")).not.toBeInTheDocument();

      await act(async () => write.resolve());

      expect(await screen.findByText("Notes copied.")).toBeInTheDocument();
      expect(copyButton).toBeEnabled();
    });

    it("keeps the note after a rejected write, explains manual copy, and retries", async () => {
      const clipboardWriteText = vi
        .fn()
        .mockRejectedValueOnce(new Error("Clipboard unavailable"))
        .mockResolvedValueOnce(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nKeep this note available.",
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const copyButton = await screen.findByRole("button", { name: "Copy notes" });
      const notes = screen.getByLabelText("Goals notes");

      fireEvent.click(copyButton);

      expect(
        await screen.findByText(
          "Could not copy the notes. Select them and copy them manually.",
        ),
      ).toBeInTheDocument();
      expect(notes).toHaveValue("Keep this note available.");

      fireEvent.click(copyButton);

      await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("Notes copied.")).toBeInTheDocument();
      expect(notes).toHaveValue("Keep this note available.");
    });

    it("disables copying when the current notes are blank", async () => {
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "  \n\t",
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));

      expect(
        await screen.findByRole("button", { name: "Copy notes" }),
      ).toBeDisabled();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("hides a late success after the notes change", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nOriginal copy source.",
      });

      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const copyButton = await screen.findByRole("button", { name: "Copy notes" });
      fireEvent.click(copyButton);

      fireEvent.change(screen.getByLabelText("Goals notes"), {
        target: { value: "Changed while the clipboard write was pending." },
      });
      await act(async () => write.resolve());

      await waitFor(() => expect(copyButton).toBeEnabled());
      expect(screen.queryByText("Notes copied.")).not.toBeInTheDocument();
    });
  });

  it("keeps a terse note in one section while another section is typed in", async () => {
    // A short unbulleted line used to be promoted to an empty heading and then
    // dropped by the next keystroke anywhere else on the canvas.
    const notes =
      "Goals\nAgree the launch order\n\nDecisions\nlegal signed off\n\nship date slipped";
    recordings[0] = { ...recordings[0], meetingNotes: notes };
    backend.getRecording.mockResolvedValue({ ...recordings[0] });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    expect(screen.getByLabelText("Decisions notes")).toHaveValue(
      "legal signed off\n\nship date slipped"
    );

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Agree the launch order and the owners" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nAgree the launch order and the owners\n\nDecisions\nlegal signed off\n\nship date slipped", undefined, expect.any(String));
    });
    expect(screen.getByLabelText("Decisions notes")).toHaveValue(
      "legal signed off\n\nship date slipped"
    );
  });

  describe("section body typing", () => {
    it("keeps a new line while typing a second line and saves both lines", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nFirst point",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const notes = await screen.findByLabelText("Goals notes");
      await user.click(notes);
      await user.keyboard("{End}{Enter}");
      expect(notes).toHaveFocus();
      expect(notes).toHaveValue("First point\n");

      await user.keyboard("Second point");

      expect(notes).toHaveFocus();
      expect(notes).toHaveValue("First point\nSecond point");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nFirst point\nSecond point",
          undefined,
          expect.any(String),
        );
      });
    });

    it("keeps a separating space while typing the next words", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nFirst point",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const notes = await screen.findByLabelText("Goals notes");
      await user.click(notes);
      await user.keyboard("{End} next step");

      expect(notes).toHaveFocus();
      expect(notes).toHaveValue("First point next step");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nFirst point next step",
          undefined,
          expect.any(String),
        );
      });
    });

    it("keeps a bullet marker in an empty custom section while its text is typed", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({ ...recordings[0], meetingNotes: "" });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(await screen.findByRole("button", { name: "Add section" }));

      const notes = screen.getByLabelText("Custom section notes");
      await user.click(notes);
      await user.keyboard("- ");
      expect(notes).toHaveValue("- ");

      await user.keyboard("Bullet text");

      expect(notes).toHaveFocus();
      expect(notes).toHaveValue("- Bullet text");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "## Custom section\n- Bullet text",
          undefined,
          expect.any(String),
        );
      });
    });

    it("keeps a blank line while typing a second paragraph and saves both paragraphs", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nFirst paragraph",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const notes = await screen.findByLabelText("Goals notes");
      await user.click(notes);
      await user.keyboard("{End}{Enter}{Enter}");
      expect(notes).toHaveValue("First paragraph\n\n");

      await user.keyboard("Second paragraph");

      expect(notes).toHaveFocus();
      expect(notes).toHaveValue("First paragraph\n\nSecond paragraph");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nFirst paragraph\n\nSecond paragraph",
          undefined,
          expect.any(String),
        );
      });
    });

    it("does not move a removed section's body draft into its neighbor", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "## Risks\nFirst body\n\n## Dependencies\nSecond body",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const risks = await screen.findByLabelText("Risks notes");
      const dependencies = screen.getByLabelText("Dependencies notes");
      await user.click(risks);
      await user.keyboard("{End} ");
      expect(risks).toHaveValue("First body ");

      await user.click(dependencies);
      expect(dependencies).toHaveFocus();
      expect(dependencies).toHaveValue("Second body");
      await user.click(screen.getByRole("button", { name: "Remove section Risks" }));

      expect(screen.queryByLabelText("Risks notes")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Dependencies notes")).toHaveValue("Second body");
    });
  });

  it("adds and removes custom meeting note sections", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Add section" });

    fireEvent.click(screen.getByRole("button", { name: "Add section" }));

    const customTitleInput = screen.getByDisplayValue("Custom section");
    fireEvent.change(customTitleInput, {
      target: { value: "Risks" },
    });
    fireEvent.change(screen.getByLabelText("Risks notes"), {
      target: { value: "Legal review may slip next week" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith("r1", "Risks\nLegal review may slip next week", undefined, expect.any(String));
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove section Risks" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Risks")).not.toBeInTheDocument();
    });
  });

  describe("section removal undo", () => {
    it("restores the removed section name, body, position, and persisted notes", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm launch scope\n\n## Risks\nLegal review may slip\n\n## Dependencies\nLegal approval",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );

      expect(screen.queryByLabelText("Risks notes")).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );

      expect(screen.getByLabelText("Risks notes")).toHaveValue(
        "Legal review may slip",
      );
      expect(
        screen.getAllByRole("textbox", { name: "Section title" }).map((input) =>
          (input as HTMLInputElement).value,
        ),
      ).toEqual(["Risks", "Dependencies"]);
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nConfirm launch scope\n\nRisks\nLegal review may slip\n\n## Dependencies\nLegal approval",
          undefined,
          expect.any(String),
        );
      });
    });

    it("preserves newer edits and sections when restoring an older removal", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nOriginal goal\n\n## Risks\nOriginal risk\n\n## Dependencies\nOriginal dependency",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      fireEvent.change(screen.getByLabelText("Goals notes"), {
        target: { value: "Newer goal" },
      });
      await user.click(screen.getByRole("button", { name: "Add section" }));
      fireEvent.change(screen.getByDisplayValue("Custom section"), {
        target: { value: "Next steps" },
      });
      fireEvent.change(screen.getByLabelText("Next steps notes"), {
        target: { value: "New section body" },
      });

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );

      expect(screen.getByLabelText("Goals notes")).toHaveValue("Newer goal");
      expect(screen.getByLabelText("Risks notes")).toHaveValue("Original risk");
      expect(screen.getByLabelText("Dependencies notes")).toHaveValue(
        "Original dependency",
      );
      expect(screen.getByLabelText("Next steps notes")).toHaveValue(
        "New section body",
      );
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nNewer goal\n\nRisks\nOriginal risk\n\n## Dependencies\nOriginal dependency\n\nNext steps\nNew section body",
          undefined,
          expect.any(String),
        );
      });
    });

    it("merges a removed body into a newer same-title section", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm scope\n\n## Risks\nOriginal risk\n\n## Dependencies\nOriginal dependency",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      const dependenciesTitle = screen.getByRole("textbox", {
        name: "Section title",
      });
      await user.clear(dependenciesTitle);
      await user.type(dependenciesTitle, "Risks");
      fireEvent.change(screen.getByLabelText("Risks notes"), {
        target: { value: "Newer risk" },
      });

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );

      expect(screen.getAllByLabelText("Risks notes")).toHaveLength(1);
      expect(screen.getByLabelText("Risks notes")).toHaveValue(
        "Newer risk\n\nOriginal risk",
      );
      expect(screen.getByText(/restored.*existing section/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nConfirm scope\n\nRisks\nNewer risk\n\nOriginal risk",
          undefined,
          expect.any(String),
        );
      });
    });

    it("does not duplicate an identical body in a same-title restore", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm scope\n\n## Risks\nShared risk\n\n## Dependencies\nShared risk",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      const dependenciesTitle = screen.getByRole("textbox", {
        name: "Section title",
      });
      await user.clear(dependenciesTitle);
      await user.type(dependenciesTitle, "Risks");

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );

      expect(screen.getAllByLabelText("Risks notes")).toHaveLength(1);
      expect(screen.getByLabelText("Risks notes")).toHaveValue("Shared risk");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nConfirm scope\n\nRisks\nShared risk",
          undefined,
          expect.any(String),
        );
      });
    });

    it("undoes multiple removals newest first", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm scope\n\n## Risks\nRisk body\n\n## Dependencies\nDependency body",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Remove section Dependencies" }),
      );

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );
      expect(screen.getByLabelText("Dependencies notes")).toHaveValue(
        "Dependency body",
      );
      expect(screen.queryByLabelText("Risks notes")).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );
      expect(screen.getByLabelText("Risks notes")).toHaveValue("Risk body");
      expect(
        screen.queryByRole("button", { name: "Undo remove section" }),
      ).not.toBeInTheDocument();
    });

    it("clears removal history when the playbook source changes", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nConfirm scope\n\n## Risks\nRisk body",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      expect(
        screen.getByRole("button", { name: "Undo remove section" }),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Playbook"), {
        target: { value: "standup" },
      });

      expect(
        screen.queryByRole("button", { name: "Undo remove section" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("section clear undo", () => {
    it("keeps a cleared template heading and restores its exact body through the saved notes", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm launch scope\n\n- Keep the owner list exact\n\n## Decisions\nShip Friday",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click((await screen.findAllByRole("button", { name: "Clear" }))[0]);

      expect(screen.getByText("Goals")).toBeInTheDocument();
      expect(screen.getByLabelText("Goals notes")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Undo clear section" }),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Undo clear section" }),
      );

      expect(screen.getByLabelText("Goals notes")).toHaveValue(
        "Confirm launch scope\n\n- Keep the owner list exact",
      );
      expect(screen.getByLabelText("Goals notes")).toHaveFocus();
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nConfirm launch scope\n\n- Keep the owner list exact\n\nDecisions\nShip Friday",
          undefined,
          expect.any(String),
        );
      });
    });

    it("merges a restored body after newer text and preserves edits in other sections", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nOriginal goal\n\n## Decisions\nOriginal decision",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click((await screen.findAllByRole("button", { name: "Clear" }))[0]);
      fireEvent.change(screen.getByLabelText("Goals notes"), {
        target: { value: "Newer goal" },
      });
      fireEvent.change(screen.getByLabelText("Decisions notes"), {
        target: { value: "Newer decision" },
      });

      await user.click(
        screen.getByRole("button", { name: "Undo clear section" }),
      );

      expect(screen.getByLabelText("Goals notes")).toHaveValue(
        "Newer goal\n\nOriginal goal",
      );
      expect(screen.getByLabelText("Decisions notes")).toHaveValue(
        "Newer decision",
      );
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "Goals\nNewer goal\n\nOriginal goal\n\nDecisions\nNewer decision",
          undefined,
          expect.any(String),
        );
      });
    });

    it("labels mixed clear and remove history by the newest entry kind", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes:
          "Goals\nConfirm scope\n\n## Decisions\nShip Friday\n\n## Risks\nLegal review",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click(
        await screen.findByRole("button", { name: "Remove section Risks" }),
      );
      await user.click(screen.getAllByRole("button", { name: "Clear" })[0]);

      await user.click(
        screen.getByRole("button", { name: "Undo clear section" }),
      );
      expect(screen.getByLabelText("Goals notes")).toHaveValue("Confirm scope");
      expect(
        screen.getByRole("button", { name: "Undo remove section" }),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Undo remove section" }),
      );
      expect(screen.getByLabelText("Risks notes")).toHaveValue("Legal review");
      expect(
        screen.queryByRole("button", { name: /Undo (?:clear|remove) section/ }),
      ).not.toBeInTheDocument();
    });

    it("disables Clear for empty template sections without creating history", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const clearButtons = await screen.findAllByRole("button", { name: "Clear" });
      expect(clearButtons.length).toBeGreaterThan(0);
      clearButtons.forEach((button) => expect(button).toBeDisabled());
      await user.click(clearButtons[0]);

      expect(
        screen.queryByRole("button", { name: /Undo (?:clear|remove) section/ }),
      ).not.toBeInTheDocument();
      expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    });

    it("clears section history when the playbook changes", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Goals\nConfirm scope",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await user.click((await screen.findAllByRole("button", { name: "Clear" }))[0]);
      expect(
        screen.getByRole("button", { name: "Undo clear section" }),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Playbook"), {
        target: { value: "standup" },
      });

      expect(
        screen.queryByRole("button", { name: /Undo (?:clear|remove) section/ }),
      ).not.toBeInTheDocument();
    });
  });

  describe("section title editing", () => {
    it("keeps focus while renaming a section with multiple words and preserves its body", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Risks\nLegal review may slip next week",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const title = await screen.findByRole("textbox", { name: "Section title" });
      await user.clear(title);
      await user.type(title, "Launch risks");

      expect(title).toHaveFocus();
      expect(title).toHaveValue("Launch risks");
      expect(screen.getByLabelText("Launch risks notes")).toHaveValue(
        "Legal review may slip next week",
      );
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "## Launch risks\nLegal review may slip next week",
          undefined,
          expect.any(String),
        );
      });
    });

    it("keeps a section through a transient empty title and restores its stored title on blur", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Risks\nKeep the body while the title is empty",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const title = await screen.findByRole("textbox", { name: "Section title" });
      await user.clear(title);

      expect(title).toHaveValue("");
      expect(screen.getByText("Keep the body while the title is empty")).toBeInTheDocument();
      await user.tab();

      expect(screen.getByRole("textbox", { name: "Section title" })).toHaveValue("Risks");
      expect(screen.getByLabelText("Risks notes")).toHaveValue(
        "Keep the body while the title is empty",
      );
    });

    it("retains typed spaces in the field and persists the trimmed heading words", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Risks\nConfirm the owner",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const title = await screen.findByRole("textbox", { name: "Section title" });
      await user.clear(title);
      await user.type(title, "  Launch risks  ");

      expect(title).toHaveValue("  Launch risks  ");
      await waitFor(() => {
        expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
          "r1",
          "## Launch risks\nConfirm the owner",
          undefined,
          expect.any(String),
        );
      });

      await user.tab();
      expect(screen.getByRole("textbox", { name: "Section title" })).toHaveValue(
        "Launch risks",
      );
    });

    it("keeps a raw title and focus through an identical settings refresh", async () => {
      const user = userEvent.setup();
      backend.getSettings.mockResolvedValue({ transcription: {} } as any);
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Risks\nConfirm the owner",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));
      await waitFor(() => expect(eventListeners.has("settings-changed")).toBe(true));

      const title = await screen.findByRole("textbox", { name: "Section title" });
      await user.clear(title);
      await user.type(title, "Follow ");
      expect(title).toHaveValue("Follow ");
      expect(title).toHaveFocus();

      const settingsReadsBeforeRefresh = backend.getSettings.mock.calls.length;
      await act(async () => {
        eventListeners.get("settings-changed")?.({ payload: null });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(backend.getSettings.mock.calls.length).toBeGreaterThan(
          settingsReadsBeforeRefresh,
        );
      });

      expect(title).toHaveValue("Follow ");
      expect(title).toHaveFocus();
    });

    it("does not reuse a draft when a renamed section is absorbed into a template heading", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "Risks\nKeep this body in the merged section",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const title = await screen.findByRole("textbox", { name: "Section title" });
      await user.clear(title);
      await user.type(title, "Goals");

      await waitFor(() => {
        expect(screen.queryByRole("textbox", { name: "Section title" })).not.toBeInTheDocument();
      });
      expect(screen.getByLabelText("Goals notes")).toHaveValue(
        "Keep this body in the merged section",
      );

      await user.click(screen.getByRole("button", { name: "Add section" }));

      expect(screen.getByRole("textbox", { name: "Section title" })).toHaveValue(
        "Custom section",
      );
      expect(screen.getByLabelText("Goals notes")).toHaveValue(
        "Keep this body in the merged section",
      );
    });

    it("clears the removed section draft, leaves its neighbor unchanged, and focuses Add section", async () => {
      const user = userEvent.setup();
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        meetingNotes: "## Risks\nFirst body\n\n## Dependencies\nSecond body",
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const [risksTitle] = await screen.findAllByRole("textbox", { name: "Section title" });
      await user.clear(risksTitle);
      await user.type(risksTitle, "Draft risk title");
      await user.click(screen.getByRole("button", { name: "Remove section Draft risk title" }));

      expect(screen.getByRole("button", { name: "Add section" })).toHaveFocus();
      expect(screen.getByRole("textbox", { name: "Section title" })).toHaveValue(
        "Dependencies",
      );
      expect(screen.getByLabelText("Dependencies notes")).toHaveValue("Second body");
      expect(screen.queryByDisplayValue("Draft risk title")).not.toBeInTheDocument();
    });
  });

  it("persists meeting chat history for the selected recording", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByText("Push meeting chat"));

    await waitFor(() => {
      expect(backend.updateMeetingChatMessages).toHaveBeenCalledWith("r1", [
        {
          id: "m1",
          role: "user",
          content: "What slipped?",
          templateId: null,
          citations: [],
          createdAt: "2026-03-06T12:00:00Z",
        },
        {
          id: "m2",
          role: "assistant",
          content: "Launch review slipped to Monday.",
          templateId: null,
          citations: [
            {
              text: "Let's move launch review to Monday",
              startTime: 2,
              endTime: 4,
              recordingId: "r1",
              certainty: 0.94,
            },
          ],
          createdAt: "2026-03-06T12:01:00Z",
        },
      ]);
    });
  });

  it("states the redaction level it applies to a meeting export", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    // The level is fixed at "basic" with no picker here, so the export surface
    // has to say what the file will and will not have scrubbed.
    const note = await screen.findByText(/basic redaction/i);
    expect(note.textContent).toContain("email addresses and phone numbers");
    expect(note.textContent).toContain("and nothing else");
    // Names the other levels too, so the sentence and the Exports picker share
    // one vocabulary instead of making the reader map a description onto it.
    expect(note.textContent).toContain("None");
    expect(note.textContent).toContain("Strict");
    // …and where the other levels live, since there is no picker here.
    expect(note.textContent).toContain("Exports");

    fireEvent.click(await screen.findByRole("button", { name: /Export as plain text/ }));

    await waitFor(() => {
      expect(backend.exportRecordingV2).toHaveBeenCalledWith("r1", "text", {
        redactionLevel: "basic",
        preview: false,
      });
    });
  });

  it("copies a grounded follow-up draft from the ask workspace", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy follow-up" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "Thanks all. Next steps: Jon will send the launch plan by Friday."
      );
    });
    expect(toast).toHaveBeenCalledWith("Follow-up draft copied.", "success");
  });

  it("can append a grounded follow-up draft into meeting notes", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to my notes" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "## Follow-up draft\nThanks all. Next steps: Jon will send the launch plan by Friday.", undefined, expect.any(String));
    });
  });

  it("shows one plain failure when both draft analyses return the same transport error", async () => {
    const error = new Error("Error invoking remote method 'sidecar:invoke': Error: Remote processing is disabled.");
    backend.summarizeRecordingGrounded.mockRejectedValueOnce(error);
    backend.extractActionItemsGrounded.mockRejectedValueOnce(error);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Remote processing is disabled.", "error"));
  });

  it("rehydrates a saved AI draft separately from written notes", async () => {
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({
      text: "## Summary\nSaved draft summary", generatedAt: "2026-10-12T12:00:00Z",
      rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [],
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Saved draft summary");
    expect(screen.getByText(/Saved separately/)).toBeInTheDocument();
    expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
  });

  it("opens saved AI draft transcript sources repeatedly and blocks other source kinds", async () => {
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({
      text: "## Summary\nSaved source navigation draft", generatedAt: "2026-10-12T12:00:00Z",
      rawNotesSnapshot: "",
      summaryCitations: [
        { text: "Draft summary source", recordingId: "r1", segmentId: "s1", startTime: 0, endTime: 1 },
        { text: "Other meeting source", recordingId: "r2", startTime: 0, endTime: 1 },
        { text: "Written draft source", recordingId: "r1", sourceKind: "meeting_note", segmentId: "meeting-note:0" },
        { text: "Invalid draft time", recordingId: "r1", startTime: -1, endTime: 1 },
      ],
      actionItemCitations: [{
        label: "Draft task",
        citations: [{ text: "Draft action source", recordingId: "r1", segmentId: "s2", startTime: 1, endTime: 2 }],
      }],
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Saved source navigation draft");
    const source = screen.getByRole("button", { name: /Draft summary source/ });
    expect(source).toBeEnabled();
    expect(source).toHaveTextContent("Unverified");
    expect(screen.getByRole("button", { name: /Other meeting source/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Invalid draft time/ })).toBeDisabled();
    expect(screen.getByText("Written draft source").closest("button")).toBeNull();
    expect(screen.getByText("Written draft source").closest('[aria-disabled="true"]')).not.toBeNull();

    fireEvent.click(source);
    await waitFor(() => expect(transcriptViewerProps.current?.sourceNavigation).toMatchObject({
      recordingId: "r1", segmentId: "s1", time: 0,
    }));
    const firstRequest = transcriptViewerProps.current.sourceNavigation.requestId;
    fireEvent.click(source);
    await waitFor(() => expect(transcriptViewerProps.current.sourceNavigation.requestId).toBeGreaterThan(firstRequest));
    fireEvent.click(screen.getByRole("button", { name: /Draft action source/ }));
    await waitFor(() => expect(transcriptViewerProps.current?.sourceNavigation).toMatchObject({
      recordingId: "r1", segmentId: "s2", time: 1,
    }));
    expect(backend.openRecordingAudio).not.toHaveBeenCalled();
    expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
  });

  it.each([null, { text: "Old stored preview", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] }])("saved AI draft removal ignores hydration predating a newer save: %s", async (oldDraft) => {
    const loading = deferred<any>();
    backend.getMeetingEnhancedNoteDraft.mockReturnValueOnce(loading.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Saved separately/);
    await act(async () => loading.resolve(oldDraft));
    fireEvent.click(screen.getByRole("button", { name: "Remove saved draft" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Enhanced meeting notes draft" })).not.toBeInTheDocument());
    expect(backend.deleteMeetingEnhancedNoteDraft).toHaveBeenCalledWith("r1");
    expect(screen.queryByText(/Saved separately/)).not.toBeInTheDocument();
  });

  it("saved AI draft removal deletes only the separate draft and supports retry", async () => {
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "Stored preview", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.deleteMeetingEnhancedNoteDraft.mockRejectedValueOnce(new Error("Storage unavailable"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved draft" }));
    await screen.findByText("Storage unavailable");
    expect(screen.getByText("Stored preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry remove saved draft" }));
    await waitFor(() => expect(screen.queryByText("Stored preview")).not.toBeInTheDocument());
    expect(backend.deleteMeetingEnhancedNoteDraft).toHaveBeenNthCalledWith(1, "r1");
    expect(backend.deleteMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(2);
    expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
    expect(backend.saveMeetingEnhancedNoteDraft).not.toHaveBeenCalled();
  });

  it("saved AI draft removal keeps a newer unsaved preview after acknowledgement", async () => {
    const removing = deferred<void>();
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "Stored preview", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.deleteMeetingEnhancedNoteDraft.mockReturnValueOnce(removing.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    await act(async () => removing.resolve());
    expect(screen.getByRole("region", { name: "Enhanced meeting notes draft" })).toBeInTheDocument();
    expect(screen.getByText(/Unsaved draft/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove saved draft" })).not.toBeInTheDocument();
  });

  it("saved AI draft removal drains before switching to another meeting", async () => {
    const removing = deferred<void>();
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "First stored draft", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "Second stored draft", generatedAt: "2026-10-12T12:01:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.deleteMeetingEnhancedNoteDraft.mockReturnValueOnce(removing.promise);
    recordings = [recordings[0], { ...recordings[0], id: "r2", title: "Launch review" }];
    backend.getRecording.mockImplementation(async (id) => recordings.find(recording => recording.id === id));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved draft" }));
    await act(async () => window.dispatchEvent(new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, { detail: { recordingId: "r2" } })));
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    await act(async () => removing.resolve());
    await screen.findByText("Second stored draft");
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
    expect(screen.getByRole("button", { name: "Remove saved draft" })).toBeEnabled();
    expect(backend.deleteMeetingEnhancedNoteDraft).toHaveBeenCalledWith("r1");
  });

  it("saved AI draft removal cannot erase a newer save already pending", async () => {
    const saving = deferred<any>();
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "Stored preview", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.saveMeetingEnhancedNoteDraft.mockReturnValueOnce(saving.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Remove saved draft" });
    fireEvent.click(screen.getByRole("button", { name: "Build it again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Remove saved draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove saved draft" }));
    expect(backend.deleteMeetingEnhancedNoteDraft).not.toHaveBeenCalled();
    await act(async () => saving.resolve(backend.saveMeetingEnhancedNoteDraft.mock.calls[0][1]));
    expect(screen.getByRole("button", { name: "Remove saved draft" })).toBeEnabled();
  });

  it("saved AI draft removal preserves a newer generation and queues its save", async () => {
    const removing = deferred<void>();
    backend.getMeetingEnhancedNoteDraft.mockResolvedValueOnce({ text: "Stored preview", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: [] });
    backend.deleteMeetingEnhancedNoteDraft.mockReturnValueOnce(removing.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved draft" }));
    await waitFor(() => expect(backend.deleteMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Removing saved draft…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Build it again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(backend.saveMeetingEnhancedNoteDraft).not.toHaveBeenCalled();
    await act(async () => removing.resolve());
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("region", { name: "Enhanced meeting notes draft" })).toBeInTheDocument();
    await screen.findByText(/Saved separately/);
    expect(screen.getByRole("button", { name: "Remove saved draft" })).toBeEnabled();
  });

  it("retains a saved AI draft preview after save rejection and allows retry", async () => {
    backend.saveMeetingEnhancedNoteDraft.mockRejectedValueOnce(new Error("Source notes changed in storage."));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    await screen.findByRole("alert");
    expect(screen.getByRole("region", {name: "Enhanced meeting notes draft"})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Retry save draft"}));
    await screen.findByText(/Saved separately/);
    expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(2);
    expect(backend.updateRecordingNotes).not.toHaveBeenCalled();
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
  });

  it("ignores late saved AI draft hydration after a new generation", async () => {
    const savedDraft = deferred<any>();
    backend.getMeetingEnhancedNoteDraft.mockReturnValueOnce(savedDraft.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    await act(async () => savedDraft.resolve({text: "Old stored draft", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: []}));
    expect(screen.queryByText("Old stored draft")).not.toBeInTheDocument();
    expect(screen.getByText(/Unsaved draft/)).toBeInTheDocument();
  });

  it("serializes saved AI draft writes across new generations", async () => {
    const saving = deferred<any>();
    const newerSaving = deferred<any>();
    backend.saveMeetingEnhancedNoteDraft.mockReturnValueOnce(saving.promise).mockReturnValueOnce(newerSaving.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    backend.summarizeRecordingGrounded.mockResolvedValueOnce({summary: "Newer draft summary", citations: [], model: "test", processingTimeMs: 1});
    fireEvent.click(screen.getByRole("button", {name: "Build it again"}));
    await screen.findByText("Newer draft summary");
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve({text: "Old save response", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: []}));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Old save response")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Saving draft…"})).toBeDisabled();
    await act(async () => newerSaving.resolve(backend.saveMeetingEnhancedNoteDraft.mock.calls[1][1]));
    expect(screen.getByText(/Saved separately/)).toBeInTheDocument();
    expect(screen.getByText("Newer draft summary")).toBeInTheDocument();
  });

  it("settles a saved AI draft save after source notes change without adopting its reply", async () => {
    const saving = deferred<any>();
    backend.saveMeetingEnhancedNoteDraft.mockReturnValueOnce(saving.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Goals notes"), {target: {value: "New source notes"}});
    await act(async () => saving.resolve({text: "Stale save response", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: []}));
    expect(screen.queryByText("Stale save response")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Saving draft…"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled();
    expect(screen.getByText(/Your notes changed while saving/)).toBeInTheDocument();
    expect(screen.getByText(/Unsaved draft/)).toBeInTheDocument();
  });

  it("ignores late saved AI draft hydration after switching meetings", async () => {
    const loading = deferred<any>();
    backend.getMeetingEnhancedNoteDraft.mockReturnValueOnce(loading.promise);
    recordings = [recordings[0], {...recordings[0], id: "r2", title: "Launch review"}];
    backend.getRecording.mockImplementation(async (id) => recordings.find(recording => recording.id === id));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    await act(async () => window.dispatchEvent(new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {detail: {recordingId: "r2"}})));
    await waitFor(() => expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review"));
    await act(async () => loading.resolve({text: "Other meeting draft", generatedAt: "2026-10-12T12:00:00Z", rawNotesSnapshot: "", summaryCitations: [], actionItemCitations: []}));
    expect(screen.queryByText("Other meeting draft")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Save draft"})).toBeDisabled();
  });

  it("waits for saved AI draft persistence before allowing view leave", async () => {
    const saving = deferred<any>();
    backend.saveMeetingEnhancedNoteDraft.mockReturnValueOnce(saving.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    const leaving = canLeaveMainView("recordings");
    let settled = false;
    void leaving.then(() => {settled = true;});
    await act(async () => {await Promise.resolve();});
    expect(settled).toBe(false);
    let allowed = false;
    await act(async () => {saving.resolve(backend.saveMeetingEnhancedNoteDraft.mock.calls[0][1]); allowed = await leaving;});
    expect(allowed).toBe(true);
  });

  it("refuses view leave when a newer saved AI draft write queues while waiting", async () => {
    const saving = deferred<any>();
    const newerSaving = deferred<any>();
    backend.saveMeetingEnhancedNoteDraft.mockReturnValueOnce(saving.promise).mockReturnValueOnce(newerSaving.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.click(screen.getByRole("button", {name: "Build a draft"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(1));
    const leaving = canLeaveMainView("recordings");
    fireEvent.click(screen.getByRole("button", {name: "Build it again"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Save draft"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name: "Save draft"}));
    let allowed = true;
    await act(async () => {saving.resolve(backend.saveMeetingEnhancedNoteDraft.mock.calls[0][1]); allowed = await leaving;});
    expect(allowed).toBe(false);
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledTimes(2));
    await act(async () => newerSaving.resolve(backend.saveMeetingEnhancedNoteDraft.mock.calls[1][1]));
    await act(async () => {allowed = await canLeaveMainView("recordings");});
    expect(allowed).toBe(true);
  });

  it("builds an enhanced notes draft with citations and saves it separately from meeting notes", async () => {
    let storedNotes = "";
    backend.getRecording.mockImplementation(async () => ({
      ...recordings[0],
      summary: "Test summary",
      actionItems: ["Ship launch checklist"],
      meetingNotes: storedNotes,
    }));
    backend.updateRecordingNotes.mockImplementation(async (_recordingId, notes, _recoveryDraftId, expectedNotes) => {
      if (expectedNotes !== undefined && expectedNotes !== storedNotes) {
        throw new Error("Meeting notes changed while saving.");
      }
      storedNotes = notes;
    });
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track with one open dependency.",
      citations: [
        {
          text: "We are on track for launch, pending legal approval.",
          startTime: 15,
          endTime: 21,
          recordingId: "r1",
          certainty: 0.97,
        },
      ],
      model: "test-model",
      processingTimeMs: 1200,
    });
    backend.extractActionItemsGrounded.mockResolvedValue({
      items: [
        {
          task: "Send legal review packet",
          assignee: "Jon",
          deadline: "Friday",
          citations: [
            {
              text: "Jon will send the legal review packet by Friday.",
              startTime: 34,
              endTime: 39,
              recordingId: "r1",
              certainty: 0.95,
            },
          ],
        },
      ],
      model: "test-model",
      processingTimeMs: 900,
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the launch blocked only on legal approval." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      );
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      );
    });

    const expectedDraft =
      "## Summary\n" +
      "Launch is on track with one open dependency.\n\n" +
      "## Action Items\n" +
      "- Send legal review packet (Owner: Jon · Due: Friday)\n\n" +
      "## Raw Notes Context\n" +
      "Goals\nKeep the launch blocked only on legal approval.";

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save draft" })).not.toBeDisabled();
    });
    // The draft is shown as the document it would become: markdown rendered,
    // not twelve rows of a read-only box.
    const draftRegion = screen.getByRole("region", {
      name: "Enhanced meeting notes draft",
    });
    expect(draftRegion).toHaveTextContent("Launch is on track with one open dependency.");
    expect(draftRegion).toHaveTextContent("Send legal review packet (Owner: Jon · Due: Friday)");
    expect(draftRegion.querySelector("li")).not.toBeNull();
    expect(screen.queryByDisplayValue(expectedDraft)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Test summary");
    expect(screen.getByLabelText("Action items")).toHaveTextContent(
      "Ship launch checklist"
    );
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledWith(
        "r1", expect.objectContaining({text: expectedDraft, rawNotesSnapshot: "Goals\nKeep the launch blocked only on legal approval."})
      );
      expect(storedNotes).toBe("Goals\nKeep the launch blocked only on legal approval.");
      expect(backend.updateRecordingAnalysis).not.toHaveBeenCalled();
    });
    expect(toast).toHaveBeenCalledWith("AI draft saved separately.", "success");
  });

  it("keeps edits made while an enhanced notes draft is being built", async () => {
    const summaryAnalysis = deferred<any>();
    const actionAnalysis = deferred<any>();
    backend.summarizeRecordingGrounded.mockReturnValueOnce(summaryAnalysis.promise);
    backend.extractActionItemsGrounded.mockReturnValueOnce(actionAnalysis.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Notes captured when generation began." },
    });
    await waitFor(() =>
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nNotes captured when generation began.",
        undefined,
        ""
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));
    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      );
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Manual summary typed while waiting." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: { value: "Manual task typed while waiting." },
    });
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Newer notes typed while waiting." },
    });

    await act(async () => {
      summaryAnalysis.resolve({
        summary: "Generated preview summary.",
        citations: [],
        model: "test-model",
        processingTimeMs: 1200,
      });
      actionAnalysis.resolve({
        items: [
          {
            task: "Generated preview task",
            assignee: null,
            deadline: null,
            citations: [],
          },
        ],
        model: "test-model",
        processingTimeMs: 900,
      });
      await Promise.all([summaryAnalysis.promise, actionAnalysis.promise]);
    });

    const draft = await screen.findByRole("region", {
      name: "Enhanced meeting notes draft",
    });
    expect(draft).toHaveTextContent("Generated preview summary.");
    expect(draft).toHaveTextContent("Generated preview task");
    expect(draft).toHaveTextContent("Notes captured when generation began.");
    expect(draft).not.toHaveTextContent("Newer notes typed while waiting.");
    expect(screen.getByLabelText("Summary")).toHaveValue(
      "Manual summary typed while waiting."
    );
    expect(screen.getByLabelText("Action items")).toHaveValue(
      "Manual task typed while waiting."
    );
    expect(screen.getByLabelText("Goals notes")).toHaveValue(
      "Newer notes typed while waiting."
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(toast).toHaveBeenCalledWith(
      "Your notes changed. Build a new draft before saving it.",
      "error"
    );
  });

  it("ignores a late enhanced draft after another meeting opens", async () => {
    const summaryAnalysis = deferred<any>();
    const actionAnalysis = deferred<any>();
    const otherMeeting = {
      ...recordings[0],
      id: "r2",
      title: "Planning review",
      audioPath: "/tmp/planning-review.wav",
      summary: "Planning summary stays visible.",
      actionItems: ["Keep the planning task"],
    } as Recording;
    recordings = [recordings[0], otherMeeting];
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordingId === otherMeeting.id
        ? otherMeeting
        : {
            ...recordings[0],
            summary: "Weekly summary stays with weekly sync.",
            actionItems: ["Keep the weekly task"],
          }
    );
    backend.summarizeRecordingGrounded.mockReturnValueOnce(summaryAnalysis.promise);
    backend.extractActionItemsGrounded.mockReturnValueOnce(actionAnalysis.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Weekly summary stays with weekly sync.");
    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));
    await waitFor(() =>
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      )
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: otherMeeting.id },
        })
      );
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Planning review")
    );
    expect(screen.getByLabelText("Summary")).toHaveTextContent(
      "Planning summary stays visible."
    );
    expect(screen.getByLabelText("Action items")).toHaveTextContent(
      "Keep the planning task"
    );

    await act(async () => {
      summaryAnalysis.resolve({
        summary: "Late weekly draft summary.",
        citations: [],
        model: "test-model",
        processingTimeMs: 1200,
      });
      actionAnalysis.resolve({
        items: [
          {
            task: "Late weekly draft task",
            assignee: null,
            deadline: null,
            citations: [],
          },
        ],
        model: "test-model",
        processingTimeMs: 900,
      });
      await Promise.all([summaryAnalysis.promise, actionAnalysis.promise]);
    });

    expect(screen.getByLabelText("Meeting title")).toHaveValue("Planning review");
    expect(screen.getByLabelText("Summary")).toHaveTextContent(
      "Planning summary stays visible."
    );
    expect(screen.getByLabelText("Action items")).toHaveTextContent(
      "Keep the planning task"
    );
    expect(
      screen.queryByRole("region", { name: "Enhanced meeting notes draft" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Late weekly draft summary.")).not.toBeInTheDocument();
    expect(screen.queryByText("Late weekly draft task")).not.toBeInTheDocument();
  });

  it("saves an enhanced notes draft separately after its source notes autosave finishes", async () => {
    let storedNotes = "";
    backend.getRecording.mockImplementation(async () => ({
      ...recordings[0],
      summary: "Test summary",
      actionItems: ["Ship launch checklist"],
      meetingNotes: storedNotes,
    }));
    backend.updateRecordingNotes.mockImplementation(async (_recordingId, notes, _recoveryDraftId, expectedNotes) => {
      if (expectedNotes !== undefined && expectedNotes !== storedNotes) {
        throw new Error("Meeting notes changed while saving.");
      }
      storedNotes = notes;
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Use the acknowledged source note." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
      "r1",
      "Goals\nUse the acknowledged source note.",
      undefined,
      ""
    ));

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(backend.saveMeetingEnhancedNoteDraft).toHaveBeenCalledWith(
      "r1", expect.objectContaining({rawNotesSnapshot: "Goals\nUse the acknowledged source note."})
    ));
    expect(storedNotes).toBe("Goals\nUse the acknowledged source note.");
    expect(toast).toHaveBeenCalledWith("AI draft saved separately.", "success");
  });

  it("keeps prior action items when enhanced-note action analysis fails", async () => {
    const summaryAnalysis = deferred<any>();
    backend.summarizeRecordingGrounded.mockReturnValueOnce(summaryAnalysis.promise);
    const summaryResult = {
      summary: "Fresh summary survived the partial failure.",
      citations: [],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 1200,
      grounded: true,
      provenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "test-model",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: true,
      },
    };
    backend.extractActionItemsGrounded.mockRejectedValueOnce(
      new Error("Action extraction timed out")
    );

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(await screen.findByRole("button", { name: "Build a draft" }));
    await waitFor(() =>
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        { persist: false }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: { value: "Manual fallback task typed while waiting" },
    });

    await act(async () => {
      summaryAnalysis.resolve(summaryResult);
      await summaryAnalysis.promise;
    });

    const draft = await screen.findByRole("region", {
      name: "Enhanced meeting notes draft",
    });
    expect(draft).toHaveTextContent("Fresh summary survived the partial failure.");
    expect(draft).toHaveTextContent("Manual fallback task typed while waiting");
    expect(draft).not.toHaveTextContent("Ship launch checklist");
    expect(screen.getByLabelText("Action items")).toHaveValue(
      "Manual fallback task typed while waiting"
    );
    expect(screen.getByLabelText("Summary")).toHaveTextContent("Test summary");
    expect(backend.updateRecordingAnalysis).not.toHaveBeenCalledWith("r1", {
      actionItems: ["Ship launch checklist"],
    });
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not redo the action items, so what was already saved was kept"
      ),
      "info"
    );
  });

  it("keeps the generated summary review warning in a copied recap", async () => {
    backend.getRecording.mockResolvedValue({ ...recordings[0], summary: "Older generated summary", actionItems: [],
      summaryProvenance: { version: 1, groundingPolicyVersion: 3, contentHash: "v1:sha256:test", actualProvider: "ollama", actualModel: "local-test", promptSource: "test", completedAt: "2026-07-25T12:00:00.000Z", citations: [{ text: "Original quote", recordingId: "r1", startTime: 15, endTime: 21 }], grounded: true },
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Needs review");
    fireEvent.click(screen.getByRole("button", { name: "Copy recap" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(copied).toContain("> Needs review: Check the summary against the meeting transcript and notes");
    expect(copied).toContain("Older generated summary");
    expect(copied).not.toContain("## Transcript");
  });

  it("copies a recap without the verbatim transcript", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Copy recap" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Tight weekly recap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: { value: "Ship launch checklist" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy recap" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    const copied = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(copied).toContain("## Summary");
    expect(copied).toContain("Tight weekly recap");
    expect(copied).not.toContain("> Needs review:");
    expect(copied).not.toContain("## Transcript");
    expect(toast).toHaveBeenCalledWith(
      "Recap copied — summary, action items, and notes. No transcript.",
      "success"
    );
  });

  it("only ships the verbatim transcript from the named full-record action", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("button", { name: "Copy recap" });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy full record, transcript and all",
      })
    );

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    const copied = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(copied).toContain("## Transcript");
    expect(copied).toContain("Transcript");
    expect(toast).toHaveBeenCalledWith(
      "Full record copied — includes the verbatim transcript.",
      "success"
    );
  });

  describe("meeting record copy ownership", () => {
    it("blocks duplicate recap writes until the clipboard settles", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const recap = await screen.findByRole("button", { name: "Copy recap" });

      fireEvent.click(recap);
      fireEvent.click(recap);

      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      expect(recap).toBeDisabled();
      await act(async () => write.resolve());
      expect(recap).toBeEnabled();
    });

    it("shares one pending lock between recap and full-record copies", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const recap = await screen.findByRole("button", { name: "Copy recap" });
      const fullRecord = screen.getByRole("button", {
        name: "Copy full record, transcript and all",
      });

      fireEvent.click(recap);
      fireEvent.click(fullRecord);

      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      expect(recap).toBeDisabled();
      expect(fullRecord).toBeDisabled();
      await act(async () => write.resolve());
      expect(recap).toBeEnabled();
      expect(fullRecord).toBeEnabled();
    });

    it("suppresses an old meeting acknowledgement and unlocks the current meeting", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      const launchReview = {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
      } as Recording;
      recordings = [recordings[0], launchReview];
      backend.getRecording.mockImplementation(async (recordingId: string) => ({
        ...(recordingId === "r1" ? recordings[0] : launchReview),
        summary: recordingId === "r1" ? "Weekly summary" : "Launch summary",
        actionItems: [],
      }));
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Copy recap" }));

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      const currentRecap = await screen.findByRole("button", { name: "Copy recap" });
      expect(currentRecap).toBeDisabled();
      await act(async () => write.resolve());

      expect(currentRecap).toBeEnabled();
      expect(toast).not.toHaveBeenCalledWith(
        "Recap copied — summary, action items, and notes. No transcript.",
        "success",
      );
    });

    it("suppresses the acknowledgement when the copied recap changes", async () => {
      const write = deferred<void>();
      const clipboardWriteText = vi.fn(() => write.promise);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Copy recap" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
      fireEvent.change(screen.getByLabelText("Summary"), {
        target: { value: "Edited while the clipboard write was pending" },
      });
      fireEvent.change(screen.getByLabelText("Summary"), {
        target: { value: "Test summary" },
      });

      await act(async () => write.resolve());

      expect(toast).not.toHaveBeenCalledWith(
        "Recap copied — summary, action items, and notes. No transcript.",
        "success",
      );
      expect(screen.getByRole("button", { name: "Copy recap" })).toBeEnabled();
    });

    it("keeps the meeting visible after failure and supports a manual retry", async () => {
      const clipboardWriteText = vi.fn()
        .mockRejectedValueOnce(new Error("Clipboard unavailable"))
        .mockResolvedValueOnce(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
      });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const recap = await screen.findByRole("button", { name: "Copy recap" });

      fireEvent.click(recap);
      await waitFor(() => expect(toast).toHaveBeenCalledWith(
        "Could not copy the meeting recap. The meeting is still open so you can copy it manually and retry.",
        "error",
      ));
      expect(screen.getByLabelText("Summary")).toHaveTextContent("Test summary");
      expect(recap).toBeEnabled();

      fireEvent.click(recap);
      await waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledTimes(2);
        expect(toast).toHaveBeenCalledWith(
          "Recap copied — summary, action items, and notes. No transcript.",
          "success",
        );
      });
    });
  });

  it("uses persisted consent state in review metadata and markdown exports", async () => {
    recordings = [
      {
        ...recordings[0],
        consentPromptShown: true,
        consentNoticeMode: "manual_required",
        consentNoticeMessage:
          "Manual reminder only. Copy the consent notice from Plainsong before you continue.",
      },
    ];
    backend.getRecording.mockResolvedValue(recordings[0]);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    expect(screen.getByText("Manual reminder required")).toBeInTheDocument();
    expect(
      screen.getByText("Manual reminder only. Copy the consent notice from Plainsong before you continue.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy recap" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("- Consent: Manual reminder required")
      );
    });
  });

  it("exports meeting artifacts from the review workspace and opens the result", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    fireEvent.click(screen.getAllByRole("button", { name: "Export as Markdown" })[0]);

    await waitFor(() => {
      expect(backend.exportRecordingV2).toHaveBeenCalledWith("r1", "markdown", {
        redactionLevel: "basic",
        preview: false,
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(backend.openExportPath).toHaveBeenCalledWith("/tmp/weekly-sync.md");
    });
  });

  it("waits for the visible meeting draft to persist before exporting", async () => {
    const notesSave = deferred<void>();
    backend.updateRecordingNotes.mockReturnValueOnce(notesSave.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Export this latest decision" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nExport this latest decision",
        undefined,
        expect.any(String),
      );
    });
    expect(backend.exportRecordingV2).not.toHaveBeenCalled();

    await act(async () => notesSave.resolve());

    await waitFor(() => {
      expect(backend.exportRecordingV2).toHaveBeenCalledWith("r1", "markdown", {
        redactionLevel: "basic",
        preview: false,
      });
    });
  });

  it("waits for the latest title, summary, and action items before exporting", async () => {
    const titleSave = deferred<void>();
    const analysisSave = deferred<void>();
    backend.renameRecording.mockReturnValueOnce(titleSave.promise);
    backend.updateRecordingAnalysis.mockReturnValueOnce(analysisSave.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    const title = screen.getByLabelText("Meeting title");
    title.focus();
    fireEvent.change(title, { target: { value: "Current planning title" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Current planning summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: { value: "Send the current plan\nConfirm the launch owner" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Current planning title");
    });
    expect(backend.exportRecordingV2).not.toHaveBeenCalled();

    await act(async () => titleSave.resolve());
    await waitFor(() => {
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith("r1", {
        summary: "Current planning summary",
        actionItems: ["Send the current plan", "Confirm the launch owner"],
      });
    });
    expect(backend.exportRecordingV2).not.toHaveBeenCalled();

    await act(async () => analysisSave.resolve());
    await waitFor(() => expect(backend.exportRecordingV2).toHaveBeenCalledWith(
      "r1",
      "markdown",
      { redactionLevel: "basic", preview: false },
    ));
  });

  it("does not export when the visible meeting draft cannot be saved", async () => {
    backend.updateRecordingNotes.mockRejectedValueOnce(new Error("Notes save failed"));

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Do not export an older note" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));

    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Your changes are still saving. Keep this meeting open and try exporting again.",
        "error",
      );
    });
    expect(backend.exportRecordingV2).not.toHaveBeenCalled();
  });

  it("refuses an export when the meeting changes again while its first draft saves", async () => {
    const notesSave = deferred<void>();
    backend.updateRecordingNotes.mockReturnValueOnce(notesSave.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "First export draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Newer draft typed during the save" },
    });
    await act(async () => notesSave.resolve());

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Your changes are still saving. Keep this meeting open and try exporting again.",
        "error",
      );
    });
    expect(backend.exportRecordingV2).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Goals notes")).toHaveValue(
      "Newer draft typed during the save",
    );
  });

  it.each(["success", "failure"])("keeps an older meeting export %s from taking over the current meeting export", async (outcome) => {
    const firstExport = deferred<any>();
    const currentExport = deferred<any>();
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.getRecording.mockImplementation(async (recordingId: string) => ({
      ...(recordings.find((recording) => recording.id === recordingId) ?? recordings[0]),
      summary: "Test summary",
      actionItems: ["Ship launch checklist"],
    }));
    backend.exportRecordingV2.mockImplementation((recordingId: string) =>
      recordingId === "r1" ? firstExport.promise : currentExport.promise
    );

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    await waitFor(() => expect(backend.exportRecordingV2).toHaveBeenCalledWith(
      "r1",
      "markdown",
      { redactionLevel: "basic", preview: false },
    ));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
        detail: { recordingId: "r2" },
      }));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
    });

    const currentExportButton = screen.getByRole("button", { name: "Export as Markdown" });
    expect(currentExportButton).toBeEnabled();
    fireEvent.click(currentExportButton);
    await waitFor(() => expect(backend.exportRecordingV2).toHaveBeenCalledWith(
      "r2",
      "markdown",
      { redactionLevel: "basic", preview: false },
    ));

    await act(async () => {
      if (outcome === "failure") firstExport.reject(new Error("Old meeting export failed"));
      else firstExport.resolve({
        format: "markdown",
        redactionLevel: "basic",
        preview: false,
        exportPath: "/tmp/weekly-sync-old.md",
        content: null,
      });
    });
    expect(screen.queryByText("/tmp/weekly-sync-old.md")).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith("Old meeting export failed", "error");
    expect(currentExportButton).toBeDisabled();

    await act(async () => currentExport.resolve({
      format: "markdown",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/launch-review.md",
      content: null,
    }));
    expect(await screen.findByText("/tmp/launch-review.md")).toBeInTheDocument();
    expect(currentExportButton).toBeEnabled();
  });

  it("explains transcript-only retention when meeting audio is not saved", async () => {
    recordings = [
      {
        ...recordings[0],
        audioPath: "",
      },
    ] as Recording[];
    backend.getRecording.mockResolvedValue(recordings[0]);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    expect(await screen.findByText("No audio")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Audio" }), { button: 0 });
    expect(
      await screen.findByText(
        "The audio was never saved, or has already been deleted. Transcript, notes, summary, and action items stay here until this meeting is deleted."
      )
    ).toBeInTheDocument();
  });

  it("ignores stale meeting chat loads after switching recordings", async () => {
    recordings = [
      {
        id: "r1",
        title: "Weekly sync",
        projectId: "default",
        duration: 120,
        createdAt: "2026-03-06T12:00:00Z",
        updatedAt: "2026-03-06T12:00:00Z",
        sourceType: "meeting",
        audioPath: "/tmp/weekly-sync.wav",
        meetingCaptureMode: "me_and_them",
        status: "completed",
      },
      {
        id: "r2",
        title: "Launch review",
        projectId: "default",
        duration: 90,
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
        sourceType: "meeting",
        audioPath: "/tmp/launch-review.wav",
        meetingCaptureMode: "mic_only",
        status: "completed",
      },
    ] as Recording[];
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordings.find((recording) => recording.id === recordingId) ?? null
    );

    const firstChatLoad = deferred<Awaited<ReturnType<typeof backend.getMeetingChatMessages>>>();
    backend.getMeetingChatMessages
      .mockReturnValueOnce(firstChatLoad.promise)
      .mockResolvedValueOnce([
        {
          id: "r2-message",
          role: "assistant",
          content: "Fresh launch review answer.",
          templateId: null,
          citations: [],
          createdAt: "2026-03-06T13:01:00Z",
        },
      ]);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Launch review"));
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));

    await waitFor(() => {
      expect(screen.getByText("1 chat messages")).toBeInTheDocument();
    });

    firstChatLoad.resolve([
      {
        id: "stale-message",
        role: "assistant",
        content: "Stale weekly sync answer.",
        templateId: null,
        citations: [],
        createdAt: "2026-03-06T12:05:00Z",
      },
      {
        id: "stale-message-2",
        role: "assistant",
        content: "Another stale answer.",
        templateId: null,
        citations: [],
        createdAt: "2026-03-06T12:06:00Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("1 chat messages")).toBeInTheDocument();
    });

    expect(screen.queryByText("2 chat messages")).not.toBeInTheDocument();
  });

  it("opens the live meeting workspace from the in-progress recorder card", async () => {
    recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
    };
    recordings = [
      {
        ...recordings[0],
        status: "recording",
      },
    ] as Recording[];
    backend.getRecording.mockResolvedValue(recordings[0]);

    render(<RecordingsView />);

    expect(screen.getByText("Open this meeting")).toBeInTheDocument();
    expect(screen.getByText("Me + Them")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open this meeting" }));

    await screen.findByRole("heading", { name: "Transcript", exact: true });
    expect(screen.getAllByText("Me + Them").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.getByTestId("meeting-secondary-details")).toHaveAttribute("open");
  });

  it("detected-call readiness uses loading-to-ready state after rerender", async () => {
    const ready = readinessContext.productReadiness;
    readinessContext.productReadiness = {
      ...ready,
      meetingsCapture: { domain: "meetings_capture", state: "loading", cause: {
        id: "loading", message: "Refreshing meeting readiness.",
      } },
    };
    const { rerender } = render(<RecordingsView />);
    readinessContext.productReadiness = ready;
    rerender(<RecordingsView />);
    act(() => publishCallCaptureRequest({
      callId: 51, app: "zoom", appLabel: "Zoom", videoService: "zoom",
      detectedAtMs: new Date(2026, 8, 2, 14, 5, 0).getTime(),
    }));

    await screen.findByRole("dialog", { name: "Meeting consent" });
    expect(startMeeting).not.toHaveBeenCalled();
    startMeeting.mockResolvedValueOnce("r-live");
    fireEvent.click(screen.getByRole("button", { name: "Confirm meeting consent" }));
    await waitFor(() => expect(startMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ detectedCallId: 51, videoService: "zoom" }),
    ));
    await waitFor(() => expect(backend.renameRecording).toHaveBeenCalledWith(
      "r-live", "Zoom call, 14:05",
    ));
  });

  it("detected-call readiness uses ready-to-blocked state after rerender", async () => {
    const { rerender } = render(<RecordingsView />);
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      meetingsCapture: { domain: "meetings_capture", state: "blocked", cause: {
        id: "microphone", message: "Microphone access is required.",
        action: { id: "open_settings", label: "Open settings", destination: "setup" },
      } },
    };
    rerender(<RecordingsView />);
    act(() => publishCallCaptureRequest({
      callId: 52, app: "zoom", appLabel: "Zoom", videoService: "zoom",
      detectedAtMs: new Date(2026, 8, 2, 14, 5, 0).getTime(),
    }));

    expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Microphone access is required.", "error");
    expect(startMeeting).not.toHaveBeenCalled();
  });

  it("carries the accepted call offer's id and service into the capture", async () => {
    // The sidecar binds this meeting's auto-stop to exactly this call. A
    // capture that arrived without the id would let any call that happened to
    // be live when it started stop it later.
    startMeeting.mockResolvedValueOnce("r-live");
    publishCallCaptureRequest({
      callId: 12,
      app: "zoom",
      appLabel: "Zoom",
      videoService: "zoom",
      detectedAtMs: new Date(2026, 8, 2, 14, 5, 0).getTime(),
    });

    render(<RecordingsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

    await waitFor(() => {
      expect(startMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ detectedCallId: 12, videoService: "zoom" }),
      );
    });
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r-live", "Zoom call, 14:05");
    });
  });

  describe("menu bar and link start requests", () => {
    it("opens the consent sheet for a request made before Meetings was showing", async () => {
      // Main sends the request while another view is showing; App parks it.
      queueMeetingStartRequest();

      render(<RecordingsView />);

      expect(await screen.findByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
      expect(startMeeting).not.toHaveBeenCalled();
    });

    it("opens the consent sheet for a request made while Meetings is showing", async () => {
      render(<RecordingsView />);
      expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument();

      act(() => {
        queueMeetingStartRequest();
      });

      expect(await screen.findByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
    });

    it("holds a parked request until readiness has loaded", async () => {
      const ready = readinessContext.productReadiness;
      readinessContext.productReadiness = {
        ...ready,
        meetingsCapture: {
          domain: "meetings_capture",
          state: "unknown",
          cause: {
            id: "loading",
            message: "Plainsong is still checking this setup.",
            action: { id: "retry", label: "Retry", destination: "setup" },
          },
        },
      };
      try {
        queueMeetingStartRequest();
        const view = render(<RecordingsView />);
        expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument();

        readinessContext.productReadiness = ready;
        view.rerender(<RecordingsView />);

        expect(await screen.findByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
      } finally {
        readinessContext.productReadiness = ready;
      }
    });
  });

  it("starts a meeting nobody offered without binding it to a call", async () => {
    startMeeting.mockResolvedValueOnce("r-live");

    render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

    await waitFor(() => {
      expect(startMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ detectedCallId: undefined, videoService: undefined }),
      );
    });
  });

  it("starts meeting capture after consent and stops an active meeting", async () => {
    startMeeting.mockResolvedValueOnce("r-live");

    const firstView = render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

    await waitFor(() => {
      expect(startMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          systemAudio: true,
          projectId: "default",
        }),
      );
    });

    recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
    };

    // Otherwise the first view shows its own Stop button once it re-renders
    // with the live state, and this fails or passes depending on timing.
    firstView.unmount();
    render(<RecordingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));

    await waitFor(() => {
      expect(stopMeeting).toHaveBeenCalledTimes(1);
    });
  });

  describe("meeting dictation separation", () => {
    it("hides meeting controls and disables meeting entry points during dictation", async () => {
      recordingState.isRecording = true;
      recordingState.recordingId = "old-meeting-id";
      recordingMode = "dictation";
      render(<RecordingsView />);

      expect(
        await screen.findByText(
          "Dictation is active. Finish it before starting a meeting.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop meeting" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pause meeting" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Live meeting notes")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New meeting" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Import audio…" })).toBeDisabled();
    });

    it("restores meeting entry after dictation ends", async () => {
      recordingState.isRecording = true;
      recordingMode = "dictation";
      const view = render(<RecordingsView />);
      expect(await screen.findByRole("button", { name: "New meeting" })).toBeDisabled();

      recordingState.isRecording = false;
      recordingState.recordingId = null;
      recordingMode = null;
      view.rerender(<RecordingsView />);

      expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
    });

    it("blocks an already-open meeting consent step when dictation starts", async () => {
      const view = render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      expect(await screen.findByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();

      recordingState.isRecording = true;
      recordingMode = "dictation";
      view.rerender(<RecordingsView />);

      expect(
        screen.getAllByText("Dictation is active. Finish it before starting a meeting."),
      ).not.toHaveLength(0);
      const consent = screen.getByRole("button", { name: "Confirm meeting consent" });
      expect(consent).toBeDisabled();
      fireEvent.click(consent);
      expect(startMeeting).not.toHaveBeenCalled();
    });

    it("keeps meeting controls and live notes for meeting capture", async () => {
      recordingState.isRecording = true;
      recordingState.recordingId = "r1";
      recordingMode = "meeting";
      render(<RecordingsView />);

      expect(await screen.findByRole("button", { name: "Stop meeting" })).toBeEnabled();
      expect(screen.getAllByRole("button", { name: "Pause meeting" }).length).toBeGreaterThan(0);
      expect(screen.getByLabelText("Live meeting notes")).toBeInTheDocument();
      expect(
        screen.queryByText("Dictation is active. Finish it before starting a meeting."),
      ).not.toBeInTheDocument();
    });
  });

  it("surfaces a Stop failure instead of returning an unhandled rejection", async () => {
    stopMeeting.mockRejectedValueOnce(new Error("Meeting audio is still finalizing"));
    recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
      meetingPhase: "recording",
      meetingMessage: null,
    };

    render(<RecordingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Meeting audio is still finalizing",
        "error",
      );
    });
    expect(screen.getByRole("button", { name: "Stop meeting" })).toBeEnabled();
  });

  describe("meeting stop recovery", () => {
    it("keeps exact live notes and an enabled retry with an inline error", async () => {
      stopMeeting.mockRejectedValueOnce(new Error("Meeting audio is still finalizing"));
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
      };
      render(<RecordingsView />);
      const notes = await screen.findByLabelText("Live meeting notes");
      fireEvent.change(notes, {
        target: { value: "  Keep this exact note.\n\nSecond line.  " },
      });

      fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Stop was not confirmed. Capture may still be running. Meeting audio is still finalizing Try Stop meeting again.",
      );
      expect(notes).toHaveValue("  Keep this exact note.\n\nSecond line.  ");
      expect(screen.getByRole("button", { name: "Stop meeting" })).toBeEnabled();
    });

    it("does not show the IPC transport wrapper in a stop error", async () => {
      stopMeeting.mockRejectedValueOnce(
        new Error("Error invoking remote method 'sidecar:invoke': Error: Meeting audio is still finalizing"),
      );
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
      };
      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop meeting" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Meeting audio is still finalizing");
      expect(alert.textContent).not.toMatch(/remote method|sidecar:invoke/);
    });

    it("coalesces duplicate clicks while the stop request is pending", async () => {
      const pendingStop = deferred<void>();
      stopMeeting.mockReturnValueOnce(pendingStop.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
      };
      render(<RecordingsView />);

      const stopButton = await screen.findByRole("button", { name: "Stop meeting" });
      fireEvent.click(stopButton);
      const stoppingButton = screen.getByRole("button", { name: "Stopping…" });
      expect(stoppingButton).toBeDisabled();
      fireEvent.click(stopButton);
      fireEvent.click(stoppingButton);
      expect(stopMeeting).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingStop.resolve(undefined);
        await pendingStop.promise;
      });
    });

    it("does not show meeting A's late failure on meeting B", async () => {
      const pendingStop = deferred<void>();
      stopMeeting.mockReturnValueOnce(pendingStop.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
      };
      const view = render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop meeting" }));

      recordingState = {
        isRecording: true,
        recordingId: "meeting-b",
        formattedDuration: "00:12",
        meetingPhase: "recording",
        meetingMessage: null,
      };
      view.rerender(<RecordingsView />);
      await act(async () => {
        pendingStop.reject(new Error("meeting A failed late"));
        await pendingStop.promise.catch(() => undefined);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop meeting" })).toBeEnabled();
      expect(toast).not.toHaveBeenCalledWith("meeting A failed late", "error");
    });
  });

  describe("meeting pause ownership", () => {
    it("coalesces a pending pause and keeps exact live notes editable", async () => {
      const pendingPause = deferred<void>();
      pauseMeeting.mockReturnValueOnce(pendingPause.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      render(<RecordingsView />);
      const notes = await screen.findByLabelText("Live meeting notes");
      const exactNotes = "  Decision one.\n\nKeep this spacing.  ";
      fireEvent.change(notes, { target: { value: exactNotes } });

      const pauseButton = screen.getAllByRole("button", { name: "Pause meeting" })[0];
      fireEvent.click(pauseButton);
      const pendingButtons = screen.getAllByRole("button", { name: "Pause meeting" });
      expect(pendingButtons).not.toHaveLength(0);
      for (const pendingButton of pendingButtons) {
        expect(pendingButton).toBeDisabled();
        expect(pendingButton).toHaveTextContent("Pausing…");
      }
      fireEvent.click(pauseButton);
      fireEvent.click(pendingButtons[0]);

      expect(pauseMeeting).toHaveBeenCalledTimes(1);
      expect(notes).toHaveValue(exactNotes);
      await act(async () => {
        pendingPause.resolve(undefined);
        await pendingPause.promise;
      });
    });

    it("shows a current pause failure inline and permits retry", async () => {
      pauseMeeting
        .mockRejectedValueOnce(new Error("pause request failed"))
        .mockResolvedValueOnce(undefined);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      render(<RecordingsView />);

      fireEvent.click((await screen.findAllByRole("button", { name: "Pause meeting" }))[0]);
      expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("pause request failed");
      const retry = screen.getAllByRole("button", { name: "Pause meeting" })[0];
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      await waitFor(() => expect(pauseMeeting).toHaveBeenCalledTimes(2));
    });

    it("keeps the pending pause label after native confirmation and suppresses its late rejection", async () => {
      const pendingPause = deferred<void>();
      pauseMeeting.mockReturnValueOnce(pendingPause.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      const view = render(<RecordingsView />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Pause meeting" }))[0]);

      recordingState.meetingPaused = true;
      view.rerender(<RecordingsView />);
      const confirmedControls = screen.getAllByRole("button", { name: "Resume meeting" });
      expect(confirmedControls).not.toHaveLength(0);
      for (const control of confirmedControls) {
        expect(control).toBeDisabled();
        expect(control).toHaveTextContent("Pausing…");
      }

      await act(async () => {
        pendingPause.reject(new Error("late pause request failure"));
        await pendingPause.promise.catch(() => undefined);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(toast).not.toHaveBeenCalledWith("late pause request failure", "error");
      for (const control of screen.getAllByRole("button", { name: "Resume meeting" })) {
        expect(control).toBeEnabled();
        expect(control).toHaveTextContent("Resume");
      }
    });

    it("does not run the pause shortcut while stop is pending", async () => {
      const pendingStop = deferred<void>();
      stopMeeting.mockReturnValueOnce(pendingStop.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop meeting" }));

      fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

      expect(pauseMeeting).not.toHaveBeenCalled();
      await act(async () => {
        pendingStop.resolve(undefined);
        await pendingStop.promise;
      });
    });

    it("does not show meeting A's late pause failure on meeting B", async () => {
      const pendingPause = deferred<void>();
      pauseMeeting.mockReturnValueOnce(pendingPause.promise);
      recordingState = {
        isRecording: true,
        recordingId: "meeting-a",
        formattedDuration: "02:04",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      const view = render(<RecordingsView />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Pause meeting" }))[0]);

      recordingState = {
        isRecording: true,
        recordingId: "meeting-b",
        formattedDuration: "00:12",
        meetingPhase: "recording",
        meetingMessage: null,
        meetingPaused: false,
      };
      view.rerender(<RecordingsView />);
      await act(async () => {
        pendingPause.reject(new Error("meeting A pause failed late"));
        await pendingPause.promise.catch(() => undefined);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      for (const pauseButton of screen.getAllByRole("button", { name: "Pause meeting" })) {
        expect(pauseButton).toBeEnabled();
      }
      expect(toast).not.toHaveBeenCalledWith("meeting A pause failed late", "error");
    });
  });

  it("searches meeting notes, recaps, and action items, not just the title and date", async () => {
    recordings = [
      {
        ...recordings[0],
        id: "r1",
        title: "Weekly sync",
        summary: "Pricing stays flat through Q3.",
        actionItems: ["Send the renewal packet"],
        meetingNotes: "Goals\nDecide the renewal path",
      },
      {
        ...recordings[0],
        id: "r2",
        title: "Design review",
        createdAt: "2026-03-05T12:00:00Z",
        summary: "",
        actionItems: [],
        meetingNotes: "",
      },
    ] as Recording[];

    render(<RecordingsView />);

    fireEvent.change(screen.getByLabelText("Search meetings"), {
      target: { value: "renewal packet" },
    });

    await waitFor(() => {
      expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    });
    expect(screen.queryByText("Design review")).not.toBeInTheDocument();
  });

  it("opens a transcript search hit at the moment it was found", async () => {
    backend.searchTranscripts.mockResolvedValue([
      {
        recordingId: "r1",
        recordingTitle: "Weekly sync",
        projectId: "default",
        segmentId: "s7",
        text: "We should push the launch review to Monday.",
        startTime: 92.5,
        endTime: 96,
        score: -3.2,
      },
    ]);

    render(<RecordingsView />);

    fireEvent.change(screen.getByLabelText("Search meetings"), {
      target: { value: "launch review" },
    });

    await waitFor(() => {
      expect(backend.searchTranscripts).toHaveBeenCalledWith(
        "launch review",
        25,
        undefined,
        "meeting",
        undefined,
      );
    });

    const hit = await screen.findByText("We should push the launch review to Monday.");
    fireEvent.click(hit);

    // The workspace opens on the transcript, positioned at the hit, with the
    // query carried across so the match is highlighted where it was found.
    await waitFor(() => {
      expect(transcriptViewerProps.current?.currentTime).toBe(92.5);
    });
    expect(transcriptViewerProps.current?.highlightQuery).toBe("launch review");
    expect(screen.getByLabelText("Find in transcript")).toHaveValue("launch review");
  });

  describe("meeting transcript search ownership", () => {
    const hit = (text: string, segmentId: string) => ({
      recordingId: "r1",
      recordingTitle: "Weekly sync",
      projectId: "default",
      segmentId,
      text,
      startTime: 12,
      endTime: 16,
      score: -2,
    });

    it("removes old transcript hits as soon as the query changes", async () => {
      backend.searchTranscripts.mockResolvedValueOnce([
        hit("The alpha decision is final.", "alpha-hit"),
      ]);
      render(<RecordingsView />);
      const search = screen.getByLabelText("Search meetings");

      fireEvent.change(search, { target: { value: "alpha decision" } });
      expect(await screen.findByText("The alpha decision is final.")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "beta decision" } });
      expect(screen.queryByText("The alpha decision is final.")).not.toBeInTheDocument();
      expect(screen.getByText("Looking through every transcript…")).toBeInTheDocument();
    });

    it("suppresses late A-B-A results and failures", async () => {
      const firstA = deferred<any[]>();
      const queryB = deferred<any[]>();
      const secondA = deferred<any[]>();
      backend.searchTranscripts
        .mockReturnValueOnce(firstA.promise)
        .mockReturnValueOnce(queryB.promise)
        .mockReturnValueOnce(secondA.promise);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<RecordingsView />);
      const search = screen.getByLabelText("Search meetings");

      fireEvent.change(search, { target: { value: "alpha decision" } });
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(1));
      fireEvent.change(search, { target: { value: "beta decision" } });
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(2));
      fireEvent.change(search, { target: { value: "alpha decision" } });
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(3));

      await act(async () => {
        firstA.resolve([hit("Stale alpha result", "stale-alpha")]);
        queryB.reject(new Error("stale beta failure"));
        await Promise.allSettled([firstA.promise, queryB.promise]);
      });
      expect(screen.queryByText("Stale alpha result")).not.toBeInTheDocument();
      expect(screen.queryByText("stale beta failure")).not.toBeInTheDocument();

      await act(async () => {
        secondA.resolve([hit("Current alpha result", "current-alpha")]);
        await secondA.promise;
      });
      expect(await screen.findByText("Current alpha result")).toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("clears transcript hits and errors for a short query", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts.mockRejectedValueOnce(new Error("Search index unavailable"));
      render(<RecordingsView />);
      const search = screen.getByLabelText("Search meetings");

      fireEvent.change(search, { target: { value: "broken query" } });
      expect(await screen.findByText("Search index unavailable")).toBeInTheDocument();
      fireEvent.change(search, { target: { value: "x" } });

      expect(screen.queryByText("Search index unavailable")).not.toBeInTheDocument();
      expect(screen.queryByText("Lines from transcripts")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry transcript search" })).not.toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("shows recovery advice rather than a search parser stack trace", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts.mockRejectedValueOnce(new Error(
        "Error invoking remote method 'sidecar:invoke': Error: SQLite syntax error\n    at search (/Users/test/db.ts:12:3)",
      ));
      render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), { target: { value: 'NEAR( ["🙂]' } });
      expect(await screen.findByText("Transcript search is unavailable. Titles, notes, summaries, and action items are still searched.")).toBeInTheDocument();
      expect(screen.queryByText(/SQLite|\/Users\/test|at search/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry transcript search" })).toBeEnabled();
      consoleError.mockRestore();
    });

    it("retries the current failed query once while the retry is pending", async () => {
      const retry = deferred<any[]>();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts
        .mockRejectedValueOnce(new Error("Search index unavailable"))
        .mockReturnValueOnce(retry.promise);
      render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), {
        target: { value: "launch review" },
      });

      const retryButton = await screen.findByRole("button", {
        name: "Retry transcript search",
      });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(backend.searchTranscripts).toHaveBeenCalledTimes(2);
      expect(retryButton).not.toBeInTheDocument();
      expect(screen.getByText("Looking through every transcript…")).toBeInTheDocument();

      await act(async () => {
        retry.resolve([hit("The launch review is Monday.", "retry-hit")]);
        await retry.promise;
      });
      expect(await screen.findByText("The launch review is Monday.")).toBeInTheDocument();
      expect(screen.queryByText("Search index unavailable")).not.toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("distinguishes pending, failed, and settled empty transcript searches", async () => {
      const firstSearch = deferred<any[]>();
      const retry = deferred<any[]>();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts
        .mockReturnValueOnce(firstSearch.promise)
        .mockReturnValueOnce(retry.promise);
      render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), {
        target: { value: "phrase absent everywhere" },
      });

      expect(screen.getByText("Searching transcripts…")).toBeInTheDocument();
      expect(
        screen.getByText(
          "No titles, notes, summaries, or action items match yet. Plainsong is still searching transcripts."
        )
      ).toBeInTheDocument();
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(1));

      await act(async () => {
        firstSearch.reject(new Error("Search index unavailable"));
        await firstSearch.promise.catch(() => undefined);
      });
      expect(screen.getByText("Search unavailable")).toBeInTheDocument();
      expect(screen.getByText("Search incomplete")).toBeInTheDocument();
      expect(
        screen.getByText(
          "No titles, notes, summaries, or action items match. Transcript search failed, so these results are incomplete. Retry above."
        )
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry transcript search" }));
      expect(screen.getByText("Searching transcripts…")).toBeInTheDocument();
      await act(async () => {
        retry.resolve([]);
        await retry.promise;
      });
      expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
      expect(screen.getByText("0 found")).toBeInTheDocument();
      expect(screen.getByText("Try a different search, or a different status.")).toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("clears old hits on status change and shows only the latest status failure", async () => {
      const readySearch = deferred<any[]>();
      const failedSearch = deferred<any[]>();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts
        .mockResolvedValueOnce([hit("Old all-status hit", "all-hit")])
        .mockReturnValueOnce(readySearch.promise)
        .mockReturnValueOnce(failedSearch.promise);
      render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), {
        target: { value: "launch review" },
      });
      expect(await screen.findByText("Old all-status hit")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Ready" }));
      expect(screen.queryByText("Old all-status hit")).not.toBeInTheDocument();
      expect(screen.getByText("Looking through every transcript…")).toBeInTheDocument();
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(2));
      expect(backend.searchTranscripts).toHaveBeenLastCalledWith(
        "launch review",
        25,
        undefined,
        "meeting",
        "completed",
      );

      fireEvent.click(screen.getByRole("button", { name: "Failed" }));
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(3));
      await act(async () => {
        readySearch.resolve([hit("Stale ready hit", "stale-ready")]);
        failedSearch.reject(new Error("Failed-status search unavailable"));
        await Promise.allSettled([readySearch.promise, failedSearch.promise]);
      });

      expect(screen.queryByText("Stale ready hit")).not.toBeInTheDocument();
      expect(screen.getByText("Failed-status search unavailable")).toBeInTheDocument();
      expect(backend.searchTranscripts).toHaveBeenLastCalledWith(
        "launch review",
        25,
        undefined,
        "meeting",
        "error",
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry transcript search" }));
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(4));
      expect(backend.searchTranscripts).toHaveBeenLastCalledWith(
        "launch review",
        25,
        undefined,
        "meeting",
        "error",
      );
      consoleError.mockRestore();
    });

    it("suppresses stale status A-B-A results", async () => {
      const firstAll = deferred<any[]>();
      const ready = deferred<any[]>();
      const currentAll = deferred<any[]>();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      backend.searchTranscripts
        .mockReturnValueOnce(firstAll.promise)
        .mockReturnValueOnce(ready.promise)
        .mockReturnValueOnce(currentAll.promise);
      render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), {
        target: { value: "launch review" },
      });
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Ready" }));
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(3));

      await act(async () => {
        firstAll.resolve([hit("Stale first all hit", "stale-all")]);
        ready.reject(new Error("stale ready failure"));
        await Promise.allSettled([firstAll.promise, ready.promise]);
      });
      expect(screen.queryByText("Stale first all hit")).not.toBeInTheDocument();
      expect(screen.queryByText("stale ready failure")).not.toBeInTheDocument();

      await act(async () => {
        currentAll.resolve([hit("Current all hit", "current-all")]);
        await currentAll.promise;
      });
      expect(await screen.findByText("Current all hit")).toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("requeries the same text when meeting status membership changes", async () => {
      const beforeRefresh = deferred<any[]>();
      const afterRefresh = deferred<any[]>();
      backend.searchTranscripts
        .mockReturnValueOnce(beforeRefresh.promise)
        .mockReturnValueOnce(afterRefresh.promise);
      const view = render(<RecordingsView />);
      fireEvent.change(screen.getByLabelText("Search meetings"), {
        target: { value: "launch review" },
      });
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(1));

      recordings = recordings.map((recording) => ({
        ...recording,
        status: "error" as const,
        updatedAt: "2026-03-06T12:05:00Z",
      }));
      view.rerender(<RecordingsView />);
      await waitFor(() => expect(backend.searchTranscripts).toHaveBeenCalledTimes(2));
      await act(async () => {
        beforeRefresh.resolve([hit("Stale membership hit", "stale-membership")]);
        afterRefresh.resolve([]);
        await Promise.all([beforeRefresh.promise, afterRefresh.promise]);
      });

      expect(screen.queryByText("Stale membership hit")).not.toBeInTheDocument();
      expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    });
  });

  it("makes the hit nearest the deep-linked moment current, not the first in the meeting", async () => {
    const segments = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      startTime: index * 10,
      endTime: index * 10 + 5,
      text: `Filler line ${index}: push the launch review out.`,
      confidence: 0.9,
    }));
    backend.getTranscript.mockResolvedValue({
      id: "t1",
      recordingId: "r1",
      segments,
      fullText: segments.map((segment) => segment.text).join(" "),
      language: "en",
      confidence: 0.9,
      model: "distil-whisper",
    });
    backend.searchTranscripts.mockResolvedValue([
      {
        recordingId: "r1",
        recordingTitle: "Weekly sync",
        projectId: "default",
        segmentId: "s4",
        text: "Filler line 4: push the launch review out.",
        startTime: 40,
        endTime: 45,
        score: -3.2,
      },
    ]);

    render(<RecordingsView />);

    fireEvent.change(screen.getByLabelText("Search meetings"), {
      target: { value: "launch review" },
    });

    fireEvent.click(await screen.findByText("Filler line 4: push the launch review out."));

    await waitFor(() => {
      expect(transcriptViewerProps.current?.segments).toHaveLength(6);
    });

    // Every turn carries the phrase. The hit the user asked for is the one at
    // 0:40 they clicked, not the first occurrence in the file.
    await waitFor(() => {
      expect(transcriptViewerProps.current?.activeMatchIndex).toBe(4);
    });
    expect(screen.getByText("5 of 6")).toBeInTheDocument();
  });

  it("keeps every transcript segment rendered while searching in the meeting", async () => {
    backend.getTranscript.mockResolvedValue({
      id: "t1",
      recordingId: "r1",
      segments: [
        { id: "s1", startTime: 0, endTime: 5, text: "We opened with the roadmap.", confidence: 0.9 },
        { id: "s2", startTime: 5, endTime: 9, text: "Legal signed off.", confidence: 0.9 },
      ],
      fullText: "We opened with the roadmap. Legal signed off.",
      language: "en",
      confidence: 0.9,
      model: "distil-whisper",
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Find in transcript");

    fireEvent.change(screen.getByLabelText("Find in transcript"), {
      target: { value: "nothing in this meeting" },
    });

    // Filtering used to drop every segment, which made the viewer render its
    // "No transcript available" empty state and read as data loss.
    await waitFor(() => {
      expect(transcriptViewerProps.current?.highlightQuery).toBe("nothing in this meeting");
    });
    expect(transcriptViewerProps.current?.segments).toHaveLength(2);
    expect(screen.getByText("2 segments rendered")).toBeInTheDocument();
  });

  it("tells a finished meeting with no words apart from one still processing", async () => {
    backend.getTranscript.mockResolvedValue({
      id: "t1",
      recordingId: "r1",
      segments: [],
      fullText: "",
      language: "en",
      confidence: 0,
      model: "distil-whisper",
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    await waitFor(() => expect(transcriptViewerProps.current?.emptyState?.title).toBe("No speech was heard"));
    expect(transcriptViewerProps.current.emptyState.message).toContain("Re-transcribe from audio");
  });

  it.each([null, 0, 0.72, 0.88, 0.92])("does not promote recognizer score %s to transcript quality", async (qualityScore) => {
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1, model: "Fixture model", modelId: "fixture-model",
      actualProvider: "transcribe_cpp", qualityScore, transcriptionLatencyMs: 880,
      sourceMode: "single_source", hasSourceAwareSpeakers: false, hasSpeakerLabels: false,
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    await waitFor(() => expect(backend.getMeetingTranscriptDetails).toHaveBeenCalled());
    const disclosure = screen.getByText("Transcription details");
    fireEvent.click(disclosure);
    const details = disclosure.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveTextContent(/\d{1,3}%/);
    expect(details).not.toHaveTextContent(/Strong|Low confidence|Not scored yet|Needs review/);
    expect(screen.getByText("transcribe_cpp · fixture-model")).toBeInTheDocument();
    expect(screen.getByText("Took 0.9s")).toBeInTheDocument();
  });

  it("derives transcript provenance from the provider that actually ran", async () => {
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1,
      model: "Whisper Large v3",
      modelId: "whisper-large-v3",
      requestedProvider: "distil_whisper",
      actualProvider: "groq",
      qualityScore: 0.92,
      transcriptionLatencyMs: 880,
      sourceMode: "me_them",
      hasSourceAwareSpeakers: true,
      hasSpeakerLabels: true,
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    await waitFor(() => {
      expect(transcriptViewerProps.current?.provenance).toEqual({
        source: "cloud",
        provider: "Groq",
      });
    });
  });

  it("labels Apple Speech recordings as explicitly on-device", async () => {
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1,
      model: "Apple Speech",
      modelId: "macos_apple_speech",
      requestedProvider: "macos_apple_speech",
      actualProvider: "macos_apple_speech",
      qualityScore: 0.92,
      transcriptionLatencyMs: 480,
      sourceMode: "single_source",
      hasSourceAwareSpeakers: false,
      hasSpeakerLabels: false,
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    await waitFor(() => {
      expect(transcriptViewerProps.current?.provenance).toEqual({
        source: "apple_on_device",
      });
    });
  });

  it("passes the backend's locked-vault message through with a route to unlock", async () => {
    recordings = [{ ...recordings[0] }] as Recording[];
    backend.openRecordingAudio.mockRejectedValue(
      new Error("Vault is locked. Unlock vault before opening encrypted recordings.")
    );
    const mainViewRequests: string[] = [];
    const listener = (event: Event) => {
      mainViewRequests.push((event as CustomEvent<{ view: string }>).detail.view);
    };
    window.addEventListener("nautilus-open-main-view", listener);

    try {
      render(<RecordingsView />);

      fireEvent.click(screen.getByRole("button", { name: "Play this meeting's audio" }));

      expect(
        await screen.findByText(
          "Vault is locked. Unlock vault before opening encrypted recordings."
        )
      ).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith(
        "Vault is locked. Unlock vault before opening encrypted recordings.",
        "error"
      );

      fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
      expect(mainViewRequests).toContain("settings");
    } finally {
      window.removeEventListener("nautilus-open-main-view", listener);
    }
  });

  it("routes a locked vault to Settings from inside the meeting workspace too", async () => {
    recordings = [{ ...recordings[0] }] as Recording[];
    backend.openRecordingAudio.mockRejectedValue(
      new Error("Vault is locked. Unlock vault before opening encrypted recordings.")
    );
    const mainViewRequests: string[] = [];
    const listener = (event: Event) => {
      mainViewRequests.push((event as CustomEvent<{ view: string }>).detail.view);
    };
    window.addEventListener("nautilus-open-main-view", listener);

    try {
      render(<RecordingsView />);

      fireEvent.click(screen.getByText("Weekly sync"));
      await screen.findByRole("heading", { name: "Transcript", exact: true });

      // The banner used to live only in the list branch, so the workspace's own
      // Play audio failed with nothing on screen but a toast.
      fireEvent.click(screen.getByRole("button", { name: "Open audio file" }));

      expect(
        await screen.findByText(
          "Vault is locked. Unlock vault before opening encrypted recordings."
        )
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
      expect(mainViewRequests).toContain("settings");
    } finally {
      window.removeEventListener("nautilus-open-main-view", listener);
    }
  });

  it("clears an audio failure when leaving the workspace", async () => {
    recordings = [{ ...recordings[0] }] as Recording[];
    backend.openRecordingAudio.mockRejectedValue(new Error("Audio file is missing."));

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Open audio file" }));
    expect(await screen.findByText("Audio file is missing.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));

    // Otherwise the banner reappears on the list, detached from the click that
    // caused it.
    await screen.findByLabelText("Search meetings");
    expect(screen.queryByText("Audio file is missing.")).not.toBeInTheDocument();
  });

  it("reports a failed meeting honestly instead of capture in progress", async () => {
    recordings = [{ ...recordings[0], status: "error" as const }] as Recording[];
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: undefined,
      actionItems: [],
      meetingNotes: null,
    });
    backend.getTranscript.mockResolvedValue(null);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByText("Transcription failed")).toBeInTheDocument();
    // The readiness state that used to read "Capture in progress" is now
    // labelled "Recording"; this guard has to name the live string or it stops
    // guarding anything.
    expect(screen.queryByText("Recording")).not.toBeInTheDocument();
  });

  it("labels cross-meeting recall buttons instead of slicing the prompt apart", async () => {
    backend.getRelationshipMemory.mockResolvedValue({
      people: [
        {
          id: "p1",
          name: "Dana",
          recordingCount: 3,
          lastSeenAt: "2026-03-05T12:00:00Z",
          relatedCompanies: [],
          recentMeetings: [],
        },
      ],
      companies: [],
    });
    recordings = [
      { ...recordings[0], summary: "Dana wants the renewal packet." },
    ] as Recording[];
    backend.getRecording.mockResolvedValue(recordings[0]);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByRole("button", { name: "Ask about Dana" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open commitments" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cared about across recent meetings/i })
    ).not.toBeInTheDocument();
  });

  it("uses the honest consent label on the live capture card", async () => {
    recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
    };
    recordings = [
      { ...recordings[0], status: "recording", consentPromptShown: true },
    ] as Recording[];
    backend.getRecording.mockResolvedValue(recordings[0]);

    render(<RecordingsView />);

    // The app knows the prompt was shown; it does not know anyone was told.
    expect(await screen.findByText("Prompt shown")).toBeInTheDocument();
    expect(screen.queryByText("Consent confirmed")).not.toBeInTheDocument();
  });

  describe("the delayed preview panel", () => {
    const streamSegment = (overrides = {}) => ({
      recordingId: "r1",
      isPartial: true,
      isFinal: false,
      text: "",
      segmentText: "",
      startTime: 0,
      endTime: 5,
      confidence: 0.9,
      kind: "speech",
      delayedPreview: true,
      lagSeconds: 5,
      ...overrides,
    });

    const startLiveMeeting = async () => {
      recordingState = {
        isRecording: true,
        recordingId: "r1",
        formattedDuration: "02:04",
      };
      recordings = [{ ...recordings[0], status: "recording" }] as Recording[];
      backend.getRecording.mockResolvedValue(recordings[0]);
      render(<RecordingsView />);
      const handler = eventListeners.get("recording-transcription-stream");
      expect(handler).toBeTruthy();
      return handler;
    };

    it("keeps every segment as its own timestamped line", async () => {
      const handler = await startLiveMeeting();

      // Each event carries the running transcript in `text` and only the new
      // words in `segmentText`. Rendering `text` per line would stamp the whole
      // meeting with the newest segment's start time.
      await act(async () => {
        handler?.({
          payload: streamSegment({
            segmentText: "we should ship the parity push",
            text: "we should ship the parity push",
            startTime: 0,
          }),
        });
        handler?.({
          payload: streamSegment({
            segmentText: "before Friday",
            text: "we should ship the parity push before Friday",
            startTime: 10,
          }),
        });
        handler?.({
          payload: streamSegment({
            segmentText: "and tell the team",
            text: "we should ship the parity push before Friday and tell the team",
            startTime: 20,
          }),
        });
      });

      await waitFor(() => {
        expect(
          screen.getAllByText("we should ship the parity push").length
        ).toBeGreaterThan(0);
      });
      expect(screen.getAllByText("before Friday").length).toBeGreaterThan(0);
      expect(screen.getAllByText("and tell the team").length).toBeGreaterThan(0);
      expect(screen.getAllByText("0:20").length).toBeGreaterThan(0);
    });

    it("calls the panel a delayed preview and says how far behind it runs", async () => {
      const handler = await startLiveMeeting();

      await act(async () => {
        handler?.({
          payload: streamSegment({
            segmentText: "opening remarks",
            text: "opening remarks",
            lagSeconds: 8,
          }),
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("Delayed preview").length).toBeGreaterThan(0);
      });
      expect(
        screen.getAllByText(/8s behind the speaker/).length
      ).toBeGreaterThan(0);
      expect(screen.queryByText("Live transcript")).not.toBeInTheDocument();
    });

    it("renders a lost span as missing audio rather than as transcript", async () => {
      const handler = await startLiveMeeting();

      await act(async () => {
        handler?.({
          payload: streamSegment({
            kind: "gap",
            segmentText: "[12s not transcribed: the live preview fell behind]",
            text: "[12s not transcribed: the live preview fell behind]",
            startTime: 60,
            endTime: 72,
          }),
        });
      });

      await waitFor(() => {
        expect(
          screen.getAllByText("12s of audio was overwritten before it could be read")
            .length
        ).toBeGreaterThan(0);
      });
      expect(
        screen.queryByText("[12s not transcribed: the live preview fell behind]")
      ).not.toBeInTheDocument();
    });

    it("warns during the meeting when a capture source goes silent", async () => {
      await startLiveMeeting();

      const handler = eventListeners.get("meeting-audio-source-warning");
      expect(handler).toBeTruthy();

      await act(async () => {
        handler?.({
          payload: {
            recordingId: "r1",
            source: "system",
            reason: "silence",
            silentSeconds: 45,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("System audio has gone silent")).toBeInTheDocument();
      });
      expect(screen.getByText(/for 45s/)).toBeInTheDocument();
    });
  });

  it("shows citation-backed provenance for a generated recap and jumps to the source", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track pending legal sign-off.",
      citations: [
        {
          text: "We are on track for launch, pending legal approval.",
          startTime: 15,
          endTime: 21,
          recordingId: "r1",
          certainty: 0.97,
        },
      ],
      grounded: true,
      provenance: {
        version: 1, groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:generated", actualProvider: "ollama", actualModel: "test-model",
        promptSource: "meeting_playbook:auto", completedAt: "2026-07-25T12:00:00.000Z",
        grounded: true, citations: [{ text: "We are on track for launch, pending legal approval.", startTime: 15, endTime: 21, recordingId: "r1", certainty: 0.97 }],
      },
      model: "test-model",
      processingTimeMs: 1200,
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    // Before any generation, the recap makes no evidence claim at all.
    expect(
      screen.getByText(/Nothing quoted yet\. Regenerate the summary or the action items/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));

    const citationRow = await screen.findByText(
      "We are on track for launch, pending legal approval."
    );
    fireEvent.click(citationRow);

    await waitFor(() => {
      expect(transcriptViewerProps.current?.currentTime).toBe(15);
    });
  });

  it("shows a verified written-note citation without jumping the audio", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      meetingNotes: "Launch risks\n  Legal approval is still pending.  ",
      summary: "Legal approval is still pending.",
      actionItems: [],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:note-summary",
        actualProvider: "ollama",
        actualModel: "llama3.2",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [
          {
            text: "Legal approval is still pending.",
            sourceKind: "meeting_note",
            segmentId: "meeting-note:1",
            startTime: null,
            endTime: null,
            recordingId: "r1",
            certainty: 1,
          },
        ],
        grounded: true,
      },
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    const sourceLabel = await screen.findByText("Written note");
    expect(screen.queryByText("No timestamp")).not.toBeInTheDocument();
    const citationButton = sourceLabel.closest("button");
    expect(citationButton).not.toBeNull();
    expect(citationButton).toBeEnabled();
    expect(citationButton).toHaveAttribute("title", "Open written notes");
    expect(within(citationButton as HTMLElement).getByText("Legal approval is still pending."))
      .toBeInTheDocument();
    const scroll = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const notes = screen.getByRole("group", { name: "Meeting notes" });
      const editor = Array.from(notes.querySelectorAll("textarea")).find((field) => field.value.includes("Legal approval is still pending."));
      const before = editor?.value;
      fireEvent.click(citationButton as HTMLElement);
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
      expect(editor).toHaveFocus();
      expect(editor).toHaveValue(before);
      expect(editor?.value.slice(editor.selectionStart, editor.selectionEnd)).toBe("Legal approval is still pending.");
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
    expect(transcriptViewerProps.current?.currentTime).toBeUndefined();
    const editor = Array.from(screen.getByRole("group", { name: "Meeting notes" }).querySelectorAll("textarea")).find((field) => field.value.includes("Legal approval is still pending."));
    expect(editor).not.toBeNull();
    fireEvent.change(editor as HTMLTextAreaElement, { target: { value: "Legal approval was granted." } });
    const stale = await screen.findByText("Written note · Unverified");
    expect(stale.closest("button")).toBeNull();
  });

  it.each([
    {
      name: "the saved note text changed",
      meetingNotes: "Launch risks\nLegal approval was granted.",
      recordingId: "r1",
      startTime: null,
    },
    {
      name: "the citation names another recording",
      meetingNotes: "Launch risks\nLegal approval is still pending.",
      recordingId: "r2",
      startTime: null,
    },
    {
      name: "the citation carries an audio timestamp",
      meetingNotes: "Launch risks\nLegal approval is still pending.",
      recordingId: "r1",
      startTime: 99,
    },
  ])("marks a written-note citation unverified when $name", async ({ meetingNotes, recordingId, startTime }) => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      meetingNotes,
      summary: "Legal approval is still pending.",
      actionItems: [],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:note-summary",
        actualProvider: "ollama",
        actualModel: "llama3.2",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [
          {
            text: "Legal approval is still pending.",
            sourceKind: "meeting_note",
            segmentId: "meeting-note:1",
            startTime,
            endTime: null,
            recordingId,
            certainty: 1,
          },
        ],
        grounded: true,
      },
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    const sourceLabel = await screen.findByText("Written note · Unverified");
    const citationBox = sourceLabel.closest("div.rounded-md");
    expect(citationBox).not.toBeNull();
    expect(citationBox).toHaveAttribute("aria-disabled", "true");
    expect(within(citationBox as HTMLElement).getByText("Legal approval is still pending."))
      .toBeInTheDocument();
    expect(citationBox?.closest("button")).toBeNull();
    fireEvent.click(citationBox as HTMLElement);
    expect(transcriptViewerProps.current?.currentTime).toBeUndefined();
  });

  it("does not navigate a citation with an unknown source kind", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Legal approval is still pending.",
      actionItems: [],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:unknown-summary",
        actualProvider: "ollama",
        actualModel: "llama3.2",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [{
          text: "Legal approval is still pending.",
          sourceKind: "calendar_attendee",
          startTime: 99,
          endTime: 100,
          recordingId: "r1",
          certainty: 1,
        }],
        grounded: true,
      },
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    const sourceLabel = await screen.findByText("Unverified citation");
    const citationBox = sourceLabel.closest("div.rounded-md");
    expect(citationBox).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(citationBox as HTMLElement);
    expect(transcriptViewerProps.current?.currentTime).toBeUndefined();
  });

  it("keeps citations without a source kind as transcript audio links", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Launch is on track pending legal sign-off.",
      actionItems: [],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:legacy-summary",
        actualProvider: "ollama",
        actualModel: "llama3.2",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [
          {
            text: "We are on track for launch, pending legal approval.",
            startTime: 15,
            endTime: 21,
            recordingId: "r1",
            certainty: 0.97,
          },
        ],
        grounded: true,
      },
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));

    const citation = await screen.findByRole("button", {
      name: /We are on track for launch, pending legal approval/,
    });
    expect(citation).toHaveTextContent("0:15-0:21");
    fireEvent.click(citation);
    await waitFor(() => expect(transcriptViewerProps.current?.currentTime).toBe(15));
  });

  it("marks machine-set recap text apart from the user's own, and hands it back on edit", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track pending legal sign-off.",
      citations: [
        {
          text: "We are on track for launch, pending legal approval.",
          startTime: 15,
          endTime: 21,
          recordingId: "r1",
          certainty: 0.97,
        },
      ],
      model: "test-model",
      processingTimeMs: 1200,
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    await waitFor(() => {
      expect(screen.getByLabelText("Summary")).toHaveTextContent("Test summary");
    });

    // The stored recap could have been written by anyone — a model in an
    // earlier session, or the reader. Nothing recorded which, so neither claim
    // is made and the reader is not handed the model's words as their own.
    expect(screen.getByLabelText("Summary")).toHaveClass("text-foreground/70");
    expect(
      screen.getAllByText(/Nothing stored says whether you or Plainsong wrote this/i).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/^Your text\./i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Lines quoted from the transcript and your notes, picked by Plainsong\./i)
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Summary")).toHaveClass("text-muted-foreground");

    // One keystroke and the words are the user's again — including the evidence
    // claim, which no longer describes what is on screen.
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Launch is on track pending legal sign-off, and pricing is settled." },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Summary")).toHaveClass("text-foreground");
    });
    expect(
      // "Regenerate", because that is what the button under this caption says.
      screen.getByText(/Your text\. Regenerate to replace it with lines quoted from the transcript\./i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText("We are on track for launch, pending legal approval.")
    ).not.toBeInTheDocument();
  });

  it.each([
    ["newer", "2026-07-25T12:01:00.000Z", "2026-07-25T12:00:00.000Z", true, true],
    ["equal", "2026-07-25T12:00:00.000Z", "2026-07-25T12:00:00.000Z", true, false],
    ["older", "2026-07-25T11:59:00.000Z", "2026-07-25T12:00:00.000Z", true, false],
    ["missing notes timestamp", null, "2026-07-25T12:00:00.000Z", true, false],
    ["invalid notes timestamp", "invalid", "2026-07-25T12:00:00.000Z", true, false],
    ["missing summary timestamp", "2026-07-25T12:01:00.000Z", "", true, false],
    ["invalid summary timestamp", "2026-07-25T12:01:00.000Z", "invalid", true, false],
    ["manual summary", "2026-07-25T12:01:00.000Z", "2026-07-25T12:00:00.000Z", false, false],
  ])("explains recap freshness with %s", async (_case, notesUpdatedAt, completedAt, generated, showNotice) => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Saved recap stays visible",
      notesUpdatedAt,
      summaryProvenance: generated ? {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "local-test",
        promptSource: "test",
        completedAt,
        citations: [{ text: "A saved quote", recordingId: "r1", startTime: 0, endTime: 5 }],
        grounded: false,
      } : null,
    });
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveTextContent("Saved recap stays visible"));
    const notice = screen.queryByText("Your written notes changed after this summary was generated. Review the summary against your updated notes or regenerate it.");
    if (showNotice) {
      expect(notice).toBeInTheDocument();
      expect(screen.queryByText("This summary needs review. Check its quoted sources before sharing.")).not.toBeInTheDocument();
    } else {
      expect(notice).not.toBeInTheDocument();
      if (generated) expect(screen.getByText("This summary needs review. Check its quoted sources before sharing.")).toBeInTheDocument();
    }
  });

  it("reloads persisted machine provenance, citations, provider, and model", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track pending legal sign-off.",
      citations: [
        {
          text: "We are on track for launch, pending legal approval.",
          startTime: 15,
          endTime: 21,
          recordingId: "r1",
          certainty: 0.97,
        },
      ],
      model: "test-model",
      processingTimeMs: 1200,
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Lines quoted from the transcript and your notes, picked by Plainsong\./i)
      ).toBeInTheDocument();
    });

    // Leave the meeting and open it again, the way a restart would. The recap
    // is now persisted machine text with no recorded author.
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Launch is on track pending legal sign-off.",
      actionItems: ["Ship launch checklist"],
      summaryProvenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "llama3.2",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [
          {
            text: "We are on track for launch, pending legal approval.",
            startTime: 15,
            endTime: 21,
            recordingId: "r1",
            certainty: 0.97,
          },
        ],
        grounded: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");
    await waitFor(() => {
      expect(screen.getByLabelText("Summary")).toHaveTextContent(
        "Launch is on track pending legal sign-off."
      );
    });

    expect(screen.queryByText(/^Your text\./i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Lines quoted from the transcript and your notes, picked by Plainsong\./i)
    ).toBeInTheDocument();
    expect(
      screen.getByText("We are on track for launch, pending legal approval.")
    ).toBeInTheDocument();
    // Provider, model, and when the analysis finished. The timestamp is
    // labelled: this page shows the meeting's own createdAt a few inches above
    // and again in the header strip, so a bare date here is unreadable.
    expect(
      screen.getByText(
        `ollama · llama3.2 · finished ${formatDateTime("2026-07-25T12:00:00.000Z")}`
      )
    ).toBeInTheDocument();
  });

  it("says plainly when a generated line has no transcript citation", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track pending legal sign-off.",
      citations: [],
      model: "test-model",
      processingTimeMs: 1200,
      // Successful summary responses include provenance even without citations.
      provenance: {
        version: 1,
        groundingPolicyVersion: SUMMARY_GROUNDING_POLICY_VERSION,
        contentHash: "v1:sha256:uncited-fixture",
        actualProvider: "test-provider",
        actualModel: "test-model",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: false,
      },
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));

    expect(
      await screen.findByText(
        /No transcript line was quoted for this summary — read it against the transcript before you send it\./i
      )
    ).toBeInTheDocument();
  });

  it("opens the meeting as a page with a way back, not a modal", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    // The workspace used to be a fixed 85vh dialog stacked over the list.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.queryByLabelText("Search meetings")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));

    expect(await screen.findByLabelText("Search meetings")).toBeInTheDocument();
    expect(screen.queryByText("The record")).not.toBeInTheDocument();
  });

  it("renames the meeting from the title in its own header", async () => {
    backend.renameRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Pricing sync" } });
    fireEvent.blur(title);

    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Pricing sync");
    });

    // An empty title would make the meeting unfindable, so it is never committed.
    fireEvent.change(screen.getByLabelText("Meeting title"), { target: { value: "   " } });
    fireEvent.blur(screen.getByLabelText("Meeting title"));
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed row rename in the dialog and closes after a successful retry", async () => {
    backend.renameRecording
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValueOnce(undefined);
    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename meeting" });
    const input = within(dialog).getByRole("textbox", { name: "New meeting title" });
    fireEvent.change(input, { target: { value: "New planning title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(
      await within(dialog).findByRole("alert"),
    ).toHaveTextContent("Could not save the title. Your edit is still here. Try again.");
    expect(input).toHaveValue("New planning title");
    expect(refetchRecordings).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Rename meeting" })).not.toBeInTheDocument();
    });
    expect(backend.renameRecording).toHaveBeenCalledTimes(2);
    expect(backend.renameRecording).toHaveBeenLastCalledWith("r1", "New planning title");
    expect(refetchRecordings).toHaveBeenCalledTimes(1);
  });

  it("locks a pending row rename and ignores Enter and repeated clicks", async () => {
    const save = deferred<void>();
    backend.renameRecording.mockReturnValueOnce(save.promise);
    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename meeting" });
    const input = within(dialog).getByRole("textbox", { name: "New meeting title" });
    fireEvent.change(input, { target: { value: "New planning title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "New planning title");
    });
    const savingButton = within(dialog).getByRole("button", { name: "Saving…" });
    expect(savingButton).toBeDisabled();
    expect(input).toHaveAttribute("readonly");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.doubleClick(savingButton);
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve());
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Rename meeting" })).not.toBeInTheDocument();
    });
  });

  it("keeps a newer rename dialog open when a canceled pending rename settles", async () => {
    const firstSave = deferred<void>();
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.renameRecording.mockReturnValueOnce(firstSave.promise);
    render(<RecordingsView />);

    const meetingOptions = screen.getAllByRole("button", { name: "Meeting options" });
    fireEvent.pointerDown(meetingOptions[1], { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    let dialog = await screen.findByRole("dialog", { name: "Rename meeting" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "New meeting title" }), {
      target: { value: "Weekly planning" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Weekly planning");
    });

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog", { name: "Rename meeting" })).not.toBeInTheDocument();
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getAllByRole("button", { name: "Meeting options" })[0], {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    dialog = await screen.findByRole("dialog", { name: "Rename meeting" });
    const secondInput = within(dialog).getByRole("textbox", { name: "New meeting title" });
    expect(secondInput).toHaveValue("Launch review");
    expect(secondInput).toHaveAttribute("readonly");
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "The previous title change is still saving. Wait before renaming this meeting.",
    );

    fireEvent.keyDown(secondInput, { key: "Enter" });
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);

    await act(async () => firstSave.resolve());
    await waitFor(() => {
      expect(secondInput).not.toHaveAttribute("readonly");
    });
    expect(screen.getByRole("dialog", { name: "Rename meeting" })).toBeInTheDocument();
    expect(secondInput).toHaveValue("Launch review");
    expect(refetchRecordings).toHaveBeenCalledTimes(1);
  });

  it("queues a meeting header rename behind a dismissed row rename", async () => {
    const rowSave = deferred<void>();
    backend.renameRecording
      .mockReturnValueOnce(rowSave.promise)
      .mockResolvedValueOnce(undefined);
    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename meeting" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "New meeting title" }), {
      target: { value: "Row title" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Row title");
    });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);

    fireEvent.click(screen.getByText("Weekly sync"));
    const meetingTitle = await screen.findByLabelText("Meeting title");
    fireEvent.change(meetingTitle, { target: { value: "Workspace title" } });
    fireEvent.blur(meetingTitle);
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);

    await act(async () => rowSave.resolve());
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledTimes(2);
      expect(backend.renameRecording).toHaveBeenLastCalledWith("r1", "Workspace title");
    });
  });

  it("keeps a failed title draft until Escape restores the stored title", async () => {
    backend.renameRecording.mockRejectedValueOnce(new Error("database is locked"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Pricing sync" } });
    fireEvent.blur(title);

    await screen.findByText("Could not save the title. Your edit is still here. Press Enter to retry.");
    expect(title).toHaveValue("Pricing sync");
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(toast).toHaveBeenCalledWith("Couldn't save that title.", "error");

    title.focus();
    fireEvent.keyDown(title, { key: "Escape" });
    expect(title).toHaveValue("Weekly sync");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(backend.renameRecording).toHaveBeenCalledTimes(1);
  });

  it("serializes title saves so the latest title wins", async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    backend.renameRecording
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Title A" } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: "Title B" } });
    fireEvent.blur(title);

    await waitFor(() => expect(backend.renameRecording).toHaveBeenCalledTimes(1));
    expect(backend.renameRecording).toHaveBeenLastCalledWith("r1", "Title A");

    await act(async () => firstSave.resolve());
    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledTimes(2);
      expect(backend.renameRecording).toHaveBeenLastCalledWith("r1", "Title B");
    });
    await act(async () => secondSave.resolve());

    await waitFor(() => expect(title).toHaveValue("Title B"));
  });

  it("preserves a failed title draft and retries it before allowing navigation", async () => {
    backend.renameRecording.mockRejectedValue(new Error("Save unavailable"));
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");
    await screen.findByLabelText("Summary");
    fireEvent.change(title, { target: { value: "Pricing decision with finance" } });
    fireEvent.blur(title);
    await screen.findByText("Could not save the title. Your edit is still here. Press Enter to retry.");
    expect(title).toHaveValue("Pricing decision with finance");

    let allowed = true;
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(false);
    expect(backend.renameRecording).toHaveBeenCalledTimes(2);
    expect(title).toHaveValue("Pricing decision with finance");

    backend.renameRecording.mockResolvedValue(undefined);
    await act(async () => { allowed = await canLeaveMainView("recordings"); });
    expect(allowed).toBe(true);
    expect(backend.renameRecording).toHaveBeenLastCalledWith("r1", "Pricing decision with finance");
    expect(title).toHaveValue("Pricing decision with finance");
  });

  it("waits for a blurred title save before leaving the meeting", async () => {
    const save = deferred<void>();
    backend.renameRecording.mockReturnValueOnce(save.promise);
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Pricing sync" } });
    fireEvent.blur(title);
    await waitFor(() => expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Pricing sync"));
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));

    expect(screen.getByRole("button", { name: "All meetings" })).toBeInTheDocument();
    await act(async () => save.resolve());
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "All meetings" })).not.toBeInTheDocument();
    });
  });

  it("saves a focused dirty title before an external request switches meetings", async () => {
    const titleSave = deferred<void>();
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordings.find((recording) => recording.id === recordingId) ?? null
    );
    backend.renameRecording.mockReturnValueOnce(titleSave.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");
    title.focus();
    fireEvent.change(title, { target: { value: "Pricing sync" } });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: "r2" },
        }),
      );
    });

    await waitFor(() => {
      expect(backend.renameRecording).toHaveBeenCalledWith("r1", "Pricing sync");
    });
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Pricing sync");

    await act(async () => titleSave.resolve());
    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
    });
  });

  it("keeps the current meeting open when its pending title is rejected", async () => {
    const titleSave = deferred<void>();
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordings.find((recording) => recording.id === recordingId) ?? null
    );
    backend.renameRecording.mockReturnValueOnce(titleSave.promise);

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");
    title.focus();
    fireEvent.change(title, { target: { value: "Pricing sync" } });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: "r2" },
        }),
      );
    });
    await waitFor(() => expect(backend.renameRecording).toHaveBeenCalledTimes(1));
    await act(async () => titleSave.reject(new Error("database is locked")));

    await screen.findByText("Could not save the title. Your edit is still here. Press Enter to retry.");
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Pricing sync");
    expect(screen.getByLabelText("Meeting title")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Launch review")).not.toBeInTheDocument();
  });

  it("keeps the current meeting open when notes fail to save before an external switch", async () => {
    const launchReview = {
      ...recordings[0],
      id: "r2",
      title: "Launch review",
      createdAt: "2026-03-06T13:00:00Z",
      updatedAt: "2026-03-06T13:00:00Z",
    } as Recording;
    recordings = [recordings[0], launchReview];
    backend.getRecording.mockImplementation(async (recordingId: string) =>
      recordings.find((recording) => recording.id === recordingId) ?? null
    );
    backend.updateRecordingNotes.mockRejectedValue(new Error("Notes save failed"));

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep this decision before switching." },
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: "r2" },
        }),
      );
    });

    await waitFor(() => expect(backend.updateRecordingNotes).toHaveBeenCalled());
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.getByLabelText("Goals notes")).toHaveValue(
      "Keep this decision before switching.",
    );
  });

  it("saves a same-meeting draft before applying an external transcript focus", async () => {
    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the note while opening its source." },
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: {
            recordingId: "r1",
            focusSegmentTime: 2,
            highlightQuery: "Transcript",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nKeep the note while opening its source.",
        undefined,
        expect.any(String),
      );
    });
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    expect(screen.getByLabelText("Goals notes")).toHaveValue(
      "Keep the note while opening its source.",
    );
    expect(screen.getByLabelText("Find in transcript")).toHaveValue("Transcript");
  });

  it("opens only the latest of out-of-order external recording requests", async () => {
    recordings = [];
    const olderRequest = deferred<Recording | null>();
    const newerRequest = deferred<Recording | null>();
    const olderMeeting = {
      id: "external-old",
      title: "Older external meeting",
      projectId: "default",
      duration: 60,
      createdAt: "2026-03-06T14:00:00Z",
      updatedAt: "2026-03-06T14:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/external-old.wav",
      meetingCaptureMode: "mic_only",
      status: "completed",
    } as Recording;
    const newerMeeting = {
      ...olderMeeting,
      id: "external-new",
      title: "Newer external meeting",
      audioPath: "/tmp/external-new.wav",
      createdAt: "2026-03-06T15:00:00Z",
      updatedAt: "2026-03-06T15:00:00Z",
    } as Recording;
    backend.getRecording.mockImplementation((recordingId: string) => {
      if (recordingId === olderMeeting.id) return olderRequest.promise;
      if (recordingId === newerMeeting.id) return newerRequest.promise;
      return Promise.resolve(null);
    });

    render(<RecordingsView />);
    await screen.findByRole("heading", { name: "Meetings" });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: olderMeeting.id },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(OPEN_RECORDING_WORKSPACE_EVENT, {
          detail: { recordingId: newerMeeting.id },
        }),
      );
    });

    await act(async () => newerRequest.resolve(newerMeeting));
    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Newer external meeting");
    });

    await act(async () => olderRequest.resolve(olderMeeting));
    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Newer external meeting");
    });
  });

  it("abandons the edited title on Escape instead of committing it", async () => {
    backend.renameRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    const title = await screen.findByLabelText("Meeting title");

    // Focus for real: the handler cancels by blurring, and a blur on an
    // unfocused input never fires the commit this is about.
    title.focus();
    fireEvent.change(title, { target: { value: "Board review" } });
    // Escape is the cancel gesture. It used to perform the rename it was meant
    // to abort, and there is no undo for that.
    fireEvent.keyDown(title, { key: "Escape" });

    expect(backend.renameRecording).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
    });
  });

  it("gives the meeting page its own heading and takes focus to it", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    // Navigating by heading used to land on "The record" with the meeting's
    // own name nowhere in the heading tree, and both navigations dropped focus
    // onto <body>.
    const workspaceHeading = await screen.findByRole("heading", { level: 1 });
    expect(workspaceHeading).toContainElement(screen.getByLabelText("Meeting title"));
    await waitFor(() => {
      expect(workspaceHeading).toHaveFocus();
    });

    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));

    const listHeading = await screen.findByRole("heading", { level: 1, name: "Meetings" });
    await waitFor(() => {
      expect(listHeading).toHaveFocus();
    });
  });

  it("warns before regenerate throws away an action item added by hand", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Summary");

    // Plainsong extracts the list first, so every visible item carries a
    // citation and the field as a whole reads as the model's.
    fireEvent.click(screen.getByRole("button", { name: "Regenerate action items" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and regenerate" }));
    await waitFor(() => {
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledTimes(1);
    });
    // Once in the record, once again in the evidence rows underneath it.
    await screen.findAllByText("Ship launch checklist (Owner: Jon · Due: Friday)");

    // Then the reader adds one follow-up of their own.
    fireEvent.click(screen.getByRole("button", { name: "Edit Action items" }));
    fireEvent.change(screen.getByLabelText("Action items"), {
      target: {
        value:
          "Ship launch checklist (Owner: Jon · Due: Friday)\nCall the lawyer before Friday",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate action items" }));

    expect(
      await screen.findByText(/Regenerating the action items replaces 1 action item/i)
    ).toBeInTheDocument();
    expect(backend.extractActionItemsGrounded).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Action items")).toHaveValue(
      "Ship launch checklist (Owner: Jon · Due: Friday)\nCall the lawyer before Friday"
    );
  });

  it("says the record is empty once per field, not twice", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "",
      actionItems: [],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    // The caption under the label and the body both said this sentence.
    expect(
      screen.getAllByText(/Nothing written yet\. Regenerate to have Plainsong write it/i)
    ).toHaveLength(1);
    expect(
      screen.getAllByText(/Nothing here yet\. Regenerate to have Plainsong pull them/i)
    ).toHaveLength(1);
  });

  it("names controls that exist when a meeting failed or was written by hand", async () => {
    recordings = [{ ...recordings[0], status: "error" as const }] as Recording[];
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "A recap that came back from storage.",
      actionItems: ["Follow up with design"],
      meetingNotes: null,
    });
    backend.getTranscript.mockResolvedValue(null);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Transcription failed");

    // The Transcript tab this copy pointed at no longer exists; retry lives in
    // the header overflow now.
    expect(screen.getByText(/Retry transcription from the meeting menu/i)).toBeInTheDocument();
    expect(screen.queryByText(/from the Transcript tab/i)).not.toBeInTheDocument();

    // The buttons are labelled "Regenerate"; "Refresh" is the transcript rail's
    // button and does something else entirely.
    expect(
      screen.getByText(
        /Nothing stored says whether you or Plainsong wrote this[\s\S]*Regenerate to replace it with lines quoted/i
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Refresh to have Plainsong/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refresh the summary or action items/i)).not.toBeInTheDocument();
  });

  it("carries the row menu's actions in the header overflow", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });

    expect(
      await screen.findByRole("menuitem", { name: "Copy recap as Markdown" })
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Move to Dictation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("offers the dictation move only for rows that look like dictations", async () => {
    const view = render(<RecordingsView />);

    // A full Me + Them meeting is not a dictation; the blanket move waits in
    // the list's overflow menu instead of a banner on every visit.
    expect(screen.queryByText(/like a dictation/i)).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More list actions" }), {
      button: 0,
    });
    expect(
      await screen.findByRole("menuitem", { name: "Move all listed to Dictation" })
    ).toBeInTheDocument();
    view.unmount();

    recordings = [
      ...recordings,
      {
        id: "r-short",
        title: "Note to self",
        projectId: "default",
        duration: 40,
        createdAt: "2026-03-07T12:00:00Z",
        updatedAt: "2026-03-07T12:00:00Z",
        sourceType: "meeting",
        audioPath: "/tmp/note.wav",
        status: "completed",
        meetingCaptureMode: "mic_only",
        metadata: { sampleRate: 48000, channels: 1, systemAudio: false },
      },
    ];
    render(<RecordingsView />);

    expect(
      screen.getByText("One listed recording is short and microphone-only, like a dictation.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move it to Dictation" }));
    await waitFor(() => {
      expect(backend.setRecordingSourceType).toHaveBeenCalledTimes(1);
    });
    expect(backend.setRecordingSourceType).toHaveBeenCalledWith("r-short", "dictation");
  });

  it("sets the recap down as a document and only opens an editor when asked", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "**Launch** is on track.\n\n- Legal signed off\n- Pricing holds",
      actionItems: ["Send the packet", "Confirm the date"],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    const summary = await screen.findByRole("region", { name: "Summary" });
    // Markdown, in the manuscript serif — not raw asterisks in a text box.
    expect(summary.querySelectorAll("li")).toHaveLength(2);
    expect(summary.querySelector(".font-semibold")).not.toBeNull();
    expect(summary.textContent).not.toContain("**");
    expect(summary.querySelector(".manuscript")).not.toBeNull();

    const actionItems = screen.getByRole("region", { name: "Action items" });
    expect(within(actionItems).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(actionItems).getByRole("checkbox", { name: "Mark Send the packet done" })).toBeInTheDocument();
    expect(within(actionItems).getByRole("checkbox", { name: "Mark Confirm the date done" })).toBeInTheDocument();

    // The editor arrives on request, and grows with the text instead of
    // clamping to eight rows.
    fireEvent.click(screen.getByRole("button", { name: "Edit Summary" }));
    const editor = screen.getByLabelText("Summary");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveAttribute("rows", "1");
    expect(editor).toHaveValue("**Launch** is on track.\n\n- Legal signed off\n- Pricing holds");

    fireEvent.click(screen.getByRole("button", { name: "Done editing Summary" }));
    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
  });

  it("shows a loading skeleton instead of claiming the meeting is empty", async () => {
    const pendingRecording = deferred<any>();
    const pendingTranscript = deferred<any>();
    backend.getRecording.mockReturnValue(pendingRecording.promise);
    backend.getTranscript.mockReturnValue(pendingTranscript.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(
      await screen.findByText(/Loading the summary, action items, and notes for this meeting/i)
    ).toBeInTheDocument();
    // None of these were true yet; the panel used to assert them anyway.
    expect(screen.queryByText("The record")).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing written yet/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing quoted yet\. Regenerate the summary or the action items/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Loading this meeting's transcript and notes\./i)
    ).toBeInTheDocument();

    pendingRecording.resolve({ ...recordings[0] });
    pendingTranscript.resolve(null);

    expect(await screen.findByRole("heading", { name: "Transcript", exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText(/Loading the summary, action items, and notes for this meeting/i)
    ).not.toBeInTheDocument();
  });

  describe("speaker identification ownership", () => {
    const configureTwoMeetings = () => {
      const launchReview = {
        ...recordings[0],
        id: "r2",
        title: "Launch review",
        createdAt: "2026-03-06T13:00:00Z",
        updatedAt: "2026-03-06T13:00:00Z",
      } as Recording;
      recordings = [recordings[0], launchReview];
      backend.getRecording.mockImplementation(async (recordingId: string) => ({
        ...(recordingId === "r1" ? recordings[0] : launchReview),
        summary: `${recordingId} summary`,
        actionItems: [],
      }));
      backend.getTranscript.mockImplementation(async (recordingId: string) => ({
        id: `t-${recordingId}`,
        recordingId,
        segments: [{ id: `s-${recordingId}`, startTime: 0, endTime: 5,
          text: `${recordingId} transcript`, confidence: 0.9 }],
        fullText: `${recordingId} transcript`,
        language: "en",
        confidence: 0.9,
        model: "distil-whisper",
      }));
      backend.getMeetingTranscriptDetails.mockResolvedValue({
        segmentCount: 1,
        hasSourceAwareSpeakers: false,
        hasSpeakerLabels: false,
      });
    };

    it("locks before readiness and blocks duplicate requests", async () => {
      const readiness = deferred<boolean>();
      backend.isDiarizationModelAvailable.mockReturnValueOnce(readiness.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      const button = await screen.findByRole("button", { name: "Label the speakers" });

      fireEvent.click(button);
      fireEvent.click(button);

      expect(backend.isDiarizationModelAvailable).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
      await act(async () => readiness.resolve(false));
      expect(await screen.findByRole("button", { name: "Label the speakers" })).toBeEnabled();
    });

    it("does not start inference after navigation during readiness", async () => {
      configureTwoMeetings();
      const readiness = deferred<boolean>();
      backend.isDiarizationModelAvailable.mockReturnValueOnce(readiness.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Label the speakers" }));

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      expect(await screen.findByRole("button", { name: "Speaker labeling busy" })).toBeDisabled();
      expect(screen.getByText("Speaker labeling is still running for another meeting.")).toBeInTheDocument();
      await act(async () => readiness.resolve(true));

      expect(backend.runDiarization).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
      expect(screen.queryByText(/Found \d+ speakers?/)).not.toBeInTheDocument();
    });

    it("keeps meeting B open when meeting A finishes", async () => {
      configureTwoMeetings();
      const run = deferred<any>();
      backend.isDiarizationModelAvailable.mockResolvedValueOnce(true);
      backend.runDiarization.mockReturnValueOnce(run.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Label the speakers" }));
      await waitFor(() => expect(backend.runDiarization).toHaveBeenCalledWith("r1"));

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await waitFor(() => expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review"));
      await act(async () => run.resolve({
        speakers: [{ id: "speaker-1", name: "Speaker 1" }],
        segmentsUpdated: 1,
      }));

      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
      expect(screen.queryByText("Found 1 speaker.")).not.toBeInTheDocument();
    });

    it("does not show meeting A's late error on meeting B", async () => {
      configureTwoMeetings();
      const run = deferred<any>();
      backend.isDiarizationModelAvailable.mockResolvedValueOnce(true);
      backend.runDiarization.mockReturnValueOnce(run.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Label the speakers" }));
      await waitFor(() => expect(backend.runDiarization).toHaveBeenCalledWith("r1"));

      fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
      fireEvent.click(await screen.findByText("Launch review"));
      await act(async () => run.reject(new Error("A speaker model failed")));

      expect(screen.getByLabelText("Meeting title")).toHaveValue("Launch review");
      expect(screen.queryByText("A speaker model failed")).not.toBeInTheDocument();
    });

    it("shows current success and unlocks retry after a current failure", async () => {
      backend.isDiarizationModelAvailable.mockResolvedValue(true);
      backend.runDiarization
        .mockRejectedValueOnce(new Error("Speaker pass failed"))
        .mockResolvedValueOnce({
          speakers: [
            { id: "speaker-1", name: "Speaker 1" },
            { id: "speaker-2", name: "Speaker 2" },
          ],
          segmentsUpdated: 2,
        });
      render(<RecordingsView />);
      fireEvent.click(screen.getByText("Weekly sync"));
      fireEvent.click(await screen.findByRole("button", { name: "Label the speakers" }));

      expect(await screen.findByText("Speaker pass failed")).toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Label the speakers" });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);

      expect(await screen.findByText("Found 2 speakers.")).toBeInTheDocument();
      expect(screen.queryByText("Speaker pass failed")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Label the speakers" })).toBeEnabled();
    });
  });

  it("explains unavailable speaker identification and can run diarization when available", async () => {
    const user = userEvent.setup();
    backend.isDiarizationModelAvailable.mockResolvedValueOnce(false);
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1,
      model: "Distil Whisper",
      modelId: "distil-large-v3",
      requestedProvider: "distil_whisper",
      actualProvider: "distil_whisper",
      qualityScore: 0.92,
      transcriptionLatencyMs: 880,
      sourceMode: "me_them",
      hasSourceAwareSpeakers: false,
      hasSpeakerLabels: false,
    });

    render(<RecordingsView />);

    await user.click(screen.getByText("Weekly sync"));
    await screen.findByText("Speakers not labeled");
    await user.click(await screen.findByRole("button", { name: "Label the speakers" }));

    expect(
      await screen.findByText(
        /No speaker model is downloaded, so who said what can't be labelled yet/i
      )
    ).toBeInTheDocument();

    backend.isDiarizationModelAvailable.mockResolvedValueOnce(true);
    backend.runDiarization.mockResolvedValueOnce({
      speakers: [
        { id: "speaker-1", name: "Speaker 1" },
        { id: "speaker-2", name: "Speaker 2" },
      ],
      segmentsUpdated: 2,
    });

    await user.click(screen.getByRole("button", { name: "Label the speakers" }));

    await waitFor(() => {
      expect(backend.runDiarization).toHaveBeenCalledWith("r1");
    });
    expect(await screen.findByText("Found 2 speakers.")).toBeInTheDocument();
  });

  it("offers the speaker model download on a meeting saved without speakers, then the labelling", async () => {
    const user = userEvent.setup();
    const plan = (installed: boolean) => ({
      selectedModelId: "pyannote_community1",
      selectedLabel: "pyannote community-1",
      selectedDownloadSize: "33 MB",
      selectedInstalled: installed,
      runModelId: installed ? "pyannote_community1" : null,
      fallbackNotice: null,
    });
    let installed = false;
    backend.getDiarizationModelPlan.mockImplementation(async () => plan(installed));
    backend.downloadDiarizationModel.mockImplementation(async () => {
      installed = true;
    });
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1,
      hasSourceAwareSpeakers: false,
      hasSpeakerLabels: false,
    });

    render(<RecordingsView />);
    await user.click(screen.getByText("Weekly sync"));

    expect(
      await screen.findByText(
        "No speaker model is downloaded, so this meeting was saved without speaker labels."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Label the speakers" })).not.toBeInTheDocument();
    expect(backend.downloadDiarizationModel).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Download speaker model (33 MB)" })
    );

    expect(backend.downloadDiarizationModel).toHaveBeenCalledWith("pyannote_community1");
    const labelButton = await screen.findByRole("button", { name: "Label the speakers" });
    expect(labelButton).toBeEnabled();
    // The download button went away with the note; focus moves to the next step.
    await waitFor(() => expect(document.activeElement).toBe(labelButton));
    expect(
      screen.getByText(
        "The speaker model is downloaded. Choose Label the speakers to split this transcript by who was talking."
      )
    ).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("speaker-model-download-note")).not.toBeInTheDocument();
    expect(backend.runDiarization).not.toHaveBeenCalled();
  });

  it("can relabel an already labeled transcript without changing its words", async () => {
    const user = userEvent.setup();
    backend.getTranscript.mockResolvedValue({
      id: "t1", recordingId: "r1", fullText: "Keep original words",
      segments: [{ id: "s1", startTime: 0, endTime: 5, text: "Keep original words", speakerId: "speaker-1", confidence: 0.9 }],
      language: "en", confidence: 0.9, model: "Parakeet",
    });
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1, hasSpeakerLabels: true, hasSourceAwareSpeakers: false,
      diarizer: "plainsong:ecapa_tdnn_speaker",
    });
    backend.isDiarizationModelAvailable.mockResolvedValue(true);
    let finish!: (value: unknown) => void;
    backend.runDiarization.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<RecordingsView />);
    await user.click(screen.getByText("Weekly sync"));
    await user.click(await screen.findByRole("button", { name: "Relabel speakers" }));
    await waitFor(() => expect(backend.runDiarization).toHaveBeenCalledWith("r1"));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    finish({ speakers: [{ id: "speaker-1", name: "Speaker 1" }], segmentsUpdated: 1 });
    expect(await screen.findByText("Found 1 speaker.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Relabel speakers" })).toBeEnabled();
    expect(transcriptViewerProps.current.segments.map((segment: { text: string }) => segment.text).join(" ")).toBe("Keep original words");
  });

  it("keeps source-aware track identities out of the relabel action", async () => {
    const user = userEvent.setup();
    backend.getTranscript.mockResolvedValue({
      id: "t1", recordingId: "r1", fullText: "Keep source identity",
      segments: [{ id: "s1", startTime: 0, endTime: 5, text: "Keep source identity", speakerId: "me", confidence: 0.9 }],
      language: "en", confidence: 0.9, model: "Parakeet",
    });
    backend.getMeetingTranscriptDetails.mockResolvedValue({
      segmentCount: 1, hasSpeakerLabels: true, hasSourceAwareSpeakers: true,
    });
    render(<RecordingsView />);
    await user.click(screen.getByText("Weekly sync"));
    await waitFor(() => expect(transcriptViewerProps.current?.segments[0].speakerId).toBe("me"));
    expect(screen.queryByRole("button", { name: "Relabel speakers" })).not.toBeInTheDocument();
    expect(backend.runDiarization).not.toHaveBeenCalled();
  });

  it("tells the reader in plain words when the transcription engine is lost", async () => {
    // ux-10: this used to be a raw "Sidecar process exited (code=…, signal=…)"
    // line, and only on the Setup view nobody is looking at.
    readinessContext.engineNotice = {
      title: "The local transcription engine stopped",
      message: "Plainsong is restarting it now.",
      recovering: true,
    };

    render(<RecordingsView />);

    expect(
      await screen.findByText("The local transcription engine stopped")
    ).toBeInTheDocument();
    expect(screen.queryByText(/code=/)).not.toBeInTheDocument();

    const banner = screen.getByRole("status", {
      name: "The local transcription engine stopped",
    });
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(readinessContext.dismissEngineNotice).toHaveBeenCalled();
  });

  describe("meeting start failures", () => {
    async function failStartWith(error: unknown) {
      startMeeting.mockRejectedValueOnce(error);
      render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm meeting consent" })
      );
      return screen.findByText("This meeting did not start");
    }

    it("offers one action matched to the typed code", async () => {
      // ux-9: a system-audio failure used to be answered with microphone
      // permission advice, because the old code substring-matched "audio".
      await failStartWith(
        Object.assign(new Error("no eligible route"), {
          code: "system_audio_unavailable",
        })
      );

      expect(
        screen.getByText(
          "Plainsong can't record the meeting audio right now, so the other side of the call would not be recorded."
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/microphone permissions/i)
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Set up meeting audio" }));
      await waitFor(() => {
        expect(backend.openPermissionSettings).toHaveBeenCalledWith(
          "system_audio"
        );
      });
    });

    it("offers the fix inside the still-open consent dialog, once", async () => {
      await failStartWith(
        Object.assign(new Error("microphone unavailable"), {
          code: "mic_permission_denied",
        })
      );
      // No toast on top of the dialog's alert and the banner.
      expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("microphone access"), "error");

      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Meeting consent" })).getByRole("button", {
          name: "In dialog: Open Microphone settings",
        })
      );
      await waitFor(() => {
        expect(backend.openPermissionSettings).toHaveBeenCalledWith("microphone");
      });
      expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument();
    });

    it("says one sentence, without a second period bolted on", async () => {
      await failStartWith(
        Object.assign(new Error("microphone unavailable"), {
          code: "mic_permission_denied",
        })
      );

      const message = screen.getByText(
        "Plainsong does not have microphone access, so there is nothing to record."
      );
      expect(message.textContent).not.toMatch(/\.\s*\./);
      expect(
        screen.getByRole("button", { name: "Open Microphone settings" })
      ).toBeInTheDocument();
    });

    it("passes a message through when it already carries its own next step", async () => {
      const message =
        "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment, then reconnect or choose another microphone if it happens again.";
      await failStartWith(new Error(message));

      expect(screen.getByText(message)).toBeInTheDocument();
    });

    it("removes IPC wrappers and keeps microphone recovery advice with a retry action", async () => {
      const message = "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment.";
      await failStartWith(new Error(`Error invoking remote method 'sidecar:invoke': Error: ${message}`));
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open Microphone settings" })).not.toBeInTheDocument();
    });

    it("keeps consent choices open through a readiness refresh and starts only after it settles", async () => {
      const { rerender } = render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      await screen.findByRole("dialog", { name: "Meeting consent" });
      const ready = readinessContext.productReadiness;
      readinessContext.productReadiness = {
        ...ready,
        fullCapture: { domain: "full_capture", state: "unknown", cause: {
          id: "loading", message: "Plainsong is still checking this setup.",
          action: { id: "retry", label: "Check again", destination: "setup" },
        } },
      };
      rerender(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm meeting consent" }));
      expect(startMeeting).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith("Plainsong is still checking this setup.", "error");
      readinessContext.productReadiness = ready;
      rerender(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(startMeeting).toHaveBeenCalledOnce());
    });

    it("can be dismissed", async () => {
      await failStartWith(
        Object.assign(new Error("busy"), { code: "already_recording" })
      );

      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => {
        expect(
          screen.queryByText("This meeting did not start")
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("meeting start ownership", () => {
    it("blocks a duplicate start while the first request is pending", async () => {
      const pendingStart = deferred<string | null>();
      startMeeting.mockReturnValueOnce(pendingStart.promise);
      render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      const start = await screen.findByRole("button", { name: "Confirm meeting consent" });

      fireEvent.click(start);
      expect(start).toBeDisabled();
      fireEvent.click(start);
      expect(startMeeting).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingStart.resolve("meeting-a");
        await pendingStart.promise;
      });
    });

    it("treats a null start acknowledgement as stale and leaves consent retryable", async () => {
      startMeeting.mockResolvedValueOnce(null).mockResolvedValueOnce("meeting-b");
      render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      const start = await screen.findByRole("button", { name: "Confirm meeting consent" });

      fireEvent.click(start);
      await waitFor(() => expect(startMeeting).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(start).toBeEnabled());
      expect(screen.getByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
      expect(refetchRecordings).not.toHaveBeenCalled();

      fireEvent.click(start);
      await waitFor(() => expect(startMeeting).toHaveBeenCalledTimes(2));
    });

    it("does not let meeting A's late acknowledgement replace meeting B notes", async () => {
      const pendingStart = deferred<string | null>();
      startMeeting.mockReturnValueOnce(pendingStart.promise);
      const view = render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-b";
      recordingMode = "meeting";
      view.rerender(<RecordingsView />);
      const notesB = await screen.findByLabelText("Live meeting notes");
      fireEvent.change(notesB, { target: { value: "Meeting B owns these notes." } });

      await act(async () => {
        pendingStart.resolve("meeting-a");
        await pendingStart.promise;
      });

      expect(notesB).toHaveValue("Meeting B owns these notes.");
      expect(refetchRecordings).not.toHaveBeenCalled();
    });

    it("unlocks after failure so the same consent flow can retry", async () => {
      startMeeting
        .mockRejectedValueOnce(new Error("temporary start failure"))
        .mockResolvedValueOnce("meeting-a");
      render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await screen.findByText("This meeting did not start");

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

      await waitFor(() => expect(startMeeting).toHaveBeenCalledTimes(2));
    });

    it("closes consent when lifecycle ownership reaches the acknowledged meeting first", async () => {
      const pendingStart = deferred<string | null>();
      startMeeting.mockReturnValueOnce(pendingStart.promise);
      const view = render(<RecordingsView />);
      fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      view.rerender(<RecordingsView />);
      await act(async () => {
        pendingStart.resolve("meeting-a");
        await pendingStart.promise;
      });

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument(),
      );
    });

    it("closes consent after metadata finishes for the acknowledged live meeting", async () => {
      const pendingRename = deferred<void>();
      startMeeting.mockResolvedValueOnce("meeting-a");
      backend.renameRecording.mockReturnValueOnce(pendingRename.promise);
      publishCallCaptureRequest({
        callId: 41,
        app: "zoom",
        appLabel: "Zoom",
        videoService: "zoom",
        detectedAtMs: new Date(2026, 8, 2, 14, 5, 0).getTime(),
      });
      const view = render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(backend.renameRecording).toHaveBeenCalled());

      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-a";
      recordingMode = "meeting";
      view.rerender(<RecordingsView />);
      await act(async () => {
        pendingRename.resolve();
        await pendingRename.promise;
      });

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Meeting consent" })).not.toBeInTheDocument(),
      );
    });

    it("keeps consent and meeting B notes when B takes ownership during A metadata", async () => {
      const pendingRename = deferred<void>();
      startMeeting.mockResolvedValueOnce("meeting-a");
      backend.renameRecording.mockReturnValueOnce(pendingRename.promise);
      publishCallCaptureRequest({
        callId: 42,
        app: "zoom",
        appLabel: "Zoom",
        videoService: "zoom",
        detectedAtMs: new Date(2026, 8, 2, 14, 6, 0).getTime(),
      });
      const view = render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(backend.renameRecording).toHaveBeenCalled());

      recordingState.isRecording = true;
      recordingState.recordingId = "meeting-b";
      recordingMode = "meeting";
      view.rerender(<RecordingsView />);
      const notesB = await screen.findByLabelText("Live meeting notes");
      fireEvent.change(notesB, { target: { value: "Meeting B remains current." } });
      await act(async () => {
        pendingRename.resolve();
        await pendingRename.promise;
      });

      expect(screen.getByRole("dialog", { name: "Meeting consent" })).toBeInTheDocument();
      expect(notesB).toHaveValue("Meeting B remains current.");
    });
  });

  it("still records a meeting when only the AI notes lane is missing", async () => {
    // The regression that blocked this branch: consumers read `state !==
    // "ready"` as "not ready", so the ai_route degradation disabled meeting
    // capture on every fresh install — while the banner beside the disabled
    // button claimed meetings still record and transcribe.
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      meetings: {
        domain: "meetings",
        state: "degraded",
        cause: {
        id: "ai_route",
        message:
          "Notes unavailable — Ollama on this machine is not running. Meetings still record and transcribe.",
        action: {
          id: "open_ai_settings",
          label: "Open AI settings",
          destination: "ai",
        },
      },
      },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "ready",
        cause: null,
      },
    };
    startMeeting.mockResolvedValueOnce("r-live");

    render(<RecordingsView />);

    const newMeeting = screen.getByRole("button", { name: "New meeting" });
    expect(newMeeting).toBeEnabled();

    // The message is informational, not an alarm, and does not claim the
    // meeting needs attention before it can be recorded.
    const notice = screen.getByRole("status", {
      name: "Meeting notes are unavailable",
    });
    expect(notice).toHaveTextContent("Notes unavailable");
    expect(notice).toHaveTextContent("Meetings still record and transcribe.");
    expect(
      screen.queryByRole("alert", { name: "Meetings need attention" }),
    ).not.toBeInTheDocument();

    fireEvent.click(newMeeting);
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm meeting consent" }),
    );

    await waitFor(() => {
      expect(startMeeting).toHaveBeenCalled();
    });
  });

  describe("meeting recovery", () => {
    const user = () => userEvent.setup();

    async function openDegradedMeeting(extra: Record<string, unknown>) {
      recordings = [{ ...recordings[0], ...extra } as Recording];
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "",
        actionItems: [],
      });
      render(<RecordingsView />);
      await user().click(screen.getByText("Weekly sync"));
      return screen.findByRole("heading", { name: "Transcript", exact: true });
    }

    it("renders the capture caveat on the meeting record", async () => {
      await openDegradedMeeting({
        captureDegradedSummary: "System audio recorded nothing for 240s.",
      });

      expect(
        await screen.findByText(/System audio recorded nothing for 240s\./)
      ).toBeInTheDocument();
      expect(
        screen.getByText("Some of this meeting was not captured")
      ).toBeInTheDocument();
    });

    it("states an incomplete transcript honestly and offers both ways out", async () => {
      await openDegradedMeeting({
        transcriptComplete: false,
        transcriptDegradedReason: "2 of 10 chunk(s) failed.",
      });

      expect(
        await screen.findByText(
          "Transcript incomplete — audio kept for re-transcription"
        )
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^Re-transcribe$/ })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /accept losing the audio/i })
      ).toBeInTheDocument();
    });

    it("asks before acknowledging, and says what acknowledging costs", async () => {
      await openDegradedMeeting({
        transcriptComplete: false,
        transcriptDegradedReason: "2 of 10 chunk(s) failed.",
      });

      fireEvent.click(
        screen.getByRole("button", { name: /accept losing the audio/i })
      );

      expect(
        await screen.findByText(/storage cleanup delete that audio/i)
      ).toBeInTheDocument();
      expect(backend.acknowledgeIncompleteTranscript).not.toHaveBeenCalled();

      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: /accept losing the audio/i,
        })
      );

      await waitFor(() => {
        expect(backend.acknowledgeIncompleteTranscript).toHaveBeenCalledWith(
          "r1"
        );
      });
    });

    it("re-checks the saved audio and reports what it found", async () => {
      backend.revalidateRecordingAudio.mockResolvedValueOnce({
        recordingId: "r1",
        recoverable: true,
        message:
          "Saved meeting audio was re-checked and is intact. Re-transcribe this meeting to finish it.",
        assets: [{ role: "primary", lifecycle: "ready", error: null }],
      });
      await openDegradedMeeting({ status: "error" });

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Meeting options" }),
        { button: 0 }
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /re-check audio/i })
      );

      await waitFor(() => {
        expect(backend.revalidateRecordingAudio).toHaveBeenCalledWith("r1");
      });
      expect(
        await screen.findByText(/re-checked and is intact/i)
      ).toBeInTheDocument();
    });

    it("does not claim a repair when the re-check fails", async () => {
      backend.revalidateRecordingAudio.mockRejectedValueOnce(
        new Error("Recording storage is busy.")
      );
      await openDegradedMeeting({ status: "error" });

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Meeting options" }),
        { button: 0 }
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /re-check audio/i })
      );

      expect(
        await screen.findByText("Saved audio could not be fully read")
      ).toBeInTheDocument();
      expect(
        screen.getByText("Recording storage is busy.")
      ).toBeInTheDocument();
    });

    it("offers no recovery affordances for a healthy meeting", async () => {
      await openDegradedMeeting({});

      expect(
        screen.queryByText(/transcript incomplete/i)
      ).not.toBeInTheDocument();
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Meeting options" }),
        { button: 0 }
      );
      await screen.findByRole("menuitem", { name: /move to dictation/i });
      expect(
        screen.queryByRole("menuitem", { name: /re-check audio/i })
      ).not.toBeInTheDocument();
    });
  });

  describe("meeting notes failures", () => {
    it("shows a stored analysis failure on the list row with a retry", async () => {
      // The finding: a meeting whose summary, action items and title all failed
      // looked exactly like one that had never asked for any.
      recordings = [
        {
          ...recordings[0],
          analysisError: "Ollama is not running on this machine.",
        } as Recording,
      ];

      render(<RecordingsView />);

      expect(
        await screen.findByText("Meeting notes were not written")
      ).toBeInTheDocument();
      expect(
        screen.getByText("Ollama is not running on this machine.")
      ).toBeInTheDocument();
      // Remembered, not news: the row does not interrupt a screen reader.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /retry notes/i }));

      await waitFor(() => {
        expect(backend.retryMeetingAnalysis).toHaveBeenCalledWith("r1");
      });
    });

    it("stops waiting for memory while keeping manual retry available", async () => {
      recordings = [{ ...recordings[0], analysisFailure: "Notes will be written when memory frees up." }];
      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop waiting" }));
      await waitFor(() => expect(backend.cancelMeetingNotesWait).toHaveBeenCalledWith("r1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Stop waiting" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Retry notes" })).toBeInTheDocument();
      expect(screen.getByText("Automatic notes cancelled. Retry when ready.")).toBeInTheDocument();
    });

    it("says nothing when the sidecar has no analysis-failure field", async () => {
      render(<RecordingsView />);

      await screen.findByText("Weekly sync");
      expect(
        screen.queryByText("Meeting notes were not written")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /retry notes/i })
      ).not.toBeInTheDocument();
    });

    it("follows the live meeting-analysis status through a retry", async () => {
      recordings = [
        {
          ...recordings[0],
          analysisError: "The analysis provider timed out.",
        } as Recording,
      ];

      render(<RecordingsView />);
      await screen.findByText("Meeting notes were not written");

      await act(async () => {
        eventListeners.get("meeting-analysis-status")?.({
          payload: { recordingId: "r1", phase: "running" },
        });
      });

      expect(
        await screen.findByText("Writing meeting notes")
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /retry notes/i })
      ).not.toBeInTheDocument();

      await act(async () => {
        eventListeners.get("meeting-analysis-status")?.({
          payload: {
            recordingId: "r1",
            phase: "failed",
            error: "Ollama refused the connection.",
          },
        });
      });

      expect(
        await screen.findByText("Ollama refused the connection.")
      ).toBeInTheDocument();

      await act(async () => {
        eventListeners.get("meeting-analysis-status")?.({
          payload: { recordingId: "r1", phase: "completed" },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByText("Meeting notes were not written")
        ).not.toBeInTheDocument();
      });
      expect(refetchRecordings).toHaveBeenCalled();
    });

    it("keeps the failure visible when the retry itself cannot start", async () => {
      recordings = [
        {
          ...recordings[0],
          analysisError: "The analysis provider timed out.",
        } as Recording,
      ];
      backend.retryMeetingAnalysis.mockRejectedValueOnce(
        new Error("No AI route is configured.")
      );

      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: /retry notes/i }));

      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith("No AI route is configured.", "error");
      });
      expect(
        await screen.findByText("No AI route is configured.")
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /retry notes/i })
      ).toBeInTheDocument();
    });

    it("repeats the failure inside the meeting, where the summary is missing", async () => {
      const user = userEvent.setup();
      recordings = [
        {
          ...recordings[0],
          analysisError: "The analysis provider timed out.",
        } as Recording,
      ];
      backend.getRecording.mockResolvedValue({
        ...recordings[0],
        summary: "",
        actionItems: [],
      });

      render(<RecordingsView />);
      await user.click(screen.getByText("Weekly sync"));

      const banners = await screen.findAllByText(
        "Meeting notes were not written"
      );
      expect(banners.length).toBeGreaterThan(0);
      expect(
        screen.getAllByRole("button", { name: /retry notes/i }).length
      ).toBeGreaterThan(0);
    });
  });

  describe("calendar affordance", () => {
    const startsAt = new Date(Date.now() + 12 * 60_000).toISOString();
    const endsAt = new Date(Date.now() + 42 * 60_000).toISOString();

    function withUpcomingMeeting(title = "Pricing review") {
      calendarSnapshot.current = {
        authorization: "authorized",
        observedAt: Date.now(),
        calendars: [{ id: "work", title: "Work", accountName: "iCloud" }],
        errorCode: null,
        events: [
          {
            id: "cal-1",
            title,
            startsAt,
            endsAt,
            isAllDay: false,
            calendarId: "work",
            calendarName: "Work",
            videoService: "zoom",
          },
        ],
      };
    }

    function withJoinMeeting() {
      withUpcomingMeeting();
      calendarSnapshot.current.events[0].conferenceUrl = "https://zoom.us/j/123";
    }

    it("calendar join waits for final consent and reports browser failure after capture", async () => {
      withJoinMeeting();
      startMeeting.mockImplementation(async (options) => {
        options.onJoinFailure();
        return "joined-recording";
      });
      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Join and capture" }));
      expect(startMeeting).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith("begin_calendar_meeting_capture", expect.anything());
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({ joinConferenceUrl: "https://zoom.us/j/123", videoService: "zoom" })));
      expect(toast).toHaveBeenCalledWith("Capture started. The meeting link could not open. Join from your calendar.", "error");
      await waitFor(() => expect(backend.renameRecording).toHaveBeenCalledWith("joined-recording", "Pricing review"));
    });

    it("calendar join cancellation leaves the next capture without stale join intent", async () => {
      withJoinMeeting();
      startMeeting.mockResolvedValue("capture-only");
      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Join and capture" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel meeting consent" }));
      expect(startMeeting).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Start capture" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({ joinConferenceUrl: undefined })));
    });

    it("calendar join blocked by readiness requires a new explicit click", async () => {
      withJoinMeeting();
      readinessContext.productReadiness.meetingsCapture = { domain: "meetings_capture", state: "loading", cause: { id: "loading", message: "Refreshing meeting readiness." } };
      const view = render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Join and capture" }));
      expect(screen.queryByRole("dialog", { name: "Meeting consent" })).toBeNull();
      expect(startMeeting).not.toHaveBeenCalled();
      readinessContext.productReadiness.meetingsCapture = { domain: "meetings_capture", state: "ready", cause: null };
      view.rerender(<RecordingsView />);
      expect(startMeeting).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Meeting consent" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));
      await waitFor(() => expect(startMeeting).toHaveBeenCalledWith(expect.objectContaining({ joinConferenceUrl: undefined })));
    });

    it("names the started meeting after the calendar event", async () => {
      // The whole payoff: one click, and the recording is already called what
      // the meeting is called.
      withUpcomingMeeting();
      startMeeting.mockResolvedValue("new-recording");
      backend.renameRecording.mockResolvedValue(undefined);

      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Start capture" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm meeting consent" }),
      );

      await waitFor(() => {
        expect(backend.renameRecording).toHaveBeenCalledWith(
          "new-recording",
          "Pricing review",
        );
      });
    });

    it("still starts the meeting when the rename fails", async () => {
      // A lost title is not a reason to lose the recording.
      withUpcomingMeeting();
      startMeeting.mockResolvedValue("new-recording");
      backend.renameRecording.mockRejectedValueOnce(new Error("database is locked"));

      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Start capture" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm meeting consent" }),
      );

      await waitFor(() => expect(startMeeting).toHaveBeenCalled());
      await waitFor(() => expect(refetchRecordings).toHaveBeenCalled());
      expect(toast).not.toHaveBeenCalledWith(
        expect.stringContaining("database is locked"),
        "error",
      );
    });

    it("leaves an ordinary New meeting unnamed", async () => {
      // "New meeting" is not a calendar start, and must not inherit a title
      // from an event the reader did not choose.
      withUpcomingMeeting();
      startMeeting.mockResolvedValue("new-recording");

      render(<RecordingsView />);
      fireEvent.click(await screen.findByRole("button", { name: /new meeting/i }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm meeting consent" }),
      );

      await waitFor(() => expect(startMeeting).toHaveBeenCalled());
      expect(backend.renameRecording).not.toHaveBeenCalled();
    });

    it("says nothing when there is no calendar to read", async () => {
      render(<RecordingsView />);

      await screen.findByRole("heading", { name: "Meetings" });
      expect(
        screen.queryByRole("button", { name: "Start capture" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Connect your calendar")).not.toBeInTheDocument();
    });
  });
});

describe("RecordingsView remembered voices", () => {
  it("keeps suggestions when the selected recording object refreshes with the same ID", async () => {
    backend.suggestSpeakerVoices.mockResolvedValue({
      enabled: true,
      clusters: [
        {
          speakerId: "speaker_0",
          appliedProfileId: null,
          matchState: null,
          suggestion: { profileId: "p-dana", displayName: "Dana", percent: 91 },
        },
      ],
      nameOptions: ["Dana"],
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");
    await waitFor(() => {
      expect(
        transcriptViewerProps.current?.speakerVoices?.speaker_0?.suggestion,
      ).toMatchObject({ profileId: "p-dana" });
    });

    backend.suggestSpeakerVoices.mockRejectedValue(
      new Error("suggestion service unavailable"),
    );
    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the same remembered voice" },
    });
    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith("r1", "Goals\nKeep the same remembered voice", undefined, expect.any(String));
    });

    expect(backend.suggestSpeakerVoices).toHaveBeenCalledTimes(1);
    expect(
      transcriptViewerProps.current?.speakerVoices?.speaker_0?.suggestion,
    ).toMatchObject({ profileId: "p-dana" });
    expect(transcriptViewerProps.current?.speakerNameOptions).toEqual(["Dana"]);
  });

  it("ignores a suggestion response from the previously open meeting", async () => {
    const firstResponse = deferred<Awaited<ReturnType<typeof backend.suggestSpeakerVoices>>>();
    const weeklySync = {
      id: "r1",
      title: "Weekly sync",
      projectId: "default",
      duration: 120,
      createdAt: "2026-03-06T12:00:00Z",
      updatedAt: "2026-03-06T12:00:00Z",
      sourceType: "meeting",
      audioPath: "/tmp/weekly-sync.wav",
      meetingCaptureMode: "me_and_them",
      status: "completed",
    } as Recording;
    recordings = [
      weeklySync,
      {
        ...weeklySync,
        id: "r2",
        title: "Planning review",
        audioPath: "/tmp/planning-review.wav",
      },
    ];
    backend.getRecording.mockImplementation(async (recordingId) => ({
      ...recordings.find((recording) => recording.id === recordingId)!,
      summary: "Test summary",
      actionItems: [],
    }));
    backend.suggestSpeakerVoices.mockImplementation(async (recordingId) => {
      if (recordingId === "r1") {
        return firstResponse.promise;
      }
      return {
        enabled: true,
        clusters: [
          {
            speakerId: "speaker_0",
            appliedProfileId: null,
            matchState: null,
            suggestion: { profileId: "p-ravi", displayName: "Ravi", percent: 94 },
          },
        ],
        nameOptions: ["Ravi"],
      };
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await waitFor(() =>
      expect(backend.suggestSpeakerVoices).toHaveBeenCalledWith("r1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
    fireEvent.click(await screen.findByText("Planning review"));
    await waitFor(() =>
      expect(transcriptViewerProps.current?.speakerVoices?.speaker_0?.suggestion)
        .toMatchObject({ profileId: "p-ravi" }),
    );

    await act(async () => {
      firstResponse.resolve({
        enabled: true,
        clusters: [
          {
            speakerId: "speaker_0",
            appliedProfileId: null,
            matchState: null,
            suggestion: { profileId: "p-dana", displayName: "Dana", percent: 91 },
          },
        ],
        nameOptions: ["Dana"],
      });
    });

    expect(transcriptViewerProps.current?.speakerVoices?.speaker_0?.suggestion)
      .toMatchObject({ profileId: "p-ravi" });
    expect(transcriptViewerProps.current?.speakerNameOptions).toEqual(["Ravi"]);
  });

  /**
   * Renaming has to work on a meeting that was diarized before "Remember
   * voices" was ever turned on. Such a meeting has no signature for any of its
   * clusters, the sidecar refuses `rememberSpeakerVoice`, and taking the
   * remember branch anyway made an ordinary rename impossible there.
   */
  it("falls back to a plain rename when the cluster has no voice signature", async () => {
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.suggestSpeakerVoices.mockResolvedValue({
      enabled: true,
      clusters: [],
      nameOptions: [],
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    await waitFor(() => {
      expect(transcriptViewerProps.current?.speakerVoices).toEqual({});
    });

    backend.renameSpeaker.mockClear();
    backend.rememberSpeakerVoice.mockClear();

    await act(async () => {
      await transcriptViewerProps.current.onRenameSpeaker(
        "speaker_0",
        "Alice",
        true,
      );
    });

    expect(backend.rememberSpeakerVoice).not.toHaveBeenCalled();
    expect(backend.renameSpeaker).toHaveBeenCalledWith("r1", "speaker_0", "Alice");
    await waitFor(() => {
      expect(transcriptViewerProps.current.speakerNames).toEqual({
        speaker_0: "Alice",
      });
    });
  });

  it("remembers the voice when the cluster does have a signature", async () => {
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.suggestSpeakerVoices.mockResolvedValue({
      enabled: true,
      clusters: [
        { speakerId: "speaker_0", appliedProfileId: null, matchState: null, suggestion: null },
      ],
      nameOptions: [],
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    await waitFor(() => {
      expect(transcriptViewerProps.current?.speakerVoices).toHaveProperty("speaker_0");
    });

    backend.renameSpeaker.mockClear();
    backend.rememberSpeakerVoice.mockClear();

    await act(async () => {
      await transcriptViewerProps.current.onRenameSpeaker(
        "speaker_0",
        "Dana",
        true,
      );
    });

    expect(backend.rememberSpeakerVoice).toHaveBeenCalledWith({
      recordingId: "r1",
      speakerId: "speaker_0",
      name: "Dana",
    });
    expect(backend.renameSpeaker).not.toHaveBeenCalled();
  });

  /**
   * "Delete all" in Settings used to leave the open transcript offering names
   * for voices that no longer existed, because the suggestions were only
   * re-asked when the selected meeting changed.
   */
  it("clears the chips on the open transcript when a remembered voice is forgotten", async () => {
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.suggestSpeakerVoices.mockResolvedValue({
      enabled: true,
      clusters: [
        {
          speakerId: "speaker_0",
          appliedProfileId: null,
          matchState: null,
          suggestion: { profileId: "p-dana", displayName: "Dana", percent: 91 },
        },
      ],
      nameOptions: ["Dana"],
    });

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });
    await waitFor(() => {
      expect(
        transcriptViewerProps.current?.speakerVoices?.speaker_0?.suggestion,
      ).toMatchObject({ displayName: "Dana" });
    });

    backend.suggestSpeakerVoices.mockResolvedValue({
      enabled: true,
      clusters: [],
      nameOptions: [],
    });

    await act(async () => {
      eventListeners.get("remembered-voices-changed")?.({
        payload: { removed: 1 },
      });
    });

    await waitFor(() => {
      expect(transcriptViewerProps.current.speakerVoices).toEqual({});
      expect(transcriptViewerProps.current.speakerNameOptions).toEqual([]);
    });
  });
});

describe("RecordingsView audio import", () => {
  beforeEach(() => {
    recordingsLoading = false;
    recordingsHaveLoaded = true;
    recordingsError = null;
    recordingState = {
      isRecording: false,
      recordingId: null,
      formattedDuration: "00:00",
      meetingPhase: "idle",
      meetingMessage: null,
    };
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
    recordings = [
      {
        id: "r1",
        title: "Weekly sync",
        projectId: "default",
        duration: 120,
        createdAt: "2026-03-06T12:00:00Z",
        updatedAt: "2026-03-06T12:00:00Z",
        sourceType: "meeting",
        audioPath: "/tmp/weekly-sync.wav",
        meetingCaptureMode: "me_and_them",
        status: "completed" as const,
      } as Recording,
    ];
    backend.getRecording.mockResolvedValue({ ...recordings[0] });
    backend.getTranscript.mockResolvedValue({
      id: "t1",
      recordingId: "r1",
      segments: [],
      fullText: "",
      language: "en",
      confidence: 0.9,
      model: "parakeet",
      createdAt: "2026-03-06T12:02:00Z",
    });
    backend.getMeetingTranscriptDetails.mockResolvedValue({});
  });

  it("offers Import audio beside New meeting and hands the picker's file to the sidecar", async () => {
    backend.importAudioFile.mockResolvedValue({
      recordingId: "r2",
      title: "Q3 planning call",
      sourceFileName: "Q3 planning call.m4a",
      durationSeconds: 1800,
    });

    render(<RecordingsView />);
    await screen.findByRole("heading", { name: "Meetings" });

    const importButton = screen.getByRole("button", { name: /import audio/i });
    // The one gold CTA on this surface stays "New meeting".
    expect(screen.getByRole("button", { name: /new meeting/i })).toBeInTheDocument();
    fireEvent.click(importButton);

    await waitFor(() => {
      expect(backend.importAudioFile).toHaveBeenCalledTimes(1);
      // The renderer never names a path; the main process picks the file.
      expect(backend.importAudioFile).toHaveBeenCalledWith();
    });
    await waitFor(() => {
      expect(refetchRecordings).toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        "Importing Q3 planning call.m4a. Transcription is running now.",
        "success",
      );
    });
    // No consent step: nobody is being recorded.
    expect(
      screen.queryByRole("button", { name: "Confirm meeting consent" }),
    ).not.toBeInTheDocument();
  });

  it("says Importing while the file is being decoded, and nothing at all when the picker is dismissed", async () => {
    const pending = deferred<any>();
    backend.importAudioFile.mockReturnValue(pending.promise);

    render(<RecordingsView />);
    await screen.findByRole("heading", { name: "Meetings" });
    fireEvent.click(screen.getByRole("button", { name: /import audio/i }));

    const importing = await screen.findByRole("button", { name: /importing/i });
    expect(importing).toBeDisabled();

    // A dismissed picker resolves with nothing: no toast, no reload, no noise.
    await act(async () => {
      pending.resolve(null);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /import audio/i }),
      ).not.toBeDisabled();
    });
    expect(toast).not.toHaveBeenCalled();
    expect(refetchRecordings).not.toHaveBeenCalled();
  });

  it("cannot start an import while a meeting is being recorded", async () => {
    recordingState = {
      isRecording: true,
      recordingId: "r9",
      formattedDuration: "00:42",
      meetingPhase: "recording",
      meetingMessage: null,
    };

    render(<RecordingsView />);
    await screen.findByRole("heading", { name: "Meetings" });

    expect(screen.getByRole("button", { name: /import audio/i })).toBeDisabled();
  });

  it("labels an imported meeting as a file, not as Me + Them, and says which file", async () => {
    recordings = [
      {
        id: "imported-1",
        title: "Q3 planning call",
        projectId: "default",
        duration: 1800,
        createdAt: "2026-03-06T12:00:00Z",
        updatedAt: "2026-03-06T12:00:00Z",
        sourceType: "meeting",
        audioPath: "/tmp/recording_1_abcdefgh.wav",
        meetingCaptureMode: "imported",
        importedSourceName: "Q3 planning call.m4a",
        status: "completed" as const,
      } as Recording,
    ];
    backend.getRecording.mockResolvedValue({ ...recordings[0] });
    backend.getTranscript.mockResolvedValue({
      id: "t2",
      recordingId: "imported-1",
      segments: [],
      fullText: "",
      language: "en",
      confidence: 0.9,
      model: "parakeet",
      createdAt: "2026-03-06T12:02:00Z",
    });

    render(<RecordingsView />);
    fireEvent.click(await screen.findByText("Q3 planning call"));
    await screen.findByRole("heading", { name: "Transcript", exact: true });

    expect(await screen.findByText("Imported file")).toBeInTheDocument();
    expect(screen.queryByText("Me + Them")).not.toBeInTheDocument();
    // The meeting can be renamed; the file it came from is stated separately.
    expect(screen.getByText("From Q3 planning call.m4a")).toBeInTheDocument();
  });
});
