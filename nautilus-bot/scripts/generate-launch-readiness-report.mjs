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
  const summary = { total: 0, pass: 0, fail: 0, blocked: 0, pending: 0 };
  const matchingRows = (bundle?.rows ?? []).filter((row) => areas.includes(row.area));

  for (const row of matchingRows) {
    const normalized = String(row.status ?? "").toLowerCase();
    summary.total += 1;
    if (normalized in summary) {
      summary[normalized] += 1;
    }
  }

  return summary;
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
const parityEvidence = readJson("artifacts/dictation-parity-evidence.json");
const promptEval = readJson("artifacts/dictation-prompt-eval.json");
const localRelease = readJson("artifacts/local-release-macos.json");
const appMatrixRows = parseAppMatrix();
const languageMatrixRows = parseLanguageMatrix();
const appMatrixSummary = summarizeAppMatrix(appMatrixRows);
const languageMatrixSummary = summarizeLanguageMatrix(languageMatrixRows);

const dictationQaSummary = qaAreaSummary(qaBundle, ["Capture", "Permissions", "Onboarding", "Transcription"]);
const meetingQaSummary = qaAreaSummary(qaBundle, ["Capture", "Retention", "Backup", "AI"]);
const trustQaSummary = qaAreaSummary(qaBundle, ["Install", "Security", "Updates", "Licensing", "Backup"]);

const activeBlockers = releaseBlockers?.blockers ?? [];

const dictationStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) => blocker.gate === "benchmark-gates-packaged"),
  checks: [
    Boolean(macBenchmarkGate?.pass),
    Boolean(windowsBenchmarkGate?.pass),
    Boolean(parityEvidence?.summary?.allPass),
    Boolean(promptEval?.summary?.allPass),
    appMatrixSummary.pending === 0,
    appMatrixSummary.clipboardOnly === 0,
    appMatrixSummary.unsupported === 0,
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
    ["cloud-asr-smoke", "apple-release-signing", "windows-release-signing", "packaged-qa-matrix"].includes(
      blocker.gate
    )
  ),
  checks: [
    Boolean(releaseBlockers?.observations?.localReleasePass),
    Boolean(releaseBlockers?.observations?.codesignVerified),
  ],
  allowPartial: true,
});

const claimsStatus = areaStatus({
  blockers: activeBlockers.filter((blocker) =>
    ["benchmark-gates-packaged", "packaged-qa-matrix"].includes(blocker.gate)
  ),
  checks: [
    appMatrixSummary.pending === 0,
    appMatrixSummary.clipboardOnly === 0,
    appMatrixSummary.unsupported === 0,
    languageMatrixSummary.packagedPending === 0,
  ],
});

const report = {
  generatedAt,
  status: releaseBlockers?.strictReady ? "GO" : "NO-GO",
  areas: {
    dictation: {
      status: dictationStatus,
      benchmarkMacosPass: Boolean(macBenchmarkGate?.pass),
      benchmarkWindowsPass: Boolean(windowsBenchmarkGate?.pass),
      parityFixturesPass: Boolean(parityEvidence?.summary?.allPass),
      promptEvalPass: Boolean(promptEval?.summary?.allPass),
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
  blockers: activeBlockers,
  nextActions: [
    "Provision Apple signing and notarization credentials, then execute the macOS packaged QA rows.",
    "Provision the Windows signing certificate, then execute the Windows packaged QA rows.",
    "Capture packaged dictation benchmark evidence and update the launch app matrix from PENDING to verified statuses.",
    "Freeze public launch claims to the verified app and language set only.",
  ],
  evidence: {
    releaseBlockers: "artifacts/release-blockers.json",
    qaBundle: "artifacts/packaged-qa-evidence-bundle.json",
    benchmarkMacos: "artifacts/benchmark-gates-macos.json",
    benchmarkWindows: "artifacts/benchmark-gates-windows.json",
    dictationParity: "artifacts/dictation-parity-evidence.json",
    dictationPromptEval: "artifacts/dictation-prompt-eval.json",
    appMatrix: "docs/dictation-app-compatibility-matrix.md",
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

const markdown = `# Launch Readiness Dashboard

Generated: ${generatedAt}
Overall status: \`${report.status}\`

This dashboard is the single repo-side control surface for launch readiness against the practical bar set by Wispr Flow, FreeFlow, Granola, and OpenOats.

## Area Status

| Area | Status | Current read |
| --- | --- | --- |
| Dictation | \`${report.areas.dictation.status}\` | Local benchmark gates pass on macOS and Windows, but the launch app matrix is still ${report.areas.dictation.appMatrixSummary.pending} pending and ${report.areas.dictation.appMatrixSummary.clipboardOnly} clipboard-only. |
| Meetings | \`${report.areas.meetings.status}\` | Packaged meeting QA remains ${report.areas.meetings.qaSummary.blocked} blocked rows out of ${report.areas.meetings.qaSummary.total}. |
| Trust | \`${report.areas.trust.status}\` | Internal hardening is in place, but release credentials and packaged trust evidence are still incomplete. |
| Launch claims | \`${report.areas.launchClaims.status}\` | App and language claims still exceed the packaged evidence currently checked into the repo. |

## Dictation

- macOS benchmark gate: \`${report.areas.dictation.benchmarkMacosPass ? "PASS" : "FAIL"}\`
- Windows benchmark gate: \`${report.areas.dictation.benchmarkWindowsPass ? "PASS" : "FAIL"}\`
- Dictation parity fixtures: \`${report.areas.dictation.parityFixturesPass ? "PASS" : "FAIL"}\`
- Prompt regression fixtures: \`${report.areas.dictation.promptEvalPass ? "PASS" : "FAIL"}\`
- Launch app matrix: ${report.areas.dictation.appMatrixSummary.supported} supported, ${report.areas.dictation.appMatrixSummary.partial} partial, ${report.areas.dictation.appMatrixSummary.clipboardOnly} clipboard-only, ${report.areas.dictation.appMatrixSummary.pending} pending

## Meetings

- Packaged QA rows in meeting-critical areas: ${report.areas.meetings.qaSummary.total}
- Blocked rows in meeting-critical areas: ${report.areas.meetings.qaSummary.blocked}
- Passed rows in meeting-critical areas: ${report.areas.meetings.qaSummary.pass}

## Trust

- Local release path: \`${report.areas.trust.localReleasePass ? "PASS" : "FAIL"}\`
- Cloud smoke ready: \`${report.areas.trust.cloudSmokeReady ? "PASS" : "BLOCKED"}\`
- Apple release signing ready: \`${report.areas.trust.appleReleaseSigningReady ? "PASS" : "BLOCKED"}\`
- Windows release signing ready: \`${report.areas.trust.windowsReleaseSigningReady ? "PASS" : "BLOCKED"}\`

## Launch Claims

- Verified launch apps ready for marketing: ${report.areas.launchClaims.appMatrixSummary.supported + report.areas.launchClaims.appMatrixSummary.partial} of ${report.areas.launchClaims.appMatrixSummary.total}
- Languages with packaged evidence: ${report.areas.launchClaims.languageMatrixSummary.packagedPass} of ${report.areas.launchClaims.languageMatrixSummary.total}

## Active Blockers

${blockerLines.join("\n")}

## Next Actions

1. ${report.nextActions[0]}
2. ${report.nextActions[1]}
3. ${report.nextActions[2]}
4. ${report.nextActions[3]}
`;

writeJson("artifacts/launch-readiness-report.json", report);
writeText("docs/launch-readiness-dashboard.md", markdown);

console.log(JSON.stringify(report, null, 2));
