#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const qaBundlePath = path.resolve(
  process.cwd(),
  valueFor("--qa-bundle", "artifacts/packaged-qa-evidence-bundle.json"),
);
const outPath = path.resolve(
  process.cwd(),
  valueFor("--out", "artifacts/packaged-ux-evidence-bundle.json"),
);
const markdownPath = path.resolve(
  process.cwd(),
  valueFor("--markdown", "docs/packaged-ux-evidence-bundle.md"),
);

const qaBundle = JSON.parse(fs.readFileSync(qaBundlePath, "utf8"));

const gates = [
  {
    id: "first-run-orientation",
    name: "First-run orientation",
    owner: "qa-release",
    acceptance:
      "New user understands what Nautilus does, local-first posture, required permissions, and the fastest safe starting path.",
    include: (row) => row.area === "Onboarding",
  },
  {
    id: "os-permissions",
    name: "OS permissions",
    owner: "qa-release",
    acceptance:
      "Microphone, accessibility/input, screen/meeting-related permissions, and denial recovery are explained before and after system prompts.",
    include: (row) => row.area === "Permissions",
  },
  {
    id: "recording-visibility",
    name: "Recording visibility",
    owner: "qa-release",
    acceptance:
      "User can always tell whether audio is being captured, paused, stopped, or unavailable.",
    include: (row) => row.area === "Capture" && !/processing|soak/i.test(row.testCase),
  },
  {
    id: "meeting-processing-state",
    name: "Meeting processing state",
    owner: "qa-release",
    acceptance:
      "On stop, meeting status changes to processing immediately; spinner/detail state updates without manual modal reopen.",
    include: (row) => row.area === "Capture" && /processing/i.test(row.testCase),
  },
  {
    id: "transcript-ready-state",
    name: "Transcript-ready state",
    owner: "qa-release",
    acceptance:
      "User can see when transcript is ready, incomplete, failed, or degraded, with recovery guidance.",
    include: (row) => row.area === "Transcription" || (row.area === "Capture" && /soak/i.test(row.testCase)),
  },
  {
    id: "retention-delete-comprehension",
    name: "Retention and delete",
    owner: "qa-release",
    acceptance:
      "User understands where transcripts and audio live, what delete modes remove, and what remains accessible.",
    include: (row) => row.area === "Retention",
  },
  {
    id: "backup-sync-recovery",
    name: "Backup/restore trust",
    owner: "qa-release",
    acceptance:
      "Backup, restore, and cloud sync paths show clear user-facing state and do not overstate hosted storage guarantees.",
    include: (row) => row.area === "Backup",
  },
  {
    id: "licensing-trial-comprehension",
    name: "Licensing and trial",
    owner: "qa-release",
    acceptance:
      "Trial, activation, expiry, tier boundaries, and lockout states are visible and recoverable.",
    include: (row) => row.area === "Licensing",
  },
  {
    id: "provider-model-routing",
    name: "Provider/model routing",
    owner: "qa-release",
    acceptance:
      "Default route is recommended by user job; expert controls do not expose internal inventory as the primary UX.",
    include: (row) => row.area === "Transcription" || row.area === "AI",
  },
  {
    id: "failure-recovery",
    name: "Failure recovery",
    owner: "qa-release",
    acceptance:
      "Failed setup, failed recording, failed transcription, provider failure, and insert/export failure have clear next steps.",
    include: (row) =>
      ["Permissions", "Capture", "Transcription", "AI", "Backup", "Licensing"].includes(row.area),
  },
  {
    id: "platform-scope",
    name: "Platform scope",
    owner: "release-owner",
    acceptance:
      "Site/app copy names supported platforms and unavailable platforms without ambiguity.",
    include: (row) => ["Install", "Security", "Updates"].includes(row.area),
  },
  {
    id: "install-update-trust",
    name: "Install, update, and platform trust",
    owner: "release-owner",
    acceptance:
      "Signing, notarization, SmartScreen, fresh install, upgrade, and update channel evidence matches public copy.",
    include: (row) => ["Install", "Security", "Updates"].includes(row.area),
  },
];

function platformForEvidence(evidence) {
  if (evidence.includes("/macos/")) return "macOS";
  if (evidence.includes("/windows/")) return "Windows";
  return "Unknown";
}

function summarize(rows) {
  return {
    total: rows.length,
    pass: rows.filter((row) => row.status === "PASS").length,
    fail: rows.filter((row) => row.status === "FAIL").length,
    blocked: rows.filter((row) => row.status === "BLOCKED").length,
    pending: rows.filter((row) => row.status === "PENDING").length,
  };
}

function statusFor(summary) {
  if (summary.fail > 0) return "FAIL";
  if (summary.blocked > 0) return "BLOCKED";
  if (summary.pending > 0) return "PENDING";
  return "PASS";
}

const uxGates = gates.map((gate) => {
  const rows = qaBundle.rows
    .filter(gate.include)
    .map((row) => ({ ...row, platform: platformForEvidence(row.evidence) }));
  const summary = summarize(rows);

  return {
    id: gate.id,
    name: gate.name,
    status: statusFor(summary),
    owner: gate.owner,
    acceptance: gate.acceptance,
    summary,
    evidence: rows,
  };
});

const summary = qaBundle.summary ?? summarize(qaBundle.rows);
const productReadiness = {
  status: "BLOCKED",
  posture:
    "Do not prioritize signing/notarization work until core app quality, competitor parity, and packaged UX evidence are credible.",
  sourceDocs: [
    "docs/competitor-parity-gates.md",
    "docs/evals/dictation-parity-launch-scorecard.md",
    "docs/evals/superwhisper-parity-audit-2026-04-09.md",
  ],
  blockers: [
    "Competitor parity gates are not PASS; the launch rule in docs/competitor-parity-gates.md is NO-GO if any CP gate is not PASS.",
    "Dictation parity scorecard still depends on packaged app evidence, app-matrix insertion evidence, provider telemetry proof, command/snippet reliability evidence, language certification, latency trend evidence, and trust/recovery UX proof.",
    "The app still lacks packaged evidence for broad language breadth, translate-to-English mode, and user-facing file transcription.",
    "Manual UX screenshots/videos are still missing for the P0 first-run, permissions, recording, processing, transcript, retention, backup, licensing, provider routing, failure recovery, and platform-scope journeys.",
  ],
  laterReleaseBlockers: [
    "Apple signing and notarization remain required before release.",
    "Windows signing and SmartScreen validation remain required before release.",
    "Signed updater validation remains required before release.",
  ],
  optionalBacklog: [
    "Mouse-button shortcut controls remain optional parity backlog per docs/evals/superwhisper-parity-audit-2026-04-09.md; do not block private beta or GA on that item unless the launch scope changes.",
  ],
};
const report = {
  generatedAt: new Date().toISOString(),
  sourceBundle: path.relative(process.cwd(), qaBundlePath),
  status: statusFor(summary),
  summary,
  productReadiness,
  uxGates,
  blockers: [
    "Core product quality and competitor-parity evidence are not launch-ready.",
    "Manual packaged QA screenshots or videos are not present for the P0 UX journeys.",
    "Packaged benchmark and app-matrix evidence are still missing for dictation parity claims.",
    "Apple/Windows signing and notarization remain later release blockers, but they should not be the next engineering focus until product-quality gates improve.",
  ],
  nextActions: [
    "Turn the competitor parity gates into the immediate implementation backlog: CP-01 through CP-15 must move toward PASS before release signing work matters.",
    "Run or add packaged-product evidence for dictation reliability, app-matrix insertion, command/snippet success, latency, and recovery UX.",
    "Replace BLOCKED UX stubs with PASS or FAIL notes that link screenshots, videos, logs, and defect IDs.",
  ],
};

function markdownFor(report) {
  const lines = [
    "# Packaged UX Evidence Bundle",
    "",
    `Generated: ${report.generatedAt}`,
    `Overall status: \`${report.status}\``,
    "",
    "This bundle maps the packaged QA matrix to the P0 Nautilus UX launch gates. It is intentionally blocker-first: a gate can only pass after packaged macOS and Windows evidence exists for the relevant user journey.",
    "",
    "## Summary",
    "",
    "| Total rows | PASS | FAIL | BLOCKED | PENDING |",
    "| --- | --- | --- | --- | --- |",
    `| ${report.summary.total} | ${report.summary.pass} | ${report.summary.fail} | ${report.summary.blocked} | ${report.summary.pending} |`,
    "",
    "## Product Readiness",
    "",
    `Status: \`${report.productReadiness.status}\``,
    "",
    report.productReadiness.posture,
    "",
    "Source docs:",
    "",
  ];

  for (const sourceDoc of report.productReadiness.sourceDocs) lines.push(`- ${sourceDoc}`);

  lines.push("", "Current product blockers:", "");
  for (const blocker of report.productReadiness.blockers) lines.push(`- ${blocker}`);

  lines.push("", "Later release blockers:", "");
  for (const blocker of report.productReadiness.laterReleaseBlockers) lines.push(`- ${blocker}`);

  lines.push("", "Optional backlog, not launch blockers:", "");
  for (const item of report.productReadiness.optionalBacklog) lines.push(`- ${item}`);

  lines.push(
    "",
    "## UX Gates",
    "",
    "| Gate | Status | Evidence rows | Owner |",
    "| --- | --- | --- | --- |",
  );

  for (const gate of report.uxGates) {
    lines.push(`| ${gate.name} | \`${gate.status}\` | ${gate.summary.total} | ${gate.owner} |`);
  }

  lines.push("", "## Gate Details", "");

  for (const gate of report.uxGates) {
    lines.push(`### ${gate.name}`, "", `Status: \`${gate.status}\``, "", gate.acceptance, "");
    lines.push("| Platform | Area | Test case | Status | Evidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of gate.evidence) {
      lines.push(
        `| ${row.platform} | ${row.area} | ${row.testCase} | \`${row.status}\` | ${row.evidence} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Blockers", "");
  for (const blocker of report.blockers) lines.push(`- ${blocker}`);
  lines.push("", "## Next Actions", "");
  report.nextActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  lines.push("");

  return `${lines.join("\n")}\n`;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, markdownFor(report));
console.log(JSON.stringify(report, null, 2));
