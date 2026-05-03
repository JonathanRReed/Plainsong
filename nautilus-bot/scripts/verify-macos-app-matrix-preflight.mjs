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
  valueFor("--matrix", "docs/dictation-app-compatibility-matrix.md")
);
const blockedRegisterPath = path.resolve(
  repoRoot,
  valueFor("--blocked-register", "docs/dictation-blocked-app-register.md")
);
const preflightPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/qa/macos/app-matrix-preflight.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/app-matrix-preflight.md")
);

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function parseAppMatrix(filePath) {
  const rows = [];
  let platform = null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^##\s+/i.test(line)) {
      platform = line.replace(/^##\s+/i, "").trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4 || cells[0] === "App" || cells[0] === "---") continue;
    if (platform !== "macOS") continue;
    rows.push({
      app: cells[0],
      status: cells[1],
      modeUsed: cells[2],
      notes: cells[3],
    });
  }
  return rows;
}

function parseBlockedRegister(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 8)
    .filter((cells) => cells[0] !== "ID" && cells[0] !== "---")
    .map(([id, platform, app, , status]) => ({
      id,
      platform,
      app,
      status: status.replaceAll("`", ""),
    }));
}

function rowKey(row) {
  return `${row.app} :: ${row.modeUsed}`;
}

function envNameForScratchTarget(app) {
  return `NAUTILUS_QA_SCRATCH_${String(app ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function captureCommandFor(app) {
  return `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "${String(app).replaceAll('"', '\\"')}" --scratch-target "$${envNameForScratchTarget(app)}"`;
}

function assertArtifactPath(value, expectedPath, label, violations) {
  if (path.resolve(String(value ?? "")) !== expectedPath) {
    violations.push(`${label} path does not match ${path.relative(repoRoot, expectedPath)}.`);
  }
}

if (!fs.existsSync(matrixPath)) {
  fail(`Dictation app matrix not found: ${path.relative(repoRoot, matrixPath)}`);
}
if (!fs.existsSync(blockedRegisterPath)) {
  fail(`Blocked-app register not found: ${path.relative(repoRoot, blockedRegisterPath)}`);
}
if (!fs.existsSync(preflightPath)) {
  fail(`macOS app-matrix preflight JSON not found: ${path.relative(repoRoot, preflightPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`macOS app-matrix preflight Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const matrixRows = parseAppMatrix(matrixPath);
const blockedEntries = parseBlockedRegister(blockedRegisterPath);
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const preflightRows = Array.isArray(preflight.rows) ? preflight.rows : [];
const violations = [];

if (preflight.status !== "BLOCKED") {
  violations.push(`Preflight status must be BLOCKED, found ${preflight.status}.`);
}
if (preflight.pass !== false) {
  violations.push("Preflight pass must be false because this artifact is not launch evidence.");
}

assertArtifactPath(preflight.matrixPath, matrixPath, "matrixPath", violations);
assertArtifactPath(preflight.blockedRegisterPath, blockedRegisterPath, "blockedRegisterPath", violations);

if (matrixRows.length === 0) {
  violations.push("No macOS rows were parsed from the dictation app matrix.");
}
if (preflightRows.length !== matrixRows.length) {
  violations.push(
    `Preflight row count ${preflightRows.length} does not match matrix row count ${matrixRows.length}.`
  );
}

const matrixKeys = new Set(matrixRows.map(rowKey));
const preflightKeys = new Set(preflightRows.map(rowKey));
for (const key of matrixKeys) {
  if (!preflightKeys.has(key)) {
    violations.push(`Preflight is missing matrix row: ${key}`);
  }
}
for (const key of preflightKeys) {
  if (!matrixKeys.has(key)) {
    violations.push(`Preflight contains row not present in matrix: ${key}`);
  }
}

const activeBlockedIds = new Set(
  blockedEntries
    .filter((entry) => entry.platform === "macOS" && entry.status !== "CLOSED")
    .map((entry) => entry.id)
);

for (const row of preflightRows) {
  const matrixRow = matrixRows.find((candidate) => rowKey(candidate) === rowKey(row));
  if (!matrixRow) continue;
  if (row.platform !== "macOS") {
    violations.push(`${rowKey(row)} has non-macOS platform: ${row.platform}`);
  }
  if (row.status !== matrixRow.status) {
    violations.push(`${row.app} status ${row.status} does not match matrix status ${matrixRow.status}.`);
  }
  if (row.notes !== matrixRow.notes) {
    violations.push(`${row.app} notes do not match the source matrix.`);
  }
  if (typeof row.appInstalled !== "boolean") {
    violations.push(`${row.app} appInstalled must be boolean.`);
  }
  if (typeof row.packagedBenchmarkCovered !== "boolean") {
    violations.push(`${row.app} packagedBenchmarkCovered must be boolean.`);
  }
  if (!Array.isArray(row.installedPaths)) {
    violations.push(`${row.app} installedPaths must be an array.`);
  }
  if (!Array.isArray(row.packagedScenarioIds)) {
    violations.push(`${row.app} packagedScenarioIds must be an array.`);
  }
  if (!Array.isArray(row.openBlockedEntries)) {
    violations.push(`${row.app} openBlockedEntries must be an array.`);
  }
  if (row.launchReady !== false) {
    violations.push(`${row.app} must not be launchReady from preflight evidence.`);
  }
  if (!String(row.launchReadyReason ?? "").includes("Preflight only")) {
    violations.push(`${row.app} launchReadyReason must state this is preflight only.`);
  }
  if (row.appInstalled && row.installedPaths.length === 0) {
    violations.push(`${row.app} is installed but has no installed path evidence.`);
  }
  if (row.packagedBenchmarkCovered && row.packagedScenarioIds.length === 0) {
    violations.push(`${row.app} is benchmark-covered but has no scenario IDs.`);
  }

  const expectedCanAttempt =
    row.status === "PENDING" &&
    row.appInstalled === true &&
    row.packagedBenchmarkCovered === true &&
    row.openBlockedEntries.length === 0;
  if (row.canAttemptManualCapture !== expectedCanAttempt) {
    violations.push(`${row.app} canAttemptManualCapture does not match installed, benchmark, and blocker state.`);
  }
  if (row.canAttemptManualCapture) {
    const expectedScratchTargetEnv = envNameForScratchTarget(row.app);
    const expectedCaptureCommand = captureCommandFor(row.app);
    if (row.scratchTargetEnv !== expectedScratchTargetEnv) {
      violations.push(`${row.app} scratchTargetEnv is ${row.scratchTargetEnv}, expected ${expectedScratchTargetEnv}.`);
    }
    if (row.captureCommand !== expectedCaptureCommand) {
      violations.push(`${row.app} captureCommand is not the expected safe command.`);
    }
    if (!markdown.includes(`\`${expectedCaptureCommand}\``)) {
      violations.push(`${row.app} safe capture command is missing from Markdown.`);
    }
    if (row.installedPaths.length === 0) {
      violations.push(`${row.app} manual capture candidate has no installed path.`);
    }
    if (row.packagedScenarioIds.length === 0) {
      violations.push(`${row.app} manual capture candidate has no packaged benchmark scenario.`);
    }
  } else if (row.scratchTargetEnv !== null) {
    violations.push(`${row.app} scratchTargetEnv must be null when manual capture is not ready.`);
  } else if (row.captureCommand !== null && row.captureCommand !== undefined) {
    violations.push(`${row.app} captureCommand must be empty when manual capture is not ready.`);
  }

  for (const blockerId of row.openBlockedEntries) {
    if (!activeBlockedIds.has(blockerId)) {
      violations.push(`${row.app} references an unknown or closed blocked-app entry: ${blockerId}.`);
    }
  }
}

const expectedSummary = {
  total: preflightRows.length,
  installed: preflightRows.filter((row) => row.appInstalled).length,
  packagedBenchmarkCovered: preflightRows.filter((row) => row.packagedBenchmarkCovered).length,
  openBlockedEntries: new Set(preflightRows.flatMap((row) => row.openBlockedEntries ?? [])).size,
  manualCaptureCandidates: preflightRows.filter((row) => row.canAttemptManualCapture).length,
  launchReady: preflightRows.filter((row) => row.launchReady).length,
};

for (const [key, value] of Object.entries(expectedSummary)) {
  if (preflight.summary?.[key] !== value) {
    violations.push(`Summary ${key} is ${preflight.summary?.[key]}, expected ${value}.`);
  }
}
if (expectedSummary.launchReady !== 0) {
  violations.push("Preflight must not certify any launch-ready row.");
}

const unsafeCommand =
  'bun run qa:packaged:macos:app-matrix:insertion -- --target-app "Google Docs (Chrome)"`';
if (!markdown.includes("Status: BLOCKED")) {
  violations.push("Markdown must contain Status: BLOCKED.");
}
if (!markdown.includes("must not be used to move any app out of `PENDING`")) {
  violations.push("Markdown must state that preflight does not certify app support.");
}
if (!markdown.includes("Use the per-row capture command for every manual capture candidate.")) {
  violations.push("Markdown must direct operators to use every per-row capture command.");
}
if (markdown.includes("QA scratch note") || markdown.includes("DISPOSABLE QA TARGET")) {
  violations.push("Markdown must not include placeholder scratch-target values.");
}
if (markdown.includes(unsafeCommand)) {
  violations.push("Markdown still includes an unsafe insertion command without --scratch-target.");
}

for (const row of preflightRows) {
  if (!markdown.includes(`| ${row.app} | ${row.modeUsed} |`)) {
    violations.push(`Markdown is missing row for ${row.app}.`);
  }
  if (row.canAttemptManualCapture && !markdown.includes(`\`${row.scratchTargetEnv}\``)) {
    violations.push(`Markdown is missing scratch target env for ${row.app}.`);
  }
}

if (violations.length > 0) {
  fail(`macOS app-matrix preflight validation failed (${violations.length} issues):`, violations);
}

console.log(
  `macOS app-matrix preflight validation passed: ${preflightRows.length} rows, ${expectedSummary.manualCaptureCandidates} manual capture candidates.`
);
