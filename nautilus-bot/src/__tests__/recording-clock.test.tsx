import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingClock, formatRecordingClock } from "@/hooks/recording-clock";

const overlayState = {
  phase: "recording",
  recordingId: "meeting-1",
  startedAtMs: 0,
  systemAudioActive: true,
};

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "get_recording_overlay_state" ? overlayState : { phase: "idle" },
  ),
  listen: vi.fn(async () => () => {}),
}));

import {
  RecordingDurationText,
  RecordingProvider,
  useRecording,
  useRecordingSession,
} from "@/hooks/use-recording";

describe("recording clock store", () => {
  it("notifies only on a changed value", () => {
    const clock = createRecordingClock();
    const listener = vi.fn();
    const unsubscribe = clock.subscribe(listener);
    clock.set(0);
    expect(listener).not.toHaveBeenCalled();
    clock.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.get()).toBe(3);
    unsubscribe();
    clock.set(4);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("formats as mm:ss", () => {
    expect(formatRecordingClock(0)).toBe("00:00");
    expect(formatRecordingClock(125)).toBe("02:05");
  });
});

describe("RecordingProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    overlayState.startedAtMs = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks the clock without re-rendering session consumers", async () => {
    let sessionRenders = 0;
    let legacyRenders = 0;
    function SessionConsumer() {
      const { recordingId } = useRecordingSession();
      sessionRenders += 1;
      return <span data-testid="session">{recordingId ?? "none"}</span>;
    }
    function LegacyConsumer() {
      const { formattedDuration } = useRecording();
      legacyRenders += 1;
      return <span data-testid="legacy">{formattedDuration}</span>;
    }

    render(
      <RecordingProvider>
        <SessionConsumer />
        <LegacyConsumer />
        <span data-testid="clock">
          <RecordingDurationText />
        </span>
      </RecordingProvider>,
    );

    // Let the overlay-state hydration land and the meeting start.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("session")).toHaveTextContent("meeting-1");
    const sessionRendersAtStart = sessionRenders;
    const legacyRendersAtStart = legacyRenders;

    await act(async () => {
      // Long enough for the 2.5 s overlay poll to repeat the same snapshot,
      // which must not count as a change either.
      vi.advanceTimersByTime(6_000);
    });

    expect(screen.getByTestId("clock")).toHaveTextContent("00:06");
    // The old API keeps working, re-rendering its caller as before.
    expect(screen.getByTestId("legacy")).toHaveTextContent("00:06");
    expect(legacyRenders).toBeGreaterThan(legacyRendersAtStart);
    expect(sessionRenders).toBe(sessionRendersAtStart);
  });
});
