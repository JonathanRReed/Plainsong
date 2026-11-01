import { forwardRef, useEffect, useImperativeHandle, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface EditableTitleHandle {
  commit: () => Promise<boolean>;
  revision: () => number;
}

interface EditableTitleProps {
  value: string;
  /** Called with a trimmed, non-empty title. Rejecting it keeps the draft for a retry. */
  onCommit: (nextTitle: string) => Promise<void> | void;
  className?: string;
  disabled?: boolean;
}

/**
 * The meeting's name, edited where it is read. Enter or blur commits; Escape
 * puts the stored title back. An empty title is never committed — a meeting
 * with no name cannot be found again.
 */
export const EditableTitle = forwardRef<EditableTitleHandle, EditableTitleProps>(function EditableTitle(
  { value, onCommit, className, disabled = false }, ref
) {
  const [draft, setDraft] = useState(value);
  const [saveFailed, setSaveFailed] = useState(false);
  const saveErrorId = useId();
  // Escape cancels by blurring, and that blur fires inside the same handler —
  // before React has re-rendered with the restored draft. A flag the blur
  // handler can read is the only thing that survives that gap; reading state
  // there means reading the abandoned edit and renaming the meeting with it.
  const abandonedRef = useRef(false);
  const draftRef = useRef(value);
  const savedValueRef = useRef(value);
  savedValueRef.current = value;
  const dirtyRef = useRef(false);
  const editRevision = useRef(0);
  const pendingCommit = useRef<{ title: string; revision: number; completion: Promise<boolean> } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const updateDraft = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };

  // The title also changes from elsewhere (auto-naming, the rename dialog).
  // Follow it unless the user is mid-edit on this input.
  useEffect(() => {
    if (!dirtyRef.current) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);

  const commit = async () => {
    if (abandonedRef.current) {
      abandonedRef.current = false;
      dirtyRef.current = false;
      updateDraft(savedValueRef.current);
      setSaveFailed(false);
      return true;
    }
    if (!dirtyRef.current && !pendingCommit.current) return true;
    const next = draftRef.current.trim();
    if (!next || (next === savedValueRef.current && !pendingCommit.current)) {
      dirtyRef.current = false;
      updateDraft(savedValueRef.current);
      setSaveFailed(false);
      return true;
    }
    if (pendingCommit.current?.title === next) {
      pendingCommit.current.revision = editRevision.current;
      return pendingCommit.current.completion;
    }
    setSaveFailed(false);
    const commitment = { title: next, revision: editRevision.current, completion: Promise.resolve(true) };
    pendingCommit.current = commitment;
    commitment.completion = (async () => {
      try {
        await onCommit(next);
        if (mountedRef.current && editRevision.current === commitment.revision) {
          dirtyRef.current = false;
          setSaveFailed(false);
          updateDraft(next);
          return true;
        }
        return false;
      } catch {
        if (mountedRef.current && editRevision.current === commitment.revision) {
          // Keep the name the user typed. The next navigation or blur must
          // retry this draft rather than treating the failed save as clean.
          dirtyRef.current = true;
          setSaveFailed(true);
        }
        return false;
      } finally {
        if (pendingCommit.current === commitment) pendingCommit.current = null;
      }
    })();
    return commitment.completion;
  };

  useImperativeHandle(ref, () => ({ commit, revision: () => editRevision.current }));

  return (
    <>
    <input
      aria-label="Meeting title"
      aria-invalid={saveFailed || undefined}
      aria-describedby={saveFailed ? saveErrorId : undefined}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        editRevision.current += 1;
        dirtyRef.current = true;
        setSaveFailed(false);
        updateDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setSaveFailed(false);
          abandonedRef.current = true;
          dirtyRef.current = false;
          editRevision.current += 1;
          updateDraft(savedValueRef.current);
          event.currentTarget.blur();
          // A blur only fires when the input actually had focus. Clear the flag
          // here too so an Escape on an unfocused input cannot poison the next
          // real commit.
          abandonedRef.current = false;
        }
      }}
      className={cn(
        "w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-2 py-1 font-serif text-2xl font-semibold tracking-tight text-foreground",
        "hover:border-border/70 focus:border-border focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring",
        className
      )}
    />
    {saveFailed && <span id={saveErrorId} role="alert" className="block font-sans text-xs font-normal tracking-normal text-rust">
      Could not save the title. Your edit is still here. Press Enter to retry.
    </span>}
    </>
  );
});
