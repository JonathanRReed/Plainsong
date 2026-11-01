import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LocalDictationDraft } from "@/hooks/use-dictation-drafts";

interface UnfinishedDictationEditsProps {
  drafts: LocalDictationDraft[];
  loading: boolean;
  error: string | null;
  onResume: (draft: LocalDictationDraft) => void;
  onDiscard: (draft: LocalDictationDraft) => void;
  onRetry?: () => void;
  onRetryDraft?: (draft: LocalDictationDraft) => void;
  onCopyStart?: () => void;
}

interface CopyStatus {
  recordingId: string;
  text: string;
  result: "success" | "error";
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}

function statusLabel(draft: LocalDictationDraft): string {
  if (draft.status === "saved") return "Saved locally";
  if (draft.status === "pending") return "Saving locally…";
  return "Couldn't save locally";
}

export function UnfinishedDictationEdits({
  drafts,
  loading,
  error,
  onResume,
  onDiscard,
  onRetry,
  onRetryDraft,
  onCopyStart,
}: UnfinishedDictationEditsProps) {
  const mountedRef = useRef(true);
  const copyEpochRef = useRef(0);
  const copyBusyRef = useRef(false);
  const latestDraftsRef = useRef(new Map<string, string>());
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [openDrafts, setOpenDrafts] = useState(() => new Set<string>());
  const [pendingDiscard, setPendingDiscard] = useState<LocalDictationDraft | null>(null);
  const keepDraftRef = useRef<HTMLButtonElement>(null);
  const discardSelectionRef = useRef<LocalDictationDraft | null>(null);
  const discardUnchanged = pendingDiscard !== null && drafts.some((draft) =>
    draft.recordingId === pendingDiscard.recordingId && draft.text === pendingDiscard.text
  );

  latestDraftsRef.current = new Map(
    drafts.map((draft) => [draft.recordingId, draft.text]),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyEpochRef.current += 1;
    };
  }, []);

  const copyDraft = async (draft: LocalDictationDraft) => {
    if (copyBusyRef.current || !draft.text.trim()) return;

    const snapshot = draft.text;
    const epoch = ++copyEpochRef.current;
    copyBusyRef.current = true;
    setCopyBusy(true);
    setCopyStatus(null);

    try {
      onCopyStart?.();
      await navigator.clipboard.writeText(snapshot);
      if (
        mountedRef.current &&
        copyEpochRef.current === epoch &&
        latestDraftsRef.current.get(draft.recordingId) === snapshot
      ) {
        setCopyStatus({
          recordingId: draft.recordingId,
          text: snapshot,
          result: "success",
        });
      }
    } catch {
      if (
        mountedRef.current &&
        copyEpochRef.current === epoch &&
        latestDraftsRef.current.get(draft.recordingId) === snapshot
      ) {
        setCopyStatus({
          recordingId: draft.recordingId,
          text: snapshot,
          result: "error",
        });
      }
    } finally {
      copyBusyRef.current = false;
      if (mountedRef.current) {
        setCopyBusy(false);
      }
    }
  };

  if (!loading && !error && drafts.length === 0) return null;

  return (
    <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        Unfinished edits{drafts.length > 0 ? ` (${drafts.length})` : ""}
      </summary>

      <div className="mt-3 space-y-3">
        {loading && drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading unfinished edits…
          </p>
        ) : null}

        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
            <p className="text-sm text-rust">{error}</p>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        {drafts.map((draft) => (
          <article
            key={draft.recordingId}
            className="space-y-2 rounded-md border border-border/60 bg-background/70 p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-foreground">
                  {draft.title}
                </h3>
                <p
                  className={
                    draft.status === "error"
                      ? "text-xs text-rust"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {statusLabel(draft)}
                </p>
              </div>
              <div className="flex gap-2">
                {draft.status === "error" && onRetryDraft ? <Button type="button" variant="outline" size="sm"
                  onClick={() => onRetryDraft(draft)}>Retry save</Button> : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onResume(draft)}
                >
                  Resume
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { discardSelectionRef.current = draft; setPendingDiscard(draft); }}
                >
                  Discard
                </Button>
              </div>
            </div>
            <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {snippet(draft.text) || "Empty edit"}
            </p>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <details
                className="min-w-0 flex-1"
                open={openDrafts.has(draft.recordingId)}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  setOpenDrafts((current) => {
                    const next = new Set(current);
                    if (isOpen) next.add(draft.recordingId);
                    else next.delete(draft.recordingId);
                    return next;
                  });
                }}
              >
                <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
                  View full draft
                </summary>
                {openDrafts.has(draft.recordingId) ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                    {draft.text}
                  </pre>
                ) : null}
              </details>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={copyBusy || !draft.text.trim()}
                onClick={() => void copyDraft(draft)}
              >
                Copy draft
              </Button>
            </div>
            {copyStatus?.recordingId === draft.recordingId &&
            copyStatus.text === draft.text ? (
              <p
                className={
                  copyStatus.result === "error"
                    ? "text-xs text-rust"
                    : "text-xs text-muted-foreground"
                }
                role={copyStatus.result === "error" ? "alert" : "status"}
              >
                {copyStatus.result === "success"
                  ? "Draft copied."
                  : "Couldn't copy the draft. Open View full draft and copy the text manually."}
              </p>
            ) : null}
            {draft.status === "error" && draft.error ? (
              <p className="text-xs text-rust">{draft.error}</p>
            ) : null}
          </article>
        ))}
      </div>
      <Dialog open={pendingDiscard !== null} onOpenChange={(open) => {
        if (!open) { discardSelectionRef.current = null; setPendingDiscard(null); }
      }}>
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); keepDraftRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Discard this unfinished edit?</DialogTitle>
            <DialogDescription>
              The unfinished words in "{pendingDiscard?.title}" will be removed from recovery. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm">{pendingDiscard?.text}</pre>
          {!discardUnchanged && <p role="alert" className="text-sm text-rust">This draft changed or is no longer available. Keep it and review the current draft.</p>}
          <DialogFooter>
            <Button ref={keepDraftRef} variant="outline" onClick={() => { discardSelectionRef.current = null; setPendingDiscard(null); }}>Keep draft</Button>
            <Button variant="destructive" disabled={!discardUnchanged} onClick={() => {
              if (!pendingDiscard || discardSelectionRef.current !== pendingDiscard ||
                  latestDraftsRef.current.get(pendingDiscard.recordingId) !== pendingDiscard.text) return;
              discardSelectionRef.current = null;
              copyEpochRef.current += 1;
              setCopyStatus(null);
              onDiscard(pendingDiscard);
              setPendingDiscard(null);
            }}>Discard unfinished edit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </details>
  );
}
