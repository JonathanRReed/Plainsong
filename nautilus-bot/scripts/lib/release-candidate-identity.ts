import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ReleaseCandidateFileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}

export type AppBundleEntry =
  | { name: string; mode: number; type: "directory" }
  | { name: string; mode: number; type: "symlink"; target: string }
  | (ReleaseCandidateFileIdentity & { mode: number; type: "file" });

export interface AppBundleIdentity {
  entries: AppBundleEntry[];
  sha256: string;
}

export interface ReleaseCandidateIdentity {
  schemaVersion: 2;
  complete: boolean;
  missing: string[];
  appComponents: ReleaseCandidateFileIdentity[];
  appBundle: AppBundleIdentity | null;
  artifacts: ReleaseCandidateFileIdentity[];
  appComponentsSha256: string;
  releaseSha256: string;
}

const APP_COMPONENT_PATHS = [
  "Contents/Resources/app.asar",
  "Contents/Resources/sidecar/plainsong-sidecar",
  "Contents/MacOS/Plainsong",
  "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper",
  "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin",
  "Contents/Resources/app-update.yml",
  "Contents/Info.plist",
];

function sha256Buffer(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileIdentity(filePath: string, name: string): ReleaseCandidateFileIdentity | null {
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

function digestEntries<T extends { name: string }>(entries: readonly T[]): string {
  return sha256Buffer(
    JSON.stringify(
      [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    ),
  );
}

export function collectAppBundleIdentity(appPath: string): AppBundleIdentity | null {
  if (!fs.existsSync(appPath)) return null;
  if (!fs.lstatSync(appPath).isDirectory()) {
    throw new Error(`App bundle is not a directory: ${appPath}`);
  }
  const entries: AppBundleEntry[] = [];
  function visit(relativePath: string): void {
    const entryPath = relativePath === "." ? appPath : path.join(appPath, relativePath);
    const stat = fs.lstatSync(entryPath);
    const entry = { name: relativePath, mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, type: "symlink", target: fs.readlinkSync(entryPath) });
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const name of fs.readdirSync(entryPath).sort()) {
        visit(relativePath === "." ? name : `${relativePath}/${name}`);
      }
    } else if (stat.isFile()) {
      // `fileIdentity` only returns null for a path that is not a regular file,
      // which `isFile()` just ruled out.
      entries.push({
        ...entry,
        type: "file",
        ...fileIdentity(entryPath, relativePath),
      } as AppBundleEntry);
    } else {
      throw new Error(`Unsupported app bundle entry: ${entryPath}`);
    }
  }
  visit(".");
  return { entries, sha256: digestEntries(entries) };
}

export function collectReleaseCandidateIdentity({
  candidatePath,
  appPath,
}: {
  candidatePath: string;
  appPath: string;
}): ReleaseCandidateIdentity {
  const resolvedCandidatePath = path.resolve(candidatePath);
  const resolvedAppPath = path.resolve(appPath);
  const missing: string[] = [];
  const appComponents: ReleaseCandidateFileIdentity[] = [];

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
    .filter((identity): identity is ReleaseCandidateFileIdentity => Boolean(identity));
  const appBundle = collectAppBundleIdentity(resolvedAppPath);
  if (!appBundle) missing.push("app:bundle");
  const appComponentsSha256 = digestEntries(appComponents);
  const releaseSha256 = digestEntries([
    { name: "app-components", bytes: 0, sha256: appComponentsSha256 },
    { name: "app-bundle", bytes: 0, sha256: appBundle?.sha256 ?? null },
    ...artifacts,
  ]);

  return {
    schemaVersion: 2,
    complete: missing.length === 0,
    missing,
    appComponents,
    appBundle,
    artifacts,
    appComponentsSha256,
    releaseSha256,
  };
}
