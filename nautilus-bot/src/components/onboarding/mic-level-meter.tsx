import { cn } from "@/lib/utils";

// Taller in the middle, with a little unevenness so a steady voice reads as a
// voice rather than a progress bar. Fixed, so nothing moves without sound.
const BAR_SHAPE = [
  0.34, 0.46, 0.58, 0.52, 0.72, 0.84, 0.94, 1, 0.9, 0.8, 0.66, 0.74, 0.56, 0.44, 0.32,
];

/**
 * A row of gold bars that rise with the microphone level.
 *
 * The level is information, so reduced motion keeps it: the bars still follow
 * the voice, they only stop easing between heights.
 */
export function MicLevelMeter({
  level,
  active,
  className,
}: {
  /** 0..1, already smoothed by the caller. */
  level: number;
  /** False draws the resting row: a flat line of quiet bars. */
  active: boolean;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, level));
  // Normal speech sits around 0.5-0.7 on the decibel scale, so lift it a
  // little: talking at a normal volume should fill most of the meter.
  const drive = active ? Math.min(1, clamped * 1.5) : 0;
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("flex h-20 items-center justify-center gap-2", className)}
    >
      {BAR_SHAPE.map((shape, index) => {
        const height = Math.max(0.12, drive * shape);
        const lit = active && drive * shape > 0.16;
        return (
          <span
            key={index}
            aria-hidden="true"
            className={cn(
              "w-2 rounded-full transition-[height,background-color] duration-100 ease-out motion-reduce:transition-none",
              lit ? "bg-gold" : "bg-muted-foreground/25",
            )}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
