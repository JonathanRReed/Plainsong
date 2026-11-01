import { describeModelDownloadError } from "@/lib/model-download-error";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { listen } from "@/lib/electron";
import { getNativeTextModelStatus, downloadNativeTextModel, cancelNativeTextModelDownload, deleteNativeTextModel, type NativeTextModelStatus } from "@/lib/backend/ai";

function useNativeTextModel(onChanged?: () => void) {
  const [status, setStatus] = useState<NativeTextModelStatus | null>(null);
  const [busy, setBusy] = useState<"download" | "delete" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const revision = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await getNativeTextModelStatus();
      if (mounted.current && current === revision.current) { setStatus(result); setError(null); }
    } catch {
      if (mounted.current && current === revision.current) {
        setStatus(null);
        setError("Could not check the built-in text model. Try again.");
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let dispose: (() => void) | undefined;
    void listen<{ modelName?: string; percentage?: number }>("model-download-progress", ({ payload }) => {
      if (mounted.current && payload.modelName === "native_text" && typeof payload.percentage === "number" && Number.isFinite(payload.percentage)) {
        setProgress(Math.min(100, Math.max(0, payload.percentage)));
      }
    }).then((cleanup) => { if (mounted.current) dispose = cleanup; else cleanup(); }).catch(() => {});
    return () => { mounted.current = false; ++revision.current; dispose?.(); };
  }, [refresh]);
  const run = async (action: "download" | "delete", modelId?: string) => {
    if (pending.current) return;
    pending.current = true;
    const current = ++revision.current;
    setBusy(action); setError(null); setNotice(null); setProgress(null);
    try {
      const result = await (action === "download" ? downloadNativeTextModel(modelId) : deleteNativeTextModel(modelId));
      if (mounted.current && current === revision.current) { setStatus(result); changed.current?.(); }
    } catch (failure) {
      if (mounted.current && current === revision.current) {
        if (action === "download" && failure instanceof Error && failure.message.includes("Native model download cancelled")) {
          setNotice("Download cancelled. You can resume it later.");
        } else {
          const message = failure instanceof Error ? failure.message.replace(/^(?:(?:Error invoking remote method ['"][^'"]+['"]:\s*)|(?:Error:\s*))+/i, "") : null;
          const runtimeRefusal = message?.startsWith("An earlier Ollama request may still be running.") || message?.startsWith("Local processing is paused because") || message?.startsWith("Another local text operation is running.") || message?.startsWith("Another Plainsong process is updating the Ollama safety marker.");
          setError(action === "download" ? describeModelDownloadError(failure) : runtimeRefusal ? message : "Could not remove the model files. Try again.");
        }
      }
      // A cancelled download can leave resumable files on disk.
      try {
        const result = await getNativeTextModelStatus();
        if (mounted.current && current === revision.current) {
          setStatus(result);
          if (action === "delete" && (result.runtimeHealth?.state === "completion_unknown" || result.runtimeHealth?.state === "storage_error")) {
            setError(result.runtimeHealth.message);
          }
          changed.current?.();
        }
      } catch {
        // Preserve the operation's message, but do not claim old files are verified.
        if (mounted.current && current === revision.current) setStatus(null);
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(null); setProgress(null); }
    }
  };
  const cancel = () => { void cancelNativeTextModelDownload().catch(() => {
    if (mounted.current) setError("Could not cancel the download. Try again.");
  }); };
  const recheck = () => { void refresh().then(() => changed.current?.()); };
  return { status, busy, progress, error, notice, run, cancel, recheck };
}

/** Decimal gigabytes, the way Finder counts them. */
function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

const NativeTextModelContext = createContext<ReturnType<typeof useNativeTextModel> | null>(null);

export function NativeTextModelProvider({ children, onChanged, enabled = true }: { children: ReactNode; onChanged?: () => void; enabled?: boolean }) {
  return enabled ? <NativeTextModelStateProvider onChanged={onChanged}>{children}</NativeTextModelStateProvider> : <>{children}</>;
}

function NativeTextModelStateProvider({ children, onChanged }: { children: ReactNode; onChanged?: () => void }) {
  const model = useNativeTextModel(onChanged);
  return <NativeTextModelContext.Provider value={model}>{children}</NativeTextModelContext.Provider>;
}

interface NativeTextModelRowProps {
  onChanged?: () => void;
  modelId?: string | null;
  onModelChange?: (modelId: string) => void;
}

export function NativeTextModelRow({ onChanged, modelId, onModelChange }: NativeTextModelRowProps) {
  const model = useContext(NativeTextModelContext);
  return model ? <NativeTextModelContents model={model} modelId={modelId} onModelChange={onModelChange} /> : <StandaloneNativeTextModelRow onChanged={onChanged} modelId={modelId} onModelChange={onModelChange} />;
}

function StandaloneNativeTextModelRow({ onChanged, modelId, onModelChange }: NativeTextModelRowProps) {
  const model = useNativeTextModel(onChanged);
  return <NativeTextModelContents model={model} modelId={modelId} onModelChange={onModelChange} />;
}

function NativeTextModelContents({ model, modelId, onModelChange }: NativeTextModelRowProps & { model: ReturnType<typeof useNativeTextModel> }) {
  const { busy, progress, error, notice, run, cancel, recheck } = model;
  const selectedId = modelId || model.status?.recommendedModelId || model.status?.modelId;
  const size = model.status?.sizes?.find((entry) => entry.modelId === selectedId);
  const status = model.status && size ? { ...model.status, ...size } : model.status;
  const chosenModel = size?.modelId;

  return <section aria-label="Built-in text model" className="mt-3 space-y-3 rounded-lg border border-border p-4">
    <div>
      <h4 className="text-sm font-semibold">{status?.displayName ?? "Built-in text model"}</h4>
    </div>
    {model.status?.sizes && onModelChange && <label className="block space-y-2 text-sm">
      <span>Notes model</span>
      <select aria-label="Notes model" className="w-full rounded-md border bg-background p-2" value={selectedId} disabled={busy !== null} onChange={(event) => onModelChange(event.target.value)}>
        {model.status.sizes.map((entry) => <option key={entry.modelId} value={entry.modelId}>
          {entry.label}{entry.recommended ? " (recommended)" : ""} · {gigabytes(entry.modelMemoryBytes)} memory
        </option>)}
      </select>
    </label>}
    {size && <p className="text-sm text-muted-foreground">{size.description}</p>}
    <p className="text-sm text-muted-foreground">Experimental: meeting quality and speed are still being tested. Check its notes against the transcript.</p>
    {status && <p className="text-xs text-muted-foreground">{gigabytes(status.downloadBytes)} download · Apache-2.0 · Unloads after each use</p>}
    {status?.ready ? <p className="text-sm">Files verified.</p> : status ? <p className="text-sm">{status.runtimePresent ? "Download the model to use it." : "The built-in text model isn't available on this Mac."}</p> : <p className="text-sm">{error ? "Model status unavailable." : "Checking model status…"}</p>}
    {status?.runtimePresent && <div className="space-y-1 text-sm">
      <p>{status.memoryAvailableBytes === null ? "Plainsong couldn't check free memory. Check again before using it." : status.canLoadNow ? "There's enough free memory to load it." : "Not enough free memory right now. Close apps you aren't using, or try again later."}</p>
      {!status.ready && status.memoryAvailableBytes != null && status.canLoadNow === false && <p className="text-xs text-muted-foreground">You can download the files now and use the model when enough memory is available.</p>}
      {(status.memoryAvailableBytes !== null || status.memoryRequiredBytes != null) && <p className="text-xs text-muted-foreground">
        {status.memoryAvailableBytes !== null && `${gigabytes(status.memoryAvailableBytes)} free now`}
        {status.memoryAvailableBytes !== null && status.memoryRequiredBytes != null && " · "}
        {status.memoryRequiredBytes != null && `${gigabytes(status.memoryRequiredBytes)} needed`}
      </p>}
      {status.memoryRequiredBytes != null && <p className="text-xs text-muted-foreground">The amount needed includes the model and leaves room for other apps.</p>}
    </div>}
    {status?.runtimePresent && status.runtimeHealth?.state !== "available" && <p
      role={status.runtimeHealth?.state === "completion_unknown" || status.runtimeHealth?.state === "storage_error" ? "alert" : "status"}
      className="text-sm"
    >{status.runtimeHealth?.message ?? "Plainsong couldn't confirm the built-in text model is working."}</p>}
    {error && error !== status?.runtimeHealth?.message && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      {busy === "download" ? <>
        <p role="status" className="self-center text-sm">Downloading{progress === null ? "…" : ` ${Math.round(progress)}%`}</p>
        <Button type="button" variant="outline" size="sm" onClick={cancel}>Cancel download</Button>
      </> : <Button type="button" variant="outline" size="sm" disabled={busy !== null || !status?.runtimePresent} onClick={() => void run("download", chosenModel)}>{status?.ready ? "Verify model files" : "Download text model"}</Button>}
      {status && status.bytesOnDisk > 0 && <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void run("delete", chosenModel)}>{busy === "delete" ? "Removing…" : "Remove model files"}</Button>}
      <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={recheck}>Check model and memory</Button>
    </div>
  </section>;
}
