import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { cn } from "@/lib/utils";

interface AiWaitOrbProps {
  /** What the model is doing: "composing" writes, "searching" reads across
   * meetings, "breathing" thinks before an answer. */
  state: Extract<OrbState, "composing" | "searching" | "breathing" | "listening">;
  /** Pin the ink for a surface the app theme does not describe, such as
   * dark dots on the gold primary button. Defaults to the app's theme. */
  theme?: "dark" | "light";
  className?: string;
}

/**
 * The inline indicator for an AI wait of several seconds (summaries, analysis,
 * questions across meetings), in place of a spinning Loader2. Always beside a
 * text label that says what is happening, so it is hidden from screen
 * readers. Not for waits under two seconds, determinate progress, or local
 * work: those keep their own states. Follows the app's .dark class and draws
 * one still frame under reduced motion.
 */
export function AiWaitOrb({ state, theme, className }: AiWaitOrbProps) {
  return (
    <ThinkingOrb
      state={state}
      size={20}
      theme={theme ?? "auto"}
      aria-hidden="true"
      className={cn("inline-block shrink-0 align-middle", className)}
    />
  );
}
