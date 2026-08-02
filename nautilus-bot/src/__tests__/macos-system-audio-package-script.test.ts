import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("macOS system-audio packaging gates", () => {
  it("keeps macOS 13 launch metadata while requiring dynamic process-tap imports", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "verify-macos-system-audio.mjs"), "--source-only"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      pass: true,
      sourceOnly: true,
      minimumSystemVersion: "13.0",
      processTapImports: "dynamic-only",
    });
  });

  it("builds Darwin sidecars with an explicit macOS 13 deployment target", () => {
    const buildScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "build-rust-sidecar.mjs"),
      "utf8",
    );
    expect(buildScript).toContain('env.MACOSX_DEPLOYMENT_TARGET = "13.0"');
    expect(buildScript).toContain("verify-macos-system-audio.mjs");
  });

  it("builds the native shortcut helper for the documented macOS 13 floor", () => {
    const buildScript = fs.readFileSync(
      path.join(repoRoot, "scripts/build-native-shortcut-helper.mjs"),
      "utf8",
    );
    expect(buildScript).toContain(
      'const deploymentTarget = `${swiftArchitecture}-apple-macosx13.0`;',
    );
    expect(buildScript).toContain('"-target", deploymentTarget');
  });

  it("requires packaged callbacks, non-silent frames, and the known tone", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-system-audio-test.mjs"),
      "utf8",
    );
    expect(qaScript).toContain('method: "test_system_audio_capture"');
    expect(qaScript).toContain("Number(result.callbacks) > 0");
    expect(qaScript).toContain("Number(result.nonSilentFrames) > 0");
    expect(qaScript).toContain("Number(result.detectedToneAmplitude) >= 0.005");
    expect(qaScript).toContain('result.verificationMethod === "known_tone"');
    expect(qaScript).toContain('valueFor("--timeout-ms", "90000")');
    expect(qaScript).toContain('method: "get_settings"');
    expect(qaScript).toContain("sidecarResponsiveAfterTest");
  });

  it("verifies the known tone before combined meeting capture in the same sidecar", () => {
    for (const scriptName of [
      "capture-packaged-macos-meeting-mic.mjs",
      "capture-packaged-macos-meeting-soak.mjs",
    ]) {
      const qaScript = fs.readFileSync(
        path.join(repoRoot, "scripts", scriptName),
        "utf8",
      );
      const verificationIndex = qaScript.indexOf(
        'sendCommand(\n        "test_system_audio_capture"',
      );
      const setupIndex = qaScript.indexOf('sendCommand("verify_meeting_setup"');

      expect(verificationIndex).toBeGreaterThan(-1);
      expect(setupIndex).toBeGreaterThan(verificationIndex);
      expect(qaScript).toContain("systemAudioVerifiedForCombinedCapture");
      expect(qaScript).toContain(
        'artifact.systemAudioVerification?.verificationMethod === "known_tone"',
      );
    }
  });

  it("proves a virtual microphone timeout is bounded and leaves the sidecar usable", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );

    expect(qaScript).toContain('args.includes("--expect-start-failure")');
    expect(qaScript).toContain(
      'valueFor("--max-start-failure-ms", "5000")',
    );
    expect(qaScript).toContain(
      'await sidecar.sendCommand("get_settings", {})',
    );
    expect(qaScript).toContain(
      "artifact.startFailureRecovery.sidecarResponsive = true",
    );
    expect(qaScript).toContain("expectedStartFailureObserved");
    expect(qaScript).toContain("startFailureWithinLimit");
    expect(qaScript).toContain("sidecarResponsiveAfterStartFailure");
    expect(qaScript).toContain("virtualFixtureOutputRestored");
    expect(qaScript).toContain("sidecarExitedCleanly");
  });
});
