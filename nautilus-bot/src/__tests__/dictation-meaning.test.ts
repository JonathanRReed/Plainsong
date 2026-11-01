import { describe, expect, it } from "vitest";

import fixtures from "../../docs/evals/dictation-meaning-fixtures.json";
import openingRegressions from "../../docs/evals/household-opening-regressions-2026-10-14.json";
import {
  normalizeMeaningText,
  scoreMeaningCandidate,
} from "../../scripts/lib/dictation-meaning.mjs";

describe("dictation meaning fixtures", () => {
  it("keeps a broad, synthetic, auditable fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(24);
    expect(fixtures.length).toBeLessThanOrEqual(32);
    expect(new Set(fixtures.map((fixture) => fixture.appCategory)).size).toBeGreaterThanOrEqual(5);
    for (const fixture of fixtures) {
      expect(fixture.source).toBe("synthetic");
      expect(fixture.spokenText.trim()).not.toBe("");
      expect(fixture.referenceOutput.trim()).not.toBe("");
      expect(fixture.intendedFacts.length).toBeGreaterThan(0);
      expect(fixture.criticalInvariants.length).toBeGreaterThan(0);
    }
  });

  it("catches dropped negation, wrong corrections, and missing conditions", () => {
    const negation = fixtures.find((fixture) => fixture.id === "negation-deploy");
    const amount = fixtures.find((fixture) => fixture.id === "corrected-amount");
    const day = fixtures.find((fixture) => fixture.id === "corrected-day");
    const condition = fixtures.find((fixture) => fixture.id === "conditional-send");
    expect(negation && amount && day && condition).toBeTruthy();

    expect(scoreMeaningCandidate(negation!, "Deploy this tonight.").status).toBe("fail");
    expect(scoreMeaningCandidate(amount!, "The approved budget is $12,000.").status).toBe("fail");
    expect(scoreMeaningCandidate(day!, "Let's meet Tuesday at 3:30.").status).toBe("fail");
    expect(scoreMeaningCandidate(condition!, "Send the invoice today.").status).toBe("fail");
  });

  it("accepts justified punctuation, case, and numeric normalization", () => {
    expect(normalizeMeaningText("Budget: twelve thousand dollars!"))
      .toBe(normalizeMeaningText("budget $12,000"));
  });

  it.each([
    "Can we send it today. Marcus approved the copy.",
    "Can we send it today. Marcus approved the copy?",
    "Can we send it today? Marcus approved the copy?",
  ])("requires review when question boundaries change: %s", candidate => {
    const fixture = {
      referenceOutput: "Can we send it today? Marcus approved the copy.",
      criticalInvariants: [],
    };
    const result = scoreMeaningCandidate(fixture, candidate);
    expect(result.status).toBe("needs_human_review");
    expect(result.needsHumanReview).toBe(true);
  });

  it("accepts formatting changes that keep the question on the same words", () => {
    const fixture = {
      referenceOutput: "Can we send $15,000 today?? Marcus approved the copy.",
      criticalInvariants: [],
    };
    const result = scoreMeaningCandidate(fixture, "Can we send fifteen thousand dollars today? Marcus approved the copy.");
    expect(result.status).toBe("pass");
  });

  it.each([
    ["Keep the rate at 0.5 percent.", "Keep the rate at 0 5 percent."],
    ["The price is 12.50 euros.", "The price is 12 50 euros."],
    ["Keep values 1,2.", "Keep values 12."],
    ["Use values 1.2, 1, 2.", "Use values 1, 2, 1.2."],
    ["Keep values 1,000,00.", "Keep values 1000 00."],
    ["Keep values 12,34,567.", "Keep values 12 34567."],
    ["Keep the rate below .5 percent.", "Keep the rate below 5 percent."],
    ["The change is -.5 percent.", "The change is .5 percent."],
    ["Use 1e-5 volts.", "Use 1e+5 volts."],
    ["Let us eat, Grandma.", "Let us eat Grandma."],
  ])("requires review when meaningful punctuation changes: %s", (referenceOutput, candidate) => {
    const result = scoreMeaningCandidate({ referenceOutput, criticalInvariants: [] }, candidate);
    expect(result.status).toBe("needs_human_review");
    expect(result.needsHumanReview).toBe(true);
  });

  it("accepts declared spoken decimals and valid thousands grouping", () => {
    for (const [referenceOutput, candidate] of [
      ["Keep the rate below 0.5 percent.", "Keep the rate below zero point five percent."],
      ["The budget is $15,000.50.", "The budget is $15000.50."],
      ["The budget is $1,000,000.", "The budget is $1000000."],
      ["The budget is $15,000.50, subject to approval.", "The budget is $15000.50, subject to approval."],
      ["Keep the rate below .5 percent.", "Keep the rate below 0.5 percent."],
      ["The price is $.50.", "The price is $0.50."],
    ]) {
      expect(scoreMeaningCandidate({ referenceOutput, criticalInvariants: [] }, candidate).status).toBe("pass");
    }
  });

  it("preserves numeric signs and matches invariant phrases on token boundaries", () => {
    expect(normalizeMeaningText("0.5 percent")).not.toBe(
      normalizeMeaningText("−0.5 percent"),
    );
    expect(normalizeMeaningText("$15,000")).not.toBe(
      normalizeMeaningText("-$15,000"),
    );

    const duration = fixtures.find((entry) => entry.id === "tentative-estimate");
    const day = fixtures.find((entry) => entry.id === "corrected-day");
    expect(scoreMeaningCandidate(duration!, "It will probably take 13 hours.").status).toBe("fail");
    expect(scoreMeaningCandidate(day!, "Let's meet Wednesdayish at 3:30.").status).toBe("fail");
  });

  it("equates the percent symbol with the spoken unit without erasing its sign", () => {
    expect(normalizeMeaningText("below 0.5%"))
      .toBe(normalizeMeaningText("below zero point five percent"));
    expect(normalizeMeaningText("below -0.5%"))
      .not.toBe(normalizeMeaningText("below 0.5 percent"));

    const fixture = fixtures.find((entry) => entry.id === "percentage-limit");
    expect(scoreMeaningCandidate(fixture!, "Keep the error rate below 0.5%.").status).toBe("pass");
  });

  it("does not erase meaningful identifier case, flags, or quotation marks", () => {
    const api = fixtures.find((entry) => entry.id === "api-identifier");
    const flag = fixtures.find((entry) => entry.id === "technical-flag");
    const quote = fixtures.find((entry) => entry.id === "quoted-copy");

    expect(
      scoreMeaningCandidate(
        api!,
        "Rename fetchuserid to fetchuserbyid, but keep the users endpoint.",
      ).status,
    ).toBe("fail");
    expect(scoreMeaningCandidate(flag!, "Run cargo test locked, not cargo update.").status).toBe(
      "fail",
    );
    expect(scoreMeaningCandidate(quote!, "The button must say Save a copy, not Save copy.").status)
      .toBe("fail");
    expect(
      scoreMeaningCandidate(
        quote!,
        "The button must say “Save a copy”, not “Save copy.”",
      ).status,
    ).toBe("needs_human_review");
    expect(scoreMeaningCandidate(quote!, 'The button must say "Save a copy," not "Save copy."').status)
      .toBe("pass");
  });

  it("declares vocabulary context needed to infer exact technical identifiers", () => {
    const fixture = fixtures.find((entry) => entry.id === "api-identifier");
    expect(fixture?.dictionary).toEqual([
      { spokenForm: "fetch user I D", replacement: "fetchUserId" },
      { spokenForm: "fetch user by I D", replacement: "fetchUserById" },
    ]);
  });

  it("does not pretend a safe-looking paraphrase is semantically proven", () => {
    const fixture = fixtures.find((entry) => entry.id === "uncertain-launch");
    expect(fixture).toBeTruthy();

    const result = scoreMeaningCandidate(
      fixture!,
      "The launch could happen Friday, though the date remains uncertain.",
    );
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("needs_human_review");
    expect(result.needsHumanReview).toBe(true);
  });

  it("passes an exact acceptable reference without human review", () => {
    const fixture = fixtures.find((entry) => entry.id === "owner-database");
    expect(fixture).toBeTruthy();
    const result = scoreMeaningCandidate(fixture!, fixture!.referenceOutput);
    expect(result.status).toBe("pass");
    expect(result.needsHumanReview).toBe(false);
    expect(result.editDistance).toBe(0);
  });

  it("accepts every fixture's declared reference", () => {
    for (const fixture of fixtures) {
      const result = scoreMeaningCandidate(fixture, fixture.referenceOutput);
      expect(result.status, `${fixture.id}: ${result.violations.join(", ")}`).toBe("pass");
    }
  });

  it.each(openingRegressions)("checks omissions and permitted edits for $id", fixture => {
    expect(scoreMeaningCandidate(fixture, fixture.referenceOutput).status).toBe("pass");
    for (const candidate of fixture.regressionCandidates) {
      const result = scoreMeaningCandidate(fixture, candidate.text);
      expect(result.status, candidate.label).toBe(candidate.expectedStatus);
      if ("expectedViolation" in candidate) {
        expect(result.violations, candidate.label).toContain(candidate.expectedViolation);
      }
    }
  });
});
