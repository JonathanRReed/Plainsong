import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { invoke, listen } from "@/lib/electron";
import { formatDateTime } from "@/lib/format-locale";

/** Mirrors `PendingDictationRecovery` in `rust-sidecar/src/dictation_checkpoint.rs`. */
export interface PendingDictationRecovery {
  stage: "stopped" | "recognized" | "delivering";
  savedAtMs: number;
  bytes: number;
}

function isPendingDictationRecovery(value: unknown): value is PendingDictationRecovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingDictationRecovery>;
  return (
    (candidate.stage === "stopped" || candidate.stage === "recognized" || candidate.stage === "delivering") &&
    typeof candidate.savedAtMs === "number" &&
    Number.isFinite(candidate.savedAtMs)
  );
}

interface RecoveredDictation {
  text: string;
  stage: PendingDictationRecovery["stage"];
  savedAtMs: number;
}

/** What the banner says about how far the unfinished dictation got. */
export function describePendingDictationRecovery(pending: PendingDictationRecovery): string {
  const when = formatDateTime(pending.savedAtMs);
  const base = `Plainsong could not finish a dictation from ${when}. Its audio was kept on this Mac so you can get the words back.`;
  return pending.stage === "delivering"
    ? `${base} It may already have been inserted, so check the app before you paste it again.`
    : `${base} The words were not inserted anywhere.`;
}

/**
 * "Recover last dictation": a dictation the previous run could not finish.
 * Recovery transcribes the kept audio again and shows the words
 * with Copy and Discard. Nothing is inserted automatically.
 */
export function DictationRecoveryBanner() {
  const [pending, setPending] = useState<PendingDictationRecovery | null>(null);
  const [recovered, setRecovered] = useState<RecoveredDictation | null>(null);
  const [busy, setBusy] = useState<"recover" | "copy" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const refresh = () => {
      void invoke<unknown>("get_pending_dictation_recovery")
        .then((value) => {
          if (mountedRef.current && isPendingDictationRecovery(value)) {
            setPending(value);
            setRecovered(null);
            setCopied(false);
            setError(null);
          }
        })
        .catch(() => undefined);
    };
    const subscription = listen("dictation-recovery-available", refresh);
    void subscription.then(refresh);
    return () => {
      mountedRef.current = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  const recover = useCallback(async () => {
    setBusy("recover");
    setError(null);
    try {
      const value = await invoke<RecoveredDictation>("recover_pending_dictation");
      if (mountedRef.current) setRecovered(value);
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Couldn't recover the dictation. Try again.");
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const showNext = useCallback(async () => {
    const next = await invoke<unknown>("get_pending_dictation_recovery");
    setPending(isPendingDictationRecovery(next) ? next : null);
    setRecovered(null);
    setCopied(false);
  }, []);

  const discard = useCallback(async () => {
    setBusy("discard");
    setError(null);
    try {
      await invoke("discard_pending_dictation_recovery");
      if (mountedRef.current) {
        await showNext();
      }
    } catch {
      if (mountedRef.current) setError("Couldn't discard the dictation. Try again.");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [showNext]);

  const copy = useCallback(async () => {
    if (!recovered) return;
    setBusy("copy");
    setError(null);
    try {
      await navigator.clipboard.writeText(recovered.text);
      // Copied is the outcome: the kept audio is no longer needed.
      await invoke("discard_pending_dictation_recovery").catch(() => undefined);
      if (mountedRef.current) setCopied(true);
    } catch {
      if (mountedRef.current) setError("Couldn't copy the words. Select them and copy by hand.");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [recovered]);

  if (!pending) return null;

  if (copied) {
    return (
      <StatusBanner
        tone="muted"
        role="status"
        title="Recovered dictation copied"
        message="The words are on your clipboard, and the kept audio was deleted."
        actions={<Button size="sm" variant="ghost" onClick={() => { void showNext().catch(() => setPending(null)); }}>Close</Button>}
      />
    );
  }

  return (
    <StatusBanner
      tone="rust"
      role="status"
      title="Recover last dictation"
      message={
        <>
          <p>{describePendingDictationRecovery(pending)}</p>
          {recovered ? (
            <p
              aria-label="Recovered words"
              className="manuscript mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/80 bg-background/80 px-3 py-2 text-foreground select-text"
            >
              {recovered.text}
            </p>
          ) : null}
          {error ? <p role="alert" className="mt-2 text-sm">{error}</p> : null}
        </>
      }
      actions={
        <>
          {recovered ? (
            <Button size="sm" disabled={busy !== null} onClick={() => { void copy(); }}>
              {busy === "copy" ? "Copying…" : "Copy"}
            </Button>
          ) : (
            <Button size="sm" disabled={busy !== null} onClick={() => { void recover(); }}>
              {busy === "recover" ? "Transcribing…" : "Recover last dictation"}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void discard(); }}>
            {busy === "discard" ? "Discarding…" : "Discard"}
          </Button>
        </>
      }
    />
  );
}
