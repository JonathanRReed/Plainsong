import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
  stopDictation: vi.fn<() => Promise<string>>(),
  stopRecording: vi.fn<(recordingId: string) => Promise<void>>(),
  startRecording: vi.fn<() => Promise<string>>(),
  pauseRecording: vi.fn<(recordingId: string) => Promise<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>>(),
  resumeRecording: vi.fn<(recordingId: string) => Promise<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>>(),
  dictationPoll: null as Promise<Record<string, unknown>> | null,
  meetingPoll: { phase: "idle" } as Record<string, unknown> | Promise<Record<string, unknown>>,
}));

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "get_dictation_overlay_state" && harness.dictationPoll
      ? harness.dictationPoll
      : command === "get_recording_overlay_state"
        ? harness.meetingPoll
      : { phase: "idle" },
  ),
  listen: vi.fn(async (
    name: string,
    listener: (event: { payload: Record<string, unknown> }) => void,
  ) => {
    harness.listeners.set(name, listener);
    return () => harness.listeners.delete(name);
  }),
}));

vi.mock("@/lib/backend/dictation", () => ({
  startDictation: vi.fn(),
  stopDictation: harness.stopDictation,
}));

vi.mock("@/lib/backend/recordings", () => ({
  pauseRecording: harness.pauseRecording,
  resumeRecording: harness.resumeRecording,
  startRecording: harness.startRecording,
  stopRecording: harness.stopRecording,
}));

import { RecordingProvider, useRecording } from "@/hooks/use-recording";

function wrapper({ children }: { children: ReactNode }) {
  return <RecordingProvider>{children}</RecordingProvider>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function emit(name: string, payload: Record<string, unknown>) {
  harness.listeners.get(name)?.({ payload });
}

describe("RecordingProvider stop ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    harness.listeners.clear();
    harness.stopDictation.mockReset();
    harness.stopRecording.mockReset();
    harness.startRecording.mockReset();
    harness.pauseRecording.mockReset();
    harness.resumeRecording.mockReset();
    harness.dictationPoll = null;
    harness.meetingPoll = { phase: "idle" };
  });

  describe("meeting stop recovery", () => {
    it("retains the live meeting and clock after rejection, then permits retry", async () => {
      harness.stopRecording
        .mockRejectedValueOnce(new Error("stop failed"))
        .mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-a",
          startedAtMs: Date.now() - 4_000,
        });
      });

      await act(async () => {
        const firstStop = result.current.stopMeeting();
        expect(result.current.stopMeeting()).toBe(firstStop);
        await expect(firstStop).rejects.toThrow("stop failed");
      });
      expect(harness.stopRecording).toHaveBeenCalledTimes(1);
      expect(result.current).toMatchObject({
        isRecording: true,
        recordingId: "meeting-a",
        meetingPhase: "recording",
      });
      expect(result.current.duration).toBe(4);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(5);

      await act(async () => { await result.current.stopMeeting(); });
      expect(harness.stopRecording).toHaveBeenCalledTimes(2);
      expect(harness.stopRecording).toHaveBeenLastCalledWith("meeting-a");
    });

    it("lets a terminal lifecycle event win over a late stop rejection", async () => {
      const pendingStop = deferred<void>();
      harness.stopRecording.mockReturnValueOnce(pendingStop.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-a",
          startedAtMs: Date.now() - 3_000,
        });
      });
      let stopPromise!: Promise<void>;
      act(() => { stopPromise = result.current.stopMeeting(); });

      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "ready",
          recordingId: "meeting-a",
        });
      });
      await act(async () => {
        pendingStop.reject(new Error("late stop failure"));
        await stopPromise.catch(() => undefined);
      });

      expect(result.current).toMatchObject({
        isRecording: false,
        recordingId: "meeting-a",
        meetingPhase: "ready",
      });
    });

    it("does not freeze meeting B when meeting A's stop resolves late", async () => {
      const pendingStop = deferred<void>();
      harness.stopRecording.mockReturnValueOnce(pendingStop.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-a",
          startedAtMs: Date.now() - 6_000,
        });
      });
      let stopPromise!: Promise<void>;
      act(() => { stopPromise = result.current.stopMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "ready",
          recordingId: "meeting-a",
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-b",
          startedAtMs: Date.now() - 2_000,
        });
      });

      await act(async () => {
        pendingStop.resolve(undefined);
        await stopPromise;
      });
      expect(result.current).toMatchObject({
        isRecording: true,
        recordingId: "meeting-b",
        meetingPhase: "recording",
      });
      expect(result.current.duration).toBe(2);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(3);
    });
  });

  describe("meeting pause ownership", () => {
    it.each([
      ["pause", true],
      ["resume", false],
    ] as const)("does not let a late %s acknowledgement revive a completed meeting", async (_action, paused) => {
      const pending = deferred<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>();
      (paused ? harness.pauseRecording : harness.resumeRecording).mockReturnValueOnce(pending.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 3_000,
          paused: !paused, closedPausedMs: 0, pauseStartedAtMs: null,
        });
      });
      let request!: Promise<void>;
      act(() => { request = paused ? result.current.pauseMeeting() : result.current.resumeMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", { phase: "ready", recordingId: "meeting-a" });
      });
      await act(async () => {
        pending.resolve({ paused, closedPausedMs: 0, pauseStartedAtMs: paused ? Date.now() : null });
        await request;
      });

      expect(result.current).toMatchObject({
        isRecording: false,
        recordingId: "meeting-a",
        meetingPhase: "ready",
      });
    });

    it("does not let meeting A's late pause acknowledgement alter meeting B", async () => {
      const pending = deferred<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>();
      harness.pauseRecording.mockReturnValueOnce(pending.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 4_000,
        });
      });
      let request!: Promise<void>;
      act(() => { request = result.current.pauseMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", { phase: "ready", recordingId: "meeting-a" });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-b", startedAtMs: Date.now() - 1_000,
          paused: false,
        });
      });
      await act(async () => {
        pending.resolve({ paused: true, closedPausedMs: 0, pauseStartedAtMs: Date.now() });
        await request;
      });

      expect(result.current).toMatchObject({
        isRecording: true,
        recordingId: "meeting-b",
        meetingPaused: false,
      });
    });

    it("does not let an old pause acknowledgement undo a newer resumed event", async () => {
      const pending = deferred<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>();
      harness.pauseRecording.mockReturnValueOnce(pending.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 4_000,
          paused: false,
        });
      });
      let request!: Promise<void>;
      act(() => { request = result.current.pauseMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", paused: true,
          closedPausedMs: 0, pauseStartedAtMs: Date.now(),
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", paused: false,
          closedPausedMs: 500, pauseStartedAtMs: null,
        });
      });
      await act(async () => {
        pending.resolve({ paused: true, closedPausedMs: 0, pauseStartedAtMs: Date.now() });
        await request;
      });

      expect(result.current).toMatchObject({
        recordingId: "meeting-a",
        meetingPhase: "recording",
        meetingPaused: false,
      });
    });

    it("keeps the current meeting clock correct across pause and resume", async () => {
      harness.meetingPoll = {
        phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 5_000,
        paused: false, closedPausedMs: 0, pauseStartedAtMs: null,
      };
      harness.pauseRecording.mockResolvedValueOnce({
        paused: true, closedPausedMs: 0, pauseStartedAtMs: Date.now(),
      });
      harness.resumeRecording.mockResolvedValueOnce({
        paused: false, closedPausedMs: 2_000, pauseStartedAtMs: null,
      });
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 5_000,
        });
      });
      await act(async () => { await result.current.pauseMeeting(); });
      harness.meetingPoll = {
        ...harness.meetingPoll,
        paused: true,
        pauseStartedAtMs: Date.now(),
      };
      expect(result.current.duration).toBe(5);
      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(result.current.duration).toBe(5);
      await act(async () => { await result.current.resumeMeeting(); });
      harness.meetingPoll = {
        ...harness.meetingPoll,
        paused: false,
        closedPausedMs: 2_000,
        pauseStartedAtMs: null,
      };
      expect(result.current.duration).toBe(5);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(6);
    });
  });

  describe("meeting lifecycle ownership", () => {
    it("does not let a stale A event steal B's pending stop or pause ownership", async () => {
      const pendingStop = deferred<void>();
      harness.stopRecording.mockReturnValueOnce(pendingStop.promise);
      const pendingPause = deferred<{ paused: boolean; closedPausedMs: number; pauseStartedAtMs: number | null }>();
      harness.pauseRecording.mockReturnValueOnce(pendingPause.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-b", startedAtMs: Date.now() - 4_000,
        });
      });

      let stopRequest!: Promise<void>;
      act(() => { stopRequest = result.current.stopMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 40_000,
        });
      });
      await act(async () => {
        pendingStop.resolve(undefined);
        await stopRequest;
      });
      expect(result.current.recordingId).toBe("meeting-b");
      expect(result.current.duration).toBe(4);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(4);

      // A fresh B lifecycle event restarts the clock for the independent pause check.
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "ready", recordingId: "meeting-b",
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-b", startedAtMs: Date.now() - 2_000,
          paused: false,
        });
      });
      let pauseRequest!: Promise<void>;
      act(() => { pauseRequest = result.current.pauseMeeting(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 50_000,
        });
      });
      await act(async () => {
        pendingPause.resolve({
          paused: true,
          closedPausedMs: 0,
          pauseStartedAtMs: Date.now(),
        });
        await pauseRequest;
      });
      expect(result.current).toMatchObject({
        recordingId: "meeting-b",
        meetingPaused: true,
        meetingPhase: "recording",
      });
    });

    it("ignores delayed initial hydration for A after B owns capture", async () => {
      const hydration = deferred<Record<string, unknown>>();
      harness.meetingPoll = hydration.promise;
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-b", startedAtMs: Date.now() - 2_000,
        });
      });
      expect(result.current.duration).toBe(2);

      await act(async () => {
        hydration.resolve({
          phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 30_000,
        });
        await hydration.promise;
        await Promise.resolve();
      });

      expect(result.current.recordingId).toBe("meeting-b");
      expect(result.current.duration).toBe(2);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(3);
    });

    it("ignores a foreign A poll without resetting B's clock or stop ownership", async () => {
      const pendingStop = deferred<void>();
      harness.stopRecording.mockReturnValueOnce(pendingStop.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording", recordingId: "meeting-b", startedAtMs: Date.now() - 5_000,
        });
      });
      let stopRequest!: Promise<void>;
      act(() => { stopRequest = result.current.stopMeeting(); });
      harness.meetingPoll = {
        phase: "recording", recordingId: "meeting-a", startedAtMs: Date.now() - 60_000,
      };

      await act(async () => { vi.advanceTimersByTime(2_500); });
      expect(result.current.recordingId).toBe("meeting-b");
      expect(result.current.duration).toBe(7);

      await act(async () => {
        pendingStop.resolve(undefined);
        await stopRequest;
      });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(result.current.duration).toBe(7);
    });
  });

  describe("dictation lifecycle ownership", () => {
    it("does not let a stale dictation event replace an active meeting", async () => {
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-b",
          startedAtMs: Date.now() - 4_000,
        });
      });

      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 1,
          startedAtMs: Date.now() - 30_000,
        });
      });

      expect(result.current).toMatchObject({
        recordingMode: "meeting",
        recordingId: "meeting-b",
        meetingPhase: "recording",
      });
      expect(result.current.duration).toBe(4);
    });

    it("does not let an older dictation session replace or end the current one", async () => {
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 2,
          startedAtMs: Date.now() - 3_000,
        });
      });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 1,
          startedAtMs: Date.now() - 40_000,
        });
        emit("dictation-state-changed", {
          phase: "done",
          sessionId: 1,
        });
      });

      expect(result.current).toMatchObject({
        recordingMode: "dictation",
        isRecording: true,
      });
      expect(result.current.duration).toBe(3);
    });

    it("keeps a live dictation when an earlier meeting finishes transcribing", async () => {
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 4,
          startedAtMs: Date.now() - 2_000,
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", { phase: "processing", recordingId: "meeting-earlier" });
        emit("meeting-recording-state-changed", { phase: "ready", recordingId: "meeting-earlier" });
      });

      expect(result.current).toMatchObject({
        recordingMode: "dictation",
        isRecording: true,
      });
      expect(result.current.duration).toBe(2);
    });

    it("does not let a higher foreign terminal event end the current dictation", async () => {
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 2,
          startedAtMs: Date.now() - 3_000,
        });
      });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "done",
          sessionId: 3,
        });
      });

      expect(result.current).toMatchObject({
        recordingMode: "dictation",
        isRecording: true,
      });
      expect(result.current.duration).toBe(3);
    });

    it("accepts a newer dictation session id after the previous session", async () => {
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => {
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 1,
          startedAtMs: Date.now() - 9_000,
        });
        emit("dictation-state-changed", {
          phase: "recording",
          sessionId: 2,
          startedAtMs: Date.now() - 1_000,
        });
      });

      expect(result.current).toMatchObject({
        recordingMode: "dictation",
        isRecording: true,
      });
      expect(result.current.duration).toBe(1);
    });

    it.each(["processing", "ready", "error"] as const)(
      "allows dictation after a meeting reaches %s",
      async (meetingPhase) => {
        const { result } = renderHook(() => useRecording(), { wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => {
          emit("meeting-recording-state-changed", {
            phase: meetingPhase,
            recordingId: "meeting-finished",
          });
        });
        await act(async () => {
          emit("dictation-state-changed", {
            phase: "recording",
            sessionId: 1,
            startedAtMs: Date.now() - 1_000,
          });
        });

        expect(result.current).toMatchObject({
          recordingMode: "dictation",
          isRecording: true,
        });
        expect(result.current.duration).toBe(1);
      },
    );

    it("does not reopen a meeting ended before its start acknowledgement returns", async () => {
      const pendingStart = deferred<string>();
      harness.startRecording.mockReturnValueOnce(pendingStart.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      let startRequest!: Promise<string | null>;
      act(() => {
        startRequest = result.current.startMeeting({
          mic: true,
          systemAudio: false,
          projectId: "default",
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "ready",
          recordingId: "meeting-a",
        });
      });

      await act(async () => {
        pendingStart.resolve("meeting-a");
        expect(await startRequest).toBeNull();
      });

      expect(result.current).toMatchObject({
        recordingMode: "meeting",
        recordingId: "meeting-a",
        meetingPhase: "ready",
        isRecording: false,
      });
      expect(result.current.duration).toBe(0);
    });

    it("does not let meeting A's late start acknowledgement replace active meeting B", async () => {
      const pendingStart = deferred<string>();
      harness.startRecording.mockReturnValueOnce(pendingStart.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      let startRequest!: Promise<string | null>;
      act(() => {
        startRequest = result.current.startMeeting({
          mic: true,
          systemAudio: true,
          projectId: "default",
        });
      });
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-b",
          startedAtMs: Date.now() - 2_000,
        });
      });
      await act(async () => {
        pendingStart.resolve("meeting-a");
        expect(await startRequest).toBeNull();
      });

      expect(result.current).toMatchObject({
        recordingMode: "meeting",
        recordingId: "meeting-b",
        meetingPhase: "recording",
        isRecording: true,
      });
      expect(result.current.duration).toBe(2);
    });

    it("returns the current meeting id without overwriting accepted pause and timing state", async () => {
      const pendingStart = deferred<string>();
      harness.startRecording.mockReturnValueOnce(pendingStart.promise);
      const { result } = renderHook(() => useRecording(), { wrapper });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      let startRequest!: Promise<string | null>;
      act(() => {
        startRequest = result.current.startMeeting({
          mic: true,
          systemAudio: true,
          projectId: "default",
        });
      });
      const startedAtMs = Date.now() - 8_000;
      const pauseStartedAtMs = Date.now() - 2_000;
      await act(async () => {
        emit("meeting-recording-state-changed", {
          phase: "recording",
          recordingId: "meeting-a",
          startedAtMs,
          paused: true,
          closedPausedMs: 1_500,
          pauseStartedAtMs,
          systemAudioActive: true,
        });
      });

      await act(async () => {
        pendingStart.resolve("meeting-a");
        expect(await startRequest).toBe("meeting-a");
      });

      expect(result.current).toMatchObject({
        recordingMode: "meeting",
        recordingId: "meeting-a",
        meetingPhase: "recording",
        meetingPaused: true,
        meetingStartedAtMs: startedAtMs,
        meetingClosedPausedMs: 1_500,
        meetingPauseStartedAtMs: pauseStartedAtMs,
        isSystemAudioActive: true,
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not clear a newer meeting when an older dictation stop resolves", async () => {
    const pendingStop = deferred<string>();
    harness.stopDictation.mockReturnValue(pendingStop.promise);
    const { result } = renderHook(() => useRecording(), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 1,
        startedAtMs: Date.now() - 2_000,
      });
    });
    let stopPromise!: Promise<string>;
    act(() => {
      stopPromise = result.current.stopDictation();
    });

    await act(async () => {
      emit("meeting-recording-state-changed", {
        phase: "recording",
        recordingId: "meeting-2",
        startedAtMs: Date.now() - 5_000,
        systemAudioActive: true,
      });
    });
    expect(result.current.recordingMode).toBe("meeting");
    expect(result.current.duration).toBe(5);

    await act(async () => {
      pendingStop.resolve("old dictation");
      await stopPromise;
    });
    expect(result.current.recordingMode).toBe("meeting");
    expect(result.current.recordingId).toBe("meeting-2");
    expect(result.current.duration).toBe(5);

    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.duration).toBe(6);
  });

  it("does not clear a newer dictation when an older dictation stop resolves", async () => {
    const pendingStop = deferred<string>();
    harness.stopDictation.mockReturnValue(pendingStop.promise);
    const { result } = renderHook(() => useRecording(), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 1,
        startedAtMs: Date.now() - 4_000,
      });
    });
    let stopPromise!: Promise<string>;
    act(() => {
      stopPromise = result.current.stopDictation();
    });
    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 2,
        startedAtMs: Date.now() - 1_000,
      });
    });

    await act(async () => {
      pendingStop.resolve("old dictation");
      await stopPromise;
    });
    expect(result.current.recordingMode).toBe("dictation");
    expect(result.current.isRecording).toBe(true);
    expect(result.current.duration).toBe(1);

    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.duration).toBe(2);
  });

  it("cleans up when the stopped dictation still owns the provider", async () => {
    const pendingStop = deferred<string>();
    harness.stopDictation.mockReturnValue(pendingStop.promise);
    const { result } = renderHook(() => useRecording(), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 1,
        startedAtMs: Date.now() - 3_000,
      });
    });
    expect(result.current.duration).toBe(3);

    let stopPromise!: Promise<string>;
    act(() => {
      stopPromise = result.current.stopDictation();
    });
    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 1,
        startedAtMs: Date.now() - 3_000,
      });
    });
    await act(async () => {
      pendingStop.resolve("finished dictation");
      expect(await stopPromise).toBe("finished dictation");
    });
    expect(result.current.recordingMode).toBeNull();
    expect(result.current.isRecording).toBe(false);
    expect(result.current.duration).toBe(0);
  });

  it("ignores an old dictation poll after a newer meeting starts", async () => {
    const pendingPoll = deferred<Record<string, unknown>>();
    const { result } = renderHook(() => useRecording(), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emit("dictation-state-changed", {
        phase: "recording",
        sessionId: 1,
        startedAtMs: Date.now() - 4_000,
      });
    });
    harness.dictationPoll = pendingPoll.promise;
    await act(async () => { vi.advanceTimersByTime(2_500); });

    await act(async () => {
      emit("meeting-recording-state-changed", {
        phase: "recording",
        recordingId: "meeting-2",
        startedAtMs: Date.now() - 2_000,
        systemAudioActive: false,
      });
    });
    expect(result.current.recordingMode).toBe("meeting");
    expect(result.current.duration).toBe(2);

    await act(async () => {
      pendingPoll.resolve({ phase: "idle" });
      await pendingPoll.promise;
      await Promise.resolve();
    });
    expect(result.current.recordingMode).toBe("meeting");
    expect(result.current.recordingId).toBe("meeting-2");
    expect(result.current.duration).toBe(2);

    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.duration).toBe(3);
  });
});
