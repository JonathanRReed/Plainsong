import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  value: string;
  /** Called with a trimmed, non-empty title. Rejecting it restores the old one. */
  onCommit: (nextTitle: string) => Promise<void> | void;
  className?: string;
  disabled?: boolean;
}

/**
 * The meeting's name, edited where it is read. Enter or blur commits; Escape
 * puts the stored title back. An empty title is never committed — a meeting
 * with no name cannot be found again.
 */
export function EditableTitle({ value, onCommit, className, disabled = false }: EditableTitleProps) {
  const [draft, setDraft] = useState(value);
  // Escape cancels by blurring, and that blur fires inside the same handler —
  // before React has re-rendered with the restored draft. A flag the blur
  // handler can read is the only thing that survives that gap; reading state
  // there means reading the abandoned edit and renaming the meeting with it.
  const abandonedRef = useRef(false);

  // The title also changes from elsewhere (auto-naming, the rename dialog).
  // Follow it unless the user is mid-edit on this input.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (abandonedRef.current) {
      abandonedRef.current = false;
      setDraft(value);
      return;
    }
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    void onCommit(next);
  };

  return (
    <input
      aria-label="Meeting title"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          abandonedRef.current = true;
          setDraft(value);
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
  );
}
