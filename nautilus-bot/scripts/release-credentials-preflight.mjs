#!/usr/bin/env node
// Secret-safe release credential preflight (docs/CODE_SIGNING.md).
// Records only environment variable names, boolean presence, and Developer ID
// identity counts — never certificate contents, passwords, or tokens.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "release-credential-preflight.json");
const markdownPath = path.join(repoRoot, "artifacts", "release-credential-preflight.md");

const ENV_VARS = [
  "CSC_LINK",
  "CSC_NAME",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN_PROFILE",
];

const envPresence = Object.fromEntries(
  ENV_VARS.map((name) => [name, Boolean(process.env[name]?.length)])
);

function countCodesigningIdentities() {
  if (process.platform !== "darwin") {
    return null;
  }
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return 0;
  }
  const match = result.stdout.match(/(\d+)\s+valid identities found/);
  return match ? Number(match[1]) : 0;
}

const codesigningIdentityCount = countCodesigningIdentities();

// electron-builder signs from either a certificate file (CSC_LINK, usually with
// CSC_KEY_PASSWORD) or a keychain identity name (CSC_NAME).
const hasCertificateInput =
  (envPresence.CSC_LINK && envPresence.CSC_KEY_PASSWORD) || envPresence.CSC_NAME;
const hasNotarizationInputs =
  envPresence.APPLE_KEYCHAIN_PROFILE ||
  (envPresence.APPLE_ID && envPresence.APPLE_APP_SPECIFIC_PASSWORD && envPresence.APPLE_TEAM_ID);

const artifact = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  envPresence,
  codesigningIdentityCount,
  hasCertificateInput,
  hasNotarizationInputs,
  ready: Boolean(hasCertificateInput && hasNotarizationInputs),
};

const markdown = `# Release Credential Preflight

Status: ${artifact.ready ? "READY" : "NOT READY"}
Generated: ${artifact.generatedAt}

## Command

\`bun run gate:release-credentials:preflight\`

## Environment variable presence

${ENV_VARS.map((name) => `- ${name}: ${envPresence[name] ? "set" : "missing"}`).join("\n")}

## Result

- Developer ID codesigning identities in keychain: ${codesigningIdentityCount ?? "n/a (not macOS)"}
- Certificate input (CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME): ${hasCertificateInput ? "PASS" : "FAIL"}
- Notarization inputs (APPLE_KEYCHAIN_PROFILE, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID): ${hasNotarizationInputs ? "PASS" : "FAIL"}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
fs.writeFileSync(markdownPath, `${markdown}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ready ? 0 : 1);
