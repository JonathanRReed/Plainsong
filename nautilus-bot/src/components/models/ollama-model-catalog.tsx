import { useState } from "react";
import type { OllamaCatalogEntry } from "@/lib/backend/ai";

interface Props {
  models: OllamaCatalogEntry[];
  busyModelId: string | null;
  progressPercent: number | null;
  error: string | null;
  onInstall: (modelId: string, acceptedLicense: boolean) => void;
  onCancel: () => void;
}

function size(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function OllamaModelCatalog({ models, busyModelId, progressPercent, error, onInstall, onCancel }: Props) {
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  if (models.length === 0 && !error) return null;
  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-label="Local Ollama model catalog">
      <div>
        <h3 className="text-sm font-semibold">Local Ollama models</h3>
        <p className="text-sm text-muted-foreground">Downloads go directly to Ollama on localhost. Plainsong does not use a cloud service or send telemetry for these models.</p>
      </div>
      <div className="space-y-2">
        {models.map((model) => {
          const needsAcceptance = model.provider.startsWith("Meta ");
          const digestMismatch = model.installed && !model.ready;
          const busy = busyModelId === model.id;
          return (
            <div key={model.id} className="rounded-md border bg-background p-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{model.displayName}</p>
                  <p className="text-xs text-muted-foreground">{model.id} · {model.provider} · {size(model.diskSizeBytes)} · {model.contextTokens.toLocaleString()} context</p>
                  <p className="text-xs text-muted-foreground">{model.license} · For {model.lanes.join(" and ")}</p>
                </div>
                {model.ready ? <span className="text-xs text-emerald-600">Ready</span> : busy ? (
                  <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onCancel}>Cancel{progressPercent === null ? "" : ` ${progressPercent}%`}</button>
                ) : (
                  <button type="button" className="rounded border px-2 py-1 text-xs" disabled={busyModelId !== null || (needsAcceptance && !accepted[model.id])} onClick={() => onInstall(model.id, accepted[model.id] === true)}>Install</button>
                )}
              </div>
              {needsAcceptance && !model.ready ? (
                <label className="mt-2 flex gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={accepted[model.id] === true} onChange={(event) => setAccepted((previous) => ({ ...previous, [model.id]: event.target.checked }))} />
                  <span>{model.disclosure}</span>
                </label>
              ) : null}
              {digestMismatch ? <p className="mt-2 text-xs text-rust">Installed tag digest does not match Plainsong&apos;s verified catalog digest. Reinstall this exact tag before selecting it.</p> : null}
            </div>
          );
        })}
      </div>
      {error ? <p className="text-sm text-rust">{error}</p> : null}
    </section>
  );
}
