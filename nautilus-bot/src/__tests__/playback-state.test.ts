import { describe, expect, it } from "vitest";
import {
  clampTime,
  formatClock,
  initialPlaybackState,
  nextPlaybackRate,
  playbackReducer,
  rangeIndexAtTime,
  type PlaybackState,
} from "@/lib/playback";

function run(actions: Parameters<typeof playbackReducer>[1][]): PlaybackState {
  return actions.reduce(playbackReducer, initialPlaybackState);
}

describe("playback reducer", () => {
  it("walks prepare → ready → playing → paused, keeping the chosen rate", () => {
    const prepared = run([
      { type: "cycleRate" },
      { type: "prepare" },
      { type: "prepared", token: "t", url: "plainsong://playback/t", duration: 120 },
    ]);
    expect(prepared.status).toBe("ready");
    expect(prepared.rate).toBe(1.5);
    expect(prepared.duration).toBe(120);

    const playing = playbackReducer(prepared, { type: "play" });
    expect(playing.status).toBe("playing");
    const paused = playbackReducer(playing, { type: "pause" });
    expect(paused.status).toBe("paused");
    // A pause while not playing changes nothing.
    expect(playbackReducer(prepared, { type: "pause" })).toBe(prepared);
  });

  it("clamps time and seeks to the known duration", () => {
    const ready = run([
      { type: "prepared", token: "t", url: "u", duration: 60 },
      { type: "time", currentTime: 75 },
    ]);
    expect(ready.currentTime).toBe(60);
    expect(playbackReducer(ready, { type: "seek", time: -3 }).currentTime).toBe(0);
    expect(playbackReducer(ready, { type: "seek", time: 12.5 }).currentTime).toBe(12.5);
    // The element's own duration replaces the row's hint once known.
    expect(playbackReducer(ready, { type: "duration", duration: 61.2 }).duration).toBe(61.2);
    expect(playbackReducer(ready, { type: "duration", duration: NaN }).duration).toBe(60);
  });

  it("parks at the end when playback ends", () => {
    const ended = run([
      { type: "prepared", token: "t", url: "u", duration: 30 },
      { type: "play" },
      { type: "ended" },
    ]);
    expect(ended.status).toBe("paused");
    expect(ended.currentTime).toBe(30);
  });

  it("keeps the token through a failure so release still finds it", () => {
    const failed = run([
      { type: "prepared", token: "t", url: "u", duration: 30 },
      { type: "play" },
      { type: "failed", message: "Playback stopped because the vault was locked." },
    ]);
    expect(failed.status).toBe("error");
    expect(failed.token).toBe("t");
    // Nothing plays through an error.
    expect(playbackReducer(failed, { type: "play" }).status).toBe("error");
    expect(playbackReducer(failed, { type: "released" })).toEqual({
      ...initialPlaybackState,
      rate: 1,
    });
  });

  it("cycles the rate 1 → 1.5 → 2 → 1", () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
    const cycled = run([{ type: "cycleRate" }, { type: "cycleRate" }, { type: "cycleRate" }]);
    expect(cycled.rate).toBe(1);
  });

  it("clamps outside the duration and tolerates an unknown duration", () => {
    expect(clampTime(-1, 10)).toBe(0);
    expect(clampTime(11, 10)).toBe(10);
    expect(clampTime(5, 0)).toBe(5);
    expect(clampTime(NaN, 10)).toBe(0);
  });
});

describe("rangeIndexAtTime", () => {
  const ranges = [
    { start: 0, end: 4 },
    { start: 5, end: 9 },
    { start: 10, end: 14 },
    { start: 20, end: 24 },
  ];

  it("finds the containing range by binary search", () => {
    expect(rangeIndexAtTime(ranges, 0)).toBe(0);
    expect(rangeIndexAtTime(ranges, 4)).toBe(0);
    expect(rangeIndexAtTime(ranges, 7.5)).toBe(1);
    expect(rangeIndexAtTime(ranges, 14)).toBe(2);
    expect(rangeIndexAtTime(ranges, 22)).toBe(3);
  });

  it("returns -1 in a gap, before the first range, and past the last", () => {
    expect(rangeIndexAtTime(ranges, 17)).toBe(-1);
    expect(rangeIndexAtTime(ranges, -1)).toBe(-1);
    expect(rangeIndexAtTime(ranges, 30)).toBe(-1);
    expect(rangeIndexAtTime([], 3)).toBe(-1);
    expect(rangeIndexAtTime(ranges, NaN)).toBe(-1);
  });

  it("resolves a shared boundary to the later range", () => {
    const touching = [
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ];
    expect(rangeIndexAtTime(touching, 5)).toBe(1);
  });

  it("agrees with a linear scan over a long, uneven transcript", () => {
    const long = Array.from({ length: 500 }, (_, index) => ({
      start: index * 3,
      end: index * 3 + (index % 2 === 0 ? 2.5 : 3),
    }));
    for (const time of [0, 1.7, 2.75, 3, 749.9, 1497, 1499.9, 1500.5, 1600]) {
      const linear = long.findIndex((range) => time >= range.start && time <= range.end);
      const binary = rangeIndexAtTime(long, time);
      // Where two ranges touch, the binary search picks the later one; the
      // linear scan the earlier. Both are "containing", so allow either.
      if (linear !== -1 && long[linear].end === time && long[linear + 1]?.start === time) {
        expect([linear, linear + 1]).toContain(binary);
      } else {
        expect(binary).toBe(linear);
      }
    }
  });
});

describe("formatClock", () => {
  it("formats minutes and rolls into hours", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3599)).toBe("59:59");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-4)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
  });
});
