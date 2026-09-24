import { useEffect, useState } from "react";
import {
  dictationProgressFraction,
  type DictationProcessingStage,
  type DictationProgressPlan,
} from "@/lib/dictation-progress";
import { cn } from "@/lib/utils";

const STAGE_LABEL: Record<DictationProcessingStage, string> = {
  stopping: "Finishing audio",
  transcribing: "Transcribing",
  polishing: "Polishing",
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The finishing bar shown between "stop speaking" and "text inserted". It
 * fills toward the sidecar's estimate and slows near the end; `complete`
 * is the only thing that fills it. The fill moves by transform, not width,
 * and reduced motion drops the per-frame updates for a slow step.
 */
export function DictationFinishBar({
  stage,
  plan,
  complete = false,
  stageStartedAt,
  className,
}: {
  stage: DictationProcessingStage;
  plan: DictationProgressPlan;
  complete?: boolean;
  /**
   * `performance.now()` when this stage began. Owned by the caller so a
   * remount (display-mode switch, reduced-motion change) resumes the stage
   * instead of restarting it from zero.
   */
  stageStartedAt?: number;
  className?: string;
}) {
  const [fraction, setFraction] = useState(() =>
    complete ? 1 : dictationProgressFraction(stage, 0, plan),
  );
  const reducedMotion = prefersReducedMotion();
  const { expectedTranscribeMs, expectedPolishMs } = plan;

  useEffect(() => {
    if (complete) {
      setFraction(1);
      return;
    }
    const startedAt = stageStartedAt ?? performance.now();
    const currentPlan = { expectedTranscribeMs, expectedPolishMs };
    const tick = () =>
      setFraction(
        dictationProgressFraction(stage, performance.now() - startedAt, currentPlan),
      );
    tick();
    if (reducedMotion) {
      const interval = setInterval(tick, 500);
      return () => clearInterval(interval);
    }
    let frame = requestAnimationFrame(function loop() {
      tick();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [stage, expectedTranscribeMs, expectedPolishMs, complete, reducedMotion, stageStartedAt]);

  return (
    <div
      role="progressbar"
      aria-label="Dictation progress"
      // An estimate, so it is announced as a stage rather than a percentage.
      aria-valuetext={complete ? "Done" : STAGE_LABEL[stage]}
      data-testid="dictation-finish-bar"
      data-stage={complete ? "done" : stage}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-foreground/8", className)}
    >
      <div
        className="h-full w-full origin-left rounded-full bg-gold-ambient"
        style={{
          transform: `scaleX(${fraction})`,
          transition: reducedMotion ? "none" : "transform 200ms var(--ease-settle)",
        }}
      />
    </div>
  );
}
