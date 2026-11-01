import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/playback";
import type { TranscriptSegment } from "@/types";

/**
 * Microphone lines of a Me + Them meeting that were the other side heard
 * through the Mac's speakers. The sidecar keeps them out of the transcript,
 * search and summaries, so the other person's words are not shown twice or
 * put in the user's mouth, but it never deletes them: a wrong call must stay
 * checkable. This is where they can be seen.
 */
export function HeardThroughSpeakers({
  segments,
  onSelect,
}: {
  segments: TranscriptSegment[] | undefined;
  onSelect?: (segment: TranscriptSegment) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!segments || segments.length === 0) {
    return null;
  }
  const count = segments.length;
  const listId = "heard-through-speakers";
  return (
    <div className="mt-3 shrink-0 text-sm text-muted-foreground" data-testid="heard-through-speakers">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {count === 1 ? "1 microphone line" : `${count} microphone lines`} matched what the other
          side said through your speakers, so {count === 1 ? "it is" : "they are"} left out of the
          transcript.
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto px-1.5 py-0.5 underline-offset-2 hover:underline"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open ? (
        <ul id={listId} className="mt-2 space-y-1 border-l pl-3">
          {segments.map((segment) => (
            <li key={segment.id}>
              <button
                type="button"
                className="text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect?.(segment)}
              >
                <span className="mr-2 tabular-nums">{formatClock(segment.startTime)}</span>
                <span className="italic">{segment.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
