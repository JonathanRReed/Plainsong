import type { DictationRecognitionReviewWord } from "@/lib/backend/dictation";

export function recognitionWordsToReview(value: unknown, original: string | null | undefined): DictationRecognitionReviewWord[] {
  if (!Array.isArray(value) || typeof original !== "string" || !original.trim()) return [];
  const source = original.replace(/\s+/gu, " ");
  return value.slice(0, 128).filter((entry): entry is DictationRecognitionReviewWord => {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.word !== "string" || !entry.word.trim() || [...entry.word].length > 128) return false;
    const literal = entry.word.trim().replace(/\s+/gu, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "u").test(source)) return false;
    return typeof entry.word === "string" && entry.word.trim().length > 0 &&
      typeof entry.score === "number" && Number.isFinite(entry.score) &&
      entry.score >= 0 && entry.score < 0.6 &&
      typeof entry.startTime === "number" && Number.isFinite(entry.startTime) && entry.startTime >= 0 &&
      typeof entry.endTime === "number" && Number.isFinite(entry.endTime) && entry.endTime >= entry.startTime;
  });
}

export function RecognitionWordReview({ words, original }: { words: unknown; original: string | null | undefined }) {
  const reviewed = recognitionWordsToReview(words, original);
  if (typeof original !== "string" || !original.trim() || reviewed.length === 0) return null;
  const visible = reviewed.slice(0, 12);
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Words to check in the original</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        The recognizer gave lower scores to these original words. They may still be correct.
      </p>
      <ul aria-label="Original words to check" className="mt-2 flex flex-wrap gap-2">
        {visible.map((entry, index) => <li key={index} className="max-w-full break-all rounded bg-muted px-2 py-1">{entry.word}</li>)}
      </ul>
      {reviewed.length > visible.length && <p className="mt-2 text-xs text-muted-foreground">
        {reviewed.length - visible.length} more original words to check.
      </p>}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">Original</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">{original}</pre>
        {reviewed.length > visible.length && <ul aria-label="More original words to check" className="mt-2 flex flex-wrap gap-2">
          {reviewed.slice(12).map((entry, index) => <li key={index} className="max-w-full break-all rounded bg-muted px-2 py-1">{entry.word}</li>)}
        </ul>}
      </details>
    </details>
  );
}
