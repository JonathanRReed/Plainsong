import { describe, expect, it } from "vitest";
import {
  aggregateWer,
  alignWords,
  normalizeForWer,
  scoreUtterance,
} from "../../scripts/lib/asr-wer.mjs";

describe("ASR word error rate", () => {
  it("ignores case, punctuation and spoken-vs-written numbers", () => {
    expect(normalizeForWer("Ship it at twenty-five past, OK?")).toEqual([
      "ship", "it", "at", "25", "past", "ok",
    ]);
    expect(scoreUtterance("I have three cats.", "i have 3 cats").wer).toBe(0);
    expect(scoreUtterance("Don't stop", "don’t stop").wer).toBe(0);
  });

  it("counts substitutions, deletions and insertions on the cheapest alignment", () => {
    expect(alignWords(["a", "b", "c"], ["a", "x", "c"])).toEqual({
      substitutions: 1, deletions: 0, insertions: 0,
    });
    expect(alignWords(["a", "b", "c"], ["a", "c"])).toEqual({
      substitutions: 0, deletions: 1, insertions: 0,
    });
    expect(alignWords(["a", "c"], ["a", "b", "c", "d"])).toEqual({
      substitutions: 0, deletions: 0, insertions: 2,
    });
    expect(alignWords([], ["a"])).toEqual({ substitutions: 0, deletions: 0, insertions: 1 });
  });

  it("penalizes a rewrite that adds words the speaker never said", () => {
    const score = scoreUtterance(
      "send the report to Dana",
      "Please send the final report over to Dana.",
    );
    expect(score.insertions).toBe(3);
    expect(score.wer).toBeCloseTo(3 / 5);
  });

  it("weights corpus WER by reference length", () => {
    const short = scoreUtterance("yes", "no");
    const long = scoreUtterance("one two three four five six seven eight nine ten", "one two three four five six seven eight nine ten");
    const corpus = aggregateWer([short, long]);
    expect(corpus.utterances).toBe(2);
    expect(corpus.wer).toBeCloseTo(1 / 11);
  });
});
