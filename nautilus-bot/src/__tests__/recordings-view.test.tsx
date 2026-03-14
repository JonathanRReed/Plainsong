import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsView } from "@/components/views/recordings-view";
import type { Recording } from "@/types";

const mocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: any }) => void>(),
  refetch: vi.fn(),
  toast: vi.fn(),
  startMeeting: vi.fn(),
  stopMeeting: vi.fn(),
  getRecording: vi.fn(),
  getTranscript: vi.fn(),
  getMeetingTranscriptDetails: vi.fn(),
  getRecordingWaveform: vi.fn(async () => []),
  getSpeakers: vi.fn(async () => []),
  getMeetingChatMessages: vi.fn(),
  updateMeetingChatMessages: vi.fn(),
  askMemory: vi.fn(async () => ({
    response: "Jon keeps pushing for a written launch plan and Friday owner confirmation.",
    citations: [
      {
        text: "Jon asked for a written launch plan before Friday.",
        startTime: 12,
        endTime: 16,
        recordingId: "r0",
      },
    ],
  })),
  updateRecordingNotes: vi.fn(),
  updateRecordingAnalysis: vi.fn(),
  updateRecordingTemplate: vi.fn(),
  getRelationshipMemory: vi.fn(async () => ({
    people: [
      {
        id: "p1",
        name: "Jon",
        recordingCount: 2,
        lastSeenAt: "2026-03-05T12:00:00Z",
        relatedCompanies: ["Acme"],
        recentMeetings: [
          {
            recordingId: "r0",
            recordingTitle: "Weekly sync",
            createdAt: "2026-03-05T12:00:00Z",
            snippet: "Jon owns the launch checklist and follow-up.",
          },
        ],
      },
    ],
    companies: [],
  })),
  summarizeRecordingGrounded: vi.fn(),
  extractActionItemsGrounded: vi.fn(),
  exportRecordingV2: vi.fn(),
  openExportPath: vi.fn(),
  recordings: [
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
  ] as Recording[],
  recordingState: {
    isRecording: false,
    recordingId: null as string | null,
    formattedDuration: "00:00",
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    mocks.eventListeners.set(eventName, handler);
    return () => {
      mocks.eventListeners.delete(eventName);
    };
  }),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings: mocks.recordings,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    startMeeting: mocks.startMeeting,
    stopMeeting: mocks.stopMeeting,
    isRecording: mocks.recordingState.isRecording,
    recordingId: mocks.recordingState.recordingId,
    formattedDuration: mocks.recordingState.formattedDuration,
  }),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast: mocks.toast,
  }),
}));

vi.mock("@/components/recording-overlay", () => ({
  ConsentDialog: () => null,
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

vi.mock("@/lib/tauri", () => ({
  getRecording: mocks.getRecording,
  getRecordingWaveform: mocks.getRecordingWaveform,
  openRecordingAudio: vi.fn(),
  getSpeakers: mocks.getSpeakers,
  getTranscript: mocks.getTranscript,
  getMeetingTranscriptDetails: mocks.getMeetingTranscriptDetails,
  runDiarization: vi.fn(),
  renameSpeaker: vi.fn(),
  deleteRecording: vi.fn(),
  renameRecording: vi.fn(),
  retryMeetingAutoName: vi.fn(),
  setRecordingSourceType: vi.fn(),
  isDiarizationModelAvailable: vi.fn(async () => false),
  getMeetingChatMessages: mocks.getMeetingChatMessages,
  updateMeetingChatMessages: mocks.updateMeetingChatMessages,
  askMemory: mocks.askMemory,
  updateTranscriptSegment: vi.fn(),
  deleteTranscriptSegments: vi.fn(),
  updateRecordingNotes: mocks.updateRecordingNotes,
  updateRecordingAnalysis: mocks.updateRecordingAnalysis,
  updateRecordingTemplate: mocks.updateRecordingTemplate,
  getRelationshipMemory: mocks.getRelationshipMemory,
  summarizeRecordingGrounded: mocks.summarizeRecordingGrounded,
  extractActionItemsGrounded: mocks.extractActionItemsGrounded,
  exportRecordingV2: mocks.exportRecordingV2,
  openExportPath: mocks.openExportPath,
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
    mocks.eventListeners.clear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
    mocks.recordingState = {
      isRecording: false,
      recordingId: null,
      formattedDuration: "00:00",
    };
    mocks.recordings = [
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
      },
    ] as Recording[];
    mocks.startMeeting.mockReset();
    mocks.stopMeeting.mockReset();
    mocks.getRecording.mockResolvedValue(mocks.recordings[0]);
    mocks.getTranscript.mockResolvedValue({
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
    mocks.getMeetingTranscriptDetails.mockResolvedValue({
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
    mocks.getMeetingChatMessages.mockResolvedValue([]);
    mocks.updateMeetingChatMessages.mockResolvedValue(undefined);
    mocks.updateRecordingNotes.mockResolvedValue(undefined);
    mocks.updateRecordingAnalysis.mockResolvedValue(undefined);
    mocks.updateRecordingTemplate.mockResolvedValue(undefined);
    mocks.summarizeRecordingGrounded.mockResolvedValue({
      summary: "Fresh grounded summary",
      citations: [],
      model: "test-model",
      processingTimeMs: 1200,
    });
    mocks.extractActionItemsGrounded.mockResolvedValue({
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
    mocks.exportRecordingV2.mockResolvedValue({
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

    const handler = mocks.eventListeners.get("recording-status-changed");
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
    });
  });

  it("refreshes the selected meeting from canonical recording data when analysis completes", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    mocks.getRecording.mockResolvedValue({
      ...mocks.recordings[0],
      summary: "Canonical meeting summary",
      actionItems: ["Ship launch checklist"],
    });

    const handler = mocks.eventListeners.get("recording-analysis-ready");
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
      expect(mocks.getMeetingTranscriptDetails).toHaveBeenCalledWith("r1");
    });
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
      expect(mocks.updateRecordingAnalysis).toHaveBeenCalledWith(
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

    fireEvent.click(screen.getByRole("button", { name: "Refresh Summary" }));

    await waitFor(() => {
      expect(mocks.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
    });
    expect(screen.getByDisplayValue("Fresh grounded summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh Action Items" }));

    await waitFor(() => {
      expect(mocks.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });
    expect(
      screen.getByDisplayValue("Ship launch checklist (Owner: Jon · Due: Friday)")
    ).toBeInTheDocument();
  });

  it("persists template changes and can apply the matching notes outline", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByRole("group", { name: "Meeting notes" });

    fireEvent.change(screen.getByLabelText("Playbook"), {
      target: { value: "standup" },
    });

    await waitFor(() => {
      expect(mocks.updateRecordingTemplate).toHaveBeenCalledWith("r1", "standup");
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply Outline" }));

    await waitFor(() => {
      expect(mocks.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Done\n- \n\nPlanned next\n- \n\nBlockers\n- \n\nOwners\n- "
      );
    });
    expect(screen.getByLabelText("Done notes")).toHaveValue("");
    expect(screen.getByLabelText("Blockers notes")).toHaveValue("");
  });

  it("shows prep briefing and follow-up center in meeting review", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByText("Prep Briefing")).toBeInTheDocument();
    expect(screen.getByText("Cross-meeting Recall")).toBeInTheDocument();
    expect(screen.getByText("Follow-up Center")).toBeInTheDocument();
    expect(screen.getByText("Jon owns the launch checklist and follow-up.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Follow-up Email" })).toBeInTheDocument();
  });

  it("runs cross-meeting recall from the meeting review sidebar", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));

    expect(await screen.findByText("Cross-meeting Recall")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Jon cared about across recent meetings/i }));

    await waitFor(() => {
      expect(mocks.askMemory).toHaveBeenCalledWith(
        expect.stringContaining("What has Jon cared about across recent meetings?")
      );
    });
    expect(
      await screen.findByText(
        "Jon keeps pushing for a written launch plan and Friday owner confirmation."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Jon asked for a written launch plan before Friday.")).toBeInTheDocument();
  });

  it("persists meeting note section edits through the notes autosave flow", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByLabelText("Goals notes");

    fireEvent.change(screen.getByLabelText("Goals notes"), {
      target: { value: "Align launch scope and decide owners" },
    });

    await waitFor(() => {
      expect(mocks.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Goals\nAlign launch scope and decide owners"
      );
    });
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
      expect(mocks.updateRecordingNotes).toHaveBeenLastCalledWith(
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
      expect(mocks.updateMeetingChatMessages).toHaveBeenCalledWith("r1", [
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
    expect(mocks.toast).toHaveBeenCalledWith("Follow-up draft copied.", "success");
  });

  it("can append a grounded follow-up draft into meeting notes", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");
    fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Append to Notes" }));

    await waitFor(() => {
      expect(mocks.updateRecordingNotes).toHaveBeenCalledWith(
        "r1",
        "Follow-up draft\nThanks all. Next steps: Jon will send the launch plan by Friday."
      );
    });
  });

  it("builds an enhanced notes draft with citations and can apply it to meeting notes", async () => {
    mocks.summarizeRecordingGrounded.mockResolvedValue({
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
    mocks.extractActionItemsGrounded.mockResolvedValue({
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
      expect(mocks.summarizeRecordingGrounded).toHaveBeenCalledWith("r1");
      expect(mocks.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });

    const expectedDraft =
      "Summary\n" +
      "Launch is on track with one open dependency.\n\n" +
      "Action Items\n" +
      "- Send legal review packet (Owner: Jon · Due: Friday)\n\n" +
      "Raw Notes Context\n" +
      "Goals\nKeep the launch blocked only on legal approval.";

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Regenerate" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Apply to Notes" })
      ).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply to Notes" }));

    await waitFor(() => {
      expect(mocks.updateRecordingNotes).toHaveBeenLastCalledWith("r1", expectedDraft);
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      "Enhanced notes applied to this meeting.",
      "success"
    );
  });

  it("copies a markdown recap from the meeting review workspace", async () => {
    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    fireEvent.change(screen.getByLabelText("Meeting summary"), {
      target: { value: "Tight weekly recap" },
    });
    fireEvent.change(screen.getByLabelText("Meeting action items"), {
      target: { value: "Ship launch checklist" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    expect(mocks.toast).toHaveBeenCalledWith("Meeting recap copied as markdown.", "success");
  });

  it("uses persisted consent state in review metadata and markdown exports", async () => {
    mocks.recordings = [
      {
        ...mocks.recordings[0],
        consentPromptShown: true,
        consentNoticeMode: "manual_required",
        consentNoticeMessage:
          "Manual reminder only. Copy the consent notice from Nautilus before you continue.",
      },
    ];
    mocks.getRecording.mockResolvedValue(mocks.recordings[0]);

    render(<RecordingsView />);

    fireEvent.click(screen.getByText("Weekly sync"));
    await screen.findByText("Meeting notes");

    expect(screen.getByText("Manual reminder required")).toBeInTheDocument();
    expect(
      screen.getByText("Manual reminder only. Copy the consent notice from Nautilus before you continue.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

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
      expect(mocks.exportRecordingV2).toHaveBeenCalledWith("r1", "markdown", {
        redactionLevel: "basic",
        preview: false,
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(mocks.openExportPath).toHaveBeenCalledWith("/tmp/weekly-sync.md");
    });
  });

  it("ignores stale meeting chat loads after switching recordings", async () => {
    mocks.recordings = [
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
    mocks.getRecording.mockImplementation(async (recordingId: string) =>
      mocks.recordings.find((recording) => recording.id === recordingId) ?? null
    );

    const firstChatLoad = deferred<Awaited<ReturnType<typeof mocks.getMeetingChatMessages>>>();
    mocks.getMeetingChatMessages
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
    mocks.recordingState = {
      isRecording: true,
      recordingId: "r1",
      formattedDuration: "02:04",
    };
    mocks.recordings = [
      {
        ...mocks.recordings[0],
        status: "recording",
      },
    ] as Recording[];
    mocks.getRecording.mockResolvedValue(mocks.recordings[0]);

    render(<RecordingsView />);

    expect(screen.getByText("Open Workspace")).toBeInTheDocument();
    expect(screen.getByText("Me + Them")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Workspace" }));

    await screen.findByText("Meeting notes");
    expect(screen.getByText("Capture mode")).toBeInTheDocument();
    expect(screen.getAllByText("Me + Them").length).toBeGreaterThan(0);
  });
});
