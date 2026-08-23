#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

// --pack-only: verify app-update.yml without requiring the ZIP manifest or
// blockmap. Electron Builder does not emit app-update.yml for a macOS `--dir`
// target, so CI and release validation use the full ZIP-backed mode.
const packOnly = args.includes("--pack-only");

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const manifestPath = path.resolve(
  repoRoot,
  valueFor("--manifest", valueFor("--latest", "release/beta-mac.yml")),
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/update-metadata.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/update-metadata.md")
);
const appUpdatePath = path.join(appPath, "Contents", "Resources", "app-update.yml");
const appInfoPlistPath = path.join(appPath, "Contents", "Info.plist");
const packageJsonPath = path.join(repoRoot, "package.json");
const expectedBetaFeedUrl =
  "https://updates.plainsong.jonathanrreed.com/beta/";
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath: path.dirname(manifestPath),
  appPath,
});

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  return readText(filePath);
}

function scalarValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function booleanScalarValue(text, key) {
  const value = scalarValue(text, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function firstFileUrl(text) {
  const match = text.match(/^\s*-\s+url:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return match?.[1]?.trim() ?? null;
}

function firstIndentedScalarValue(text, key) {
  const match = text.match(new RegExp(`^\\s+${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function sha512Base64(filePath) {
  return crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function plistScalar(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", filePath],
    { encoding: "utf8" },
  );
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

function renderMarkdown(artifact) {
  return `# Updates: Packaged macOS Update Metadata

Status: ${artifact.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Mode: ${artifact.mode}
Generated: ${artifact.generatedAt}

## Command

\`bun run qa:packaged:macos:update-metadata\`

## Result

- App update metadata: ${artifact.paths.appUpdate}
- Beta manifest: ${artifact.paths.manifest}
- Error: ${artifact.error ?? "none"}
- Update provider: ${artifact.updateConfig?.provider ?? "missing"}
- Update feed: ${artifact.updateConfig?.url ?? "missing"}
- Multiple range requests: ${artifact.updateConfig?.useMultipleRangeRequest ?? "missing"}
- Release channel: ${artifact.releaseChannel ?? "missing"}
- Installed app requests: ${artifact.channel?.requestedManifest ?? "missing"}
- Packaged channel file: ${artifact.channel?.packagedManifest ?? "missing"}
- Manifest version: ${artifact.manifest?.version ?? "missing"}
- Packaged app version: ${artifact.appVersion ?? "missing"}
- Package version: ${artifact.packageVersion ?? "missing"}
- ZIP artifact: ${artifact.manifest?.zipPath ?? "missing"}
- ZIP SHA-512 matches manifest: ${artifact.checks.zipSha512MatchesManifest ? "yes" : "no"}
- ZIP size matches manifest: ${artifact.checks.zipSizeMatchesManifest ? "yes" : "no"}
- Blockmap exists: ${artifact.checks.blockmapExists ? "yes" : "no"}

## Checks

${Object.entries(artifact.checks)
  .map(([key, value]) => `- ${key}: ${value ? "PASS" : "FAIL"}`)
  .join("\n")}
`;
}

function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(artifact)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

try {
  const packageJson = JSON.parse(readRequired(packageJsonPath, "package.json"));
  const appUpdate = readRequired(appUpdatePath, "packaged app-update.yml");
  const appVersion = plistScalar(appInfoPlistPath, "CFBundleShortVersionString");

  const prerelease = String(appVersion ?? "").match(
    /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.|$)/,
  );
  const releaseChannel = prerelease?.[1] ?? "latest";

  // Resolve the exact manifest filename through the same compiled module used
  // by the packaged main process. The beta candidate must request beta-mac.yml
  // and electron-builder must package that same channel.
  const require = createRequire(import.meta.url);
  let requestedManifest = null;
  try {
    const { updaterChannelManifestFilename } = require(
      path.join(repoRoot, "dist-electron", "updater-channel.js")
    );
    requestedManifest = updaterChannelManifestFilename(
      releaseChannel === "beta" ? "beta" : "stable",
      "darwin",
    );
  } catch {
    // Left null: channelResolverLoaded fails below. Run
    // `bun run build:electron` first so dist-electron/updater-channel.js exists.
  }
  const packagedChannel = scalarValue(appUpdate, "channel") ?? "latest";
  const packagedManifest = `${packagedChannel}-mac.yml`;

  const manifest = packOnly
    ? null
    : readRequired(manifestPath, `${releaseChannel} mac manifest`);
  const zipName = manifest
    ? (scalarValue(manifest, "path") ?? firstFileUrl(manifest))
    : null;
  const zipPath = zipName ? path.join(path.dirname(manifestPath), zipName) : null;
  const blockmapPath = zipPath ? `${zipPath}.blockmap` : null;
  const expectedSha512 = manifest
    ? (scalarValue(manifest, "sha512") ?? firstIndentedScalarValue(manifest, "sha512"))
    : null;
  const expectedSizeRaw = manifest
    ? (scalarValue(manifest, "size") ?? firstIndentedScalarValue(manifest, "size"))
    : null;
  const expectedSize = Number(expectedSizeRaw);
  const actualSize = zipPath && fs.existsSync(zipPath) ? fs.statSync(zipPath).size : null;
  const actualSha512 = zipPath && fs.existsSync(zipPath) ? sha512Base64(zipPath) : null;

  const artifact = {
    generatedAt: new Date().toISOString(),
    candidateIdentity,
    mode: packOnly ? "pack-only" : "full",
    pass: false,
    paths: {
      app: appPath,
      appInfoPlist: appInfoPlistPath,
      appUpdate: appUpdatePath,
      manifest: manifestPath,
    },
    packageVersion: packageJson.version ?? null,
    appVersion,
    updateConfig: {
      provider: scalarValue(appUpdate, "provider"),
      url: scalarValue(appUpdate, "url"),
      useMultipleRangeRequest: booleanScalarValue(
        appUpdate,
        "useMultipleRangeRequest",
      ),
      updaterCacheDirName: scalarValue(appUpdate, "updaterCacheDirName"),
    },
    releaseChannel,
    channel: {
      requestedManifest,
      packagedManifest,
    },
    manifest: manifest
      ? {
          version: scalarValue(manifest, "version"),
          releaseDate: scalarValue(manifest, "releaseDate"),
          zipName,
          zipPath,
          expectedSha512,
          actualSha512,
          expectedSize: expectedSizeRaw && Number.isFinite(expectedSize) ? expectedSize : null,
          actualSize,
          blockmapPath,
        }
      : null,
    checks: {},
  };

  artifact.checks = {
    appUpdateMetadataExists: fs.existsSync(appUpdatePath),
    appInfoPlistExists: fs.existsSync(appInfoPlistPath),
    appVersionPresent: Boolean(appVersion),
    packageVersionMatchesPackagedApp:
      Boolean(appVersion) && artifact.packageVersion === appVersion,
    providerIsGeneric: artifact.updateConfig.provider === "generic",
    betaFeedUrlMatchesExpected:
      artifact.updateConfig.url === expectedBetaFeedUrl,
    multipleRangeRequestsDisabled:
      artifact.updateConfig.useMultipleRangeRequest === false,
    releaseChannelIsBeta: releaseChannel === "beta",
    packagedChannelMatchesRelease: packagedChannel === releaseChannel,
    channelResolverLoaded: Boolean(requestedManifest),
    installedChannelRequestsPackagedManifest:
      requestedManifest === packagedManifest,
  };
  if (!packOnly) {
    Object.assign(artifact.checks, {
      releaseManifestExists: fs.existsSync(manifestPath),
      betaChannelManifestEmitted:
        Boolean(requestedManifest) &&
        path.basename(manifestPath) === requestedManifest &&
        fs.existsSync(manifestPath),
      versionMatchesPackagedApp: artifact.manifest.version === artifact.appVersion,
      zipPathPresent: Boolean(zipPath),
      zipArtifactExists: Boolean(zipPath && fs.existsSync(zipPath)),
      zipSha512Present: Boolean(expectedSha512),
      zipSha512MatchesManifest: Boolean(expectedSha512 && actualSha512 === expectedSha512),
      zipSizePresent: Boolean(expectedSizeRaw && Number.isFinite(expectedSize)),
      zipSizeMatchesManifest: Boolean(
        expectedSizeRaw && Number.isFinite(expectedSize) && actualSize === expectedSize
      ),
      blockmapExists: Boolean(blockmapPath && fs.existsSync(blockmapPath)),
    });
  }
  artifact.pass = Object.values(artifact.checks).every(Boolean);

  writeArtifact(artifact);
  process.exit(artifact.pass ? 0 : 1);
} catch (error) {
  const artifact = {
    generatedAt: new Date().toISOString(),
    candidateIdentity,
    mode: packOnly ? "pack-only" : "full",
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    paths: {
      app: appPath,
      appUpdate: appUpdatePath,
      manifest: manifestPath,
    },
    checks: {},
  };
  writeArtifact(artifact);
  process.exit(1);
}
