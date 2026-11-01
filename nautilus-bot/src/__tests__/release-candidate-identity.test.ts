import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectReleaseCandidateIdentity } from "../../scripts/lib/release-candidate-identity.ts";

function fixture() {
  const candidatePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "plainsong-candidate-identity-"),
  );
  const appPath = path.join(candidatePath, "mac-arm64", "Plainsong.app");
  const files = {
    "Contents/Resources/app.asar": "asar",
    "Contents/Resources/sidecar/plainsong-sidecar": "sidecar",
    "Contents/MacOS/Plainsong": "main",
    "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper":
      "shortcut",
    "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin":
      "speech",
    "Contents/Resources/app-update.yml": "provider: generic",
    "Contents/Info.plist": "plist",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(appPath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  for (const [name, contents] of [
    ["Plainsong-0.9.0-beta.2-arm64.dmg", "dmg"],
    ["Plainsong-0.9.0-beta.2-arm64-mac.zip", "zip"],
    ["Plainsong-0.9.0-beta.2-arm64-mac.zip.blockmap", "blockmap"],
    ["beta-mac.yml", "manifest"],
  ]) {
    fs.writeFileSync(path.join(candidatePath, name), contents);
  }
  return { candidatePath, appPath };
}

describe("release candidate identity", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  it("changes when any shipped release artifact changes", () => {
    const { candidatePath, appPath } = fixture();
    const before = collectReleaseCandidateIdentity({ candidatePath, appPath });

    fs.appendFileSync(path.join(candidatePath, "beta-mac.yml"), "\nchanged");
    const after = collectReleaseCandidateIdentity({ candidatePath, appPath });

    expect(before.complete).toBe(true);
    expect(after.releaseSha256).not.toBe(before.releaseSha256);
    fs.rmSync(candidatePath, { recursive: true, force: true });
  });

  it("changes when a packaged sidecar changes even if app.asar does not", () => {
    const { candidatePath, appPath } = fixture();
    const before = collectReleaseCandidateIdentity({ candidatePath, appPath });

    fs.appendFileSync(
      path.join(appPath, "Contents/Resources/sidecar/plainsong-sidecar"),
      "changed",
    );
    const after = collectReleaseCandidateIdentity({ candidatePath, appPath });

    expect(after.appComponentsSha256).not.toBe(before.appComponentsSha256);
    expect(after.releaseSha256).not.toBe(before.releaseSha256);
    fs.rmSync(candidatePath, { recursive: true, force: true });
  });

  it.each([
    "Contents/Resources/sidecar/plainsong-cli",
    "Contents/Resources/calendar-helper/plainsong-native-calendar-helper",
    "Contents/Resources/language-model-helper/plainsong-native-language-model-helper",
    "Contents/Resources/asr-helper/plainsong-native-asr-helper",
    "Contents/Resources/text-helper/plainsong-text-helper",
    "Contents/Frameworks/Electron Framework.framework/Electron Framework",
    "Contents/_CodeSignature/CodeResources",
    "Contents/Resources/unlisted-resource.txt",
  ])("binds the entire app bundle when %s changes", (relative) => {
    const { candidatePath, appPath } = fixture();
    try {
      const target = path.join(appPath, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "original");
      const before = collectReleaseCandidateIdentity({ candidatePath, appPath });
      fs.writeFileSync(target, "replacement");
      const changed = collectReleaseCandidateIdentity({ candidatePath, appPath });
      expect(changed.releaseSha256).not.toBe(before.releaseSha256);
      fs.rmSync(target);
      expect(collectReleaseCandidateIdentity({ candidatePath, appPath }).releaseSha256)
        .not.toBe(changed.releaseSha256);
    } finally {
      fs.rmSync(candidatePath, { recursive: true, force: true });
    }
  });

  it("binds executable permissions and symlink targets", () => {
    const { candidatePath, appPath } = fixture();
    try {
      const executable = path.join(appPath, "Contents/MacOS/Plainsong");
      fs.chmodSync(executable, 0o644);
      const before = collectReleaseCandidateIdentity({ candidatePath, appPath });
      fs.chmodSync(executable, 0o755);
      const executableChanged = collectReleaseCandidateIdentity({ candidatePath, appPath });
      expect(executableChanged.releaseSha256).not.toBe(before.releaseSha256);
      const link = path.join(appPath, "Contents/Current");
      fs.symlinkSync("Resources", link);
      const linked = collectReleaseCandidateIdentity({ candidatePath, appPath });
      fs.unlinkSync(link);
      fs.symlinkSync("MacOS", link);
      expect(collectReleaseCandidateIdentity({ candidatePath, appPath }).releaseSha256)
        .not.toBe(linked.releaseSha256);
    } finally {
      fs.rmSync(candidatePath, { recursive: true, force: true });
    }
  });

  it("rejects app receipts after an unlisted helper changes with preserved mtimes", () => {
    const { candidatePath, appPath } = fixture();
    try {
      const qaPath = path.join(candidatePath, "qa");
      fs.mkdirSync(qaPath);
      const helper = path.join(appPath, "Contents/Resources/sidecar/plainsong-cli");
      fs.writeFileSync(helper, "original CLI");
      const stat = fs.statSync(helper);
      const identity = collectReleaseCandidateIdentity({ candidatePath, appPath });
      fs.writeFileSync(path.join(qaPath, "backup-create-restore.json"), JSON.stringify({
        pass: true, generatedAt: new Date().toISOString(),
        candidateIdentity: identity, candidateAppUnchanged: true,
      }));
      const outPath = path.join(qaPath, "audit.json");
      const backupStatus = () => {
        spawnSync("bun", [
          path.join(repoRoot, "scripts/capture-packaged-macos-release-audit.ts"),
          "--candidate", candidatePath, "--qa-dir", qaPath, "--out", outPath,
          "--markdown", path.join(qaPath, "audit.md"),
        ], { cwd: repoRoot, encoding: "utf8" });
        const audit = JSON.parse(fs.readFileSync(outPath, "utf8"));
        return audit.requirements.find((requirement: { id: string }) => requirement.id === "backup-restore").status;
      };
      expect(backupStatus()).toBe("proved");
      fs.writeFileSync(helper, "replacement CLI");
      fs.utimesSync(helper, stat.atime, stat.mtime);
      expect(backupStatus()).toBe("contradicted");
    } finally {
      fs.rmSync(candidatePath, { recursive: true, force: true });
    }
  });

  it("rejects a failed receipt even when its safety fields and app identity match", () => {
    const { candidatePath, appPath } = fixture();
    try {
      const qaPath = path.join(candidatePath, "qa");
      fs.mkdirSync(qaPath);
      fs.writeFileSync(path.join(qaPath, "support-bundle.json"), JSON.stringify({
        pass: false, safeToShare: true,
        excludedByDesign: Array.from({ length: 8 }, (_, index) => `excluded-${index}`),
        candidateIdentity: collectReleaseCandidateIdentity({ candidatePath, appPath }),
        candidateAppUnchanged: true,
      }));
      const outPath = path.join(qaPath, "audit.json");
      spawnSync("bun", [
        path.join(repoRoot, "scripts/capture-packaged-macos-release-audit.ts"),
        "--candidate", candidatePath, "--qa-dir", qaPath, "--out", outPath,
        "--markdown", path.join(qaPath, "audit.md"),
      ], { cwd: repoRoot, encoding: "utf8" });
      const audit = JSON.parse(fs.readFileSync(outPath, "utf8"));
      expect(audit.requirements.find((requirement: { id: string }) => requirement.id === "support-bundle"))
        .toMatchObject({ status: "contradicted" });
    } finally {
      fs.rmSync(candidatePath, { recursive: true, force: true });
    }
  });

  it("prevents an artifact receipt from surviving a manifest replacement", () => {
    const { candidatePath, appPath } = fixture();
    const qaPath = path.join(candidatePath, "qa");
    const outPath = path.join(qaPath, "audit.json");
    fs.mkdirSync(qaPath, { recursive: true });
    const identity = collectReleaseCandidateIdentity({ candidatePath, appPath });
    fs.writeFileSync(
      path.join(qaPath, "update-metadata.json"),
      JSON.stringify({
        pass: true,
        generatedAt: new Date().toISOString(),
        candidateIdentity: identity,
      }),
    );

    const runAudit = () => {
      spawnSync(
        "bun",
        [
          path.join(repoRoot, "scripts/capture-packaged-macos-release-audit.ts"),
          "--candidate",
          candidatePath,
          "--qa-dir",
          qaPath,
          "--out",
          outPath,
          "--markdown",
          path.join(qaPath, "audit.md"),
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      return JSON.parse(fs.readFileSync(outPath, "utf8"));
    };

    expect(
      runAudit().requirements.find(
        (requirement: { id: string }) => requirement.id === "update-metadata",
      ),
    ).toMatchObject({ status: "proved" });

    fs.appendFileSync(path.join(candidatePath, "beta-mac.yml"), "\nreplaced");
    expect(
      runAudit().requirements.find(
        (requirement: { id: string }) => requirement.id === "update-metadata",
      ),
    ).toMatchObject({ status: "contradicted" });
    fs.rmSync(candidatePath, { recursive: true, force: true });
  });
});
