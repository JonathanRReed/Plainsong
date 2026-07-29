import { cn } from "@/lib/utils";
import {
  MODEL_PRESETS,
  presetDiskLabel,
  type ModelPreset,
  type ModelPresetId,
} from "@/components/models/model-presets";

interface PresetPickerProps {
  activePresetId: ModelPresetId | null;
  /** Presets whose models this build cannot offer, with the reason. */
  unavailableReasonFor: (preset: ModelPreset) => string | null;
  onApply: (preset: ModelPreset) => void;
}

export function PresetPicker({
  activePresetId,
  unavailableReasonFor,
  onApply,
}: PresetPickerProps) {
  const activePreset = MODEL_PRESETS.find(
    (preset) => preset.id === activePresetId,
  );

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-heading">Start from a preset</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Each one sets both speech choices at once and leaves your two AI
            choices alone. Change either speech choice afterwards and this
            reads Custom instead.
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
        {MODEL_PRESETS.map((preset) => {
          const selected = preset.id === activePresetId;
          const unavailable = unavailableReasonFor(preset);
          const diskLabel = presetDiskLabel(preset);

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
                  {diskLabel} of models
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
