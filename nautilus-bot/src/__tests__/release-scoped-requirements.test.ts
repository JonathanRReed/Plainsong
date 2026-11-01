import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectReleaseCandidateIdentity } from "../../scripts/lib/release-candidate-identity.ts";
import { describe, expect, it } from "vitest";
import { footprintReceiptQualifies } from "../../scripts/lib/footprint-gate.ts";
import { partialScopeReceiptQualifies } from "../../scripts/lib/release-scoped-requirements.ts";
import { releaseScopeDecisions, type PartialScopeDecision } from "../../scripts/lib/release-scope-exceptions.ts";

function decisionFor(requirement: PartialScopeDecision["requirement"]): PartialScopeDecision {
  const decision = releaseScopeDecisions("0.9.0-beta.7").find((row) => row.requirement === requirement);
  if (!decision?.scope) throw new Error(`Missing partial decision: ${requirement}`);
  return decision;
}

function footprintReceipt() {
  return { pass: false, error: null, simulateGb: 8, tier: "light", simulationReachedSidecar: true,
    standardWorkload: true, measurementErrors: [], extraSettings: [], extraAppArgs: [],
    states: ["idle", "idle-hidden", "dictation", "idle-after-dictation", "meeting", "post-call"].map((state) => ({
      state, pass: state !== "idle-after-dictation", samples: 3, exercised: true, skipped: null,
    })), systemMemory: { effective: [{ state: "idle-after-dictation", verdict: "fail" }] } };
}

function hostReceipt() {
  return { pass: false, summary: { required: 4, requiredLaunchReady: 3 },
    rows: ["Apple Notes", "Google Docs (Chrome)", "Slack", "Messages"].map((app) => ({
      platform: "macOS", app, requiredForLaunch: true, launchReady: app !== "Google Docs (Chrome)",
      launchGateSatisfied: app !== "Google Docs (Chrome)", insertionEvidence: { valid: app !== "Google Docs (Chrome)" },
      openBlockedEntries: [],
    })) };
}

function installReceipt() {
  return { pass: false, kind: "clean-install", reviewMethod: "recorded-walkthrough", remainingLaunchFindings: [
    "A clean-account installation and first-run permission journey, including dictation and insertion, remains unqualified. Existing account grants were preserved.",
  ], observations: ["quarantined-dmg-gatekeeper", "drag-install-disposable-location", "first-run-permission-flow", "local-dictation-and-meeting"]
    .map((id, index) => ({ id, status: index < 2 ? "pass" : "fail" })) };
}

describe("8 GB idle-after-dictation exclusion", () => {
  const decision = decisionFor("memory-footprint");

  it("accepts only the named app and effective memory state without changing the receipt", () => {
    const receipt = footprintReceipt();
    const original = structuredClone(receipt);
    expect(footprintReceiptQualifies(receipt, 8, "light")).toBe(false);
    expect(partialScopeReceiptQualifies(receipt, decision)).toBe(true);
    expect(receipt).toEqual(original);
    expect(footprintReceiptQualifies(receipt, 16, "balanced", "idle-after-dictation")).toBe(false);
  });

  it.each(["idle", "idle-hidden", "dictation", "meeting", "post-call", "another-state"])("still blocks %s app or effective failures", (state) => {
    const receipt = footprintReceipt();
    expect(partialScopeReceiptQualifies({ ...receipt, states: [...receipt.states,
      { state, pass: false, samples: 1, exercised: true, skipped: null }] }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, systemMemory: { effective: [{ state, verdict: "fail" }] } }, decision)).toBe(false);
  });

  it("keeps workload, measurement and simulation validity checks", () => {
    const receipt = footprintReceipt();
    for (const changed of [
      { ...receipt, simulationReachedSidecar: false }, { ...receipt, standardWorkload: false },
      { ...receipt, measurementErrors: ["Search helper job did not complete"] },
      { ...receipt, error: "capture failed" }, { ...receipt, experimental: true },
      { ...receipt, simulateGb: 16, tier: "balanced" }, { ...receipt, simulateAvailableGb: 2 },
      { ...receipt, extraSettings: ["experimental"] }, { ...receipt, extraAppArgs: ["--experimental"] },
      { ...receipt, states: receipt.states.slice(1) },
      { ...receipt, states: receipt.states.map((row) => ({ ...row, samples: 0 })) },
      { ...receipt, states: receipt.states.map((row) => ({ ...row, exercised: false })) },
    ]) expect(partialScopeReceiptQualifies(changed, decision)).toBe(false);
  });
});

describe("Google Docs in Chrome exclusion", () => {
  const decision = decisionFor("host-matrix");
  it("accepts the remaining required hosts", () => {
    expect(partialScopeReceiptQualifies(hostReceipt(), decision)).toBe(true);
  });
  it.each(["Apple Notes", "Slack", "Messages"])("still requires %s", (app) => {
    const receipt = hostReceipt();
    const rows = receipt.rows.map((row) => row.app === app ? { ...row, launchReady: false } : row);
    expect(partialScopeReceiptQualifies({ ...receipt, rows, summary: { required: 4, requiredLaunchReady: 2 } }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, rows: receipt.rows.filter((row) => row.app !== app),
      summary: { required: 3, requiredLaunchReady: 2 } }, decision)).toBe(false);
  });
  it("does not waive other Chrome targets or verifier failures", () => {
    const receipt = hostReceipt();
    const extra = { ...receipt.rows[0], app: "HubSpot (Chrome)", launchReady: false };
    expect(partialScopeReceiptQualifies({ ...receipt, rows: [...receipt.rows, extra],
      summary: { required: 5, requiredLaunchReady: 3 } }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, rows: receipt.rows.map((row) => row.app === "Slack"
      ? { ...row, insertionEvidence: { valid: false } } : row) }, decision)).toBe(false);
  });
});

describe("clean-account first-run exclusion", () => {
  const decision = decisionFor("clean-install");
  it("accepts the remaining quarantined install checks", () => {
    expect(partialScopeReceiptQualifies(installReceipt(), decision)).toBe(true);
  });
  it.each(["quarantined-dmg-gatekeeper", "drag-install-disposable-location"])("still requires %s", (id) => {
    const receipt = installReceipt();
    expect(partialScopeReceiptQualifies({ ...receipt, observations: receipt.observations.map((row) =>
      row.id === id ? { ...row, status: "fail" } : row) }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, observations: receipt.observations.filter((row) => row.id !== id) }, decision)).toBe(false);
  });
  it("blocks unrelated findings, capture errors and unknown install parts", () => {
    const receipt = installReceipt();
    expect(partialScopeReceiptQualifies({ ...receipt, remainingLaunchFindings: ["Signature failed"] }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, error: "verification failed" }, decision)).toBe(false);
    expect(partialScopeReceiptQualifies({ ...receipt, observations: [...receipt.observations,
      { id: "bundle-signature", status: "fail" }] }, decision)).toBe(false);
  });
});


describe("scoped exclusions in the pre-audit CLI", () => {
  it("reports scoped proofs separately and keeps candidate binding and other parts mandatory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-scoped-audit-"));
    try {
      const candidatePath = path.join(root, "candidate");
      const qa = path.join(root, "qa");
      const appPath = path.join(candidatePath, "mac-arm64/Plainsong.app");
      const files = ["Contents/Resources/app.asar", "Contents/Resources/sidecar/plainsong-sidecar",
        "Contents/MacOS/Plainsong", "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper",
        "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin", "Contents/Resources/app-update.yml"];
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(appPath, file)), { recursive: true });
        fs.writeFileSync(path.join(appPath, file), "synthetic fixture");
      }
      fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.9.0-beta.7</string></dict></plist>`);
      for (const name of ["Plainsong-0.9.0-beta.7-arm64.dmg", "Plainsong-0.9.0-beta.7-arm64-mac.zip",
        "Plainsong-0.9.0-beta.7-arm64-mac.zip.blockmap", "beta-mac.yml"]) fs.writeFileSync(path.join(candidatePath, name), "fixture");
      fs.mkdirSync(qa);
      const candidateIdentity = collectReleaseCandidateIdentity({ candidatePath, appPath });
      expect(candidateIdentity.complete).toBe(true);
      const fixtures = {
        "footprint-8gb.json": footprintReceipt(),
        "app-matrix-preflight.json": hostReceipt(),
        "clean-install.json": installReceipt(),
      };
      function writeReceipt(name: string, receipt: object) {
        fs.writeFileSync(path.join(qa, name), JSON.stringify({ candidateIdentity, candidateAppUnchanged: true, ...receipt }));
      }
      for (const [name, receipt] of Object.entries(fixtures)) writeReceipt(name, receipt);
      function runAudit() {
        const result = spawnSync("bun", [path.resolve(import.meta.dirname, "../../scripts/capture-packaged-macos-release-audit.ts"),
          "--phase", "pre", "--candidate", candidatePath, "--qa-dir", qa], { encoding: "utf8", timeout: 10_000 });
        expect(result.status, result.stderr).toBe(1);
        return JSON.parse(fs.readFileSync(path.join(qa, "release-pre-audit.json"), "utf8"));
      }
      const report = runAudit();
      expect(report.summary["proved with scoped exclusion"]).toBe(3);
      expect(report.summary["excluded by decision"]).toBe(1);
      expect(report.summary.proved).toBe(3);
      const markdown = fs.readFileSync(path.join(qa, "release-pre-audit.md"), "utf8");
      for (const decision of releaseScopeDecisions("0.9.0-beta.7").filter((row) => row.scope)) {
        expect(report.requirements.find((row: { id: string }) => row.id === decision.requirement))
          .toMatchObject({ status: "proved with scoped exclusion", scopeDecision: decision });
        expect(markdown).toContain(JSON.stringify(decision.scope));
        expect(markdown).toContain(decision.decision);
      }
      const cases = [
        { id: "memory-footprint", name: "footprint-8gb.json", receipt: fixtures["footprint-8gb.json"],
          failed: { ...footprintReceipt(), measurementErrors: ["Search helper job did not complete"] } },
        { id: "host-matrix", name: "app-matrix-preflight.json", receipt: fixtures["app-matrix-preflight.json"],
          failed: { ...hostReceipt(), rows: hostReceipt().rows.map((row) => row.app === "Slack" ? { ...row, launchReady: false } : row) } },
        { id: "clean-install", name: "clean-install.json", receipt: fixtures["clean-install.json"],
          failed: { ...installReceipt(), observations: installReceipt().observations.map((row) =>
            row.id === "quarantined-dmg-gatekeeper" ? { ...row, status: "fail" } : row) } },
      ];
      for (const testCase of cases) {
        for (const receipt of [testCase.failed, { ...testCase.receipt, candidateAppUnchanged: false },
          { ...testCase.receipt, candidateIdentity: { appBundle: { sha256: "stale" }, releaseSha256: "stale" } }]) {
          writeReceipt(testCase.name, receipt);
          const failed = runAudit();
          expect(failed.requirements.find((row: { id: string }) => row.id === testCase.id))
            .toMatchObject({ status: "contradicted", scopeDecision: { requirement: testCase.id } });
          expect(failed.summary["proved with scoped exclusion"]).toBe(2);
        }
        writeReceipt(testCase.name, testCase.receipt);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
