import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateCandidateEvidenceProvenance,
  evaluateComponentEquivalence,
} from "../../scripts/lib/macos-component-equivalence.mjs";
import { VERIFY_MODES } from "../../scripts/lib/app-matrix-readback.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const captureScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "capture-packaged-macos-app-matrix-insertion.mjs"),
  "utf8",
);
const verifierScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-packaged-macos-app-matrix-insertion.mjs"),
  "utf8",
);
const readBackScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "lib", "app-matrix-readback.mjs"),
  "utf8",
);
const preflightScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "capture-packaged-macos-app-matrix-preflight.mjs"),
  "utf8",
);
const releaseAuditScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
  "utf8",
);
const compatibilityMatrix = fs.readFileSync(
  path.join(repoRoot, "docs", "dictation-app-compatibility-matrix.md"),
  "utf8",
);

describe("macOS app matrix insertion scripts", () => {
  it("loads the machine read-back implementation as valid JavaScript", () => {
    expect(VERIFY_MODES).toContain("native-accessibility");
  });

  it("matches a target by bundle identifier, case-insensitively", () => {
    // macOS can report a frontmost app without a name, so the bundle id has to
    // be a first-class way to identify the target rather than a fallback.
    expect(captureScript).toContain('"Apple Notes": ["com.apple.Notes"]');
    expect(captureScript).toContain("expected.toLowerCase() === bundleId.toLowerCase()");
    expect(captureScript).toContain("artifact.sidecarResult?.targetBundleId");
  });

  it("keeps the pass carried by an external read-back, never by a self-report", () => {
    // The harness used to pass on three values the app reported about itself
    // ANDed with a typed human answer, and only the human answer spoke to
    // whether text landed anywhere. `pasted: true` in particular is not a
    // confirmation: paste_text_systemwide returns it as soon as CGEvent::post
    // returns, and CGEvent::post returns nothing. These assertions exist so
    // that arrangement cannot come back quietly.
    expect(verifierScript).toContain("forbiddenGatingChecks");
    for (const forbidden of [
      "manualObservationAccepted",
      "sidecarCommandCompleted",
      "frontmostMatchedTarget",
      "pasteReported",
    ]) {
      expect(verifierScript).toContain(forbidden);
    }

    // What must carry it instead: the sample read back out of the target
    // surface, the surface proven empty first, and the row's own application
    // confirmed frontmost by System Events.
    expect(verifierScript).toContain("readBackMatchedSample");
    expect(verifierScript).toContain("preInsertValue");
    expect(verifierScript).toContain("externalFrontmostMatchedTarget");
  });

  it("warms the sidecar before asking the operator to hold target focus", () => {
    const snapshotIndex = captureScript.indexOf("const snapshot = snapshotUserState()");
    const launchIndex = captureScript.indexOf("sidecar = launchSidecar()");
    const warmupIndex = captureScript.indexOf(
      'await sidecar.sendCommand("get_settings", {})',
    );
    const activationIndex = captureScript.indexOf(
      "artifact.activationResult = activateTargetApp(targetApp)",
    );
    const prepareIndex = captureScript.indexOf("const prepared = await session.prepare()");

    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(launchIndex).toBeGreaterThan(snapshotIndex);
    expect(warmupIndex).toBeGreaterThan(launchIndex);
    expect(activationIndex).toBeGreaterThan(warmupIndex);
    expect(prepareIndex).toBeGreaterThan(activationIndex);
  });

  it("lets asynchronous target apps consume the staged clipboard before read-back replaces it", () => {
    const insertIndex = captureScript.indexOf(
      'artifact.sidecarResult = await sidecar.sendCommand("smoke_test_cursor_insert"',
    );
    const settleIndex = captureScript.indexOf(
      "await sleep(Math.max(0, postInsertSettleMs))",
    );
    const readBackIndex = captureScript.indexOf("const observed = await session.readBack()");

    expect(captureScript).toContain(
      'const postInsertSettleMs = Number(valueFor("--post-insert-settle-ms", "1000"))',
    );
    expect(insertIndex).toBeGreaterThan(-1);
    expect(settleIndex).toBeGreaterThan(insertIndex);
    expect(readBackIndex).toBeGreaterThan(settleIndex);
  });

  it("requires disposable target text to be removed after machine read-back", () => {
    expect(captureScript).toContain("targetSurfaceRestored");
    expect(verifierScript).toContain("checks.targetSurfaceRestored must be true");
    expect(readBackScript).toContain("cleanupProbeToken");
    expect(readBackScript).toContain(
      'setFocusedAccessibilityValue(accessibilityApp, "")',
    );
    expect(readBackScript).toContain("directAccessibilityFallback");
    expect(readBackScript).toContain("targetSurfaceRestored: restored");
    expect(readBackScript).toContain(
      "targetSurfaceRestored: cleanupProbeMatched && !clearProbeBlocked",
    );
  });

  it("refuses to call a run PASS when it closes no matrix row", () => {
    // A read-back on a surface the harness itself owns proves insertion works
    // in that surface's host application; it does not close the row naming a
    // product the harness never opened.
    expect(verifierScript).toContain("PASS_OUT_OF_SCOPE");
    expect(captureScript).toContain("closesMatrixRow");
  });

  it("gates launch on required rows while retaining optional hosts as deferred backlog", () => {
    expect(preflightScript).toContain('row.launchGate === "REQUIRED"');
    expect(preflightScript).toContain(
      "summary.requiredLaunchReady === summary.required",
    );
    expect(releaseAuditScript).toContain("artifact?.pass === true");
    expect(releaseAuditScript).toContain(
      "artifact?.summary?.requiredLaunchReady === artifact?.summary?.required",
    );
    expect(compatibilityMatrix).toMatch(
      /\| Cursor \| DEFERRED \| clipboard_only \| DEFERRED \|/,
    );
    expect(compatibilityMatrix).not.toMatch(
      /\| Cursor \| [^|\n]+ \| [^|\n]+ \| REQUIRED \|/,
    );
  });

  it("rejects packaged receipts that predate the current app archive", () => {
    expect(releaseAuditScript).toContain("candidateBuiltAtMs");
    expect(releaseAuditScript).toContain("candidateBound");
    expect(releaseAuditScript).toContain("predates the current candidate app archive");
  });

  it("binds ordinary release review signoff to the source snapshot that passed the source gates", () => {
    expect(releaseAuditScript).toContain("reviewSourceMatchesGates");
    expect(releaseAuditScript).toContain("sourceSnapshotSha256");
    expect(releaseAuditScript).toContain("trackedDiffSha256");
  });

  it("accepts historical direct-sidecar evidence only through exact unsigned component equivalence", () => {
    const components = Object.fromEntries(
      ["sidecar", "shortcutHelper", "speechHelper"].map((name) => [
        name,
        {
          referenceUnsignedSha256: `${name}-hash`,
          candidateUnsignedSha256: `${name}-hash`,
          unsignedCodeIdentical: true,
        },
      ]),
    );
    const evaluation = evaluateComponentEquivalence({
      referenceApp: "/reference/Plainsong.app",
      candidateApp: "/candidate/Plainsong.app",
      referenceTrustPass: true,
      candidateTrustPass: true,
      sameSigningTeam: true,
      sameBundleIdentifier: true,
      components,
    });
    expect(evaluation.pass).toBe(true);

    const provenance = evaluateCandidateEvidenceProvenance({
      artifactAppPath: "/reference/Plainsong.app",
      artifactSidecarPath:
        "/reference/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      candidateAppPath: "/candidate/Plainsong.app",
      equivalence: {
        pass: evaluation.pass,
        identity: {
          referenceApp: "/reference/Plainsong.app",
          candidateApp: "/candidate/Plainsong.app",
        },
        checks: evaluation.checks,
        components,
      },
    });

    expect(provenance).toMatchObject({
      valid: true,
      mode: "verified-unsigned-component-equivalence",
    });
  });

  it("binds same-path evidence to the exact packaged component bytes", () => {
    const componentDigests = {
      appAsar: "a".repeat(64),
      sidecar: "b".repeat(64),
      shortcutHelper: "c".repeat(64),
      speechHelper: "d".repeat(64),
    };

    expect(
      evaluateCandidateEvidenceProvenance({
        artifactAppPath: "/candidate/Plainsong.app",
        artifactSidecarPath:
          "/candidate/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
        candidateAppPath: "/candidate/Plainsong.app",
        artifactComponents: componentDigests,
        candidateComponents: componentDigests,
      }),
    ).toMatchObject({
      valid: true,
      mode: "exact-candidate-components",
    });

    expect(
      evaluateCandidateEvidenceProvenance({
        artifactAppPath: "/candidate/Plainsong.app",
        artifactSidecarPath:
          "/candidate/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
        candidateAppPath: "/candidate/Plainsong.app",
        artifactComponents: componentDigests,
        candidateComponents: {
          ...componentDigests,
          appAsar: "e".repeat(64),
        },
      }),
    ).toMatchObject({
      valid: false,
      mode: "stale-same-path-evidence",
    });
  });

  it("rejects an evidence transfer when the exact candidate sidecar differs", () => {
    const components = Object.fromEntries(
      ["sidecar", "shortcutHelper", "speechHelper"].map((name) => [
        name,
        {
          referenceUnsignedSha256: `${name}-reference`,
          candidateUnsignedSha256:
            name === "sidecar" ? `${name}-candidate` : `${name}-reference`,
          unsignedCodeIdentical: name !== "sidecar",
        },
      ]),
    );
    const evaluation = evaluateComponentEquivalence({
      referenceApp: "/reference/Plainsong.app",
      candidateApp: "/candidate/Plainsong.app",
      referenceTrustPass: true,
      candidateTrustPass: true,
      sameSigningTeam: true,
      sameBundleIdentifier: true,
      components,
    });
    expect(evaluation.pass).toBe(false);

    const provenance = evaluateCandidateEvidenceProvenance({
      artifactAppPath: "/reference/Plainsong.app",
      artifactSidecarPath:
        "/reference/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      candidateAppPath: "/candidate/Plainsong.app",
      equivalence: {
        pass: evaluation.pass,
        identity: {
          referenceApp: "/reference/Plainsong.app",
          candidateApp: "/candidate/Plainsong.app",
        },
        checks: evaluation.checks,
        components,
      },
    });
    expect(provenance.valid).toBe(false);
  });
});
