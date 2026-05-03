#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Nautilus.app")
);
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/licensing-activate-deactivate-live.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/licensing-activate-deactivate.md")
);
const requiredEnv = "NAUTILUS_QA_LICENSE_KEY";

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

const generatedAt = new Date().toISOString();
const keyPresent = Boolean(process.env[requiredEnv]?.trim());
const appExists = fs.existsSync(appPath);
const sidecarExists = fs.existsSync(sidecarPath) && fs.statSync(sidecarPath).isFile();
const status = keyPresent && sidecarExists ? "READY" : "BLOCKED";
const missing = [
  ...(keyPresent ? [] : [requiredEnv]),
  ...(sidecarExists ? [] : ["packaged sidecar"]),
];

const report = {
  generatedAt,
  appPath,
  sidecarPath,
  status,
  pass: false,
  command: "bun run qa:packaged:macos:license-live",
  requiredEnv,
  requiredEnvPresent: keyPresent,
  appExists,
  sidecarExists,
  missing,
  allowExistingLicenseFlag: "--allow-existing-license",
  secretPolicy: "Only key names and boolean presence are recorded. License values are never written.",
};

writeJson(outPath, report);
writeText(
  markdownPath,
  `# Licensing: License activation/deactivation

Status: BLOCKED
Owner: qa-macos
Generated: ${generatedAt}

## Evidence

- Artifact: \`${path.relative(repoRoot, outPath)}\`
- Command: \`${report.command}\`
- App: \`release/mac-arm64/Nautilus.app\`
- Sidecar: \`release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar\`

## Secret-Safe Preflight

- App exists: ${appExists ? "yes" : "no"}
- Sidecar exists: ${sidecarExists ? "yes" : "no"}
- ${requiredEnv} present: ${keyPresent ? "yes" : "no"}
- Missing prerequisites: ${missing.length > 0 ? missing.join(", ") : "none"}
- Secret policy: ${report.secretPolicy}

## Blocking Detail

- Set \`${requiredEnv}\` to a disposable Lemon Squeezy test key and rerun \`${report.command}\`.
- The live harness refuses to overwrite an existing valid local license unless \`${report.allowExistingLicenseFlag}\` is passed.
- Run \`bun run gate:blockers:refresh\` after the live license capture passes.
`
);

console.log(JSON.stringify(report, null, 2));
