import { describe, expect, it } from "vitest";
import {
  appendTranscriptStreamLine,
  describeAudioSourceWarning,
  describeTranscriptDelay,
  describeTranscriptGap,
  type RecordingTranscriptionStreamEvent,
  type TranscriptStreamLine,
} from "@/lib/meeting-transcript-stream";

function segment(
  overrides: Partial<RecordingTranscriptionStreamEvent> = {}
): RecordingTranscriptionStreamEvent {
  return {
    recordingId: "r1",
    isPartial: true,
    isFinal: false,
    text: "we should ship the parity push",
    segmentText: "we should ship the parity push",
    startTime: 0,
    endTime: 5,
    confidence: 0.9,
    kind: "speech",
    delayedPreview: true,
    lagSeconds: 4,
    ...overrides,
  };
}

describe("appendTranscriptStreamLine", () => {
  it("keeps every segment, each stamped with its own start time", () => {
    let lines: TranscriptStreamLine[] = [];
    for (const event of [
      segment({ segmentText: "first thing", startTime: 0, endTime: 5 }),
      segment({ segmentText: "second thing", startTime: 5, endTime: 10 }),
      segment({ segmentText: "third thing", startTime: 10, endTime: 15 }),
    ]) {
      lines = appendTranscriptStreamLine(lines, event);
    }

    expect(lines.map((line) => line.text)).toEqual([
      "first thing",
      "second thing",
      "third thing",
    ]);
    expect(lines.map((line) => line.startTime)).toEqual([0, 5, 10]);
  });

  it("does not push a blank line for the closing marker", () => {
    const lines = appendTranscriptStreamLine(
      [],
      segment({ segmentText: "", isPartial: false, isFinal: true })
    );

    expect(lines).toEqual([]);
  });

  it("carries a lost span through as a gap rather than as speech", () => {
    const lines = appendTranscriptStreamLine(
      [],
      segment({
        kind: "gap",
        segmentText: "[12s not transcribed: the live preview fell behind]",
        startTime: 60,
        endTime: 72,
      })
    );

    expect(lines[0].kind).toBe("gap");
    expect(describeTranscriptGap(lines[0])).toBe(
      "12s of audio was overwritten before it could be read"
    );
  });
});

describe("describeTranscriptDelay", () => {
  it("never calls a trailing preview a live transcript", () => {
    const delayed = describeTranscriptDelay({ delayedPreview: true, lagSeconds: 6 });

    expect(delayed.delayed).toBe(true);
    expect(delayed.label).toBe("Delayed preview");
    expect(delayed.label.toLowerCase()).not.toContain("live");
    expect(delayed.caption).toContain("6s behind the speaker");
    // The caption has to disclaim liveness outright, not merely avoid the word:
    // a trailing preview presented without qualification reads as a live one.
    expect(delayed.caption).toContain("not a live caption");
  });

  it("still states the delay when the lag rounds to nothing", () => {
    const delayed = describeTranscriptDelay({ delayedPreview: true, lagSeconds: 0.2 });

    expect(delayed.caption).toContain("not a live caption");
  });

  it("falls back to a plain preview label before any segment arrives", () => {
    const initial = describeTranscriptDelay(null);

    expect(initial.delayed).toBe(false);
    expect(initial.label).toBe("Transcript preview");
  });
});

describe("describeAudioSourceWarning", () => {
  it("names the source that went quiet and what it costs", () => {
    const warning = describeAudioSourceWarning({
      recordingId: "r1",
      source: "system",
      reason: "silence",
      silentSeconds: 30,
    });

    expect(warning.title).toBe("System audio has gone silent");
    expect(warning.message).toContain("for 30s");
    expect(warning.message).toContain("not being recorded");
  });

  it("labels a silent microphone as the microphone", () => {
    const warning = describeAudioSourceWarning({
      recordingId: "r1",
      source: "mic",
      reason: "silence",
      silentSeconds: 12,
    });

    expect(warning.title).toBe("Microphone has gone silent");
  });
});
