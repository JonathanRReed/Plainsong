import { describe, expect, it } from "vitest";
import { dictationChangeSelections, restoreDictationChange } from "./dictation-change-selections";

describe("individual dictation restoration", () => {
  it("shows shared context without including another changed phrase", () => {
    const changes = dictationChangeSelections("Wait fifteen minutes, then call Jon.", "Wait five minutes, then call Jonathan.");
    expect(changes[0]).toMatchObject({ original: "fifteen", current: "five", contextBefore: "Wait ", contextAfter: " minutes, then call " });
    expect(changes[1]).toMatchObject({ contextBefore: " minutes, then call ", contextAfter: "" });
    expect(restoreDictationChange("Wait five minutes, then call Jonathan.", changes[0])).toBe("Wait fifteen minutes, then call Jonathan.");
  });
  it("preserves Unicode and whitespace in adjacent context", () => {
    const changes = dictationChangeSelections("😀 café\n\t十五\u00a0minutes", "😀 café\n\t五\u00a0minutes");
    expect(changes[0]).toMatchObject({ contextBefore: "😀 café\n\t", contextAfter: "\u00a0minutes", original: "十五", current: "五" });
  });
  it("bounds context by Unicode code points without cutting surrogate pairs", () => {
    const prefix = `${"😀".repeat(120)} `;
    const suffix = ` ${"🦉".repeat(120)}`;
    const change = dictationChangeSelections(`${prefix}old${suffix}`, `${prefix}new${suffix}`)[0];
    expect(change.contextBefore).toBe(`${"😀".repeat(79)} `);
    expect(change.contextAfter).toBe(` ${"🦉".repeat(79)}`);
    expect(change.contextBeforeTruncated).toBe(true);
    expect(change.contextAfterTruncated).toBe(true);
  });
  it("restores one replacement and keeps another correction", () => {
    const original = "Meet noon with Jon.";
    const current = "Meet midnight with Jonathan.";
    const changes = dictationChangeSelections(original, current);
    expect(changes).toHaveLength(2);
    expect(restoreDictationChange(current, changes[0])).toBe("Meet noon with Jonathan.");
    expect(restoreDictationChange(current, changes[1])).toBe("Meet midnight with Jon.");
  });
  it("restores deleted whitespace exactly", () => {
    const original = "First\n\n  second\tthird";
    const current = "First second third";
    const changes = dictationChangeSelections(original, current);
    expect(restoreDictationChange(current, changes[0])).toBe("First\n\n  second third");
    expect(restoreDictationChange(current, changes[1])).toBe("First second\tthird");
  });
  it("handles pure insertions and deletions", () => {
    expect(restoreDictationChange("New", dictationChangeSelections("", "New")[0])).toBe("");
    expect(restoreDictationChange("", dictationChangeSelections("Deleted", "")[0])).toBe("Deleted");
  });
  it("uses character offsets after non-ASCII text", () => {
    const text = "😀 café red";
    const change = dictationChangeSelections("😀 café blue", text)[0];
    expect(restoreDictationChange(text, change)).toBe("😀 café blue");
  });
  it("bounds long review text and restores the full changed range", () => {
    const prefix = "same ".repeat(400);
    const suffix = " end".repeat(400);
    const original = `${prefix}old${suffix}`;
    const current = `${prefix}new${suffix}`;
    const changes = dictationChangeSelections(original, current);
    expect(changes).toHaveLength(1);
    expect(Array.from(changes[0].contextBefore).length).toBeLessThanOrEqual(80);
    expect(Array.from(changes[0].contextAfter).length).toBeLessThanOrEqual(80);
    expect(changes[0].contextBeforeTruncated).toBe(true);
    expect(changes[0].contextAfterTruncated).toBe(true);
    expect(restoreDictationChange(current, changes[0])).toBe(original);
  });

  it("cuts long context at a word boundary when whole words remain", () => {
    const before = "Hi Maya, the usability sessions went well and the feedback was positive. Let's go through the write-up together on ";
    const [removal] = dictationChangeSelections(`${before}Tuesday. No wait, Wednesday.`, `${before}Wednesday.`);
    expect(removal.contextBefore).toBe("well and the feedback was positive. Let's go through the write-up together on ");
    expect(removal.contextBeforeTruncated).toBe(true);
    const after = " and then the rest of a fairly long sentence that keeps going well past the eighty point limit here";
    const [swap] = dictationChangeSelections(`Meet at noon${after}`, `Meet at one${after}`);
    expect(swap.contextAfter).toBe(" and then the rest of a fairly long sentence that keeps going well past the ");
    expect(swap.contextAfterTruncated).toBe(true);
  });
});
