import { describe, expect, it } from "vitest";
import type { DictationInsights } from "@/lib/backend";
import { dictationHeadlineStats, formatCount, formatDuration } from "@/lib/dictation-stats";

function insights(overrides: Partial<DictationInsights>): DictationInsights {
  return {
    totalDictations: 0,
    dictatedWords: 0,
    averageWordsPerDictation: 0,
    activeDays: 0,
    lastSevenDaysDictations: 0,
    commandsUsed: 0,
    backtracksUsed: 0,
    snippetsTriggered: 0,
    topAppTarget: null,
    topAppTargetCount: 0,
    ...overrides,
  };
}

describe("dictation headline stats", () => {
  it("derives pace and time saved from words and speaking time", () => {
    // 3,000 words spoken in 20 minutes: 150 wpm; typing them at 40 wpm
    // takes 75 minutes, so 55 are saved.
    const stats = dictationHeadlineStats(
      insights({ dictatedWords: 3000, spokenSeconds: 1200, currentStreakDays: 4 }),
    );
    expect(stats).toEqual({ words: 3000, wordsPerMinute: 150, minutesSaved: 55, streakDays: 4 });
  });

  it("shows no pace until there is enough audio, and never negative time", () => {
    expect(dictationHeadlineStats(insights({ dictatedWords: 5, spokenSeconds: 10 })).wordsPerMinute).toBeNull();
    expect(dictationHeadlineStats(insights({ dictatedWords: 10, spokenSeconds: 600 })).minutesSaved).toBe(0);
    // An older sidecar without the new fields still renders.
    expect(dictationHeadlineStats(insights({ dictatedWords: 400 }))).toMatchObject({
      wordsPerMinute: null,
      minutesSaved: 10,
      streakDays: 0,
    });
  });

  it("formats counts and durations compactly", () => {
    expect([formatCount(999), formatCount(1200), formatCount(12_400), formatCount(1_500_000)]).toEqual([
      "999",
      "1.2k",
      "12k",
      "1.5M",
    ]);
    expect([formatDuration(45), formatDuration(192), formatDuration(720)]).toEqual(["45 min", "3.2 h", "12 h"]);
  });
});
