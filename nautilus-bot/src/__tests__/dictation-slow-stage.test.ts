import { describe, expect, it } from "vitest";
import {
  SLOW_STAGE_FLOOR_MS,
  slowStageThresholdMs,
} from "@/lib/dictation-slow-stage";

const isStageRunningLong = (elapsedMs: number, expectedMs: number | null) =>
  elapsedMs > slowStageThresholdMs(expectedMs);

describe("slow dictation stage", () => {
  it("waits for twice the expected time", () => {
    expect(slowStageThresholdMs(3000)).toBe(6000);
    expect(isStageRunningLong(5900, 3000)).toBe(false);
    expect(isStageRunningLong(6100, 3000)).toBe(true);
  });

  it("never calls a stage slow before the floor", () => {
    // A 600 ms stage at 1.5 s is 2.5x late but still quick to a person.
    expect(isStageRunningLong(1500, 600)).toBe(false);
    expect(isStageRunningLong(SLOW_STAGE_FLOOR_MS - 1, 600)).toBe(false);
    expect(isStageRunningLong(SLOW_STAGE_FLOOR_MS + 1, 600)).toBe(true);
  });

  it("falls back to the floor when there is no usable expectation", () => {
    for (const expected of [null, undefined, 0, -5, Number.NaN]) {
      expect(slowStageThresholdMs(expected)).toBe(SLOW_STAGE_FLOOR_MS);
    }
  });
});
