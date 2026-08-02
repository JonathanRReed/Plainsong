import { describe, expect, it } from "vitest";
import {
  evaluateReleaseDependencyAudit,
  parseBraceExpansionLockEntries,
} from "../../scripts/verify-release-dependency-audit.mjs";

const knownAudit = {
  "brace-expansion": [
    {
      id: 1124334,
      url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
      severity: "high",
    },
  ],
};

const reviewedLock = `
    "brace-expansion": ["brace-expansion@5.0.8", "", {}],
    "@electron/asar/minimatch/brace-expansion": ["brace-expansion@1.1.17", "", {}],
    "@electron/universal/minimatch/brace-expansion": ["brace-expansion@2.1.3", "", {}],
`;

describe("release dependency audit", () => {
  it("accepts the reviewed build-only advisory when it is absent from the app", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: knownAudit,
      lockEntries: parseBraceExpansionLockEntries(reviewedLock),
      packagedEntries: ["/node_modules/react/index.js"],
    });

    expect(report.pass).toBe(true);
    expect(report.acceptedException).toBe(true);
    expect(report.counts.affectedLockEntries).toBe(2);
  });

  it("rejects any additional advisory", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: {
        ...knownAudit,
        example: [{ id: 7, url: "https://example.invalid", severity: "high" }],
      },
      lockEntries: parseBraceExpansionLockEntries(reviewedLock),
      packagedEntries: [],
    });

    expect(report.pass).toBe(false);
    expect(report.checks.noUnexpectedAdvisories).toBe(false);
  });

  it("rejects an affected copy outside the reviewed build tree", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: knownAudit,
      lockEntries: parseBraceExpansionLockEntries(
        `${reviewedLock}
    "runtime/minimatch/brace-expansion": ["brace-expansion@2.1.3", "", {}],
`,
      ),
      packagedEntries: [],
    });

    expect(report.pass).toBe(false);
    expect(report.checks.affectedCopiesLimitedToReviewedBuildTree).toBe(false);
  });

  it("rejects reviewed build packages when they enter the packaged app", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: knownAudit,
      lockEntries: parseBraceExpansionLockEntries(reviewedLock),
      packagedEntries: ["/node_modules/brace-expansion/index.js"],
    });

    expect(report.pass).toBe(false);
    expect(report.checks.affectedCopiesExcludedFromPackagedApp).toBe(false);
  });

  it("passes without an exception after all affected copies are removed", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: {},
      lockEntries: parseBraceExpansionLockEntries(
        '    "brace-expansion": ["brace-expansion@5.0.8", "", {}],',
      ),
      packagedEntries: [],
    });

    expect(report.pass).toBe(true);
    expect(report.acceptedException).toBe(false);
  });
});
