#!/usr/bin/env node
/**
 * Verifier for the packaged macOS app matrix insertion artifact.
 *
 * The bar is a machine read-back: the sample text must have been read back out of the target
 * surface by something that is not the app under test, the field must be proven empty beforehand,
 * System Events must have confirmed the row's own application was frontmost, and the strategy used
 * must be a recognized one.
 *
 * This verifier deliberately REFUSES artifacts that still gate on a human attestation or on the
 * sidecar's own `pasted` flag, so the old attestation cannot be quietly reintroduced.
 *
 * It also refuses to call anything PASS unless it closes the matrix row it names. A run that
 * satisfied every gating check on a surface outside that product terminates as PASS_OUT_OF_SCOPE
 * and is accepted here through a separate path that says, out loud, that it closes no row.
 */
import fs from "node:fs";
import path from "node:path";

import { VERIFY_MODES, normalizeReadBackValue } from "./lib/app-matrix-readback.mjs";
import { evaluateAppMatrixTerminalStatus } from "./lib/app-matrix-terminal-status.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const matrixTargets = [
  "Apple Notes",
  "Google Docs (Chrome)",
  "Slack",
  "Notion",
  "VS Code",
  "Cursor",
  "Messages",
  "HubSpot (Chrome)",
];
const placeholderScratchTargetPattern = /^(DISPOSABLE QA TARGET|QA scratch note)$/i;
/** Keys that must never appear in the gating `checks` object again. */
const forbiddenGatingChecks = [
  "manualObservationAccepted",
  "sidecarCommandCompleted",
  "frontmostMatchedTarget",
  "pasteReported",
];

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function slugFor(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

const targetApp = valueFor("--target-app", "")?.trim() ?? "";
const requestedVerifyMode = valueFor("--verify-mode", "")?.trim().toLowerCase() ?? "";
const targetSlug = slugFor(targetApp) || "unknown-target";
// Mirrors the capture script: local-http-probe evidence is filed separately because it cannot
// close the row it names, so it must not sit at the canonical row path.
const artifactSlug =
  requestedVerifyMode === "local-http-probe" ? `${targetSlug}-local-http-probe` : targetSlug;
const artifactPath = path.resolve(
  repoRoot,
  valueFor("--file", valueFor("--out", `artifacts/qa/macos/app-matrix-insertion-${artifactSlug}.json`))
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor(
    "--markdown",
    artifactPath.replace(/\.json$/i, ".md")
  )
);

if (!fs.existsSync(artifactPath)) {
  fail(`App matrix insertion artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`App matrix insertion Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const violations = [];
const expectedTargetApp = targetApp || artifact.targetApp;
const filenameSlug = path
  .basename(artifactPath)
  .replace(/^app-matrix-insertion-/i, "")
  .replace(/\.json$/i, "");
const readBack = artifact.readBack ?? {};

/*
 * Terminal status. A run only earns the word PASS when the read-back happened inside the product
 * the row names. Anything else that satisfied every gating check is PASS_OUT_OF_SCOPE: accepted as
 * honest evidence, refused as row closure.
 */
const closesMatrixRow = artifact.rowClosure?.closesMatrixRow === true;
const outOfScope = artifact.status === "PASS_OUT_OF_SCOPE";
violations.push(...evaluateAppMatrixTerminalStatus(artifact));
if (!matrixTargets.includes(artifact.targetApp)) {
  violations.push(`targetApp must be one of the frozen matrix targets. Found ${artifact.targetApp}.`);
}
if (expectedTargetApp && artifact.targetApp !== expectedTargetApp) {
  violations.push(`Artifact targetApp ${artifact.targetApp} does not match requested target ${expectedTargetApp}.`);
}
const expectedFilenameSlug =
  artifact.verifyMode === "local-http-probe"
    ? `${slugFor(artifact.targetApp)}-local-http-probe`
    : slugFor(artifact.targetApp);
if (expectedFilenameSlug !== filenameSlug) {
  violations.push(
    `Filename slug must be ${expectedFilenameSlug} for a ${artifact.verifyMode} run against ` +
      `${artifact.targetApp}. Found ${filenameSlug}.`
  );
}
if (!artifact.scratchTarget?.trim()) {
  violations.push("scratchTarget must be present.");
} else if (placeholderScratchTargetPattern.test(artifact.scratchTarget.trim())) {
  violations.push("scratchTarget must not be a placeholder.");
}
if (!artifact.sampleText?.trim()) {
  violations.push("sampleText must be present.");
}

/* ---- the machine read-back is the verdict ---- */

if (!VERIFY_MODES.includes(artifact.verifyMode)) {
  violations.push(
    `verifyMode must be one of: ${VERIFY_MODES.join(", ")}. Found ${artifact.verifyMode}.`
  );
}
if (readBack.mode !== artifact.verifyMode) {
  violations.push(
    `readBack.mode (${readBack.mode}) must match the artifact verifyMode (${artifact.verifyMode}).`
  );
}
if (requestedVerifyMode && artifact.verifyMode !== requestedVerifyMode) {
  violations.push(
    `Artifact verifyMode ${artifact.verifyMode} does not match requested mode ${requestedVerifyMode}.`
  );
}
if (artifact.checks?.readBackModeRecognized !== true) {
  violations.push("checks.readBackModeRecognized must be true.");
}
if (artifact.checks?.readBackMatchedSample !== true) {
  violations.push("checks.readBackMatchedSample must be true.");
}
if (artifact.checks?.readBackPreInsertEmpty !== true) {
  violations.push("checks.readBackPreInsertEmpty must be true.");
}
// A System Events read of the frontmost process, not a self-report: it is the only thing tying a
// read-back to the application this row names, so it has to be gating.
if (artifact.checks?.externalFrontmostMatchedTarget !== true) {
  violations.push(
    "checks.externalFrontmostMatchedTarget must be true: without an external frontmost read, any " +
      "application with a focused empty field could satisfy this row."
  );
}
if (artifact.externalFrontmostMatchedTarget !== true) {
  violations.push("externalFrontmostMatchedTarget must be true at the top level as well.");
}
if (!artifact.externalFrontmost || artifact.externalFrontmost.ok !== true) {
  violations.push(
    "externalFrontmost must record a successful System Events read of the frontmost application."
  );
}
if (artifact.checks?.sidecarExitedCleanly !== true) {
  violations.push("checks.sidecarExitedCleanly must be true.");
}
// The packaged sidecar mutates the operator's real data directory on startup, so a clean run has
// to prove it put it back.
if (artifact.checks?.dbRestored !== true || artifact.dbRestored !== true) {
  violations.push(
    "checks.dbRestored and dbRestored must be true: the harness snapshots plainsong.db (and its " +
      "-wal/-shm) before launching the packaged sidecar and restores them afterwards."
  );
}
if (artifact.checks?.settingsRestored !== true || artifact.settingsRestored !== true) {
  violations.push("checks.settingsRestored and settingsRestored must be true.");
}
if (artifact.userStateSnapshotTaken !== true) {
  violations.push("userStateSnapshotTaken must be true.");
}
if (!artifact.originalDbHashes || !artifact.restoredDbHashes) {
  violations.push("originalDbHashes and restoredDbHashes must both be recorded.");
}
if (typeof readBack.observedValue !== "string") {
  violations.push("readBack.observedValue must be a string read back off the target surface.");
} else if (
  normalizeReadBackValue(readBack.observedValue) !== normalizeReadBackValue(artifact.sampleText)
) {
  violations.push(
    "readBack.observedValue must equal sampleText exactly. " +
      `Observed ${JSON.stringify(readBack.observedValue)}.`
  );
}
if (typeof readBack.preInsertValue !== "string") {
  violations.push("readBack.preInsertValue must be a string recorded before the insert.");
} else if (normalizeReadBackValue(readBack.preInsertValue) !== "") {
  violations.push(
    "readBack.preInsertValue must be empty; otherwise pre-existing text can masquerade as an " +
      `insert. Found ${JSON.stringify(readBack.preInsertValue)}.`
  );
}
if (!readBack.prepareEvidence) {
  violations.push("readBack.prepareEvidence must record how the pre-insert read was made.");
}
if (!readBack.readBackEvidence) {
  violations.push("readBack.readBackEvidence must record how the post-insert read was made.");
}
if (["native-accessibility", "clipboard-sentinel"].includes(artifact.verifyMode)) {
  if (artifact.checks?.targetSurfaceRestored !== true) {
    violations.push(
      "checks.targetSurfaceRestored must be true: the disposable target must be machine-verified empty after read-back."
    );
  }
  if (readBack.cleanupEvidence?.targetSurfaceRestored !== true) {
    violations.push(
      "readBack.cleanupEvidence.targetSurfaceRestored must be true for native and clipboard target surfaces."
    );
  }
}

/* ---- the attestation must stay dead ---- */

for (const key of forbiddenGatingChecks) {
  if (artifact.checks && key in artifact.checks) {
    violations.push(
      `checks.${key} must not exist: self-reports and human attestations are not gating checks. ` +
        "Self-reports belong under selfReported."
    );
  }
}
if (artifact.observation !== undefined) {
  violations.push(
    "artifact.observation must not exist. A human attestation is not evidence; use readBack."
  );
}
if (!artifact.selfReported || typeof artifact.selfReported !== "object") {
  violations.push("selfReported must record the sidecar's own claims as non-gating corroboration.");
} else {
  for (const key of ["sidecarCommandCompleted", "frontmostMatchedTarget", "pasteReported"]) {
    if (typeof artifact.selfReported[key] !== "boolean") {
      violations.push(`selfReported.${key} must be recorded as a boolean.`);
    }
  }
  if (!String(artifact.selfReported.note ?? "").trim()) {
    violations.push("selfReported.note must state that these fields cannot carry a pass.");
  }
}

/* ---- scope honesty ---- */

if (!artifact.rowClosure || typeof artifact.rowClosure !== "object") {
  violations.push("rowClosure must state whether this run closes the matrix row.");
} else {
  if (typeof artifact.rowClosure.closesMatrixRow !== "boolean") {
    violations.push("rowClosure.closesMatrixRow must be a boolean.");
  }
  if (!String(artifact.rowClosure.reason ?? "").trim()) {
    violations.push("rowClosure.reason must explain the scope of this evidence.");
  }
  if (artifact.verifyMode === "local-http-probe") {
    if (artifact.rowClosure.closesMatrixRow !== false) {
      violations.push(
        "local-http-probe reads back a harness-owned page, not the product named in the row, so " +
          "rowClosure.closesMatrixRow must be false."
      );
    }
    if (!(artifact.scopeCaveats ?? []).some((caveat) => /127\.0\.0\.1|probe/i.test(caveat))) {
      violations.push(
        "local-http-probe runs must record a scope caveat naming the local probe surface."
      );
    }
  }
}

if (artifact.sidecarExit?.code !== 0) {
  violations.push("sidecarExit.code must be 0.");
}
if (!artifact.sidecarResult || typeof artifact.sidecarResult !== "object") {
  violations.push("sidecarResult must be recorded (as corroboration, not as the verdict).");
}

// Anchored to the whole line on purpose: "Status: PASS" is a substring of
// "Status: PASS_OUT_OF_SCOPE", and an out-of-scope run must never read as a PASS.
const expectedStatusLine = outOfScope ? "PASS_OUT_OF_SCOPE" : "PASS";
if (!new RegExp(`^Status: ${expectedStatusLine}$`, "m").test(markdown)) {
  violations.push(`Markdown is missing verified line: Status: ${expectedStatusLine}`);
}

const expectedMarkdownLines = [
  `- App: \`${artifact.targetApp}\``,
  `- Scratch target: \`${artifact.scratchTarget}\``,
  `- Read-back mode: \`${artifact.verifyMode}\``,
  "- Read-back mode recognized: yes",
  "- Pre-insert field empty: yes",
  "- Read-back matched sample: yes",
  "- External frontmost matched target: yes",
  "- Sidecar exited cleanly: yes",
  "- User database restored: yes",
  "- User settings restored: yes",
  `- Closes the matrix row for ${artifact.targetApp}: ${closesMatrixRow ? "yes" : "no"}`,
  "## Self-Reported by the App Under Test (NOT verification)",
];
for (const line of expectedMarkdownLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown is missing verified line: ${line}`);
  }
}
if (/^- Manual observation accepted: yes$/m.test(markdown)) {
  violations.push("Markdown must not present a manual observation as a gating check.");
}

if (violations.length > 0) {
  fail(`App matrix insertion validation failed (${violations.length} issues):`, violations);
}

if (outOfScope) {
  console.log(
    `App matrix insertion validation passed OUT OF SCOPE: ${artifact.targetApp} via ` +
      `${artifact.verifyMode}. Read back ${JSON.stringify(artifact.readBack.observedValue)} from ` +
      "an empty field, but this run CLOSES NO MATRIX ROW - the read-back did not happen inside " +
      `${artifact.targetApp}. Reason: ${artifact.rowClosure.reason} Do not promote this row on ` +
      "the strength of this artifact."
  );
} else {
  console.log(
    `App matrix insertion validation passed: ${artifact.targetApp} via ${artifact.verifyMode}. ` +
      `Read back ${JSON.stringify(artifact.readBack.observedValue)} from an empty field, with ` +
      `${artifact.externalFrontmost?.name ?? "the target"} confirmed frontmost by System Events. ` +
      "Closes matrix row: yes."
  );
}
