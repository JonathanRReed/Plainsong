import { Button } from "@/components/ui/button";
import { ASR_LANGUAGE_NAMES, formatModelSize, plainModelName } from "@/lib/asr-capabilities";
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
  "Shows your words in the dictation popup while you are still speaking, building on what it has already heard instead of starting over every fraction of a second.";

const WHAT_IT_DOES_NOT_DO =
  "It never changes what Plainsong types for you. The inserted text always comes from your dictation speech model, after you stop.";

/**
 * Why a file that is on disk is still not being loaded.
 *
 * The row used to say "did not match its pinned checksum" for every
 * not-ready-with-bytes case, which is a specific and alarming accusation. The
 * status only measures the installed model path; resumable downloads live
 * at a separate temporary path. Consequently, neither the size nor presence
 * of this file identifies why it is unusable. Keep the diagnosis limited to
 * what the status establishes: Plainsong could not verify the installed file.
 */
function livePreviewFileProblem(
  status: Pick<LivePreviewEngineStatus, "ready" | "bytesOnDisk">,
): boolean {
  return !status.ready && status.bytesOnDisk > 0;
}

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

  const fileProblem = livePreviewFileProblem(status);
  const languageCount = status.languages.length;

  return (
    <section
      aria-label="Live preview model"
      className="mt-4 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            Live preview model · experimental
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

      {fileProblem && !busy ? (
        <p className="mt-2 text-sm leading-6 text-rust">
          Plainsong couldn&apos;t verify the downloaded file, so it won&apos;t
          use it. Downloading again replaces it.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm leading-6 text-rust" role="alert">
          {error}
        </p>
      ) : null}

      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        {status.displayName ? plainModelName(status.displayName) : "The live preview model"}
        {status.license ? `, ${status.license}` : ""}. Its model file lists{" "}
        {languageCount} {languageCount === 1 ? "language" : "languages"}
        {languageCount > 0 ? ` (${status.languages.map((code) => ASR_LANGUAGE_NAMES[code] ?? code).join(", ")})` : ""}; for
        any other dictation language, the standard preview is used. Only
        English has been tested in Plainsong.
      </p>

      {!status.ready ? (
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Without it the live preview still works: Plainsong transcribes what
          you have said so far again every fraction of a second, so the words
          arrive a little behind you.
        </p>
      ) : null}
    </section>
  );
}
