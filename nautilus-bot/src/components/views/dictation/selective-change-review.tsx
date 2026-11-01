import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { dictationChangeSelections, restoreDictationChange, usesCoarseDictationReview, type DictationChangeSelection } from "@/lib/dictation-change-selections";

interface SelectiveChangeReviewProps {
  original: string;
  current: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  originalLabel?: string;
  currentLabel?: string;
}

function ChangePassage({ change, text, removed, label }: { change: DictationChangeSelection; text: string; removed: string; label: string }) {
  return <pre aria-label={`${label} passage`} className="whitespace-pre-wrap break-words font-sans text-sm">
    {change.contextBeforeTruncated && <span aria-label="Earlier context omitted">…</span>}
    {change.contextBefore}
    {/* A removal shows the words that went, struck through, so the passage
        still reads as a sentence instead of naming an empty slot. */}
    {!text && removed
      ? <del aria-label={`${label} removed text`} className="text-muted-foreground line-through decoration-2">{removed}</del>
      : <mark aria-label={`${label} changed text`} className="rounded-sm bg-muted px-0.5 font-semibold underline decoration-2 underline-offset-2">{text || <span className="text-xs italic">No text</span>}</mark>}
    {change.contextAfter}
    {change.contextAfterTruncated && <span aria-label="Later context omitted">…</span>}
  </pre>;
}

export function SelectiveChangeReview({ original, current, onChange, disabled = false, originalLabel = "Original", currentLabel = "Your edit" }: SelectiveChangeReviewProps) {
  const changes = useMemo(() => dictationChangeSelections(original, current), [original, current]);
  const coarseReview = useMemo(() => usesCoarseDictationReview(original, current), [original, current]);
  const [undo, setUndo] = useState<{ before: string; after: string; original: string } | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ trigger: HTMLButtonElement; expected: string; original: string; target: "undo" | "summary" } | null>(null);
  useLayoutEffect(() => {
    const intent = pendingFocus.current;
    pendingFocus.current = null;
    if (!intent || disabled || current !== intent.expected || original !== intent.original) return;
    const document = intent.trigger.ownerDocument;
    if (document.activeElement !== intent.trigger && document.activeElement !== document.body) return;
    (intent.target === "undo" ? undoButton.current : summary.current)?.focus();
  });
  useEffect(() => {
    if (undo && (current !== undo.after || original !== undo.original)) setUndo(null);
  }, [current, original, undo]);
  const canUndo = undo !== null && current === undo.after && original === undo.original;

  if (changes.length === 0 && !canUndo) return null;

  return (
    <details className="rounded-md border bg-muted/20 p-3">
      <summary ref={summary} className="cursor-pointer text-sm font-medium">Restore individual changes</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">Restore one change from the original text while keeping your other edits. Underlined text is the change; nearby words provide context. Review the words before saving.</p>
        {coarseReview && <p className="text-xs text-muted-foreground">This long dictation is reviewed as one changed passage. Restoring it replaces every edit shown in that passage.</p>}
        {changes.map((change, index) => (
          <div key={`${change.start}:${change.end}:${index}`} className="space-y-2 rounded-md border bg-background p-3">
            <p className="text-xs font-medium">Change {index + 1}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">{originalLabel}</p><ChangePassage change={change} text={change.original} removed="" label={originalLabel} /></div>
              <div><p className="text-xs text-muted-foreground">{currentLabel}</p><ChangePassage change={change} text={change.current} removed={change.original} label={currentLabel} /></div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={disabled}
              aria-label={`Restore change ${index + 1}`}
              onClick={event => {
                const after = restoreDictationChange(current, change);
                const trigger = event.currentTarget;
                pendingFocus.current = trigger.ownerDocument.activeElement === trigger
                  ? { trigger, expected: after, original, target: "undo" }
                  : null;
                setUndo({ before: current, after, original });
                onChange(after);
              }}>Restore this change</Button>
          </div>
        ))}
        {canUndo && <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-xs text-muted-foreground">Change restored in the editor.</p>
          <Button ref={undoButton} type="button" variant="ghost" size="sm" disabled={disabled} onClick={event => {
            if (!undo) return;
            const trigger = event.currentTarget;
            pendingFocus.current = trigger.ownerDocument.activeElement === trigger
              ? { trigger, expected: undo.before, original, target: "summary" }
              : null;
            onChange(undo.before);
            setUndo(null);
          }}>Undo restoration</Button>
        </div>}
      </div>
    </details>
  );
}
