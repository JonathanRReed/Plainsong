import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: electronMocks.invoke,
  listen: vi.fn(),
}));

import {
  cancelAnalysisRun,
  editTranscriptSpeakerTurn,
  exportWithTemplate,
  extractActionItemsGrounded,
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
      "Corrected whole speaker turn."
    );

    expect(electronMocks.invoke).toHaveBeenCalledTimes(1);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "edit_transcript_speaker_turn",
      {
        recordingId: "r1",
        segmentIds: ["s1", "s2"],
        newText: "Corrected whole speaker turn.",
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
