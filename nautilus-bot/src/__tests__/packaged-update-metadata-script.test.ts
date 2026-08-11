import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function createTempRepo(scriptName: string) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "plainsong-update-metadata-"));
  const tempScriptsDir = path.join(tempRoot, "scripts");
  mkdirSync(tempScriptsDir, { recursive: true });

  const sourceScript = path.resolve(process.cwd(), "scripts", scriptName);
  const tempScript = path.join(tempScriptsDir, scriptName);
  copyFileSync(sourceScript, tempScript);
  mkdirSync(path.join(tempScriptsDir, "lib"), { recursive: true });
  copyFileSync(
    path.resolve(process.cwd(), "scripts/lib/release-candidate-identity.mjs"),
    path.join(tempScriptsDir, "lib/release-candidate-identity.mjs"),
  );

  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "plainsong", version: "0.9.0-beta.1" }, null, 2),
  );

  return { tempRoot, tempScript };
}

function writeAppInfoPlist(appPath: string, version: string) {
  const contentsPath = path.join(appPath, "Contents");
  mkdirSync(contentsPath, { recursive: true });
  writeFileSync(
    path.join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
  );
}

describe("verify-packaged-macos-update-metadata.mjs", () => {
  it("writes JSON and Markdown artifacts and preserves the missing app-update.yml error when the packaged app is missing", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-packaged-macos-update-metadata.mjs");
    try {
      const outPath = path.join(tempRoot, "artifacts", "qa", "macos", "update-metadata.json");
      const markdownPath = path.join(tempRoot, "artifacts", "qa", "macos", "update-metadata.md");
      const appPath = path.join(tempRoot, "missing.app");
      const latestPath = path.join(tempRoot, "release", "latest-mac.yml");

      const result = spawnSync(
        "node",
        [
          tempScript,
          "--app",
          appPath,
          "--latest",
          latestPath,
          "--out",
          outPath,
          "--markdown",
          markdownPath,
        ],
        {
          encoding: "utf8",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();

      expect(result.stdout).not.toMatch(/TypeError/);
      expect(result.stdout).toContain("packaged app-update.yml not found");
      expect(result.stderr).not.toContain("TypeError");

      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        error?: string;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.error).toContain("packaged app-update.yml not found");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("Status: FAIL");
      expect(markdown).toContain("qa:packaged:macos:update-metadata");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the beta channel manifest is missing", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-packaged-macos-update-metadata.mjs");
    try {
      const appPath = path.join(tempRoot, "release", "mac-arm64", "Plainsong.app");
      const resourcesPath = path.join(appPath, "Contents", "Resources");
      mkdirSync(resourcesPath, { recursive: true });
      writeAppInfoPlist(appPath, "0.9.0-beta.1");
      writeFileSync(
        path.join(resourcesPath, "app-update.yml"),
        "provider: generic\nurl: https://updates.plainsong.jonathanrreed.com/beta/\nchannel: beta\nuseMultipleRangeRequest: false\n",
      );

      const outPath = path.join(tempRoot, "artifacts", "update.json");
      const result = spawnSync(
        "node",
        [tempScript, "--app", appPath, "--out", outPath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        error?: string;
        paths: { manifest: string };
      };
      expect(artifact.paths.manifest).toMatch(/beta-mac\.yml$/);
      expect(artifact.error).toContain("beta mac manifest not found");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts a matching beta manifest, ZIP, blockmap, and package version", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-packaged-macos-update-metadata.mjs");
    try {
      const appPath = path.join(tempRoot, "release", "mac-arm64", "Plainsong.app");
      const resourcesPath = path.join(appPath, "Contents", "Resources");
      const releasePath = path.join(tempRoot, "release");
      const distElectronPath = path.join(tempRoot, "dist-electron");
      mkdirSync(resourcesPath, { recursive: true });
      writeAppInfoPlist(appPath, "0.9.0-beta.1");
      mkdirSync(distElectronPath, { recursive: true });
      writeFileSync(
        path.join(resourcesPath, "app-update.yml"),
        "provider: generic\nurl: https://updates.plainsong.jonathanrreed.com/beta/\nchannel: beta\nuseMultipleRangeRequest: false\n",
      );
      writeFileSync(
        path.join(distElectronPath, "updater-channel.js"),
        'exports.updaterChannelManifestFilename = () => "beta-mac.yml";\n',
      );
      const zipName = "Plainsong-0.9.0-beta.1-arm64-mac.zip";
      const zipPath = path.join(releasePath, zipName);
      writeFileSync(zipPath, "signed beta zip fixture");
      writeFileSync(`${zipPath}.blockmap`, "blockmap fixture");
      const zipBytes = readFileSync(zipPath);
      const sha512 = crypto.createHash("sha512").update(zipBytes).digest("base64");
      writeFileSync(
        path.join(releasePath, "beta-mac.yml"),
        `version: 0.9.0-beta.1\npath: ${zipName}\nsha512: ${sha512}\nsize: ${zipBytes.byteLength}\nreleaseDate: '2026-08-08T00:00:00.000Z'\n`,
      );

      const outPath = path.join(tempRoot, "artifacts", "update.json");
      const result = spawnSync(
        "node",
        [tempScript, "--app", appPath, "--out", outPath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        pass: boolean;
        releaseChannel: string;
        updateConfig: {
          provider: string;
          url: string;
          useMultipleRangeRequest: boolean;
        };
        checks: Record<string, boolean>;
      };
      expect(artifact.pass).toBe(true);
      expect(artifact.releaseChannel).toBe("beta");
      expect(artifact.updateConfig).toMatchObject({
        provider: "generic",
        url: "https://updates.plainsong.jonathanrreed.com/beta/",
        useMultipleRangeRequest: false,
      });
      expect(Object.values(artifact.checks).every(Boolean)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the packaged app version as candidate truth and flags a stale workspace", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-packaged-macos-update-metadata.mjs");
    try {
      writeFileSync(
        path.join(tempRoot, "package.json"),
        JSON.stringify({ name: "plainsong", version: "0.9.0-beta.2" }, null, 2),
      );
      const appPath = path.join(tempRoot, "release", "mac-arm64", "Plainsong.app");
      const resourcesPath = path.join(appPath, "Contents", "Resources");
      const releasePath = path.join(tempRoot, "release");
      const distElectronPath = path.join(tempRoot, "dist-electron");
      mkdirSync(resourcesPath, { recursive: true });
      mkdirSync(distElectronPath, { recursive: true });
      writeAppInfoPlist(appPath, "0.9.0-beta.1");
      writeFileSync(
        path.join(resourcesPath, "app-update.yml"),
        "provider: github\nowner: JonathanRReed\nrepo: Plainsong\nchannel: beta\n",
      );
      writeFileSync(
        path.join(distElectronPath, "updater-channel.js"),
        'exports.updaterChannelManifestFilename = () => "beta-mac.yml";\n',
      );
      const zipName = "Plainsong-0.9.0-beta.1-arm64-mac.zip";
      const zipPath = path.join(releasePath, zipName);
      writeFileSync(zipPath, "signed beta zip fixture");
      writeFileSync(`${zipPath}.blockmap`, "blockmap fixture");
      const zipBytes = readFileSync(zipPath);
      const sha512 = crypto.createHash("sha512").update(zipBytes).digest("base64");
      writeFileSync(
        path.join(releasePath, "beta-mac.yml"),
        `version: 0.9.0-beta.1\npath: ${zipName}\nsha512: ${sha512}\nsize: ${zipBytes.byteLength}\n`,
      );
      const outPath = path.join(tempRoot, "artifacts", "update.json");

      const result = spawnSync(
        "node",
        [tempScript, "--app", appPath, "--out", outPath],
        { encoding: "utf8" },
      );
      const artifact = JSON.parse(readFileSync(outPath, "utf8"));

      expect(result.status).toBe(1);
      expect(artifact.appVersion).toBe("0.9.0-beta.1");
      expect(artifact.releaseChannel).toBe("beta");
      expect(artifact.checks.versionMatchesPackagedApp).toBe(true);
      expect(artifact.checks.packageVersionMatchesPackagedApp).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
