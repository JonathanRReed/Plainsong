#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

export function parseBraceExpansionLockEntries(lockText) {
  const entries = [];
  const matcher =
    /^\s{4}"([^"]*brace-expansion[^"]*)": \["brace-expansion@([^"]+)"/gm;
  for (const match of lockText.matchAll(matcher)) {
    entries.push({ key: match[1], version: match[2] });
  }
  return entries;
}

function isAffectedBraceExpansionVersion(version) {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [major, minor, patch] = parts;
  if (major === 1) return minor < 1 || (minor === 1 && patch < 18);
  if (major === 2) return minor < 1 || (minor === 1 && patch < 4);
  if (major === 4) return true;
  if (major === 5) return minor === 0 && patch < 9;
  return major < 1;
}

function packagedModuleForEntry(entry) {
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
}) {
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
    ...new Set(packagedEntries.map(packagedModuleForEntry).filter(Boolean)),
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

function parseAuditOutput(output) {
  const firstBrace = output.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("bun audit did not return a JSON object.");
  }
  return JSON.parse(output.slice(firstBrace));
}

function listPackagedEntries(appPath) {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged ASAR is missing at ${asarPath}`);
  }

  const asarCli = path.join(
    repoRoot,
    "node_modules",
    "@electron",
    "asar",
    "bin",
    "asar.js",
  );
  const listed = spawnSync(process.execPath, [asarCli, "list", asarPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(
      listed.stderr.trim() || "Failed to list packaged ASAR contents.",
    );
  }

  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
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

function main() {
  const appPath = path.resolve(
    repoRoot,
    valueFor("--app", "release/mac-arm64/Plainsong.app"),
  );
  const auditResult = spawnSync("bun", ["audit", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (auditResult.error) throw auditResult.error;

  const audit = parseAuditOutput(auditResult.stdout);
  const lockEntries = parseBraceExpansionLockEntries(
    fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8"),
  );
  const packagedEntries = listPackagedEntries(appPath);
  const report = {
    generatedAt: new Date().toISOString(),
    appPath,
    ...evaluateReleaseDependencyAudit({
      audit,
      lockEntries,
      packagedEntries,
    }),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
