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

const packPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/launch-unblocker-pack.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/launch-unblocker-pack.md")
);

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function assertFileExists(relativePath, owner, violations) {
  if (!relativePath) {
    violations.push(`${owner} is missing a path.`);
    return;
  }
  if (!fs.existsSync(path.join(repoRoot, relativePath))) {
    violations.push(`${owner} references a missing file: ${relativePath}`);
  }
}

if (!fs.existsSync(packPath)) {
  fail(`Launch unblocker pack JSON not found: ${path.relative(repoRoot, packPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Launch unblocker pack Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const inputTemplatePath = path.join(repoRoot, "docs/launch-inputs.template.env");
const inputTemplate = fs.existsSync(inputTemplatePath)
  ? fs.readFileSync(inputTemplatePath, "utf8")
  : "";
const audit = readJson("artifacts/launch-completion-audit.json");
const launchReport = readJson("artifacts/launch-readiness-report.json");
const cloudPreflight = readJson("artifacts/cloud-asr-preflight.json");
const licensePreflight = readJson("artifacts/qa/macos/licensing-activate-deactivate-live.json");
const releaseCredentialPreflight = readJson("artifacts/release-credential-preflight.json");
const appPreflight = readJson("artifacts/qa/macos/app-matrix-preflight.json");
const appMatrixGate = readJson("artifacts/dictation-app-matrix-gate.json");
const windowsHandoff = readJson("artifacts/windows-packaged-qa-handoff.json");
const qaBundle = readJson("artifacts/packaged-qa-evidence-bundle.json");
const violations = [];

if (pack.status !== (audit.completionReadyExcludingSigningAndPublishing ? "PASS" : "BLOCKED")) {
  violations.push("Pack status does not match completion audit status.");
}
if (
  pack.completionReadyExcludingSigningAndPublishing !==
  Boolean(audit.completionReadyExcludingSigningAndPublishing)
) {
  violations.push("Pack completionReadyExcludingSigningAndPublishing is stale.");
}
if (!markdown.includes(`Status: ${pack.status}`)) {
  violations.push("Markdown status does not match JSON status.");
}

for (const [key, evidencePath] of Object.entries(pack.sourceEvidence ?? {})) {
  if (key === "windowsRunner") {
    assertFileExists(evidencePath, key, violations);
    continue;
  }
  assertFileExists(evidencePath, key, violations);
  if (!markdown.includes(`\`${evidencePath}\``)) {
    violations.push(`Markdown source evidence is missing ${evidencePath}.`);
  }
}

const expectedIncomplete = (audit.incomplete ?? []).map((item) => item.id).sort();
const actualIncomplete = [
  ...(pack.blockers?.incompleteChecklistItems ?? []),
].sort();
if (JSON.stringify(actualIncomplete) !== JSON.stringify(expectedIncomplete)) {
  violations.push("Incomplete checklist item list does not match completion audit.");
}

const expectedActiveBlockers = (launchReport.blockers ?? []).map((blocker) => blocker.gate).sort();
const actualActiveBlockers = [
  ...(pack.blockers?.activeProductBlockers ?? []),
].sort();
if (JSON.stringify(actualActiveBlockers) !== JSON.stringify(expectedActiveBlockers)) {
  violations.push("Active product blockers do not match launch readiness report.");
}
for (const blocker of expectedActiveBlockers) {
  if (!markdown.includes(`\`${blocker}\``)) {
    violations.push(`Markdown active blocker list is missing ${blocker}.`);
  }
}

const expectedExternalBlockers = (launchReport.externalBlockers ?? [])
  .map((blocker) => blocker.gate)
  .sort();
const actualExternalBlockers = [
  ...(pack.blockers?.externalSigningAndPublishingBlockers ?? []),
].sort();
if (JSON.stringify(actualExternalBlockers) !== JSON.stringify(expectedExternalBlockers)) {
  violations.push("External blocker list does not match launch readiness report.");
}

const expectedCloudSecrets = (cloudPreflight.requiredEnv ?? [])
  .map((entry) => `${entry.name}:${Boolean(entry.present)}`)
  .sort();
const actualCloudSecrets = (pack.requiredInputs?.cloudSecrets ?? [])
  .map((entry) => `${entry.name}:${Boolean(entry.present)}`)
  .sort();
if (JSON.stringify(actualCloudSecrets) !== JSON.stringify(expectedCloudSecrets)) {
  violations.push("Cloud secret requirements do not match cloud ASR preflight.");
}
for (const entry of pack.requiredInputs?.cloudSecrets ?? []) {
  if (!markdown.includes(`| ${entry.name} | ${entry.present ? "yes" : "no"} |`)) {
    violations.push(`Markdown cloud secret row is missing ${entry.name}.`);
  }
}

const licenseSecret = pack.requiredInputs?.licenseSecret;
if (licenseSecret?.name !== licensePreflight.requiredEnv) {
  violations.push("License secret name does not match license preflight.");
}
if (Boolean(licenseSecret?.present) !== Boolean(licensePreflight.requiredEnvPresent)) {
  violations.push("License secret presence does not match license preflight.");
}
if (
  !markdown.includes(
    `| ${licensePreflight.requiredEnv} | ${licensePreflight.requiredEnvPresent ? "yes" : "no"} |`
  )
) {
  violations.push("Markdown license secret row is missing or stale.");
}

const releaseCredentials = pack.requiredInputs?.releaseCredentials;
if (!releaseCredentials) {
  violations.push("Pack is missing release credential preflight summary.");
} else {
  if (releaseCredentials.status !== releaseCredentialPreflight.status) {
    violations.push("Release credential status does not match preflight artifact.");
  }
  if (Boolean(releaseCredentials.macOSReady) !== Boolean(releaseCredentialPreflight.macOS?.ready)) {
    violations.push("macOS release credential readiness does not match preflight artifact.");
  }
  if (Boolean(releaseCredentials.windowsReady) !== Boolean(releaseCredentialPreflight.windows?.ready)) {
    violations.push("Windows release credential readiness does not match preflight artifact.");
  }
  if (Boolean(releaseCredentials.publishReady) !== Boolean(releaseCredentialPreflight.publish?.ready)) {
    violations.push("Publishing credential readiness does not match preflight artifact.");
  }
  const expectedRows = [
    `macOS signing and notarization:${Boolean(releaseCredentialPreflight.macOS?.ready)}`,
    `Windows signing:${Boolean(releaseCredentialPreflight.windows?.ready)}`,
    `Draft publishing token:${Boolean(releaseCredentialPreflight.publish?.ready)}`,
  ].sort();
  const actualRows = (releaseCredentials.rows ?? [])
    .map((row) => `${row.area}:${Boolean(row.ready)}`)
    .sort();
  if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) {
    violations.push("Release credential rows do not match preflight artifact.");
  }
  for (const row of releaseCredentials.rows ?? []) {
    if (row.artifact !== "artifacts/release-credential-preflight.md") {
      violations.push(`Release credential row ${row.area} points to the wrong artifact.`);
    }
    if (!markdown.includes(`| ${row.area} | ${row.ready ? "yes" : "no"} |`)) {
      violations.push(`Markdown release credential row is missing ${row.area}.`);
    }
  }
  if (!markdown.includes(`Overall status: ${releaseCredentialPreflight.status}`)) {
    violations.push("Markdown release credential status is missing or stale.");
  }
}

const packQaSummary = pack.requiredInputs?.qaSummary;
if (!packQaSummary) {
  violations.push("Pack is missing packaged QA summary.");
} else {
  const expectedQaSummary = {
    total: qaBundle.summary?.total,
    missingEvidence: qaBundle.summary?.missingEvidence,
    mismatchedEvidenceStatus: qaBundle.summary?.mismatchedEvidenceStatus,
    missingPlatform: qaBundle.summary?.missingPlatform,
  };
  for (const [key, value] of Object.entries(expectedQaSummary)) {
    if (packQaSummary[key] !== value) {
      violations.push(`Pack QA summary ${key} is ${packQaSummary[key]}, expected ${value}.`);
    }
  }
  for (const platform of ["macOS", "Windows"]) {
    const expected = qaBundle.summary?.byPlatform?.[platform] ?? {};
    const actual = packQaSummary.byPlatform?.[platform] ?? {};
    for (const key of ["total", "pass", "fail", "blocked", "pending"]) {
      if (actual[key] !== expected[key]) {
        violations.push(`Pack QA summary ${platform} ${key} is ${actual[key]}, expected ${expected[key]}.`);
      }
    }
  }
  const macosLine = `- macOS packaged QA: ${qaBundle.summary?.byPlatform?.macOS?.pass ?? 0} PASS / ${qaBundle.summary?.byPlatform?.macOS?.blocked ?? 0} BLOCKED / ${qaBundle.summary?.byPlatform?.macOS?.pending ?? 0} PENDING`;
  const windowsLine = `- Windows packaged QA: ${qaBundle.summary?.byPlatform?.Windows?.pass ?? 0} PASS / ${qaBundle.summary?.byPlatform?.Windows?.blocked ?? 0} BLOCKED / ${qaBundle.summary?.byPlatform?.Windows?.pending ?? 0} PENDING`;
  const integrityLine = `- Evidence integrity: ${qaBundle.summary?.missingEvidence ?? "unknown"} missing files, ${qaBundle.summary?.mismatchedEvidenceStatus ?? "unknown"} mismatched statuses, ${qaBundle.summary?.missingPlatform ?? "unknown"} missing platforms`;
  for (const line of [macosLine, windowsLine, integrityLine]) {
    if (!markdown.includes(line)) {
      violations.push(`Markdown QA summary line is missing or stale: ${line}`);
    }
  }
}

const expectedScratchApps = (appPreflight.rows ?? [])
  .filter((row) => row.status === "PENDING" && row.canAttemptManualCapture)
  .map((row) => row.app)
  .sort();
const actualScratchApps = (pack.requiredInputs?.macosScratchTargets ?? [])
  .map((row) => row.app)
  .sort();
if (JSON.stringify(actualScratchApps) !== JSON.stringify(expectedScratchApps)) {
  violations.push("macOS scratch-target list does not match app-matrix preflight.");
}
for (const target of pack.requiredInputs?.macosScratchTargets ?? []) {
  if (!target.command.includes("--scratch-target")) {
    violations.push(`macOS scratch target command is missing --scratch-target for ${target.app}.`);
  }
  if (!target.scratchTargetEnv) {
    violations.push(`macOS scratch target is missing scratchTargetEnv for ${target.app}.`);
  }
  if (target.command.includes("DISPOSABLE QA TARGET") || target.command.includes("QA scratch note")) {
    violations.push(`macOS scratch target command still contains a placeholder for ${target.app}.`);
  }
  if (!target.command.includes(`$${target.scratchTargetEnv}`)) {
    violations.push(`macOS scratch target command does not use ${target.scratchTargetEnv} for ${target.app}.`);
  }
  if (!markdown.includes(target.app)) {
    violations.push(`Markdown macOS scratch target is missing ${target.app}.`);
  }
  if (!markdown.includes(`\`${target.scratchTargetEnv}\``)) {
    violations.push(`Markdown macOS scratch target env var is missing ${target.scratchTargetEnv}.`);
  }
  if (!inputTemplate.includes(`${target.scratchTargetEnv}=`)) {
    violations.push(`Input template is missing ${target.scratchTargetEnv}.`);
  }
}

const preflightRowsByApp = new Map(
  (appPreflight.rows ?? []).map((row) => [
    String(row.app ?? "")
      .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
      .trim()
      .toLowerCase(),
    row,
  ])
);
const expectedMacosAppMatrixRows = (appMatrixGate.rows ?? [])
  .filter((row) => row.platform === "macOS" && !row.launchReady)
  .map((row) => {
    const key = String(row.app ?? "")
      .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
      .trim()
      .toLowerCase();
    const preflightRow = preflightRowsByApp.get(key);
    return `${row.app}:${row.status}:${Boolean(preflightRow?.appInstalled)}:${(row.openBlockedEntries ?? []).join(",")}`;
  })
  .sort();
const actualMacosAppMatrixRows = (pack.requiredInputs?.macosAppMatrixRows ?? [])
  .map((row) => `${row.app}:${row.status}:${Boolean(row.installed)}:${(row.openBlockedEntries ?? []).join(",")}`)
  .sort();
if (JSON.stringify(actualMacosAppMatrixRows) !== JSON.stringify(expectedMacosAppMatrixRows)) {
  violations.push("macOS app-matrix remainder list does not match preflight.");
}
for (const row of pack.requiredInputs?.macosAppMatrixRows ?? []) {
  if (!row.requiredAction) {
    violations.push(`macOS app-matrix row is missing requiredAction for ${row.app}.`);
  }
  if (row.canAttemptManualCapture && !row.captureCommand?.includes("--scratch-target")) {
    violations.push(`macOS app-matrix capture command is missing --scratch-target for ${row.app}.`);
  }
  if (row.canAttemptManualCapture && row.captureCommand?.includes("DISPOSABLE QA TARGET")) {
    violations.push(`macOS app-matrix capture command still contains a placeholder for ${row.app}.`);
  }
  if (row.canAttemptManualCapture && !row.captureCommand?.includes(`$${row.scratchTargetEnv}`)) {
    violations.push(`macOS app-matrix capture command does not use ${row.scratchTargetEnv} for ${row.app}.`);
  }
  if (!markdown.includes(`| ${row.app} | ${row.status} |`)) {
    violations.push(`Markdown macOS app-matrix row is missing ${row.app}.`);
  }
}

const expectedRejectedMacosEvidence = (appMatrixGate.rejectedInsertionEvidence ?? [])
  .filter((artifact) => String(artifact.path ?? "").startsWith("artifacts/qa/macos/"))
  .map(
    (artifact) =>
      `${artifact.path}:${artifact.targetApp ?? ""}:${artifact.status ?? ""}:${artifact.pass === true ? "true" : "false"}`
  )
  .sort();
const actualRejectedMacosEvidence = (pack.requiredInputs?.rejectedMacosInsertionEvidence ?? [])
  .map(
    (artifact) =>
      `${artifact.path}:${artifact.targetApp ?? ""}:${artifact.status ?? ""}:${artifact.pass === true ? "true" : "false"}`
  )
  .sort();
if (JSON.stringify(actualRejectedMacosEvidence) !== JSON.stringify(expectedRejectedMacosEvidence)) {
  violations.push("Rejected macOS insertion evidence list does not match app-matrix gate.");
}
for (const artifact of pack.requiredInputs?.rejectedMacosInsertionEvidence ?? []) {
  assertFileExists(artifact.path, "rejectedMacosInsertionEvidence", violations);
  if (!artifact.reason) {
    violations.push(`Rejected macOS insertion evidence is missing a reason for ${artifact.path}.`);
  }
  if (!artifact.requiredAction) {
    violations.push(`Rejected macOS insertion evidence is missing requiredAction for ${artifact.path}.`);
  }
  if (!markdown.includes(`\`${artifact.path}\``)) {
    violations.push(`Markdown rejected macOS insertion evidence is missing ${artifact.path}.`);
  }
}

const expectedWindowsProductRows = (windowsHandoff.rows ?? [])
  .filter((row) => row.launchBlockingProductRow && row.status !== "PASS")
  .map((row) => `${row.area}:${row.testCase}:${row.evidence}`)
  .sort();
const actualWindowsProductRows = (pack.requiredInputs?.windows?.blockedProductRows ?? [])
  .map((row) => `${row.area}:${row.testCase}:${row.evidence}`)
  .sort();
if (JSON.stringify(actualWindowsProductRows) !== JSON.stringify(expectedWindowsProductRows)) {
  violations.push("Windows product row list does not match Windows handoff.");
}

for (const artifact of windowsHandoff.requiredReturnArtifacts ?? []) {
  if (!pack.requiredInputs?.windows?.requiredReturnArtifacts?.includes(artifact)) {
    violations.push(`Windows required return artifact is missing from pack: ${artifact}`);
  }
  if (!markdown.includes(`\`${artifact}\``)) {
    violations.push(`Markdown Windows return artifact is missing ${artifact}.`);
  }
}

const requiredCommands = [
  "bun run gate:cloud-asr:preflight",
  "bun run qa:cloud-asr:smoke",
  "bun run gate:license-live:preflight",
  "bun run qa:packaged:macos:license-live",
  "bun run gate:release-credentials:preflight",
  "bun run gate:blockers:refresh",
  "bun run gate:completion-audit",
];
for (const command of requiredCommands) {
  if (!pack.afterInputsCommands?.includes(command)) {
    violations.push(`Pack after-input command is missing: ${command}`);
  }
  if (!markdown.includes(`\`${command}\``)) {
    violations.push(`Markdown after-input command is missing: ${command}`);
  }
}

if (!/Secret values and license values must never be written/.test(pack.secretPolicy ?? "")) {
  violations.push("Secret policy is missing the no-secret-values guarantee.");
}
if (!markdown.includes(pack.secretPolicy)) {
  violations.push("Markdown secret policy does not match JSON.");
}

if (!inputTemplate) {
  violations.push("Launch input template is missing.");
} else {
  const requiredTemplateComments = [
    "Keep this checked-in template blank. Put real values only in an untracked local file.",
    "Live cloud ASR smoke credentials. Required for bun run qa:cloud-asr:smoke.",
    "Disposable QA license key. Required for bun run qa:packaged:macos:license-live.",
    "Release signing and publishing inputs. Required for signed release-candidate validation.",
    "Do not use customer, private, production, or real conversation targets.",
  ];
  for (const comment of requiredTemplateComments) {
    if (!inputTemplate.includes(comment)) {
      violations.push(`Input template is missing guidance: ${comment}`);
    }
  }
  for (const entry of pack.requiredInputs?.cloudSecrets ?? []) {
    if (!inputTemplate.includes(`${entry.name}=`)) {
      violations.push(`Input template is missing ${entry.name}.`);
    }
  }
  if (!inputTemplate.includes(`${licenseSecret?.name}=`)) {
    violations.push(`Input template is missing ${licenseSecret?.name}.`);
  }
  const releaseTemplateVars = [
    "CSC_LINK",
    "CSC_NAME",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "WIN_PUBLISHER_NAME",
    "GH_TOKEN",
  ];
  for (const name of releaseTemplateVars) {
    if (!inputTemplate.includes(`${name}=`)) {
      violations.push(`Input template is missing ${name}.`);
    }
  }
  for (const target of pack.requiredInputs?.macosScratchTargets ?? []) {
    if (!inputTemplate.includes(`# ${target.app}: ${target.command}`)) {
      violations.push(`Input template is missing capture command comment for ${target.app}.`);
    }
  }
  for (const command of requiredCommands) {
    if (!inputTemplate.includes(`# ${command}`)) {
      violations.push(`Input template is missing after-input command comment: ${command}`);
    }
  }
  const suspiciousTemplateValues = inputTemplate
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .filter((line) => {
      const [, value = ""] = line.split("=", 2);
      return /(sk-[A-Za-z0-9]|license_[A-Za-z0-9]|[A-Za-z0-9_-]{32,})/.test(value.trim());
    });
  if (suspiciousTemplateValues.length > 0) {
    violations.push("Input template appears to contain a secret-like value.");
  }
}

if (violations.length > 0) {
  fail(`Launch unblocker pack validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Launch unblocker pack validation passed: ${pack.status}, ${actualIncomplete.length} incomplete items.`
);
