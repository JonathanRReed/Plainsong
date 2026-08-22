import { describe, expect, it } from "vitest";
import { formatMeetingStartError } from "@/lib/meeting-start-error";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
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
});
