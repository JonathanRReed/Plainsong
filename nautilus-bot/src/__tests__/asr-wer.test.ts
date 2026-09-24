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
      "ship", "it", "at", "25", "past", "okay",
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
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const long = scoreUtterance(words, words);
    const corpus = aggregateWer([short, long]);
    expect(corpus.utterances).toBe(2);
    expect(corpus.wer).toBeCloseTo(1 / 11);
  });
});

describe("ASR word error rate: written vs spoken numbers", () => {
  const same = (a: string, b: string) =>
    expect(normalizeForWer(a)).toEqual(normalizeForWer(b));

  it("treats the prompt set's numbers as equal whichever way a route writes them", () => {
    same("call me back at five five five one two three four", "Call me back at 555-1234");
    same("four thousand two hundred and fifty dollars", "$4,250");
    same("returns a four oh one", "returns a 401");
    same("eight point two percent", "8.2%");
    same("room two fourteen", "room 214");
    same("the fourteenth of October", "the 14th of October");
    same("March third", "March 3rd");
    same("twenty twenty", "2020");
    same("one hundred", "100");
    same("twelve thousand", "12,000");
    same("three thirty", "3:30");
    same("twenty first", "21st");
    same("okay", "OK");
    expect(normalizeForWer("five five five one two three four")).toEqual(["5551234"]);
  });

  it("does not turn ordinary words into numbers", () => {
    expect(normalizeForWer("oh I see")).toEqual(["oh", "i", "see"]);
    expect(normalizeForWer("the point is")).toEqual(["the", "point", "is"]);
    expect(normalizeForWer("a hundred reasons")).toEqual(["a", "hundred", "reasons"]);
  });

  it("still counts a wrong number as an error", () => {
    expect(scoreUtterance("room two fourteen", "room 215").errors).toBe(1);
    expect(scoreUtterance("eight point two percent", "8.3%").errors).toBe(1);
  });
});
