import { describeSearchIndexWait } from "@/lib/search-index-status";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsOptionSelect } from "@/components/settings/option-select";
import { SearchModelTermsNote, SearchModelTermsPrompt } from "@/components/settings/search-model-terms";
import { settingsErrorMessage } from "@/components/settings/settings-error-message";
import { useToast } from "@/components/toast";
import { listen } from "@/lib/electron";
import {
  acceptEmbeddingModelTerms,
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  downloadEmbeddingModel,
  getEmbeddingStatus,
  reindexEmbeddings,
  type EmbeddingStatus,
} from "@/lib/backend";
import type { TranscriptionSettings } from "@/types/settings";

type Mode = TranscriptionSettings["memorySearchMode"];
type SearchModel = EmbeddingStatus["builtInModels"][number];

/**
 * Ollama embedding models offered by name, best first on meeting questions in
 * Plainsong's tests. Anything else goes in Custom.
 */
const OLLAMA_SEARCH_MODELS: readonly { tag: string; label: string }[] = [
  { tag: "embeddinggemma", label: "EmbeddingGemma 300M (embeddinggemma)" },
  { tag: "embeddinggemma-2:270m", label: "EmbeddingGemma 2 (embeddinggemma-2:270m)" },
  { tag: "qwen3-embedding:0.6b", label: "Qwen3 Embedding 0.6B (qwen3-embedding:0.6b)" },
];
const CUSTOM = "__custom__";

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function MeaningSearchSection({
  transcription,
  onChange,
}: {
  transcription: TranscriptionSettings;
  onChange: (patch: Partial<TranscriptionSettings>) => void;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [busy, setBusy] = useState<"download" | "delete" | "rebuild" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [customOllama, setCustomOllama] = useState(
    () => !OLLAMA_SEARCH_MODELS.some((model) => model.tag === transcription.embeddingModel),
  );
  const mounted = useRef(true);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getEmbeddingStatus();
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setStatus(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const disposers: (() => void)[] = [];
    const keep = (cleanup: () => void) => {
      if (mounted.current) disposers.push(cleanup);
      else cleanup();
    };
    void listen<{ modelName?: string; percentage?: number }>("model-download-progress", ({ payload }) => {
      if (
        mounted.current &&
        payload.modelName?.startsWith("text_embeddings/") &&
        typeof payload.percentage === "number" &&
        Number.isFinite(payload.percentage)
      ) {
        setProgress(Math.min(100, Math.max(0, payload.percentage)));
        // A download started elsewhere (the hint under Ask, or before this
        // screen was opened) finishes without this screen's own call.
        if (payload.percentage >= 100) void refresh();
      }
    }).then(keep).catch(() => {});
    void listen("semantic-index-progress", () => {
      void refresh();
    }).then(keep).catch(() => {});
    return () => {
      mounted.current = false;
      disposers.forEach((dispose) => dispose());
    };
  }, [refresh]);

  // Refresh when the mode or model changes, so coverage names the new index.
  useEffect(() => {
    void refresh();
  }, [refresh, transcription.memorySearchMode, transcription.builtinEmbeddingModel, transcription.embeddingModel]);

  const mode: Mode = transcription.memorySearchMode;
  const models = status?.builtInModels ?? [];
  // The saved choice first: settings save after a short delay and the
  // sidecar's status catches up later still, so preferring the status
  // snapped a new pick back to the old model (and its Download button) for
  // several seconds.
  const selectedId = transcription.builtinEmbeddingModel || status?.selectedBuiltInModel || "";
  const recommended = models.find((model) => model.isDefault);
  const selected = models.find((model) => model.id === selectedId) ?? recommended;
  const needsTerms = selected !== undefined && selected.requiresTermsAcceptance && !selected.termsAccepted;
  // Any downloaded model can be removed; the one in use is removed from its card above.
  const otherDownloaded = models.filter(
    (model) => model.downloaded && !(mode === "builtin" && model.id === selected?.id),
  );

  const run = async (action: "download" | "delete", modelId: string) => {
    if (busy) return;
    cancelled.current = false;
    setBusy(action);
    setProgress(null);
    try {
      const next = await (action === "download" ? downloadEmbeddingModel(modelId) : deleteEmbeddingModel(modelId));
      if (mounted.current) setStatus(next);
    } catch (error) {
      if (!cancelled.current) {
        toast(
          settingsErrorMessage(
            error,
            action === "download"
              ? "Plainsong could not download and verify the search model. Check your connection and try again."
              : "Plainsong could not remove the search model.",
          ),
          "error",
        );
      }
      void refresh();
    } finally {
      if (mounted.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };

  // Accepting the terms comes first; the download (when the files are not on
  // the Mac yet) runs only once the sidecar has recorded the acceptance.
  const acceptAndDownload = async (model: SearchModel) => {
    if (busy) return;
    cancelled.current = false;
    setBusy("download");
    setProgress(null);
    let accepted = false;
    try {
      const afterAccept = await acceptEmbeddingModelTerms(model.id, model.termsUrl);
      accepted = true;
      if (mounted.current) setStatus(afterAccept);
      if (!model.downloaded) {
        const afterDownload = await downloadEmbeddingModel(model.id);
        if (mounted.current) setStatus(afterDownload);
      }
    } catch (error) {
      if (cancelled.current) {
        void refresh();
        return;
      }
      toast(
        settingsErrorMessage(
          error,
          accepted
            ? "Plainsong could not download and verify the search model. Check your connection and try again."
            : "Plainsong could not save your acceptance of the terms.",
        ),
        "error",
      );
      void refresh();
    } finally {
      if (mounted.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };

  const cancelDownload = () => {
    cancelled.current = true;
    void cancelEmbeddingModelDownload().catch(() => {});
  };

  // Also true for a download this screen did not start: leaving Settings and
  // coming back mid-download used to show a dead Download button.
  const downloadRunning = busy === "download" || status?.downloading === true;

  const downloading = (
    <div className="flex items-center gap-2">
      <p role="status">Downloading{progress === null ? "…" : ` ${Math.round(progress)}%`}</p>
      <Button type="button" variant="outline" size="sm" onClick={cancelDownload}>
        Cancel
      </Button>
    </div>
  );

  const rebuild = async () => {
    if (busy) return;
    setBusy("rebuild");
    try {
      const result = await reindexEmbeddings();
      if (result.background) {
        // The built-in route rebuilds in the background; progress arrives as
        // events and the status above updates with it.
        toast("Rebuilding the index in the background. It pauses while you dictate or record.", "success");
        return;
      }
      toast(
        `Indexed ${result.segments} passages from ${result.recordings} recordings${result.errors > 0 ? ` (${result.errors} errors)` : ""}`,
        result.errors > 0 ? "error" : "success",
      );
    } catch (error) {
      toast(settingsErrorMessage(error, "Plainsong could not rebuild the index."), "error");
    } finally {
      if (mounted.current) setBusy(null);
      void refresh();
    }
  };

  const ollamaChoice = customOllama ? CUSTOM : transcription.embeddingModel;
  const coverage =
    status && status.indexedRecordings !== null && status.totalRecordings !== null
      ? `${status.indexedRecordings} of ${status.totalRecordings} recordings indexed.`
      : null;

  return (
    <div className="space-y-4">
      <SettingsOptionSelect
        label="How Ask finds passages"
        description="Word matching finds a passage only when it used the words in your question. Meaning matching also finds one that said the same thing another way. The search boxes always match words. Both run on this Mac, and your recordings are never sent anywhere."
        value={mode}
        onChange={(value) => onChange({ memorySearchMode: value as Mode })}
      >
        <option value="fts">Match the words you type</option>
        <option value="builtin" disabled={status ? !status.builtInAvailable : false}>
          Match the meaning, with a model built into Plainsong
        </option>
        <option value="ollama_embeddings">Match the meaning, with a model you run in Ollama</option>
      </SettingsOptionSelect>

      {mode === "builtin" && (
        <div className="space-y-3">
          {models.length > 0 && (
            <SettingsOptionSelect
              label="Search model"
              description={
                selected
                  ? `${selected.summary} Made for ${selected.languages}.`
                  : "The model that reads your transcripts for meaning."
              }
              value={selected?.id ?? ""}
              onChange={(value) => onChange({ builtinEmbeddingModel: value })}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName} by {model.vendor}, {megabytes(model.downloadBytes)}
                  {model.isDefault ? " (recommended)" : ""}
                  {model.requiresTermsAcceptance ? ` (${model.license})` : ""}
                </option>
              ))}
            </SettingsOptionSelect>
          )}
          {selected && (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
              {needsTerms ? null : selected.downloaded ? (
                <p>Downloaded and verified. It runs on this Mac, with no Ollama or account.</p>
              ) : (
                <p>
                  Download it once ({megabytes(selected.downloadBytes)} from Hugging Face) to search by
                  meaning. Until then, search matches words.
                </p>
              )}
              <p className="text-muted-foreground">
                The model, your transcripts and the index stay on this Mac. <SearchModelTermsNote model={selected} />
              </p>
              {needsTerms &&
                (downloadRunning ? (
                  downloading
                ) : (
                  <SearchModelTermsPrompt
                    model={selected}
                    recommended={recommended}
                    disabled={busy !== null || status?.downloading === true}
                    onAccept={() => void acceptAndDownload(selected)}
                  />
                ))}
              {coverage && <p className="text-muted-foreground">{coverage}</p>}
              {status?.indexing && (
                <p role="status" className="text-muted-foreground">
                  Indexing in the background. It pauses while you dictate, record or ask, and in Low Power
                  Mode or on battery below 20%.
                </p>
              )}
              {status?.lastError && !status.indexing && (
                <p className="text-muted-foreground">{describeSearchIndexWait(status.lastError)}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {!selected.downloaded &&
                  !needsTerms &&
                  (downloadRunning ? (
                    downloading
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null || status?.downloading}
                      onClick={() => void run("download", selected.id)}
                    >
                      Download {selected.displayName}
                    </Button>
                  ))}
                {selected.downloaded && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null || status?.downloading === true}
                    onClick={() => void run("delete", selected.id)}
                  >
                    {busy === "delete" ? "Removing…" : "Remove model and its index"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {otherDownloaded.length > 0 && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">
            {mode === "builtin" ? "Other downloaded search models" : "Downloaded search models"}
          </p>
          {otherDownloaded.map((model) => (
            <div key={model.id} className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground">
                {model.displayName}, {megabytes(model.downloadBytes)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || status?.downloading === true}
                onClick={() => void run("delete", model.id)}
              >
                Remove {model.displayName}
              </Button>
            </div>
          ))}
        </div>
      )}

      {mode === "ollama_embeddings" && (
        <div className="space-y-2">
          <SettingsOptionSelect
            label="Ollama model used for meaning matching"
            description="Ollama must be running on this Mac. Changing the model needs a rebuild of the index below."
            value={ollamaChoice}
            onChange={(value) => {
              if (value === CUSTOM) {
                setCustomOllama(true);
                return;
              }
              setCustomOllama(false);
              onChange({ embeddingModel: value });
            }}
          >
            {OLLAMA_SEARCH_MODELS.map((model) => (
              <option key={model.tag} value={model.tag}>
                {model.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </SettingsOptionSelect>
          {customOllama && (
            <div className="space-y-1">
              <Label htmlFor="embedding-model">Ollama model name</Label>
              <Input
                id="embedding-model"
                value={transcription.embeddingModel}
                onChange={(event: ChangeEvent<HTMLInputElement>) => onChange({ embeddingModel: event.target.value })}
                placeholder="nomic-embed-text"
                className="font-mono text-sm"
              />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Install it first with{" "}
            <code className="rounded bg-muted px-1">ollama pull {transcription.embeddingModel || "model-name"}</code>{" "}
            in Terminal.
          </p>
          {coverage && <p className="text-sm text-muted-foreground">{coverage}</p>}
        </div>
      )}

      {mode !== "fts" && (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Rebuild the index</p>
            <p className="text-sm text-muted-foreground">
              {mode === "builtin"
                ? "Re-reads every transcript now. New and edited recordings are indexed on their own."
                : "Re-reads every transcript you already have. Needed after changing the model above."}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || (mode === "builtin" && (!selected?.downloaded || needsTerms))}
            onClick={() => void rebuild()}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Rebuild
          </Button>
        </div>
      )}
    </div>
  );
}
