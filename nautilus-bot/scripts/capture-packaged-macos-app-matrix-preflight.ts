#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateCandidateEvidenceProvenance,
  type ComponentEquivalenceArtifact,
  type ExactCandidateComponentDigests,
} from "./lib/macos-component-equivalence.ts";

import { captureAppReceiptBinding, bindAppReceipt, appReceiptMatchesBinding } from "./lib/app-receipt-binding.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

interface MatrixRow {
  platform: string;
  app: string;
  status: string;
  modeUsed: string;
  launchGate: string;
  notes: string;
}

interface BlockedEntry {
  id: string;
  platform: string;
  app: string;
  currentMode: string;
  status: string;
  risk: string;
  blocker: string;
  requiredEvidence: string;
}

interface PackagedBenchmark {
  rows?: {
    insertionOutcome?: unknown;
    appTarget?: string;
    scenarioId?: string;
    scenarioLabel?: string;
  }[];
}

/** The fields of a linked insertion capture this preflight reads. */
interface LinkedInsertionArtifact {
  verifyMode?: unknown;
  appPath?: string | null;
  sidecarPath?: string | null;
  candidateComponents?: ExactCandidateComponentDigests | null;
}

interface InsertionEvidence {
  required: boolean;
  valid: boolean;
  markdownPath: string | null;
  jsonPath: string | null;
  verifyMode: string | null;
  candidateProvenance?: ReturnType<typeof evaluateCandidateEvidenceProvenance>;
  summary: string;
}

function valueFor(name: string): string | null;
function valueFor<T extends string | null | undefined>(name: string, fallback: T): string | T;
function valueFor(
  name: string,
  fallback: string | null | undefined = null,
): string | null | undefined {
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
const requestedCandidateApp = valueFor("--candidate-app", "release/mac-arm64/Plainsong.app");
const resolvedCandidateAppPath = path.resolve(repoRoot, requestedCandidateApp);
const candidateAppPath = fs.existsSync(resolvedCandidateAppPath)
  ? fs.realpathSync(resolvedCandidateAppPath)
  : resolvedCandidateAppPath;
const appReceiptBinding = captureAppReceiptBinding(candidateAppPath);
const requestedEquivalence = valueFor("--equivalence", null);
const equivalencePath = requestedEquivalence
  ? path.resolve(repoRoot, requestedEquivalence)
  : null;
const insertionVerifierPath = path.join(
  repoRoot,
  "scripts",
  "verify-packaged-macos-app-matrix-insertion.ts"
);

const appCandidates: Record<string, string[]> = {
  "Apple Notes": [
    "/System/Applications/Notes.app",
    "/Applications/Notes.app",
  ],
  "Google Docs (Chrome)": ["/Applications/Google Chrome.app"],
  Slack: ["/Applications/Slack.app"],
  Notion: ["/Applications/Notion.app"],
  "VS Code": ["/Applications/Visual Studio Code.app"],
  Messages: [
    "/System/Applications/Messages.app",
    "/Applications/Messages.app",
  ],
  "HubSpot (Chrome)": ["/Applications/Google Chrome.app"],
};

function normalizeAppName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
}

function envNameForScratchTarget(app: unknown): string {
  return `PLAINSONG_QA_SCRATCH_${String(app ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function captureCommandFor(app: string): string {
  return `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "${String(app).replaceAll('"', '\\"')}" --scratch-target "$${envNameForScratchTarget(app)}"`;
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

const componentEquivalence = equivalencePath
  ? readJson<ComponentEquivalenceArtifact>(equivalencePath)
  : null;

function canonicalExistingPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return fs.realpathSync(path.resolve(repoRoot, value));
  } catch {
    return null;
  }
}

function componentDigestsForApp(bundlePath: string | null): ExactCandidateComponentDigests | null {
  if (!bundlePath) return null;
  const components = {
    appAsar: path.join(bundlePath, "Contents", "Resources", "app.asar"),
    sidecar: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    shortcutHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    speechHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ),
  };
  // Object.fromEntries forgets the key set; it is exactly the four components above.
  return Object.fromEntries(
    Object.entries(components).map(([name, filePath]) => [
      name,
      fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
        : null,
    ]),
  ) as unknown as ExactCandidateComponentDigests;
}

const candidateComponents = componentDigestsForApp(candidateAppPath);

function writeText(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function shellOut(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function parseAppMatrix(filePath: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let platform: string | null = null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^##\s+/i.test(line)) {
      platform = line.replace(/^##\s+/i, "").trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4 || cells[0] === "App" || cells[0] === "---") continue;
    if (platform !== "macOS") continue;
    const hasLaunchGate = cells.length >= 5;
    rows.push({
      platform,
      app: cells[0],
      status: cells[1],
      modeUsed: cells[2],
      launchGate: hasLaunchGate ? cells[3] : "REQUIRED",
      notes: hasLaunchGate ? cells[4] : cells[3],
    });
  }
  return rows;
}

function parseBlockedRegister(filePath: string): BlockedEntry[] {
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

function packagedScenariosByApp(
  benchmark: PackagedBenchmark | null,
): Map<string, (string | undefined)[]> {
  const byApp = new Map<string, (string | undefined)[]>();
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

function installedPathsFor(app: string): string[] {
  const candidates = appCandidates[app] ?? [];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function spotlightPathsFor(app: string): string[] {
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

function evidenceMarkdownPathFromNotes(notes: unknown): string | null {
  const match = /Packaged insertion verified in `([^`]+\.md)`/i.exec(String(notes ?? ""));
  if (!match) return null;
  const resolved = path.resolve(repoRoot, match[1]);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function verifyLinkedInsertionEvidence(row: MatrixRow): InsertionEvidence {
  if (row.launchGate === "DEFERRED" || row.status === "DEFERRED") {
    return {
      required: false,
      valid: false,
      markdownPath: null,
      jsonPath: null,
      verifyMode: null,
      summary: "This optional compatibility row is deferred and does not require v1 evidence.",
    };
  }
  const statusEligible = row.status === "SUPPORTED" || row.status === "PARTIAL";
  if (!statusEligible) {
    return {
      required: false,
      valid: false,
      markdownPath: null,
      jsonPath: null,
      verifyMode: null,
      summary: "The row is still pending real packaged insertion evidence.",
    };
  }

  const evidenceMarkdownPath = evidenceMarkdownPathFromNotes(row.notes);
  if (!evidenceMarkdownPath) {
    return {
      required: true,
      valid: false,
      markdownPath: null,
      jsonPath: null,
      verifyMode: null,
      summary:
        "The row status requires a repository-relative `Packaged insertion verified in` Markdown link.",
    };
  }
  const evidenceJsonPath = evidenceMarkdownPath.replace(/\.md$/i, ".json");
  if (!fs.existsSync(evidenceMarkdownPath) || !fs.existsSync(evidenceJsonPath)) {
    return {
      required: true,
      valid: false,
      markdownPath: path.relative(repoRoot, evidenceMarkdownPath),
      jsonPath: path.relative(repoRoot, evidenceJsonPath),
      verifyMode: null,
      summary: "The linked Markdown and JSON evidence pair does not exist.",
    };
  }

  let artifact: LinkedInsertionArtifact | null;
  try {
    artifact = readJson<LinkedInsertionArtifact>(evidenceJsonPath);
  } catch (error) {
    return {
      required: true,
      valid: false,
      markdownPath: path.relative(repoRoot, evidenceMarkdownPath),
      jsonPath: path.relative(repoRoot, evidenceJsonPath),
      verifyMode: null,
      summary: `The linked JSON evidence is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const verifyMode = String(artifact?.verifyMode ?? "");
  const result = spawnSync(
    process.execPath,
    [
      insertionVerifierPath,
      ...(candidateAppPath ? ["--candidate-app", candidateAppPath] : []),
      "--target-app",
      row.app,
      "--verify-mode",
      verifyMode,
      "--file",
      evidenceJsonPath,
      "--markdown",
      evidenceMarkdownPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );
  const artifactAppPath = canonicalExistingPath(artifact?.appPath);
  const artifactSidecarPath = canonicalExistingPath(artifact?.sidecarPath);
  const candidateProvenance = evaluateCandidateEvidenceProvenance({
    artifactAppPath,
    artifactSidecarPath,
    candidateAppPath,
    artifactComponents: artifact?.candidateComponents,
    candidateComponents,
    equivalence: componentEquivalence,
  });
  const canonicalVerifierPassed = result.status === 0;
  const fullBundleMatches = appReceiptBinding !== null && appReceiptMatchesBinding(artifact, appReceiptBinding);
  const valid = canonicalVerifierPassed && candidateProvenance.valid && fullBundleMatches;
  return {
    required: true,
    valid,
    markdownPath: path.relative(repoRoot, evidenceMarkdownPath),
    jsonPath: path.relative(repoRoot, evidenceJsonPath),
    verifyMode: verifyMode || null,
    candidateProvenance,
    summary: valid
      ? `${(result.stdout ?? "").trim()} ${candidateProvenance.summary}`.trim()
      : !fullBundleMatches
        ? "Insertion evidence does not match the full candidate app bundle or lacks an unchanged-app marker."
        : !candidateProvenance.valid
        ? candidateProvenance.summary
        : (result.stderr ?? "").trim() ||
        (result.stdout ?? "").trim() ||
        `Insertion verifier exited ${result.status}.`,
  };
}

const generatedAt = new Date().toISOString();
const matrixRows = parseAppMatrix(matrixPath);
const blockedEntries = parseBlockedRegister(blockedRegisterPath);
const packagedBenchmark = readJson<PackagedBenchmark>(packagedBenchmarkPath);
const packagedScenarios = packagedScenariosByApp(packagedBenchmark);

const rows = matrixRows.map((row) => {
  const requiredForLaunch = row.launchGate === "REQUIRED";
  const directInstalledPaths = requiredForLaunch ? installedPathsFor(row.app) : [];
  const spotlightPaths = requiredForLaunch ? spotlightPathsFor(row.app) : [];
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
    requiredForLaunch &&
    row.status === "PENDING" &&
    installedPaths.length > 0 &&
    openBlockedEntries.length === 0;
  const captureCommand = canAttemptManualCapture ? captureCommandFor(row.app) : null;
  const insertionEvidence = verifyLinkedInsertionEvidence(row);
  const launchReady =
    insertionEvidence.valid === true && openBlockedEntries.length === 0;
  const launchGateSatisfied = !requiredForLaunch || launchReady;
  const launchReadyReason = !requiredForLaunch
    ? "This optional compatibility row is explicitly deferred and does not block the v1 release gate."
    : launchReady
      ? "The matrix status is supported or partial, the linked insertion artifact matches the full candidate bundle and passes the canonical verifier, and no blocked-app entry remains open."
      : insertionEvidence.required && !insertionEvidence.valid
        ? `The matrix status claims support, but the linked evidence is invalid: ${insertionEvidence.summary}`
        : openBlockedEntries.length > 0
          ? `Blocked-app entries remain open: ${openBlockedEntries.join(", ")}.`
          : "Real packaged insertion evidence has not been captured and verified yet.";

  return {
    ...row,
    requiredForLaunch,
    appInstalled: installedPaths.length > 0,
    installedPaths,
    packagedBenchmarkCovered: packagedScenarioIds.length > 0,
    packagedScenarioIds,
    openBlockedEntries,
    canAttemptManualCapture,
    scratchTargetEnv: canAttemptManualCapture ? envNameForScratchTarget(row.app) : null,
    captureCommand,
    insertionEvidence,
    launchReady,
    launchGateSatisfied,
    launchReadyReason,
  };
});

const requiredRows = rows.filter((row) => row.requiredForLaunch);
const summary = {
  total: rows.length,
  required: requiredRows.length,
  deferred: rows.length - requiredRows.length,
  installed: rows.filter((row) => row.appInstalled).length,
  packagedBenchmarkCovered: rows.filter((row) => row.packagedBenchmarkCovered).length,
  openBlockedEntries: new Set(rows.flatMap((row) => row.openBlockedEntries)).size,
  openRequiredBlockedEntries: new Set(
    requiredRows.flatMap((row) => row.openBlockedEntries)
  ).size,
  manualCaptureCandidates: rows.filter((row) => row.canAttemptManualCapture).length,
  launchReady: rows.filter((row) => row.launchReady).length,
  requiredLaunchReady: requiredRows.filter((row) => row.launchReady).length,
  launchGateSatisfied: rows.filter((row) => row.launchGateSatisfied).length,
};
const pass = summary.requiredLaunchReady === summary.required;

const reportData = {
  generatedAt,
  pass,
  status: pass ? "PASS" : "BLOCKED",
  matrixPath,
  blockedRegisterPath,
  packagedBenchmarkPath,
  candidateAppPath,
  equivalencePath,
  summary,
  rows,
};

const report = appReceiptBinding ? bindAppReceipt(reportData, appReceiptBinding) : { ...reportData, pass: false };
if (!report.pass) report.status = "BLOCKED";

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
    const evidence = row.insertionEvidence.valid
      ? `verified (${row.insertionEvidence.verifyMode})`
      : row.insertionEvidence.required
        ? "invalid linked evidence"
        : "missing";
    const next = !row.requiredForLaunch
      ? "deferred from v1"
      : row.launchReady
      ? "none"
      : row.insertionEvidence.required && !row.insertionEvidence.valid
        ? "repair linked evidence"
        : row.canAttemptManualCapture
          ? "capture real packaged insertion"
          : row.appInstalled
            ? "resolve blocked entry or scenario gap"
            : "install target app before capture";
    const gateSatisfied = row.launchGateSatisfied ? "yes" : "no";
    return `| ${row.app} | ${row.modeUsed} | ${row.launchGate} | ${gateSatisfied} | ${installed} | ${evidence} | ${packaged} | ${blocked} | ${scratchTargetEnv} | ${captureCommand} | ${next} |`;
  })
  .join("\n");

writeJson(outPath, report);
writeText(
  markdownPath,
  `# macOS Dictation App Matrix Preflight

Status: ${report.status}
Generated: ${generatedAt}

This preflight certifies a \`REQUIRED\` \`SUPPORTED\` or \`PARTIAL\` row only when its linked JSON and Markdown pair passes the canonical packaged insertion verifier. The capture must match the full bundle digest of \`--candidate-app\` and record that the app remained unchanged. The default is \`release/mac-arm64/Plainsong.app\`. It never promotes a \`PENDING\` row. \`DEFERRED\` rows are reported as compatibility backlog and do not block v1.

## Summary

- Matrix rows: ${summary.total}
- Required launch rows: ${summary.required}
- Deferred compatibility rows: ${summary.deferred}
- Installed target apps found: ${summary.installed}
- Rows covered by packaged benchmark fixtures: ${summary.packagedBenchmarkCovered}
- Open blocked-app entries: ${summary.openBlockedEntries}
- Open blocked-app entries on required rows: ${summary.openRequiredBlockedEntries}
- Manual capture candidates: ${summary.manualCaptureCandidates}
- Required launch-ready rows certified by this artifact: ${summary.requiredLaunchReady}

## Rows

| App | Mode | Launch gate | Gate satisfied | Installed | Linked insertion evidence | Packaged benchmark scenarios | Open blocked entries | Scratch target env | Capture command | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${markdownRows}

## Required Follow-Up

- Capture real packaged insertion behavior only for a missing \`REQUIRED\` row.
- Use the per-row capture command only for a required manual capture candidate.
- Update \`docs/dictation-app-compatibility-matrix.md\` only after real insertion evidence exists.
- Keep every required \`SUPPORTED\` or \`PARTIAL\` row linked to a verifier-clean JSON and Markdown pair.
- Deferred rows may remain open as compatibility backlog without blocking v1.
`
);

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
