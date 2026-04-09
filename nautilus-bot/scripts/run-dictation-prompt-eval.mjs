#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) {
    return fallback;
  }
  return args[index + 1];
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
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

function writeFile(relativePath, content) {
  const outputPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${content.trimEnd()}\n`, "utf8");
}

function renderTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].filter(Boolean).join("\n");
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

const benchmarkFixtures = valueFor(
  "--benchmark-fixtures",
  "docs/evals/dictation-parity-fixture.json"
);
const evidenceFixtures = valueFor(
  "--evidence-fixtures",
  "docs/evals/dictation-quality-fixtures.json"
);
const generatedAt = new Date().toISOString();
const parityEvidenceOut = valueFor(
  "--parity-out",
  "artifacts/dictation-prompt-eval.raw.json"
);
const evalOut = valueFor(
  "--out",
  "artifacts/dictation-prompt-eval.json"
);
const reportOut = valueFor(
  "--report-out",
  "docs/evals/dictation-prompt-eval-report.md"
);

run("cargo", [
  "run",
  "--manifest-path",
  "rust-sidecar/Cargo.toml",
  "--bin",
  "dictation-parity-evidence",
  "--",
  "--benchmark-fixtures",
  benchmarkFixtures,
  "--evidence-fixtures",
  evidenceFixtures,
  "--out",
  parityEvidenceOut,
  "--generated-at",
  generatedAt,
]);

const parityEvidence = readJson(parityEvidenceOut);

const relevantChecks = [
  ...parityEvidence.commandCases.map((item) => ({
    group: "command_prompts",
    id: item.id,
    label: item.label,
    expected: item.expectNoCommand
      ? "no command"
      : item.expectedCommand ?? "none",
    actual: item.actualCommand ?? "none",
    pass: item.pass,
  })),
  ...parityEvidence.formattingCases.map((item) => ({
    group: "formatting_prompts",
    id: item.id,
    label: item.label,
    expected: item.expectedOutput,
    actual: item.actualOutput,
    pass: item.pass,
  })),
  ...parityEvidence.correctionCases.map((item) => ({
    group: "rewrite_and_correction",
    id: item.id,
    label: item.label,
    expected: item.expectedOutput,
    actual: item.actualOutput,
    pass: item.pass,
  })),
];

const groups = [
  {
    key: "command_prompts",
    label: "Command grammar",
    cases: relevantChecks.filter((item) => item.group === "command_prompts"),
    successRate: parityEvidence.summary.commandSuccessRate,
  },
  {
    key: "formatting_prompts",
    label: "Formatting and mode transforms",
    cases: relevantChecks.filter((item) => item.group === "formatting_prompts"),
    successRate: parityEvidence.summary.formattingSuccessRate,
  },
  {
    key: "rewrite_and_correction",
    label: "Correction and rewrite helpers",
    cases: relevantChecks.filter((item) => item.group === "rewrite_and_correction"),
    successRate: parityEvidence.summary.correctionSuccessRate,
  },
];

const allPass = groups.every((group) => group.cases.every((item) => item.pass));

const artifact = {
  generatedAt,
  sourceArtifacts: {
    benchmarkFixtures,
    evidenceFixtures,
    parityEvidence: parityEvidenceOut,
  },
  summary: {
    allPass,
    commandSuccessRate: parityEvidence.summary.commandSuccessRate,
    formattingSuccessRate: parityEvidence.summary.formattingSuccessRate,
    correctionSuccessRate: parityEvidence.summary.correctionSuccessRate,
  },
  groups,
};

writeFile(evalOut, JSON.stringify(artifact, null, 2));

writeFile(
  reportOut,
  `# Dictation Prompt Eval Report

Generated: ${generatedAt}

This report promotes the dictation prompt and text-shaping fixture path into an explicit regression harness. It is the repo-owned answer to prompt-eval drift: command grammar, formatting output, and correction behavior must stay reproducible.

## Summary

- Command grammar: ${formatPercent(artifact.summary.commandSuccessRate)}
- Formatting and mode transforms: ${formatPercent(
    artifact.summary.formattingSuccessRate
  )}
- Correction and rewrite helpers: ${formatPercent(
    artifact.summary.correctionSuccessRate
  )}
- Overall: ${artifact.summary.allPass ? "PASS" : "FAIL"}

## Command grammar

${renderTable(
  ["ID", "Label", "Expected", "Actual", "Pass"],
  groups[0].cases.map((item) => [
    item.id,
    item.label,
    item.expected,
    item.actual,
    item.pass ? "PASS" : "FAIL",
  ])
)}

## Formatting and mode transforms

${renderTable(
  ["ID", "Label", "Expected", "Actual", "Pass"],
  groups[1].cases.map((item) => [
    item.id,
    item.label,
    item.expected,
    item.actual,
    item.pass ? "PASS" : "FAIL",
  ])
)}

## Correction and rewrite helpers

${renderTable(
  ["ID", "Label", "Expected", "Actual", "Pass"],
  groups[2].cases.map((item) => [
    item.id,
    item.label,
    item.expected,
    item.actual,
    item.pass ? "PASS" : "FAIL",
  ])
)}
`
);

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);

if (!allPass) {
  process.exit(1);
}
