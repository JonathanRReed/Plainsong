import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APP_COMPONENT_PATHS = [
  "Contents/Resources/app.asar",
  "Contents/Resources/sidecar/plainsong-sidecar",
  "Contents/MacOS/Plainsong",
  "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper",
  "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin",
  "Contents/Resources/app-update.yml",
  "Contents/Info.plist",
];

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileIdentity(filePath, name) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(file);
  }
  return { name, bytes: stat.size, sha256: hash.digest("hex") };
}

function digestEntries(entries) {
  return sha256Buffer(
    JSON.stringify(
      [...entries].sort((left, right) => left.name.localeCompare(right.name)),
    ),
  );
}

export function collectReleaseCandidateIdentity({ candidatePath, appPath }) {
  const resolvedCandidatePath = path.resolve(candidatePath);
  const resolvedAppPath = path.resolve(appPath);
  const missing = [];
  const appComponents = [];

  for (const relativePath of APP_COMPONENT_PATHS) {
    const identity = fileIdentity(
      path.join(resolvedAppPath, relativePath),
      relativePath,
    );
    if (identity) appComponents.push(identity);
    else missing.push(`app:${relativePath}`);
  }

  const candidateNames = fs.existsSync(resolvedCandidatePath)
    ? fs.readdirSync(resolvedCandidatePath).sort()
    : [];
  const dmgNames = candidateNames.filter((name) => /\.dmg$/i.test(name));
  const zipNames = candidateNames.filter((name) => /-mac\.zip$/i.test(name));
  const blockmapNames = candidateNames.filter((name) => /\.blockmap$/i.test(name));
  const manifestNames = candidateNames.filter((name) => name === "beta-mac.yml");

  if (dmgNames.length !== 1) missing.push(`release:dmg-count:${dmgNames.length}`);
  if (zipNames.length !== 1) missing.push(`release:zip-count:${zipNames.length}`);
  if (blockmapNames.length !== 1) {
    missing.push(`release:blockmap-count:${blockmapNames.length}`);
  }
  if (manifestNames.length !== 1) {
    missing.push(`release:beta-manifest-count:${manifestNames.length}`);
  }

  const artifacts = [
    ...dmgNames,
    ...zipNames,
    ...blockmapNames,
    ...manifestNames,
  ]
    .map((name) => fileIdentity(path.join(resolvedCandidatePath, name), name))
    .filter(Boolean);
  const appComponentsSha256 = digestEntries(appComponents);
  const releaseSha256 = digestEntries([
    { name: "app-components", bytes: 0, sha256: appComponentsSha256 },
    ...artifacts,
  ]);

  return {
    schemaVersion: 1,
    complete: missing.length === 0,
    missing,
    appComponents,
    artifacts,
    appComponentsSha256,
    releaseSha256,
  };
}
