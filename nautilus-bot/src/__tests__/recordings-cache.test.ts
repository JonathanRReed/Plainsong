import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataCacheProvider, useDataCache } from "@/hooks/data-cache-context";
import type { Recording } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function cache() {
  return renderHook(() => useDataCache(), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(DataCacheProvider, null, children),
  }).result.current;
}
const rows: Recording[] = [{
  id: "recovered", title: "Recovered dictation", projectId: "p1", duration: 2,
  createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
  sourceType: "dictation", audioPath: "/fixture.wav", status: "error",
}];

describe("recordings cache invalidation", () => {
  it("coalesces concurrent refresh callers after an invalidated in-flight query", async () => {
    const store = cache();
    const old = deferred<Recording[]>();
    const fresh = deferred<Recording[]>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const initial = store.getRecordings("p1", fetcher);
    store.invalidateRecordings("p1");
    const first = store.getRecordings("p1", fetcher, true);
    const second = store.getRecordings("p1", fetcher, true);
    await act(async () => { old.resolve([]); await initial; });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(store.peekRecordings("p1")).toBeNull();
    fresh.resolve(rows);
    expect(await first).toEqual(rows);
    expect(await second).toEqual(rows);
    expect(store.peekRecordings("p1")).toEqual(rows);
    expect(await store.getRecordings("p1", fetcher)).toEqual(rows);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("performs the requested refresh even if the obsolete query fails", async () => {
    const store = cache();
    const old = deferred<Recording[]>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(rows);
    const initial = store.getRecordings("p1", fetcher);
    const oldFailure = initial.catch(() => undefined);
    store.invalidateRecordings("p1");
    const refreshed = store.getRecordings("p1", fetcher, true);
    old.reject(new Error("Old query failed"));
    await oldFailure;
    expect(await refreshed).toEqual(rows);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite explicitly updated cache rows with an older query", async () => {
    const store = cache();
    const old = deferred<Recording[]>();
    const initial = store.getRecordings("p1", () => old.promise);
    store.setRecordings("p1", rows);
    old.resolve([]);
    await initial;
    expect(store.peekRecordings("p1")).toEqual(rows);
  });
});
