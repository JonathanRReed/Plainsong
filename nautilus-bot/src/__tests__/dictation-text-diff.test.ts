import { describe, expect, it } from "vitest";

import { diffDictationText } from "@/lib/dictation-text-diff";

function reconstruct(
  parts: ReturnType<typeof diffDictationText>,
  side: "original" | "current",
) {
  return parts
    .filter((part) => part.type === "equal" || (
      side === "original" ? part.type === "removed" : part.type === "added"
    ))
    .map((part) => part.text)
    .join("");
}

describe("diffDictationText", () => {
  it("reconstructs punctuation and whitespace exactly on both sides", () => {
    const original = "Hello,  world!\nNext line.";
    const current = "Hello world?\nNext  line.";

    const parts = diffDictationText(original, current);

    expect(reconstruct(parts, "original")).toBe(original);
    expect(reconstruct(parts, "current")).toBe(current);
    expect(parts.some((part) => part.type === "removed")).toBe(true);
    expect(parts.some((part) => part.type === "added")).toBe(true);
  });

  it("keeps repeated tokens deterministic without losing either text", () => {
    const original = "go go now";
    const current = "go now now";

    const first = diffDictationText(original, current);
    const second = diffDictationText(original, current);

    expect(second).toEqual(first);
    expect(reconstruct(first, "original")).toBe(original);
    expect(reconstruct(first, "current")).toBe(current);
  });

  it("uses a bounded coarse diff for inputs beyond the LCS work cap", () => {
    const sharedStart = "start ";
    const sharedEnd = " end";
    const original = `${sharedStart}${"alpha ".repeat(520)}${sharedEnd}`;
    const current = `${sharedStart}${"beta ".repeat(520)}${sharedEnd}`;

    const parts = diffDictationText(original, current);

    expect(parts.length).toBeLessThanOrEqual(4);
    expect(reconstruct(parts, "original")).toBe(original);
    expect(reconstruct(parts, "current")).toBe(current);
  });

  it("keeps emoji intact in the bounded coarse diff", () => {
    const original = `start ${"😀 ".repeat(520)}end`;
    const current = `start ${"😁 ".repeat(520)}end`;

    const parts = diffDictationText(original, current);

    expect(reconstruct(parts, "original")).toBe(original);
    expect(reconstruct(parts, "current")).toBe(current);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/u.test(part.text))).toBe(true);
    expect(parts.every((part) => !/^[\uDC00-\uDFFF]/u.test(part.text))).toBe(true);
  });
});
