import { describe, expect, it } from "vitest";
import { formatMeetingStartError } from "@/lib/meeting-start-error";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
  meetingCaptureRestarted,
  reduceMeetingLifecycleState,
} from "@/features/meetings/runtime";

describe("formatMeetingStartError", () => {
  it("keeps automatic microphone recovery guidance focused on retrying", () => {
    const message =
      "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment, then reconnect or choose another microphone if it happens again.";

    expect(formatMeetingStartError(new Error(message))).toBe(message);
  });

  it("adds permission guidance for ordinary microphone failures", () => {
    expect(formatMeetingStartError("No microphone input device available")).toBe(
      "No microphone input device available. Please check your microphone permissions in System Settings."
    );
  });
});

describe("meeting lifecycle reconciliation", () => {
  it("keeps one Rust-owned identifier through Stop and processing", () => {
    const recording = reduceMeetingLifecycleState(
      INITIAL_MEETING_LIFECYCLE_STATE,
      { phase: "recording", recordingId: "meeting-1", startedAtMs: 100 },
    );
    const stopping = reduceMeetingLifecycleState(recording, {
      phase: "stopping",
      recordingId: "meeting-1",
    });
    const processing = reduceMeetingLifecycleState(stopping, {
      phase: "processing",
      recordingId: "meeting-1",
    });

    expect(processing).toMatchObject({
      phase: "processing",
      recordingId: "meeting-1",
      startedAtMs: 100,
    });
  });

  it("retains terminal errors and recovery text until the user acts", () => {
    const failed = reduceMeetingLifecycleState(
      {
        ...INITIAL_MEETING_LIFECYCLE_STATE,
        phase: "processing",
        recordingId: "meeting-1",
      },
      {
        phase: "recoverable",
        recordingId: "meeting-1",
        message: "Saved audio can be recovered after relaunch.",
      },
    );

    expect(failed).toMatchObject({
      phase: "recoverable",
      recordingId: "meeting-1",
      message: "Saved audio can be recovered after relaunch.",
    });
    expect(
      reduceMeetingLifecycleState(failed, { phase: "idle" }),
    ).toEqual(failed);
  });

  it("ignores a replayed terminal event from an older meeting", () => {
    const live = {
      ...INITIAL_MEETING_LIFECYCLE_STATE,
      phase: "recording" as const,
      recordingId: "meeting-2",
    };

    expect(
      reduceMeetingLifecycleState(live, {
        phase: "ready",
        recordingId: "meeting-1",
      }),
    ).toEqual(live);
  });

  it("does not let a different active identifier replace a live meeting", () => {
    const live = {
      ...INITIAL_MEETING_LIFECYCLE_STATE,
      phase: "recording" as const,
      recordingId: "meeting-live",
      startedAtMs: 100,
    };

    expect(
      reduceMeetingLifecycleState(live, {
        phase: "recording",
        recordingId: "meeting-reconnect",
        startedAtMs: 200,
      }),
    ).toEqual(live);
  });

  it("normalizes the legacy transcribing phase to processing", () => {
    expect(
      reduceMeetingLifecycleState(INITIAL_MEETING_LIFECYCLE_STATE, {
        phase: "transcribing",
        recordingId: "meeting-1",
      }),
    ).toMatchObject({ phase: "processing", recordingId: "meeting-1" });
  });

  it("carries a mid-meeting warning without disturbing the live capture", () => {
    const live = reduceMeetingLifecycleState(INITIAL_MEETING_LIFECYCLE_STATE, {
      phase: "recording",
      recordingId: "meeting-1",
      startedAtMs: 100,
      systemAudioActive: true,
      consentPromptShown: true,
    });

    // The sidecar re-emits `recording` with only a message when a WAV writer
    // dies or the disk starts filling.
    const warned = reduceMeetingLifecycleState(live, {
      phase: "recording",
      recordingId: "meeting-1",
      message: "This disk is nearly full (120 MB free).",
    });

    expect(warned).toMatchObject({
      phase: "recording",
      recordingId: "meeting-1",
      message: "This disk is nearly full (120 MB free).",
      startedAtMs: 100,
      systemAudioActive: true,
      consentPromptShown: true,
    });
  });
});

describe("meetingCaptureRestarted", () => {
  const live = {
    ...INITIAL_MEETING_LIFECYCLE_STATE,
    phase: "recording" as const,
    recordingId: "meeting-1",
    startedAtMs: 100,
  };

  it("is true when a meeting actually enters capture", () => {
    expect(
      meetingCaptureRestarted(INITIAL_MEETING_LIFECYCLE_STATE, live),
    ).toBe(true);
    expect(
      meetingCaptureRestarted(
        { ...INITIAL_MEETING_LIFECYCLE_STATE, phase: "preparing" },
        live,
      ),
    ).toBe(true);
  });

  it("is false for a repeated recording event on the same meeting", () => {
    // The regression this guards: consumers reset the transcript preview, the
    // lost-audio counter, the visible source warning and the elapsed timer when
    // capture starts. A warning that rides in on a `recording` event would
    // erase the very warning it came to deliver.
    const warned = reduceMeetingLifecycleState(live, {
      phase: "recording",
      recordingId: "meeting-1",
      message: "Plainsong stopped being able to save this meeting's audio.",
    });

    expect(meetingCaptureRestarted(live, warned)).toBe(false);
  });

  it("is true when a different meeting takes over", () => {
    const other = { ...live, recordingId: "meeting-2" };
    expect(meetingCaptureRestarted(live, other)).toBe(true);
  });

  it("is false for every phase that is not capture", () => {
    for (const phase of ["stopping", "processing", "ready", "error"] as const) {
      expect(meetingCaptureRestarted(live, { ...live, phase })).toBe(false);
    }
  });
});
