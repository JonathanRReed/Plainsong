import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";

const backendMocks = vi.hoisted(() => ({
  analyzeRecording: vi.fn(),
  cancelAnalysisRun: vi.fn(),
  extractActionItems: vi.fn(),
  extractActionItemsGrounded: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
}));

const clipboardWriteText = vi.fn();

vi.mock("@/lib/backend", () => ({
  analyzeRecording: backendMocks.analyzeRecording,
  cancelAnalysisRun: backendMocks.cancelAnalysisRun,
  extractActionItems: backendMocks.extractActionItems,
  extractActionItemsGrounded: backendMocks.extractActionItemsGrounded,
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: { payload: any }) => void) => {
      eventMocks.listeners.set(eventName, handler);
      return () => eventMocks.listeners.delete(eventName);
    }
  ),
  invoke: vi.fn(),
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

function analysisResult(label: string) {
  return {
    query: `${label} backend query`,
    response: `${label} answer`,
    citations: [
      {
        text: `${label} source`,
        startTime: 1,
        endTime: 2,
        recordingId: "r1",
        certainty: 0.9,
      },
    ],
    actualProvider: "ollama",
    model: "test-model",
    processingTimeMs: 10,
    grounded: true,
    provenance: {
      version: 1,
      contentHash: `v1:sha256:${label}`,
      actualProvider: "ollama",
      actualModel: "test-model",
      promptSource: "analysis_query",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [],
      grounded: true,
    },
  };
}

describe("AiAnalysisPanel", () => {
  it("labels note references without treating absent audio times or lexical overlap as missing evidence", async () => {
    const note = "Mara will send the proposal by Friday only after legal approves.";
    backendMocks.analyzeRecording.mockResolvedValue({ query: "summary", response: "Mara will send it Friday after legal approval.", citations: [{ text: note, sourceKind: "meeting_note", segmentId: "meeting-note:0", recordingId: "r1", startTime: null, endTime: null, certainty: 0.7 }], model: "local-test", processingTimeMs: 10, grounded: true });
    render(<AiAnalysisPanel recordingId="r1" sourceNotes={note} />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    expect((await screen.findAllByText("Written note")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/lack a current source reference/)).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence|certainty|coverage 0%/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[r1\]/)).not.toBeInTheDocument();
  });

  it("marks a note reference stale when the current notes change", async () => {
    const note = "Send the proposal.";
    backendMocks.analyzeRecording.mockResolvedValue({ query: "summary", response: "Send it.", citations: [{ text: note, sourceKind: "meeting_note", segmentId: "meeting-note:0", recordingId: "r1" }], model: "local-test", processingTimeMs: 10, grounded: true });
    const view = render(<AiAnalysisPanel recordingId="r1" sourceNotes={note} />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findAllByText("Written note");
    view.rerender(<AiAnalysisPanel recordingId="r1" sourceNotes="Do not send the proposal." />);
    expect((await screen.findAllByText("Written note · Unverified reference")).length).toBeGreaterThan(0);
    expect(screen.getByText(/lack a current source reference/)).toBeInTheDocument();
  });

  it.each(["meeting_note", "unknown"])("does not display forged audio positions for %s sources", async (sourceKind) => {
    backendMocks.analyzeRecording.mockResolvedValue({ query: "summary", response: "Send it.", citations: [{ text: "Send the proposal.", sourceKind, segmentId: "meeting-note:0", recordingId: "r1", startTime: 999, endTime: 1000 }], model: "local-test", processingTimeMs: 10, grounded: true });
    render(<AiAnalysisPanel recordingId="r1" sourceNotes="Send the proposal." />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByText(/lack a current source reference/);
    expect(screen.queryByText(/999\.0s/)).not.toBeInTheDocument();
  });

  it("announces answering, completion and failure while keeping question focus", async () => {
    const pending = deferred<ReturnType<typeof analysisResult>>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);
    const input = screen.getByLabelText("Question about this meeting");
    input.focus();
    fireEvent.change(input, { target: { value: "What changed?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("status", { name: "Answer status" })).toHaveTextContent("Answering");
    expect(input).toHaveFocus();
    await act(async () => pending.resolve(analysisResult("First")));
    expect(screen.getByRole("status", { name: "Answer status" })).toHaveTextContent("Answer ready");
    expect(screen.getByRole("region", { name: "Meeting answer" })).toHaveTextContent("First answer");
    expect(input).toHaveFocus();
    backendMocks.analyzeRecording.mockRejectedValueOnce(new Error("Please try again"));
    fireEvent.change(input, { target: { value: "What else?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Please try again");
    expect(screen.getByRole("status", { name: "Answer status" })).toHaveTextContent("Answer failed");
    expect(input).toHaveFocus();
  });

  it("clears request progress when the answer resolves without a completed event", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);
    await waitFor(() => expect(eventMocks.listeners.has("recording-analysis-progress")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalled());
    const calls = backendMocks.analyzeRecording.mock.calls;
    const runId = calls[calls.length - 1]?.[3];
    act(() => eventMocks.listeners.get("recording-analysis-progress")?.({payload:{recordingId:"r1",runId,target:"ask",stage:"synthesizing",strategy:"direct",completed:0,total:1,pass:0,message:"Writing QA answer",updatedAt:"2026-07-25T12:00:00Z"}}));
    expect(screen.getByText("Writing QA answer")).toBeInTheDocument();
    await act(async () => pending.resolve({query:"summary",response:"The answer is here.",citations:[],model:"local-test",processingTimeMs:10,grounded:false}));
    expect(await screen.findAllByText("The answer is here.")).not.toHaveLength(0);
    expect(screen.queryByText("Writing QA answer")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
    eventMocks.listeners.clear();
    backendMocks.cancelAnalysisRun.mockResolvedValue(undefined);
    backendMocks.analyzeRecording.mockResolvedValue({
      query: "summary",
      response: "Grounded summary",
      citations: [
        {
          text: "Ship the release this Friday",
          startTime: 3,
          endTime: 5,
          recordingId: "r1",
          certainty: 0.92,
        },
      ],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 950,
      provenance: {
        version: 1,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "test-model",
        promptSource: "analysis_query",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: true,
      },
    });
    backendMocks.extractActionItems.mockResolvedValue([]);
    backendMocks.extractActionItemsGrounded.mockResolvedValue({
      items: [
        {
          task: "Ship the release",
          assignee: "Jon",
          deadline: "Friday",
          citations: [
            {
              text: "Jon will ship the release this Friday",
              startTime: 8,
              endTime: 10,
              recordingId: "r1",
              certainty: 0.95,
            },
          ],
        },
      ],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 1100,
    });
  });

  describe.each(["template", "custom"] as const)("%s request failures", (request) => {
    it.each([
      "ollama Policy: An earlier Ollama request may still be running. Local processing is paused because its completion could not be confirmed. Restarting Plainsong or checking loaded models does not confirm it stopped.",
      "native_text Policy: Local processing is paused because Plainsong could not read or update its Ollama safety marker in the configuration directory.",
      "ollama Policy: Automatic Ollama warm-up deferred: insufficient or unverified memory headroom for the model and other applications",
      "ollama OutputLimit: Generation reached its output limit; incomplete output was not accepted.",
      "ollama Configuration: Model not found. Choose an installed model in Settings > Models.",
    ])("keeps the backend refusal: %s", async (message) => {
      backendMocks.analyzeRecording.mockRejectedValueOnce(new Error(message));
      render(<AiAnalysisPanel recordingId="r1" />);
      if (request === "template") {
        fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
      } else {
        fireEvent.change(screen.getByPlaceholderText(/ask a custom question/i), {
          target: { value: "What happened?" },
        });
        fireEvent.click(screen.getByRole("button", { name: /send/i }));
      }
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByText(/Ollama is not running|Transcript not available/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open Search & AI" })).not.toBeInTheDocument();
    });
  });

  it.each([
    "ollama Transport: Connection refused. Start the configured Ollama server.",
    "openai Configuration: Missing provider secret for 'openai'. Add an API key in Settings > Search & AI > API keys.",
  ])("keeps explicit setup guidance while preserving the backend error", async (message) => {
    backendMocks.analyzeRecording.mockRejectedValueOnce(new Error(message));
    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    // One in-app way forward, not a terminal command.
    expect(screen.getByRole("button", { name: "Open Search & AI" })).toBeInTheDocument();
    expect(screen.queryByText(/ollama serve/)).not.toBeInTheDocument();
  });

  it.each([
    "Error invoking remote method 'sidecar:invoke': Error: native_text OutputLimit: Incomplete output was not accepted.",
    { message: "native_text OutputLimit: Incomplete output was not accepted." },
  ])("keeps error detail across string and object transport payloads", async (failure) => {
    backendMocks.analyzeRecording.mockRejectedValueOnce(failure);
    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    expect(await screen.findByText("native_text OutputLimit: Incomplete output was not accepted.")).toBeInTheDocument();
  });

  it("runs grounded action item extraction when requested", async () => {
    render(<AiAnalysisPanel recordingId="r1" analysisMode="grounded" />);

    fireEvent.click(screen.getByRole("button", { name: /action items/i }));

    await waitFor(() => {
      expect(backendMocks.extractActionItemsGrounded).toHaveBeenCalledWith(
        "r1",
        undefined,
        {
          persist: false,
          runId: expect.any(String),
        }
      );
    });

    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Jon will ship the release this Friday/).length
    ).toBeGreaterThan(0);
  });

  it("warns when citations remain but the backend marks the answer ungrounded", async () => {
    backendMocks.analyzeRecording.mockResolvedValueOnce({
      query: "summary",
      response: "Grounded summary",
      citations: [
        {
          text: "Ship the release this Friday",
          startTime: 3,
          endTime: 5,
          recordingId: "r1",
          certainty: 1,
        },
      ],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 950,
      grounded: false,
      provenance: {
        version: 1,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "test-model",
        promptSource: "analysis_query",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: false,
      },
    });

    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));

    expect(
      await screen.findByText(/one or more citations were invalid or did not support the answer/i)
    ).toBeInTheDocument();
  });

  it("copies the verified answer byte for byte without starting another backend request", async () => {
    const response = "  First line\n\nSecond line with trailing spaces  \n";
    backendMocks.analyzeRecording.mockResolvedValueOnce({
      ...analysisResult("Verified"),
      response,
    });

    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByRole("button", { name: "Copy answer" });

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(response));
    expect(await screen.findByRole("status", { name: "Copy status" })).toHaveTextContent("Answer copied.");
    expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1);
    expect(backendMocks.extractActionItems).not.toHaveBeenCalled();
    expect(backendMocks.extractActionItemsGrounded).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the ungrounded warning",
      result: { ...analysisResult("Ungrounded"), grounded: false },
      warning: "Not fully grounded: one or more citations were invalid or did not support the answer.",
    },
    {
      name: "the incomplete-reference warning",
      result: { ...analysisResult("Incomplete"), citations: [] },
      warning: "Some citations lack a current source reference. Review the answer against its sources.",
    },
  ])("prefixes $name before the exact answer", async ({ result, warning }) => {
    backendMocks.analyzeRecording.mockResolvedValueOnce(result);
    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByRole("button", { name: "Copy answer" });

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(`${warning}\n\n${result.response}`);
    });
  });

  it("allows one clipboard write and keeps a replacement answer disabled until it settles", async () => {
    const copy = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(copy.promise);
    backendMocks.analyzeRecording
      .mockResolvedValueOnce(analysisResult("First"))
      .mockResolvedValueOnce(analysisResult("Second"));
    render(
      <AiAnalysisPanel
        recordingId="r1"
        templates={[
          { id: "first", name: "First prompt", icon: "file-text", query: "First query", description: "First" },
          { id: "second", name: "Second prompt", icon: "file-text", query: "Second query", description: "Second" },
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /First prompt/ }));
    await screen.findByText("Answered question: First prompt");

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    const pendingButton = screen.getByRole("button", { name: "Copying…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Second prompt/ }));
    await screen.findByText("Answered question: Second prompt");
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();

    await act(async () => copy.resolve());

    expect(await screen.findByRole("button", { name: "Copy answer" })).toBeEnabled();
    expect(screen.queryByText("Answer copied.")).not.toBeInTheDocument();
  });

  it("shows a manual-copy alert after rejection and retries the current answer", async () => {
    clipboardWriteText
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValueOnce(undefined);
    render(<AiAnalysisPanel recordingId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByRole("button", { name: "Copy answer" });

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not copy the answer. Select it and copy it manually."
    );
    const retryButton = screen.getByRole("button", { name: "Copy answer" });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status", { name: "Copy status" })).toHaveTextContent("Answer copied.");
  });

  it("drops stale copy feedback when source notes change the review warning", async () => {
    const copy = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(copy.promise);
    const note = "Mara will send the proposal Friday.";
    const response = "Mara will send it Friday.\n";
    backendMocks.analyzeRecording.mockResolvedValueOnce({
      ...analysisResult("Note"),
      response,
      citations: [{
        text: note,
        sourceKind: "meeting_note",
        segmentId: "meeting-note:0",
        recordingId: "r1",
        startTime: null,
        endTime: null,
        certainty: 0.9,
      }],
    });
    const view = render(<AiAnalysisPanel recordingId="r1" sourceNotes={note} />);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByRole("button", { name: "Copy answer" });
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    view.rerender(<AiAnalysisPanel recordingId="r1" sourceNotes="The proposal is paused." />);
    expect(await screen.findByText(/lack a current source reference/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
    await act(async () => copy.resolve());

    expect(screen.queryByText("Answer copied.")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Copy answer" }));
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenLastCalledWith(
        "Some citations lack a current source reference. Review the answer against its sources.\n\nMara will send it Friday.\n"
      );
    });
  });

  it("copies action items in display order with available details without updating the meeting thread", async () => {
    const onChatMessagesChange = vi.fn();
    backendMocks.extractActionItemsGrounded.mockResolvedValueOnce({
      items: [
        {
          task: "Ship the release",
          assignee: "Jon",
          deadline: "Friday",
          citations: [{
            text: "Jon will ship the release Friday.",
            startTime: 8,
            endTime: 10,
            recordingId: "r1",
          }],
        },
        {
          task: "Confirm support coverage",
          assignee: "Mara",
          citations: [{
            text: "Mara will confirm support coverage.",
            startTime: 11,
            endTime: 13,
            recordingId: "r1",
          }],
        },
        {
          task: "Archive the checklist",
          deadline: "Monday",
          citations: [{
            text: "Archive the checklist by Monday.",
            startTime: 14,
            endTime: 16,
            recordingId: "r1",
          }],
        },
        {
          task: "Post the retrospective",
          citations: [{
            text: "Post the retrospective.",
            startTime: 17,
            endTime: 19,
            recordingId: "r1",
          }],
        },
      ],
      grounded: true,
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 1100,
    });

    render(
      <AiAnalysisPanel
        recordingId="r1"
        analysisMode="grounded"
        chatMessages={[]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    await screen.findByRole("button", { name: "Copy tasks" });
    await waitFor(() => expect(onChatMessagesChange).toHaveBeenCalled());
    onChatMessagesChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Copy tasks" }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith([
        "- Ship the release (Owner: Jon · Due: Friday)",
        "- Confirm support coverage (Owner: Mara)",
        "- Archive the checklist (Due: Monday)",
        "- Post the retrospective",
      ].join("\n"));
    });
    expect(await screen.findByRole("status", { name: "Copy status" })).toHaveTextContent("Tasks copied.");
    expect(onChatMessagesChange).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an ungrounded extraction",
      result: {
        items: [{
          task: "Verify the release",
          citations: [{ text: "Verify the release.", startTime: 3, endTime: 5, recordingId: "r1" }],
        }],
        grounded: false,
      },
      warning: "Not fully grounded: one or more follow-ups had invalid or unsupported transcript citations.",
    },
    {
      name: "a missing task reference",
      result: {
        items: [{ task: "Verify the release", citations: [] }],
        grounded: true,
      },
      warning: "Some task citations lack a current source reference. Review the tasks against the meeting before sharing.",
    },
  ])("prefixes the task review warning for $name", async ({ result, warning }) => {
    backendMocks.extractActionItemsGrounded.mockResolvedValueOnce({
      ...result,
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 1100,
    });
    render(<AiAnalysisPanel recordingId="r1" analysisMode="grounded" />);
    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    await screen.findByRole("button", { name: "Copy tasks" });

    fireEvent.click(screen.getByRole("button", { name: "Copy tasks" }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(`${warning}\n\n- Verify the release`);
    });
  });

  it("keeps one copy in flight across task and answer outputs and drops its stale success feedback", async () => {
    const copy = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(copy.promise);
    backendMocks.analyzeRecording.mockResolvedValueOnce(analysisResult("Replacement"));
    render(<AiAnalysisPanel recordingId="r1" analysisMode="grounded" />);
    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    await screen.findByRole("button", { name: "Copy tasks" });

    fireEvent.click(screen.getByRole("button", { name: "Copy tasks" }));
    expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await screen.findByText("Answered question: Meeting Summary");
    const pendingAnswerCopy = screen.getByRole("button", { name: "Copying…" });
    expect(pendingAnswerCopy).toBeDisabled();
    fireEvent.click(pendingAnswerCopy);
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);

    await act(async () => copy.resolve());

    expect(await screen.findByRole("button", { name: "Copy answer" })).toBeEnabled();
    expect(screen.queryByText("Tasks copied.")).not.toBeInTheDocument();
  });

  it("shows the task-specific manual-copy alert after rejection and retries", async () => {
    clipboardWriteText
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValueOnce(undefined);
    render(<AiAnalysisPanel recordingId="r1" analysisMode="grounded" />);
    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    await screen.findByRole("button", { name: "Copy tasks" });

    fireEvent.click(screen.getByRole("button", { name: "Copy tasks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not copy the tasks. Select them and copy them manually."
    );
    const retryButton = screen.getByRole("button", { name: "Copy tasks" });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status", { name: "Copy status" })).toHaveTextContent("Tasks copied.");
  });

  it("exposes response actions with grounded payloads", async () => {
    const onAction = vi.fn();

    render(
      <AiAnalysisPanel
        recordingId="r1"
        responseActions={[
          {
            label: "Use Result",
            onAction,
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Grounded summary").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));

    expect(onAction).toHaveBeenCalledWith({
      response: "Grounded summary",
      query:
        "Provide a concise summary of this meeting, highlighting the main topics discussed and key outcomes.",
      templateId: "summary",
      citations: [
        {
          text: "Ship the release this Friday",
          startTime: 3,
          endTime: 5,
          recordingId: "r1",
          certainty: 0.92,
        },
      ],
      provenance: {
        version: 1,
        contentHash: "v1:sha256:summary",
        actualProvider: "ollama",
        actualModel: "test-model",
        promptSource: "analysis_query",
        completedAt: "2026-07-25T12:00:00.000Z",
        citations: [],
        grounded: true,
      },
    });
  });

  it("keeps response actions bound to the completed prompt until the next answer succeeds", async () => {
    const secondRequest = deferred<ReturnType<typeof analysisResult>>();
    const retry = deferred<ReturnType<typeof analysisResult>>();
    const onAction = vi.fn();
    const isVisible = vi.fn(() => true);
    backendMocks.analyzeRecording
      .mockResolvedValueOnce(analysisResult("First"))
      .mockReturnValueOnce(secondRequest.promise)
      .mockReturnValueOnce(retry.promise);

    render(
      <AiAnalysisPanel
        recordingId="r1"
        templates={[
          { id: "first", name: "First prompt", icon: "file-text", query: "First query", description: "First" },
          { id: "second", name: "Second prompt", icon: "file-text", query: "Second query", description: "Second" },
        ]}
        responseActions={[{ label: "Use Result", onAction, isVisible }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /first prompt/i }));
    expect(await screen.findByText("Answered question: First prompt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /second prompt/i }));
    expect(screen.getByText("Answering: Second prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
      response: "First answer",
      query: "First query",
      templateId: "first",
      citations: analysisResult("First").citations,
      provenance: analysisResult("First").provenance,
    }));
    expect(isVisible).toHaveBeenLastCalledWith(expect.objectContaining({
      response: "First answer",
      query: "First query",
      templateId: "first",
    }));

    await act(async () => secondRequest.reject(new Error("Second prompt failed")));
    expect(await screen.findByText("Second prompt failed")).toBeInTheDocument();
    expect(screen.getByText("Answered question: First prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
      response: "First answer",
      query: "First query",
      templateId: "first",
    }));

    fireEvent.click(screen.getByRole("button", { name: /second prompt/i }));
    await act(async () => retry.resolve(analysisResult("Second")));
    expect(await screen.findByText("Answered question: Second prompt")).toBeInTheDocument();
    expect(screen.queryByText("Answered question: First prompt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
      response: "Second answer",
      query: "Second query",
      templateId: "second",
      citations: analysisResult("Second").citations,
      provenance: analysisResult("Second").provenance,
    }));
  });

  it("keeps template response metadata when a custom question fails", async () => {
    const customRequest = deferred<ReturnType<typeof analysisResult>>();
    const onAction = vi.fn();
    backendMocks.analyzeRecording
      .mockResolvedValueOnce(analysisResult("Template"))
      .mockReturnValueOnce(customRequest.promise);

    render(
      <AiAnalysisPanel
        recordingId="r1"
        templates={[
          { id: "recap", name: "Release recap", icon: "file-text", query: "Recap query", description: "Recap" },
        ]}
        responseActions={[{ label: "Use Result", onAction }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /release recap/i }));
    expect(await screen.findByText("Answered question: Release recap")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/ask a custom question/i), {
      target: { value: "What remains blocked?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(screen.getByText("Answering: What remains blocked?")).toBeInTheDocument();

    await act(async () => customRequest.reject(new Error("Custom question failed")));
    expect(await screen.findByText("Custom question failed")).toBeInTheDocument();
    expect(screen.getByText("Answered question: Release recap")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      response: "Template answer",
      query: "Recap query",
      templateId: "recap",
    }));
  });

  it("keeps action-item template metadata while a custom question is pending or fails", async () => {
    const customRequest = deferred<ReturnType<typeof analysisResult>>();
    const onAction = vi.fn();
    backendMocks.analyzeRecording.mockReturnValueOnce(customRequest.promise);

    render(
      <AiAnalysisPanel
        recordingId="r1"
        analysisMode="grounded"
        actionItemActions={[{ label: "Use Tasks", onAction }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    expect(await screen.findByText("Ship the release")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/ask a custom question/i), {
      target: { value: "Who owns testing?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(screen.getByText("Answering: Who owns testing?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use Tasks" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: "actions" }));

    await act(async () => customRequest.reject(new Error("Custom task question failed")));
    expect(await screen.findByText("Custom task question failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Tasks" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ templateId: "actions" }));
  });

  it("renders and extends a persisted meeting conversation", async () => {
    const onChatMessagesChange = vi.fn();

    render(
      <AiAnalysisPanel
        recordingId="r1"
        chatMessages={[
          {
            id: "existing-user",
            role: "user",
            content: "What did Jon own?",
            templateId: null,
            citations: [],
            createdAt: "2026-03-06T12:00:00Z",
          },
          {
            id: "existing-assistant",
            role: "assistant",
            content: "Jon owned the release checklist.",
            templateId: null,
            citations: [
              {
                text: "Jon owns the release checklist",
                startTime: 6,
                endTime: 8,
                recordingId: "r1",
                certainty: 0.91,
              },
            ],
            createdAt: "2026-03-06T12:01:00Z",
          },
        ]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );

    expect(screen.getByText("Conversation")).toBeInTheDocument();
    expect(screen.getByText("Jon owned the release checklist.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/ask a custom question/i), {
      target: { value: "What slipped?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(backendMocks.analyzeRecording).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("Earlier user questions for conversational context:"),
        undefined,
        expect.any(String)
      );
      const analyzeCalls = backendMocks.analyzeRecording.mock.calls;
      expect(analyzeCalls[analyzeCalls.length - 1]?.[1]).not.toContain(
        "Jon owned the release checklist."
      );
    });
    await waitFor(() => {
      expect(onChatMessagesChange).toHaveBeenCalled();
    });
    expect(screen.getAllByText(/What slipped\?/i).length).toBeGreaterThan(0);
  });

  it("isolates progress and failures to the active target and run", async () => {
    render(<AiAnalysisPanel recordingId="r1" />);
    await waitFor(() => {
      expect(eventMocks.listeners.has("recording-analysis-progress")).toBe(true);
      expect(eventMocks.listeners.has("recording-analysis-failed")).toBe(true);
    });

    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalled());
    const analyzeCalls = backendMocks.analyzeRecording.mock.calls;
    const runId = analyzeCalls[analyzeCalls.length - 1]?.[3];

    act(() => {
      eventMocks.listeners.get("recording-analysis-progress")?.({
        payload: {
          recordingId: "r1",
          runId: "other-run",
          target: "ask",
          stage: "mapping",
          strategy: "chunked",
          completed: 1,
          total: 9,
          pass: 0,
          message: "Wrong run",
          updatedAt: "2026-07-25T12:00:00.000Z",
        },
      });
      eventMocks.listeners.get("recording-analysis-progress")?.({
        payload: {
          recordingId: "r1",
          runId,
          target: "summary",
          stage: "mapping",
          strategy: "chunked",
          completed: 1,
          total: 7,
          pass: 0,
          message: "Wrong target",
          updatedAt: "2026-07-25T12:00:00.000Z",
        },
      });
    });
    expect(screen.queryByText("Wrong run")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong target")).not.toBeInTheDocument();

    act(() => {
      eventMocks.listeners.get("recording-analysis-progress")?.({
        payload: {
          recordingId: "r1",
          runId,
          target: "ask",
          stage: "mapping",
          strategy: "chunked",
          completed: 2,
          total: 5,
          pass: 0,
          message: "Reading transcript chunk 2 of 5",
          updatedAt: "2026-07-25T12:00:00.000Z",
        },
      });
    });
    expect(screen.getByText("Reading transcript chunk 2 of 5")).toBeInTheDocument();

    act(() => {
      eventMocks.listeners.get("recording-analysis-failed")?.({
        payload: {
          recordingId: "r1",
          runId,
          target: "ask",
          reason: "Provider timed out during reduction.",
          updatedAt: "2026-07-25T12:00:01.000Z",
        },
      });
    });
    expect(
      screen.getByText(/Previous successful analysis remains available/i)
    ).toBeInTheDocument();

    await act(async () => {
      pending.reject(new Error("Provider timed out during reduction."));
      await Promise.resolve();
    });
  });

  it("cancels the active backend run when the panel unmounts", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<AiAnalysisPanel recordingId="r1" />);

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalled());
    const analyzeCalls = backendMocks.analyzeRecording.mock.calls;
    const runId = analyzeCalls[analyzeCalls.length - 1]?.[3];

    unmount();

    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledWith(runId);
  });

  it("cancels a question once, ignores its late events and result, and preserves completed output and the current draft", async () => {
    const pending = deferred<ReturnType<typeof analysisResult>>();
    const onAction = vi.fn();
    const onChatMessagesChange = vi.fn();
    backendMocks.analyzeRecording
      .mockResolvedValueOnce(analysisResult("Previous"))
      .mockReturnValueOnce(pending.promise);

    render(
      <AiAnalysisPanel
        recordingId="r1"
        templates={[
          { id: "previous", name: "Previous answer", icon: "file-text", query: "Previous query", description: "Previous" },
          { id: "unused", name: "Unused prompt", icon: "file-text", query: "Unused query", description: "Unused" },
        ]}
        responseActions={[{ label: "Use Result", onAction }]}
        chatMessages={[]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /previous answer/i }));
    expect((await screen.findAllByText("Previous answer", { selector: "p" })).length).toBeGreaterThan(0);
    onChatMessagesChange.mockClear();

    const input = screen.getByPlaceholderText(/ask a custom question/i);
    fireEvent.change(input, { target: { value: "Question to cancel" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(2));
    const runId = backendMocks.analyzeRecording.mock.calls[1]?.[3];
    fireEvent.change(input, { target: { value: "Keep this draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledTimes(1);
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledWith(runId);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /unused prompt/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByText("Cancelling: Question to cancel")).toBeInTheDocument();

    act(() => {
      eventMocks.listeners.get("recording-analysis-progress")?.({
        payload: { recordingId: "r1", runId, target: "ask", stage: "mapping", strategy: "chunked", completed: 1, total: 2, pass: 0, message: "Late progress", updatedAt: "2026-07-25T12:00:00Z" },
      });
      eventMocks.listeners.get("recording-analysis-failed")?.({
        payload: { recordingId: "r1", runId, target: "ask", reason: "Late failure", updatedAt: "2026-07-25T12:00:01Z" },
      });
    });
    expect(screen.queryByText(/Late progress|Late failure/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      response: "Previous answer",
      query: "Previous query",
      templateId: "previous",
    }));

    await act(async () => pending.resolve(analysisResult("Cancelled")));

    expect(screen.queryByText("Cancelled answer")).not.toBeInTheDocument();
    expect(screen.getAllByText("Previous answer", { selector: "p" }).length).toBeGreaterThan(0);
    expect(input).toHaveValue("Keep this draft");
    expect(onChatMessagesChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /unused prompt/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeEnabled();
  });

  it("cancels grounded action-item extraction without replacing the prior answer or notifying the thread", async () => {
    const pending = deferred<any>();
    const onAction = vi.fn();
    const onChatMessagesChange = vi.fn();
    backendMocks.analyzeRecording.mockResolvedValueOnce(analysisResult("Prior"));
    backendMocks.extractActionItemsGrounded.mockReturnValueOnce(pending.promise);

    render(
      <AiAnalysisPanel
        recordingId="r1"
        analysisMode="grounded"
        responseActions={[{ label: "Use Result", onAction }]}
        chatMessages={[]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    expect((await screen.findAllByText("Prior answer")).length).toBeGreaterThan(0);
    onChatMessagesChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /action items/i }));
    await waitFor(() => expect(backendMocks.extractActionItemsGrounded).toHaveBeenCalledTimes(1));
    const runId = backendMocks.extractActionItemsGrounded.mock.calls[0]?.[2]?.runId;

    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledWith(runId);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getAllByText("Prior answer").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Use Result" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      response: "Prior answer",
      templateId: "summary",
    }));

    await act(async () => pending.resolve({
      items: [{ task: "Cancelled task", assignee: "Mara", deadline: "Friday", citations: [] }],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 10,
    }));

    expect(screen.queryByText("Cancelled task")).not.toBeInTheDocument();
    expect(screen.getAllByText("Prior answer").length).toBeGreaterThan(0);
    expect(onChatMessagesChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /action items/i })).toBeEnabled();
  });

  it("keeps waiting and ignores the result when the cancel request fails", async () => {
    const pending = deferred<ReturnType<typeof analysisResult>>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    backendMocks.cancelAnalysisRun.mockRejectedValueOnce(new Error("Cancel RPC failed"));
    render(<AiAnalysisPanel recordingId="r1" />);

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(await screen.findByText("Could not cancel immediately. Waiting for the request to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /action items/i })).toBeDisabled();

    await act(async () => pending.resolve(analysisResult("Ignored")));

    expect(screen.queryByText("Ignored answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Could not cancel immediately. Waiting for the request to finish.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /action items/i })).toBeEnabled();
  });

  it("suppresses late cancel feedback across a source change and does not cancel the same run again on unmount", async () => {
    const analysis = deferred<ReturnType<typeof analysisResult>>();
    const cancellation = deferred<void>();
    void cancellation.promise.catch(() => undefined);
    backendMocks.analyzeRecording.mockReturnValueOnce(analysis.promise);
    backendMocks.cancelAnalysisRun.mockReturnValueOnce(cancellation.promise);
    const view = render(<AiAnalysisPanel recordingId="r1" />);

    fireEvent.click(screen.getByRole("button", { name: /meeting summary/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1));
    const runId = backendMocks.analyzeRecording.mock.calls[0]?.[3];
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledWith(runId);

    view.rerender(<AiAnalysisPanel recordingId="r2" />);
    await act(async () => cancellation.reject(new Error("Late cancel failure")));

    expect(screen.queryByText(/Could not cancel immediately|Late cancel failure/)).not.toBeInTheDocument();
    view.unmount();
    expect(backendMocks.cancelAnalysisRun).toHaveBeenCalledTimes(1);

    await act(async () => analysis.resolve(analysisResult("Stale")));
  });

  it("preserves a new draft while the submitted question resolves", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);

    const input = screen.getByPlaceholderText(/ask a custom question/i);
    fireEvent.change(input, { target: { value: "Question A" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1));
    expect(input).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /meeting summary/i })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Question B" } });

    await act(async () => {
      pending.resolve({
        query: "Question A",
        response: "Answer A",
        citations: [],
        model: "test-model",
        processingTimeMs: 10,
        grounded: false,
      });
    });

    expect((await screen.findAllByText("Answer A")).length).toBeGreaterThan(0);
    expect(screen.getByText("Question A")).toBeInTheDocument();
    expect(input).toHaveValue("Question B");
  });

  it("preserves the current draft when the submitted question fails", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);

    const input = screen.getByPlaceholderText(/ask a custom question/i);
    fireEvent.change(input, { target: { value: "Question A" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "Question B" } });
    await act(async () => {
      pending.reject(new Error("Analysis failed for Question A"));
    });

    expect(await screen.findByText("Analysis failed for Question A")).toBeInTheDocument();
    expect(input).toHaveValue("Question B");
  });

  it("clears an unchanged draft after its answer succeeds", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);

    const input = screen.getByPlaceholderText(/ask a custom question/i);
    fireEvent.change(input, { target: { value: "Question A" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await act(async () => {
      pending.resolve({
        query: "Question A",
        response: "Answer A",
        citations: [],
        model: "test-model",
        processingTimeMs: 10,
        grounded: false,
      });
    });

    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("does not submit twice when Enter is pressed again during a request", async () => {
    const pending = deferred<any>();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);
    render(<AiAnalysisPanel recordingId="r1" />);

    const input = screen.getByPlaceholderText(/ask a custom question/i);
    fireEvent.change(input, { target: { value: "Question A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(backendMocks.analyzeRecording).toHaveBeenCalledTimes(1));
    expect(input).not.toBeDisabled();

    await act(async () => {
      pending.resolve({
        query: "Question A",
        response: "Answer A",
        citations: [],
        model: "test-model",
        processingTimeMs: 10,
        grounded: false,
      });
    });
  });

  it("ignores stale analysis responses after the recording changes", async () => {
    const pending = deferred<{
      query: string;
      response: string;
      citations: Array<{
        text: string;
        startTime: number;
        endTime: number;
        recordingId: string;
        certainty: number;
      }>;
      actualProvider: string;
      model: string;
      processingTimeMs: number;
    }>();
    const onChatMessagesChange = vi.fn();
    backendMocks.analyzeRecording.mockReturnValueOnce(pending.promise);

    const { rerender } = render(
      <AiAnalysisPanel
        recordingId="r1"
        chatMessages={[]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/ask a custom question/i), {
      target: { value: "What slipped?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    rerender(
      <AiAnalysisPanel
        recordingId="r2"
        chatMessages={[]}
        onChatMessagesChange={onChatMessagesChange}
      />
    );

    pending.resolve({
      query: "what slipped",
      response: "Stale response",
      citations: [],
      actualProvider: "ollama",
      model: "test-model",
      processingTimeMs: 500,
    });

    await waitFor(() => {
      expect(backendMocks.analyzeRecording).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("What slipped?"),
        undefined,
        expect.any(String)
      );
    });

    expect(onChatMessagesChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
  });
});
