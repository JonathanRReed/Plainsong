import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearDictationDraft as clearStoredDictationDraft,
  listDictationDrafts,
  saveDictationDraft as saveStoredDictationDraft,
  type DictationDraft,
} from "@/lib/backend/dictation-drafts";

export type DictationDraftStatus = "pending" | "saved" | "error";

export interface LocalDictationDraft extends DictationDraft {
  status: DictationDraftStatus;
  error?: string;
}

interface DraftEntry extends LocalDictationDraft {
  revision: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useDictationDrafts() {
  const entriesRef = useRef(new Map<string, DraftEntry>());
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const revisionRef = useRef(0);
  const removedRevisionsRef = useRef(new Map<string, number>());
  const refreshEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const [drafts, setDrafts] = useState<LocalDictationDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback((entries: Map<string, DraftEntry>) => {
    entriesRef.current = entries;
    if (!mountedRef.current) return;
    setDrafts(
      Array.from(entries.values(), ({ revision: _revision, ...draft }) => draft),
    );
  }, []);

  const updateEntry = useCallback(
    (
      recordingId: string,
      update: (entry: DraftEntry | undefined) => DraftEntry | null,
    ) => {
      const next = new Map(entriesRef.current);
      const updated = update(next.get(recordingId));
      if (updated) next.set(recordingId, updated);
      else if (next.delete(recordingId)) {
        removedRevisionsRef.current.set(recordingId, ++revisionRef.current);
      }
      publish(next);
    },
    [publish],
  );

  const enqueue = useCallback(<T,>(recordingId: string, task: () => Promise<T>) => {
    const previous = queuesRef.current.get(recordingId);
    const result = previous
      ? previous.catch(() => undefined).then(task)
      : task();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queuesRef.current.set(recordingId, tail);
    void tail.finally(() => {
      if (queuesRef.current.get(recordingId) === tail) {
        queuesRef.current.delete(recordingId);
      }
    });
    return result;
  }, []);

  const refresh = useCallback(async () => {
    const epoch = ++refreshEpochRef.current;
    const isCurrent = () => mountedRef.current && refreshEpochRef.current === epoch;
    const refreshStartedAtRevision = revisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const stored = await listDictationDrafts();
      if (!isCurrent()) return;
      const merged = new Map<string, DraftEntry>();
      for (const draft of stored) {
        // A list started before removal can still contain the discarded copy.
        if ((removedRevisionsRef.current.get(draft.recordingId) ?? 0) > refreshStartedAtRevision) continue;
        merged.set(draft.recordingId, {
          ...draft,
          status: "saved",
          revision: 0,
        });
      }
      for (const [recordingId, local] of entriesRef.current) {
        const hasQueuedWrite = queuesRef.current.has(recordingId);
        if (
          local.revision > 0 &&
          (local.status !== "saved" ||
            hasQueuedWrite ||
            local.revision > refreshStartedAtRevision)
        ) {
          merged.set(recordingId, {
            ...local,
            title: merged.get(recordingId)?.title ?? local.title,
          });
        }
      }
      publish(merged);
    } catch (caught) {
      if (isCurrent()) {
        setError(errorMessage(caught, "Couldn't load unfinished edits."));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [publish]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      ++refreshEpochRef.current;
    };
  }, [refresh]);

  const saveDraft = useCallback(
    (recordingId: string, text: string, expectedSavedText: string | null) => {
      const revision = ++revisionRef.current;
      const existing = entriesRef.current.get(recordingId);
      updateEntry(recordingId, () => ({
        recordingId,
        title: existing?.title ?? "Untitled dictation",
        text,
        expectedSavedText,
        status: "pending",
        revision,
      }));

      return enqueue(recordingId, async () => {
        const queuedDraft = entriesRef.current.get(recordingId);
        if (queuedDraft?.revision !== revision) {
          return false;
        }
        const payloadText = queuedDraft.text;
        const payloadExpectedSavedText = queuedDraft.expectedSavedText;
        try {
          await saveStoredDictationDraft(
            recordingId,
            payloadText,
            payloadExpectedSavedText,
          );
          updateEntry(recordingId, (current) =>
            current?.revision === revision
              ? { ...current, status: "saved", error: undefined }
              : current ?? null,
          );
          return true;
        } catch (caught) {
          updateEntry(recordingId, (current) =>
            current?.revision === revision
              ? {
                  ...current,
                  status: "error",
                  error: errorMessage(caught, "Couldn't save this edit."),
                }
              : current ?? null,
          );
          return false;
        }
      });
    },
    [enqueue, updateEntry],
  );

  const retryDraft = useCallback(
    (recordingId: string) => {
      const current = entriesRef.current.get(recordingId);
      if (!current || current.status !== "error") {
        return Promise.resolve(false);
      }
      return saveDraft(recordingId, current.text, current.expectedSavedText);
    },
    [saveDraft],
  );

  const waitForQueuedWrites = useCallback(async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      const queuedWrites = Array.from(queuesRef.current.values());
      if (queuedWrites.length === 0) return true;
      await Promise.all(queuedWrites);
      await Promise.resolve();
    }
    return queuesRef.current.size === 0;
  }, []);

  const flush = useCallback(async () => {
    if (!(await waitForQueuedWrites())) return false;

    const failedRecordingIds = Array.from(entriesRef.current.values())
      .filter((draft) => draft.status === "error")
      .map((draft) => draft.recordingId);
    if (failedRecordingIds.length > 0) {
      await Promise.all(
        failedRecordingIds.map((recordingId) => retryDraft(recordingId)),
      );
    }

    if (!(await waitForQueuedWrites())) return false;
    return Array.from(entriesRef.current.values()).every(
      (draft) => draft.status === "saved",
    );
  }, [retryDraft, waitForQueuedWrites]);

  const clearDraft = useCallback(
    (recordingId: string, expectedDraftText: string) => {
      const current = entriesRef.current.get(recordingId);
      if (!current || current.text !== expectedDraftText) {
        return Promise.resolve(false);
      }
      const revision = current.revision;

      return enqueue(recordingId, async () => {
        try {
          const cleared = await clearStoredDictationDraft(
            recordingId,
            expectedDraftText,
          );
          if (cleared) {
            updateEntry(recordingId, (latest) =>
              latest?.revision === revision && latest.text === expectedDraftText
                ? null
                : latest ?? null,
            );
          }
          return cleared;
        } catch (caught) {
          updateEntry(recordingId, (latest) =>
            latest?.revision === revision && latest.text === expectedDraftText
              ? {
                  ...latest,
                  status: "error",
                  error: errorMessage(caught, "Couldn't discard this edit."),
                }
              : latest ?? null,
          );
          return false;
        }
      });
    },
    [enqueue, updateEntry],
  );

  const forgetDraft = useCallback(
    (recordingId: string) => {
      updateEntry(recordingId, () => null);
    },
    [updateEntry],
  );

  const acknowledgeSavedEdit = useCallback(
    (
      recordingId: string,
      savedDraftText: string,
      expectedOldBase: string | null,
      newSavedEdit: string | null,
    ) => {
      const current = entriesRef.current.get(recordingId);
      if (!current) return Promise.resolve(false);
      if (current.text === savedDraftText) {
        const revision = current.revision;
        return enqueue(recordingId, async () => {
          try {
            const cleared = await clearStoredDictationDraft(
              recordingId,
              savedDraftText,
            );
            let removedExactRevision = false;
            updateEntry(recordingId, (latest) => {
              if (
                latest?.revision === revision &&
                latest.text === savedDraftText
              ) {
                removedExactRevision = true;
                return null;
              }
              return latest ?? null;
            });
            if (cleared) return true;
            if (!removedExactRevision) return false;
            await refresh();
            return true;
          } catch (caught) {
            let removedExactRevision = false;
            updateEntry(recordingId, (latest) => {
              if (
                latest?.revision === revision &&
                latest.text === savedDraftText
              ) {
                removedExactRevision = true;
                return null;
              }
              return latest ?? null;
            });
            if (removedExactRevision) await refresh();
            if (mountedRef.current) {
              setError(
                errorMessage(
                  caught,
                  "Saved the edit, but couldn't clean up its recovery copy.",
                ),
              );
            }
            return true;
          }
        });
      }
      if (current.expectedSavedText !== expectedOldBase) {
        return Promise.resolve(false);
      }
      return saveDraft(recordingId, current.text, newSavedEdit);
    },
    [enqueue, refresh, saveDraft, updateEntry],
  );

  return {
    drafts,
    loading,
    error,
    refresh,
    saveDraft,
    retryDraft,
    flush,
    clearDraft,
    acknowledgeSavedEdit,
    forgetDraft,
  };
}
