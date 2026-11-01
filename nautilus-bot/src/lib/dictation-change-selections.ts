import { diffDictationText } from "@/lib/dictation-text-diff";

export interface DictationChangeSelection {
  start: number;
  end: number;
  original: string;
  current: string;
  contextBefore: string;
  contextAfter: string;
  contextBeforeTruncated: boolean;
  contextAfterTruncated: boolean;
}

const MAX_CONTEXT_CODE_POINTS = 80;

function reviewContext(text: string, side: "before" | "after"): string {
  // Slice a bounded UTF-16 window before counting code points. The extra
  // code units keep a cut surrogate pair outside the returned window.
  const windowSize = MAX_CONTEXT_CODE_POINTS * 2 + 2;
  const window = side === "before" ? text.slice(-windowSize) : text.slice(0, windowSize);
  const points = Array.from(window);
  const sliced = (side === "before" ? points.slice(-MAX_CONTEXT_CODE_POINTS) : points.slice(0, MAX_CONTEXT_CODE_POINTS)).join("");
  if (sliced.length === text.length) return sliced;
  // A cut inside a word reads as a typo ("…t well and"), so drop the partial
  // word when whole words remain. Text without spaces keeps the hard cut.
  if (side === "before") {
    const outside = text[text.length - sliced.length - 1] ?? "";
    if (/\s/.test(outside) || /^\s/.test(sliced)) return sliced;
    const trimmed = sliced.slice(sliced.search(/\s/) + 1);
    return sliced.search(/\s/) >= 0 && trimmed.trim() ? trimmed : sliced;
  }
  const outside = text[sliced.length] ?? "";
  if (/\s/.test(outside) || /\s$/.test(sliced)) return sliced;
  const cut = sliced.search(/\s\S*$/);
  return cut >= 0 && sliced.slice(0, cut).trim() ? sliced.slice(0, cut + 1) : sliced;
}

/** Adjacent additions and removals form one reviewable edit. */
export function dictationChangeSelections(original: string, current: string): DictationChangeSelection[] {
  const changes: DictationChangeSelection[] = [];
  let offset = 0;
  let pending: DictationChangeSelection | null = null;
  let previousEqual = "";
  for (const part of diffDictationText(original, current)) {
    if (part.type === "equal") {
      if (pending) {
        pending.contextAfter = reviewContext(part.text, "after");
        pending.contextAfterTruncated = pending.contextAfter.length < part.text.length;
        changes.push(pending);
      }
      pending = null;
      previousEqual = part.text;
      offset += part.text.length;
      continue;
    }
    if (!pending) {
      const contextBefore = reviewContext(previousEqual, "before");
      pending = {
        start: offset, end: offset, original: "", current: "",
        contextBefore,
        contextAfter: "",
        contextBeforeTruncated: contextBefore.length < previousEqual.length,
        contextAfterTruncated: false,
      };
    }
    if (part.type === "removed") pending.original += part.text;
    else {
      pending.current += part.text;
      offset += part.text.length;
      pending.end = offset;
    }
  }
  if (pending) changes.push(pending);
  return changes;
}

export function restoreDictationChange(current: string, change: DictationChangeSelection): string {
  return current.slice(0, change.start) + change.original + current.slice(change.end);
}

export function usesCoarseDictationReview(original: string, current: string): boolean {
  const count = (text: string) => (text.match(/\s+|[^\s]+/gu)?.length ?? 0) + 1;
  return count(original) * count(current) > 250_000;
}
