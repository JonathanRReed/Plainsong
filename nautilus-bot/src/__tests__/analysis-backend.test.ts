import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: electronMocks.invoke,
  listen: vi.fn(),
}));

import {
  askMemory,
  cancelAnalysisRun,
  editTranscriptSpeakerTurn,
  deleteTranscriptSegments,
  exportWithTemplate,
  extractActionItemsGrounded,
  searchTranscripts,
  updateRecordingAnalysis,
} from "@/lib/backend";

describe("analysis backend commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends field-level analysis patches without synthesizing missing fields", async () => {
    electronMocks.invoke.mockResolvedValue({
      id: "r1",
      summary: "Saved summary",
      actionItems: ["Existing action"],
    });
    const summaryProvenance = {
      version: 1,
      contentHash: "v1:sha256:summary",
      actualProvider: "ollama",
      actualModel: "llama3.2",
      promptSource: "meeting_playbook:auto",
      completedAt: "2026-07-25T12:00:00.000Z",
      citations: [],
      grounded: true,
    };

    await updateRecordingAnalysis("r1", {
      summary: "Saved summary",
      summaryProvenance,
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "update_recording_analysis",
      {
        recordingId: "r1",
        summary: "Saved summary",
        summaryProvenance,
      }
    );
    expect(electronMocks.invoke.mock.calls[0]?.[1]).not.toHaveProperty(
      "actionItems"
    );
  });

  it("sends a grouped transcript edit as one atomic command", async () => {
    electronMocks.invoke.mockResolvedValue(undefined);

    await editTranscriptSpeakerTurn(
      "r1",
      ["s1", "s2"],
      "Corrected whole speaker turn.",
      [{ id: "s1", text: "First original.", startTime: 0, endTime: 1, speakerId: null }, { id: "s2", text: "Second original.", startTime: 1, endTime: 2, speakerId: null }]
    );

    expect(electronMocks.invoke).toHaveBeenCalledTimes(1);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "edit_transcript_speaker_turn",
      {
        recordingId: "r1",
        segmentIds: ["s1", "s2"],
        newText: "Corrected whole speaker turn.",
        expectedSegments: [{ id: "s1", text: "First original.", startTime: 0, endTime: 1, speakerId: null }, { id: "s2", text: "Second original.", startTime: 1, endTime: 2, speakerId: null }],
      }
    );
  });

  it("sends explicit analysis cancellation by run id", async () => {
    electronMocks.invoke.mockResolvedValue(undefined);

    await cancelAnalysisRun("run-1");

    expect(electronMocks.invoke).toHaveBeenCalledWith("cancel_analysis_run", {
      runId: "run-1",
    });
  });

  it("scopes memory recall to an analysis run when one is provided", async () => {
    electronMocks.invoke.mockResolvedValue({ response: "Scoped answer", citations: [] });

    await askMemory("What changed?", {
      excludeRecordingId: "r1",
      sourceType: "meeting",
      runId: "recall-run-1",
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith("ask_memory", {
      query: "What changed?",
      excludeRecordingId: "r1",
      sourceType: "meeting",
      runId: "recall-run-1",
    });
  });

  it("keeps the unscoped memory recall payload unchanged", async () => {
    electronMocks.invoke.mockResolvedValue({ response: "Unscoped answer", citations: [] });

    await askMemory("What changed?", {
      excludeRecordingId: "r1",
      sourceType: "meeting",
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith("ask_memory", {
      query: "What changed?",
      excludeRecordingId: "r1",
      sourceType: "meeting",
    });
  });

  it("can request grounded action items as a non-persisting preview", async () => {
    electronMocks.invoke.mockResolvedValue({ items: [] });

    await extractActionItemsGrounded("r1", undefined, {
      persist: false,
      runId: "run-1",
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "extract_action_items_grounded",
      {
        recordingId: "r1",
        model: undefined,
        persist: false,
        runId: "run-1",
      }
    );
  });

  it("template export invokes only the deterministic export command", async () => {
    electronMocks.invoke.mockResolvedValue({
      templateId: "follow-up",
      preview: true,
      exportPath: null,
      content: "Saved summary",
    });

    await exportWithTemplate("r1", "follow-up", {
      preview: true,
      redactionLevel: "basic",
    });

    expect(electronMocks.invoke).toHaveBeenCalledTimes(1);
    expect(electronMocks.invoke).toHaveBeenCalledWith("export_with_template", {
      recordingId: "r1",
      templateId: "follow-up",
      target: undefined,
      preview: true,
      redactionLevel: "basic",
    });
  });
});

describe("transcript search wire contract", () => {
  beforeEach(() => electronMocks.invoke.mockReset());

  it("adds source type only when transcript search is scoped", async () => {
    electronMocks.invoke.mockResolvedValueOnce([]);

    await searchTranscripts("launch review", 25, undefined, "meeting");

    expect(electronMocks.invoke).toHaveBeenCalledWith("search_transcripts", {
      query: "launch review",
      limit: 25,
      projectIds: undefined,
      sourceType: "meeting",
    });
  });

  it("adds recording status when transcript search is status scoped", async () => {
    electronMocks.invoke.mockResolvedValueOnce([]);

    await searchTranscripts("launch review", 25, undefined, "meeting", "completed");

    expect(electronMocks.invoke).toHaveBeenCalledWith("search_transcripts", {
      query: "launch review",
      limit: 25,
      projectIds: undefined,
      sourceType: "meeting",
      recordingStatus: "completed",
    });
  });

  it("preserves the legacy transcript search payload when scope is omitted", async () => {
    electronMocks.invoke.mockResolvedValueOnce([]);

    await searchTranscripts("launch review", 25);

    expect(electronMocks.invoke).toHaveBeenCalledWith("search_transcripts", {
      query: "launch review",
      limit: 25,
      projectIds: undefined,
    });
    expect(electronMocks.invoke.mock.calls[0]?.[1]).not.toHaveProperty("sourceType");
    expect(electronMocks.invoke.mock.calls[0]?.[1]).not.toHaveProperty("recordingStatus");
  });
});


describe("guarded transcript deletion wire contract", () => {
  beforeEach(() => electronMocks.invoke.mockReset());

  it("sends the exact quoted metadata without normalizing words", async () => {
    const expectedSegments = [{ id: "s1", text: "  Do not ship.\nKeep this condition.  ", startTime: 1.25, endTime: 4.5, speakerId: null }];
    electronMocks.invoke.mockResolvedValueOnce(1);
    expect(await deleteTranscriptSegments("r1", ["s1"], expectedSegments)).toBe(1);
    expect(electronMocks.invoke.mock.calls[0][0]).toBe("delete_transcript_segments");
    expect(JSON.parse(JSON.stringify(electronMocks.invoke.mock.calls[0][1]))).toEqual({ recordingId: "r1", segmentIds: ["s1"], expectedSegments });
  });

  it("keeps an empty expectation array guarded rather than downgrading it", async () => {
    electronMocks.invoke.mockRejectedValueOnce(new Error("Transcript changed"));
    await expect(deleteTranscriptSegments("r1", ["s1"], [])).rejects.toThrow("Transcript changed");
    expect(electronMocks.invoke.mock.calls[0][1]).toEqual({ recordingId: "r1", segmentIds: ["s1"], expectedSegments: [] });
  });

  it("preserves the legacy payload when no expectations are supplied", async () => {
    electronMocks.invoke.mockResolvedValueOnce(1);
    await deleteTranscriptSegments("r1", ["s1"]);
    expect(electronMocks.invoke.mock.calls[0][1]).toEqual({ recordingId: "r1", segmentIds: ["s1"] });
  });
});
