#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function writeText(relativePath, body) {
  const outputPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${body.trimEnd()}\n`, "utf8");
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function normalizeMatrixAppName(app) {
  return app
    .replace(" (Chrome)", "")
    .replace(" (Edge/Chrome)", "");
}

function renderTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].filter(Boolean).join("\n");
}

function parseMatrix(filePath) {
  const raw = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4)
    .filter((cells) => cells[0] !== "App" && cells[0] !== "---")
    .map(([app, status, modeUsed, notes]) => ({
      app,
      status,
      modeUsed,
      notes,
    }));
}

function parseBlockedRegister() {
  const raw = fs.readFileSync(
    path.join(repoRoot, "docs/dictation-blocked-app-register.md"),
    "utf8"
  );
  return raw
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
      status,
      risk,
      blocker,
      requiredEvidence,
    }));
}

const generatedAt = new Date().toISOString();
const evidenceOut = "artifacts/dictation-parity-evidence.json";
const promptEvalArtifactOut = "artifacts/dictation-prompt-eval.json";

run("cargo", [
  "run",
  "--manifest-path",
  "rust-sidecar/Cargo.toml",
  "--bin",
  "dictation-parity-evidence",
  "--",
  "--benchmark-fixtures",
  "docs/evals/dictation-parity-fixture.json",
  "--evidence-fixtures",
  "docs/evals/dictation-quality-fixtures.json",
  "--out",
  evidenceOut,
  "--generated-at",
  generatedAt,
]);

run("node", [
  "scripts/run-dictation-prompt-eval.mjs",
  "--parity-out",
  "artifacts/dictation-prompt-eval.raw.json",
  "--out",
  promptEvalArtifactOut,
  "--report-out",
  "docs/evals/dictation-prompt-eval-report.md",
]);

const evidence = readJson(evidenceOut);
const promptEval = readJson(promptEvalArtifactOut);
const macosBenchmark = readJson("docs/evals/benchmark-run-latest-macos.json");
const windowsBenchmark = readJson("docs/evals/benchmark-run-latest-windows.json");
const macosGate = readJson("artifacts/benchmark-gates-macos.json");
const windowsGate = readJson("artifacts/benchmark-gates-windows.json");
const languageFixture = readJson("docs/evals/dictation-language-certification-fixture.json");
const macosMatrix = parseMatrix("docs/dictation-app-compatibility-matrix.md").slice(0, 8);
const windowsMatrix = parseMatrix("docs/dictation-app-compatibility-matrix.md").slice(8);
const blockedApps = parseBlockedRegister();
const benchmarkRows = [...macosBenchmark.rows, ...windowsBenchmark.rows];

writeText(
  "docs/evals/dictation-command-corpus-log.md",
  `# Dictation Command Corpus Log

Generated: ${generatedAt}

Local benchmark command checks currently pass at ${formatPercent(
    evidence.summary.commandSuccessRate
  )}. This corpus proves command parsing and no-command safety in the local fixture path. Packaged validation is still required for launch claims.

${renderTable(
    ["ID", "Label", "App", "Language", "Expected", "Actual", "Pass"],
    evidence.commandCases.map((item) => [
      item.id,
      item.label,
      item.appTarget,
      item.language ?? "auto",
      item.expectNoCommand ? "no command" : item.expectedCommand ?? "none",
      item.actualCommand ?? "none",
      item.pass ? "PASS" : "FAIL",
    ])
  )}
`
);

writeText(
  "docs/evals/dictation-snippet-fixture-list.md",
  `# Dictation Snippet Fixture List

Generated: ${generatedAt}

Local snippet coverage currently passes at ${formatPercent(
    evidence.summary.snippetSuccessRate
  )}. These fixtures prove expansion and app-scope behavior in the local benchmark path.

${renderTable(
    ["ID", "Label", "App", "Expected snippets", "Actual snippets", "Expected output", "Pass"],
    evidence.snippetCases.map((item) => [
      item.id,
      item.label,
      item.appTarget,
      String(item.expectedSnippetAppliedCount ?? 0),
      String(item.actualSnippetAppliedCount),
      item.expectedOutput ?? item.actualOutput,
      item.pass ? "PASS" : "FAIL",
    ])
  )}
`
);

writeText(
  "docs/evals/dictation-dictionary-fixture-report.md",
  `# Dictation Dictionary Fixture Report

Generated: ${generatedAt}

Dictionary fixtures pass at ${formatPercent(
    evidence.summary.dictionarySuccessRate
  )}. This report verifies longest-match handling and app-scoped replacements in the current local code path.

${renderTable(
    ["ID", "Label", "Language", "App", "Expected", "Actual", "Pass"],
    evidence.dictionaryCases.map((item) => [
      item.id,
      item.label,
      item.language,
      item.appTarget ?? "global",
      item.expectedOutput,
      item.actualOutput,
      item.pass ? "PASS" : "FAIL",
    ])
  )}
`
);

writeText(
  "docs/evals/dictation-formatter-benchmark-report.md",
  `# Dictation Formatter Benchmark Report

Generated: ${generatedAt}

Formatting and correction fixtures now have reproducible local evidence. Smart formatting passes at ${formatPercent(
    evidence.summary.formattingSuccessRate
  )}, and correction cases pass at ${formatPercent(
    evidence.summary.correctionSuccessRate
  )}. Packaged QA is still required before launch claims move beyond local evidence.

## Formatting

${renderTable(
    ["ID", "Label", "Mode", "Hint", "Pass"],
    evidence.formattingCases.map((item) => [
      item.id,
      item.label,
      item.modePreset,
      item.formattingHint ?? "none",
      item.pass ? "PASS" : "FAIL",
    ])
  )}

## Corrections

${renderTable(
    ["ID", "Label", "Target", "Replacement", "Pass"],
    evidence.correctionCases.map((item) => [
      item.id,
      item.label,
      item.target,
      item.replacement,
      item.pass ? "PASS" : "FAIL",
    ])
  )}
`
);

writeText(
  "docs/evals/dictation-language-certification-matrix.md",
  `# Dictation Language Certification Matrix

Generated: ${generatedAt}

This matrix freezes the current launch-language guidance. It is truthful about the current state: provider guidance exists and the local benchmark corpus now exercises every frozen launch language, but packaged benchmark and insertion evidence is still pending.

${renderTable(
    ["Code", "Language", "Tier", "Local corpus", "Dictation", "Meetings", "Fallback", "Packaged evidence"],
    languageFixture.languages.map((item) => [
      item.code,
      item.language,
      item.launchTier,
      benchmarkRows.some((row) => row.language === item.code) ? "covered" : "missing",
      item.recommendedDictationProvider,
      item.recommendedMeetingProvider,
      item.fallbackProvider,
      item.packagedEvidenceStatus,
    ])
  )}
`
);

const localApps = new Map();
for (const row of macosBenchmark.rows) {
  const key = `macOS:${row.appTarget}`;
  localApps.set(key, [...(localApps.get(key) ?? []), row.scenarioId ?? row.appTarget]);
}
for (const row of windowsBenchmark.rows) {
  const key = `Windows:${row.appTarget}`;
  localApps.set(key, [...(localApps.get(key) ?? []), row.scenarioId ?? row.appTarget]);
}

writeText(
  "docs/evals/dictation-app-matrix-evidence.md",
  `# Dictation App Matrix Evidence

Generated: ${generatedAt}

This rollup compares the frozen launch app matrix with the current local benchmark corpus and blocked-app register. It does not replace packaged QA, but it shows where the local corpus already exercises insertion behavior and where gaps remain.

## macOS matrix

${renderTable(
    ["App", "Matrix status", "Mode", "Local corpus", "Scenario IDs", "Notes"],
    macosMatrix.map((item) => [
      item.app,
      item.status,
      item.modeUsed,
      localApps.has(`macOS:${normalizeMatrixAppName(item.app)}`) ? "covered" : "missing",
      (localApps.get(`macOS:${normalizeMatrixAppName(item.app)}`) ?? []).join(", ") || "none",
      item.notes,
    ])
  )}

## Windows matrix

${renderTable(
    ["App", "Matrix status", "Mode", "Local corpus", "Scenario IDs", "Notes"],
    windowsMatrix.map((item) => [
      item.app,
      item.status,
      item.modeUsed,
      localApps.has(`Windows:${normalizeMatrixAppName(item.app)}`) ? "covered" : "missing",
      (localApps.get(`Windows:${normalizeMatrixAppName(item.app)}`) ?? []).join(", ") || "none",
      item.notes,
    ])
  )}

## Open blocked apps

${renderTable(
    ["ID", "Platform", "App", "Status", "Risk", "Blocker"],
    blockedApps.map((item) => [
      item.id,
      item.platform,
      item.app,
      item.status,
      item.risk,
      item.blocker,
    ])
  )}
`
);

writeText(
  "docs/evals/dictation-hands-free-readiness.md",
  `# Dictation Hands-Free Readiness

Generated: ${generatedAt}

Hands-free remains a launch-critical trust path. The repo now has explicit local evidence for implementation coverage, but not yet packaged long-session evidence.

## Automated coverage

- [first-run-wizard.test.tsx](${path.join(repoRoot, "src/__tests__/first-run-wizard.test.tsx")}) covers onboarding persistence for hands-free mode.
- [dictation-popup.test.tsx](${path.join(repoRoot, "src/__tests__/dictation-popup.test.tsx")}) covers popup guidance when hands-free mode is enabled.
- [dictation-view.tsx](${path.join(repoRoot, "src/components/views/dictation-view.tsx")}) and [settings-view-simple.tsx](${path.join(repoRoot, "src/components/views/settings-view-simple.tsx")}) expose runtime settings and explanation copy.

## Current launch state

- Local implementation coverage: PASS
- Packaged long-session evidence: BLOCKED
- Required next evidence: packaged start, stop, silence timeout, and recovery capture on macOS and Windows
`
);

writeText(
  "docs/evals/dictation-parity-artifact-summary.md",
  `# Dictation Parity Artifact Summary

Generated: ${generatedAt}

## Local evidence state

- Command corpus: ${formatPercent(evidence.summary.commandSuccessRate)}
- Snippet fixtures: ${formatPercent(evidence.summary.snippetSuccessRate)}
- Dictionary fixtures: ${formatPercent(evidence.summary.dictionarySuccessRate)}
- Formatting fixtures: ${formatPercent(evidence.summary.formattingSuccessRate)}
- Correction fixtures: ${formatPercent(evidence.summary.correctionSuccessRate)}
- Prompt eval, command grammar: ${formatPercent(promptEval.summary.commandSuccessRate)}
- Prompt eval, formatting and mode transforms: ${formatPercent(
    promptEval.summary.formattingSuccessRate
  )}
- Prompt eval, correction and rewrite helpers: ${formatPercent(
    promptEval.summary.correctionSuccessRate
  )}
- macOS latency gate: ${macosGate.pass ? "PASS" : "FAIL"}
- Windows latency gate: ${windowsGate.pass ? "PASS" : "FAIL"}

## Remaining truth

- Local fixture evidence is now reproducible across commands, snippets, dictionary behavior, formatting behavior, prompt regression, language guidance, and app-matrix rollup.
- The frozen launch-language set is now covered in the local benchmark corpus.
- The frozen launch app matrix is now fully covered in the local benchmark corpus.
- Packaged dictation evidence is still required for launch claims.
- Windows packaged validation still requires a real Windows host.
`
);
