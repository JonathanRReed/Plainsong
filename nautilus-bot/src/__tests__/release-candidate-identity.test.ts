import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectReleaseCandidateIdentity } from "../../scripts/lib/release-candidate-identity.mjs";

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
    ["Plainsong-0.9.0-beta.1-arm64.dmg", "dmg"],
    ["Plainsong-0.9.0-beta.1-arm64-mac.zip", "zip"],
    ["Plainsong-0.9.0-beta.1-arm64-mac.zip.blockmap", "blockmap"],
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
        "node",
        [
          path.join(repoRoot, "scripts/capture-packaged-macos-release-audit.mjs"),
          "--candidate",
          candidatePath,
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
