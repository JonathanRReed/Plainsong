#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { updaterTrustReceiptMatches } from "./lib/updater-trust-receipt.ts";
import { parseQaUpdateFeedUrl } from "../electron/qa-update-feed.ts";
import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

if (args.includes("--run-local") || args.includes("--dry-run")) {
  const { runLocalUpdaterJourney } = await import("./lib/local-updater-journey.ts");
  await runLocalUpdaterJourney(args);
  process.exit(0);
}

/** The updater journey record written by the packaged N-to-N+1 run. */
interface UpdaterJourney {
  scope?: unknown;
  feed?: { provider?: unknown; production?: unknown; baseUrl?: string };
  beforeVersion?: unknown;
  afterVersion?: unknown;
  beforeArtifactSha256?: unknown;
  afterArtifactSha256?: unknown;
  observedAt?: string;
  installedThroughUpdater?: unknown;
  installHandoff?: unknown;
  events?: unknown;
  relaunchObserved?: unknown;
  preservation?: {
    settings?: unknown;
    onboarding?: unknown;
    dictationHistory?: unknown;
    meetings?: unknown;
  } | null;
  observations?: {
    settingsSentinel?: unknown;
    onboardingSentinel?: unknown;
    dictationSentinel?: unknown;
    meetingSentinel?: unknown;
  };
}

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

const paths = {
  beforeApp: valueFor("--before-app"),
  afterApp: valueFor("--after-app"),
  beforeArtifact: valueFor("--before-artifact"),
  afterArtifact: valueFor("--after-artifact"),
  journey: valueFor("--journey"),
  beforeTrust: valueFor("--before-trust"),
  afterTrust: valueFor("--after-trust"),
  out: path.resolve(
    repoRoot,
    valueFor("--out", "artifacts/qa/macos/updater-n-to-n-plus-1.json"),
  ),
};

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson<T>(filePath: string | null, label: string, errors: string[]): T | null {
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`${label} is missing.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    errors.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readAppVersion(appPath: string | null, label: string, errors: string[]): string | null {
  if (!appPath) {
    errors.push(`${label} app path is missing.`);
    return null;
  }
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) {
    errors.push(`${label} Info.plist is missing.`);
    return null;
  }

  const plutil = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath],
    { encoding: "utf8" },
  );
  if (plutil.status === 0 && plutil.stdout.trim()) {
    return plutil.stdout.trim();
  }

  const source = fs.readFileSync(plistPath, "utf8");
  const match = source.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
  );
  if (!match) {
    errors.push(`${label} app version is missing from Info.plist.`);
    return null;
  }
  return match[1].trim();
}

function hasOrderedEvents(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  let cursor = 0;
  for (const event of actual) {
    if (event === expected[cursor]) cursor += 1;
  }
  return cursor === expected.length;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Compare SemVer precedence without depending on an undeclared transitive package.
function parseVersion(value: unknown): { core: bigint[]; prerelease: string[] } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

function isForwardVersion(before: string | null, after: string | null): boolean {
  const left = parseVersion(before);
  const right = parseVersion(after);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return right.core[index] > left.core[index];
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length > 0 && right.prerelease.length === 0;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return true;
    if (b === undefined) return false;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(b) > BigInt(a);
    if (aNumeric !== bNumeric) return aNumeric;
    return b > a;
  }
  return false;
}

const expectedBeforeVersion = valueFor("--expected-before-version");
const expectedAfterVersion = valueFor("--expected-after-version");

const errors: string[] = [];
const journey = readJson<UpdaterJourney>(paths.journey, "Updater journey", errors);
const beforeTrust = readJson<unknown>(paths.beforeTrust, "Before trust receipt", errors);
const afterTrust = readJson<unknown>(paths.afterTrust, "After trust receipt", errors);
const beforeVersion = readAppVersion(paths.beforeApp, "Before", errors);
const afterVersion = readAppVersion(paths.afterApp, "After", errors);

for (const [label, filePath] of [
  ["Before artifact", paths.beforeArtifact],
  ["After artifact", paths.afterArtifact],
]) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${label} is missing.`);
  }
}

const beforeArtifactSha256 =
  paths.beforeArtifact && fs.existsSync(paths.beforeArtifact)
    ? sha256(paths.beforeArtifact)
    : null;
const afterArtifactSha256 =
  paths.afterArtifact && fs.existsSync(paths.afterArtifact)
    ? sha256(paths.afterArtifact)
    : null;
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath: paths.afterArtifact
    ? path.dirname(path.resolve(paths.afterArtifact))
    : repoRoot,
  appPath: paths.afterApp ? path.resolve(paths.afterApp) : repoRoot,
});

const requiredEvents = [
  "checking-for-update",
  "update-available",
  "download-progress",
  "update-downloaded",
  journey?.installHandoff === "managed-macos-install-on-quit" ? "app-before-quit" : "before-quit-for-update",
  "relaunch",
];

const checks = {
  noInputErrors: errors.length === 0,
  scopeIsLocalSignedUpdateMechanism:
    journey?.scope === "local-signed-update-mechanism",
  feedIsLocalGeneric:
    journey?.feed?.provider === "generic" &&
    journey?.feed?.production === false &&
    parseQaUpdateFeedUrl(journey?.feed?.baseUrl) !== null,
  productionFeedNotClaimed: journey?.feed?.production === false,
  beforeVersionMatchesExpected: nonEmptyString(expectedBeforeVersion) && beforeVersion === expectedBeforeVersion,
  afterVersionMatchesExpected: nonEmptyString(expectedAfterVersion) && afterVersion === expectedAfterVersion,
  versionTransitionIsForward: isForwardVersion(beforeVersion, afterVersion),
  journeyVersionsMatchApps:
    journey?.beforeVersion === beforeVersion && journey?.afterVersion === afterVersion,
  distinctArtifacts:
    nonEmptyString(beforeArtifactSha256) &&
    nonEmptyString(afterArtifactSha256) &&
    beforeArtifactSha256 !== afterArtifactSha256,
  journeyHashesMatchArtifacts:
    journey?.beforeArtifactSha256 === beforeArtifactSha256 &&
    journey?.afterArtifactSha256 === afterArtifactSha256,
  beforeTrustPasses: updaterTrustReceiptMatches(
    beforeTrust,
    beforeVersion,
    beforeArtifactSha256,
    paths.beforeApp,
    paths.beforeArtifact,
  ),
  afterTrustPasses: updaterTrustReceiptMatches(
    afterTrust,
    afterVersion,
    afterArtifactSha256,
    paths.afterApp,
    paths.afterArtifact,
  ),
  observedAtIsDated:
    nonEmptyString(journey?.observedAt) && Number.isFinite(Date.parse(journey!.observedAt!)),
  installedThroughUpdater: journey?.installedThroughUpdater === true,
  updaterEventsCompleteAndOrdered: hasOrderedEvents(journey?.events, requiredEvents),
  relaunchObserved: journey?.relaunchObserved === true,
  settingsPreserved:
    journey?.preservation?.settings === true &&
    nonEmptyString(journey?.observations?.settingsSentinel),
  onboardingPreserved:
    journey?.preservation?.onboarding === true &&
    nonEmptyString(journey?.observations?.onboardingSentinel),
  dictationHistoryPreserved:
    journey?.preservation?.dictationHistory === true &&
    nonEmptyString(journey?.observations?.dictationSentinel),
  meetingsPreserved:
    journey?.preservation?.meetings === true &&
    nonEmptyString(journey?.observations?.meetingSentinel),
};

const pass = Object.values(checks).every(Boolean);
const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  candidateIdentity,
  pass,
  status: pass ? "PASS" : "BLOCKED",
  scope: journey?.scope ?? null,
  productionFeedProven: false,
  boundary:
    "This receipt proves the signed local N-to-N+1 mechanism only. The client-reachable production feed is a separate release gate.",
  transition: `${beforeVersion ?? "missing"} -> ${afterVersion ?? "missing"}`,
  artifacts: {
    before: {
      version: beforeVersion,
      sha256: beforeArtifactSha256,
      file: paths.beforeArtifact ? path.basename(paths.beforeArtifact) : null,
    },
    after: {
      version: afterVersion,
      sha256: afterArtifactSha256,
      file: paths.afterArtifact ? path.basename(paths.afterArtifact) : null,
    },
  },
  requiredEvents,
  observedEvents: Array.isArray(journey?.events) ? journey!.events : [],
  preservation: journey?.preservation ?? null,
  checks,
  errors,
};

fs.mkdirSync(path.dirname(paths.out), { recursive: true });
fs.writeFileSync(paths.out, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt, null, 2));
process.exit(pass ? 0 : 1);
