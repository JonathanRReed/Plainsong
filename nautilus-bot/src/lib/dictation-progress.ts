/**
 * The dictation finishing bar: how full it is at a given moment.
 *
 * The sidecar sends an expected duration for each processing stage, learned
 * from this Mac's recent dictations (`rust-sidecar/src/dictation_progress.rs`).
 * The bar fills toward that estimate, slows as it gets close, and never
 * reaches the end on its own. Only the `done` phase fills it, so the bar can
 * run late but can never claim the text is ready before it is.
 */

export type DictationProcessingStage = "stopping" | "transcribing" | "polishing";

export interface DictationProgressPlan {
  expectedTranscribeMs: number;
  /** Null when no AI pass is expected: transcription gets the whole bar. */
  expectedPolishMs: number | null;
}

/** The furthest the bar goes before the text actually lands. */
export const DICTATION_PROGRESS_CEILING = 0.94;
/** Where the bar sits while the audio is being finalized. */
const STOPPING_FRACTION = 0.04;
/** Transcription's share of the bar is kept inside this range so neither stage collapses to a sliver. */
const MIN_TRANSCRIBE_SHARE = 0.35;
const MAX_TRANSCRIBE_SHARE = 0.75;
/**
 * Curve steepness. At the expected time a stage is ~86% through its span,
 * then creeps toward the end instead of stopping dead.
 */
const EASE_RATE = 2;

function positive(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 0 at the start of a stage, approaching 1 without ever reaching it. */
export function easeTowardExpected(elapsedMs: number, expectedMs: number): number {
  const t = Math.max(0, elapsedMs) / positive(expectedMs, 1);
  return 1 - Math.exp(-EASE_RATE * t);
}

/** Where transcription ends and polishing begins, as a bar fraction. */
export function transcribeStageEnd(plan: DictationProgressPlan): number {
  if (plan.expectedPolishMs === null) {
    return DICTATION_PROGRESS_CEILING;
  }
  const transcribe = positive(plan.expectedTranscribeMs, 1);
  const polish = positive(plan.expectedPolishMs, 1);
  const share = Math.min(
    MAX_TRANSCRIBE_SHARE,
    Math.max(MIN_TRANSCRIBE_SHARE, transcribe / (transcribe + polish)),
  );
  return STOPPING_FRACTION + (DICTATION_PROGRESS_CEILING - STOPPING_FRACTION) * share;
}

export function dictationProgressFraction(
  stage: DictationProcessingStage,
  elapsedInStageMs: number,
  plan: DictationProgressPlan,
): number {
  if (stage === "stopping") {
    return STOPPING_FRACTION;
  }
  const transcribeEnd = transcribeStageEnd(plan);
  if (stage === "transcribing") {
    return (
      STOPPING_FRACTION +
      (transcribeEnd - STOPPING_FRACTION) *
        easeTowardExpected(elapsedInStageMs, plan.expectedTranscribeMs)
    );
  }
  return (
    transcribeEnd +
    (DICTATION_PROGRESS_CEILING - transcribeEnd) *
      easeTowardExpected(elapsedInStageMs, positive(plan.expectedPolishMs, 700))
  );
}
