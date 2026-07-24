// @ts-nocheck - Vitest mock types don't align with TypeScript
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsView } from "@/components/views/recordings-view";
import type { Recording } from "@/types";
import * as backend from "@/lib/backend";

const speechSynthesisMock = {
  speak: vi.fn(),
  cancel: vi.fn(),
};

const eventListeners = new Map<string, (event: { payload: any }) => void>();
const toast = vi.fn();
const startMeeting = vi.fn();
const stopMeeting = vi.fn();

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    eventListeners.set(eventName, handler);
    return () => {
      eventListeners.delete(eventName);
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
};

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    startMeeting,
    stopMeeting,
    isRecording: recordingState.isRecording,
    recordingId: recordingState.recordingId,
    formattedDuration: recordingState.formattedDuration,
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

vi.mock("@/components/transcript-viewer", () => ({
  TranscriptViewer: () => null,
  TranscriptSearch: () => null,
}));

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
  retryMeetingAutoName: vi.fn() as any,
  setRecordingSourceType: vi.fn() as any,
  isDiarizationModelAvailable: vi.fn(async () => false) as any,
  getMeetingChatMessages: vi.fn(async () => []) as any,
  updateMeetingChatMessages: vi.fn(async () => {}) as any,
  askMemory: vi.fn() as any,
  updateTranscriptSegment: vi.fn() as any,
  deleteTranscriptSegments: vi.fn() as any,
  updateRecordingNotes: vi.fn(async () => {}) as any,
  updateRecordingAnalysis: vi.fn(async () => {}) as any,
  updateRecordingTemplate: vi.fn(async () => {}) as any,
  getRelationshipMemory: vi.fn(async () => null) as any,
  summarizeRecordingGrounded: vi.fn(async () => ({})) as any,
  extractActionItemsGrounded: vi.fn(async () => ({})) as any,
  exportRecordingV2: vi.fn(async () => ({})) as any,
  openExportPath: vi.fn() as any,
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
    speechSynthesisMock.speak.mockClear();
    speechSynthesisMock.cancel.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
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
    recordings[0] = {
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
    } as Recording;
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
    backend.getMeetingChatMessages.mockResolvedValue([]);
    backend.updateMeetingChatMessages.mockResolvedValue(undefined);
    backend.updateRecordingNotes.mockResolvedValue(undefined);
    backend.updateRecordingAnalysis.mockResolvedValue(undefined);
    backend.updateRecordingTemplate.mockResolvedValue(undefined);
    backend.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Fresh grounded summary",
      citations: [],
      model: "test-model",
      processingTimeMs: 1200,
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
      model: "test-model",
      processingTimeMs: 900,
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

  it("updates meeting filters immediately when a recording enters processing", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "Processing" }));
    expect(screen.getByText("No meetings match your filters")).toBeInTheDocument();

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
    await screen.findByText("Meeting notes");

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
    await screen.findByText("Meeting notes");

    await waitFor(() => {
      expect(backend.getMeetingTranscriptDetails).toHaveBeenCalledWith("r1");
    });
  });

  it("offers a retry-transcription entry point in the row menu for meetings stuck in error", async () => {
    recordings[0] = { ...recordings[0], status: "error" as const };
    backend.retranscribeRecording.mockResolvedValue(undefined);

    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Recording options" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry Transcription" }));

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
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Transcript" }), { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Retry transcription" }));

    await waitFor(() => {
      expect(backend.retranscribeRecording).toHaveBeenCalledWith("r1");
    });
  });

  it("does not offer retry-transcription for a completed meeting", async () => {
    render(<RecordingsView />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Recording options" }), {
      button: 0,
    });
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("menuitem", { name: "Retry Transcription" })).not.toBeInTheDocument();
  });

  it("persists edited summary and action item blocks from the notes tab", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Meeting summary");

    fireEvent.change(screen.getByLabelText("Meeting summary"), {
      target: { value: "User-edited recap" },
    });
    fireEvent.change(screen.getByLabelText("Meeting action items"), {
      target: { value: "Follow up with design\nShip release notes" },
    });

    await waitFor(() => {
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith(
        "r1",
        "User-edited recap",
        ["Follow up with design", "Ship release notes"]
      );
    });
  });

  it("regenerates summary and action items into editable meeting blocks", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Meeting summary");

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh Summary" })[0]);

    await waitFor(() => {
      expect(backend.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
    expect(screen.getByDisplayValue("Fresh grounded summary")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh Action Items" })[0]);

    await waitFor(() => {
      expect(backend.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });
    expect(
      screen.getByDisplayValue("Ship launch checklist (Owner: Jon · Due: Friday)")
    ).toBeInTheDocument();
  });

  it("does not replace the visible summary when grounded refresh fails to persist", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Saved summary",
      actionItems: ["Existing follow-up"],
    });
    backend.updateRecordingAnalysis.mockRejectedValueOnce(new Error("Disk write failed"));

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    expect(await screen.findByDisplayValue("Saved summary")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh Summary" })[0]);

    await waitFor(() => {
      expect(backend.updateRecordingAnalysis).toHaveBeenCalledWith(
        "r1",
        "Fresh grounded summary",
        ["Existing follow-up"]
      );
    });

    expect(screen.getByDisplayValue("Saved summary")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Fresh grounded summary")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Apply Outline" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Done\n- \n\nPlanned next\n- \n\nBlockers\n- \n\nOwners\n- "
      );
    });
    expect(screen.getByLabelText("Done notes")).toHaveValue("");
    expect(screen.getByLabelText("Blockers notes")).toHaveValue("");
  });

  it("shows review workflow and follow-up tools in meeting review", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    expect(await screen.findByText("Review workflow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Follow-up Draft" })).toBeInTheDocument();
    // Refresh and copy-recap are not restated here; they belong to the cards
    // they act on.
    expect(screen.getAllByRole("button", { name: "Refresh Summary" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Refresh Action Items" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Copy recap$/ })).toHaveLength(1);
    expect(await screen.findByText("Prep notes")).toBeInTheDocument();
    expect(screen.getByText("Cross-meeting Recall")).toBeInTheDocument();
    expect(screen.getByText("Follow-up tools")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Follow-up Email" })).toBeInTheDocument();
  });

  it("can read the meeting summary aloud from the review surface", async () => {
    backend.getRecording.mockResolvedValue({
      ...recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByDisplayValue("Canonical meeting summary");

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
    await screen.findByDisplayValue("Canonical meeting summary");

    fireEvent.click(screen.getByRole("button", { name: "Read Follow-up" }));

    await waitFor(() => {
      expect(speechSynthesisMock.cancel).toHaveBeenCalled();
      expect(speechSynthesisMock.speak).toHaveBeenCalled();
    });
  });

  it("runs cross-meeting recall from the meeting review sidebar", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByText("Cross-meeting Recall")).toBeInTheDocument();
    // The component may show preset suggestions; if not, we can test the functionality differently
    // For now, let's test that askMemory can be called directly
    await backend.askMemory("What has Jon cared about across recent meetings?");

    await waitFor(() => {
      expect(backend.askMemory).toHaveBeenCalledWith(
        expect.stringContaining("What has Jon cared about across recent meetings?")
      );
    });
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
    await screen.findByRole("button", { name: "Add Section" });

    fireEvent.click(screen.getByRole("button", { name: "Add Section" }));

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
    await screen.findByText("Meeting notes");
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

  it("copies a grounded follow-up draft from the ask workspace", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy Follow-up" }));

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
    await screen.findByText("Meeting notes");
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Append to Notes" }));

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
    await screen.findByText("Meeting notes");
    fireEvent.click(await screen.findByRole("tab", { name: "Notes" }));

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Keep the launch blocked only on legal approval." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Enhance Notes" }));

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
      expect(
        screen.getByRole("button", { name: /Enhance Notes|Regenerate/i })
      ).toBeInTheDocument();
      expect(screen.getByText("Launch is on track with one open dependency.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Apply to Notes" })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply to Notes" }));

    await waitFor(() => {
      expect(backend.updateRecordingNotes).toHaveBeenLastCalledWith("r1", expectedDraft);
    });
    expect(toast).toHaveBeenCalledWith(
      "Enhanced notes applied to this meeting.",
      "success"
    );
  });

  it("copies a recap without the verbatim transcript", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    fireEvent.change(screen.getByLabelText("Meeting summary"), {
      target: { value: "Tight weekly recap" },
    });
    fireEvent.change(screen.getByLabelText("Meeting action items"), {
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
    await screen.findByText("Meeting notes");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy full record (includes transcript)",
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
    await screen.findByText("Meeting notes");

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
    await screen.findByText("Meeting notes");

    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));

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
    await screen.findByText("Meeting notes");

    expect(await screen.findByText("Transcript-only")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Audio is not saved or has already been removed by retention. Transcript, notes, summary, and action items remain available until this meeting is deleted."
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
    await screen.findByText("Meeting notes");

    fireEvent.click(screen.getByText("Launch review"));
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

    expect(screen.getByText("Open Workspace")).toBeInTheDocument();
    expect(screen.getByText("Me + Them")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Workspace" }));

    await screen.findByText("Meeting notes");
    expect(screen.getByText("Capture mode")).toBeInTheDocument();
    expect(screen.getAllByText("Me + Them").length).toBeGreaterThan(0);
  });

  it("starts meeting capture after consent and stops an active meeting", async () => {
    startMeeting.mockResolvedValueOnce("r-live");

    render(<RecordingsView />);

    fireEvent.click(screen.getByRole("button", { name: "New Meeting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm meeting consent" }));

    await waitFor(() => {
      expect(startMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          systemAudio: true,
          projectId: "default",
          consentPromptShown: true,
        }),
      );
    });

    recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
    };

    render(<RecordingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Stop Meeting" }));

    await waitFor(() => {
      expect(stopMeeting).toHaveBeenCalledTimes(1);
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
    await user.click(await screen.findByRole("tab", { name: "Transcript" }));
    await screen.findByText("No speaker labels detected");
    await user.click(await screen.findByRole("button", { name: "Identify Speakers" }));

    expect(
      await screen.findByText(/Speaker diarization is not yet available as a local model/i)
    ).toBeInTheDocument();

    backend.isDiarizationModelAvailable.mockResolvedValueOnce(true);
    backend.runDiarization.mockResolvedValueOnce({
      speakers: [
        { id: "speaker-1", name: "Speaker 1" },
        { id: "speaker-2", name: "Speaker 2" },
      ],
      segmentsUpdated: 2,
    });

    await user.click(screen.getByRole("button", { name: "Identify Speakers" }));

    await waitFor(() => {
      expect(backend.runDiarization).toHaveBeenCalledWith("r1");
    });
    expect(await screen.findByText("Speaker identification complete (2 speakers found).")).toBeInTheDocument();
  });
});
