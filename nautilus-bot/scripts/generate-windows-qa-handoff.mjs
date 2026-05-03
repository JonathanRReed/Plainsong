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

const matrixPath = path.resolve(
  repoRoot,
  valueFor("--matrix", "docs/packaged-app-qa-matrix.md")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/windows-packaged-qa-handoff.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/windows-packaged-qa-handoff.md")
);
const runnerPath = path.resolve(
  repoRoot,
  valueFor("--runner", "scripts/windows-packaged-qa-runner.ps1")
);
const qaBundlePath = path.resolve(
  repoRoot,
  valueFor("--qa-bundle", "artifacts/packaged-qa-evidence-bundle.json")
);

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function parsePackagedQaMatrix(filePath) {
  const rows = [];
  let platform = null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^##\s+/i.test(line)) {
      platform = line.replace(/^##\s+/i, "").trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Area" || cells[0] === "---") continue;
    if (platform !== "Windows") continue;
    rows.push({
      platform,
      area: cells[0],
      testCase: cells[1],
      status: cells[2].toUpperCase(),
      evidence: cells[3],
      owner: cells[4],
    });
  }
  return rows;
}

function isDistributionOnly(row) {
  return (
    row.area === "Install" ||
    row.area === "Security" ||
    row.area === "Updates" ||
    /signed installer|authenticode|smartscreen|stable channel/i.test(row.testCase)
  );
}

function rowCommand(row) {
  const checks = [
    "Replace the BLOCKED artifact with Status: PASS or Status: FAIL.",
    "Include build path, Windows version, app version, tester, timestamp, and observed result.",
    "Include screenshots, logs, or exported files where the row requires visual or file evidence.",
  ];

  if (row.area === "Capture" && /Dictation hotkey/i.test(row.testCase)) {
    checks.push("Use safe scratch fields only and record target app plus inserted text.");
  }
  if (row.area === "Licensing") {
    checks.push("Use disposable QA license keys only and never write raw keys into evidence.");
  }
  if (row.area === "Backup") {
    checks.push("Record backup path, restore target, and cleanup result.");
  }
  if (row.area === "Export") {
    checks.push("Attach export filenames and bundle verification result.");
  }

  return {
    evidence: row.evidence,
    command: `notepad ${row.evidence}`,
    acceptanceChecks: checks,
  };
}

const generatedAt = new Date().toISOString();
const qaBundle = fs.existsSync(qaBundlePath)
  ? JSON.parse(fs.readFileSync(qaBundlePath, "utf8"))
  : null;
const rows = parsePackagedQaMatrix(matrixPath).map((row) => ({
  ...row,
  distributionOnly: isDistributionOnly(row),
  launchBlockingProductRow: !isDistributionOnly(row),
  ...rowCommand(row),
}));

const summary = {
  totalRows: rows.length,
  pass: rows.filter((row) => row.status === "PASS").length,
  fail: rows.filter((row) => row.status === "FAIL").length,
  blocked: rows.filter((row) => row.status === "BLOCKED").length,
  pending: rows.filter((row) => row.status === "PENDING").length,
  productRows: rows.filter((row) => row.launchBlockingProductRow).length,
  distributionRows: rows.filter((row) => row.distributionOnly).length,
  blockedProductRows: rows.filter(
    (row) => row.launchBlockingProductRow && row.status === "BLOCKED"
  ).length,
  blockedDistributionRows: rows.filter(
    (row) => row.distributionOnly && row.status === "BLOCKED"
  ).length,
};
const qaBundleWindowsSummary = qaBundle?.summary?.byPlatform?.Windows ?? null;

const report = {
  generatedAt,
  status: summary.blocked === 0 ? "PASS" : "BLOCKED",
  matrixPath: path.relative(repoRoot, matrixPath),
  qaBundlePath: path.relative(repoRoot, qaBundlePath),
  runnerPath: path.relative(repoRoot, runnerPath),
  benchmarkCommand: "bun run benchmark:dictation:packaged:windows",
  appMatrixCommand: "bun run gate:app-matrix",
  refreshCommand: "bun run gate:blockers:refresh",
  requiredReturnArtifacts: [
    "docs/evals/benchmark-run-packaged-windows.json",
    "artifacts/benchmark-packaged-windows.json",
    "artifacts/benchmark-gates-packaged-windows.json",
    "artifacts/dictation-app-matrix-gate.json",
    "artifacts/packaged-qa-evidence-bundle.json",
  ],
  summary,
  qaBundleWindowsSummary,
  rows,
};

const markdownRows = rows
  .map((row) => {
    const scope = row.distributionOnly ? "distribution" : "product";
    return `| ${row.area} | ${row.testCase} | ${row.status} | ${scope} | \`${row.evidence}\` |`;
  })
  .join("\n");

const productCommands = rows
  .filter((row) => row.launchBlockingProductRow)
  .map(
    (row) =>
      `- ${row.area}: ${row.testCase}\n  - Evidence: \`${row.evidence}\`\n  - Open: \`${row.command}\`\n  - Acceptance: ${row.acceptanceChecks.join(" ")}`
  )
  .join("\n");

const distributionCommands = rows
  .filter((row) => row.distributionOnly)
  .map(
    (row) =>
      `- ${row.area}: ${row.testCase}\n  - Evidence: \`${row.evidence}\`\n  - Open: \`${row.command}\``
  )
  .join("\n");

const runnerRows = rows.map((row) => ({
  area: row.area,
  testCase: row.testCase,
  status: row.status,
  evidence: row.evidence,
  distributionOnly: row.distributionOnly,
  launchBlockingProductRow: row.launchBlockingProductRow,
  acceptanceChecks: row.acceptanceChecks,
}));

writeText(
  runnerPath,
  `param(
  [switch]$ProductOnly,
  [switch]$SkipBenchmark,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$RowsJson = @'
${JSON.stringify(runnerRows, null, 2)}
'@

$Rows = $RowsJson | ConvertFrom-Json
$RequiredReturnArtifacts = @(
${report.requiredReturnArtifacts.map((artifact) => `  "${artifact}"`).join(",\n")}
)

function Read-StatusFromEvidence {
  param([string]$Path)
  if (!(Test-Path $Path)) {
    return "MISSING"
  }
  $Content = Get-Content -Raw -Path $Path
  if ($Content -match "(?im)^Status:\\s*PASS\\b") {
    return "PASS"
  }
  if ($Content -match "(?im)^Status:\\s*FAIL\\b") {
    return "FAIL"
  }
  if ($Content -match "(?im)^Status:\\s*BLOCKED\\b") {
    return "BLOCKED"
  }
  return "UNKNOWN"
}

function Test-EvidenceMetadata {
  param([string]$Path)
  $RequiredLabels = @(
    "Build path",
    "Windows version",
    "App version",
    "Tester",
    "Timestamp",
    "Observed result"
  )
  $Content = Get-Content -Raw -Path $Path
  $Missing = @()
  foreach ($Label in $RequiredLabels) {
    $EscapedLabel = [Regex]::Escape($Label)
    if ($Content -notmatch "(?im)^\\s*-\\s*\${EscapedLabel}:\\s*\\S+") {
      $Missing += $Label
    }
  }
  return $Missing
}

function Show-Row {
  param($Row)
  Write-Host ""
  Write-Host ("[{0}] {1}" -f $Row.area, $Row.testCase)
  Write-Host ("Evidence: {0}" -f $Row.evidence)
  foreach ($Check in $Row.acceptanceChecks) {
    Write-Host ("- {0}" -f $Check)
  }
}

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
  throw "Run this script on Windows PowerShell or PowerShell 7 on Windows."
}

$SidecarPath = "release/win-unpacked/resources/sidecar/nautilus-sidecar.exe"
if (!(Test-Path $SidecarPath)) {
  Write-Warning "Packaged sidecar was not found at $SidecarPath. Build or unpack the Windows package before product QA."
}

if (!$SkipBenchmark -and !$ValidateOnly) {
  bun run benchmark:dictation:packaged:windows
}

$RowsToRun = $Rows
if ($ProductOnly) {
  $RowsToRun = $Rows | Where-Object { $_.launchBlockingProductRow -eq $true }
}

if (!$ValidateOnly) {
  foreach ($Row in $RowsToRun) {
    Show-Row $Row
    $Dir = Split-Path -Parent $Row.evidence
    if ($Dir -and !(Test-Path $Dir)) {
      New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    }
    if (!(Test-Path $Row.evidence)) {
      @"
# $($Row.area): $($Row.testCase)

Status: BLOCKED
Owner: qa-windows

## Evidence

- Build path:
- Windows version:
- App version:
- Tester:
- Timestamp:
- Observed result:

## Notes

"@ | Set-Content -Path $Row.evidence -Encoding UTF8
    }
    notepad $Row.evidence
    Read-Host "Update the evidence file, save it, then press Enter"
  }
}

$Failures = @()
foreach ($Row in ($Rows | Where-Object { $_.launchBlockingProductRow -eq $true })) {
  $Status = Read-StatusFromEvidence $Row.evidence
  if ($Status -ne "PASS" -and $Status -ne "FAIL") {
    $Failures += ("{0}: {1} is {2}" -f $Row.testCase, $Row.evidence, $Status)
    continue
  }
  $MissingMetadata = Test-EvidenceMetadata $Row.evidence
  if ($MissingMetadata.Count -gt 0) {
    $Failures += ("{0}: {1} is missing required metadata fields: {2}" -f $Row.testCase, $Row.evidence, ($MissingMetadata -join ", "))
  }
}

Write-Host ""
Write-Host "Required return artifacts:"
foreach ($Artifact in $RequiredReturnArtifacts) {
  $Exists = Test-Path $Artifact
  Write-Host ("- {0}: {1}" -f $Artifact, $(if ($Exists) { "present" } else { "missing" }))
  if (!$Exists) {
    $Failures += ("Required return artifact is missing: {0}" -f $Artifact)
  }
}

if ($Failures.Count -gt 0) {
  $JoinedFailures = $Failures -join [Environment]::NewLine
  Write-Error ("Windows product QA still has unresolved evidence:{0}{1}" -f [Environment]::NewLine, $JoinedFailures)
  exit 1
}

Write-Host "Windows product QA evidence files are resolved. Copy the return artifacts back to the repo and run bun run gate:blockers:refresh."
`
);

writeJson(outPath, report);
writeText(
  markdownPath,
  `# Windows Packaged QA Handoff

Status: ${report.status}
Generated: ${generatedAt}

This handoff is generated from \`${path.relative(repoRoot, matrixPath)}\`. It defines the Windows-host evidence required before Nautilus can be considered ready, excluding signing and publishing.

## Required Windows Commands

1. Build or unpack the Windows packaged app so \`release/win-unpacked/resources/sidecar/nautilus-sidecar.exe\` exists.
2. Run \`${report.benchmarkCommand}\`.
3. Run \`pwsh ${path.relative(repoRoot, runnerPath)} -ProductOnly\` to walk product QA rows and validate evidence statuses.
4. Run \`${report.appMatrixCommand}\` after packaged app-matrix evidence is added.
5. Copy the return artifacts listed below back to this repo and run \`${report.refreshCommand}\`.

## Generated Runner

- Runner: \`${path.relative(repoRoot, runnerPath)}\`
- Product-only execution: \`pwsh ${path.relative(repoRoot, runnerPath)} -ProductOnly\`
- Validation-only check: \`pwsh ${path.relative(repoRoot, runnerPath)} -ProductOnly -SkipBenchmark -ValidateOnly\`

## Summary

- Windows rows: ${summary.totalRows}
- Product rows: ${summary.productRows}
- Distribution rows: ${summary.distributionRows}
- Blocked product rows: ${summary.blockedProductRows}
- Blocked distribution rows: ${summary.blockedDistributionRows}
- QA bundle Windows summary: ${report.qaBundleWindowsSummary?.pass ?? 0} PASS / ${report.qaBundleWindowsSummary?.blocked ?? 0} BLOCKED / ${report.qaBundleWindowsSummary?.pending ?? 0} PENDING

## Return Artifacts

${report.requiredReturnArtifacts.map((artifact) => `- \`${artifact}\``).join("\n")}

## Product QA Rows

${productCommands}

## Distribution Rows

These still matter for release, but the current objective explicitly excludes signing and publishing.

${distributionCommands}

## Matrix

| Area | Test Case | Status | Scope | Evidence |
| --- | --- | --- | --- | --- |
${markdownRows}
`
);

console.log(JSON.stringify(report, null, 2));
