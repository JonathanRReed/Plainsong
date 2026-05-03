#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const registerPath = path.join(repoRoot, "docs/strict-release-blocker-register.md");
const blockersPath = path.join(repoRoot, "artifacts/release-blockers.json");

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

if (!fs.existsSync(registerPath)) {
  fail("Strict release blocker register is missing.");
}
if (!fs.existsSync(blockersPath)) {
  fail("Release blockers artifact is missing.");
}

const register = fs.readFileSync(registerPath, "utf8");
const blockers = JSON.parse(fs.readFileSync(blockersPath, "utf8"));
const violations = [];
const expectedRows = [
  {
    id: "BR-001",
    gate: "cloud-asr-smoke",
    evidence: ["artifacts/cloud-asr-smoke.blocked.md"],
  },
  {
    id: "BR-002",
    gate: "benchmark-gates-packaged",
    evidence: [
      "artifacts/benchmark-packaged.blocked.md",
      "artifacts/benchmark-gates-packaged-macos.json",
      "docs/evals/benchmark-run-packaged-macos.json",
      "scripts/capture-packaged-windows-dictation-benchmark.mjs",
    ],
  },
  {
    id: "BR-003",
    gate: "dictation-app-matrix",
    evidence: [
      "artifacts/dictation-app-matrix-gate.json",
      "artifacts/qa/macos/app-matrix-preflight.md",
      "artifacts/qa/macos/app-matrix-insertion-apple-notes.md",
      "docs/dictation-app-compatibility-matrix.md",
      "docs/dictation-blocked-app-register.md",
    ],
  },
  {
    id: "BR-004",
    gate: "apple-release-signing",
    evidence: [
      "artifacts/qa/macos/security-gatekeeper.md",
      "artifacts/qa/macos/security-notarization.md",
    ],
  },
  {
    id: "BR-005",
    gate: "windows-release-signing",
    evidence: [
      "artifacts/qa/windows/security-authenticode.md",
      "artifacts/qa/windows/security-smartscreen.md",
    ],
  },
  {
    id: "BR-006",
    gate: "packaged-qa-matrix",
    evidence: ["docs/packaged-app-qa-matrix.md", "artifacts/packaged-qa-evidence-bundle.json"],
  },
];
const expectedGates = expectedRows.map((row) => row.gate);
const blockerGates = (blockers.blockers ?? []).map((blocker) => blocker.gate).sort();
const blockersByGate = new Map((blockers.blockers ?? []).map((blocker) => [blocker.gate, blocker]));

if (blockers.strictReady !== false) {
  violations.push("release-blockers strictReady must remain false until every blocker is cleared.");
}
if (JSON.stringify(blockerGates) !== JSON.stringify([...expectedGates].sort())) {
  violations.push("release-blockers gate list does not match the strict register gate set.");
}
if (!register.includes("Strict readiness: **NO-GO**")) {
  violations.push("Strict register must state NO-GO while release-blockers strictReady is false.");
}

for (const expected of expectedRows) {
  const blocker = blockersByGate.get(expected.gate);
  if (!blocker) {
    violations.push(`release-blockers is missing expected gate ${expected.gate}.`);
    continue;
  }
  if (blocker.status !== "BLOCKED") {
    violations.push(`${expected.gate} must remain BLOCKED while listed in release-blockers.`);
  }
  if (!register.includes(`| ${expected.id} |`)) {
    violations.push(`Strict register is missing ${expected.id}.`);
  }
  if (!register.includes(blocker.evidence)) {
    violations.push(`Strict register is missing evidence path ${blocker.evidence}.`);
  }
  for (const evidencePath of expected.evidence) {
    if (!register.includes(evidencePath)) {
      violations.push(`Strict register ${expected.id} is missing expected evidence ${evidencePath}.`);
    }
    if (!fs.existsSync(path.join(repoRoot, evidencePath))) {
      violations.push(`Strict register ${expected.id} evidence path does not exist: ${evidencePath}.`);
    }
  }
  if (!fs.existsSync(path.join(repoRoot, blocker.evidence))) {
    violations.push(`Release blocker evidence path does not exist: ${blocker.evidence}.`);
  }
}

for (const blocker of blockers.blockers ?? []) {
  if (!blocker.gate || !blocker.status || !blocker.evidence || !blocker.reason) {
    violations.push(`Release blocker is malformed: ${blocker.gate ?? "missing gate"}.`);
  }
  if (!expectedGates.includes(blocker.gate)) {
    violations.push(`Strict register has no expected row for gate ${blocker.gate}.`);
  }
  if (!register.includes(blocker.evidence)) {
    violations.push(`Strict register is missing current blocker evidence ${blocker.evidence}.`);
  }
}

const qa = blockers.observations?.qaSummary;
let qaSummary = null;
if (!qa) {
  violations.push("release-blockers is missing qaSummary.");
} else {
  qaSummary = `${qa.pass} PASS / ${qa.blocked} BLOCKED / ${qa.pending} PENDING`;
  if (!register.includes(qaSummary)) {
    violations.push(`Strict register is missing current QA summary ${qaSummary}.`);
  }
}

const requiredArtifacts = [
  "artifacts/launch-readiness-report.json",
  "docs/launch-readiness-dashboard.md",
  "artifacts/packaged-qa-evidence-bundle.json",
  "artifacts/release-blockers.json",
  "artifacts/cloud-asr-smoke.blocked.md",
  "artifacts/benchmark-packaged.blocked.md",
  "artifacts/dictation-app-matrix-gate.json",
  "artifacts/qa/macos/app-matrix-preflight.md",
  "artifacts/qa/macos/app-matrix-insertion-apple-notes.md",
  "artifacts/qa/macos/idle-cpu-baseline.md",
  "artifacts/qa/macos/update-metadata.md",
  "artifacts/qa/macos/exports.md",
  "artifacts/qa/macos/capture-soak-3h.md",
];

for (const artifact of requiredArtifacts) {
  if (!register.includes(artifact)) {
    violations.push(`Strict register artifact list is missing ${artifact}.`);
  }
  if (!fs.existsSync(path.join(repoRoot, artifact))) {
    violations.push(`Strict register artifact path does not exist: ${artifact}.`);
  }
}

if (violations.length > 0) {
  fail(`Strict release blocker register validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Strict release blocker register validation passed: ${blockerGates.length} blockers, ${qaSummary}.`
);
