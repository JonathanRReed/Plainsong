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

describe("AiAnalysisPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventMocks.listeners.clear();
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading transcript chunk 2 of 5"
    );

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
