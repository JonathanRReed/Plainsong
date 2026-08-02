import { describe, expect, it } from "vitest";
import { matchSpokenFixture } from "../../scripts/lib/spoken-fixture-match.mjs";

describe("meeting soak spoken-fixture matching", () => {
  const fixture =
    "Plainsong packaged meeting soak fixture. The transcript should contain this repeated launch readiness sentence.";

  it("rejects a nonempty transcript that does not contain the fixture", () => {
    const result = matchSpokenFixture("Thank you.", fixture);

    expect(result.matched).toBe(false);
    expect(result.matchedTokens).toEqual([]);
    expect(result.requiredMatchCount).toBe(3);
  });

  it("accepts recognizable fixture content without requiring an exact transcript", () => {
    const result = matchSpokenFixture(
      "PLAINSONG recorded the packaged meeting fixture.",
      fixture,
    );

    expect(result.matched).toBe(true);
    expect(result.matchedTokens).toEqual(
      expect.arrayContaining(["plainsong", "packaged", "meeting"]),
    );
  });

  it("requires every distinctive word when a custom fixture has fewer than three", () => {
    expect(matchSpokenFixture("alpha beta", "Alpha beta").matched).toBe(true);
    expect(matchSpokenFixture("alpha only", "Alpha beta").matched).toBe(false);
  });
});
