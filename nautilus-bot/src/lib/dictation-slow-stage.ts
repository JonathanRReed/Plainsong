/**
 * When the dictation pill admits a processing stage is running long.
 *
 * Only a stage that has run well past what this Mac usually takes counts:
 * twice the expected time, and never under a floor, so a quick stage that is
 * merely a little late does not flip the label. With no expectation at all the
 * floor alone decides. The notice says nothing about why; it only says the
 * work is still going.
 */
export const SLOW_STAGE_FLOOR_MS = 4000;
const SLOW_STAGE_FACTOR = 2;

export const SLOW_STAGE_LABEL = "Still working";
export const SLOW_STAGE_DETAIL =
  "Taking longer than usual. Your words are safe.";

/** How long a stage may run before the pill says it is running long. */
export function slowStageThresholdMs(expectedMs: number | null | undefined): number {
  const expected =
    typeof expectedMs === "number" && Number.isFinite(expectedMs) && expectedMs > 0
      ? expectedMs
      : 0;
  return Math.max(SLOW_STAGE_FLOOR_MS, SLOW_STAGE_FACTOR * expected);
}
