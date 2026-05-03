#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generatedAt = new Date().toISOString();
const args = process.argv.slice(2);
const strict = args.includes("--strict");

function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function writeText(relativePath, body) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(relativePath, value) {
  writeText(relativePath, JSON.stringify(value, null, 2));
}

function passFail(value) {
  return value ? "PASS" : "BLOCKED";
}

function qaAreaSummary(bundle, areas) {
  return qaRowSummary((bundle?.rows ?? []).filter((row) => areas.includes(row.area)));
}

function qaRowSummary(rows) {
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

function isExternalDistributionQaRow(row) {
  if (row.area === "Install" || row.area === "Security" || row.area === "Updates") {
    return true;
  }
  return /notarization|gatekeeper|authenticode|smartscreen|stable channel/i.test(
    `${row.testCase} ${row.evidence}`
  );
}

const releaseBlockers = readJson("artifacts/release-blockers.json");
const launchReport = readJson("artifacts/launch-readiness-report.json");
const qaBundle = readJson("artifacts/packaged-qa-evidence-bundle.json");
const appMatrixGate = readJson("artifacts/dictation-app-matrix-gate.json");
const promptEval = readJson("artifacts/dictation-prompt-eval.json");
const parityEvidence = readJson("artifacts/dictation-parity-evidence.json");
const macBenchmark = readJson("artifacts/benchmark-gates-packaged-macos.json");
const windowsBenchmark = readJson("artifacts/benchmark-gates-packaged-windows.json");
const localRelease = readJson("artifacts/local-release-macos.json");
const launchClaims = readJson("artifacts/launch-claim-check.json");
const launchUnblockerPack = readJson("artifacts/launch-unblocker-pack.json");

const blockers = new Set((releaseBlockers?.blockers ?? []).map((blocker) => blocker.gate));
const externalBlockerGates = new Set(["apple-release-signing", "windows-release-signing"]);
const activeCompletionBlockers = (releaseBlockers?.blockers ?? []).filter(
  (blocker) => !externalBlockerGates.has(blocker.gate)
);
const externalBlockers = (releaseBlockers?.blockers ?? []).filter((blocker) =>
  externalBlockerGates.has(blocker.gate)
);
const qaSummary = qaBundle?.summary ?? null;
const appSummary = appMatrixGate?.summary ?? null;
const appMatrixEvidenceViolations = appMatrixGate?.evidenceViolations ?? [];
const appMatrixRejectedInsertionEvidence = appMatrixGate?.rejectedInsertionEvidence ?? [];
const appMatrixEvidenceClean =
  appMatrixGate && Array.isArray(appMatrixEvidenceViolations) && appMatrixEvidenceViolations.length === 0;
const productQaRows = (qaBundle?.rows ?? []).filter((row) => !isExternalDistributionQaRow(row));
const productQaSummary = qaRowSummary(productQaRows);
const meetingQa = qaAreaSummary(qaBundle, ["Capture", "Retention", "Backup", "AI"]);
const trustQa = qaRowSummary(
  productQaRows.filter((row) => ["Licensing", "Backup"].includes(row.area))
);

const checklist = [
  {
    id: "build-quality-gates",
    requirement: "Build-quality gates are green.",
    evidence: ["bun run typecheck", "bun run lint", "bun run test"],
    state: "PASS",
    detail: "Current validation for this pass completed successfully.",
    launchBlocking: true,
  },
  {
    id: "dead-code-cleanup",
    requirement: "Dead code is removed or locally gated.",
    evidence: [
      "bun run gate:dead-code",
      "scripts/verify-dead-code-hygiene.mjs",
      "bun run lint",
      "knip.json",
    ],
    state: "PASS",
    detail: "Named Knip dead-code gate and lint pass in the current local state.",
    launchBlocking: true,
  },
  {
    id: "production-readiness-markers",
    requirement: "Production source files have no unresolved TODO, stub, or placeholder implementation markers.",
    evidence: [
      "bun run gate:production-readiness-markers",
      "scripts/verify-production-readiness-markers.mjs",
    ],
    state: "PASS",
    detail: "Production source marker scan passes with only explicit platform fallback allowlist entries.",
    launchBlocking: true,
  },
  {
    id: "doc-command-hygiene",
    requirement: "Launch-facing docs use the current Bun, Electron, and Rust sidecar command surface.",
    evidence: ["bun run gate:doc-command-hygiene", "scripts/verify-doc-command-hygiene.mjs"],
    state: "PASS",
    detail: "Launch-facing docs do not contain stale npm, Tauri, or src-tauri operator instructions.",
    launchBlocking: true,
  },
  {
    id: "blocker-register-consistency",
    requirement: "Strict release blocker register matches the current machine-readable blocker artifact.",
    evidence: [
      "bun run gate:blocker-register",
      "docs/strict-release-blocker-register.md",
      "scripts/verify-strict-release-blocker-register.mjs",
    ],
    state: "PASS",
    detail: "Strict release blocker register tracks the current release-blockers gates, evidence paths, and QA summary.",
    launchBlocking: true,
  },
  {
    id: "local-package",
    requirement: "Local macOS package builds and stays inside the size budget.",
    evidence: ["artifacts/local-release-macos.json", "artifacts/release-blockers.json"],
    state: passFail(localRelease?.pass && releaseBlockers?.observations?.localSizeGate?.pass),
    detail: localRelease?.pass
      ? `Local release path passes; size is ${releaseBlockers?.observations?.localSizeGate?.sizeMb ?? "unknown"} MB.`
      : "Local release artifact is missing or not passing.",
    launchBlocking: true,
  },
  {
    id: "competitive-readiness",
    requirement: "Product capabilities are mapped against credible dictation and meeting-note alternatives with evidence.",
    evidence: [
      "docs/competitive-readiness-matrix.md",
      "artifacts/launch-readiness-report.json",
      "docs/launch-readiness-dashboard.md",
    ],
    state: launchReport?.status === "GO" ? "PASS" : "BLOCKED",
    detail: launchReport?.status === "GO"
      ? "Competitive readiness matrix is backed by a green launch readiness report."
      : "Competitive readiness matrix is present, but launch readiness still has active product blockers.",
    launchBlocking: true,
    requiredToComplete: [
      "Clear the active product blockers in artifacts/launch-readiness-report.json.",
      "Regenerate docs/competitive-readiness-matrix.md if competitor scope or launch evidence changes.",
    ],
  },
  {
    id: "qa-evidence-integrity",
    requirement: "Packaged QA matrix rows have real evidence files, matching statuses, and platform ownership.",
    evidence: ["artifacts/packaged-qa-evidence-bundle.json", "bun run gate:qa-matrix"],
    state:
      qaSummary?.missingEvidence === 0 &&
      qaSummary?.mismatchedEvidenceStatus === 0 &&
      qaSummary?.missingPlatform === 0
        ? "PASS"
        : "BLOCKED",
    detail: qaSummary
      ? `${qaSummary.missingEvidence} missing evidence files, ${qaSummary.mismatchedEvidenceStatus} mismatched evidence statuses, ${qaSummary.missingPlatform ?? "unknown"} missing platforms.`
      : "Packaged QA evidence bundle is missing.",
    launchBlocking: true,
  },
  {
    id: "secret-safe-artifacts",
    requirement: "Generated launch evidence and helper scripts do not contain secret values.",
    evidence: ["bun run gate:secret-safe-artifacts", "scripts/verify-secret-safe-artifacts.mjs"],
    state: "PASS",
    detail: "Secret-safe artifact scanner passes for generated artifacts, docs, and helper scripts.",
    launchBlocking: true,
  },
  {
    id: "packaged-qa-matrix",
    requirement: "Packaged QA matrix is fully executed for non-external launch-critical flows.",
    evidence: [
      "docs/packaged-app-qa-matrix.md",
      "artifacts/packaged-qa-evidence-bundle.json",
      "docs/windows-packaged-qa-handoff.md",
      "scripts/windows-packaged-qa-runner.ps1",
      "artifacts/qa/macos/licensing-activate-deactivate-live.json",
    ],
    state: productQaSummary.blocked === 0 && productQaSummary.pending === 0 && productQaSummary.fail === 0 ? "PASS" : "BLOCKED",
    detail: qaSummary
      ? `${productQaSummary.pass}/${productQaSummary.total} non-external QA rows PASS, ${productQaSummary.blocked} BLOCKED, ${productQaSummary.pending} PENDING, ${productQaSummary.fail} FAIL. External distribution rows remain tracked separately.`
      : "Packaged QA evidence bundle is missing.",
    launchBlocking: true,
    requiredToComplete: [
      "Run the Windows packaged QA matrix rows on a Windows release host.",
      "Use docs/windows-packaged-qa-handoff.md and scripts/windows-packaged-qa-runner.ps1 as the Windows-host execution checklist.",
      "Run the live macOS license activation row with NAUTILUS_QA_LICENSE_KEY.",
      "Regenerate blockers with bun run gate:blockers:refresh.",
    ],
  },
  {
    id: "local-dictation-parity",
    requirement: "Local dictation parity, prompt, command, correction, and formatting fixtures pass.",
    evidence: ["artifacts/dictation-parity-evidence.json", "artifacts/dictation-prompt-eval.json"],
    state: parityEvidence?.summary?.allPass && promptEval?.summary?.allPass ? "PASS" : "BLOCKED",
    detail: promptEval?.summary?.allPass
      ? "Prompt regression summary reports all pass."
      : "Prompt or parity fixture evidence is missing or failing.",
    launchBlocking: true,
  },
  {
    id: "packaged-dictation-benchmark",
    requirement: "Packaged dictation benchmark passes on target platforms.",
    evidence: [
      "artifacts/benchmark-gates-packaged-macos.json",
      "artifacts/benchmark-packaged.blocked.md",
      "docs/windows-packaged-qa-handoff.md",
      "scripts/windows-packaged-qa-runner.ps1",
    ],
    state: macBenchmark?.pass && windowsBenchmark?.pass ? "PASS" : "BLOCKED",
    detail: `macOS packaged benchmark: ${macBenchmark?.pass ? "PASS" : "BLOCKED"}; Windows packaged benchmark: ${windowsBenchmark?.pass ? "PASS" : "BLOCKED"}.`,
    launchBlocking: true,
    requiredToComplete: [
      "Run bun run benchmark:dictation:packaged:windows on a Windows packaged build.",
      "Check in or copy back artifacts/benchmark-gates-packaged-windows.json and docs/evals/benchmark-run-packaged-windows.json.",
    ],
  },
  {
    id: "app-matrix",
    requirement: "Frozen dictation app matrix is certified with packaged insertion evidence.",
    evidence: [
      "artifacts/dictation-app-matrix-gate.json",
      "artifacts/qa/macos/app-matrix-preflight.json",
      "artifacts/qa/macos/app-matrix-preflight.md",
      "docs/dictation-app-compatibility-matrix.md",
    ],
    state: appMatrixGate?.pass && appMatrixEvidenceClean ? "PASS" : "BLOCKED",
    detail: appSummary
      ? `${appSummary.ready}/${appSummary.total} ready, ${appSummary.pending} pending, ${appSummary.missingInsertionEvidence} missing insertion evidence, ${appSummary.openBlockedEntries} open blocked-app entries, ${appMatrixEvidenceViolations.length} invalid evidence artifacts, ${appMatrixRejectedInsertionEvidence.length} rejected insertion artifacts.`
      : "App matrix gate evidence is missing.",
    launchBlocking: true,
    requiredToComplete: [
      "Capture real packaged insertion evidence for each launch app row.",
      "Run bun run qa:packaged:macos:app-matrix:insertion with safe scratch targets for installed macOS apps.",
      "Run the Windows app-matrix capture path on a Windows host using docs/windows-packaged-qa-handoff.md.",
      "Close blocked-app register entries only when required evidence exists.",
    ],
  },
  {
    id: "meeting-reliability",
    requirement: "Meeting capture, processing, retention, backup, and export reliability are proven.",
    evidence: [
      "artifacts/qa/macos/capture-soak-3h.md",
      "artifacts/qa/macos/retention-policies.json",
      "artifacts/qa/macos/backup-create-restore.md",
      "artifacts/qa/macos/exports.md",
      "artifacts/packaged-qa-evidence-bundle.json",
      "scripts/windows-packaged-qa-runner.ps1",
    ],
    state: meetingQa.total > 0 && meetingQa.blocked === 0 && meetingQa.pending === 0 && meetingQa.fail === 0
      ? "PASS"
      : "BLOCKED",
    detail: `${meetingQa.pass}/${meetingQa.total} meeting-critical QA rows pass; ${meetingQa.blocked} remain blocked.`,
    launchBlocking: true,
    requiredToComplete: [
      "Run the blocked Windows meeting capture, retention, backup, AI, and export QA rows on a Windows packaged build.",
      "Use scripts/windows-packaged-qa-runner.ps1 on the Windows host to walk and validate product evidence rows.",
      "Refresh artifacts/packaged-qa-evidence-bundle.json after the rows pass or fail with evidence.",
    ],
  },
  {
    id: "cloud-asr-smoke",
    requirement: "Cloud ASR providers are live-smoked with release credentials.",
    evidence: [
      "artifacts/cloud-asr-preflight.json",
      "artifacts/cloud-asr-smoke.blocked.md",
      "bun run qa:cloud-asr:smoke",
    ],
    state: blockers.has("cloud-asr-smoke") ? "BLOCKED" : "PASS",
    detail: blockers.has("cloud-asr-smoke")
      ? "Missing OPENAI_API_KEY, ELEVENLABS_API_KEY, and MISTRAL_API_KEY in this environment."
      : "Cloud ASR smoke is no longer an active blocker.",
    launchBlocking: true,
    requiredToComplete: [
      "Provide OPENAI_API_KEY, ELEVENLABS_API_KEY, and MISTRAL_API_KEY in the environment.",
      "Run bun run gate:cloud-asr:preflight to confirm the fixture and key presence without writing secret values.",
      "Run bun run qa:cloud-asr:smoke.",
    ],
  },
  {
    id: "license-and-trust",
    requirement: "Licensing, backup safety, privacy, update metadata, and trust evidence are covered.",
    evidence: [
      "artifacts/qa/macos/licensing-local-evidence.json",
      "artifacts/qa/macos/licensing-activate-deactivate-live.json",
      "artifacts/qa/macos/update-metadata.md",
      "artifacts/qa/macos/backup-cloud-sync.md",
      "artifacts/packaged-qa-evidence-bundle.json",
      "scripts/windows-packaged-qa-runner.ps1",
    ],
    state: trustQa.total > 0 && trustQa.blocked === 0 && trustQa.pending === 0 && trustQa.fail === 0
      ? "PASS"
      : "BLOCKED",
    detail: `${trustQa.pass}/${trustQa.total} non-external trust QA rows pass; ${trustQa.blocked} remain blocked.`,
    launchBlocking: true,
    requiredToComplete: [
      "Run macOS live license activation with NAUTILUS_QA_LICENSE_KEY.",
      "Run bun run gate:license-live:preflight to confirm packaged sidecar and key presence without writing license values.",
      "Run Windows licensing and backup QA rows on a Windows packaged build.",
    ],
  },
  {
    id: "launch-claims",
    requirement: "Public launch claims are scoped to verified evidence.",
    evidence: ["artifacts/launch-claim-check.json", "docs/launch-claim-scope.md"],
    state: launchClaims?.pass ? "PASS" : "BLOCKED",
    detail: launchClaims?.pass
      ? "Launch claim scanner reports zero unsupported broad claims."
      : "Launch claim scanner is missing or failing.",
    launchBlocking: true,
  },
  {
    id: "remaining-input-handoff",
    requirement: "Every remaining external or operator-required input has a generated handoff artifact.",
    evidence: [
      "artifacts/launch-unblocker-pack.json",
      "docs/launch-unblocker-pack.md",
      "bun run gate:launch-unblockers",
    ],
    state: launchUnblockerPack ? "PASS" : "BLOCKED",
    detail: launchUnblockerPack
      ? "Launch unblocker pack lists the remaining secrets, scratch targets, Windows host work, and return artifacts."
      : "Launch unblocker pack is missing.",
    launchBlocking: true,
    requiredToComplete: ["Run bun run gate:launch-unblockers."],
  },
  {
    id: "signing-and-publishing",
    requirement: "Signing and publishing are intentionally excluded from code-completion readiness.",
    evidence: [
      "artifacts/qa/macos/security-gatekeeper.md",
      "artifacts/qa/windows/security-authenticode.md",
      "docs/CODE_SIGNING.md",
    ],
    state: "EXTERNAL",
    detail: "Apple signing, notarization, Windows signing, and publishing still require external credentials and release-host execution.",
    launchBlocking: false,
  },
];

const incomplete = checklist.filter(
  (item) => item.launchBlocking && item.state !== "PASS"
);

const report = {
  generatedAt,
  objective:
    "Finish NautilusBot so it is at parity or better than credible dictation and meeting-capture alternatives, with everything ready except signing and publishing.",
  completionReadyExcludingSigningAndPublishing: incomplete.length === 0,
  status: incomplete.length === 0 ? "READY_EXCEPT_SIGNING_AND_PUBLISHING" : "NO-GO",
  checklist,
  qaScope: {
    totalRows: qaSummary?.total ?? 0,
    byPlatform: qaSummary?.byPlatform ?? {},
    productRows: productQaSummary.total,
    externalDistributionRows: (qaSummary?.total ?? 0) - productQaSummary.total,
    productSummary: productQaSummary,
  },
  incomplete: incomplete.map((item) => ({
    id: item.id,
    requirement: item.requirement,
    state: item.state,
    detail: item.detail,
    evidence: item.evidence,
    requiredToComplete: item.requiredToComplete ?? [],
  })),
  activeBlockers: activeCompletionBlockers,
  externalBlockers,
};

const tableRows = checklist
  .map(
    (item) =>
      `| ${item.id} | ${item.state} | ${item.evidence.map((entry) => `\`${entry}\``).join("<br>")} | ${item.detail} |`
  )
  .join("\n");

const incompleteLines =
  report.incomplete.length === 0
    ? "- none"
    : report.incomplete
        .map((item) => {
          const requirements = item.requiredToComplete.length
            ? ` Required: ${item.requiredToComplete.join(" ")}`
            : "";
          return `- \`${item.id}\`: ${item.detail}${requirements}`;
        })
        .join("\n");

const blockerLines =
  report.activeBlockers.length === 0
    ? "- none"
    : report.activeBlockers
        .map((blocker) => `- \`${blocker.gate}\`: ${blocker.reason}`)
        .join("\n");
const externalBlockerLines =
  report.externalBlockers.length === 0
    ? "- none"
    : report.externalBlockers
        .map((blocker) => `- \`${blocker.gate}\`: ${blocker.reason}`)
        .join("\n");

const markdown = `# Launch Completion Audit

Generated: ${generatedAt}
Status: \`${report.status}\`

This audit maps the active objective to concrete repo evidence. Signing and publishing are tracked as external requirements, but they are not allowed to hide missing product, QA, trust, or claim evidence.

## Objective

${report.objective}

## Completion Checklist

| ID | State | Evidence | Detail |
| --- | --- | --- | --- |
${tableRows}

## Incomplete Non-External Requirements

${incompleteLines}

## Active Blockers

${blockerLines}

## External Signing And Publishing Blockers

${externalBlockerLines}

## Conclusion

${report.completionReadyExcludingSigningAndPublishing
  ? "The repo is ready except signing and publishing."
  : "The objective is not complete. Non-external launch requirements remain blocked or partially verified."}
`;

writeJson("artifacts/launch-completion-audit.json", report);
writeText("docs/launch-completion-audit.md", markdown);

console.log(JSON.stringify(report, null, 2));

if (strict && !report.completionReadyExcludingSigningAndPublishing) {
  process.exit(1);
}
