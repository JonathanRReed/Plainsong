import { describe, expect, it } from "vitest";
import {
  formatPauseDuration,
  pauseSpanDurationMs,
  placePauseMarkers,
} from "@/lib/pause-markers";

describe("formatPauseDuration", () => {
  it("reads like the timeline marker", () => {
    expect(formatPauseDuration(130_000)).toBe("2 min 10 s");
    expect(formatPauseDuration(45_000)).toBe("45 s");
    expect(formatPauseDuration(120_000)).toBe("2 min");
    expect(formatPauseDuration(3_720_000)).toBe("1 h 2 min");
    expect(formatPauseDuration(3_600_000)).toBe("1 h");
    expect(formatPauseDuration(400)).toBe("under 1 s");
    expect(formatPauseDuration(-5)).toBe("under 1 s");
  });
});

describe("placePauseMarkers", () => {
  const turns = [0, 12.5, 40, 61];

  it("puts each marker before the first turn at or after the pause offset", () => {
    const markers = placePauseMarkers(turns, [
      { startedAtMs: 10_000, endedAtMs: 140_000, atSeconds: 12.5 },
      { startedAtMs: 500_000, endedAtMs: 545_000, atSeconds: 45 },
    ]);
    expect(markers).toEqual([
      {
        beforeGroupIndex: 1,
        atSeconds: 12.5,
        durationMs: 130_000,
        label: "Paused 2 min 10 s",
      },
      {
        beforeGroupIndex: 3,
        atSeconds: 45,
        durationMs: 45_000,
        label: "Paused 45 s",
      },
    ]);
  });

  it("places a pause past the last turn after it, and sorts by offset", () => {
    const markers = placePauseMarkers(turns, [
      { startedAtMs: 900_000, endedAtMs: 960_000, atSeconds: 70 },
      { startedAtMs: 1_000, endedAtMs: 2_000, atSeconds: 0 },
    ]);
    expect(markers.map((marker) => [marker.beforeGroupIndex, marker.atSeconds])).toEqual([
      [0, 0],
      [4, 70],
    ]);
  });

  it("skips spans that never ended, and gives nothing for no spans or no turns", () => {
    expect(
      placePauseMarkers(turns, [{ startedAtMs: 1, endedAtMs: null, atSeconds: 5 }]),
    ).toEqual([]);
    expect(placePauseMarkers(turns, [])).toEqual([]);
    expect(placePauseMarkers(turns, null)).toEqual([]);
    expect(placePauseMarkers(turns, undefined)).toEqual([]);
    // A transcript with no turns still shows the pause, after nothing.
    expect(
      placePauseMarkers([], [{ startedAtMs: 0, endedAtMs: 9_000, atSeconds: 3 }]),
    ).toEqual([{ beforeGroupIndex: 0, atSeconds: 3, durationMs: 9_000, label: "Paused 9 s" }]);
  });

  it("measures a span from its own stamps", () => {
    expect(pauseSpanDurationMs({ startedAtMs: 5_000, endedAtMs: 7_500, atSeconds: 1 })).toBe(2_500);
    expect(pauseSpanDurationMs({ startedAtMs: 5_000, endedAtMs: 4_000, atSeconds: 1 })).toBe(0);
    expect(pauseSpanDurationMs({ startedAtMs: 5_000, endedAtMs: null, atSeconds: 1 })).toBe(0);
  });
});
