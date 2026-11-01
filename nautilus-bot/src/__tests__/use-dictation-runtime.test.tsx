import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: mocks.invoke,
  listen: mocks.listen,
}));

import { useDictationRuntime } from "@/features/dictation/runtime";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installImmediateListeners() {
  const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();
  mocks.listen.mockImplementation(
    async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      mocks.handlers.set(eventName, handler);
      const unlisten = vi.fn(() => mocks.handlers.delete(eventName));
      unlisteners.set(eventName, unlisten);
      return unlisten;
    },
  );
  return unlisteners;
}

describe("useDictationRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.invoke.mockResolvedValue({ phase: "idle" });
    installImmediateListeners();
  });

  it("starts both subscriptions before requesting the initial snapshot", async () => {
    const stateRegistration = deferred<() => void>();
    const textRegistration = deferred<() => void>();
    mocks.listen.mockImplementation(
      (eventName: string, handler: (event: { payload: unknown }) => void) => {
        mocks.handlers.set(eventName, handler);
        return eventName === "dictation-state-changed"
          ? stateRegistration.promise
          : textRegistration.promise;
      },
    );

    const { unmount } = renderHook(() => useDictationRuntime());

    expect(mocks.listen.mock.calls.map(([eventName]) => eventName)).toEqual([
      "dictation-state-changed",
      "dictation-text-ready",
    ]);
    expect(mocks.invoke).not.toHaveBeenCalled();

    await act(async () => {
      stateRegistration.resolve(vi.fn<() => void>());
      textRegistration.resolve(vi.fn<() => void>());
    });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("get_dictation_overlay_state"),
    );
    unmount();
  });

  it("delivers text while the initial snapshot is pending", async () => {
    const snapshot = deferred<{ phase: "idle" }>();
    mocks.invoke.mockReturnValue(snapshot.promise);
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("get_dictation_overlay_state"),
    );
    await act(async () => {
      mocks.handlers.get("dictation-text-ready")?.({
        payload: { text: "new result", outcome: "pasted" },
      });
    });

    expect(result.current.textReadyEvent).toEqual({
      text: "new result",
      outcome: "pasted",
    });
    expect(result.current.stateEvent).toBeNull();

    unmount();
    snapshot.resolve({ phase: "idle" });
  });

  it("keeps a live state event when a stale initial snapshot resolves later", async () => {
    const snapshot = deferred<{ phase: "recording"; sessionId: number; preview: string }>();
    mocks.invoke.mockReturnValue(snapshot.promise);
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.has("dictation-state-changed")).toBe(true));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "done", sessionId: 8, preview: "live words" },
      });
      snapshot.resolve({ phase: "recording", sessionId: 7, preview: "stale words" });
    });

    expect(result.current.stateEvent).toEqual(
      expect.objectContaining({ phase: "done", sessionId: 8, preview: "live words" }),
    );
    unmount();
  });

  it("does not apply a stale state snapshot after a live text event", async () => {
    const snapshot = deferred<{ phase: "recording"; sessionId: number }>();
    mocks.invoke.mockReturnValue(snapshot.promise);
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.has("dictation-text-ready")).toBe(true));
    await act(async () => {
      mocks.handlers.get("dictation-text-ready")?.({ payload: { text: "latest words" } });
      snapshot.resolve({ phase: "recording", sessionId: 4 });
    });

    expect(result.current.textReadyEvent).toEqual({ text: "latest words" });
    expect(result.current.stateEvent).toBeNull();
    unmount();
  });

  it("unlistens registrations that finish after unmount", async () => {
    const stateRegistration = deferred<() => void>();
    const textRegistration = deferred<() => void>();
    const unlistenState = vi.fn();
    const unlistenText = vi.fn();
    mocks.listen.mockImplementation((eventName: string) =>
      eventName === "dictation-state-changed"
        ? stateRegistration.promise
        : textRegistration.promise,
    );

    const { unmount } = renderHook(() => useDictationRuntime());
    unmount();
    await act(async () => {
      stateRegistration.resolve(unlistenState);
      textRegistration.resolve(unlistenText);
    });

    expect(unlistenState).toHaveBeenCalledOnce();
    expect(unlistenText).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("ignores initial hydration that finishes after unmount", async () => {
    const snapshot = deferred<{ phase: "recording"; sessionId: number }>();
    mocks.invoke.mockReturnValue(snapshot.promise);
    const unlisteners = installImmediateListeners();
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    unmount();
    await act(async () => {
      snapshot.resolve({ phase: "recording", sessionId: 3 });
    });

    expect(result.current.stateEvent).toBeNull();
    expect(unlisteners.get("dictation-state-changed")).toHaveBeenCalledOnce();
    expect(unlisteners.get("dictation-text-ready")).toHaveBeenCalledOnce();
  });

  it("hydrates from the initial snapshot when no live event arrives", async () => {
    mocks.invoke.mockResolvedValue({ phase: "recording", sessionId: 11, partialText: "hello" });
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() =>
      expect(result.current.stateEvent).toEqual(
        expect.objectContaining({
          phase: "recording",
          sessionId: 11,
          preview: "hello",
        }),
      ),
    );
    unmount();
  });

  it("keeps the text subscription active when state subscription fails", async () => {
    const unlistenText = vi.fn();
    mocks.listen.mockImplementation(
      async (eventName: string, handler: (event: { payload: unknown }) => void) => {
        if (eventName === "dictation-state-changed") {
          throw new Error("state subscription failed");
        }
        mocks.handlers.set(eventName, handler);
        return unlistenText;
      },
    );
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("get_dictation_overlay_state"),
    );
    await act(async () => {
      mocks.handlers.get("dictation-text-ready")?.({ payload: { text: "still delivered" } });
    });

    expect(result.current.textReadyEvent).toEqual({ text: "still delivered" });
    unmount();
    expect(unlistenText).toHaveBeenCalledOnce();
  });

  it("rejects stale state and text tails after a newer session starts", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.size).toBe(2));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 41, startedAtMs: 1_000 },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "preparing", sessionId: 42, startedAtMs: 2_000 },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 41, partialText: "stale partial" },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "idle", sessionId: 41 },
      });
      mocks.handlers.get("dictation-text-ready")?.({
        payload: {
          text: "stale result",
          sessionId: 41,
          acknowledgedAtMs: 1_100,
          recordingId: "recording-41",
        },
      });
    });

    expect(result.current.stateEvent).toEqual(
      expect.objectContaining({ phase: "preparing", sessionId: 42, startedAtMs: 2_000 }),
    );
    expect(result.current.stateEvent?.preview).toBeNull();
    expect(result.current.textReadyEvent).toBeNull();
    unmount();
  });

  it("ignores old and duplicate identified results while accepting the next result", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.size).toBe(2));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 7, startedAtMs: 2_000 },
      });
      mocks.handlers.get("dictation-text-ready")?.({
        payload: { text: "too old", sessionId: 7, acknowledgedAtMs: 1_999 },
      });
      mocks.handlers.get("dictation-text-ready")?.({
        payload: {
          text: "first result",
          sessionId: 7,
          acknowledgedAtMs: 2_100,
          recordingId: "recording-7-a",
        },
      });
    });

    const firstResult = result.current.textReadyEvent;
    expect(firstResult).toEqual(
      expect.objectContaining({ text: "first result", recordingId: "recording-7-a" }),
    );

    await act(async () => {
      mocks.handlers.get("dictation-text-ready")?.({
        payload: {
          text: "duplicate payload",
          sessionId: 7,
          acknowledgedAtMs: 2_100,
          recordingId: "recording-7-a",
        },
      });
    });
    expect(result.current.textReadyEvent).toBe(firstResult);

    await act(async () => {
      mocks.handlers.get("dictation-text-ready")?.({
        payload: {
          text: "latest result",
          sessionId: 7,
          acknowledgedAtMs: 2_200,
          recordingId: "recording-7-b",
        },
      });
    });
    expect(result.current.textReadyEvent).toEqual(
      expect.objectContaining({ text: "latest result", recordingId: "recording-7-b" }),
    );
    expect(result.current.textReadyEvent).not.toBe(firstResult);
    unmount();
  });

  it("accepts a restarted counter with a newer start and rejects an older start", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.has("dictation-state-changed")).toBe(true));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 900, startedAtMs: 10_000 },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "preparing", sessionId: 1, startedAtMs: 20_000 },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "preparing", sessionId: 901, startedAtMs: 15_000 },
      });
    });

    expect(result.current.stateEvent).toEqual(
      expect.objectContaining({ phase: "preparing", sessionId: 1, startedAtMs: 20_000 }),
    );
    unmount();
  });

  it("accepts a higher preparing session without a start timestamp", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.has("dictation-state-changed")).toBe(true));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", sessionId: 4, startedAtMs: 10_000 },
      });
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "preparing", sessionId: 5 },
      });
    });

    expect(result.current.stateEvent).toEqual(
      expect.objectContaining({ phase: "preparing", sessionId: 5 }),
    );
    unmount();
  });

  it("keeps recognition review words with their session and rejects an older completion", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());
    await waitFor(() => expect(mocks.handlers.size).toBe(2));
    const words = [{ word: "tailie", score: 0.533, startTime: 0, endTime: 1 }];
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({ payload: { phase: "recording", sessionId: 10, startedAtMs: 1000 } });
      mocks.handlers.get("dictation-text-ready")?.({ payload: {
        text: "The tally text.", rawTranscript: "The tailie text.", recognitionReviewWords: words,
        sessionId: 10, acknowledgedAtMs: 1100,
      } });
    });
    expect(result.current.textReadyEvent?.recognitionReviewWords).toEqual(words);
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({ payload: { phase: "preparing", sessionId: 11, startedAtMs: 2000 } });
      mocks.handlers.get("dictation-text-ready")?.({ payload: { text: "New capture", sessionId: 11, acknowledgedAtMs: 2100 } });
      mocks.handlers.get("dictation-text-ready")?.({ payload: {
        text: "Old capture", rawTranscript: "tailie", recognitionReviewWords: words,
        sessionId: 10, acknowledgedAtMs: 1100,
      } });
    });
    expect(result.current.textReadyEvent?.text).toBe("New capture");
    expect(result.current.textReadyEvent?.recognitionReviewWords).toBeUndefined();
    unmount();
  });

  it("continues forwarding untagged legacy state and text events", async () => {
    const { result, unmount } = renderHook(() => useDictationRuntime());

    await waitFor(() => expect(mocks.handlers.size).toBe(2));
    await act(async () => {
      mocks.handlers.get("dictation-state-changed")?.({
        payload: { phase: "recording", partialText: "legacy partial" },
      });
      mocks.handlers.get("dictation-text-ready")?.({
        payload: { text: "legacy result", outcome: "pasted" },
      });
    });

    expect(result.current.stateEvent).toEqual(
      expect.objectContaining({ phase: "recording", preview: "legacy partial" }),
    );
    expect(result.current.textReadyEvent).toEqual({
      text: "legacy result",
      outcome: "pasted",
    });
    unmount();
  });
});
