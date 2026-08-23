import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluateAppMatrixTerminalStatus } from "../../scripts/lib/app-matrix-terminal-status.mjs";

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

  it("executes the verifier against a complete PASS fixture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-app-matrix-verifier-"));
    const artifactPath = path.join(tempDir, "app-matrix-insertion-apple-notes.json");
    const markdownPath = path.join(tempDir, "app-matrix-insertion-apple-notes.md");
    const sampleText = "Plainsong verifier fixture";
    const artifact = {
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
        readBackMatchedSample: true,
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
        observedValue: sampleText,
        prepareEvidence: {},
        readBackEvidence: {},
        cleanupEvidence: { targetSurfaceRestored: true },
      },
      selfReported: {
        sidecarCommandCompleted: true,
        frontmostMatchedTarget: true,
        pasteReported: true,
        note: "Corroboration only.",
      },
      rowClosure: { closesMatrixRow: true, reason: "Read back inside Apple Notes." },
      sidecarExit: { code: 0 },
      sidecarResult: {},
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
      "node",
      [
        path.join(repoRoot, "scripts", "verify-packaged-macos-app-matrix-insertion.mjs"),
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

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("validation passed: Apple Notes");
  });
});
