import { describe, expect, it } from "vitest";
import { findTranscriptMatches } from "@/lib/transcript-search";

const rows = (...entries: Array<[string, string, number]>) =>
  entries.map(([id, text, startTime]) => ({ id, text, startTime }));

const ranges = (result: ReturnType<typeof findTranscriptMatches>, id: string) =>
  result.rangesBySegment.get(id) ?? [];

describe("findTranscriptMatches", () => {
  it.each([
    ["🙂 José", "Jose\u0301", 7],
    ["🙂 Jose\u0301", "José", 8],
  ])("matches equivalent Unicode spellings in %s and preserves highlight offsets", (text, query, end) => {
    const result = findTranscriptMatches(rows(["a", text, 1]), query);
    expect(result.matches).toEqual([{ segmentId: "a", startTime: 1 }]);
    expect(ranges(result, "a")).toEqual([{ start: 3, end, matchIndex: 0, isStart: true }]);
  });

  it.each(["[", "*", "(", '"', "OR", "NEAR(", "a:b", "🙂"])("treats search syntax %s as literal text", (query) => {
    expect(findTranscriptMatches(rows(["a", `xx ${query} yy`, 1]), query).matches).toHaveLength(1);
  });

  it("finds a phrase across reading-order rows and anchors it to the first row", () => {
    const result = findTranscriptMatches(
      rows(["a", "The observed", 1], ["b", "one point four result", 2]),
      "observed one point four",
    );

    expect(result.matches).toEqual([{ segmentId: "a", startTime: 1 }]);
    expect(ranges(result, "a")).toEqual([
      { start: 4, end: 12, matchIndex: 0, isStart: true },
    ]);
    expect(ranges(result, "b")).toEqual([
      { start: 0, end: 14, matchIndex: 0, isStart: false },
    ]);
  });

  it("returns nonoverlapping occurrences in the same and later rows", () => {
    const result = findTranscriptMatches(
      rows(["a", "Echo echo", 4], ["b", "ECHO", 9]),
      "echo",
    );

    expect(result.matches).toEqual([
      { segmentId: "a", startTime: 4 },
      { segmentId: "a", startTime: 4 },
      { segmentId: "b", startTime: 9 },
    ]);
    expect(ranges(result, "a")).toEqual([
      { start: 0, end: 4, matchIndex: 0, isStart: true },
      { start: 5, end: 9, matchIndex: 1, isStart: true },
    ]);
    expect(ranges(result, "b")).toEqual([
      { start: 0, end: 4, matchIndex: 2, isStart: true },
    ]);
  });

  it("searches chronologically without treating speaker changes as boundaries", () => {
    const result = findTranscriptMatches(
      rows(["speaker-a", "handoff", 10], ["speaker-b", "continues", 11]),
      "handoff continues",
    );

    expect(result.matches).toEqual([{ segmentId: "speaker-a", startTime: 10 }]);
  });

  it("collapses whitespace and empty row separators", () => {
    const result = findTranscriptMatches(
      rows(["a", "alpha\t", 1], ["empty", "", 2], ["b", "\n beta", 3]),
      "  alpha   beta  ",
    );

    expect(result.matches).toEqual([{ segmentId: "a", startTime: 1 }]);
    expect(ranges(result, "a")).toEqual([
      { start: 0, end: 6, matchIndex: 0, isStart: true },
    ]);
    expect(ranges(result, "empty")).toEqual([]);
    expect(ranges(result, "b")).toEqual([
      { start: 0, end: 6, matchIndex: 0, isStart: false },
    ]);
  });

  it("keeps punctuation literal", () => {
    const source = rows(["a", "one-point-four one point four", 1]);

    expect(findTranscriptMatches(source, "one-point-four").matches).toHaveLength(1);
    expect(findTranscriptMatches(source, "one point four").matches).toHaveLength(1);
    expect(findTranscriptMatches(source, "one.point.four").matches).toHaveLength(0);
  });

  it("preserves UTF-16 offsets through lowercase expansion and emoji", () => {
    const result = findTranscriptMatches(
      rows(["a", "xİ🙂Y", 1]),
      "i̇🙂y",
    );

    expect(result.matches).toEqual([{ segmentId: "a", startTime: 1 }]);
    expect(ranges(result, "a")).toEqual([
      { start: 1, end: 5, matchIndex: 0, isStart: true },
    ]);
  });

  it("folds Greek final sigma consistently in query and transcript context", () => {
    const result = findTranscriptMatches(
      rows(["a", "ΟΣ ος", 1]),
      "οσ",
    );

    expect(result.matches).toHaveLength(2);
    expect(ranges(result, "a")).toEqual([
      { start: 0, end: 2, matchIndex: 0, isStart: true },
      { start: 3, end: 5, matchIndex: 1, isStart: true },
    ]);
  });

  it("does not duplicate a hit when lowercase expansion maps search units to one character", () => {
    const result = findTranscriptMatches(rows(["a", "İ", 1]), "i");

    expect(result.matches).toEqual([{ segmentId: "a", startTime: 1 }]);
    expect(ranges(result, "a")).toEqual([
      { start: 0, end: 1, matchIndex: 0, isStart: true },
    ]);
  });

  it("leaves source rows unchanged and ranges reproduce the matched source text", () => {
    const source = rows(["a", "Keep THIS", 1], ["b", "text intact", 2]);
    const snapshot = structuredClone(source);
    const result = findTranscriptMatches(source, "this text");

    expect(source).toEqual(snapshot);
    expect(
      [...result.rangesBySegment].flatMap(([id, foundRanges]) => {
        const text = source.find((row) => row.id === id)?.text ?? "";
        return foundRanges.map((range) => text.slice(range.start, range.end));
      }),
    ).toEqual(["THIS", "text"]);
  });

  it("returns no matches for an empty or whitespace-only query", () => {
    const source = rows(["a", "anything", 1]);

    expect(findTranscriptMatches(source, "")).toEqual({
      matches: [],
      rangesBySegment: new Map(),
    });
    expect(findTranscriptMatches(source, " \n\t ").matches).toEqual([]);
  });

  it("keeps dense same-segment occurrences ordered and distinct", () => {
    const occurrenceCount = 2_000;
    const text = "a ".repeat(occurrenceCount);
    const result = findTranscriptMatches(rows(["a", text, 1]), "a");
    const foundRanges = ranges(result, "a");

    expect(result.matches).toHaveLength(occurrenceCount);
    expect(foundRanges).toHaveLength(occurrenceCount);
    expect(foundRanges[0]).toEqual({
      start: 0,
      end: 1,
      matchIndex: 0,
      isStart: true,
    });
    expect(foundRanges[1_999]).toEqual({
      start: 3_998,
      end: 3_999,
      matchIndex: 1_999,
      isStart: true,
    });
    expect(
      foundRanges.every(
        (range, index) => index === 0 || foundRanges[index - 1].end <= range.start,
      ),
    ).toBe(true);
  });
});
