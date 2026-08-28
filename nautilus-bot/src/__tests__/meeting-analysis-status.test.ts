import { describe, expect, it } from "vitest";
import {
  describeMeetingAnalysis,
  parseMeetingAnalysisStatus,
  readStoredAnalysisFailure,
} from "@/lib/meeting-analysis-status";
import type { Recording } from "@/types";

function recording(extra: Record<string, unknown> = {}): Recording {
  return { id: "r1", ...extra } as unknown as Recording;
}

describe("parseMeetingAnalysisStatus", () => {
  it("reads the contract's three phases", () => {
    for (const phase of ["running", "failed", "completed"] as const) {
      expect(
        parseMeetingAnalysisStatus({ recordingId: "r1", phase }),
      ).toEqual({ recordingId: "r1", phase, error: null });
    }
  });

  it("keeps the reason when one is sent", () => {
    expect(
      parseMeetingAnalysisStatus({
        recordingId: "r1",
        phase: "failed",
        error: "  Ollama refused the connection.  ",
      }),
    ).toEqual({
      recordingId: "r1",
      phase: "failed",
      error: "Ollama refused the connection.",
    });
  });

  it("discards a payload that is not the promised shape", () => {
    expect(parseMeetingAnalysisStatus(null)).toBeNull();
    expect(parseMeetingAnalysisStatus("failed")).toBeNull();
    expect(parseMeetingAnalysisStatus({ phase: "failed" })).toBeNull();
    expect(parseMeetingAnalysisStatus({ recordingId: "r1" })).toBeNull();
    expect(
      parseMeetingAnalysisStatus({ recordingId: "r1", phase: "queued" }),
    ).toBeNull();
  });
});

describe("readStoredAnalysisFailure", () => {
  it("reads the field the sidecar serializes", () => {
    expect(
      readStoredAnalysisFailure(recording({ analysisError: "No AI route." })),
    ).toBe("No AI route.");
  });

  it("survives a differently spelled or structured field", () => {
    expect(
      readStoredAnalysisFailure(recording({ analysis_error: "No AI route." })),
    ).toBe("No AI route.");
    expect(
      readStoredAnalysisFailure(
        recording({ analysisFailure: { message: "No AI route." } }),
      ),
    ).toBe("No AI route.");
  });

  it("stays silent when the field is absent or empty", () => {
    // A build whose sidecar half has not landed must degrade to today's
    // behaviour, not render a failure it cannot substantiate.
    expect(readStoredAnalysisFailure(recording())).toBeNull();
    expect(readStoredAnalysisFailure(recording({ analysisError: "  " }))).toBeNull();
    expect(readStoredAnalysisFailure(null)).toBeNull();
  });
});

describe("describeMeetingAnalysis", () => {
  it("says nothing when nothing failed", () => {
    expect(
      describeMeetingAnalysis({
        storedFailure: null,
        livePhase: null,
        liveError: null,
      }),
    ).toBeNull();
  });

  it("lets a running retry outrank the failure it is clearing", () => {
    const notice = describeMeetingAnalysis({
      storedFailure: "No AI route.",
      livePhase: "running",
      liveError: null,
    });

    expect(notice?.busy).toBe(true);
    expect(notice?.retryable).toBe(false);
  });

  it("clears the stored failure once a run completes", () => {
    expect(
      describeMeetingAnalysis({
        storedFailure: "No AI route.",
        livePhase: "completed",
        liveError: null,
      }),
    ).toBeNull();
  });

  it("prefers this session's reason over the stored one", () => {
    expect(
      describeMeetingAnalysis({
        storedFailure: "An older reason.",
        livePhase: "failed",
        liveError: "Ollama refused the connection.",
      })?.message,
    ).toBe("Ollama refused the connection.");
  });

  it("admits when a failure was recorded without a reason", () => {
    expect(
      describeMeetingAnalysis({
        storedFailure: null,
        livePhase: "failed",
        liveError: null,
      })?.message,
    ).toBe("The summary and action items failed and no reason was recorded.");
  });
});
