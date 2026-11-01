import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluateAppMatrixTerminalStatus } from "../../scripts/lib/app-matrix-terminal-status.ts";

import { captureAppReceiptBinding } from "../../scripts/lib/app-receipt-binding.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("app matrix terminal status", () => {
  it("accepts PASS only when it closes the named matrix row", () => {
    expect(
      evaluateAppMatrixTerminalStatus({
        status: "PASS",
        pass: true,
        verifyMode: "native-accessibility",
        checksAllPassed: true,
        rowClosure: { closesMatrixRow: true },
      }),
    ).toEqual([]);
  });

  it("rejects PASS without row closure", () => {
    expect(
      evaluateAppMatrixTerminalStatus({
        status: "PASS",
        pass: true,
        verifyMode: "clipboard-sentinel",
        checksAllPassed: true,
        rowClosure: { closesMatrixRow: false },
      }).join(" "),
    ).toContain("must close the matrix row");
  });

  it("accepts honest PASS_OUT_OF_SCOPE evidence", () => {
    expect(
      evaluateAppMatrixTerminalStatus({
        status: "PASS_OUT_OF_SCOPE",
        pass: false,
        verifyMode: "local-http-probe",
        checksAllPassed: true,
        rowClosure: { closesMatrixRow: false },
      }),
    ).toEqual([]);
  });

  it("rejects a local HTTP probe labeled PASS", () => {
    expect(
      evaluateAppMatrixTerminalStatus({
        status: "PASS",
        pass: true,
        verifyMode: "local-http-probe",
        checksAllPassed: true,
        rowClosure: { closesMatrixRow: true },
      }).join(" "),
    ).toContain("can never terminate as PASS");
  });

  it.each([
    { label: "confirmed insertion with external readback", pasted: true, copied: false, confirmed: true, observed: true },
    { label: "unconfirmed insertion with external readback", pasted: true, copied: false, confirmed: false, observed: true },
    { label: "legacy insertion with external readback", pasted: true, copied: false, confirmed: undefined, observed: true },
    { label: "dispatched paste without external readback", pasted: true, copied: false, confirmed: false, observed: false },
    { label: "confirmed self-report without external readback", pasted: true, copied: false, confirmed: true, observed: false },
    { label: "copied result without external readback", pasted: false, copied: true, confirmed: false, observed: false },
  ])("executes the verifier against $label", ({ pasted, copied, confirmed, observed }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-app-matrix-verifier-"));
    const artifactPath = path.join(tempDir, "app-matrix-insertion-apple-notes.json");
    const markdownPath = path.join(tempDir, "app-matrix-insertion-apple-notes.md");
    const sampleText = "Plainsong verifier fixture";
    const appPath = path.join(tempDir, "Plainsong.app");
    fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture");
    const binding = captureAppReceiptBinding(appPath);
    const artifact = {
      appPath,
      candidateIdentity: { appBundle: { sha256: binding.appBundleSha256 } },
      candidateAppUnchanged: true,
      targetApp: "Apple Notes",
      status: "PASS",
      pass: true,
      checksAllPassed: true,
      verifyMode: "native-accessibility",
      scratchTarget: "Disposable unit-test note",
      sampleText,
      checks: {
        readBackModeRecognized: true,
        readBackPreInsertEmpty: true,
        readBackMatchedSample: observed,
        externalFrontmostMatchedTarget: true,
        sidecarExitedCleanly: true,
        targetSurfaceRestored: true,
        dbRestored: true,
        settingsRestored: true,
      },
      externalFrontmostMatchedTarget: true,
      externalFrontmost: { ok: true, name: "Notes", bundleId: "com.apple.Notes" },
      dbRestored: true,
      settingsRestored: true,
      userStateSnapshotTaken: true,
      originalDbHashes: {},
      restoredDbHashes: {},
      readBack: {
        mode: "native-accessibility",
        preInsertValue: "",
        observedValue: observed ? sampleText : "",
        prepareEvidence: {},
        readBackEvidence: {},
        cleanupEvidence: { targetSurfaceRestored: true },
      },
      selfReported: {
        sidecarCommandCompleted: true,
        frontmostMatchedTarget: true,
        pasteReported: pasted,
        note: "Corroboration only.",
      },
      rowClosure: { closesMatrixRow: true, reason: "Read back inside Apple Notes." },
      sidecarExit: { code: 0 },
      sidecarResult: { pasted, copied, confirmed },
    };
    const markdown = [
      "Status: PASS",
      "- App: `Apple Notes`",
      "- Scratch target: `Disposable unit-test note`",
      "- Read-back mode: `native-accessibility`",
      "- Read-back mode recognized: yes",
      "- Pre-insert field empty: yes",
      "- Read-back matched sample: yes",
      "- External frontmost matched target: yes",
      "- Sidecar exited cleanly: yes",
      "- User database restored: yes",
      "- User settings restored: yes",
      "- Closes the matrix row for Apple Notes: yes",
      "## Self-Reported by the App Under Test (NOT verification)",
    ].join("\n");

    fs.writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");
    fs.writeFileSync(markdownPath, markdown, "utf8");
    const result = spawnSync(
      "bun",
      [
        path.join(repoRoot, "scripts", "verify-packaged-macos-app-matrix-insertion.ts"),
        "--file",
        artifactPath,
        "--markdown",
        markdownPath,
        "--target-app",
        "Apple Notes",
        "--verify-mode",
        "native-accessibility",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (observed) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("validation passed: Apple Notes");
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checks.readBackMatchedSample must be true");
      expect(result.stdout).not.toContain("validation passed");
    }
  });
});
