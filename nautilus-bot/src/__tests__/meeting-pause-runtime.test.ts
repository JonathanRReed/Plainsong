import { describe, expect, it } from "vitest";
import {
  formatElapsedClock,
  INITIAL_MEETING_LIFECYCLE_STATE,
  meetingCaptureRestarted,
  meetingElapsedSeconds,
  reduceMeetingLifecycleState,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";

const START = 1_000_000;

function recording(overrides: Partial<MeetingLifecycleState> = {}): MeetingLifecycleState {
  return {
    ...INITIAL_MEETING_LIFECYCLE_STATE,
    phase: "recording",
    recordingId: "rec-1",
    startedAtMs: START,
    ...overrides,
  };
}

describe("pause fields in the meeting lifecycle reducer", () => {
  it("applies a pause event without restarting capture, and a resume carries the total", () => {
    const live = recording();
    const paused = reduceMeetingLifecycleState(live, {
      phase: "recording",
      recordingId: "rec-1",
      paused: true,
      closedPausedMs: 0,
      pauseStartedAtMs: START + 60_000,
    });
    expect(paused.paused).toBe(true);
    expect(paused.pauseStartedAtMs).toBe(START + 60_000);
    expect(paused.closedPausedMs).toBe(0);
    // Same meeting, same phase: the clock keeps its start.
    expect(paused.startedAtMs).toBe(START);
    expect(meetingCaptureRestarted(live, paused)).toBe(false);

    const resumed = reduceMeetingLifecycleState(paused, {
      phase: "recording",
      recordingId: "rec-1",
      paused: false,
      closedPausedMs: 130_000,
      pauseStartedAtMs: null,
    });
    expect(resumed.paused).toBe(false);
    expect(resumed.pauseStartedAtMs).toBeNull();
    expect(resumed.closedPausedMs).toBe(130_000);
  });

  it("keeps the pause across a mid-meeting warning that carries no pause fields", () => {
    const paused = recording({ paused: true, pauseStartedAtMs: START + 5_000, closedPausedMs: 9_000 });
    const warned = reduceMeetingLifecycleState(paused, {
      phase: "recording",
      recordingId: "rec-1",
      message: "This disk is nearly full",
    });
    expect(warned.paused).toBe(true);
    expect(warned.pauseStartedAtMs).toBe(START + 5_000);
    expect(warned.closedPausedMs).toBe(9_000);
    expect(warned.message).toBe("This disk is nearly full");
  });

  it("clears the pause when capture ends and when a different meeting starts", () => {
    const paused = recording({ paused: true, pauseStartedAtMs: START + 5_000, closedPausedMs: 9_000 });
    const stopping = reduceMeetingLifecycleState(paused, {
      phase: "stopping",
      recordingId: "rec-1",
    });
    expect(stopping.paused).toBe(false);
    expect(stopping.closedPausedMs).toBe(0);
    expect(stopping.pauseStartedAtMs).toBeNull();

    const next = reduceMeetingLifecycleState(
      { ...INITIAL_MEETING_LIFECYCLE_STATE, phase: "ready", recordingId: "rec-1", paused: true },
      { phase: "recording", recordingId: "rec-2", startedAtMs: START + 100 },
    );
    expect(next.paused).toBe(false);
    expect(next.closedPausedMs).toBe(0);
  });

  it("hydrates a paused meeting from the overlay snapshot", () => {
    const hydrated = reduceMeetingLifecycleState(INITIAL_MEETING_LIFECYCLE_STATE, {
      phase: "recording",
      recordingId: "rec-1",
      startedAtMs: START,
      paused: true,
      closedPausedMs: 4_000,
      pauseStartedAtMs: START + 30_000,
    });
    expect(hydrated.paused).toBe(true);
    expect(hydrated.closedPausedMs).toBe(4_000);
    expect(hydrated.pauseStartedAtMs).toBe(START + 30_000);
  });
});

describe("meetingElapsedSeconds", () => {
  it("counts wall clock minus finished pauses, and freezes while paused", () => {
    expect(meetingElapsedSeconds(recording(), START + 90_500)).toBe(90);
    expect(
      meetingElapsedSeconds(recording({ closedPausedMs: 30_000 }), START + 90_500),
    ).toBe(60);

    const paused = recording({
      closedPausedMs: 30_000,
      paused: true,
      pauseStartedAtMs: START + 80_000,
    });
    // 50 s of real capture before the pause; the clock does not move after.
    expect(meetingElapsedSeconds(paused, START + 90_000)).toBe(50);
    expect(meetingElapsedSeconds(paused, START + 900_000)).toBe(50);
  });

  it("never goes negative and treats an unknown start as zero", () => {
    expect(meetingElapsedSeconds(recording({ closedPausedMs: 999_999 }), START + 1)).toBe(0);
    expect(meetingElapsedSeconds(recording({ startedAtMs: null }), START + 5_000)).toBe(0);
    // Paused without a start stamp: frozen at what it had.
    expect(
      meetingElapsedSeconds(
        recording({ paused: true, pauseStartedAtMs: null }),
        START + 45_000,
      ),
    ).toBe(45);
  });

  it("formats the clock the way the readouts show it", () => {
    expect(formatElapsedClock(0)).toBe("00:00");
    expect(formatElapsedClock(65)).toBe("01:05");
    expect(formatElapsedClock(3_725)).toBe("1:02:05");
    expect(formatElapsedClock(-3)).toBe("00:00");
  });
});
