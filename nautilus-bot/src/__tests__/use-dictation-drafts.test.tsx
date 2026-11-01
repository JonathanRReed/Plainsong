import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDictationDrafts } from "@/hooks/use-dictation-drafts";
import {
  clearDictationDraft,
  listDictationDrafts,
  saveDictationDraft,
} from "@/lib/backend/dictation-drafts";

vi.mock("@/lib/backend/dictation-drafts", () => ({
  listDictationDrafts: vi.fn(),
  saveDictationDraft: vi.fn(),
  clearDictationDraft: vi.fn(),
}));

const listDrafts = vi.mocked(listDictationDrafts);
const saveDraft = vi.mocked(saveDictationDraft);
const clearDraft = vi.mocked(clearDictationDraft);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useDictationDrafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDrafts.mockResolvedValue([]);
    clearDraft.mockResolvedValue(true);
  });

  it("does not restore a discarded draft from an older refresh", async () => {
    const draft = { recordingId: "recording-1", title: "Dictation", text: "Discard me", expectedSavedText: null };
    listDrafts.mockResolvedValueOnce([draft]);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const stale = deferred<Awaited<ReturnType<typeof listDictationDrafts>>>();
    listDrafts.mockReturnValueOnce(stale.promise);
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refresh(); });
    await act(async () => {
      expect(await result.current.clearDraft(draft.recordingId, draft.text)).toBe(true);
    });
    expect(result.current.drafts).toEqual([]);
    await act(async () => {
      stale.resolve([draft]);
      await refreshing;
    });
    expect(result.current.drafts).toEqual([]);
  });

  it("keeps a fresh same-ID draft when an older refresh finishes last", async () => {
    const oldDraft = { recordingId: "recording-1", title: "Dictation", text: "Discard me", expectedSavedText: null };
    listDrafts.mockResolvedValueOnce([oldDraft]);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const stale = deferred<Awaited<ReturnType<typeof listDictationDrafts>>>();
    listDrafts.mockReturnValueOnce(stale.promise);
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refresh(); });
    await act(async () => {
      await result.current.clearDraft(oldDraft.recordingId, oldDraft.text);
    });
    const freshDraft = { ...oldDraft, text: "New recovery copy" };
    listDrafts.mockResolvedValueOnce([freshDraft]);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.drafts[0]?.text).toBe(freshDraft.text);
    await act(async () => {
      stale.resolve([oldDraft]);
      await refreshing;
    });
    expect(result.current.drafts).toEqual([expect.objectContaining({ text: freshDraft.text, status: "saved" })]);
  });

  it("keeps a failed write available as a local draft", async () => {
    saveDraft.mockRejectedValueOnce(new Error("disk unavailable"));
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saved = true;
    await act(async () => {
      saved = await result.current.saveDraft("recording-1", "Keep these words", null);
    });

    expect(saved).toBe(false);
    expect(result.current.drafts).toEqual([
      expect.objectContaining({
        recordingId: "recording-1",
        text: "Keep these words",
        status: "error",
      }),
    ]);
    expect(result.current.drafts[0]?.error).toContain("disk unavailable");
  });

  it("serializes writes per recording and leaves the latest revision saved", async () => {
    const first = deferred<void>();
    saveDraft
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstSave!: Promise<boolean>;
    let secondSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.saveDraft("recording-1", "First", "Saved text");
      secondSave = result.current.saveDraft("recording-1", "Second", "Saved text");
    });

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({ text: "Second", status: "pending" }),
    );

    await act(async () => {
      first.resolve();
      await firstSave;
      await secondSave;
    });

    expect(saveDraft.mock.calls).toEqual([
      ["recording-1", "First", "Saved text"],
      ["recording-1", "Second", "Saved text"],
    ]);
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({ text: "Second", status: "saved" }),
    );
  });

  it("skips superseded saves waiting behind an active write", async () => {
    const first = deferred<void>();
    saveDraft
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstSave!: Promise<boolean>;
    let supersededSave!: Promise<boolean>;
    let latestSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.saveDraft("recording-1", "First", null);
      supersededSave = result.current.saveDraft("recording-1", "Second", null);
      latestSave = result.current.saveDraft("recording-1", "Third", null);
    });

    expect(saveDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      await firstSave;
      expect(await supersededSave).toBe(false);
      expect(await latestSave).toBe(true);
    });

    expect(saveDraft.mock.calls).toEqual([
      ["recording-1", "First", null],
      ["recording-1", "Third", null],
    ]);
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({ text: "Third", status: "saved" }),
    );
  });

  it("does not let a clear for old text erase a newer local revision", async () => {
    const first = deferred<void>();
    saveDraft
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.saveDraft("recording-1", "Old edit", null);
      void result.current.saveDraft("recording-1", "Updated edit", null);
    });

    let cleared = true;
    await act(async () => {
      cleared = await result.current.clearDraft("recording-1", "Old edit");
    });

    expect(cleared).toBe(false);
    expect(clearDraft).not.toHaveBeenCalled();
    expect(result.current.drafts[0]?.text).toBe("Updated edit");

    await act(async () => {
      first.resolve();
      await firstSave;
    });
    await waitFor(() => expect(result.current.drafts[0]?.status).toBe("saved"));
    expect(result.current.drafts[0]?.text).toBe("Updated edit");
  });

  it("rebases newer text after an older edit is saved", async () => {
    const first = deferred<void>();
    saveDraft
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstJournal!: Promise<boolean>;
    let staleJournal!: Promise<boolean>;
    let acknowledgement!: Promise<boolean>;
    act(() => {
      firstJournal = result.current.saveDraft("recording-1", "Saved edit", null);
      staleJournal = result.current.saveDraft("recording-1", "Newer edit", null);
      acknowledgement = result.current.acknowledgeSavedEdit(
        "recording-1",
        "Saved edit",
        null,
        "Saved edit",
      );
    });

    await act(async () => {
      first.resolve();
      expect(await firstJournal).toBe(true);
      expect(await staleJournal).toBe(false);
      expect(await acknowledgement).toBe(true);
    });

    expect(clearDraft).not.toHaveBeenCalled();
    expect(saveDraft.mock.calls).toEqual([
      ["recording-1", "Saved edit", null],
      ["recording-1", "Newer edit", "Saved edit"],
    ]);
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({
        text: "Newer edit",
        expectedSavedText: "Saved edit",
        status: "saved",
      }),
    );
  });

  it("waits for pending writes before flush succeeds", async () => {
    const pending = deferred<void>();
    saveDraft.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let flushed = false;
    let flushPromise!: Promise<boolean>;
    act(() => {
      void result.current.saveDraft("recording-1", "Pending edit", null);
      flushPromise = result.current.flush().then((value) => {
        flushed = value;
        return value;
      });
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    await act(async () => {
      pending.resolve();
      expect(await flushPromise).toBe(true);
    });
    expect(result.current.drafts[0]?.status).toBe("saved");
  });

  it("retries a failed current draft once and returns false when it still fails", async () => {
    saveDraft
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("retry failure"));
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(
        await result.current.saveDraft("recording-1", "Keep this edit", null),
      ).toBe(false);
    });

    await act(async () => {
      expect(await result.current.flush()).toBe(false);
    });

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({
        text: "Keep this edit",
        status: "error",
        error: "retry failure",
      }),
    );
  });

  it("flushes the latest revision queued while a flush is waiting", async () => {
    const first = deferred<void>();
    const latest = deferred<void>();
    saveDraft
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let flushPromise!: Promise<boolean>;
    act(() => {
      void result.current.saveDraft("recording-1", "First", null);
      flushPromise = result.current.flush();
      void result.current.saveDraft("recording-1", "Superseded", null);
      void result.current.saveDraft("recording-1", "Latest", null);
    });

    await act(async () => {
      first.resolve();
      await Promise.resolve();
    });
    expect(saveDraft.mock.calls).toEqual([
      ["recording-1", "First", null],
      ["recording-1", "Latest", null],
    ]);

    await act(async () => {
      latest.resolve();
      expect(await flushPromise).toBe(true);
    });
    expect(result.current.drafts[0]).toEqual(
      expect.objectContaining({ text: "Latest", status: "saved" }),
    );
  });

  it("forgets an acknowledged failed journal without removing a newer draft", async () => {
    const refreshed = deferred<Awaited<ReturnType<typeof listDictationDrafts>>>();
    listDrafts
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => refreshed.promise);
    saveDraft
      .mockRejectedValueOnce(new Error("journal write failed"))
      .mockResolvedValueOnce(undefined);
    clearDraft.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(
        await result.current.saveDraft("recording-1", "Primary edit", null),
      ).toBe(false);
    });

    let acknowledgement!: Promise<boolean>;
    act(() => {
      acknowledgement = result.current.acknowledgeSavedEdit(
        "recording-1",
        "Primary edit",
        null,
        "Primary edit",
      );
    });
    await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(2));

    let newerSave!: Promise<boolean>;
    act(() => {
      newerSave = result.current.saveDraft(
        "recording-1",
        "New draft",
        "Primary edit",
      );
    });
    await act(async () => {
      refreshed.resolve([
        {
          recordingId: "recording-2",
          title: "Server draft",
          text: "Stored elsewhere",
          expectedSavedText: null,
        },
      ]);
      expect(await acknowledgement).toBe(true);
      expect(await newerSave).toBe(true);
    });

    expect(result.current.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordingId: "recording-1",
          text: "New draft",
          status: "saved",
        }),
        expect.objectContaining({
          recordingId: "recording-2",
          text: "Stored elsewhere",
          status: "saved",
        }),
      ]),
    );
  });

  it("does not block flush when acknowledged-draft cleanup fails", async () => {
    const cleanup = deferred<boolean>();
    saveDraft.mockResolvedValue(undefined);
    clearDraft.mockImplementationOnce(() => cleanup.promise);
    const { result } = renderHook(() => useDictationDrafts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(
        await result.current.saveDraft("recording-1", "Canonical edit", null),
      ).toBe(true);
    });

    let acknowledgement!: Promise<boolean>;
    let newerSave!: Promise<boolean>;
    act(() => {
      acknowledgement = result.current.acknowledgeSavedEdit(
        "recording-1",
        "Canonical edit",
        null,
        "Canonical edit",
      );
      newerSave = result.current.saveDraft(
        "recording-1",
        "Newer local edit",
        "Canonical edit",
      );
    });

    await act(async () => {
      cleanup.reject(new Error("cleanup unavailable"));
      expect(await acknowledgement).toBe(true);
      expect(await newerSave).toBe(true);
      expect(await result.current.flush()).toBe(true);
    });

    expect(result.current.error).toBe("cleanup unavailable");
    expect(result.current.drafts).toEqual([
      expect.objectContaining({
        recordingId: "recording-1",
        text: "Newer local edit",
        status: "saved",
      }),
    ]);
  });
});
