import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("macOS app matrix insertion scripts", () => {
  it("accepts an exact target bundle identifier when macOS omits the app name", () => {
    const captureScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-app-matrix-insertion.mjs"),
      "utf8",
    );
    const verifierScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "verify-packaged-macos-app-matrix-insertion.mjs"),
      "utf8",
    );

    expect(captureScript).toContain('"Apple Notes": ["com.apple.Notes"]');
    expect(captureScript).toContain(
      "expected.toLowerCase() === bundleId.toLowerCase()",
    );
    expect(captureScript).toContain("artifact.sidecarResult?.targetBundleId");
    expect(verifierScript).toContain(
      "artifact.sidecarResult?.targetBundleId === \"string\"",
    );
    expect(verifierScript).toContain(
      "sidecarResult.targetApp or targetBundleId must be present.",
    );
  });
});
