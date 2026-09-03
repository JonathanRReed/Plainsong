import { Button } from "@/components/ui/button";
import { formatModelSize } from "@/lib/asr-capabilities";
import { bytesToMib } from "@/components/models/downloaded-models";
import { ReadinessMark } from "@/components/models/model-facts";
import type {
  AppleLanguageModelAvailability,
  BundledCleanupModelStatus,
} from "@/lib/backend/ai";

/**
 * What the built-in model can and cannot do, in one place.
 *
 * S1-mini is a text normalizer, not an assistant: it removes fillers,
 * resolves self-corrections, punctuates, and writes spoken numbers and dates
 * in written form. It does not summarize, answer, or follow a prompt. Saying
 * both halves here is the honest version of "no setup" -- the alternative is
 * a user discovering the second half when a custom mode quietly stops using
 * AI.
 */
const BUNDLED_CLEANUP_WHAT_IT_DOES =
  "Removes filler words, fixes false starts, adds punctuation and capitalization, and writes spoken numbers, dates and email addresses in written form. English only.";

const BUNDLED_CLEANUP_WHAT_IT_CANNOT_DO =
  "It does not summarize, answer questions, or follow a custom prompt, so meeting notes, custom modes and dictation commands need Ollama or a cloud provider.";

/**
 * What the machine underneath actually delivers.
 *
 * Measured on an M4 Pro (artifacts/qa/bundled-cleanup-receipt-2026-09-02.md):
 * on the GPU a 200-word dictation cleans up in 1.8 s, on the CPU in 11-13 s
 * against a 6 second limit. That is not a footnote — on CPU every long
 * dictation ends in a "took too long" warning and the unedited text — so the
 * row says it here rather than letting the user learn it one warning at a
 * time. The sidecar reports the backend it would actually use, probed without
 * loading the weights.
 */
function describeBackend(status: BundledCleanupModelStatus): {
  text: string;
  slow: boolean;
} {
  if (status.backendMeetsBudget) {
    return {
      text: "Runs on this Mac's GPU, where a long dictation is cleaned up in about two seconds.",
      slow: false,
    };
  }
  if (!status.backendPresent) {
    return {
      text: "This build has no runtime for the built-in model, so cleanup here is skipped and your words are inserted unchanged. Choose Ollama or a cloud provider.",
      slow: true,
    };
  }
  return {
    text: "This Mac runs it on the CPU, not the GPU. A short dictation still finishes in about five seconds, but a 200-word one takes 11 to 13 — past the six-second limit, so long dictations arrive as spoken with a “took too long” warning. Ollama or a cloud provider is the better choice here.",
    slow: true,
  };
}

interface BundledCleanupModelRowProps {
  status: BundledCleanupModelStatus | null;
  busy: boolean;
  progressPercent: number | null;
  error: string | null;
  onDownload: () => void;
  onDelete: () => void;
}

/**
 * The built-in dictation cleanup model's download, size and delete action.
 *
 * Readiness here is the sidecar's answer -- "every pinned file carries a
 * trusted integrity receipt" -- rather than "the folder is not empty". A
 * partially downloaded or tampered file reads as not ready and offers the
 * download again, because that is what the sidecar will do when asked to run
 * it.
 */
export function BundledCleanupModelRow({
  status,
  busy,
  progressPercent,
  error,
  onDownload,
  onDelete,
}: BundledCleanupModelRowProps) {
  if (!status) {
    return (
      <div className="rounded-md border bg-muted/20 p-3 text-sm">
        <p className="text-muted-foreground">
          Could not read the built-in model&apos;s state, so there is nothing
          measured to show here.
        </p>
      </div>
    );
  }

  const partial = !status.ready && status.bytesOnDisk > 0;
  const backend = describeBackend(status);

  return (
    <section
      aria-label="Built-in dictation cleanup model"
      className="rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {status.displayName} by {status.vendor}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {BUNDLED_CLEANUP_WHAT_IT_DOES}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {BUNDLED_CLEANUP_WHAT_IT_CANNOT_DO}
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
          {status.missingFiles.length}{" "}
          {status.missingFiles.length === 1 ? "file is" : "files are"} missing
          or failed verification ({status.missingFiles.join(", ")}), so the
          model will not load. Downloading again replaces them.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm leading-6 text-rust" role="alert">
          {error}
        </p>
      ) : null}

      <p
        className={`mt-2 max-w-2xl text-sm leading-6 ${
          backend.slow ? "text-rust" : "text-muted-foreground"
        }`}
      >
        {backend.text}
      </p>

      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Downloaded once from Hugging Face and verified against a pinned
        checksum. After that it runs on this Mac with no network, no account
        and nothing to install. It holds about{" "}
        {formatModelSize(bytesToMib(status.residentBytes))} of memory while it
        is loaded, and stays loaded between dictations while “Keep the model
        warm” is on.
      </p>
    </section>
  );
}

interface AppleLanguageModelRowProps {
  availability: AppleLanguageModelAvailability | null;
  checking: boolean;
  onRecheck: () => void;
}

/**
 * The one-line verdict beside the row.
 *
 * "Not available" is right for a Mac that cannot run this model and wrong for
 * one that is still downloading it: the second is a wait, not a verdict, and
 * the difference decides whether "Check again" is worth pressing. The sidecar
 * already distinguishes them, so the label does too.
 */
function availabilityLabel(
  availability: AppleLanguageModelAvailability | null,
  checking: boolean,
): string {
  if (checking) return "Checking…";
  if (availability?.available) return "Available";
  if (availability?.reason === "model_not_ready") return "Still downloading";
  return "Not available";
}

/**
 * Whether Apple's on-device model can run here, and if not, why.
 *
 * The reason matters more than the verdict: "this Mac cannot" and "you have
 * Apple Intelligence switched off" need different things from the user, and
 * the sidecar's probe already distinguishes them.
 */
export function AppleLanguageModelRow({
  availability,
  checking,
  onRecheck,
}: AppleLanguageModelRowProps) {
  return (
    <section
      aria-label="Apple on-device model"
      className="rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Apple on-device model</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Nothing to download: this is the model macOS 26 and newer ships
            with Apple Intelligence. It runs on this Mac and never reaches
            Apple&apos;s servers.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ReadinessMark
            label={availabilityLabel(availability, checking)}
            tone={availability?.available ? "ready" : "attention"}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            onClick={onRecheck}
          >
            Check again
          </Button>
        </div>
      </div>

      {!checking && availability && !availability.available ? (
        <p className="mt-2 max-w-2xl text-sm leading-6 text-rust">
          {availability.detail ??
            "Plainsong could not reach the Apple on-device model on this Mac."}{" "}
          Dictation cleanup will be skipped and your words inserted unchanged
          until this resolves.
        </p>
      ) : null}
    </section>
  );
}
