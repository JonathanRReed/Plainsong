import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";

const tauriMocks = vi.hoisted(() => ({
  analyzeRecording: vi.fn(),
  extractActionItems: vi.fn(),
  extractActionItemsGrounded: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  analyzeRecording: tauriMocks.analyzeRecording,
  extractActionItems: tauriMocks.extractActionItems,
  extractActionItemsGrounded: tauriMocks.extractActionItemsGrounded,
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
    tauriMocks.analyzeRecording.mockResolvedValue({
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
      model: "test-model",
      processingTimeMs: 950,
    });
    tauriMocks.extractActionItems.mockResolvedValue([]);
    tauriMocks.extractActionItemsGrounded.mockResolvedValue({
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
      model: "test-model",
      processingTimeMs: 1100,
    });
  });

  it("runs grounded action item extraction when requested", async () => {
    render(<AiAnalysisPanel recordingId="r1" analysisMode="grounded" />);

    fireEvent.click(screen.getByRole("button", { name: /action items/i }));

    await waitFor(() => {
      expect(tauriMocks.extractActionItemsGrounded).toHaveBeenCalledWith("r1");
    });

    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Jon will ship the release this Friday/).length
    ).toBeGreaterThan(0);
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
      expect(tauriMocks.analyzeRecording).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("Conversation so far:")
      );
    });
    await waitFor(() => {
      expect(onChatMessagesChange).toHaveBeenCalled();
    });
    expect(screen.getAllByText(/What slipped\?/i).length).toBeGreaterThan(0);
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
      model: string;
      processingTimeMs: number;
    }>();
    const onChatMessagesChange = vi.fn();
    tauriMocks.analyzeRecording.mockReturnValueOnce(pending.promise);

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
      model: "test-model",
      processingTimeMs: 500,
    });

    await waitFor(() => {
      expect(tauriMocks.analyzeRecording).toHaveBeenCalledWith(
        "r1",
        expect.stringContaining("What slipped?")
      );
    });

    expect(onChatMessagesChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
  });
});
