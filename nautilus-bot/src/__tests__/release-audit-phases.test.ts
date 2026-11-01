import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prePublicationAuditProvesRequirements } from "../../scripts/lib/release-audit-phase.ts";

import { parseScopeDecisions, releaseScopeDecisions } from "../../scripts/lib/release-scope-exceptions.ts";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function audit(phase?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-audit-phase-"));
  temporaryRoots.push(root);
  const candidate = path.join(root, "candidate");
  const qa = path.join(root, "qa");
  fs.mkdirSync(candidate);
  fs.mkdirSync(qa);
  const script = path.resolve(import.meta.dirname, "../../scripts/capture-packaged-macos-release-audit.ts");
  const args = [script, "--candidate", candidate, "--qa-dir", qa];
  if (phase !== undefined) args.push("--phase", phase);
  const result = spawnSync("bun", args, { encoding: "utf8", timeout: 10_000 });
  return { result, qa };
}

describe("release audit phases", () => {
  it("defaults to pre and blocks on missing local evidence without a publication dependency", () => {
    const { result, qa } = audit();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(qa, "release-pre-audit.json"), "utf8"));
    expect(report.phase).toBe("pre");
    expect(report.status).toBe("BLOCKED");
    expect(report.publicationReady).toBe(false);
    expect(report.launchDone).toBe(false);
    expect(report.receiptFinal).toBe(false);
    expect(report.rollout).toBeNull();
    expect(report.rolloutError).toBeNull();
    const ids = report.requirements.map((row: { id: string }) => row.id);
    for (const id of ["release-artifacts", "developer-id-signing", "apple-distribution", "update-metadata",
      "packaged-licenses", "package-size", "signed-updater", "clean-install", "source-gates"]) {
      expect(ids).toContain(id);
    }
    for (const id of ["public-update-feed", "public-downloads", "site-release-metadata"]) expect(ids).not.toContain(id);
    expect(fs.existsSync(path.join(qa, "release-post-audit.json"))).toBe(false);
  });

  it("requires pre acceptance, public feed, downloads and site metadata after publication", () => {
    const { result, qa } = audit("post");
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(qa, "release-post-audit.json"), "utf8"));
    expect(report.phase).toBe("post");
    expect(report.status).toBe("BLOCKED");
    expect(report.launchDone).toBe(false);
    expect(report.publicationReady).toBe(false);
    expect(report.requirements.map((row: { id: string }) => row.id)).toEqual([
      "pre-publication-audit", "public-update-feed", "public-downloads", "site-release-metadata",
    ]);
    expect(report.requirements[0].status).toBe("missing");
    expect(fs.existsSync(path.join(qa, "release-pre-audit.json"))).toBe(false);
  });

  it.each(["unknown", "--candidate"])("rejects invalid phase %s", (phase) => {
    const { result, qa } = audit(phase);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--phase must be pre or post");
    expect(fs.readdirSync(qa)).toEqual([]);
  });
});

describe("prior pre-publication audit acceptance", () => {
  const ids = ["candidate-bytes", "qualification"];
  const passing = { schemaVersion: 2, phase: "pre", pass: true, publicationReady: true,
    requirements: ids.map((id) => ({ id, status: "proved" })) };

  it("accepts a complete pre PASS", () => {
    expect(prePublicationAuditProvesRequirements(passing, ids)).toBe(true);
  });

  it.each([
    null,
    { ...passing, schemaVersion: 1 },
    { ...passing, phase: "post" },
    { ...passing, pass: false },
    { ...passing, publicationReady: false },
    { ...passing, requirements: [] },
    { ...passing, requirements: [passing.requirements[0], passing.requirements[0]] },
    { ...passing, requirements: [{ id: ids[0], status: "proved" }, { id: ids[1], status: "contradicted" }] },
    { ...passing, requirements: [null, null] },
  ])("rejects blocked, malformed, wrong-phase or incomplete pre receipts", (receipt) => {
    expect(prePublicationAuditProvesRequirements(receipt, ids)).toBe(false);
  });
});

describe("beta.7 scope decisions", () => {
  it("accepts only the recorded updater exclusion in a prior pre receipt", () => {
    const decision = releaseScopeDecisions("0.9.0-beta.7").find((row) => row.requirement === "signed-updater");
    const receipt = { schemaVersion: 2, phase: "pre", version: "0.9.0-beta.7", pass: true, publicationReady: true,
      requirements: [{ id: "signed-updater", status: "excluded by decision", scopeDecision: decision }] };
    expect(prePublicationAuditProvesRequirements(receipt, ["signed-updater"])).toBe(true);
    expect(prePublicationAuditProvesRequirements({ ...receipt, version: "0.9.0-beta.8" }, ["signed-updater"])).toBe(false);
    for (const id of ["backup-restore", "memory-footprint", "memory-footprint-16gb", "clean-install", "made-up"]) {
      expect(prePublicationAuditProvesRequirements({ ...receipt,
        requirements: [{ id, status: "excluded by decision", scopeDecision: { ...decision, requirement: id } }],
      }, [id])).toBe(false);
    }
    expect(prePublicationAuditProvesRequirements({ ...receipt, requirements: [
      { id: "signed-updater", status: "excluded by decision", scopeDecision: { ...decision, reason: "waived" } },
    ] }, ["signed-updater"])).toBe(false);
  });

  it("rejects unknown, duplicate and unattributed exceptions", () => {
    const decisions = releaseScopeDecisions("0.9.0-beta.7");
    const file = { schemaVersion: 1, version: "0.9.0-beta.7", decisions };
    expect(decisions.map((row) => row.requirement)).toEqual(["signed-updater", "audible-benchmark", "memory-footprint", "host-matrix", "clean-install"]);
    expect(releaseScopeDecisions("0.9.0-beta.8")).toEqual([]);
    for (const invalid of [
      [...decisions, { ...decisions[0], requirement: "memory-footprint" }],
      [...decisions, decisions[0]], [{ ...decisions[0], decidedBy: "agent" }],
      [{ ...decisions[0], date: "" }], [{ ...decisions[0], reason: "" }],
    ]) expect(() => parseScopeDecisions({ ...file, decisions: invalid }, file.version)).toThrow();
  });
});


describe("partial scope decision acceptance", () => {
  const partials = releaseScopeDecisions("0.9.0-beta.7").filter((decision) => decision.scope);

  it.each(partials)("accepts only the exact scoped status for $requirement", (decision) => {
    const row = { id: decision.requirement, status: "proved with scoped exclusion", scopeDecision: decision };
    const receipt = { schemaVersion: 2, phase: "pre", version: "0.9.0-beta.7", pass: true,
      publicationReady: true, requirements: [row] };
    expect(prePublicationAuditProvesRequirements(receipt, [row.id])).toBe(true);
    for (const changed of [
      { ...receipt, version: "0.9.0-beta.8" },
      { ...receipt, requirements: [{ ...row, status: "excluded by decision" }] },
      { ...receipt, requirements: [{ ...row, status: "contradicted" }] },
      { ...receipt, requirements: [{ ...row, scopeDecision: { ...decision, scope: undefined } }] },
      { ...receipt, requirements: [{ ...row, scopeDecision: { ...decision, scope: { ...decision.scope, extra: true } } }] },
      { ...receipt, requirements: [{ ...row, scopeDecision: { ...decision, reason: "waived" } }] },
    ]) expect(prePublicationAuditProvesRequirements(changed, [row.id])).toBe(false);
  });

  it.each(partials)("rejects missing, widened, unknown or extra scope fields for $requirement", (decision) => {
    const file = { schemaVersion: 1, version: "0.9.0-beta.7", decisions: [decision] };
    expect(parseScopeDecisions(file, file.version)).toEqual([decision]);
    const { scope: _scope, ...withoutScope } = decision;
    for (const changed of [
      withoutScope, { ...decision, scope: {} }, { ...decision, scope: null },
      { ...decision, scope: { ...decision.scope, extra: "all" } },
      { ...decision, scope: { tier: "16gb", state: "post-call" } },
      { ...decision, scope: { target: "Slack" } },
      { ...decision, scope: { journey: "all" } },
      { ...decision, extra: true }, { ...decision, decision: "all waived" },
    ]) expect(() => parseScopeDecisions({ ...file, decisions: [changed] }, file.version)).toThrow();
  });

  it("rejects a partial status or a scope on a whole-requirement decision", () => {
    const decision = releaseScopeDecisions("0.9.0-beta.7")[0];
    expect(prePublicationAuditProvesRequirements({ schemaVersion: 2, phase: "pre", version: "0.9.0-beta.7",
      pass: true, publicationReady: true, requirements: [{ id: decision.requirement,
        status: "proved with scoped exclusion", scopeDecision: decision }] }, [decision.requirement])).toBe(false);
    expect(() => parseScopeDecisions({ schemaVersion: 1, version: "0.9.0-beta.7",
      decisions: [{ ...decision, scope: {} }] }, "0.9.0-beta.7")).toThrow();
  });
});
