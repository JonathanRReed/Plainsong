#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const packagedBenchmarkPath = path.resolve(
  repoRoot,
  valueFor("--packaged-benchmark", "docs/evals/benchmark-run-packaged-macos.json")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/app-matrix-preflight.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/app-matrix-preflight.md")
);

const appCandidates = {
  "Apple Notes": [
    "/System/Applications/Notes.app",
    "/Applications/Notes.app",
  ],
  "Google Docs (Chrome)": ["/Applications/Google Chrome.app"],
  Slack: ["/Applications/Slack.app"],
  Notion: ["/Applications/Notion.app"],
  "VS Code": ["/Applications/Visual Studio Code.app"],
  Cursor: ["/Applications/Cursor.app"],
  Messages: [
    "/System/Applications/Messages.app",
    "/Applications/Messages.app",
  ],
  "HubSpot (Chrome)": ["/Applications/Google Chrome.app"],
};

function normalizeAppName(value) {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
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

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function shellOut(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
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
      currentMode: currentMode.replaceAll("`", ""),
      status: status.replaceAll("`", ""),
      risk,
      blocker,
      requiredEvidence,
    }));
}

function packagedScenariosByApp(benchmark) {
  const byApp = new Map();
  for (const row of benchmark?.rows ?? []) {
    const outcome = String(row.insertionOutcome ?? "");
    if (outcome !== "pasted" && outcome !== "command_only") continue;
    const key = normalizeAppName(row.appTarget);
    const scenarios = byApp.get(key) ?? [];
    scenarios.push(row.scenarioId ?? row.scenarioLabel ?? row.appTarget);
    byApp.set(key, scenarios);
  }
  return byApp;
}

function installedPathsFor(app) {
  const candidates = appCandidates[app] ?? [];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function spotlightPathsFor(app) {
  const bundleNames = (appCandidates[app] ?? [])
    .map((candidate) => path.basename(candidate))
    .filter(Boolean);
  if (bundleNames.length === 0) return [];
  const predicate = bundleNames
    .map((name) => `kMDItemFSName == '${name.replaceAll("'", "\\'")}'`)
    .join(" || ");
  const stdout = shellOut("mdfind", [`kMDItemKind == 'Application' && (${predicate})`]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const generatedAt = new Date().toISOString();
const matrixRows = parseAppMatrix(matrixPath);
const blockedEntries = parseBlockedRegister(blockedRegisterPath);
const packagedBenchmark = readJson(packagedBenchmarkPath);
const packagedScenarios = packagedScenariosByApp(packagedBenchmark);

const rows = matrixRows.map((row) => {
  const directInstalledPaths = installedPathsFor(row.app);
  const spotlightPaths = spotlightPathsFor(row.app);
  const installedPaths = [...new Set([...directInstalledPaths, ...spotlightPaths])].sort();
  const openBlockedEntries = blockedEntries
    .filter(
      (entry) =>
        entry.platform === "macOS" &&
        normalizeAppName(entry.app) === normalizeAppName(row.app) &&
        entry.status !== "CLOSED"
    )
    .map((entry) => entry.id);
  const packagedScenarioIds =
    packagedScenarios.get(normalizeAppName(row.app)) ??
    packagedScenarios.get(normalizeAppName(row.app.replace(/\s+\(Chrome\)$/i, ""))) ??
    [];
  const canAttemptManualCapture =
    row.status === "PENDING" &&
    installedPaths.length > 0 &&
    openBlockedEntries.length === 0;
  const captureCommand = canAttemptManualCapture ? captureCommandFor(row.app) : null;

  return {
    ...row,
    appInstalled: installedPaths.length > 0,
    installedPaths,
    packagedBenchmarkCovered: packagedScenarioIds.length > 0,
    packagedScenarioIds,
    openBlockedEntries,
    canAttemptManualCapture,
    scratchTargetEnv: canAttemptManualCapture ? envNameForScratchTarget(row.app) : null,
    captureCommand,
    launchReady: false,
    launchReadyReason:
      "Preflight only. Real packaged insertion evidence must be captured before status can change.",
  };
});

const summary = {
  total: rows.length,
  installed: rows.filter((row) => row.appInstalled).length,
  packagedBenchmarkCovered: rows.filter((row) => row.packagedBenchmarkCovered).length,
  openBlockedEntries: new Set(rows.flatMap((row) => row.openBlockedEntries)).size,
  manualCaptureCandidates: rows.filter((row) => row.canAttemptManualCapture).length,
  launchReady: 0,
};

const report = {
  generatedAt,
  pass: false,
  status: "BLOCKED",
  matrixPath,
  blockedRegisterPath,
  packagedBenchmarkPath,
  summary,
  rows,
};

const markdownRows = rows
  .map((row) => {
    const installed = row.appInstalled ? "yes" : "no";
    const packaged = row.packagedBenchmarkCovered
      ? row.packagedScenarioIds.join(", ")
      : "missing";
    const blocked = row.openBlockedEntries.length
      ? row.openBlockedEntries.join(", ")
      : "none";
    const scratchTargetEnv = row.scratchTargetEnv ? `\`${row.scratchTargetEnv}\`` : "not ready";
    const captureCommand = row.captureCommand ? `\`${row.captureCommand}\`` : "not ready";
    const next = row.canAttemptManualCapture
      ? "capture real packaged insertion"
      : row.appInstalled
        ? "resolve blocked entry or scenario gap"
        : "install target app before capture";
    return `| ${row.app} | ${row.modeUsed} | ${installed} | ${packaged} | ${blocked} | ${scratchTargetEnv} | ${captureCommand} | ${next} |`;
  })
  .join("\n");

writeJson(outPath, report);
writeText(
  markdownPath,
  `# macOS Dictation App Matrix Preflight

Status: BLOCKED
Generated: ${generatedAt}

This is a packaged-evidence preflight only. It does not certify app support and must not be used to move any app out of \`PENDING\`.

## Summary

- Matrix rows: ${summary.total}
- Installed target apps found: ${summary.installed}
- Rows covered by packaged benchmark fixtures: ${summary.packagedBenchmarkCovered}
- Open blocked-app entries: ${summary.openBlockedEntries}
- Manual capture candidates: ${summary.manualCaptureCandidates}
- Launch-ready rows certified by this artifact: ${summary.launchReady}

## Rows

| App | Mode | Installed | Packaged benchmark scenarios | Open blocked entries | Scratch target env | Capture command | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
${markdownRows}

## Required Follow-Up

- Capture real packaged insertion behavior in each target editor.
- Use the per-row capture command for every manual capture candidate.
- Update \`docs/dictation-app-compatibility-matrix.md\` only after real insertion evidence exists.
- Close blocked-app register entries only after their required evidence is attached.
`
);

console.log(JSON.stringify(report, null, 2));
process.exit(0);
