import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { diffDictationText } from "@/lib/dictation-text-diff";

interface DictationChangeReviewProps {
  original: string;
  current: string;
  originalLabel?: string;
  /** What the right-hand text is: the reader's own edit unless said otherwise. */
  currentLabel?: string;
  onRestoreOriginal?: () => void;
}

export function DictationChangeReview({
  original,
  current,
  originalLabel = "Original",
  currentLabel = "Your edit",
  onRestoreOriginal,
}: DictationChangeReviewProps) {
  const parts = useMemo(
    () => diffDictationText(original, current),
    [original, current],
  );

  if (original === current) return null;

  return (
    <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        Review changes
      </summary>

      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-rust/35" />
            <span>{originalLabel}</span>
            <span className="sr-only">:</span>
            <span>Removed</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-gold/35" />
            <span>{currentLabel}</span>
            <span className="sr-only">:</span>
            <span>Added</span>
          </span>
        </div>

        <div className="sr-only">
          <p>{originalLabel}: {original || "No text."}</p>
          <p>{currentLabel}: {current || "No text."}</p>
        </div>

        <p aria-hidden="true" className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
          {parts.map((part, index) => {
            if (part.type === "removed") {
              return (
                <del
                  key={index}
                  className="rounded-sm bg-rust/10 px-0.5 text-rust decoration-rust/60"
                >
                  {part.text}
                </del>
              );
            }
            if (part.type === "added") {
              return (
                <ins
                  key={index}
                  className="rounded-sm bg-gold/10 px-0.5 text-gold-text no-underline"
                >
                  {part.text}
                </ins>
              );
            }
            return <span key={index}>{part.text}</span>;
          })}
        </p>

        {onRestoreOriginal ? (
          <Button type="button" variant="outline" size="sm" onClick={onRestoreOriginal}>
            Restore original
          </Button>
        ) : null}
      </div>
    </details>
  );
}
