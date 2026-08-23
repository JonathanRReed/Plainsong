import { describe, expect, it } from "vitest";
import { matchSpokenFixture } from "../../scripts/lib/spoken-fixture-match.mjs";

describe("meeting soak spoken-fixture matching", () => {
  const fixture =
    "Plainsong packaged meeting soak fixture. The transcript should contain this repeated launch readiness sentence.";

  it("rejects a nonempty transcript that does not contain the fixture", () => {
    const result = matchSpokenFixture("Thank you.", fixture);

    expect(result.matched).toBe(false);
    expect(result.matchedTokens).toEqual([]);
    expect(result.requiredMatchCount).toBe(6);
  });

  it("rejects a short three-token false positive from a longer fixture", () => {
    const result = matchSpokenFixture(
      "PLAINSONG recorded the packaged meeting fixture.",
      fixture,
    );

    expect(result.matched).toBe(false);
    expect(result.coverage).toBeLessThan(result.minimumCoverage);
  });

  it("accepts recognition-tolerant content with ordered distinctive coverage", () => {
    const result = matchSpokenFixture(
      "Plainsong packaged meeting soak fixture. Transcript contains a launch readiness sentence.",
      fixture,
    );

    expect(result.matched).toBe(true);
    expect(result.coverage).toBeGreaterThanOrEqual(result.minimumCoverage);
    expect(result.orderedCoverage).toBeGreaterThanOrEqual(
      result.minimumOrderedCoverage,
    );
    expect(result.missingTokens).toContain("repeated");
  });

  it("rejects truncated fixture content even when the opening is correct", () => {
    const result = matchSpokenFixture(
      "Plainsong packaged meeting soak fixture.",
      fixture,
    );

    expect(result.matched).toBe(false);
    expect(result.missingTokens.length).toBeGreaterThan(0);
  });

  it("rejects distinctive words replayed in the wrong order", () => {
    const result = matchSpokenFixture(
      "sentence readiness launch repeated transcript fixture soak meeting packaged Plainsong",
      fixture,
    );

    expect(result.matched).toBe(false);
    expect(result.orderViolations.length).toBeGreaterThan(0);
  });

  it("requires every distinctive word when a custom fixture has fewer than three", () => {
    expect(matchSpokenFixture("alpha beta", "Alpha beta").matched).toBe(true);
    expect(matchSpokenFixture("alpha only", "Alpha beta").matched).toBe(false);
  });

  it("reports transcript length and omissions for the release receipt", () => {
    const result = matchSpokenFixture("Plainsong packaged", fixture);

    expect(result.transcriptLength).toEqual({ characters: 18, tokens: 2 });
    expect(result.omissions).toEqual(result.missingTokens);
  });
});
