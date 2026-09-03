import { describe, expect, it } from "vitest";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
  reduceMeetingLifecycleState,
  type MeetingLifecycleEvent,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";

/**
 * "Import audio…" hands its recording to the same post-capture pipeline a
 * stopped meeting uses, so the renderer's meeting state machine has to see the
 * same phases. It did not: the import emitted only `recording-status-changed`,
 * and the first `meeting-recording-state-changed` an import ever produced was
 * the pipeline's own terminal one — for a recording the machine had never
 * heard of.
 *
 * These are the two sequences the sidecar emits, replayed through the reducer.
 */
function replay(events: MeetingLifecycleEvent[]): MeetingLifecycleState {
  return events.reduce(reduceMeetingLifecycleState, INITIAL_MEETING_LIFECYCLE_STATE);
}

const STOP_SEQUENCE: MeetingLifecycleEvent[] = [
  { phase: "recording", recordingId: "rec-1", startedAtMs: 1_000 },
  { phase: "stopping", recordingId: "rec-1", message: "Stopping capture and saving audio" },
  { phase: "processing", recordingId: "rec-1", message: "Processing transcript" },
  { phase: "ready", recordingId: "rec-1", message: null },
];

const IMPORT_SEQUENCE: MeetingLifecycleEvent[] = [
  { phase: "processing", recordingId: "rec-1", message: "Processing transcript" },
  { phase: "ready", recordingId: "rec-1", message: null },
];

describe("an imported meeting's lifecycle phases", () => {
  it("puts the state machine in the same place a stopped meeting does", () => {
    const stopped = replay(STOP_SEQUENCE);
    const imported = replay(IMPORT_SEQUENCE);

    expect(imported.phase).toBe("ready");
    expect(imported.recordingId).toBe("rec-1");
    // Everything except the start stamp, which only a live capture has.
    expect({ ...imported, startedAtMs: null }).toEqual({
      ...stopped,
      startedAtMs: null,
    });
  });

  it("shows a processing phase for the import before the pipeline finishes", () => {
    const processing = replay(IMPORT_SEQUENCE.slice(0, 1));

    expect(processing.phase).toBe("processing");
    expect(processing.recordingId).toBe("rec-1");
    expect(processing.message).toBe("Processing transcript");
    // Processing is not capture: nothing may read this as a live meeting.
    expect(processing.paused).toBe(false);
  });

  it("without the processing phase the terminal event arrives out of nowhere", () => {
    // The old behaviour, kept as the regression this guards: the machine sat
    // at idle with no recording id until the pipeline's terminal phase, so
    // nothing in the app could show an import being worked on.
    const beforeTerminal = replay([]);
    expect(beforeTerminal.phase).toBe("idle");
    expect(beforeTerminal.recordingId).toBeNull();
    expect(replay(IMPORT_SEQUENCE.slice(0, 1)).phase).not.toBe("idle");
  });

  it("reports an import that failed vault encryption as an error, not as idle", () => {
    const failed = replay([
      {
        phase: "error",
        recordingId: "rec-1",
        message:
          "The audio was imported, but vault encryption must be retried before it can be transcribed: Vault locked before the finalized recording bundle could be encrypted",
      },
    ]);

    expect(failed.phase).toBe("error");
    expect(failed.recordingId).toBe("rec-1");
    expect(failed.message).toContain("vault encryption must be retried");
  });
});
