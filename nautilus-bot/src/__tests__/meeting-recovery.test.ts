import { describe, expect, it } from "vitest";
import {
  canRecheckMeetingAudio,
  describeCaptureDegradation,
  describeIncompleteTranscript,
  readMeetingIntegrity,
  transcriptIsIncomplete,
} from "@/lib/meeting-recovery";
import type { Recording } from "@/types";

function recording(extra: Record<string, unknown> = {}): Recording {
  return {
    id: "r1",
    title: "Weekly sync",
    projectId: "default",
    duration: 120,
    createdAt: "2026-03-06T12:00:00Z",
    updatedAt: "2026-03-06T12:00:00Z",
    sourceType: "meeting",
    audioPath: "/tmp/weekly.wav",
    status: "completed",
    ...extra,
  } as unknown as Recording;
}

describe("readMeetingIntegrity", () => {
  it("reads the camelCase fields the recordings JSON uses", () => {
    expect(
      readMeetingIntegrity(
        recording({
          transcriptComplete: false,
          transcriptDegradedReason: "2 of 10 chunks failed.",
          transcriptIncompleteAcknowledgedAt: "2026-03-07T09:00:00Z",
          captureDegradedSummary: "System audio was silent for 240s.",
        }),
      ),
    ).toEqual({
      transcriptComplete: false,
      degradedReason: "2 of 10 chunks failed.",
      acknowledgedAt: "2026-03-07T09:00:00Z",
      captureDegradedSummary: "System audio was silent for 240s.",
    });
  });

  it("survives snake_case and SQLite integers", () => {
    const integrity = readMeetingIntegrity(
      recording({
        transcript_complete: 0,
        transcript_degraded_reason: "chunks failed",
      }),
    );

    expect(integrity.transcriptComplete).toBe(false);
    expect(integrity.degradedReason).toBe("chunks failed");
  });

  it("makes no claim when the fields are absent", () => {
    // A sidecar predating these fields must not be read as "complete".
    const integrity = readMeetingIntegrity(recording());

    expect(integrity.transcriptComplete).toBeNull();
    expect(transcriptIsIncomplete(integrity)).toBe(false);
    expect(describeIncompleteTranscript(integrity)).toBeNull();
    expect(describeCaptureDegradation(integrity)).toBeNull();
  });
});

describe("describeIncompleteTranscript", () => {
  it("says the audio is being held back, and why", () => {
    const notice = describeIncompleteTranscript(
      readMeetingIntegrity(
        recording({
          transcriptComplete: false,
          transcriptDegradedReason:
            "2 of 10 transcription chunk(s) failed; transcript may be incomplete.",
        }),
      ),
    );

    expect(notice?.title).toBe(
      "Transcript incomplete — audio kept for re-transcription",
    );
    expect(notice?.audioHeld).toBe(true);
    expect(notice?.message).toContain("2 of 10");
    expect(notice?.message).toMatch(/only complete record/i);
  });

  it("changes what it promises once the reader has acknowledged", () => {
    const notice = describeIncompleteTranscript(
      readMeetingIntegrity(
        recording({
          transcriptComplete: false,
          transcriptDegradedReason: "Chunks failed.",
          transcriptIncompleteAcknowledgedAt: "2026-03-07T09:00:00Z",
        }),
      ),
    );

    expect(notice?.audioHeld).toBe(false);
    expect(notice?.message).toMatch(/cleanup may now delete/i);
    // Acknowledging never claims the transcript became complete.
    expect(notice?.title).toMatch(/incomplete/i);
  });

  it("still says something useful with no recorded reason", () => {
    const notice = describeIncompleteTranscript(
      readMeetingIntegrity(recording({ transcriptComplete: false })),
    );

    expect(notice?.message).toMatch(/never transcribed/i);
  });
});

describe("describeCaptureDegradation", () => {
  it("names which sources went quiet and for how long", () => {
    const caveat = describeCaptureDegradation(
      readMeetingIntegrity(
        recording({
          captureDegradedSummary: "System audio recorded nothing for 240s.",
        }),
      ),
    );

    expect(caveat?.message).toContain("240s");
    expect(caveat?.message).toMatch(/not in the recording or the transcript/i);
  });
});

describe("canRecheckMeetingAudio", () => {
  const withIntegrity = (extra: Record<string, unknown> = {}) => {
    const value = recording(extra);
    return canRecheckMeetingAudio(value, readMeetingIntegrity(value));
  };

  it("is offered for the states a condemned asset produces", () => {
    expect(withIntegrity({ status: "error" })).toBe(true);
    expect(withIntegrity({ transcriptComplete: false })).toBe(true);
    // A finalization that failed before the duration was written.
    expect(withIntegrity({ duration: 0 })).toBe(true);
  });

  it("is not offered where the sidecar would refuse it", () => {
    expect(withIntegrity({ status: "recording" })).toBe(false);
    expect(withIntegrity({ status: "processing", duration: 0 })).toBe(false);
    expect(withIntegrity({ status: "error", audioPath: "" })).toBe(false);
    expect(canRecheckMeetingAudio(null, readMeetingIntegrity(null))).toBe(false);
  });

  it("is not offered for a healthy meeting", () => {
    expect(withIntegrity()).toBe(false);
  });
});
