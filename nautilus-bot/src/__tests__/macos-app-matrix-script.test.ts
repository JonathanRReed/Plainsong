import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const captureScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "capture-packaged-macos-app-matrix-insertion.mjs"),
  "utf8",
);
const verifierScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-packaged-macos-app-matrix-insertion.mjs"),
  "utf8",
);

describe("macOS app matrix insertion scripts", () => {
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

  it("refuses to call a run PASS when it closes no matrix row", () => {
    // A read-back on a surface the harness itself owns proves insertion works
    // in that surface's host application; it does not close the row naming a
    // product the harness never opened.
    expect(verifierScript).toContain("PASS_OUT_OF_SCOPE");
    expect(captureScript).toContain("closesMatrixRow");
  });
});
