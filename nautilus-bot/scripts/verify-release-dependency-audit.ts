#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

export interface BraceExpansionLockEntry {
  key: string;
  version: string;
}

export interface DependencyAdvisory {
  id: number;
  url: string;
  severity?: string;
}

export interface ReleaseDependencyAuditReport {
  pass: boolean;
  checks: {
    auditCompleted: boolean;
    noUnexpectedAdvisories: boolean;
    auditMatchesInstalledState: boolean;
    rootBraceExpansionPatched: boolean;
    affectedCopiesLimitedToReviewedBuildTree: boolean;
    affectedCopiesExcludedFromPackagedApp: boolean;
  };
  acceptedException: boolean;
  advisory: null;
  counts: {
    advisories: number;
    unexpectedAdvisories: number;
    affectedLockEntries: number;
    unexpectedAffectedLockEntries: number;
    packagedExcludedModules: number;
  };
  affectedLockEntries: BraceExpansionLockEntry[];
  unexpectedAffectedLockEntries: BraceExpansionLockEntry[];
  packagedExcludedModules: string[];
}

interface PackageIdentity {
  name: string;
  version: string;
}

export interface PackagedDependencyEntry {
  path: string;
  packaged: PackageIdentity;
  installed: PackageIdentity | PackageIdentity[] | null;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const excludedPackagedModules = [
  "@electron/asar",
  "@electron/universal",
  "brace-expansion",
  "electron-builder",
  "glob",
  "minimatch",
];

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

export function parseBraceExpansionLockEntries(
  lockText: string,
): BraceExpansionLockEntry[] {
  const entries: BraceExpansionLockEntry[] = [];
  const matcher =
    /^[ \t]*"([^"]*brace-expansion[^"]*)": \["brace-expansion@([^"]+)"/gm;
  for (const match of lockText.matchAll(matcher)) {
    entries.push({ key: match[1], version: match[2] });
  }
  return entries;
}

function isAffectedBraceExpansionVersion(version: string): boolean {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [major, minor, patch] = parts;
  if (major === 1) return minor < 1 || (minor === 1 && patch < 21);
  if (major === 2) return minor < 1 || (minor === 1 && patch < 7);
  if (major === 3) return minor === 0 && patch < 8;
  if (major === 4) return true;
  if (major === 5) return minor === 0 && patch < 12;
  return major < 1;
}

function packagedModuleForEntry(entry: string): string | null {
  const normalized = entry.replaceAll("\\", "/");
  for (const moduleName of excludedPackagedModules) {
    if (
      normalized.includes(`/node_modules/${moduleName}/`) ||
      normalized.endsWith(`/node_modules/${moduleName}`)
    ) {
      return moduleName;
    }
  }
  return null;
}

export function evaluateReleaseDependencyAudit({
  audit,
  lockEntries,
  packagedEntries,
}: {
  audit: Record<string, DependencyAdvisory[]>;
  lockEntries: BraceExpansionLockEntry[];
  packagedEntries: string[];
}): ReleaseDependencyAuditReport {
  validateAuditShape(audit);
  const advisoryEntries = Object.entries(audit).flatMap(
    ([packageName, advisories]) =>
      advisories.map((advisory) => ({ packageName, ...advisory })),
  );
  const unexpectedAdvisories = advisoryEntries;

  const affectedLockEntries = lockEntries.filter((entry) =>
    isAffectedBraceExpansionVersion(entry.version),
  );
  const unexpectedAffectedLockEntries = affectedLockEntries;
  const rootEntry = lockEntries.find((entry) => entry.key === "brace-expansion");
  const rootEntryPatched =
    !rootEntry || !isAffectedBraceExpansionVersion(rootEntry.version);
  const auditMatchesInstalledState =
    affectedLockEntries.length === 0 && advisoryEntries.length === 0;

  const packagedExcludedModules = [
    ...new Set(
      packagedEntries
        .map(packagedModuleForEntry)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();

  const checks = {
    auditCompleted: audit && typeof audit === "object",
    noUnexpectedAdvisories: unexpectedAdvisories.length === 0,
    auditMatchesInstalledState,
    rootBraceExpansionPatched: rootEntryPatched,
    affectedCopiesLimitedToReviewedBuildTree:
      unexpectedAffectedLockEntries.length === 0,
    affectedCopiesExcludedFromPackagedApp:
      packagedExcludedModules.length === 0,
  };

  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    acceptedException: false,
    advisory: null,
    counts: {
      advisories: advisoryEntries.length,
      unexpectedAdvisories: unexpectedAdvisories.length,
      affectedLockEntries: affectedLockEntries.length,
      unexpectedAffectedLockEntries: unexpectedAffectedLockEntries.length,
      packagedExcludedModules: packagedExcludedModules.length,
    },
    affectedLockEntries,
    unexpectedAffectedLockEntries,
    packagedExcludedModules,
  };
}

function validateAuditShape(
  audit: unknown,
): asserts audit is Record<string, DependencyAdvisory[]> {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)
      || Object.values(audit).some((items) => !Array.isArray(items)
        || items.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) {
    throw new Error("Dependency audit output must be an object of advisory arrays.");
  }
}

function parseAuditOutput(output: string): unknown {
  const firstBrace = output.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("bun audit did not return a JSON object.");
  }
  return JSON.parse(output.slice(firstBrace));
}

export function parseReleaseDependencyAuditResult(result: {
  status: number | null;
  stdout: string;
  signal?: string | null;
  error?: unknown;
}): Record<string, DependencyAdvisory[]> {
  if (result.error || result.signal || ![0, 1].includes(result.status as number)) {
    throw new Error("Dependency audit did not complete successfully.");
  }
  const audit = parseAuditOutput(result.stdout);
  validateAuditShape(audit);
  if (result.status !== 0 && Object.values(audit).every((items) => items.length === 0)) {
    throw new Error("Dependency audit failed without a valid advisory report.");
  }
  return audit;
}

function listPackagedEntries(appPath: string): string[] {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged ASAR is missing at ${asarPath}`);
  }

  const entries = listPackage(asarPath, { isPack: false });
  const unpackedPath = `${asarPath}.unpacked`;
  if (fs.existsSync(unpackedPath)) {
    entries.push(
      ...fs
        .readdirSync(unpackedPath, { recursive: true })
        .map((entry) => `app.asar.unpacked/${String(entry)}`),
    );
  }
  return entries;
}

export function comparePackagedDependencyVersions(entries: PackagedDependencyEntry[]): {
  checked: number;
  mismatches: PackagedDependencyEntry[];
} {
  return {
    checked: entries.length,
    mismatches: entries.filter(({ packaged, installed }) => {
      const candidates = Array.isArray(installed) ? installed : installed ? [installed] : [];
      return !candidates.some((candidate) => packaged.name === candidate.name && packaged.version === candidate.version);
    }),
  };
}

function installedLockedVersions(): Map<string, PackageIdentity[]> {
  const locked = new Set<string>();
  const lock = fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8");
  for (const match of lock.matchAll(/^[ \t]*"[^"]+": \["([^"]+)"/gm)) {
    const separator = match[1].lastIndexOf("@");
    if (separator > 0) locked.add(`${match[1].slice(0, separator)}@${match[1].slice(separator + 1)}`);
  }
  const versions = new Map<string, PackageIdentity[]>();
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith(".")) continue;
      const packageDirs = entry.startsWith("@")
        ? fs.readdirSync(path.join(directory, entry)).map((name) => path.join(directory, entry, name))
        : [path.join(directory, entry)];
      for (const packageDir of packageDirs) {
        if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) continue;
        const real = fs.realpathSync(packageDir);
        if (seen.has(real)) continue;
        seen.add(real);
        const manifest = path.join(real, "package.json");
        if (fs.existsSync(manifest)) {
          // Only a name and version that bun.lock records are kept, so both are strings.
          const { name, version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as PackageIdentity;
          if (locked.has(`${name}@${version}`)) {
            const candidates = versions.get(name) ?? [];
            if (!candidates.some((candidate) => candidate.version === version)) candidates.push({ name, version });
            versions.set(name, candidates);
          }
        }
        visit(path.join(real, "node_modules"));
      }
    }
  };
  visit(path.join(repoRoot, "node_modules"));
  return versions;
}

function verifyPackagedDependencyVersions(
  appPath: string,
  packagedEntries: string[],
): { checked: number; mismatches: PackagedDependencyEntry[] } {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const installedVersions = installedLockedVersions();
  const packagePaths = [...new Set(packagedEntries.filter((entry) =>
    /^\/node_modules\/(?:@[^/]+\/)?[^/]+\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*package\.json$/.test(entry),
  ))];
  return comparePackagedDependencyVersions(packagePaths.map((entry) => {
    const relative = entry.slice(1);
    const packaged = JSON.parse(extractFile(asarPath, relative).toString("utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof packaged.name !== "string" || typeof packaged.version !== "string") {
      throw new Error(`Packaged dependency manifest is incomplete: ${entry}`);
    }
    return { path: relative, packaged: { name: packaged.name, version: packaged.version },
      installed: installedVersions.get(packaged.name) ?? [] };
  }));
}

function main() {
  const appPath = path.resolve(
    repoRoot,
    valueFor("--app", "release/mac-arm64/Plainsong.app"),
  );
  const auditResult = spawnSync("bun", ["audit", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const audit = parseReleaseDependencyAuditResult(auditResult);
  const lockEntries = parseBraceExpansionLockEntries(
    fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8"),
  );
  const packagedEntries = listPackagedEntries(appPath);
  const packagedVersions = verifyPackagedDependencyVersions(appPath, packagedEntries);
  const report: ReleaseDependencyAuditReport & {
    generatedAt: string;
    appPath: string;
    checks: { packagedVersionsMatchInstalled?: boolean };
    counts: { packagedDependencyManifests?: number };
    packagedVersionMismatches?: PackagedDependencyEntry[];
  } = {
    generatedAt: new Date().toISOString(),
    appPath,
    ...evaluateReleaseDependencyAudit({
      audit,
      lockEntries,
      packagedEntries,
    }),
  };
  report.checks.packagedVersionsMatchInstalled = packagedVersions.mismatches.length === 0;
  report.counts.packagedDependencyManifests = packagedVersions.checked;
  report.packagedVersionMismatches = packagedVersions.mismatches;
  report.pass = report.pass && report.checks.packagedVersionsMatchInstalled;

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
