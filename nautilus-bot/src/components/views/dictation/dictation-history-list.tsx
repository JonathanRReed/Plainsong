import { useEffect, useRef, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format-locale";
import {
  DICTATION_HISTORY_PAGE_SIZE,
  dictationHistoryAppName,
  dictationHistoryPreview,
  dictationHistoryStatusLabel,
  formatHistoryTime,
  groupDictationHistory,
} from "@/lib/dictation-history-groups";
import type { Recording } from "@/types";

interface DictationHistoryListProps {
  recordings: Recording[];
  isLoading: boolean;
  formatDuration: (seconds: number) => string;
  onOpen: (recording: Recording) => void;
  /** Resolves true once the words are on the clipboard. */
  onCopy: (recording: Recording) => Promise<boolean>;
  onDelete: (recording: Recording) => void;
}

const COPIED_CONFIRMATION_MS = 1600;

export function DictationHistoryList({
  recordings,
  isLoading,
  formatDuration,
  onOpen,
  onCopy,
  onDelete,
}: DictationHistoryListProps) {
  const [visibleCount, setVisibleCount] = useState(DICTATION_HISTORY_PAGE_SIZE);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
    },
    [],
  );

  const visible = recordings.slice(0, visibleCount);
  const groups = groupDictationHistory(visible);
  const remaining = recordings.length - visible.length;

  const handleCopy = async (recording: Recording) => {
    if (!(await onCopy(recording))) {
      return;
    }
    if (copiedTimer.current !== null) {
      window.clearTimeout(copiedTimer.current);
    }
    setCopiedId(recording.id);
    copiedTimer.current = window.setTimeout(() => {
      setCopiedId(null);
      copiedTimer.current = null;
    }, COPIED_CONFIRMATION_MS);
  };

  if (isLoading) {
    return (
      <div role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading dictation history…</span>
        <div className="space-y-2" aria-hidden="true">
          <div className="animate-pulse-subtle h-3 w-16 rounded-sm bg-muted/60" />
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-2 rounded-md border px-3 py-3">
              <div
                className="animate-pulse-subtle h-3.5 rounded-sm bg-muted/50"
                style={{ width: `${88 - index * 14}%` }}
              />
              <div className="animate-pulse-subtle h-3 w-24 rounded-sm bg-muted/40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (recordings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved dictations yet. If auto-delete is set to Immediate, history is
        intentionally not retained.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <span role="status" aria-live="polite" className="sr-only">
        {copiedId ? "Copied to the clipboard" : ""}
      </span>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} className="space-y-1.5">
          <h3 className="rubric-muted px-1">{group.label}</h3>
          <ul className="divide-y divide-border/60 rounded-md border">
            {group.recordings.map((recording) => {
              const app = dictationHistoryAppName(recording);
              const status = dictationHistoryStatusLabel(recording.status);
              const copied = copiedId === recording.id;
              return (
                <li
                  key={recording.id}
                  className="group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40 focus-within:bg-muted/40"
                >
                  <button
                    type="button"
                    aria-label={`Open saved dictation: ${recording.title}`}
                    className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => onOpen(recording)}
                  >
                    <p className="line-clamp-2 text-sm text-foreground">
                      {dictationHistoryPreview(recording)}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      <span className="time-spec">
                        {formatHistoryTime(recording.createdAt)}
                      </span>
                      {app ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{app}</span>
                        </>
                      ) : null}
                      <span aria-hidden="true">·</span>
                      <span className="time-spec">
                        {formatDuration(recording.duration)}
                      </span>
                      {status ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span
                            className={cn(
                              recording.status === "error" && "text-rust",
                            )}
                          >
                            {status}
                          </span>
                        </>
                      ) : null}
                    </p>
                  </button>
                  {/* Out of the way until the row is pointed at or tabbed
                      into; still in the tab order, so the keyboard reaches
                      them without a mouse. */}
                  <div
                    className={cn(
                      "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
                      copied && "opacity-100",
                    )}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Copy ${recording.title}`}
                      onClick={() => void handleCopy(recording)}
                    >
                      {copied ? (
                        <Check aria-hidden="true" className="text-gold-text" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-rust"
                      aria-label={`Delete ${recording.title}`}
                      title="Delete"
                      onClick={() => onDelete(recording)}
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {remaining > 0 ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-sm text-muted-foreground">
            Showing {formatNumber(visible.length)} of{" "}
            {formatNumber(recordings.length)}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setVisibleCount((count) => count + DICTATION_HISTORY_PAGE_SIZE)
            }
          >
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
