import { describe, expect, it } from "vitest";
import { parseTranscriptTime, transcriptNavigationEnd, transcriptSections, transcriptSegmentAt } from "@/lib/meeting-transcript-navigation";
import type { TranscriptSegment } from "@/types";
const segment = (id: string, startTime: number, speakerId = "a") => ({ id, startTime, endTime: startTime + 10, speakerId, text: id, confidence: 1 }) as TranscriptSegment;
describe("meeting transcript navigation", () => {
  it("bounds navigation by known starts and valid ends on navigable segments", () => {
    for (const endTime of [undefined, NaN, Infinity, -1, 599]) {
      const late = { ...segment("late", 600), endTime } as TranscriptSegment;
      const invalid = [NaN, Infinity, -1].map(startTime => ({ ...segment("bad", startTime), endTime: 900 }));
      expect(transcriptNavigationEnd([segment("early", 0), late, ...invalid])).toBe(600);
      expect(late.endTime).toBe(endTime);
    }
    expect(transcriptNavigationEnd([segment("late", 600)])).toBe(610);
    expect(transcriptNavigationEnd([])).toBe(0);
  });
  it("orders original segments into occupied time sections and filters speakers before choosing a jump", () => {
    const segments = [segment("late", 700), segment("bad", NaN), segment("other", 15, "b"), segment("first", 2), segment("negative", -2)];
    expect(transcriptSections(segments).map(section => [section.interval, section.first.id, section.count])).toEqual([[0, "first", 2], [2, "late", 1]]);
    expect(transcriptSections(segments, "b")[0].first.id).toBe("other");
    expect(transcriptSections(segments, "missing")).toEqual([]);
    expect(segments[0].id).toBe("late");
  });
  it("accepts full time formats and rejects malformed or overflow values", () => {
    expect(parseTranscriptTime(" 12:30 ")).toBe(750);
    expect(parseTranscriptTime("1:02:03")).toBe(3723);
    for (const value of ["12", "1:2", "1:60", "1:60:00", "-1:00", "Infinity:00", "999999999999999999999:00"]) expect(parseTranscriptTime(value)).toBeNull();
  });
  it("uses the next start to select evidence when an end is missing or invalid", () => {
    const first = segment("first", 2);
    for (const endTime of [NaN, undefined, 1]) {
      const segments = [{ ...first, endTime } as TranscriptSegment, segment("next", 30)];
      expect(transcriptSegmentAt(segments, 15)?.id).toBe("first");
      expect(transcriptSegmentAt(segments, 30)?.id).toBe("next");
      expect(segments[0].endTime).toBe(endTime);
    }
  });
  it("finds evidence in unsorted segments including gaps and the final endpoint", () => {
    const segments = [segment("last", 700), segment("first", 2), segment("bad", NaN)];
    expect(transcriptSegmentAt(segments, 5)?.id).toBe("first");
    expect(transcriptSegmentAt(segments, 100)?.id).toBe("last");
    expect(transcriptSegmentAt(segments, 710)?.id).toBe("last");
    expect(transcriptSegmentAt([], 0)).toBeUndefined();
  });
});
