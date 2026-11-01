import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { useRecordings } from "@/hooks/use-recordings";
import { getRecordings } from "@/lib/backend";
import { listen } from "@/lib/electron";

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockRecordings = [
  {
    id: "r1",
    title: "Meeting 1",
    projectId: "p1",
    duration: 120,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceType: "meeting",
    audioPath: "/tmp/audio.wav",
    status: "completed" as const,
  },
];

vi.mock("@/lib/backend", () => ({
  getRecordings: vi.fn(() => Promise.resolve(mockRecordings)),
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    eventMocks.listeners.set(eventName, handler);
    return () => eventMocks.listeners.delete(eventName);
  }),
  invoke: vi.fn(),
}));

describe("useRecordings", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    createElement(DataCacheProvider, null, children)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    eventMocks.listeners.clear();
    vi.mocked(getRecordings).mockReset().mockResolvedValue(mockRecordings);
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      eventMocks.listeners.set(
        eventName,
        handler as (event: { payload: any }) => void,
      );
      return () => eventMocks.listeners.delete(eventName);
    });
  });

  it("fetches recordings on mount", async () => {
    const { result } = renderHook(() => useRecordings(), { wrapper });

    await waitFor(() => {
      expect(result.current.recordings).toHaveLength(1);
    });
    expect(result.current.recordings[0].title).toBe("Meeting 1");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasLoaded).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("keeps transport errors and stack traces out of history errors", async () => {
    vi.mocked(getRecordings).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'sidecar:invoke': Error: SQLite failure\n    at getRecordings (/Users/test/db.ts:12:4)",
    ));
    const { result } = renderHook(() => useRecordings("technical-error"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe("Couldn't load recordings. Try again.");
    expect(result.current.hasLoaded).toBe(false);
  });

  it("drops entries auto-delete removed after the list last refreshed", async () => {
    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.recordings).toHaveLength(1));
    await waitFor(() => expect(eventMocks.listeners.has("dictation-retention-cleanup")).toBe(true));
    const calls = vi.mocked(getRecordings).mock.calls.length;

    // A sweep that removed nothing does not refetch.
    act(() => {
      eventMocks.listeners.get("dictation-retention-cleanup")?.({ payload: { deletedRecordings: 0 } });
    });
    expect(vi.mocked(getRecordings).mock.calls.length).toBe(calls);

    vi.mocked(getRecordings).mockResolvedValue([]);
    act(() => {
      eventMocks.listeners.get("dictation-retention-cleanup")?.({ payload: { deletedRecordings: 2 } });
    });
    await waitFor(() => expect(result.current.recordings).toHaveLength(0));
  });

  it("does not mark a failed first request as a successful load", async () => {
    const { getRecordings } = await import("@/lib/backend");
    vi.mocked(getRecordings).mockRejectedValueOnce(new Error("Recordings unavailable"));

    const { result } = renderHook(() => useRecordings("failed-project"), { wrapper });

    expect(result.current.hasLoaded).toBe(false);
    await waitFor(() => {
      expect(result.current.error).toBe("Recordings unavailable");
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasLoaded).toBe(false);
  });

  it("uses an actionable fallback when a failed request has no message", async () => {
    const { getRecordings } = await import("@/lib/backend");
    vi.mocked(getRecordings).mockRejectedValueOnce(new Error("   "));

    const { result } = renderHook(() => useRecordings("blank-error-project"), { wrapper });

    await waitFor(() => {
      expect(result.current.error).toBe("Couldn't load recordings. Try again.");
    });
    expect(result.current.hasLoaded).toBe(false);
    expect(result.current.recordings).toEqual([]);
  });

  it("keeps cached meetings visible when a background refresh fails", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const refresh = deferred<typeof mockRecordings>();
    vi.mocked(getRecordings)
      .mockResolvedValueOnce(mockRecordings)
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() => useRecordings("refresh-project"), { wrapper });

    await waitFor(() => {
      expect(result.current.recordings).toEqual(mockRecordings);
      expect(result.current.hasLoaded).toBe(true);
    });
    await waitFor(() => {
      expect(eventMocks.listeners.get("recording-status-changed")).toBeDefined();
    });

    await act(async () => {
      eventMocks.listeners.get("recording-status-changed")?.({ payload: {} });
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.recordings).toEqual(mockRecordings);

    await act(async () => {
      refresh.reject(new Error("Refresh unavailable"));
      await refresh.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Refresh unavailable");
    });
    expect(result.current.hasLoaded).toBe(true);
    expect(result.current.recordings).toEqual(mockRecordings);
  });

  it("passes projectId to fetch", async () => {
    const { getRecordings } = await import("@/lib/backend");
    renderHook(() => useRecordings("p1"), { wrapper });

    await waitFor(() => {
      expect(getRecordings).toHaveBeenCalledWith("p1");
    });
  });

  it("keeps refetch stable across rerenders", async () => {
    const { result, rerender } = renderHook(() => useRecordings("p1"), { wrapper });

    await waitFor(() => {
      expect(result.current.recordings).toHaveLength(1);
    });
    const refetch = result.current.refetch;

    rerender();

    expect(result.current.refetch).toBe(refetch);
  });

  it("deduplicates recording fetches by project key", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const mockedGetRecordings = vi.mocked(getRecordings);

    const { result } = renderHook(
      () => {
        const first = useRecordings("p1");
        const second = useRecordings("p1");
        return { first, second };
      },
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.first.recordings).toHaveLength(1);
      expect(result.current.second.recordings).toHaveLength(1);
    });
    expect(mockedGetRecordings).toHaveBeenCalledTimes(1);
  });

  it("refreshes recordings when meeting status changes outside the current view", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const mockedGetRecordings = vi.mocked(getRecordings);

    mockedGetRecordings
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockRecordings);

    const { result } = renderHook(() => useRecordings(), { wrapper });

    await waitFor(() => {
      expect(result.current.recordings).toEqual([]);
    });

    const handler = eventMocks.listeners.get("recording-status-changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler?.({
        payload: {
          recordingId: "r1",
          status: "completed",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.recordings).toHaveLength(1);
    });

    expect(mockedGetRecordings).toHaveBeenCalledTimes(2);
  });

  it("reconciles persistence after every Meeting lifecycle event", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const mockedGetRecordings = vi.mocked(getRecordings);
    mockedGetRecordings.mockResolvedValueOnce([]).mockResolvedValueOnce(mockRecordings);

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.recordings).toEqual([]));
    await waitFor(() => {
      expect(eventMocks.listeners.get("meeting-recording-state-changed")).toBeDefined();
    });

    await act(async () => {
      eventMocks.listeners.get("meeting-recording-state-changed")?.({
        payload: { phase: "error", recordingId: "r1" },
      });
    });

    await waitFor(() => expect(result.current.recordings).toEqual(mockRecordings));
    expect(mockedGetRecordings).toHaveBeenCalledTimes(2);
  });

  it("refreshes recordings when dictation history changes", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const mockedGetRecordings = vi.mocked(getRecordings);
    mockedGetRecordings.mockResolvedValueOnce([]).mockResolvedValueOnce(mockRecordings);

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.recordings).toEqual([]));
    await waitFor(() => {
      expect(eventMocks.listeners.get("dictation-history-changed")).toBeDefined();
    });

    await act(async () => {
      eventMocks.listeners.get("dictation-history-changed")?.({
        payload: { recordingId: "r1", recovery: true },
      });
    });

    await waitFor(() => expect(result.current.recordings).toEqual(mockRecordings));
    expect(mockedGetRecordings).toHaveBeenCalledTimes(2);
  });

  it("refreshes recording metadata after another window saves notes", async () => {
    const changed = mockRecordings.map((recording) => ({ ...recording, meetingNotes: "Notes saved from the popup." }));
    vi.mocked(getRecordings).mockResolvedValueOnce(mockRecordings).mockResolvedValueOnce(changed);
    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.recordings).toEqual(mockRecordings));
    await waitFor(() => expect(eventMocks.listeners.get("recording-notes-updated")).toBeDefined());
    await act(async () => {
      eventMocks.listeners.get("recording-notes-updated")?.({ payload: { recordingId: "r1" } });
    });
    await waitFor(() => expect(result.current.recordings).toEqual(changed));
    expect(getRecordings).toHaveBeenCalledTimes(2);
  });

  it("registers remaining listeners when earlier registrations are pending or fail", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const heldRegistration = deferred<() => void>();
    const refreshedRecordings = [{ ...mockRecordings[0], title: "Recovered dictation" }];
    vi.mocked(getRecordings)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(refreshedRecordings);
    vi.mocked(listen).mockImplementation((eventName, handler) => {
      eventMocks.listeners.set(
        eventName,
        handler as (event: { payload: any }) => void,
      );
      if (eventName === "meeting-recording-state-changed") {
        return heldRegistration.promise;
      }
      if (eventName === "recording-status-changed") {
        return Promise.reject(new Error("listener unavailable"));
      }
      return Promise.resolve(() => eventMocks.listeners.delete(eventName));
    });

    const { result, unmount } = renderHook(() => useRecordings(), { wrapper });

    await waitFor(() => expect(result.current.recordings).toEqual([]));
    await waitFor(() => {
      expect(eventMocks.listeners.get("dictation-history-changed")).toBeDefined();
    });

    await act(async () => {
      eventMocks.listeners.get("dictation-history-changed")?.({ payload: {} });
    });

    await waitFor(() => {
      expect(result.current.recordings).toEqual(refreshedRecordings);
    });

    unmount();
    heldRegistration.resolve(vi.fn());
    await heldRegistration.promise;
  });

  it("removes every listener that finishes registering after unmount", async () => {
    const registrations = Array.from({ length: 7 }, () => deferred<() => void>());
    const unlisteners = registrations.map(() => vi.fn());
    vi.mocked(listen).mockImplementation((eventName, handler) => {
      eventMocks.listeners.set(
        eventName,
        handler as (event: { payload: any }) => void,
      );
      const registration = registrations[vi.mocked(listen).mock.calls.length - 1];
      return registration.promise;
    });

    const { unmount } = renderHook(() => useRecordings(), { wrapper });

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(7));
    unmount();

    await act(async () => {
      registrations.forEach((registration, index) => {
        registration.resolve(unlisteners[index]);
      });
      await Promise.all(registrations.map((registration) => registration.promise));
    });

    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledOnce();
    }
  });

  it("ignores a captured listener after its hook unmounts", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const { unmount } = renderHook(() => useRecordings("disposed-project"), { wrapper });

    await waitFor(() => {
      expect(eventMocks.listeners.get("dictation-history-changed")).toBeDefined();
    });
    const disposedHandler = eventMocks.listeners.get("dictation-history-changed");
    await waitFor(() => expect(getRecordings).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      disposedHandler?.({ payload: {} });
    });

    expect(getRecordings).toHaveBeenCalledTimes(1);
  });

  it("shows a newer refresh result instead of an older in-flight response", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const initialRequest = deferred<typeof mockRecordings>();
    const refreshRequest = deferred<typeof mockRecordings>();
    const staleRecordings = [{ ...mockRecordings[0], title: "Before recovery" }];
    const recoveredRecordings = [{ ...mockRecordings[0], title: "Recovered dictation" }];
    vi.mocked(getRecordings)
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(refreshRequest.promise);

    const { result } = renderHook(() => useRecordings("recovery-project"), { wrapper });
    await waitFor(() => {
      expect(eventMocks.listeners.get("dictation-history-changed")).toBeDefined();
    });

    await act(async () => {
      eventMocks.listeners.get("dictation-history-changed")?.({ payload: {} });
      initialRequest.resolve(staleRecordings);
      await initialRequest.promise;
    });

    await waitFor(() => expect(getRecordings).toHaveBeenCalledTimes(2));
    expect(result.current.recordings).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      refreshRequest.resolve(recoveredRecordings);
      await refreshRequest.promise;
    });

    await waitFor(() => {
      expect(result.current.recordings).toEqual(recoveredRecordings);
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBeNull();
  });

  it("keeps the newer project result when the previous project fails later", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const projectA = deferred<typeof mockRecordings>();
    const projectBRecordings = [{ ...mockRecordings[0], id: "r2", projectId: "p2", title: "Project B" }];
    vi.mocked(getRecordings)
      .mockReturnValueOnce(projectA.promise)
      .mockResolvedValueOnce(projectBRecordings);

    const { result, rerender } = renderHook(
      ({ projectId }) => useRecordings(projectId),
      { initialProps: { projectId: "p1" }, wrapper },
    );

    rerender({ projectId: "p2" });
    await waitFor(() => {
      expect(result.current.recordings).toEqual(projectBRecordings);
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      projectA.reject(new Error("Project A unavailable"));
      await projectA.promise.catch(() => undefined);
    });

    expect(result.current.recordings).toEqual(projectBRecordings);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("clears the previous project rows while the next project loads", async () => {
    const { getRecordings } = await import("@/lib/backend");
    const projectB = deferred<typeof mockRecordings>();
    const projectBRecordings = [{ ...mockRecordings[0], id: "r2", projectId: "p2", title: "Project B" }];
    vi.mocked(getRecordings)
      .mockResolvedValueOnce(mockRecordings)
      .mockReturnValueOnce(projectB.promise);

    const { result, rerender } = renderHook(
      ({ projectId }) => useRecordings(projectId),
      { initialProps: { projectId: "p1" }, wrapper },
    );
    await waitFor(() => expect(result.current.recordings).toEqual(mockRecordings));

    rerender({ projectId: "p2" });

    await waitFor(() => {
      expect(result.current.recordings).toEqual([]);
      expect(result.current.isLoading).toBe(true);
      expect(result.current.hasLoaded).toBe(false);
    });

    await act(async () => {
      projectB.resolve(projectBRecordings);
      await projectB.promise;
    });
    await waitFor(() => expect(result.current.recordings).toEqual(projectBRecordings));
  });
});
