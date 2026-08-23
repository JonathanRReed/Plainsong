#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
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

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, label, errors) {
  if (!filePath || !fs.existsSync(filePath)) {
    errors.push(`${label} is missing.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readAppVersion(appPath, label, errors) {
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

function hasOrderedEvents(actual, expected) {
  if (!Array.isArray(actual)) return false;
  let cursor = 0;
  for (const event of actual) {
    if (event === expected[cursor]) cursor += 1;
  }
  return cursor === expected.length;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function trustReceiptMatches(receipt, version, artifactSha256) {
  return (
    receipt?.pass === true &&
    nonEmptyString(version) &&
    nonEmptyString(artifactSha256) &&
    receipt.packageVersion === version &&
    receipt.artifactSha256 === artifactSha256
  );
}

const errors = [];
const journey = readJson(paths.journey, "Updater journey", errors);
const beforeTrust = readJson(paths.beforeTrust, "Before trust receipt", errors);
const afterTrust = readJson(paths.afterTrust, "After trust receipt", errors);
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
  candidatePath: paths.beforeArtifact
    ? path.dirname(path.resolve(paths.beforeArtifact))
    : repoRoot,
  appPath: paths.beforeApp ? path.resolve(paths.beforeApp) : repoRoot,
});

const requiredEvents = [
  "checking-for-update",
  "update-available",
  "download-progress",
  "update-downloaded",
  "before-quit-for-update",
  "relaunch",
];

const checks = {
  noInputErrors: errors.length === 0,
  scopeIsLocalSignedUpdateMechanism:
    journey?.scope === "local-signed-update-mechanism",
  feedIsLocalGeneric:
    journey?.feed?.provider === "generic" &&
    journey?.feed?.production === false &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(
      journey?.feed?.baseUrl ?? "",
    ),
  productionFeedNotClaimed: journey?.feed?.production === false,
  beforeVersionIsBeta1: beforeVersion === "0.9.0-beta.1",
  afterVersionIsBeta2: afterVersion === "0.9.0-beta.2",
  journeyVersionsMatchApps:
    journey?.beforeVersion === beforeVersion && journey?.afterVersion === afterVersion,
  distinctArtifacts:
    nonEmptyString(beforeArtifactSha256) &&
    nonEmptyString(afterArtifactSha256) &&
    beforeArtifactSha256 !== afterArtifactSha256,
  journeyHashesMatchArtifacts:
    journey?.beforeArtifactSha256 === beforeArtifactSha256 &&
    journey?.afterArtifactSha256 === afterArtifactSha256,
  beforeTrustPasses: trustReceiptMatches(
    beforeTrust,
    beforeVersion,
    beforeArtifactSha256,
  ),
  afterTrustPasses: trustReceiptMatches(
    afterTrust,
    afterVersion,
    afterArtifactSha256,
  ),
  observedAtIsDated:
    nonEmptyString(journey?.observedAt) && Number.isFinite(Date.parse(journey.observedAt)),
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
  observedEvents: Array.isArray(journey?.events) ? journey.events : [],
  preservation: journey?.preservation ?? null,
  checks,
  errors,
};

fs.mkdirSync(path.dirname(paths.out), { recursive: true });
fs.writeFileSync(paths.out, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt, null, 2));
process.exit(pass ? 0 : 1);
