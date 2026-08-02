#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { evaluateComponentEquivalence } from "./lib/macos-component-equivalence.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function requiredPath(name) {
  const value = valueFor(name);
  if (!value) {
    throw new Error(`Missing required argument ${name}`);
  }
  return fs.realpathSync(path.resolve(repoRoot, value));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(value).trimEnd()}\n`, "utf8");
}

function plistValue(appPath, key) {
  const result = spawnSync(
    "/usr/bin/plutil",
    [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not read ${key} from ${appPath}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function componentPaths(appPath) {
  return {
    sidecar: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    shortcutHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    speechHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ),
  };
}

function unsignedSha256(sourcePath, temporaryDirectory, label) {
  const copyPath = path.join(temporaryDirectory, label);
  fs.copyFileSync(sourcePath, copyPath);
  const result = spawnSync("/usr/bin/codesign", ["--remove-signature", copyPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Could not remove the signature from ${label}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return sha256(copyPath);
}

function compareComponents(referenceApp, candidateApp) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "plainsong-component-equivalence-"),
  );
  try {
    const referencePaths = componentPaths(referenceApp);
    const candidatePaths = componentPaths(candidateApp);
    return Object.fromEntries(
      Object.keys(referencePaths).map((name) => {
        const referencePath = referencePaths[name];
        const candidatePath = candidatePaths[name];
        if (!fs.existsSync(referencePath) || !fs.existsSync(candidatePath)) {
          throw new Error(`Missing packaged component ${name}`);
        }
        const referenceUnsignedSha256 = unsignedSha256(
          referencePath,
          temporaryDirectory,
          `reference-${name}`,
        );
        const candidateUnsignedSha256 = unsignedSha256(
          candidatePath,
          temporaryDirectory,
          `candidate-${name}`,
        );
        return [
          name,
          {
            relativePath: path.relative(referenceApp, referencePath),
            referenceRawSha256: sha256(referencePath),
            candidateRawSha256: sha256(candidatePath),
            referenceUnsignedSha256,
            candidateUnsignedSha256,
            unsignedCodeIdentical:
              referenceUnsignedSha256 === candidateUnsignedSha256,
          },
        ];
      }),
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const referenceApp = requiredPath("--reference-app");
const candidateApp = requiredPath("--candidate-app");
const referenceTrustPath = requiredPath("--reference-trust");
const candidateTrustPath = requiredPath("--candidate-trust");
const outPath = path.resolve(
  repoRoot,
  valueFor(
    "--out",
    "artifacts/qa/macos/app-matrix-component-equivalence.json",
  ),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor(
    "--markdown",
    "artifacts/qa/macos/app-matrix-component-equivalence.md",
  ),
);

const referenceTrust = readJson(referenceTrustPath);
const candidateTrust = readJson(candidateTrustPath);
const components = compareComponents(referenceApp, candidateApp);
const evaluation = evaluateComponentEquivalence({
  referenceApp,
  candidateApp,
  referenceTrustPass: referenceTrust.pass,
  candidateTrustPass: candidateTrust.pass,
  sameSigningTeam:
    referenceTrust.identity?.expectedTeam === candidateTrust.identity?.expectedTeam &&
    referenceTrust.identity?.appTeamIdentifier ===
      candidateTrust.identity?.appTeamIdentifier,
  sameBundleIdentifier:
    plistValue(referenceApp, "CFBundleIdentifier") ===
    plistValue(candidateApp, "CFBundleIdentifier"),
  components,
});

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  pass: evaluation.pass,
  scope: "packaged-macos-component-provenance",
  identity: {
    referenceApp,
    candidateApp,
    referenceTrustPath,
    candidateTrustPath,
  },
  checks: evaluation.checks,
  components,
};

writeText(outPath, JSON.stringify(report, null, 2));
writeText(
  markdownPath,
  `# Packaged macOS Component Equivalence

Status: ${report.pass ? "PASS" : "FAIL"}
Generated: ${report.generatedAt}

This receipt compares the trusted packaged binaries after removing only their
code-signature blobs. It permits evidence transfer only for captures that
directly executed the recorded sidecar and only when the reference and exact
candidate trust receipts, signing team, bundle identity, and required unsigned
component hashes all match.

| Component | Unsigned code identical |
| --- | --- |
${Object.entries(components)
  .map(([name, component]) => `| ${name} | ${component.unsignedCodeIdentical ? "yes" : "no"} |`)
  .join("\n")}
`,
);

console.log(
  JSON.stringify({
    pass: report.pass,
    checks: report.checks,
    components: Object.fromEntries(
      Object.entries(report.components).map(([name, component]) => [
        name,
        { unsignedCodeIdentical: component.unsignedCodeIdentical },
      ]),
    ),
  }),
);
process.exit(report.pass ? 0 : 1);
