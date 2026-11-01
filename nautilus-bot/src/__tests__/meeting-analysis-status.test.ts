import { describe, expect, it } from "vitest";
import {
  MEMORY_WAIT_NOTICE,
  describeMeetingAnalysis,
  parseMeetingAnalysisStatus,
  readStoredAnalysisFailure,
} from "@/lib/meeting-analysis-status";
import type { Recording } from "@/types";

function recording(extra: Record<string, unknown> = {}): Recording {
  return { id: "r1", ...extra } as unknown as Recording;
}

describe("parseMeetingAnalysisStatus", () => {
  it("reads the contract's four phases", () => {
    for (const phase of ["running", "waiting", "failed", "completed"] as const) {
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

  it.each([
    "ollama Policy: An earlier Ollama request may still be running. Local processing is paused because its completion could not be confirmed. Restarting Plainsong or checking loaded models does not confirm it stopped.",
    "native_text Policy: Local processing is paused because Plainsong could not read or update its Ollama safety marker in the configuration directory.",
  ])("keeps a durable safety refusal visible without offering a retry", (reason) => {
    for (const live of [true, false]) {
      const notice = describeMeetingAnalysis({
        storedFailure: live ? null : reason,
        livePhase: live ? "failed" : null,
        liveError: live ? reason : null,
      });
      // The provider id prefix is the log's, not the reader's.
      expect(notice?.message).toBe(reason.replace(/^\w+ Policy: /, ""));
      expect(notice?.retryable).toBe(false);
    }
  });

  it.each([
    "native_text Policy: Not enough verified memory headroom for native text processing and other applications.",
    "Another local text operation is running. Try again after it finishes.",
    "Another Plainsong process is updating the Ollama safety marker. Try again after it finishes.",
    "Ollama refused the connection.",
  ])("allows another attempt after a recoverable condition changes", (reason) => {
    expect(describeMeetingAnalysis({
      storedFailure: reason,
      livePhase: null,
      liveError: null,
    })?.retryable).toBe(true);
  });

  it("does not show memory or model internals from a stored failure", () => {
    const notice = describeMeetingAnalysis({
      storedFailure:
        "summary: native_text Policy: Not enough verified memory headroom for native text processing and other applications.; action items: native_text Policy: Not enough verified memory headroom for native text processing and other applications.",
      livePhase: null,
      liveError: null,
    });
    expect(notice?.message).toBe(
      "There wasn't enough free memory to write the summary and action items. Close other large apps, then try again.",
    );
    expect(notice?.retryable).toBe(true);
  });

  it("names one cause once when both stages failed the same way", () => {
    const notice = describeMeetingAnalysis({
      storedFailure: "summary: Ollama refused the connection.; action items: Ollama refused the connection.",
      livePhase: null,
      liveError: null,
    });
    expect(notice?.message).toBe("Ollama refused the connection.");
  });

  it("says the summary failed, not the notes, when transcript quotes were saved", () => {
    const failure =
      "summary: native_text Policy: Not enough verified memory headroom for native text processing and other applications.";
    const quoted = describeMeetingAnalysis({
      storedFailure: failure,
      livePhase: null,
      liveError: null,
      summary: "Summary couldn't be written. These lines are quoted from the transcript.\n\n- [0:12] Ana: We ship Friday.",
    });
    expect(quoted?.title).toBe("Summary couldn't be written");
    expect(quoted?.message).toMatch(/Key lines from the transcript are saved/);
    expect(quoted?.retryable).toBe(true);
    const none = describeMeetingAnalysis({
      storedFailure: failure,
      livePhase: null,
      liveError: null,
      summary: "",
    });
    expect(none?.title).toBe("Meeting notes were not written");
  });

  it("does not say again for the first automatic pass", () => {
    const notice = describeMeetingAnalysis({ storedFailure: null, livePhase: "running", liveError: null });
    expect(notice?.message).not.toMatch(/again/);
  });

  it("says notes are waiting for memory and offers both stop and retry", () => {
    const notice = describeMeetingAnalysis({
      storedFailure: MEMORY_WAIT_NOTICE,
      livePhase: "waiting",
      liveError: MEMORY_WAIT_NOTICE,
    });
    expect(notice?.title).toBe("Notes will be written when you step away or memory frees up.");
    expect(notice?.waiting).toBe(true);
    expect(notice?.retryable).toBe(true);
    expect(notice?.busy).toBe(false);
  });

  it("keeps automatic retry and cancellation after a restart", () => {
    const notice = describeMeetingAnalysis({
      storedFailure: MEMORY_WAIT_NOTICE,
      livePhase: null,
      liveError: null,
    });
    expect(notice?.title).toBe("Notes will be written when you step away or memory frees up.");
    expect(notice?.waiting).toBe(true);
    expect(notice?.retryable).toBe(true);
  });
});
