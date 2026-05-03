#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const now = new Date().toISOString();

function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function isFixtureBenchmarkRun(artifact) {
  if (!artifact) {
    return true;
  }

  const values = [
    artifact.runId,
    artifact.build?.version,
    artifact.platform?.device,
  ]
    .filter(Boolean)
    .join(" ");

  return /\b(local|fixture|baseline)\b/i.test(values);
}

function writeText(relativePath, body) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${body.trimEnd()}\n`, "utf8");
}

function parseMatrixSummary() {
  const matrixPath = path.join(repoRoot, "docs/packaged-app-qa-matrix.md");
  const raw = fs.readFileSync(matrixPath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5)
    .filter((cells) => !["Area", "---"].includes(cells[0]))
    .filter((cells) => ["PASS", "FAIL", "BLOCKED", "PENDING"].includes(cells[2]));

  return {
    total: rows.length,
    pass: rows.filter((row) => row[2] === "PASS").length,
    fail: rows.filter((row) => row[2] === "FAIL").length,
    blocked: rows.filter((row) => row[2] === "BLOCKED").length,
    pending: rows.filter((row) => row[2] === "PENDING").length,
  };
}

const localRelease = readJson("artifacts/local-release-macos.json");
const benchmarkBaseline = readJson("docs/evals/benchmark-run-baseline.json");
const benchmarkMacos = readJson("docs/evals/benchmark-run-latest-macos.json");
const benchmarkWindows = readJson("docs/evals/benchmark-run-latest-windows.json");
const benchmarkPackagedMacos = readJson("docs/evals/benchmark-run-packaged-macos.json");
const benchmarkPackagedWindows = readJson("docs/evals/benchmark-run-packaged-windows.json");
const packagedMacosGate = readJson("artifacts/benchmark-gates-packaged-macos.json");
const packagedWindowsGate = readJson("artifacts/benchmark-gates-packaged-windows.json");
const packagedMacosCapture = readJson("artifacts/benchmark-packaged-macos.json");
const packagedWindowsCapture = readJson("artifacts/benchmark-packaged-windows.json");
const appMatrixGate = readJson("artifacts/dictation-app-matrix-gate.json");
const macBenchmarkGates = readJson("artifacts/benchmark-gates-macos.json");
const windowsBenchmarkGates = readJson("artifacts/benchmark-gates-windows.json");
const qaSummary = parseMatrixSummary();
const qaEvidenceBundle = readJson("artifacts/packaged-qa-evidence-bundle.json");
const cloudAsrPreflight = readJson("artifacts/cloud-asr-preflight.json");
const missingCloudSecrets = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MISTRAL_API_KEY"].filter(
  (key) => !process.env[key] || !process.env[key].trim()
);

function isExternalDistributionQaRow(row) {
  if (row.area === "Install" || row.area === "Security" || row.area === "Updates") {
    return true;
  }
  return /notarization|gatekeeper|authenticode|smartscreen|stable channel/i.test(
    `${row.testCase} ${row.evidence}`
  );
}

function summarizeQaRows(rows) {
  const summary = { total: 0, pass: 0, fail: 0, blocked: 0, pending: 0 };
  for (const row of rows) {
    const status = String(row.status ?? "").toLowerCase();
    summary.total += 1;
    if (status in summary) {
      summary[status] += 1;
    }
  }
  return summary;
}

const productQaRows = (qaEvidenceBundle?.rows ?? []).filter(
  (row) => !isExternalDistributionQaRow(row)
);
const externalDistributionQaRows = (qaEvidenceBundle?.rows ?? []).filter(
  isExternalDistributionQaRow
);
const productQaSummary = qaEvidenceBundle?.summary?.product ?? summarizeQaRows(productQaRows);
const externalDistributionQaSummary =
  qaEvidenceBundle?.summary?.externalDistribution ??
  summarizeQaRows(externalDistributionQaRows);

writeText(
  "artifacts/cloud-asr-smoke.blocked.md",
  `# Cloud ASR Smoke Gate (Blocked)

## Command

- Preflight: \`bun run gate:cloud-asr:preflight\`
- Live smoke: \`bun run qa:cloud-asr:smoke\`
- Live output: \`${cloudAsrPreflight?.liveSmokeOutput ?? "artifacts/cloud-asr-smoke.json"}\`
- Live verifier: \`${cloudAsrPreflight?.liveSmokeVerifier ?? "scripts/verify-cloud-asr-smoke.mjs"}\`

Status: BLOCKED
Generated: ${now}

## Secret-Safe Preflight

- Fixture exists: ${cloudAsrPreflight?.fixtureExists ? "yes" : "no"}
- Fixture SHA-256: ${cloudAsrPreflight?.fixtureSha256 ?? "missing"}
- Missing env vars: ${missingCloudSecrets.length > 0 ? missingCloudSecrets.join(", ") : "none"}
- Secret policy: ${cloudAsrPreflight?.secretPolicy ?? "Only key names and boolean presence are recorded. Secret values are never written."}

## Blocking Detail

- Missing required live cloud ASR secrets: ${missingCloudSecrets.join(", ")}

## Required Follow-Up

- Provide \`OPENAI_API_KEY\`, \`ELEVENLABS_API_KEY\`, and \`MISTRAL_API_KEY\` in the environment.
- Run \`bun run qa:cloud-asr:smoke\`.
- Run \`bun run gate:blockers:refresh\` after the live smoke passes.
`
);

writeText(
  "artifacts/benchmark-packaged.blocked.md",
  `# Packaged Dictation Benchmark Evidence (Blocked)

Status: BLOCKED
Generated: ${now}

## Current Local Observation
- \`docs/evals/benchmark-run-baseline.json\` exists, but it is still tagged as a local baseline artifact.
- \`docs/evals/benchmark-run-latest-macos.json\` exists and the local macOS benchmark gate passes.
- \`docs/evals/benchmark-run-latest-windows.json\` exists and the local Windows benchmark gate passes.

## Current Packaged Observation
- \`docs/evals/benchmark-run-packaged-macos.json\` ${benchmarkPackagedMacos ? `exists with run id \`${benchmarkPackagedMacos.runId}\`` : "is missing"}.
- \`artifacts/benchmark-packaged-macos.json\` ${packagedMacosCapture?.pass ? "passes" : "is missing or blocked"}.
- \`artifacts/benchmark-gates-packaged-macos.json\` ${packagedMacosGate?.pass ? "passes" : "is missing or blocked"}.
- \`docs/evals/benchmark-run-packaged-windows.json\` ${benchmarkPackagedWindows ? `exists with run id \`${benchmarkPackagedWindows.runId}\`` : "is missing"}.
- \`artifacts/benchmark-packaged-windows.json\` ${packagedWindowsCapture?.pass ? "passes" : "is missing or blocked"}.
- \`artifacts/benchmark-gates-packaged-windows.json\` ${packagedWindowsGate?.pass ? "passes" : "is missing or blocked"}.

## Blocking Detail
- Baseline artifact run id: \`${benchmarkBaseline?.runId ?? "missing"}\`
- macOS artifact run id: \`${benchmarkMacos?.runId ?? "missing"}\`
- Windows artifact run id: \`${benchmarkWindows?.runId ?? "missing"}\`
- macOS packaged benchmark artifact run id: \`${benchmarkPackagedMacos?.runId ?? "missing"}\`
- Windows packaged benchmark artifact run id: \`${benchmarkPackagedWindows?.runId ?? "missing"}\`
- Launch still requires packaged benchmark evidence on both platforms plus app-matrix validation before dictation parity claims are ship-ready.
- Windows packaged capture command: \`bun run benchmark:dictation:packaged:windows\`.
`
);

const macDmgCheck = localRelease?.checks?.find((check) => check.label === "build-dmg-helper");
const macSpctlCheck = localRelease?.checks?.find((check) => check.label === "spctl-assess");
const macCodesignCheck = localRelease?.checks?.find((check) => check.label === "codesign-verify");
const electronBuildCheck = localRelease?.checks?.find((check) => check.label === "electron-build");

writeText(
  "artifacts/qa/macos/install-fresh-dmg.md",
  `# Install: Fresh install from signed DMG

Status: BLOCKED
Owner: qa-macos
Generated: ${now}

## Current Local Observation
- DMG helper path passes locally and produced \`release/Nautilus-1.0.0-arm64.dmg\`.
- Fresh-install execution was not performed manually from the packaged DMG in this pass.

## Blocking Detail
- Local packaging is using the \`Nautilus Local Dev\` identity, not a release-notarized identity.
- This row still needs a real install walkthrough and evidence capture from the packaged DMG.
`
);

writeText(
  "artifacts/qa/macos/install-upgrade.md",
  `# Install: Upgrade from previous released version

Status: BLOCKED
Owner: qa-macos
Generated: ${now}

## Current Local Observation
- Current packaged DMG exists, but no previous signed release build was installed and upgraded in this pass.

## Blocking Detail
- Upgrade-path verification still requires a real prior signed build, an upgrade install, and retained-data verification.
`
);

writeText(
  "artifacts/qa/macos/security-gatekeeper.md",
  `# Security: Gatekeeper assessment accepted

Status: BLOCKED
Owner: qa-macos
Generated: ${now}

## Current Local Observation
- \`codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app\` passed.
- \`spctl -a -vv release/mac-arm64/Nautilus.app\` still rejects the app with \`origin=Nautilus Local Dev\`.

## Blocking Detail
- Gatekeeper acceptance remains blocked until Apple release signing and notarization are configured and re-tested on the packaged app.
`
);

writeText(
  "artifacts/qa/macos/security-notarization.md",
  `# Security: Notarization ticket validated

Status: BLOCKED
Owner: qa-macos
Generated: ${now}

## Current Local Observation
- Local Electron packaging skipped notarization because notarization options could not be generated in this environment.

## Blocking Detail
- This row requires Apple notarization credentials, a notarized packaged app, and validation of the notarization ticket on the delivered artifact.
`
);

writeText(
  "artifacts/qa/macos/updates-stable-install.md",
  `# Updates: Stable channel check + install

Status: BLOCKED
Owner: qa-macos
Generated: ${now}

## Current Local Observation
- Local packaged artifacts build successfully.
- Local packaged update metadata passes \`bun run qa:packaged:macos:update-metadata\`:
  - \`release/mac-arm64/Nautilus.app/Contents/Resources/app-update.yml\` is present.
  - \`release/latest-mac.yml\` points at the generated macOS ZIP artifact.
  - ZIP SHA-512, size, and blockmap evidence match the manifest.
- No signed update feed or prior installed release candidate was exercised in this pass.

## Blocking Detail
- Stable-channel install validation still requires signed release artifacts and a real update flow test.
`
);

writeText(
  "artifacts/qa/windows/install-fresh-installer.md",
  `# Install: Fresh install from signed installer

Status: BLOCKED
Owner: qa-windows
Generated: ${now}

## Current Local Observation
- Windows release scripts and packaging configuration are present in the repo.
- No Windows host execution occurred in this pass.

## Blocking Detail
- This row still requires a real Windows build host, a signed installer, and a manual fresh-install validation run.
`
);

writeText(
  "artifacts/qa/windows/install-upgrade.md",
  `# Install: Upgrade from previous released version

Status: BLOCKED
Owner: qa-windows
Generated: ${now}

## Current Local Observation
- No Windows upgrade-path execution occurred in this pass.

## Blocking Detail
- This row still requires a prior signed Windows release, an upgraded install, and retained-state verification.
`
);

writeText(
  "artifacts/qa/windows/security-authenticode.md",
  `# Security: Authenticode signature valid

Status: BLOCKED
Owner: qa-windows
Generated: ${now}

## Current Local Observation
- Windows installer signing could not be validated from this macOS host.

## Blocking Detail
- This row still requires a Windows code-signing certificate and Authenticode verification on a Windows-built installer.
`
);

writeText(
  "artifacts/qa/windows/security-smartscreen.md",
  `# Security: SmartScreen publisher display

Status: BLOCKED
Owner: qa-windows
Generated: ${now}

## Current Local Observation
- No Windows SmartScreen validation run occurred in this pass.

## Blocking Detail
- This row still requires a signed Windows installer and a real SmartScreen validation on Windows.
`
);

writeText(
  "artifacts/qa/windows/updates-stable-install.md",
  `# Updates: Stable channel check + install

Status: BLOCKED
Owner: qa-windows
Generated: ${now}

## Current Local Observation
- No Windows updater validation run occurred in this pass.

## Blocking Detail
- This row still requires signed Windows release artifacts and a real stable-channel update install test.
`
);

const blockers = [];

if (missingCloudSecrets.length > 0) {
  blockers.push({
    gate: "cloud-asr-smoke",
    status: "BLOCKED",
    evidence: "artifacts/cloud-asr-smoke.blocked.md",
    reason: `Missing required live cloud ASR secrets: ${missingCloudSecrets.join(", ")}`,
  });
}

if (!macBenchmarkGates?.pass || !windowsBenchmarkGates?.pass) {
  blockers.push({
    gate: "benchmark-gates-local",
    status: "BLOCKED",
    evidence: [
      "artifacts/benchmark-gates-macos.json",
      "artifacts/benchmark-gates-windows.json",
    ],
    reason: "Local benchmark gate artifacts are not fully passing.",
  });
}

const packagedMacosBenchmarkReady =
  Boolean(benchmarkPackagedMacos) &&
  Boolean(packagedMacosCapture?.pass) &&
  Boolean(packagedMacosGate?.pass) &&
  !isFixtureBenchmarkRun(benchmarkPackagedMacos);
const packagedWindowsBenchmarkReady =
  Boolean(benchmarkPackagedWindows) &&
  Boolean(packagedWindowsCapture?.pass) &&
  Boolean(packagedWindowsGate?.pass) &&
  !isFixtureBenchmarkRun(benchmarkPackagedWindows);

if (!packagedMacosBenchmarkReady || !packagedWindowsBenchmarkReady) {
  blockers.push({
    gate: "benchmark-gates-packaged",
    status: "BLOCKED",
    evidence: "artifacts/benchmark-packaged.blocked.md",
    reason: packagedMacosBenchmarkReady
      ? "macOS packaged dictation benchmark evidence is present and passing; Windows packaged benchmark evidence is still missing."
      : "Packaged dictation benchmark evidence is still missing or not passing.",
  });
}

const appMatrixEvidenceViolations = appMatrixGate?.evidenceViolations ?? [];
const appMatrixRejectedInsertionEvidence = appMatrixGate?.rejectedInsertionEvidence ?? [];
const appMatrixEvidenceClean =
  appMatrixGate && Array.isArray(appMatrixEvidenceViolations) && appMatrixEvidenceViolations.length === 0;

if (!appMatrixGate?.pass || !appMatrixEvidenceClean) {
  const summary = appMatrixGate?.summary;
  blockers.push({
    gate: "dictation-app-matrix",
    status: "BLOCKED",
    evidence: "artifacts/dictation-app-matrix-gate.json",
    reason: appMatrixEvidenceViolations.length > 0
      ? `Frozen app matrix has ${appMatrixEvidenceViolations.length} invalid insertion evidence artifact(s).`
      : summary
        ? `Frozen app matrix is not launch-ready: ${summary.ready}/${summary.total} ready, ${summary.pending} pending, ${summary.missingPackagedEvidence} missing packaged benchmark evidence, ${summary.missingInsertionEvidence} missing insertion evidence, ${summary.openBlockedEntries} open blocked-app entries, ${appMatrixRejectedInsertionEvidence.length} rejected insertion evidence artifacts.`
        : "Frozen app matrix gate artifact is missing or not passing.",
  });
}

if (macSpctlCheck && macSpctlCheck.expectedFailure) {
  blockers.push({
    gate: "apple-release-signing",
    status: "BLOCKED",
    evidence: "artifacts/qa/macos/security-gatekeeper.md",
    reason: "Gatekeeper still rejects the local dev-signed app; release signing and notarization are not configured.",
  });
}

blockers.push({
  gate: "windows-release-signing",
  status: "BLOCKED",
  evidence: "artifacts/qa/windows/security-authenticode.md",
  reason: "Windows signing and SmartScreen validation have not been executed from a Windows release host.",
});

if (productQaSummary.pass < productQaSummary.total) {
  blockers.push({
    gate: "packaged-qa-matrix",
    status: "BLOCKED",
    evidence: "artifacts/packaged-qa-evidence-bundle.json",
    reason: `Non-external packaged QA remains ${productQaSummary.blocked} BLOCKED / ${productQaSummary.pass} PASS. External distribution QA remains ${externalDistributionQaSummary.blocked} BLOCKED / ${externalDistributionQaSummary.pass} PASS and is tracked separately.`,
  });
}

const report = {
  generatedAt: now,
  strictReady: blockers.length === 0,
  blockers,
  observations: {
    localReleasePass: Boolean(localRelease?.pass),
    localBenchmarkGatesPass: Boolean(macBenchmarkGates?.pass) && Boolean(windowsBenchmarkGates?.pass),
    packagedBenchmarkEvidenceReady:
      packagedMacosBenchmarkReady && packagedWindowsBenchmarkReady,
    packagedMacosBenchmarkReady,
    packagedWindowsBenchmarkReady,
    qaSummary,
    productQaSummary,
    externalDistributionQaSummary,
    qaEvidenceSummary: {
      missingEvidence: qaEvidenceBundle?.summary?.missingEvidence ?? null,
      mismatchedEvidenceStatus: qaEvidenceBundle?.summary?.mismatchedEvidenceStatus ?? null,
    },
    codesignVerified: Boolean(macCodesignCheck?.passed),
    electronBuildPassed: Boolean(electronBuildCheck?.passed),
    dmgHelperPassed: Boolean(macDmgCheck?.passed),
    localSizeGate: localRelease?.observations?.sizeGate ?? null,
  },
};

writeText("artifacts/release-blockers.json", JSON.stringify(report, null, 2));
