#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generatedAt = new Date().toISOString();

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

function parseMarkdownTable(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    return [];
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0)
    .filter((cells) => cells[0] !== "---");
}

function parseAppMatrix() {
  const fullPath = path.join(repoRoot, "docs/dictation-app-compatibility-matrix.md");
  const raw = fs.readFileSync(fullPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const parsed = [];
  let currentPlatform = null;

  for (const line of lines) {
    if (/^##\s+/i.test(line)) {
      currentPlatform = line.replace(/^##\s+/i, "").trim();
      continue;
    }

    if (!line.startsWith("|")) {
      continue;
    }

    const row = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (row.length < 4 || row[0] === "App" || row[0] === "---") {
      continue;
    }

    if (row.length >= 4 && currentPlatform) {
      parsed.push({
        platform: currentPlatform,
        app: row[0],
        status: row[1],
        modeUsed: row[2],
        notes: row[3],
      });
    }
  }

  return parsed;
}

function parseLanguageMatrix() {
  const rows = parseMarkdownTable("docs/evals/dictation-language-certification-matrix.md");
  return rows
    .filter((row) => row.length >= 8)
    .filter((row) => row[0] !== "Code")
    .map((row) => ({
      code: row[0],
      language: row[1],
      tier: row[2],
      localCorpus: row[3],
      dictationProvider: row[4],
      meetingProvider: row[5],
      fallbackProvider: row[6],
      packagedEvidence: row[7],
    }));
}

function qaAreaSummary(bundle, areas) {
  return summarizeQaRows((bundle?.rows ?? []).filter((row) => areas.includes(row.area)));
}

function summarizeQaRows(rows) {
  const summary = { total: 0, pass: 0, fail: 0, blocked: 0, pending: 0 };
  for (const row of rows) {
    const normalized = String(row.status ?? "").toLowerCase();
    summary.total += 1;
    if (normalized in summary) {
      summary[normalized] += 1;
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

function summarizeAppMatrix(rows) {
  const summary = {
    total: rows.length,
    supported: 0,
    partial: 0,
    clipboardOnly: 0,
    unsupported: 0,
    pending: 0,
  };

  for (const row of rows) {
    switch (row.status) {
      case "SUPPORTED":
        summary.supported += 1;
        break;
      case "PARTIAL":
        summary.partial += 1;
        break;
      case "CLIPBOARD_ONLY":
        summary.clipboardOnly += 1;
        break;
      case "UNSUPPORTED":
        summary.unsupported += 1;
        break;
      default:
        summary.pending += 1;
        break;
    }
  }

  return summary;
}

function summarizeAppMatrixGate(gate, fallbackRows) {
  const fallback = summarizeAppMatrix(fallbackRows);
  const rows = gate?.rows ?? [];
  return {
    ...fallback,
    ready: gate?.summary?.ready ?? rows.filter((row) => row.launchReady).length,
    missingPackagedEvidence:
      gate?.summary?.missingPackagedEvidence ??
      rows.filter((row) => !row.packagedEvidenceReady).length,
    missingInsertionEvidence:
      gate?.summary?.missingInsertionEvidence ??
      rows.filter((row) => !row.insertionEvidenceReady).length,
    openBlockedEntries:
      gate?.summary?.openBlockedEntries ??
      new Set(rows.flatMap((row) => row.openBlockedEntries ?? [])).size,
    rejectedInsertionEvidence:
      gate?.summary?.rejectedInsertionEvidence ??
      (Array.isArray(gate?.rejectedInsertionEvidence) ? gate.rejectedInsertionEvidence.length : 0),
  };
}

function summarizeLanguageMatrix(rows) {
  const summary = {
    total: rows.length,
    packagedPass: 0,
    packagedPending: 0,
  };

  for (const row of rows) {
    if (row.packagedEvidence === "PASS") {
      summary.packagedPass += 1;
    } else {
      summary.packagedPending += 1;
    }
  }

  return summary;
}

function areaStatus({ blockers = [], checks = [], summary = null, allowPartial = false }) {
  if (blockers.length > 0) {
    return "BLOCKED";
  }

  if (checks.some((check) => check === false)) {
    return allowPartial ? "PARTIAL" : "BLOCKED";
  }

  if (summary && summary.total > 0 && summary.pass !== summary.total) {
    return allowPartial ? "PARTIAL" : "BLOCKED";
  }

  return "PASS";
}

const releaseBlockers = readJson("artifacts/release-blockers.json");
const qaBundle = readJson("artifacts/packaged-qa-evidence-bundle.json");
const macBenchmarkGate = readJson("artifacts/benchmark-gates-macos.json");
const windowsBenchmarkGate = readJson("artifacts/benchmark-gates-windows.json");
const packagedMacosBenchmarkGate = readJson("artifacts/benchmark-gates-packaged-macos.json");
const packagedWindowsBenchmarkGate = readJson("artifacts/benchmark-gates-packaged-windows.json");
const parityEvidence = readJson("artifacts/dictation-parity-evidence.json");
const promptEval = readJson("artifacts/dictation-prompt-eval.json");
const appMatrixGate = readJson("artifacts/dictation-app-matrix-gate.json");
const localRelease = readJson("artifacts/local-release-macos.json");
const appMatrixRows = parseAppMatrix();
const languageMatrixRows = parseLanguageMatrix();
const appMatrixSummary = summarizeAppMatrixGate(appMatrixGate, appMatrixRows);
const languageMatrixSummary = summarizeLanguageMatrix(languageMatrixRows);
const appMatrixEvidenceViolations = appMatrixGate?.evidenceViolations ?? [];
const appMatrixRejectedInsertionEvidence = appMatrixGate?.rejectedInsertionEvidence ?? [];
const appMatrixEvidenceClean =
  appMatrixGate && Array.isArray(appMatrixEvidenceViolations) && appMatrixEvidenceViolations.length === 0;
const appMatrixPass = Boolean(appMatrixGate?.pass && appMatrixEvidenceClean);
const productQaRows = (qaBundle?.rows ?? []).filter((row) => !isExternalDistributionQaRow(row));
const productQaBundle = {
  rows: productQaRows,
};

const dictationQaSummary = qaAreaSummary(qaBundle, ["Capture", "Permissions", "Onboarding", "Transcription"]);
const meetingQaSummary = qaAreaSummary(qaBundle, ["Capture", "Retention", "Backup", "AI"]);
const trustQaSummary = qaAreaSummary(productQaBundle, ["Licensing", "Backup"]);
const qaEvidenceSummary = {
  missingEvidence: qaBundle?.summary?.missingEvidence ?? null,
  mismatchedEvidenceStatus: qaBundle?.summary?.mismatchedEvidenceStatus ?? null,
  missingPlatform: qaBundle?.summary?.missingPlatform ?? null,
  byPlatform: qaBundle?.summary?.byPlatform ?? {},
  product: qaBundle?.summary?.product ?? summarizeQaRows(productQaRows),
  externalDistribution: qaBundle?.summary?.externalDistribution ?? null,
  productByPlatform: qaBundle?.summary?.productByPlatform ?? {},
  externalDistributionByPlatform: qaBundle?.summary?.externalDistributionByPlatform ?? {},
};
const packagedWindowsBenchmarkEvidence = packagedWindowsBenchmarkGate
  ? "artifacts/benchmark-gates-packaged-windows.json"
  : "artifacts/benchmark-packaged.blocked.md";

const activeBlockers = releaseBlockers?.blockers ?? [];
const externalBlockerGates = new Set(["apple-release-signing", "windows-release-signing"]);
const completionBlockers = activeBlockers.filter((blocker) => !externalBlockerGates.has(blocker.gate));
const externalBlockers = activeBlockers.filter((blocker) => externalBlockerGates.has(blocker.gate));

const dictationStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) =>
    ["benchmark-gates-packaged", "dictation-app-matrix"].includes(blocker.gate)
  ),
  checks: [
    Boolean(macBenchmarkGate?.pass),
    Boolean(windowsBenchmarkGate?.pass),
    Boolean(packagedMacosBenchmarkGate?.pass),
    Boolean(packagedWindowsBenchmarkGate?.pass),
    Boolean(parityEvidence?.summary?.allPass),
    Boolean(promptEval?.summary?.allPass),
    appMatrixSummary.pending === 0,
    appMatrixSummary.clipboardOnly === 0,
    appMatrixSummary.unsupported === 0,
    appMatrixPass,
  ],
});

const meetingStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) => blocker.gate === "packaged-qa-matrix"),
  checks: [
    meetingQaSummary.total > 0,
    meetingQaSummary.blocked === 0,
    meetingQaSummary.fail === 0,
  ],
});

const trustStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) =>
    ["cloud-asr-smoke", "packaged-qa-matrix"].includes(blocker.gate)
  ),
  checks: [
    Boolean(releaseBlockers?.observations?.localReleasePass),
    Boolean(releaseBlockers?.observations?.codesignVerified),
  ],
  allowPartial: true,
});

const claimsStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) =>
    ["benchmark-gates-packaged", "dictation-app-matrix", "packaged-qa-matrix"].includes(
      blocker.gate
    )
  ),
  checks: [
    appMatrixSummary.pending === 0,
    appMatrixSummary.clipboardOnly === 0,
    appMatrixSummary.unsupported === 0,
    appMatrixPass,
    languageMatrixSummary.packagedPending === 0,
  ],
});

const report = {
  generatedAt,
  status: completionBlockers.length === 0 ? "GO" : "NO-GO",
  areas: {
    dictation: {
      status: dictationStatus,
      benchmarkMacosPass: Boolean(macBenchmarkGate?.pass),
      benchmarkWindowsPass: Boolean(windowsBenchmarkGate?.pass),
      packagedBenchmarkMacosPass: Boolean(packagedMacosBenchmarkGate?.pass),
      packagedBenchmarkWindowsPass: Boolean(packagedWindowsBenchmarkGate?.pass),
      parityFixturesPass: Boolean(parityEvidence?.summary?.allPass),
      promptEvalPass: Boolean(promptEval?.summary?.allPass),
      appMatrixPass,
      appMatrixEvidenceViolations,
      appMatrixRejectedInsertionEvidence,
      qaSummary: dictationQaSummary,
      appMatrixSummary,
    },
    meetings: {
      status: meetingStatus,
      qaSummary: meetingQaSummary,
    },
    trust: {
      status: trustStatus,
      qaSummary: trustQaSummary,
      qaEvidenceSummary,
      localReleasePass: Boolean(releaseBlockers?.observations?.localReleasePass),
      cloudSmokeReady: !activeBlockers.some((blocker) => blocker.gate === "cloud-asr-smoke"),
      appleReleaseSigningReady: !activeBlockers.some((blocker) => blocker.gate === "apple-release-signing"),
      windowsReleaseSigningReady: !activeBlockers.some((blocker) => blocker.gate === "windows-release-signing"),
    },
    launchClaims: {
      status: claimsStatus,
      appMatrixSummary,
      languageMatrixSummary,
    },
  },
  blockers: completionBlockers,
  externalBlockers,
  nextActions: [
    "Execute the remaining non-signing macOS packaged QA rows that require live credentials.",
    "Use docs/windows-packaged-qa-handoff.md and scripts/windows-packaged-qa-runner.ps1 on a Windows release host, then execute the Windows packaged QA rows.",
    "Capture packaged app-matrix evidence on macOS and Windows, then update the launch app matrix from PENDING to verified statuses.",
    "Keep signing and publishing blockers tracked separately until product readiness is green.",
  ],
  evidence: {
    releaseBlockers: "artifacts/release-blockers.json",
    qaBundle: "artifacts/packaged-qa-evidence-bundle.json",
    benchmarkMacos: "artifacts/benchmark-gates-macos.json",
    benchmarkWindows: "artifacts/benchmark-gates-windows.json",
    packagedBenchmarkMacos: "artifacts/benchmark-gates-packaged-macos.json",
    packagedBenchmarkWindows: packagedWindowsBenchmarkEvidence,
    dictationParity: "artifacts/dictation-parity-evidence.json",
    dictationPromptEval: "artifacts/dictation-prompt-eval.json",
    appMatrixGate: "artifacts/dictation-app-matrix-gate.json",
    appMatrix: "docs/dictation-app-compatibility-matrix.md",
    completionAudit: "docs/launch-completion-audit.md",
    launchUnblockerPack: "docs/launch-unblocker-pack.md",
    windowsQaHandoff: "docs/windows-packaged-qa-handoff.md",
    windowsQaRunner: "scripts/windows-packaged-qa-runner.ps1",
    languageMatrix: "docs/evals/dictation-language-certification-matrix.md",
  },
};

const blockerLines =
  report.blockers.length === 0
    ? ["- none"]
    : report.blockers.map(
        (blocker) =>
          `- \`${blocker.gate}\`: ${blocker.reason} (${blocker.evidence})`
      );
const externalBlockerLines =
  report.externalBlockers.length === 0
    ? ["- none"]
    : report.externalBlockers.map(
        (blocker) =>
          `- \`${blocker.gate}\`: ${blocker.reason} (${blocker.evidence})`
      );

const markdown = `# Launch Readiness Dashboard

Generated: ${generatedAt}
Overall status: \`${report.status}\`

This dashboard is the single repo-side control surface for launch readiness against the practical bar set by Wispr Flow, FreeFlow, Granola, and OpenOats.

## Area Status

| Area | Status | Current read |
| --- | --- | --- |
| Dictation | \`${report.areas.dictation.status}\` | Local benchmark gates pass on macOS and Windows, packaged benchmark gates are ${report.areas.dictation.packagedBenchmarkMacosPass ? "PASS" : "BLOCKED"} on macOS and ${report.areas.dictation.packagedBenchmarkWindowsPass ? "PASS" : "BLOCKED"} on Windows, and the launch app matrix is still ${report.areas.dictation.appMatrixSummary.ready}/${report.areas.dictation.appMatrixSummary.total} ready with ${report.areas.dictation.appMatrixSummary.pending} pending. |
| Meetings | \`${report.areas.meetings.status}\` | Packaged meeting QA remains ${report.areas.meetings.qaSummary.blocked} blocked rows out of ${report.areas.meetings.qaSummary.total}. |
| Trust | \`${report.areas.trust.status}\` | Internal hardening is in place, but release credentials and packaged trust evidence are still incomplete. |
| Launch claims | \`${report.areas.launchClaims.status}\` | App and language claims still exceed the packaged evidence currently checked into the repo. |

## Dictation

- macOS benchmark gate: \`${report.areas.dictation.benchmarkMacosPass ? "PASS" : "FAIL"}\`
- Windows benchmark gate: \`${report.areas.dictation.benchmarkWindowsPass ? "PASS" : "FAIL"}\`
- macOS packaged benchmark gate: \`${report.areas.dictation.packagedBenchmarkMacosPass ? "PASS" : "BLOCKED"}\`
- Windows packaged benchmark gate: \`${report.areas.dictation.packagedBenchmarkWindowsPass ? "PASS" : "BLOCKED"}\`
- Dictation parity fixtures: \`${report.areas.dictation.parityFixturesPass ? "PASS" : "FAIL"}\`
- Prompt regression fixtures: \`${report.areas.dictation.promptEvalPass ? "PASS" : "FAIL"}\`
- App matrix gate: \`${report.areas.dictation.appMatrixPass ? "PASS" : "BLOCKED"}\`
- Launch app matrix: ${report.areas.dictation.appMatrixSummary.ready}/${report.areas.dictation.appMatrixSummary.total} ready, ${report.areas.dictation.appMatrixSummary.supported} supported, ${report.areas.dictation.appMatrixSummary.partial} partial, ${report.areas.dictation.appMatrixSummary.clipboardOnly} clipboard-only, ${report.areas.dictation.appMatrixSummary.pending} pending
- Missing insertion evidence: ${report.areas.dictation.appMatrixSummary.missingInsertionEvidence}
- Rejected insertion evidence artifacts: ${report.areas.dictation.appMatrixSummary.rejectedInsertionEvidence}
- Missing packaged benchmark evidence: ${report.areas.dictation.appMatrixSummary.missingPackagedEvidence}
- Invalid app-matrix evidence artifacts: ${report.areas.dictation.appMatrixEvidenceViolations.length}

## Meetings

- Packaged QA rows in meeting-critical areas: ${report.areas.meetings.qaSummary.total}
- Blocked rows in meeting-critical areas: ${report.areas.meetings.qaSummary.blocked}
- Passed rows in meeting-critical areas: ${report.areas.meetings.qaSummary.pass}

## Trust

- Local release path: \`${report.areas.trust.localReleasePass ? "PASS" : "FAIL"}\`
- QA evidence files present: \`${report.areas.trust.qaEvidenceSummary.missingEvidence === 0 ? "PASS" : "BLOCKED"}\`
- QA evidence status matches matrix: \`${report.areas.trust.qaEvidenceSummary.mismatchedEvidenceStatus === 0 ? "PASS" : "BLOCKED"}\`
- QA evidence platform ownership: \`${report.areas.trust.qaEvidenceSummary.missingPlatform === 0 ? "PASS" : "BLOCKED"}\`
- macOS packaged QA: ${report.areas.trust.qaEvidenceSummary.byPlatform.macOS?.pass ?? 0} PASS / ${report.areas.trust.qaEvidenceSummary.byPlatform.macOS?.blocked ?? 0} BLOCKED / ${report.areas.trust.qaEvidenceSummary.byPlatform.macOS?.pending ?? 0} PENDING
- Windows packaged QA: ${report.areas.trust.qaEvidenceSummary.byPlatform.Windows?.pass ?? 0} PASS / ${report.areas.trust.qaEvidenceSummary.byPlatform.Windows?.blocked ?? 0} BLOCKED / ${report.areas.trust.qaEvidenceSummary.byPlatform.Windows?.pending ?? 0} PENDING
- Non-external packaged QA: ${report.areas.trust.qaEvidenceSummary.product?.pass ?? 0} PASS / ${report.areas.trust.qaEvidenceSummary.product?.blocked ?? 0} BLOCKED / ${report.areas.trust.qaEvidenceSummary.product?.pending ?? 0} PENDING
- External distribution QA: ${report.areas.trust.qaEvidenceSummary.externalDistribution?.pass ?? 0} PASS / ${report.areas.trust.qaEvidenceSummary.externalDistribution?.blocked ?? 0} BLOCKED / ${report.areas.trust.qaEvidenceSummary.externalDistribution?.pending ?? 0} PENDING
- Cloud smoke ready: \`${report.areas.trust.cloudSmokeReady ? "PASS" : "BLOCKED"}\`
- Apple release signing ready: \`${report.areas.trust.appleReleaseSigningReady ? "PASS" : "BLOCKED"}\`
- Windows release signing ready: \`${report.areas.trust.windowsReleaseSigningReady ? "PASS" : "BLOCKED"}\`

## Launch Claims

- Verified launch apps ready for marketing: ${report.areas.launchClaims.appMatrixSummary.supported + report.areas.launchClaims.appMatrixSummary.partial} of ${report.areas.launchClaims.appMatrixSummary.total}
- Languages with packaged evidence: ${report.areas.launchClaims.languageMatrixSummary.packagedPass} of ${report.areas.launchClaims.languageMatrixSummary.total}

## Active Blockers

${blockerLines.join("\n")}

## Control Artifacts

- Completion audit: \`${report.evidence.completionAudit}\`
- Launch unblocker pack: \`${report.evidence.launchUnblockerPack}\`
- Windows QA handoff: \`${report.evidence.windowsQaHandoff}\`

## External Signing And Publishing Blockers

${externalBlockerLines.join("\n")}

## Next Actions

1. ${report.nextActions[0]}
2. ${report.nextActions[1]}
3. ${report.nextActions[2]}
4. ${report.nextActions[3]}
`;

writeJson("artifacts/launch-readiness-report.json", report);
writeText("docs/launch-readiness-dashboard.md", markdown);

console.log(JSON.stringify(report, null, 2));
