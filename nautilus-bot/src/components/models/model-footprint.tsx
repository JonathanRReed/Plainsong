import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatModelSize } from "@/lib/asr-capabilities";
import {
  bytesToMib,
  type DownloadedModelIndex,
} from "@/components/models/downloaded-models";

/** One downloaded speech model, as the Disk section lists it. */
export interface DownloadedSpeechModel {
  routeId: string;
  label: string;
  bytes: number;
  /** What uses it now ("dictation", "meetings"), or null when nothing does. */
  usedFor: string | null;
}

interface ModelFootprintProps {
  index: DownloadedModelIndex | null;
  /** What the current four lanes still have to fetch before they can run. */
  pendingMib: number;
  /** Downloaded speech models that can be told apart, largest first. */
  models?: DownloadedSpeechModel[];
  onRemove?: (routeId: string) => void;
  removingRouteId?: string | null;
  removeError?: string | null;
}

export function ModelFootprint({
  index,
  pendingMib,
  models = [],
  onRemove,
  removingRouteId = null,
  removeError = null,
}: ModelFootprintProps) {
  // Removal asks once, on the row itself: a second click confirms.
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div>
      <h3 className="section-heading">Disk</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        {index
          ? index.fileCount === 0
            ? "No speech models are downloaded yet."
            : `Speech models on this Mac take ${formatModelSize(bytesToMib(index.totalBytes))} in ${index.fileCount} ${index.fileCount === 1 ? "file" : "files"}, measured from the files themselves.`
          : "Couldn't read the models folder, so there's no total to show."}
      </p>
      {pendingMib > 0 ? (
        <p className="mt-1 max-w-2xl text-sm leading-6 text-rust">
          {formatModelSize(pendingMib)} still to download before your choices
          above can run.
        </p>
      ) : null}
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        Choosing another model never deletes one you&apos;ve already
        downloaded. Remove one below to free its space; you can download it
        again any time.
      </p>
      {models.length > 0 && onRemove ? (
        <ul aria-label="Downloaded speech models" className="mt-3 grid max-w-2xl gap-2">
          {models.map((model) => {
            const busy = removingRouteId === model.routeId;
            const asking = confirming === model.routeId;
            return (
              <li
                key={model.routeId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{model.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatModelSize(bytesToMib(model.bytes))}
                    {model.usedFor ? ` · used for ${model.usedFor}` : ""}
                  </span>
                </span>
                {model.usedFor ? (
                  <span className="text-xs text-muted-foreground">
                    Choose another model first to remove it
                  </span>
                ) : asking ? (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={removingRouteId !== null}
                      onClick={() => {
                        setConfirming(null);
                        onRemove(model.routeId);
                      }}
                    >
                      Remove {formatModelSize(bytesToMib(model.bytes))}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Remove ${model.label}`}
                    disabled={removingRouteId !== null}
                    onClick={() => setConfirming(model.routeId)}
                  >
                    {busy ? "Removing…" : "Remove"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {removeError ? (
        <p role="alert" className="mt-2 max-w-2xl text-sm text-rust">
          {removeError}
        </p>
      ) : null}
    </div>
  );
}
