import { describe, expect, it } from "vitest";
import {
  evaluateReleaseDependencyAudit,
  parseBraceExpansionLockEntries,
  parseReleaseDependencyAuditResult,
  comparePackagedDependencyVersions,
} from "../../scripts/verify-release-dependency-audit.ts";

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
  it("finds affected lock entries regardless of indentation", () => {
    const entries = parseBraceExpansionLockEntries('        "brace-expansion": ["brace-expansion@5.0.11", "", {}],');
    expect(entries).toEqual([{ key: "brace-expansion", version: "5.0.11" }]);
  });
  it("rejects stale or missing packaged dependency versions despite a clean source audit", () => {
    const stale = { path: "node_modules/js-yaml/package.json", packaged: { name: "js-yaml", version: "4.3.1" }, installed: { name: "js-yaml", version: "4.3.2" } };
    const missing = { ...stale, path: "node_modules/removed/package.json", installed: null };
    expect(comparePackagedDependencyVersions([stale, missing])).toEqual({ checked: 2, mismatches: [stale, missing] });
    expect(comparePackagedDependencyVersions([{ ...stale, packaged: stale.installed }])).toEqual({ checked: 1, mismatches: [] });
  });

  it("accepts a flattened dependency only when its version belongs to the audited installed graph", () => {
    const packaged = { name: "semver", version: "7.7.4" };
    const entry = { path: "node_modules/semver/package.json", packaged,
      installed: [{ name: "semver", version: "7.8.5" }, packaged] };
    expect(comparePackagedDependencyVersions([entry]).mismatches).toEqual([]);
    expect(comparePackagedDependencyVersions([{ ...entry, packaged: { ...packaged, version: "7.0.0" } }]).mismatches).toHaveLength(1);
  });
  it("rejects failed empty audits and interrupted or abnormal exits", () => {
    for (const result of [
      { status: 1, stdout: "{}" },
      { status: 2, stdout: "{}" },
      { status: null, signal: "SIGTERM", stdout: "{}" },
      { status: 0, error: new Error("spawn failed"), stdout: "{}" },
    ]) expect(() => parseReleaseDependencyAuditResult(result)).toThrow();
    expect(parseReleaseDependencyAuditResult({ status: 0, stdout: "{}" })).toEqual({});
    expect(parseReleaseDependencyAuditResult({ status: 1, stdout: JSON.stringify(knownAudit) })).toEqual(knownAudit);
  });

  it("rejects malformed audit containers and advisory entries", () => {
    for (const audit of [null, [], { example: {} }, { example: [null] }]) {
      expect(() => evaluateReleaseDependencyAudit({
        audit: audit as unknown as typeof knownAudit,
        lockEntries: [], packagedEntries: [],
      })).toThrow();
    }
  });
  it("rejects the previously reviewed build-only advisory after patched releases exist", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: knownAudit,
      lockEntries: parseBraceExpansionLockEntries(reviewedLock),
      packagedEntries: ["/node_modules/react/index.js"],
    });

    expect(report.pass).toBe(false);
    expect(report.acceptedException).toBe(false);
    expect(report.counts.affectedLockEntries).toBe(3);
    expect(report.checks.noUnexpectedAdvisories).toBe(false);
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
        `    "brace-expansion": ["brace-expansion@5.0.12", "", {}],
    "@electron/asar/minimatch/brace-expansion": ["brace-expansion@1.1.21", "", {}],
    "@electron/universal/minimatch/brace-expansion": ["brace-expansion@2.1.7", "", {}],`,
      ),
      packagedEntries: [],
    });

    expect(report.pass).toBe(true);
    expect(report.acceptedException).toBe(false);
    expect(report.counts.affectedLockEntries).toBe(0);
  });

  it("rejects each version family below the current patched floor", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: {},
      lockEntries: parseBraceExpansionLockEntries(reviewedLock),
      packagedEntries: [],
    });

    expect(report.pass).toBe(false);
    expect(report.counts.affectedLockEntries).toBe(3);
    expect(report.checks.auditMatchesInstalledState).toBe(false);
  });

  it("rejects formerly patched releases that have newer advisories", () => {
    const report = evaluateReleaseDependencyAudit({
      audit: {},
      lockEntries: parseBraceExpansionLockEntries(`
    "brace-expansion": ["brace-expansion@5.0.11", "", {}],
    "old/brace-expansion": ["brace-expansion@1.1.20", "", {}],
    "other/brace-expansion": ["brace-expansion@2.1.6", "", {}],
    "third/brace-expansion": ["brace-expansion@3.0.7", "", {}],
      `),
      packagedEntries: [],
    });
    expect(report.pass).toBe(false);
    expect(report.counts.affectedLockEntries).toBe(4);
  });
});
