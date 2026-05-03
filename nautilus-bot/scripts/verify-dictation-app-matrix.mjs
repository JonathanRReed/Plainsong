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
const macosPackagedBenchmarkPath = path.resolve(
  repoRoot,
  valueFor("--macos-packaged-benchmark", "docs/evals/benchmark-run-packaged-macos.json")
);
const windowsPackagedBenchmarkPath = path.resolve(
  repoRoot,
  valueFor("--windows-packaged-benchmark", "docs/evals/benchmark-run-packaged-windows.json")
);
const macosInsertionEvidenceDir = path.resolve(
  repoRoot,
  valueFor("--macos-insertion-evidence-dir", "artifacts/qa/macos")
);
const outPath = valueFor("--out")
  ? path.resolve(repoRoot, valueFor("--out"))
  : null;
const writeOnly = args.includes("--write-only");
const placeholderScratchTargetPattern = /^(DISPOSABLE QA TARGET|QA scratch note)$/i;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeAppName(value) {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
}

function slugFor(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseAppMatrix(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`App matrix not found: ${filePath}`);
  }

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
    rows.push({
      platform,
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
    .map(([id, platform, app, currentMode, status, risk, blocker, requiredEvidence]) => ({
      id,
      platform,
      app,
      currentMode,
      status: status.replaceAll("`", ""),
      risk,
      blocker,
      requiredEvidence,
    }));
}

function successfulPackagedApps(benchmark) {
  const apps = new Map();
  for (const row of benchmark?.rows ?? []) {
    const outcome = String(row.insertionOutcome ?? "");
    const passed = outcome === "pasted" || outcome === "command_only";
    if (!passed) continue;
    const key = normalizeAppName(row.appTarget);
    const existing = apps.get(key) ?? [];
    existing.push(row.scenarioId ?? row.appTarget);
    apps.set(key, existing);
  }
  return apps;
}

function successfulInsertionEvidence(evidenceDir, violations, rejectedEvidence) {
  const apps = new Map();
  if (!fs.existsSync(evidenceDir)) return apps;
  for (const name of fs.readdirSync(evidenceDir)) {
    if (!/^app-matrix-insertion-.+\.json$/i.test(name)) continue;
    const filePath = path.join(evidenceDir, name);
    const relativePath = path.relative(repoRoot, filePath);
    let artifact = null;
    try {
      artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      rejectedEvidence.push({
        path: relativePath,
        status: "UNREADABLE",
        targetApp: null,
        pass: false,
        reason: "Artifact JSON could not be parsed.",
      });
      continue;
    }
    const rejectReasons = [];
    if (!artifact?.pass) rejectReasons.push("pass is not true");
    if (artifact?.status !== "PASS") rejectReasons.push(`status is ${artifact?.status ?? "missing"}`);
    if (!artifact?.checks?.sidecarCommandCompleted) rejectReasons.push("sidecar command did not complete");
    if (!artifact?.checks?.frontmostMatchedTarget) rejectReasons.push("frontmost app did not match target");
    if (!artifact?.checks?.pasteReported) rejectReasons.push("paste was not reported");
    if (!artifact?.checks?.manualObservationAccepted) rejectReasons.push("manual observation was not accepted");
    if (!artifact?.scratchTarget?.trim()) rejectReasons.push("scratch target is missing");
    if (placeholderScratchTargetPattern.test(artifact?.scratchTarget?.trim() ?? "")) {
      rejectReasons.push("scratch target is a placeholder");
    }
    if (!artifact?.sampleText?.trim()) rejectReasons.push("sample text is missing");
    if (!["exact", "partial"].includes(artifact?.observation?.result)) {
      rejectReasons.push("manual observation result is missing");
    }
    if (rejectReasons.length > 0) {
      rejectedEvidence.push({
        path: relativePath,
        status: artifact?.status ?? null,
        targetApp: artifact?.targetApp ?? null,
        pass: artifact?.pass ?? null,
        reason: rejectReasons.join(", "),
      });
      continue;
    }
    const filenameTargetSlug = name
      .replace(/^app-matrix-insertion-/i, "")
      .replace(/\.json$/i, "");
    const artifactTargetSlug = slugFor(artifact.targetApp);
    if (filenameTargetSlug !== artifactTargetSlug) {
      violations.push(
        `${path.relative(repoRoot, filePath)} targetApp ${artifact.targetApp} does not match filename slug ${filenameTargetSlug}.`
      );
      continue;
    }
    const pairedMarkdownPath = filePath.replace(/\.json$/i, ".md");
    if (!fs.existsSync(pairedMarkdownPath)) {
      violations.push(`${path.relative(repoRoot, filePath)} is missing paired Markdown evidence.`);
      continue;
    }
    const key = normalizeAppName(artifact.targetApp);
    const existing = apps.get(key) ?? [];
    existing.push({
      path: filePath,
      targetApp: artifact.targetApp,
      scratchTarget: artifact.scratchTarget,
      sampleText: artifact.sampleText,
      observed: artifact.observation?.result ?? null,
      generatedAt: artifact.generatedAt ?? null,
    });
    apps.set(key, existing);
  }
  return apps;
}

function openBlockedEntriesFor(row, blockedEntries) {
  return blockedEntries.filter(
    (entry) =>
      entry.platform === row.platform &&
      normalizeAppName(entry.app) === normalizeAppName(row.app) &&
      entry.status !== "CLOSED"
  );
}

const matrixRows = parseAppMatrix(matrixPath);
const blockedEntries = parseBlockedRegister(blockedRegisterPath);
const macosPackagedBenchmark = readJsonIfExists(macosPackagedBenchmarkPath);
const windowsPackagedBenchmark = readJsonIfExists(windowsPackagedBenchmarkPath);
const evidenceViolations = [];
const rejectedInsertionEvidence = [];
const packagedAppsByPlatform = {
  macOS: successfulPackagedApps(macosPackagedBenchmark),
  Windows: successfulPackagedApps(windowsPackagedBenchmark),
};
const insertionEvidenceByPlatform = {
  macOS: successfulInsertionEvidence(
    macosInsertionEvidenceDir,
    evidenceViolations,
    rejectedInsertionEvidence
  ),
  Windows: new Map(),
};

const rows = matrixRows.map((row) => {
  const supportedStatus = row.status === "SUPPORTED" || row.status === "PARTIAL";
  const packagedScenarioIds =
    packagedAppsByPlatform[row.platform]?.get(normalizeAppName(row.app)) ?? [];
  const insertionEvidence =
    insertionEvidenceByPlatform[row.platform]?.get(normalizeAppName(row.app)) ?? [];
  const blockedEntriesForRow = openBlockedEntriesFor(row, blockedEntries);
  const packagedEvidenceReady = packagedScenarioIds.length > 0;
  const insertionEvidenceReady = insertionEvidence.length > 0;
  const launchReady =
    supportedStatus &&
    packagedEvidenceReady &&
    insertionEvidenceReady &&
    blockedEntriesForRow.length === 0;

  return {
    ...row,
    supportedStatus,
    packagedEvidenceReady,
    packagedScenarioIds,
    insertionEvidenceReady,
    insertionEvidence: insertionEvidence.map((artifact) => ({
      ...artifact,
      path: path.relative(repoRoot, artifact.path),
    })),
    openBlockedEntries: blockedEntriesForRow.map((entry) => entry.id),
    launchReady,
  };
});

const summary = {
  total: rows.length,
  ready: rows.filter((row) => row.launchReady).length,
  pending: rows.filter((row) => row.status === "PENDING").length,
  clipboardOnly: rows.filter((row) => row.status === "CLIPBOARD_ONLY").length,
  unsupported: rows.filter((row) => row.status === "UNSUPPORTED").length,
  missingPackagedEvidence: rows.filter((row) => !row.packagedEvidenceReady).length,
  missingInsertionEvidence: rows.filter((row) => !row.insertionEvidenceReady).length,
  openBlockedEntries: new Set(rows.flatMap((row) => row.openBlockedEntries)).size,
  rejectedInsertionEvidence: rejectedInsertionEvidence.length,
};

const result = {
  generatedAt: new Date().toISOString(),
  pass: rows.length > 0 && rows.every((row) => row.launchReady),
  matrixPath,
  blockedRegisterPath,
  packagedBenchmarks: {
    macOS: fs.existsSync(macosPackagedBenchmarkPath) ? macosPackagedBenchmarkPath : null,
    Windows: fs.existsSync(windowsPackagedBenchmarkPath) ? windowsPackagedBenchmarkPath : null,
  },
  insertionEvidence: {
    macOS: fs.existsSync(macosInsertionEvidenceDir) ? macosInsertionEvidenceDir : null,
    Windows: null,
  },
  summary,
  evidenceViolations,
  rejectedInsertionEvidence,
  rows,
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(result, null, 2));
if (evidenceViolations.length > 0) {
  console.error(`Invalid insertion evidence (${evidenceViolations.length} issues):`);
  for (const violation of evidenceViolations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
process.exit(result.pass || writeOnly ? 0 : 1);
