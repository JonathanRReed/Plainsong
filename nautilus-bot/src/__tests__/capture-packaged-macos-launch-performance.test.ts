import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../scripts/capture-packaged-macos-launch-performance.mjs",
  ),
  "utf8",
);

describe("packaged macOS launch-performance receipt", () => {
  it("launches the measured run through LaunchServices and keeps optional DOM verification on private pipes", () => {
    expect(source).toContain('const OPEN_BINARY = "/usr/bin/open"');
    expect(source).toMatch(/"-n",\s*"-W",\s*appPath,/);
    expect(source).toContain('"--args",');
    expect(source).toMatch(/"--env",\s*`PLAINSONG_QA_MODE=1`/);
    expect(source).toMatch(/"--env",\s*`PLAINSONG_DATA_DIR=\$\{dataRoot\}`/);
    expect(source).toMatch(/"--env",\s*`PLAINSONG_CONFIG_DIR=\$\{configRoot\}`/);
    expect(source).not.toContain('"-a", appPath');
    expect(source).toContain("--plainsong-launch-metrics-file=");
    expect(source).toContain(
      'const verifyDomContract = args.includes("--verify-dom-contract")',
    );
    expect(source).toContain('"--remote-debugging-pipe"');
    expect(source).toContain(
      'stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]',
    );
    expect(source).not.toMatch(/--remote-debugging-port(?:=|\b)/);
    expect(source).not.toMatch(/https?:\/\/(?:127\.0\.0\.1|localhost)/);
  });

  it("targets the main renderer and measures painted and interactive DOM states", () => {
    expect(source).toContain('cdp.send("Target.getTargets")');
    expect(source).toContain('cdp.send("Target.attachToTarget", {');
    expect(source).toContain('!target.url.includes("overlay")');
    expect(source).toContain(
      'performance.getEntriesByName("first-contentful-paint")',
    );
    expect(source).toContain(
      "document.querySelector('[aria-label=\"Checking first-run setup\"]')",
    );
    expect(source).toContain('document.querySelector("main#main-content")');
    expect(source).toContain(
      'document.querySelector(\'[role="dialog"][aria-modal="true"]\')',
    );
    expect(source).toContain(
      "observation.workspaceVisible || observation.wizardVisible",
    );
    expect(source).not.toContain(
      "observation.splashVisible || observation.workspaceVisible",
    );
  });

  it("binds the receipt to the candidate and launch environment", () => {
    for (const field of [
      "sourceSha",
      "appSha256",
      "appBundleSha256",
      "sourceProvenance",
      "signingIdentity",
      "notarized",
      "stapled",
      "architecture",
      "macosVersion",
      "hardwareModel",
      "displayRefreshRateHz",
      "loadAverage",
      "profileCondition",
      "milestoneLogs",
    ]) {
      expect(source).toContain(field);
    }
  });

  it("separates timing from release trust and fails closed for release qualification", () => {
    expect(source).toContain("timingPass");
    expect(source).toContain("trustPass");
    expect(source).toContain("releaseQualifiedPass: timingPass && trustPass");
    expect(source).toContain("developerIdSigned");
    expect(source).toContain("notarized");
    expect(source).toContain("stapled");
    expect(source).toContain('architecture === "arm64"');
    expect(source).toMatch(
      /args\.includes\(\s*"--diagnostic-allow-unqualified"/,
    );
    expect(source).toContain("codesignVerify.status === 0");
    expect(source).toContain("spctlAssessment.status === 0");
    expect(source).toContain("staplerValidation.status === 0");
  });

  it("isolates milestones per launch and cannot miss an early open exit", () => {
    expect(source).toContain("`launch-milestones-${runId}.jsonl`");
    expect(source).toContain("const childCompletion = new Promise");
    expect(source).toContain(
      "child.exitCode !== null || child.signalCode !== null",
    );
    expect(source).toContain("await childCompletion");
  });

  it("requires warm profiles to be stamped by the measured candidate", () => {
    expect(source).toContain(
      'const PROFILE_STAMP_FILE = "launch-candidate.json"',
    );
    expect(source).toContain(
      "Warm measurements require an existing candidate-stamped --profile-root",
    );
    expect(source).toContain("stamp.appBundleSha256 !== appBundleSha256");
  });
});
