import { Button } from "@/components/ui/button";
import { formatModelSize } from "@/lib/asr-capabilities";
import { bytesToMib } from "@/components/models/downloaded-models";
import { ReadinessMark } from "@/components/models/model-facts";
import type { LivePreviewEngineStatus } from "@/lib/backend/ai";

/**
 * The one sentence that has to be true for this row to be honest.
 *
 * These weights transcribe nothing that gets inserted. They only draw the
 * popup's live text while you are still talking, instead of re-transcribing
 * everything you have said so far every few hundred milliseconds. If the row
 * ever stops saying that, someone has made the preview load-bearing.
 */
const WHAT_IT_DOES =
  "Draws the words in the dictation popup while you are still speaking, keeping what it has already heard instead of starting the transcription over every few hundred milliseconds.";

const WHAT_IT_DOES_NOT_DO =
  "It never changes what Plainsong types for you. The inserted text is always the finished transcription from your dictation engine, made after you stop.";

interface LivePreviewEngineRowProps {
  status: LivePreviewEngineStatus | null;
  busy: boolean;
  progressPercent: number | null;
  error: string | null;
  onDownload: () => void;
  onDelete: () => void;
}

/**
 * Download, size and delete for the streaming live-preview engine.
 *
 * Rendered only when the sidecar reports `supported` — a build without the
 * streaming engine compiled in has nothing here to offer, and an empty row
 * that says "unavailable" would just be noise on the Models screen.
 *
 * Readiness is the sidecar's answer — the file is on disk *and* its pinned
 * checksum verified — not "a file exists", because that is the same question
 * the preview asks before it will load anything.
 */
export function LivePreviewEngineRow({
  status,
  busy,
  progressPercent,
  error,
  onDownload,
  onDelete,
}: LivePreviewEngineRowProps) {
  if (!status?.supported) {
    return null;
  }

  const partial = !status.ready && status.bytesOnDisk > 0;
  const languageCount = status.languages.length;

  return (
    <section
      aria-label="Live preview engine"
      className="mt-4 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            Live preview engine · experimental
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {WHAT_IT_DOES}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {WHAT_IT_DOES_NOT_DO}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ReadinessMark
            label={
              status.ready
                ? `On this Mac · ${formatModelSize(bytesToMib(status.bytesOnDisk))}`
                : `${formatModelSize(bytesToMib(status.downloadBytes))} to download`
            }
            tone={status.ready ? "ready" : "attention"}
          />
          {status.ready ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onDelete}
            >
              {busy ? "Working…" : "Delete"}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onDownload}>
              {busy
                ? progressPercent === null
                  ? "Downloading…"
                  : `Downloading ${Math.round(progressPercent)}%`
                : "Download"}
            </Button>
          )}
        </div>
      </div>

      {partial && !busy ? (
        <p className="mt-2 text-sm leading-6 text-rust">
          The file on disk did not match its pinned checksum, so it will not be
          loaded. Downloading again replaces it.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm leading-6 text-rust" role="alert">
          {error}
        </p>
      ) : null}

      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        {status.displayName ?? "The streaming model"}
        {status.license ? `, ${status.license}` : ""}. Its own model file
        declares {languageCount}{" "}
        {languageCount === 1 ? "language" : "languages"}
        {languageCount > 0 ? ` (${status.languages.join(", ")})` : ""}; a
        dictation language outside that list keeps the older preview instead.
        Only English has been measured in Plainsong.
      </p>

      {!status.ready ? (
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Without it the live preview still works: Plainsong re-transcribes what
          you have said so far every few hundred milliseconds, so the words
          arrive a little behind you.
        </p>
      ) : null}
    </section>
  );
}
