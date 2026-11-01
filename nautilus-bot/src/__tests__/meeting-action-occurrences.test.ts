import { describe, expect, it } from "vitest";
import { matchActionItemOccurrences, type ActionItemOccurrence } from "@/lib/meeting-action-occurrences";

const generated = (startTime: number): ActionItemOccurrence => ({
  item: "Send report", citations: [{ text: "Send report", startTime, endTime: startTime + 2 }], grounded: true,
});
const manual: ActionItemOccurrence = { item: "Send report", citations: null, grounded: false };

describe("meeting action occurrence provenance", () => {
  it("keeps separate citation times for repeated task text", () => {
    const result = matchActionItemOccurrences(["Send report", "Send report"], [generated(10), generated(70)]);
    expect(result.map((item) => item.citations?.[0].startTime)).toEqual([10, 70]);
    expect(matchActionItemOccurrences(["Send report"], [generated(70)])[0].citations?.[0].startTime).toBe(70);
    expect(matchActionItemOccurrences(["Send report"], [generated(10)])[0].citations?.[0].startTime).toBe(10);
  });

  it.each([[manual, generated(70)], [generated(10), manual]])("retains manual placeholders in either occurrence order", (first, second) => {
    expect(matchActionItemOccurrences(["Send report", "Send report"], [first, second])).toEqual([first, second]);
    // Deletion acknowledgements carry the surviving occurrence, rather than a text lookup.
    expect(matchActionItemOccurrences(["Send report"], [second])).toEqual([second]);
    expect(matchActionItemOccurrences(["Send report"], [first])).toEqual([first]);
    expect(matchActionItemOccurrences(["Send report", "Send report"], [first, second])).toEqual([first, second]);
  });

  it("withholds ambiguous duplicate evidence during structural text edits", () => {
    const source = [generated(10), manual, { ...generated(40), item: "Book room" }];
    const result = matchActionItemOccurrences(["Send report", "Book room"], source);
    expect(result[0]).toEqual(manual);
    expect(result[1].citations?.[0].startTime).toBe(40);
    expect(matchActionItemOccurrences(["Send report"], [generated(10), manual])).toEqual([manual]);
    // The persisted row acknowledgement restores the exact surviving slot.
    expect(matchActionItemOccurrences(["Send report"], [generated(10)])).toEqual([generated(10)]);
  });

  it("drops evidence for edited text without consuming another occurrence", () => {
    expect(matchActionItemOccurrences(["Send revised report", "Send report"], [manual, generated(70)]))
      .toEqual([{ item: "Send revised report", citations: null, grounded: false }, generated(70)]);
  });
});

describe("meeting action evidence", () => {
  it("keeps a quoted source only for the unchanged generated item", () => {
    const quoted: ActionItemOccurrence = { ...generated(10), evidence: "I'll send the report." };
    expect(matchActionItemOccurrences(["Send report"], [quoted])[0].evidence).toBe("I'll send the report.");
    expect(matchActionItemOccurrences(["Send the report today"], [quoted])[0].evidence).toBeUndefined();
  });

  it("keeps the unclear mark only for the unchanged generated item", () => {
    const unclear: ActionItemOccurrence = { ...generated(10), evidence: "I'll send the report.", unclear: true };
    expect(matchActionItemOccurrences(["Send report"], [unclear])[0].unclear).toBe(true);
    expect(matchActionItemOccurrences(["Send the report today"], [unclear])[0].unclear).toBeUndefined();
  });
});
