import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { useRecordings } from "@/hooks/use-recordings";
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
      expect(result.current.error).toBe("Failed to fetch recordings");
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

  it("removes listeners that finish registering after unmount", async () => {
    const pendingUnlisten = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation((eventName, handler) => {
      eventMocks.listeners.set(
        eventName,
        handler as (event: { payload: any }) => void,
      );
      return pendingUnlisten.promise;
    });

    const { unmount } = renderHook(() => useRecordings(), { wrapper });
    unmount();

    await act(async () => {
      pendingUnlisten.resolve(unlisten);
      await pendingUnlisten.promise;
    });

    expect(unlisten).toHaveBeenCalledTimes(4);
  });
});
