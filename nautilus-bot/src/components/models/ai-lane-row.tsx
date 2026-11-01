import type { ChangeEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { CHATGPT_PLAN_PROVIDER } from "@/lib/backend/chatgpt-plan";

interface AiLaneRowProps {
  lane: AiLaneKey;
  label: string;
  help: string;
  value: AiLaneSettings;
  remoteProcessingEnabled: boolean;
  models: string[];
  modelsLoading: boolean;
  modelLabels?: ReadonlyMap<string, string>;
  onProviderChange: (lane: AiLaneKey, providerName: string) => void;
  onRefreshModels: (providerName: string) => void;
  onModelChange: (lane: AiLaneKey, modelId: string | null) => void;
  /**
   * Rendered under the picker when the selected provider is one of the
   * zero-setup on-device ones, which have a fixed model and their own
   * readiness (a download for the bundled model, an OS capability for
   * Apple's). The Models screen owns that state, so it supplies the node.
   */
  zeroSetupSlot?: ReactNode;
  appleAvailable?: boolean;
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
  modelLabels,
  onProviderChange,
  onRefreshModels,
  onModelChange,
  zeroSetupSlot,
  appleAvailable = false,
}: AiLaneRowProps) {
  const choices = analysisModelChoices(value.provider, models);
  const zeroSetup = isZeroSetupAnalysisProvider(value.provider);
  const options = analysisProviderOptionsForLane(lane).filter((option) =>
    lane !== "meetingsAi" || option.value !== "apple_language_model" || appleAvailable || value.provider === "apple_language_model");
  const selectedModelId = value.modelId?.trim() ?? "";
  const selectedModelIsUnknown =
    selectedModelId.length > 0 && !choices.includes(selectedModelId);
  const requiresExplicitModel = value.provider === CHATGPT_PLAN_PROVIDER;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${lane}-provider`} className="text-sm font-semibold">
          {label}
        </Label>
        <p
          id={`${lane}-provider-help`}
          className="max-w-2xl text-sm leading-6 text-muted-foreground"
        >
          {help}
        </p>
        <select
          id={`${lane}-provider`}
          aria-describedby={`${lane}-provider-help`}
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
          {value.provider === "ollama"
            ? "Local Ollama models run on this Mac. Ollama cloud models send text off this Mac, so they need cloud AI turned on under Privacy & data, and so do models Plainsong hasn't checked."
            : isRemoteAnalysisProvider(value.provider)
              ? `Text you dictate or record is sent to ${describeAnalysisDestination(value.provider)} for this step.`
              : `Runs on ${describeAnalysisDestination(value.provider)}; nothing leaves the machine for this step.`}
        </p>
        {value.provider === "native_text" ? (
          <p className="text-sm leading-6 text-muted-foreground">Writes meeting notes and custom rewrites. It checks free memory before loading and unloads after each use.</p>
        ) : zeroSetup ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {value.provider === "apple_language_model"
              ? "Uses Apple Intelligence on this Mac. Long meetings are read in parts."
              : "Cleans up dictation on this Mac."}
          </p>
        ) : null}
        {!remoteProcessingEnabled && isRemoteAnalysisProvider(value.provider) ? (
          <p className="text-sm leading-6 text-rust">
            This one runs in the cloud, but cloud AI is turned off — so nothing
            will be written until you allow it under Settings &gt; Privacy
            &amp; data.
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
          <Button
            variant="outline"
            size="sm"
            aria-label={`Refresh models for ${label}`}
            disabled={modelsLoading || (!remoteProcessingEnabled && isRemoteAnalysisProvider(value.provider))}
            onClick={() => onRefreshModels(value.provider)}
          >
            Refresh models
          </Button>
          {choices.length > 0 ? (
            <>
              <select
                id={`${lane}-model`}
                aria-describedby={`${lane}-model-help`}
                value={selectedModelId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  onModelChange(lane, event.target.value || null)
                }
                className="w-full rounded-md border bg-background p-2 text-sm"
              >
                <option value="">
                  {requiresExplicitModel ? "Choose a model" : "The service's default"}
                </option>
                {selectedModelIsUnknown ? (
                  <option value={selectedModelId}>{selectedModelId}</option>
                ) : null}
                {choices.map((model) => (
                  <option key={model} value={model}>
                    {modelLabels?.get(model) ?? model}
                  </option>
                ))}
              </select>
              <p id={`${lane}-model-help`} className="text-sm text-muted-foreground">
                Which model the service uses. This list comes from the service itself.
              </p>
            </>
          ) : value.provider === CHATGPT_PLAN_PROVIDER ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              Load or connect a ChatGPT account above to see its available models.
            </div>
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
                under Search &amp; AI to see models.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
