import { cn } from "@/lib/utils";
import {
  MODEL_PRESETS,
  presetDiskLabel,
  presetForThisMac,
  type DownloadSizeMibFor,
  type ModelPreset,
  type ModelPresetId,
} from "@/components/models/model-presets";

interface PresetPickerProps {
  activePresetId: ModelPresetId | null;
  /** Presets whose models this build cannot offer, with the reason. */
  unavailableReasonFor: (preset: ModelPreset) => string | null;
  /**
   * Whether this Mac runs the GGUF build of Parakeet v3, which presets then
   * name in place of the ONNX build (`presetForThisMac`).
   */
  efficientParakeet: boolean;
  /** What a Download fetches for a model on this Mac, where that is known. */
  downloadSizeMibFor?: DownloadSizeMibFor;
  onApply: (preset: ModelPreset) => void;
}

export function PresetPicker({
  activePresetId,
  unavailableReasonFor,
  efficientParakeet,
  downloadSizeMibFor,
  onApply,
}: PresetPickerProps) {
  const activePreset = MODEL_PRESETS.find(
    (preset) => preset.id === activePresetId,
  );

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* The heading is the disclosure that holds this picker. */}
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Each preset picks the speech models for dictation and meetings
            together. Your AI choices stay as they are. Change either speech
            model afterwards and this shows Custom.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Active preset{" "}
          <span className="font-medium text-foreground">
            {activePreset ? activePreset.name : "Custom"}
          </span>
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Model preset"
        className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4"
      >
        {MODEL_PRESETS.map((definition) => {
          const preset = presetForThisMac(definition, efficientParakeet);
          const selected = preset.id === activePresetId;
          const unavailable = unavailableReasonFor(preset);
          const diskLabel = presetDiskLabel(preset, downloadSizeMibFor);

          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable !== null}
              onClick={() => onApply(preset)}
              className={cn(
                "flex h-full flex-col gap-2 rounded-md border p-4 text-left transition-smooth",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected
                  ? "border-gold/40 bg-gold/10"
                  : "border-border/60 bg-background hover:border-border",
                unavailable !== null && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="flex items-center gap-2">
                {selected ? (
                  <span aria-hidden="true" className="neume neume-lit" />
                ) : null}
                <span className="text-sm font-semibold">{preset.name}</span>
              </span>
              {diskLabel ? (
                <span className="font-mono text-sm text-muted-foreground">
                  {diskLabel}
                </span>
              ) : null}
              <span className="text-sm leading-6 text-muted-foreground">
                {preset.buys}
              </span>
              <span className="text-sm leading-6 text-muted-foreground">
                {preset.costs}
              </span>
              {unavailable ? (
                <span className="text-sm leading-6 text-rust">{unavailable}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
