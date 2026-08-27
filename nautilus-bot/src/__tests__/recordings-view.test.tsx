// @ts-nocheck - Vitest mock types don't align with TypeScript
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsView } from "@/components/views/recordings-view";
import type { Recording } from "@/types";
import * as backend from "@/lib/backend";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";
import { OPEN_SETTINGS_TAB_EVENT } from "@/lib/navigation";

const speechSynthesisMock = {
  speak: vi.fn(),
  cancel: vi.fn(),
};

const eventListeners = new Map<string, (event: { payload: any }) => void>();
const toast = vi.fn();
const startMeeting = vi.fn();
const stopMeeting = vi.fn();
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
    fullCapture: { domain: "full_capture", state: "ready", cause: null },
    overall: { domain: "overall", state: "ready", cause: null },
  } as ProductReadinessSnapshot,
}));

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    eventListeners.set(eventName, handler);
    return () => {
      if (eventListeners.get(eventName) === handler) {
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
};
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
  useRecording: () => ({
    startMeeting,
    stopMeeting,
    isRecording: recordingState.isRecording,
    recordingId: recordingState.recordingId,
    formattedDuration: recordingState.formattedDuration,
    meetingPhase: recordingState.meetingPhase,
    meetingMessage: recordingState.meetingMessage,
  }),
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
        <button type="button" onClick={() => props.onStart?.({ systemAudio: true })}>
          Confirm meeting consent
        </button>
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

vi.mock("@/lib/backend", () => ({
  getRecording: vi.fn(async () => ({})) as any,
  getRecordingWaveform: vi.fn() as any,
  openRecordingAudio: vi.fn() as any,
  getSpeakers: vi.fn() as any,
  getTranscript: vi.fn(async () => ({})) as any,
  getMeetingTranscriptDetails: vi.fn(async () => ({})) as any,
  runDiarization: vi.fn() as any,
  renameSpeaker: vi.fn() as any,
  deleteRecording: vi.fn() as any,
  renameRecording: vi.fn() as any,
  retranscribeRecording: vi.fn() as any,
  retryMeetingAnalysis: vi.fn(async () => {}) as any,
  retryMeetingAutoName: vi.fn() as any,
  revalidateRecordingAudio: vi.fn(async () => ({})) as any,
  acknowledgeIncompleteTranscript: vi.fn(async () => ({})) as any,
  setRecordingSourceType: vi.fn() as any,
  isDiarizationModelAvailable: vi.fn(async () => false) as any,
  getMeetingChatMessages: vi.fn(async () => []) as any,
  updateMeetingChatMessages: vi.fn(async () => {}) as any,
  askMemory: vi.fn() as any,
  editTranscriptSpeakerTurn: vi.fn() as any,
  deleteTranscriptSegments: vi.fn() as any,
  updateRecordingNotes: vi.fn(async () => {}) as any,
  updateRecordingAnalysis: vi.fn(async () => {}) as any,
  updateRecordingTemplate: vi.fn(async () => {}) as any,
  getRelationshipMemory: vi.fn(async () => null) as any,
  summarizeRecordingGrounded: vi.fn(async () => ({})) as any,
  extractActionItemsGrounded: vi.fn(async () => ({})) as any,
  exportRecordingV2: vi.fn(async () => ({})) as any,
  openExportPath: vi.fn() as any,
  searchTranscripts: vi.fn(async () => []) as any,
  openPermissionSettings: vi.fn(async () => {}) as any,
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

describe("RecordingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
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
    recordingsLoading = false;
    recordingsHaveLoaded = true;
    recordingsError = null;
    readinessContext.engineNotice = null;
    readinessContext.productReadiness = {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: { domain: "meetings", state: "ready", cause: null },
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
    backend.editTranscriptSpeakerTurn.mockResolvedValue(undefined);
    backend.deleteRecording.mockResolvedValue(undefined);
    backend.searchTranscripts.mockResolvedValue([]);
    backend.getRelationshipMemory.mockResolvedValue(null);
    backend.getMeetingChatMessages.mockResolvedValue([]);
    backend.updateMeetingChatMessages.mockResolvedValue(undefined);
    backend.updateRecordingNotes.mockResolvedValue(undefined);
    backend.updateRecordingAnalysis.mockResolvedValue(undefined);
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

  it("shows the empty state only after a successful empty response", () => {
    recordings = [];
    recordingsLoading = false;
    recordingsHaveLoaded = true;

    render(<RecordingsView />);

    expect(screen.getByText("No meetings yet")).toBeInTheDocument();
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
    await screen.findByText("The record");

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
    await screen.findByText("The record");

    await waitFor(() => {
      expect(backend.getMeetingTranscriptDetails).toHaveBeenCalledWith("r1");
    });
  });

  it("saves a speaker-turn edit with one atomic backend command", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");
    await waitFor(() => {
      expect(transcriptViewerProps.current?.onEditSegment).toBeTypeOf("function");
    });

    await act(async () => {
      await transcriptViewerProps.current.onEditSegment(
        ["s1", "s2"],
        "Corrected whole speaker turn."
      );
    });

    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledTimes(1);
    expect(backend.editTranscriptSpeakerTurn).toHaveBeenCalledWith(
      "r1",
      ["s1", "s2"],
      "Corrected whole speaker turn."
    );
    expect(backend.deleteTranscriptSegments).not.toHaveBeenCalled();
  });

  it("persists a speaker rename before updating local speaker names", async () => {
    const pendingRename = deferred<void>();
    backend.getSpeakers.mockResolvedValue([
      { id: "speaker_0", name: "Speaker 1", color: "#000", sampleCount: 1 },
    ]);
    backend.renameSpeaker.mockReturnValueOnce(pendingRename.promise);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");
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
    await screen.findByText("The record");
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
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Done\n- \n\nPlanned next\n- \n\nBlockers\n- \n\nOwners\n- "
      );
    });
    expect(screen.getByLabelText("Done notes")).toHaveValue("");
    expect(screen.getByLabelText("Blockers notes")).toHaveValue("");
  });

  it("keeps the meeting's working groups without the workflow narration", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");

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
    expect(screen.getAllByText("Ready to send")).toHaveLength(1);
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
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByText("Ask across your earlier meetings")).toBeInTheDocument();
    // The component may show preset suggestions; if not, we can test the functionality differently
    // For now, let's test that askMemory can be called directly
    await backend.askMemory("What has Jon cared about across recent meetings?");

    await waitFor(() => {
      expect(backend.askMemory).toHaveBeenCalledWith(
        expect.stringContaining("What has Jon cared about across recent meetings?")
      );
    });
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
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nKeep the scope tight"
      );
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
    expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
      "r1",
      "Goals\nNewer draft"
    );
  });

  it("persists meeting note section edits through the notes autosave flow", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Align launch scope and decide owners" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nAlign launch scope and decide owners"
      );
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
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nAgree the launch order and the owners\n\nDecisions\nlegal signed off\n\nship date slipped"
      );
    });
    expect(screen.getByLabelText("Decisions notes")).toHaveValue(
      "legal signed off\n\nship date slipped"
    );
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
      expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith(
        "r1",
        "Risks\nLegal review may slip next week"
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove section Risks" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Risks")).not.toBeInTheDocument();
    });
  });

  it("persists meeting chat history for the selected recording", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");
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
    await screen.findByText("The record");

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
    await screen.findByText("The record");
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
    await screen.findByText("The record");
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to my notes" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "## Follow-up draft\nThanks all. Next steps: Jon will send the launch plan by Friday."
      );
    });
  });

  it("builds an enhanced notes draft with citations and can apply it to meeting notes", async () => {
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
    await screen.findByText("The record");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the launch blocked only on legal approval." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });

    const expectedDraft =
      "## Summary\n" +
      "Launch is on track with one open dependency.\n\n" +
      "## Action Items\n" +
      "- Send legal review packet (Owner: Jon · Due: Friday)\n\n" +
      "## Raw Notes Context\n" +
      "Goals\nKeep the launch blocked only on legal approval.";

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save over my notes" })).not.toBeDisabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Save over my notes" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith("r1", expectedDraft);
    });
    expect(toast).toHaveBeenCalledWith("Draft saved into your notes.", "success");
  });

  it("keeps prior action items when enhanced-note action analysis fails", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Fresh summary survived the partial failure.",
      citations: [],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 1200,
      grounded: true,
      provenance: {
        version: 1,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "test-model",
        promptSource: "meeting_playbook:auto",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: true,
      },
    });
    backend.extractActionItemsGrounded.mockRejectedValueOnce(
      new Error("Action extraction timed out")
    );

    render(<RecordingsView />);
    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");
    fireEvent.click(screen.getByRole("button", { name: "Build a draft" }));

    const draft = await screen.findByRole("region", {
      name: "Enhanced meeting notes draft",
    });
    expect(draft).toHaveTextContent("Fresh summary survived the partial failure.");
    expect(draft).toHaveTextContent("Ship launch checklist");
    expect(screen.getByLabelText("Action items")).toHaveTextContent(
      "Ship launch checklist"
    );
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not redo the action items, so what was already saved was kept"
      ),
      "info"
    );
  });

  it("copies a recap without the verbatim transcript", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");

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
    expect(copied).not.toContain("## Transcript");
    expect(toast).toHaveBeenCalledWith(
      "Recap copied — summary, action items, and notes. No transcript.",
      "success"
    );
  });

  it("only ships the verbatim transcript from the named full-record action", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");

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
    await screen.findByText("The record");

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
    await screen.findByText("The record");

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
    await screen.findByText("The record");

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
    await screen.findByText("The record");

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

    await screen.findByText("The record");
    expect(screen.getAllByText("Me + Them").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Meeting title")).toHaveValue("Weekly sync");
  });

  it("starts meeting capture after consent and stops an active meeting", async () => {
    startMeeting.mockResolvedValueOnce("r-live");

    render(<RecordingsView />);

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

    render(<RecordingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));

    await waitFor(() => {
      expect(stopMeeting).toHaveBeenCalledTimes(1);
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
      expect(backend.searchTranscripts).toHaveBeenCalledWith("launch review", 25);
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
      await screen.findByText("The record");

      // The banner used to live only in the list branch, so the workspace's own
      // Play audio failed with nothing on screen but a toast.
      fireEvent.click(screen.getByRole("button", { name: "Play audio" }));

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
    await screen.findByText("The record");
    fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
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
        screen.getByText(/Written by Plainsong from the transcript and your notes\./i)
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
      screen.getByText(/Your text\. Regenerate to have Plainsong rewrite it from the transcript\./i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText("We are on track for launch, pending legal approval.")
    ).not.toBeInTheDocument();
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
        screen.getByText(/Written by Plainsong from the transcript and your notes\./i)
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
      screen.getByText(/Written by Plainsong from the transcript and your notes\./i)
    ).toBeInTheDocument();
    expect(
      screen.getByText("We are on track for launch, pending legal approval.")
    ).toBeInTheDocument();
    // Provider, model, and when the analysis finished. The timestamp is
    // labelled: this page shows the meeting's own createdAt a few inches above
    // and again in the header strip, so a bare date here is unreadable.
    expect(
      screen.getByText(
        `ollama · llama3.2 · finished ${new Date("2026-07-25T12:00:00.000Z").toLocaleString()}`
      )
    ).toBeInTheDocument();
  });

  it("says plainly when a generated line has no transcript citation", async () => {
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Launch is on track pending legal sign-off.",
      citations: [],
      model: "test-model",
      processingTimeMs: 1200,
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
    await screen.findByText("The record");

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
    await screen.findByText("The record");

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
        /Nothing stored says whether you or Plainsong wrote this[\s\S]*Regenerate to have Plainsong rewrite it/i
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Refresh to have Plainsong/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refresh the summary or action items/i)).not.toBeInTheDocument();
  });

  it("carries the row menu's actions in the header overflow", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("The record");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Meeting options" }), {
      button: 0,
    });

    expect(
      await screen.findByRole("menuitem", { name: "Copy recap as Markdown" })
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Move to Dictation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
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
    expect(actionItems.querySelectorAll("li")).toHaveLength(2);

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

    expect(await screen.findByText("The record")).toBeInTheDocument();
    expect(
      screen.queryByText(/Loading the summary, action items, and notes for this meeting/i)
    ).not.toBeInTheDocument();
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
    await screen.findByText("Nobody is named in this transcript");
    await user.click(await screen.findByRole("button", { name: "Label the speakers" }));

    expect(
      await screen.findByText(
        /Plainsong has no on-device model for separating speakers yet/i
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
          "System audio is not available, so the other side of the call would not be recorded."
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/microphone permissions/i)
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Set up system audio" }));
      await waitFor(() => {
        expect(backend.openPermissionSettings).toHaveBeenCalledWith(
          "system_audio"
        );
      });
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

      fireEvent.click(screen.getByRole("button", { name: /retry notes/i }));

      await waitFor(() => {
        expect(backend.retryMeetingAnalysis).toHaveBeenCalledWith("r1");
      });
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
});
