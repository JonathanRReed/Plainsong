import { describe, expect, it } from "vitest";
import { evaluateRustReleaseAudit } from "../../scripts/verify-rust-release-audit.ts";

const now = Date.parse("2026-10-13T12:00:00Z");
const database = {
  revision: "a".repeat(40),
  commitTimestamp: "2026-10-12T12:00:00Z",
  origin: "https://github.com/RustSec/advisory-db.git",
  trackedClean: true,
};
const cleanReport = { vulnerabilities: { count: 0, found: false, list: [] }, warnings: {} };
const result = { status: 0, stdout: JSON.stringify(cleanReport) };
const finding = { advisory: { id: "RUSTSEC-2026-0001" }, package: { name: "example", version: "1.0.0" } };

describe("Rust release audit", () => {
  it("accepts a clean audit against fresh official database evidence", () => {
    const receipt = evaluateRustReleaseAudit({ database, result, now });
    expect(receipt.pass).toBe(true);
    expect(receipt.database.ageDays).toBe(1);
    expect(receipt.database.revision).toBe(database.revision);
    expect(evaluateRustReleaseAudit({ database: { ...database, origin: "https://github.com/RustSec/advisory-db" }, result, now }).pass).toBe(true);
  });

  it("rejects missing, stale, future, dirty, or untrusted database evidence", () => {
    for (const candidate of [
      null,
      { ...database, revision: null },
      { ...database, commitTimestamp: null },
      { ...database, commitTimestamp: "invalid" },
      { ...database, commitTimestamp: "2026-10-06T11:59:59Z" },
      { ...database, commitTimestamp: "2026-10-13T12:05:01Z" },
      { ...database, trackedClean: false },
      { ...database, origin: "https://secret@example.com/advisory-db" },
    ]) {
      const receipt = evaluateRustReleaseAudit({ database: candidate, result, now });
      expect(receipt.pass).toBe(false);
      expect(JSON.stringify(receipt)).not.toContain("secret");
    }
  });

  it("accepts the freshness boundary and modest clock skew", () => {
    for (const commitTimestamp of ["2026-10-06T12:00:00Z", "2026-10-13T12:05:00Z"]) {
      expect(evaluateRustReleaseAudit({ database: { ...database, commitTimestamp }, result, now }).pass).toBe(true);
    }
  });

  it("rejects malformed reports, failed empty reports, and process errors", () => {
    for (const failed of [
      { status: 0, stdout: "not JSON" },
      { status: 0, stdout: "{}" },
      { status: 1, stdout: result.stdout },
      { status: 2, stdout: result.stdout },
      { status: null, signal: "SIGTERM", stdout: result.stdout },
      { status: 0, error: new Error("spawn failed"), stdout: result.stdout },
      { status: 0, stdout: JSON.stringify({ ...cleanReport, vulnerabilities: { count: 1, found: true, list: [] } }) },
      { status: 0, stdout: JSON.stringify({ ...cleanReport, warnings: { unmaintained: [null] } }) },
    ]) expect(evaluateRustReleaseAudit({ database, result: failed, now }).pass).toBe(false);
  });

  it("preserves vulnerability findings and fails even if Cargo exits zero", () => {
    for (const status of [0, 1]) {
      const receipt = evaluateRustReleaseAudit({ database, now, result: { status, stdout: JSON.stringify({ ...cleanReport, vulnerabilities: { count: 1, found: true, list: [finding] } }) } });
      expect(receipt.pass).toBe(false);
      expect(receipt.audit.vulnerabilities).toEqual([finding]);
      expect(receipt.audit.vulnerabilityCount).toBe(1);
    }
  });

  it("reports informational warnings separately without calling them vulnerabilities", () => {
    const warnings = { unmaintained: [finding] };
    const receipt = evaluateRustReleaseAudit({ database, now, result: { status: 0, stdout: JSON.stringify({ ...cleanReport, warnings }) } });
    expect(receipt.pass).toBe(true);
    expect(receipt.audit.vulnerabilityCount).toBe(0);
    expect(receipt.audit.informationalWarningCount).toBe(1);
    expect(receipt.audit.informationalWarnings).toEqual(warnings);
  });
});
