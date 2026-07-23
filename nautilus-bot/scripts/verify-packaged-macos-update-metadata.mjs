#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

// --pack-only: verify a `--dir` (electron:pack) build, which has app-update.yml
// but no latest-mac.yml / zip / blockmap artifacts. Used by the CI package gate.
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
const latestPath = path.resolve(repoRoot, valueFor("--latest", "release/latest-mac.yml"));
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/update-metadata.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/update-metadata.md")
);
const appUpdatePath = path.join(appPath, "Contents", "Resources", "app-update.yml");
const packageJsonPath = path.join(repoRoot, "package.json");

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
- Latest manifest: ${artifact.paths.latest}
- Error: ${artifact.error ?? "none"}
- Update provider: ${artifact.updateConfig?.provider ?? "missing"}
- GitHub owner: ${artifact.updateConfig?.owner ?? "missing"}
- GitHub repo: ${artifact.updateConfig?.repo ?? "missing"}
- Stable channel requests: ${artifact.stableChannel?.requestedManifest ?? "missing"}
- Published channel file: ${artifact.stableChannel?.publishedManifest ?? "missing"}
- Manifest version: ${artifact.latest?.version ?? "missing"}
- Package version: ${artifact.packageVersion ?? "missing"}
- ZIP artifact: ${artifact.latest?.zipPath ?? "missing"}
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

  // The manifest filename the shipped app requests for the default (stable)
  // channel, resolved through the same compiled module the packaged main
  // process uses. electron-builder publishes `latest-mac.yml` for stable
  // releases, so any drift here is the stable-channel
  // ERR_UPDATER_CHANNEL_FILE_NOT_FOUND bug this check exists to catch.
  const require = createRequire(import.meta.url);
  let requestedStableManifest = null;
  try {
    const { updaterChannelManifestFilename } = require(
      path.join(repoRoot, "dist-electron", "updater-channel.js")
    );
    requestedStableManifest = updaterChannelManifestFilename("stable", "darwin");
  } catch {
    // Left null: stableChannelResolverLoaded fails below. Run
    // `bun run build:electron` first so dist-electron/updater-channel.js exists.
  }
  const publishedChannel = scalarValue(appUpdate, "channel") ?? "latest";
  const publishedStableManifest = `${publishedChannel}-mac.yml`;

  const latest = packOnly ? null : readRequired(latestPath, "latest mac manifest");
  const zipName = latest ? (scalarValue(latest, "path") ?? firstFileUrl(latest)) : null;
  const zipPath = zipName ? path.join(path.dirname(latestPath), zipName) : null;
  const blockmapPath = zipPath ? `${zipPath}.blockmap` : null;
  const expectedSha512 = latest
    ? (scalarValue(latest, "sha512") ?? firstIndentedScalarValue(latest, "sha512"))
    : null;
  const expectedSizeRaw = latest
    ? (scalarValue(latest, "size") ?? firstIndentedScalarValue(latest, "size"))
    : null;
  const expectedSize = Number(expectedSizeRaw);
  const actualSize = zipPath && fs.existsSync(zipPath) ? fs.statSync(zipPath).size : null;
  const actualSha512 = zipPath && fs.existsSync(zipPath) ? sha512Base64(zipPath) : null;

  const artifact = {
    generatedAt: new Date().toISOString(),
    mode: packOnly ? "pack-only" : "full",
    pass: false,
    paths: {
      app: appPath,
      appUpdate: appUpdatePath,
      latest: latestPath,
    },
    packageVersion: packageJson.version ?? null,
    updateConfig: {
      provider: scalarValue(appUpdate, "provider"),
      owner: scalarValue(appUpdate, "owner"),
      repo: scalarValue(appUpdate, "repo"),
      updaterCacheDirName: scalarValue(appUpdate, "updaterCacheDirName"),
    },
    stableChannel: {
      requestedManifest: requestedStableManifest,
      publishedManifest: publishedStableManifest,
    },
    latest: latest
      ? {
          version: scalarValue(latest, "version"),
          releaseDate: scalarValue(latest, "releaseDate"),
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
    providerIsGithub: artifact.updateConfig.provider === "github",
    ownerConfigured: Boolean(artifact.updateConfig.owner),
    repoConfigured: Boolean(artifact.updateConfig.repo),
    stableChannelResolverLoaded: Boolean(requestedStableManifest),
    stableChannelRequestsPublishedManifest:
      requestedStableManifest === publishedStableManifest,
  };
  if (!packOnly) {
    Object.assign(artifact.checks, {
      latestManifestExists: fs.existsSync(latestPath),
      stableChannelManifestEmitted:
        Boolean(requestedStableManifest) &&
        path.basename(latestPath) === requestedStableManifest &&
        fs.existsSync(latestPath),
      versionMatchesPackage: artifact.latest.version === artifact.packageVersion,
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
    mode: packOnly ? "pack-only" : "full",
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    paths: {
      app: appPath,
      appUpdate: appUpdatePath,
      latest: latestPath,
    },
    checks: {},
  };
  writeArtifact(artifact);
  process.exit(1);
}
