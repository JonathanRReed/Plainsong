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

const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/launch-unblocker-pack.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/launch-unblocker-pack.md")
);
const inputTemplatePath = path.resolve(
  repoRoot,
  valueFor("--input-template", "docs/launch-inputs.template.env")
);

function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function shellQuote(value) {
  return String(value).replaceAll('"', '\\"');
}

function envNameForScratchTarget(app) {
  return `NAUTILUS_QA_SCRATCH_${String(app ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function scratchCommand(app) {
  const envName = envNameForScratchTarget(app);
  return `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "${shellQuote(app)}" --scratch-target "$${envName}"`;
}

const generatedAt = new Date().toISOString();
const audit = readJson("artifacts/launch-completion-audit.json");
const launchReport = readJson("artifacts/launch-readiness-report.json");
const cloudPreflight = readJson("artifacts/cloud-asr-preflight.json");
const licensePreflight = readJson("artifacts/qa/macos/licensing-activate-deactivate-live.json");
const appPreflight = readJson("artifacts/qa/macos/app-matrix-preflight.json");
const appMatrixGate = readJson("artifacts/dictation-app-matrix-gate.json");
const windowsHandoff = readJson("artifacts/windows-packaged-qa-handoff.json");
const qaBundle = readJson("artifacts/packaged-qa-evidence-bundle.json");
const rejectedMacosInsertionEvidence = (appMatrixGate.rejectedInsertionEvidence ?? [])
  .filter((artifact) => String(artifact.path ?? "").startsWith("artifacts/qa/macos/"))
  .map((artifact) => ({
    path: artifact.path,
    targetApp: artifact.targetApp ?? null,
    status: artifact.status ?? null,
    pass: artifact.pass ?? null,
    reason: artifact.reason ?? "No rejection reason recorded.",
    requiredAction:
      "Replace this artifact by rerunning the packaged insertion capture with a real disposable scratch target, or delete it before recapturing.",
  }));

const cloudSecrets = (cloudPreflight.requiredEnv ?? []).map((entry) => ({
  name: entry.name,
  present: Boolean(entry.present),
  required: true,
}));

const licenseSecret = {
  name: licensePreflight.requiredEnv,
  present: Boolean(licensePreflight.requiredEnvPresent),
  required: true,
};

const macosScratchTargets = (appPreflight.rows ?? [])
  .filter((row) => row.status === "PENDING" && row.canAttemptManualCapture)
  .map((row) => ({
    app: row.app,
    installedPaths: row.installedPaths ?? [],
    modeUsed: row.modeUsed,
    packagedScenarioIds: row.packagedScenarioIds ?? [],
    scratchTargetRequired: true,
    scratchTargetEnv: envNameForScratchTarget(row.app),
    command: scratchCommand(row.app),
    safety:
      "Use a disposable document, channel, note, draft, or message target. Do not paste into real customer, private, or production conversations.",
  }));

function normalizeApp(value) {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
}

const preflightRowsByApp = new Map(
  (appPreflight.rows ?? []).map((row) => [normalizeApp(row.app), row])
);

const macosAppMatrixRows = (appMatrixGate.rows ?? [])
  .filter((row) => row.platform === "macOS" && !row.launchReady)
  .map((row) => {
    const preflightRow = preflightRowsByApp.get(normalizeApp(row.app));
    const blockedIds = row.openBlockedEntries ?? [];
    const canAttemptManualCapture = Boolean(preflightRow?.canAttemptManualCapture);
    const captureCommand = canAttemptManualCapture ? scratchCommand(row.app) : null;
    return {
      app: row.app,
      status: row.status,
      modeUsed: row.modeUsed,
      installed: Boolean(preflightRow?.appInstalled),
      installedPaths: preflightRow?.installedPaths ?? [],
      packagedBenchmarkCovered: Boolean(row.packagedEvidenceReady),
      packagedScenarioIds: row.packagedScenarioIds ?? [],
      insertionEvidenceReady: Boolean(row.insertionEvidenceReady),
      openBlockedEntries: blockedIds,
      canAttemptManualCapture,
      scratchTargetEnv: canAttemptManualCapture ? envNameForScratchTarget(row.app) : null,
      requiredAction: blockedIds.length
        ? "Resolve blocked-app register entry before marking launch-ready."
        : canAttemptManualCapture
          ? "Capture packaged insertion evidence in a disposable scratch target."
          : "Install the target app or use the Windows handoff where applicable.",
      captureCommand,
    };
  });

const windowsProductRows = (windowsHandoff.rows ?? [])
  .filter((row) => row.launchBlockingProductRow && row.status !== "PASS")
  .map((row) => ({
    area: row.area,
    testCase: row.testCase,
    status: row.status,
    evidence: row.evidence,
    acceptanceChecks: row.acceptanceChecks ?? [],
  }));

const windowsDistributionRows = (windowsHandoff.rows ?? [])
  .filter((row) => row.distributionOnly && row.status !== "PASS")
  .map((row) => ({
    area: row.area,
    testCase: row.testCase,
    status: row.status,
    evidence: row.evidence,
  }));

const blockerIds = (audit.incomplete ?? []).map((item) => item.id);
const activeBlockers = (launchReport.blockers ?? []).map((blocker) => blocker.gate);
const externalBlockers = (launchReport.externalBlockers ?? []).map((blocker) => blocker.gate);

const pack = {
  generatedAt,
  status: audit.completionReadyExcludingSigningAndPublishing ? "PASS" : "BLOCKED",
  completionReadyExcludingSigningAndPublishing:
    Boolean(audit.completionReadyExcludingSigningAndPublishing),
  sourceEvidence: {
    completionAudit: "artifacts/launch-completion-audit.json",
    launchReadinessReport: "artifacts/launch-readiness-report.json",
    qaBundle: "artifacts/packaged-qa-evidence-bundle.json",
    inputTemplate: "docs/launch-inputs.template.env",
    cloudPreflight: "artifacts/cloud-asr-preflight.json",
    licensePreflight: "artifacts/qa/macos/licensing-activate-deactivate-live.json",
    appMatrixGate: "artifacts/dictation-app-matrix-gate.json",
    macosAppMatrixPreflight: "artifacts/qa/macos/app-matrix-preflight.json",
    windowsHandoff: "artifacts/windows-packaged-qa-handoff.json",
    windowsRunner: windowsHandoff.runnerPath,
  },
  blockers: {
    incompleteChecklistItems: blockerIds,
    activeProductBlockers: activeBlockers,
    externalSigningAndPublishingBlockers: externalBlockers,
  },
  requiredInputs: {
    cloudSecrets,
    licenseSecret,
    qaSummary: {
      total: qaBundle.summary?.total ?? 0,
      byPlatform: qaBundle.summary?.byPlatform ?? {},
      missingEvidence: qaBundle.summary?.missingEvidence ?? null,
      mismatchedEvidenceStatus: qaBundle.summary?.mismatchedEvidenceStatus ?? null,
      missingPlatform: qaBundle.summary?.missingPlatform ?? null,
    },
    macosScratchTargets,
    macosAppMatrixRows,
    rejectedMacosInsertionEvidence,
    windows: {
      hostRequired: true,
      runner: windowsHandoff.runnerPath,
      productOnlyCommand: "pwsh scripts/windows-packaged-qa-runner.ps1 -ProductOnly",
      fullCommand: "pwsh scripts/windows-packaged-qa-runner.ps1",
      benchmarkCommand: windowsHandoff.benchmarkCommand,
      requiredReturnArtifacts: windowsHandoff.requiredReturnArtifacts ?? [],
      blockedProductRows: windowsProductRows,
      blockedDistributionRows: windowsDistributionRows,
    },
  },
  afterInputsCommands: [
    "bun run gate:cloud-asr:preflight",
    "bun run qa:cloud-asr:smoke",
    "bun run gate:license-live:preflight",
    "bun run qa:packaged:macos:license-live",
    "bun run gate:blockers:refresh",
    "bun run gate:completion-audit",
  ],
  secretPolicy:
    "Only required secret names and boolean presence are recorded. Secret values and license values must never be written to repo artifacts.",
};

const cloudLines = cloudSecrets
  .map((entry) => `| ${entry.name} | ${entry.present ? "yes" : "no"} |`)
  .join("\n");

const scratchLines = macosScratchTargets.length
  ? macosScratchTargets
      .map(
        (target) =>
          `| ${target.app} | ${target.modeUsed} | \`${target.scratchTargetEnv}\` | ${target.installedPaths.join(", ")} | \`${target.command}\` |`
      )
      .join("\n")
  : "| none | none | none | none | none |";

const macosAppMatrixLines = macosAppMatrixRows.length
  ? macosAppMatrixRows
      .map((row) => {
        const installed = row.installed ? row.installedPaths.join(", ") || "yes" : "no";
        const blocked = row.openBlockedEntries.length ? row.openBlockedEntries.join(", ") : "none";
        const command = row.captureCommand ? `\`${row.captureCommand}\`` : "not ready";
        return `| ${row.app} | ${row.status} | ${installed} | ${blocked} | ${row.requiredAction} | ${command} |`;
      })
      .join("\n")
  : "| none | PASS | yes | none | none | none |";

const rejectedMacosInsertionLines = rejectedMacosInsertionEvidence.length
  ? rejectedMacosInsertionEvidence
      .map(
        (artifact) =>
          `| ${artifact.targetApp ?? "unknown"} | ${artifact.status ?? "unknown"} | ${artifact.pass === true ? "true" : "false"} | \`${artifact.path}\` | ${artifact.reason} | ${artifact.requiredAction} |`
      )
      .join("\n")
  : "| none | none | none | none | none | none |";

const windowsProductLines = windowsProductRows.length
  ? windowsProductRows
      .map((row) => `| ${row.area} | ${row.testCase} | ${row.status} | \`${row.evidence}\` |`)
      .join("\n")
  : "| none | none | PASS | none |";

const returnArtifactLines = pack.requiredInputs.windows.requiredReturnArtifacts
  .map((artifact) => `- \`${artifact}\``)
  .join("\n");

const afterCommandLines = pack.afterInputsCommands.map((command) => `- \`${command}\``).join("\n");

const inputTemplateLines = [
  "# Launch QA input template",
  "# Fill values in your shell or a local untracked copy. Do not commit real secrets.",
  "# Keep this checked-in template blank. Put real values only in an untracked local file.",
  "",
  "# Live cloud ASR smoke credentials. Required for bun run qa:cloud-asr:smoke.",
  ...cloudSecrets.map((entry) => `${entry.name}=`),
  "",
  "# Disposable QA license key. Required for bun run qa:packaged:macos:license-live.",
  `${licenseSecret.name}=`,
  "",
  "# Disposable scratch targets for macOS app insertion QA.",
  "# Use document, channel, note, draft, or field names that are safe to paste into.",
  "# Do not use customer, private, production, or real conversation targets.",
  ...macosScratchTargets.flatMap((target) => [
    `# ${target.app}: ${target.command}`,
    `${target.scratchTargetEnv}=`,
  ]),
  "",
  "# After filling an untracked copy, run:",
  "# bun run gate:cloud-asr:preflight",
  "# bun run qa:cloud-asr:smoke",
  "# bun run gate:license-live:preflight",
  "# bun run qa:packaged:macos:license-live",
  "# bun run gate:blockers:refresh",
  "# bun run gate:completion-audit",
];

writeJson(outPath, pack);
writeText(inputTemplatePath, inputTemplateLines.join("\n"));
writeText(
  markdownPath,
  `# Launch Unblocker Pack

Status: ${pack.status}
Generated: ${generatedAt}

This pack is generated from the current completion audit and preflight artifacts. It lists only the inputs that still require credentials, safe manual targets, or a Windows release host.

## Source Evidence

- Completion audit: \`${pack.sourceEvidence.completionAudit}\`
- Launch readiness report: \`${pack.sourceEvidence.launchReadinessReport}\`
- QA evidence bundle: \`${pack.sourceEvidence.qaBundle}\`
- Input template: \`${pack.sourceEvidence.inputTemplate}\`
- Cloud preflight: \`${pack.sourceEvidence.cloudPreflight}\`
- License preflight: \`${pack.sourceEvidence.licensePreflight}\`
- App matrix gate: \`${pack.sourceEvidence.appMatrixGate}\`
- macOS app matrix preflight: \`${pack.sourceEvidence.macosAppMatrixPreflight}\`
- Windows handoff: \`${pack.sourceEvidence.windowsHandoff}\`
- Windows runner: \`${pack.sourceEvidence.windowsRunner}\`

## Active Product Blockers

${activeBlockers.map((blocker) => `- \`${blocker}\``).join("\n")}

## External Signing And Publishing Blockers

${externalBlockers.map((blocker) => `- \`${blocker}\``).join("\n")}

## Cloud ASR Secrets

| Env var | Present |
| --- | --- |
${cloudLines}

## License Secret

| Env var | Present |
| --- | --- |
| ${licenseSecret.name} | ${licenseSecret.present ? "yes" : "no"} |

## Packaged QA Summary

- macOS packaged QA: ${pack.requiredInputs.qaSummary.byPlatform.macOS?.pass ?? 0} PASS / ${pack.requiredInputs.qaSummary.byPlatform.macOS?.blocked ?? 0} BLOCKED / ${pack.requiredInputs.qaSummary.byPlatform.macOS?.pending ?? 0} PENDING
- Windows packaged QA: ${pack.requiredInputs.qaSummary.byPlatform.Windows?.pass ?? 0} PASS / ${pack.requiredInputs.qaSummary.byPlatform.Windows?.blocked ?? 0} BLOCKED / ${pack.requiredInputs.qaSummary.byPlatform.Windows?.pending ?? 0} PENDING
- Evidence integrity: ${pack.requiredInputs.qaSummary.missingEvidence ?? "unknown"} missing files, ${pack.requiredInputs.qaSummary.mismatchedEvidenceStatus ?? "unknown"} mismatched statuses, ${pack.requiredInputs.qaSummary.missingPlatform ?? "unknown"} missing platforms

## macOS Safe Scratch Targets

Use these only with disposable scratch targets. Do not paste into real customer, private, or production conversations.

| App | Mode | Env var | Installed path | Command |
| --- | --- | --- | --- | --- |
${scratchLines}

## macOS App Matrix Remaining Rows

This table keeps every unresolved macOS app row visible, including rows that cannot be safely captured yet.

| App | Status | Installed | Blocked entries | Required action | Command |
| --- | --- | --- | --- | --- | --- |
${macosAppMatrixLines}

## Rejected macOS Insertion Evidence

These artifacts are ignored by the app-matrix gate until they are replaced by passing evidence.

| App | Status | Pass | Artifact | Reason | Required action |
| --- | --- | --- | --- | --- | --- |
${rejectedMacosInsertionLines}

## Windows Release Host

- Product-only command: \`${pack.requiredInputs.windows.productOnlyCommand}\`
- Full command: \`${pack.requiredInputs.windows.fullCommand}\`
- Benchmark command: \`${pack.requiredInputs.windows.benchmarkCommand}\`

### Required Return Artifacts

${returnArtifactLines}

### Blocked Product Rows

| Area | Test case | Status | Evidence |
| --- | --- | --- | --- |
${windowsProductLines}

## After Inputs

${afterCommandLines}

## Secret Policy

${pack.secretPolicy}
`
);

console.log(JSON.stringify(pack, null, 2));
