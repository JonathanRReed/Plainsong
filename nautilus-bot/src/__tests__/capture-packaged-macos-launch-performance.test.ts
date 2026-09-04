import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/capture-packaged-macos-launch-performance.mjs"),
  "utf8",
);

describe("packaged macOS launch-performance receipt", () => {
  it("launches the measured run through LaunchServices and keeps optional DOM verification on private pipes", () => {
    expect(source).toContain('const OPEN_BINARY = "/usr/bin/open"');
    expect(source).toContain('"-n", "-W", appPath, "--args"');
    expect(source).not.toContain('"-a", appPath');
    expect(source).toContain("--plainsong-launch-metrics-file=");
    expect(source).toContain('const verifyDomContract = args.includes("--verify-dom-contract")');
    expect(source).toContain('"--remote-debugging-pipe"');
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]');
    expect(source).not.toMatch(/--remote-debugging-port(?:=|\b)/);
    expect(source).not.toMatch(/https?:\/\/(?:127\.0\.0\.1|localhost)/);
  });

  it("targets the main renderer and measures painted and interactive DOM states", () => {
    expect(source).toContain('cdp.send("Target.getTargets")');
    expect(source).toContain('cdp.send("Target.attachToTarget", {');
    expect(source).toContain('!target.url.includes("overlay")');
    expect(source).toContain('performance.getEntriesByName("first-contentful-paint")');
    expect(source).toContain('document.querySelector(\'[aria-label="Checking first-run setup"]\')');
    expect(source).toContain('document.querySelector("main#main-content")');
    expect(source).toContain('document.querySelector(\'[role="dialog"][aria-modal="true"]\')');
  });

  it("binds the receipt to the candidate and launch environment", () => {
    for (const field of [
      "sourceSha",
      "appSha256",
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
    expect(source).toContain('args.includes("--diagnostic-allow-unqualified")');
  });
});
