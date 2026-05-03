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

const auditPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/launch-completion-audit.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/launch-completion-audit.md")
);

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function markdownRowFor(item) {
  const evidence = item.evidence.map((entry) => `\`${entry}\``).join("<br>");
  return `| ${item.id} | ${item.state} | ${evidence} | ${item.detail} |`;
}

function incompleteLineFor(item) {
  const required = item.requiredToComplete?.length
    ? ` Required: ${item.requiredToComplete.join(" ")}`
    : "";
  return `- \`${item.id}\`: ${item.detail}${required}`;
}

function isFileEvidence(entry) {
  return entry === "knip.json" || /^(artifacts|docs|scripts|src|electron|rust-sidecar)\//.test(entry);
}

function assertFileEvidenceExists(entry, owner) {
  if (!isFileEvidence(entry)) {
    return;
  }
  if (!fs.existsSync(path.join(repoRoot, entry))) {
    violations.push(`${owner} references missing evidence file: ${entry}`);
  }
}

if (!fs.existsSync(auditPath)) {
  fail(`Completion audit JSON not found: ${path.relative(repoRoot, auditPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Completion audit Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const violations = [];
const checklist = Array.isArray(audit.checklist) ? audit.checklist : [];
const incomplete = Array.isArray(audit.incomplete) ? audit.incomplete : [];
const activeBlockers = Array.isArray(audit.activeBlockers) ? audit.activeBlockers : [];
const externalBlockers = Array.isArray(audit.externalBlockers) ? audit.externalBlockers : [];
const launchUnblockerPackPath = path.join(repoRoot, "artifacts/launch-unblocker-pack.json");
const launchUnblockerPack = fs.existsSync(launchUnblockerPackPath)
  ? JSON.parse(fs.readFileSync(launchUnblockerPackPath, "utf8"))
  : null;
const qaBundlePath = path.join(repoRoot, "artifacts/packaged-qa-evidence-bundle.json");
const qaBundle = fs.existsSync(qaBundlePath)
  ? JSON.parse(fs.readFileSync(qaBundlePath, "utf8"))
  : null;

if (audit.objective !== "Finish NautilusBot so it is at parity or better than credible dictation and meeting-capture alternatives, with everything ready except signing and publishing.") {
  violations.push("Objective text does not match the active launch objective.");
}

const computedIncomplete = checklist.filter(
  (item) => item.launchBlocking && item.state !== "PASS"
);
const competitiveItem = checklist.find((item) => item.id === "competitive-readiness");
if (!competitiveItem) {
  violations.push("Checklist is missing competitive-readiness.");
} else {
  const expectedEvidence = [
    "docs/competitive-readiness-matrix.md",
    "artifacts/launch-readiness-report.json",
    "docs/launch-readiness-dashboard.md",
  ];
  for (const evidence of expectedEvidence) {
    if (!competitiveItem.evidence?.includes(evidence)) {
      violations.push(`competitive-readiness evidence is missing ${evidence}.`);
    }
  }
  if (competitiveItem.launchBlocking !== true) {
    violations.push("competitive-readiness must remain launch-blocking.");
  }
}
const unblockerItem = checklist.find((item) => item.id === "remaining-input-handoff");
if (!unblockerItem) {
  violations.push("Checklist is missing remaining-input-handoff.");
} else {
  const expectedEvidence = [
    "artifacts/launch-unblocker-pack.json",
    "docs/launch-unblocker-pack.md",
    "bun run gate:launch-unblockers",
  ];
  for (const evidence of expectedEvidence) {
    if (!unblockerItem.evidence?.includes(evidence)) {
      violations.push(`remaining-input-handoff evidence is missing ${evidence}.`);
    }
  }
  if (unblockerItem.launchBlocking !== true) {
    violations.push("remaining-input-handoff must remain launch-blocking.");
  }
  if (unblockerItem.state === "PASS") {
    const expectedIncomplete = computedIncomplete.map((item) => item.id).sort();
    const actualIncomplete = [
      ...(launchUnblockerPack?.blockers?.incompleteChecklistItems ?? []),
    ].sort();
    if (!launchUnblockerPack) {
      violations.push("remaining-input-handoff is PASS but launch unblocker pack is missing.");
    } else if (JSON.stringify(actualIncomplete) !== JSON.stringify(expectedIncomplete)) {
      violations.push("Launch unblocker pack incomplete list does not match completion audit.");
    }
  }
}
const secretSafeItem = checklist.find((item) => item.id === "secret-safe-artifacts");
if (!secretSafeItem) {
  violations.push("Checklist is missing secret-safe-artifacts.");
} else {
  const expectedEvidence = [
    "bun run gate:secret-safe-artifacts",
    "scripts/verify-secret-safe-artifacts.mjs",
  ];
  for (const evidence of expectedEvidence) {
    if (!secretSafeItem.evidence?.includes(evidence)) {
      violations.push(`secret-safe-artifacts evidence is missing ${evidence}.`);
    }
  }
  if (secretSafeItem.state !== "PASS") {
    violations.push("secret-safe-artifacts must be PASS after verifier execution.");
  }
  if (secretSafeItem.launchBlocking !== true) {
    violations.push("secret-safe-artifacts must remain launch-blocking.");
  }
}
const qaEvidenceIntegrityItem = checklist.find((item) => item.id === "qa-evidence-integrity");
if (!qaEvidenceIntegrityItem) {
  violations.push("Checklist is missing qa-evidence-integrity.");
} else {
  const expectedEvidence = ["artifacts/packaged-qa-evidence-bundle.json", "bun run gate:qa-matrix"];
  for (const evidence of expectedEvidence) {
    if (!qaEvidenceIntegrityItem.evidence?.includes(evidence)) {
      violations.push(`qa-evidence-integrity evidence is missing ${evidence}.`);
    }
  }
  if (!qaBundle) {
    violations.push("qa-evidence-integrity cannot be checked because the QA bundle is missing.");
  } else {
    const summary = qaBundle.summary ?? {};
    const platformCounts = summary.byPlatform ?? {};
    const missingPlatform = summary.missingPlatform ?? null;
    if (summary.missingEvidence !== 0) {
      violations.push("qa-evidence-integrity requires zero missing evidence files.");
    }
    if (summary.mismatchedEvidenceStatus !== 0) {
      violations.push("qa-evidence-integrity requires zero mismatched evidence statuses.");
    }
    if (missingPlatform !== 0) {
      violations.push("qa-evidence-integrity requires zero missing platform rows.");
    }
    if (platformCounts.macOS?.total !== 27 || platformCounts.Windows?.total !== 25) {
      violations.push("QA bundle platform counts must remain 27 macOS rows and 25 Windows rows.");
    }
    if (qaEvidenceIntegrityItem.state !== "PASS") {
      violations.push("qa-evidence-integrity must be PASS after QA bundle verifier execution.");
    }
  }
  if (qaEvidenceIntegrityItem.launchBlocking !== true) {
    violations.push("qa-evidence-integrity must remain launch-blocking.");
  }
}
const productionReadinessMarkersItem = checklist.find(
  (item) => item.id === "production-readiness-markers"
);
if (!productionReadinessMarkersItem) {
  violations.push("Checklist is missing production-readiness-markers.");
} else {
  const expectedEvidence = [
    "bun run gate:production-readiness-markers",
    "scripts/verify-production-readiness-markers.mjs",
  ];
  for (const evidence of expectedEvidence) {
    if (!productionReadinessMarkersItem.evidence?.includes(evidence)) {
      violations.push(`production-readiness-markers evidence is missing ${evidence}.`);
    }
  }
  if (productionReadinessMarkersItem.state !== "PASS") {
    violations.push("production-readiness-markers must be PASS after verifier execution.");
  }
  if (productionReadinessMarkersItem.launchBlocking !== true) {
    violations.push("production-readiness-markers must remain launch-blocking.");
  }
}
const deadCodeItem = checklist.find((item) => item.id === "dead-code-cleanup");
if (!deadCodeItem) {
  violations.push("Checklist is missing dead-code-cleanup.");
} else {
  const expectedEvidence = [
    "bun run gate:dead-code",
    "scripts/verify-dead-code-hygiene.mjs",
    "bun run lint",
    "knip.json",
  ];
  for (const evidence of expectedEvidence) {
    if (!deadCodeItem.evidence?.includes(evidence)) {
      violations.push(`dead-code-cleanup evidence is missing ${evidence}.`);
    }
  }
  if (deadCodeItem.state !== "PASS") {
    violations.push("dead-code-cleanup must be PASS after dead-code gate execution.");
  }
  if (deadCodeItem.launchBlocking !== true) {
    violations.push("dead-code-cleanup must remain launch-blocking.");
  }
}
const docCommandHygieneItem = checklist.find((item) => item.id === "doc-command-hygiene");
if (!docCommandHygieneItem) {
  violations.push("Checklist is missing doc-command-hygiene.");
} else {
  const expectedEvidence = [
    "bun run gate:doc-command-hygiene",
    "scripts/verify-doc-command-hygiene.mjs",
  ];
  for (const evidence of expectedEvidence) {
    if (!docCommandHygieneItem.evidence?.includes(evidence)) {
      violations.push(`doc-command-hygiene evidence is missing ${evidence}.`);
    }
  }
  if (docCommandHygieneItem.state !== "PASS") {
    violations.push("doc-command-hygiene must be PASS after verifier execution.");
  }
  if (docCommandHygieneItem.launchBlocking !== true) {
    violations.push("doc-command-hygiene must remain launch-blocking.");
  }
}
const blockerRegisterItem = checklist.find((item) => item.id === "blocker-register-consistency");
if (!blockerRegisterItem) {
  violations.push("Checklist is missing blocker-register-consistency.");
} else {
  const expectedEvidence = [
    "bun run gate:blocker-register",
    "docs/strict-release-blocker-register.md",
    "scripts/verify-strict-release-blocker-register.mjs",
  ];
  for (const evidence of expectedEvidence) {
    if (!blockerRegisterItem.evidence?.includes(evidence)) {
      violations.push(`blocker-register-consistency evidence is missing ${evidence}.`);
    }
  }
  if (blockerRegisterItem.state !== "PASS") {
    violations.push("blocker-register-consistency must be PASS after verifier execution.");
  }
  if (blockerRegisterItem.launchBlocking !== true) {
    violations.push("blocker-register-consistency must remain launch-blocking.");
  }
}
if (audit.completionReadyExcludingSigningAndPublishing !== (computedIncomplete.length === 0)) {
  violations.push("completionReadyExcludingSigningAndPublishing does not match launch-blocking checklist state.");
}
const expectedStatus = computedIncomplete.length === 0 ? "READY_EXCEPT_SIGNING_AND_PUBLISHING" : "NO-GO";
if (audit.status !== expectedStatus) {
  violations.push(`Status ${audit.status} does not match expected ${expectedStatus}.`);
}
if (!markdown.includes(`Status: \`${audit.status}\``)) {
  violations.push("Markdown status does not match JSON status.");
}
if (!markdown.includes(audit.objective)) {
  violations.push("Markdown objective does not match JSON objective.");
}

const incompleteIds = new Set(incomplete.map((item) => item.id));
for (const item of computedIncomplete) {
  if (!incompleteIds.has(item.id)) {
    violations.push(`Incomplete list is missing launch-blocking item: ${item.id}.`);
  }
}
for (const item of incomplete) {
  const matching = computedIncomplete.find((candidate) => candidate.id === item.id);
  if (!matching) {
    violations.push(`Incomplete list contains non-blocking or passing item: ${item.id}.`);
    continue;
  }
  if (item.detail !== matching.detail) {
    violations.push(`Incomplete detail for ${item.id} does not match checklist detail.`);
  }
  if (!markdown.includes(incompleteLineFor(item))) {
    violations.push(`Markdown incomplete section is missing ${item.id}.`);
  }
}

for (const item of checklist) {
  if (!item.id || !item.requirement || !item.state || !Array.isArray(item.evidence)) {
    violations.push(`Checklist item is malformed: ${item.id ?? "missing id"}.`);
    continue;
  }
  if (!["PASS", "BLOCKED", "EXTERNAL"].includes(item.state)) {
    violations.push(`${item.id} has invalid state ${item.state}.`);
  }
  if (item.launchBlocking === true && item.state !== "PASS" && !item.requiredToComplete?.length) {
    violations.push(`${item.id} is launch-blocking and incomplete but has no requiredToComplete steps.`);
  }
  for (const evidence of item.evidence) {
    assertFileEvidenceExists(evidence, item.id);
  }
  if (item.id === "signing-and-publishing" && item.launchBlocking !== false) {
    violations.push("signing-and-publishing must remain non-launch-blocking in this completion audit.");
  }
  if (!markdown.includes(markdownRowFor(item))) {
    violations.push(`Markdown checklist row is missing or stale for ${item.id}.`);
  }
}

for (const blocker of activeBlockers) {
  if (["apple-release-signing", "windows-release-signing"].includes(blocker.gate)) {
    violations.push(`Signing blocker is incorrectly listed as active completion blocker: ${blocker.gate}.`);
  }
  if (!blocker.gate || !blocker.reason) {
    violations.push(`Active blocker is malformed: ${blocker.gate ?? "missing gate"}.`);
    continue;
  }
  const line = `- \`${blocker.gate}\`: ${blocker.reason}`;
  if (!markdown.includes(line)) {
    violations.push(`Markdown active blocker section is missing ${blocker.gate}.`);
  }
  if (blocker.evidence) {
    assertFileEvidenceExists(blocker.evidence, blocker.gate);
  }
}

for (const blocker of externalBlockers) {
  if (!["apple-release-signing", "windows-release-signing"].includes(blocker.gate)) {
    violations.push(`Non-signing blocker is incorrectly listed as external: ${blocker.gate}.`);
  }
  if (!blocker.gate || !blocker.reason) {
    violations.push(`External blocker is malformed: ${blocker.gate ?? "missing gate"}.`);
    continue;
  }
  const line = `- \`${blocker.gate}\`: ${blocker.reason}`;
  if (!markdown.includes(line)) {
    violations.push(`Markdown external blocker section is missing ${blocker.gate}.`);
  }
  if (blocker.evidence) {
    assertFileEvidenceExists(blocker.evidence, blocker.gate);
  }
}

const conclusion = audit.completionReadyExcludingSigningAndPublishing
  ? "The repo is ready except signing and publishing."
  : "The objective is not complete. Non-external launch requirements remain blocked or partially verified.";
if (!markdown.includes(conclusion)) {
  violations.push("Markdown conclusion does not match JSON readiness state.");
}

if (violations.length > 0) {
  fail(`Completion audit validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Completion audit validation passed: ${audit.status}, ${incomplete.length} incomplete launch-blocking items.`
);
