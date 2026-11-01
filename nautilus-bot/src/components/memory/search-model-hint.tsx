import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { listen } from "@/lib/electron";
import { describeModelDownloadError } from "@/lib/model-download-error";
import { SearchModelTermsNote, SearchModelTermsPrompt } from "@/components/settings/search-model-terms";
import {
  acceptEmbeddingModelTerms,
  cancelEmbeddingModelDownload,
  downloadEmbeddingModel,
  getEmbeddingStatus,
  type EmbeddingStatus,
} from "@/lib/backend";

/**
 * Under Ask: when meaning search is selected but its built-in model is not on
 * the Mac yet, or its terms are not accepted, say that answers use word
 * matching until it is, and offer the download (after the click-through, for
 * a model with its own terms). Downloads only when clicked.
 */
export function SearchModelHint() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // The reason a download or terms save failed, in plain words; null when
  // nothing failed.
  const [failed, setFailed] = useState<string | null>(null);
  const mounted = useRef(true);
  const cancelled = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      getEmbeddingStatus()
        .then((next) => {
          if (mounted.current) setStatus(next);
        })
        .catch(() => {});
    };
    refresh();
    let dispose: (() => void) | undefined;
    void listen<{ modelName?: string; percentage?: number }>("model-download-progress", ({ payload }) => {
      if (mounted.current && payload.modelName?.startsWith("text_embeddings/") && typeof payload.percentage === "number") {
        setProgress(Math.min(100, Math.max(0, payload.percentage)));
        // Finished, whether this hint or Settings started it: read the status
        // again so the hint goes away once the model is on this Mac.
        if (payload.percentage >= 100) refresh();
      }
    })
      .then((cleanup) => {
        if (mounted.current) dispose = cleanup;
        else cleanup();
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      dispose?.();
    };
  }, []);

  if (!status || status.memorySearchMode !== "builtin" || !status.builtInAvailable) return null;
  const model = status.builtInModels.find((entry) => entry.id === status.selectedBuiltInModel);
  const needsTerms = model?.requiresTermsAcceptance === true && !model.termsAccepted;
  if (!model || (model.downloaded && !needsTerms)) return null;

  const download = async () => {
    cancelled.current = false;
    setBusy(true);
    setFailed(null);
    let accepted = !needsTerms;
    try {
      if (needsTerms) {
        const afterAccept = await acceptEmbeddingModelTerms(model.id, model.termsUrl);
        accepted = true;
        if (mounted.current) setStatus(afterAccept);
      }
      if (!model.downloaded) {
        const next = await downloadEmbeddingModel(model.id);
        if (mounted.current) setStatus(next);
      }
    } catch (error) {
      if (mounted.current && !cancelled.current) {
        setFailed(
          accepted
            ? describeModelDownloadError(error)
            : "Plainsong couldn't save your acceptance of the terms. Try again.",
        );
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const progressLine = (
    <div className="flex items-center gap-2 text-sm">
      <p role="status">Downloading{progress === null ? "…" : ` ${Math.round(progress)}%`}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          cancelled.current = true;
          void cancelEmbeddingModelDownload().catch(() => {});
        }}
      >
        Cancel
      </Button>
    </div>
  );

  if (needsTerms) {
    return (
      <div className="space-y-2">
        {busy || status.downloading ? (
          progressLine
        ) : (
          <SearchModelTermsPrompt
            model={model}
            recommended={status.builtInModels.find((entry) => entry.isDefault)}
            disabled={status.downloading}
            onAccept={() => void download()}
          />
        )}
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {failed}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-sm">
      <p className="min-w-0 flex-1 text-muted-foreground">
        Ask matches your exact words until the search model is downloaded. With it, Ask also finds passages
        that say the same thing another way. It runs on this Mac and sends nothing.{" "}
        <SearchModelTermsNote model={model} />
      </p>
      {busy || status.downloading ? (
        progressLine
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={() => void download()}>
          Download search model ({Math.round(model.downloadBytes / 1_000_000)} MB)
        </Button>
      )}
      {failed && (
        <p role="alert" className="w-full text-destructive">
          {failed}
        </p>
      )}
    </div>
  );
}
