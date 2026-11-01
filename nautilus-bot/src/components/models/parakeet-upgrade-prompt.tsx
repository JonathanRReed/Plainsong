import { Button } from "@/components/ui/button";

interface ParakeetUpgradePromptProps {
  /** The GGUF build's download size, or null when it isn't known. */
  sizeLabel: string | null;
  /** The GGUF build is already on this Mac and only needs choosing. */
  onDisk: boolean;
  busy: boolean;
  percent: number | null;
  error: string | null;
  onUpgrade: () => void;
}

/**
 * The one prompt an older install still on the ONNX build of Parakeet v3
 * sees, on a Mac that runs the GGUF build. Nothing downloads until the
 * button is pressed; once the download passes its check, the lanes that used
 * the ONNX build switch to it.
 */
export function ParakeetUpgradePrompt({
  sizeLabel,
  onDisk,
  busy,
  percent,
  error,
  onUpgrade,
}: ParakeetUpgradePromptProps) {
  const actionLabel = onDisk
    ? "Switch to it"
    : sizeLabel
      ? `Download and switch — ${sizeLabel}`
      : "Download and switch";
  return (
    <section
      aria-label="Faster Parakeet v3"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-4 py-3"
    >
      <p className="flex items-center gap-2 text-sm">
        <span className="neume neume-lit shrink-0" aria-hidden="true" />
        A faster, more accurate version of Parakeet v3 is available.
      </p>
      <Button size="sm" disabled={busy} onClick={onUpgrade}>
        {busy
          ? percent !== null
            ? `Downloading… ${Math.round(percent)}%`
            : onDisk
              ? "Switching…"
              : "Downloading…"
          : actionLabel}
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm leading-6 text-rust">
          {error}
        </p>
      ) : null}
    </section>
  );
}
