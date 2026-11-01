import { describe, expect, it } from "vitest";
import {
  aggregateWer,
  alignWords,
  normalizeForWer,
  scoreUtterance,
} from "../../scripts/lib/asr-wer.ts";

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
    same("confectionary fifteen o eight", "Confectionary 1508");
    same("eight point two percent", "8.2%");
    same("room two fourteen", "room 214");
    same("the fourteenth of October", "the 14th of October");
    same("March third", "March 3rd");
    same("twenty twenty", "2020");
    same("one hundred", "100");
    same("twelve thousand", "12,000");
    same("three thirty", "3:30");
    same("twenty first", "21st");
    same("the five hundred and sixty third night", "the 563rd night");
    same("the seven hundred and eighteenth night", "the 718th night");
    same("the one hundred twelfth floor", "the 112th floor");
    same("five hundred first editions", "500 first editions");
    same("two hundred and first", "201st");
    same("seven hundred and eighteenth", "718th");
    same("five hundred twentieth", "520th");
    expect(normalizeForWer("twenty first")).toEqual(["20", "1st"]);
    same("okay", "OK");
    expect(normalizeForWer("five five five one two three four")).toEqual(["5551234"]);
  });

  it("does not turn ordinary words into numbers", () => {
    expect(normalizeForWer("oh I see")).toEqual(["oh", "i", "see"]);
    expect(normalizeForWer("the point is")).toEqual(["the", "point", "is"]);
    expect(normalizeForWer("a hundred reasons")).toEqual(["a", "hundred", "reasons"]);
  });

  it("scores an ambiguous spoken ordinal as either written form", () => {
    // "three hundred and twenty second graders" may be 320 second graders or
    // the 322nd graders; the dictation ITN keeps the words unless the
    // ordinal reading is settled. No form is counted as an error.
    const spoken = "three hundred and twenty second graders";
    expect(scoreUtterance(spoken, "320 second graders").errors).toBe(0);
    expect(scoreUtterance(spoken, "322nd graders").errors).toBe(0);
    expect(scoreUtterance("set a thirty second timer", "Set a 30 second timer.").errors).toBe(0);
    expect(scoreUtterance("the five hundred and sixty third night", "the 560 third night").errors).toBe(0);
    for (const written of ["the twenty first item", "the 21st item", "the 20 first item"]) {
      expect(scoreUtterance("the twenty first item", written).errors).toBe(0);
    }
    // A different number is still wrong.
    expect(scoreUtterance(spoken, "324th graders").errors).toBe(1);
    expect(scoreUtterance("the five hundred and sixty third night", "the 564th night").errors).toBe(1);
  });

  it("still counts a wrong number as an error", () => {
    expect(scoreUtterance("room two fourteen", "room 215").errors).toBe(1);
    expect(scoreUtterance("eight point two percent", "8.3%").errors).toBe(1);
  });
});
