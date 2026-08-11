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
    expect(qaScript).toContain("sidecarExitedCleanly");
    expect(qaScript).toContain("child.kill(\"SIGTERM\"), 15000");
  });

  it("verifies system audio before combined meeting capture in the same sidecar", () => {
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
      expect(qaScript).toContain('"known_tone"');
    }
  });

  it("starts external fixture audio before verifying a virtual loopback route", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );
    const earlyFixtureIndex = qaScript.indexOf(
      "if (speakFixture && virtualFixtureDeviceName)",
    );
    const verificationIndex = qaScript.indexOf(
      'sendCommand(\n        "test_system_audio_capture"',
    );

    expect(earlyFixtureIndex).toBeGreaterThan(-1);
    expect(verificationIndex).toBeGreaterThan(earlyFixtureIndex);
    expect(qaScript).toContain('? "external_audio"');
    expect(qaScript).toContain("if (speakFixture && !speechFixture)");
  });

  it("routes and restores both macOS output classes for the spoken fixture", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );

    expect(qaScript).toContain('currentAudioSource("system")');
    expect(qaScript).toContain(
      'selectAudioSource(virtualFixtureDeviceName, "system")',
    );
    expect(qaScript).toContain("systemOutputDeviceRestored");
    expect(qaScript).toContain("virtualFixtureSystemOutputSelected");
    expect(qaScript).toContain("virtualFixtureSystemOutputRestored");
  });

  it("binds the three-hour soak receipt to the exact release identity", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );
    const auditScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
      "utf8",
    );
    const meetingSoakStart = auditScript.indexOf('id: "meeting-soak"');
    const meetingSoakEnd = auditScript.indexOf('id: "source-gates"');
    const meetingSoakRequirement = auditScript.slice(
      meetingSoakStart,
      meetingSoakEnd,
    );

    expect(qaScript).toContain("collectReleaseCandidateIdentity");
    expect(qaScript).toContain("candidateIdentity");
    expect(meetingSoakStart).toBeGreaterThan(-1);
    expect(meetingSoakEnd).toBeGreaterThan(meetingSoakStart);
    expect(meetingSoakRequirement).toContain('candidateIdentityMode: "release"');
  });

  it("releases fixture audio before waiting for long-form transcription", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );
    const stopRecordingIndex = qaScript.indexOf(
      'await sidecar.sendCommand("stop_recording"',
    );
    const releaseFixtureIndex = qaScript.indexOf(
      "await releaseFixtureEnvironment();",
      stopRecordingIndex,
    );
    const transcriptWaitIndex = qaScript.indexOf(
      "await waitForTranscript(sidecar, artifact.recordingId)",
      stopRecordingIndex,
    );

    expect(stopRecordingIndex).toBeGreaterThan(-1);
    expect(releaseFixtureIndex).toBeGreaterThan(stopRecordingIndex);
    expect(transcriptWaitIndex).toBeGreaterThan(releaseFixtureIndex);
  });

  it("proves the observed recording duration instead of only the requested duration", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );
    const auditScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
      "utf8",
    );
    const meetingSoakStart = auditScript.indexOf('id: "meeting-soak"');
    const meetingSoakEnd = auditScript.indexOf('id: "source-gates"');
    const meetingSoakRequirement = auditScript.slice(
      meetingSoakStart,
      meetingSoakEnd,
    );

    expect(qaScript).toContain("recordingDurationMs");
    expect(qaScript).toContain("minimumDurationObserved");
    expect(meetingSoakRequirement).toContain(
      "artifact?.recordingDurationMs >= 3 * 60 * 60 * 1000",
    );
  });

  it("can mute a native spoken fixture and restores the prior output state", () => {
    const qaScript = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-soak.mjs"),
      "utf8",
    );

    expect(qaScript).toContain('args.includes("--mute-fixture-output")');
    expect(qaScript).toContain("artifact.fixtureOutputMutedDuring");
    expect(qaScript).toContain("fixtureOutputMuteRestored");
    expect(qaScript).toContain("fixtureOutputMuteRestoreErrorAbsent");
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
