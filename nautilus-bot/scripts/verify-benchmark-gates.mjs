#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const schemaPath = path.resolve(
  process.cwd(),
  valueFor("--schema", "docs/evals/benchmark-run.schema.json")
);
const baselinePath = path.resolve(
  process.cwd(),
  valueFor("--baseline", "docs/evals/benchmark-run-baseline.json")
);
const candidatePath = path.resolve(
  process.cwd(),
  valueFor("--candidate", "docs/evals/benchmark-run-latest.json")
);
const outputPath = valueFor("--out")
  ? path.resolve(process.cwd(), valueFor("--out"))
  : null;

const commandMin = Number(valueFor("--command-min", "0.95"));
const snippetMin = Number(valueFor("--snippet-min", "0.99"));
const latencyImprovementMin = Number(valueFor("--latency-improvement-min", "0.25"));
const FLOAT_TOLERANCE = 1e-9;

if (!Number.isFinite(commandMin) || !Number.isFinite(snippetMin) || !Number.isFinite(latencyImprovementMin)) {
  console.error("Invalid thresholds supplied. command/snippet/latency values must be numeric.");
  process.exit(1);
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} file not found: ${filePath}`);
    process.exit(1);
  }
}

function runSchemaValidation(filePath) {
  const validatorPath = path.resolve(process.cwd(), "scripts/validate-gate-artifact.mjs");
  const result = spawnSync(
    process.execPath,
    [validatorPath, "--schema", schemaPath, "--file", filePath],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    if (result.stdout.trim()) process.stderr.write(`${result.stdout}\n`);
    if (result.stderr.trim()) process.stderr.write(`${result.stderr}\n`);
    process.exit(result.status ?? 1);
  }
}

function passesMinimum(actual, required) {
  return actual > required || Math.abs(actual - required) <= FLOAT_TOLERANCE;
}

assertFileExists(schemaPath, "Schema");
assertFileExists(baselinePath, "Baseline benchmark");
assertFileExists(candidatePath, "Candidate benchmark");

runSchemaValidation(baselinePath);
runSchemaValidation(candidatePath);

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));

const rows = Array.isArray(candidate.rows) ? candidate.rows : [];
if (rows.length === 0) {
  console.error("Candidate benchmark has no rows.");
  process.exit(1);
}

const providerIntegrityIssues = [];
rows.forEach((row, idx) => {
  if (typeof row.requestedProvider !== "string" || row.requestedProvider.trim().length === 0) {
    providerIntegrityIssues.push(`row ${idx}: requestedProvider missing/empty`);
  }
  if (typeof row.actualProvider !== "string" || row.actualProvider.trim().length === 0) {
    providerIntegrityIssues.push(`row ${idx}: actualProvider missing/empty`);
  }
  if (typeof row.isFallback !== "boolean") {
    providerIntegrityIssues.push(`row ${idx}: isFallback must be boolean`);
  }
  if (typeof row.endToEndMs !== "number" || row.endToEndMs < 0) {
    providerIntegrityIssues.push(`row ${idx}: endToEndMs must be a non-negative number`);
  }
});

const baselineP50 = Number(baseline?.summary?.p50EndToEndMs);
const candidateP50 = Number(candidate?.summary?.p50EndToEndMs);
const commandSuccessRate = Number(candidate?.summary?.commandSuccessRate);
const snippetSuccessRate = Number(candidate?.summary?.snippetSuccessRate);

if (!Number.isFinite(baselineP50) || baselineP50 <= 0) {
  console.error("Baseline summary.p50EndToEndMs must be a positive number.");
  process.exit(1);
}
if (!Number.isFinite(candidateP50) || candidateP50 < 0) {
  console.error("Candidate summary.p50EndToEndMs must be a non-negative number.");
  process.exit(1);
}

const latencyImprovement = (baselineP50 - candidateP50) / baselineP50;

const checks = [
  {
    id: "cp13-command-success",
    pass: passesMinimum(commandSuccessRate, commandMin),
    actual: commandSuccessRate,
    required: commandMin,
    comparator: ">=",
  },
  {
    id: "cp14-snippet-success",
    pass: passesMinimum(snippetSuccessRate, snippetMin),
    actual: snippetSuccessRate,
    required: snippetMin,
    comparator: ">=",
  },
  {
    id: "cp15-latency-improvement",
    pass: passesMinimum(latencyImprovement, latencyImprovementMin),
    actual: latencyImprovement,
    required: latencyImprovementMin,
    comparator: ">=",
  },
  {
    id: "cp15-provider-integrity",
    pass: providerIntegrityIssues.length === 0,
    actual: providerIntegrityIssues.length === 0 ? "ok" : providerIntegrityIssues.length,
    required: "0 issues",
    comparator: "==",
    details: providerIntegrityIssues,
  },
];

const result = {
  generatedAt: new Date().toISOString(),
  baselinePath,
  candidatePath,
  schemaPath,
  thresholds: {
    commandMin,
    snippetMin,
    latencyImprovementMin,
  },
  metrics: {
    baselineP50EndToEndMs: baselineP50,
    candidateP50EndToEndMs: candidateP50,
    latencyImprovement,
    commandSuccessRate,
    snippetSuccessRate,
  },
  checks,
  pass: checks.every((check) => check.pass),
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(result, null, 2));

if (!result.pass) {
  process.exit(1);
}
