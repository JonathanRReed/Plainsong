import type { ChangeEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  analysisModelChoices,
  analysisProviderOptionsForLane,
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
  isZeroSetupAnalysisProvider,
  type AiLaneKey,
} from "@/components/models/ai-lanes";
import type { AiLaneSettings } from "@/types/settings";

interface AiLaneRowProps {
  lane: AiLaneKey;
  label: string;
  help: string;
  value: AiLaneSettings;
  remoteProcessingEnabled: boolean;
  models: string[];
  modelsLoading: boolean;
  onProviderChange: (lane: AiLaneKey, providerName: string) => void;
  onModelChange: (lane: AiLaneKey, modelId: string | null) => void;
  /**
   * Rendered under the picker when the selected provider is one of the
   * zero-setup on-device ones, which have a fixed model and their own
   * readiness (a download for the bundled model, an OS capability for
   * Apple's). The Models screen owns that state, so it supplies the node.
   */
  zeroSetupSlot?: ReactNode;
}

/**
 * One AI lane's provider + model. Moved here from the Settings AI tab so that
 * every model choice -- speech and text -- is made in one place; two pickers
 * writing the same two settings keys was the thing worth avoiding.
 */
export function AiLaneRow({
  lane,
  label,
  help,
  value,
  remoteProcessingEnabled,
  models,
  modelsLoading,
  onProviderChange,
  onModelChange,
  zeroSetupSlot,
}: AiLaneRowProps) {
  const choices = analysisModelChoices(value.provider, models);
  const zeroSetup = isZeroSetupAnalysisProvider(value.provider);
  const options = analysisProviderOptionsForLane(lane);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${lane}-provider`} className="text-sm font-semibold">
          {label}
        </Label>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {help}
        </p>
        <select
          id={`${lane}-provider`}
          value={value.provider}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onProviderChange(lane, event.target.value)
          }
          className="w-full rounded-md border bg-background p-2 text-sm"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-sm leading-6 text-muted-foreground">
          {isRemoteAnalysisProvider(value.provider)
            ? `Text you dictate or record is sent to ${describeAnalysisDestination(value.provider)} for this step.`
            : `Runs on ${describeAnalysisDestination(value.provider)}; nothing leaves the machine for this step.`}
        </p>
        {zeroSetup ? (
          <p className="text-sm leading-6 text-muted-foreground">
            Nothing to install and no key to paste. It cleans up dictation only
            — it cannot write meeting notes, and it does not run saved
            profiles or dictation commands, which fall back to
            Plainsong&apos;s built-in text transforms.
          </p>
        ) : null}
        {!remoteProcessingEnabled && isRemoteAnalysisProvider(value.provider) ? (
          <p className="text-sm leading-6 text-rust">
            This one runs in the cloud, but cloud AI is turned off — so nothing
            will be written until you allow it under Settings &rarr; Privacy
            &amp; Security.
          </p>
        ) : null}
      </div>

      {zeroSetup ? (
        zeroSetupSlot ?? null
      ) : (
      <div className="space-y-2">
        <Label htmlFor={`${lane}-model`} className="flex items-center gap-2">
          Model
          {modelsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
        </Label>
        {choices.length > 0 ? (
          <>
            <select
              id={`${lane}-model`}
              value={value.modelId ?? choices[0]}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                onModelChange(lane, event.target.value || null)
              }
              className="w-full rounded-md border bg-background p-2 text-sm"
            >
              {choices.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              This list comes from the service itself.
            </p>
          </>
        ) : value.provider === "ollama" ? (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="text-muted-foreground">
              No Ollama models found. Run{" "}
              <code className="rounded bg-muted px-1">ollama pull qwen3.5:4b</code>{" "}
              to download a model.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-rust/30 bg-rust/10 p-3 text-sm">
            <p className="text-rust">
              Add your {describeAnalysisDestination(value.provider)} API key
              under AI &amp; Keys to see models.
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
