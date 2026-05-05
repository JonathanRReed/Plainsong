#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generatedAt = new Date().toISOString();
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const matrixPath = valueFor("--matrix", "docs/competitive-readiness-matrix.md");
const launchReportPath = valueFor("--launch-report", "artifacts/launch-readiness-report.json");
const qaBundlePath = valueFor("--qa-bundle", "artifacts/packaged-qa-evidence-bundle.json");
const outPath = valueFor("--out", "artifacts/competitive-parity-report.json");
const markdownPath = valueFor("--markdown", "docs/competitive-parity-report.md");

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function writeText(relativePath, body) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(relativePath, value) {
  writeText(relativePath, JSON.stringify(value, null, 2));
}

function parseCompetitiveRows(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4)
    .filter((cells) => cells[0] !== "Capability" && cells[0] !== "---")
    .map((cells) => ({
      capability: cells[0],
      competitiveBar: cells[1],
      evidence: cells[2],
      status: cells[3],
    }));
}

function summarizeStatuses(rows) {
  return {
    total: rows.length,
    pass: rows.filter((row) => row.status === "PASS").length,
    blocked: rows.filter((row) => row.status === "BLOCKED").length,
  };
}

function qaPlatformSummary(bundle, platform) {
  return bundle?.summary?.byPlatform?.[platform] ?? {
    total: 0,
    pass: 0,
    fail: 0,
    blocked: 0,
    pending: 0,
  };
}

function requiredActionFor(capability, launchReport, qaBundle) {
  const dictation = launchReport?.areas?.dictation ?? {};
  const meetings = launchReport?.areas?.meetings ?? {};
  const trust = launchReport?.areas?.trust ?? {};
  const claims = launchReport?.areas?.launchClaims ?? {};
  const windowsQa = qaPlatformSummary(qaBundle, "Windows");

  switch (capability) {
    case "System-wide dictation":
      return `Capture packaged insertion evidence for the frozen app matrix. Current ready count: ${dictation.appMatrixSummary?.ready ?? 0}/${dictation.appMatrixSummary?.total ?? 0}.`;
    case "Local-first ASR":
      return "Keep local ASR benchmark, language, and provider-integrity artifacts green while closing packaged proof.";
    case "Cloud ASR choice":
      return "Provide OPENAI_API_KEY, ELEVENLABS_API_KEY, and MISTRAL_API_KEY, then run the cloud ASR smoke gate.";
    case "AI cleanup and formatting":
      return "Keep prompt and parity fixtures green, then prove the same path in packaged app insertion runs.";
    case "Cross-platform packaged behavior":
      return `Run Windows packaged QA. Current Windows packaged QA: ${windowsQa.pass} PASS / ${windowsQa.blocked} BLOCKED.`;
    case "Meeting transcription":
      return `Finish blocked meeting-critical packaged QA rows. Current meeting status: ${meetings.status ?? "UNKNOWN"}.`;
    case "AI meeting notes":
      return "Run Windows AI and export QA rows, then refresh the packaged QA evidence bundle.";
    case "Privacy and retention":
      return "Run Windows retention QA rows and keep macOS retention evidence green.";
    case "Backup and restore":
      return "Run Windows backup and restore QA rows and live license-related trust rows.";
    case "Launch claim discipline":
      return claims.status === "PASS"
        ? "Keep public copy scoped to implemented or certified evidence only."
        : "Remove any claim that exceeds packaged evidence.";
    case "Provider fallback transparency":
      return "Keep requested and actual route telemetry in every dictation runtime event and history artifact.";
    case "Overlay lifecycle control":
      return "Keep Electron as the overlay visibility owner and React as the state renderer plus action surface.";
    case "Settings first-load guard":
      return "Keep Settings core controls on the getSettings path and keep secondary probes lazy and timeout-safe.";
    case "Sidecar trust boundary":
      return "Keep the sidecar environment allowlist explicit and add new provider keys only when the sidecar needs them.";
    case "IPC drift and timeout guard":
      return "Keep the IPC contract gate in completion checks and assign timeout classes to new long-running commands.";
    default:
      return "Tie this capability to a concrete artifact before making a public claim.";
  }
}

const matrixMarkdown = readText(matrixPath);
const launchReport = readJson(launchReportPath);
const qaBundle = readJson(qaBundlePath);
const rows = parseCompetitiveRows(matrixMarkdown);
const statusSummary = summarizeStatuses(rows);
const blockedRows = rows.filter((row) => row.status === "BLOCKED");
const passRows = rows.filter((row) => row.status === "PASS");
const parityReady =
  statusSummary.total > 0 &&
  statusSummary.blocked === 0 &&
  launchReport?.status === "GO";

const sourceRegister = [
  {
    competitor: "Wispr Flow",
    bar: "System-wide dictation, dictionary, snippets, command mode, styles, developer syntax awareness, privacy mode, cross-device plans.",
    urls: [
      "https://wisprflow.ai/features",
      "https://docs.wisprflow.ai/articles/9559327591-flow-plans-and-what-s-included",
      "https://docs.wisprflow.ai/articles/3818554249-enable-hipaa-support-and-zero-data-retention-zdr-in-wispr-flow",
    ],
  },
  {
    competitor: "Superwhisper",
    bar: "Local and cloud voice models, custom modes, 100+ language positioning, Windows shipping with documented gaps.",
    urls: [
      "https://superwhisper.com/docs",
      "https://superwhisper.com/models",
      "https://superwhisper.com/docs/models/voice",
      "https://superwhisper.com/docs/get-started/windows",
    ],
  },
  {
    competitor: "Granola",
    bar: "Bot-free meeting notes, templates, recipes, chat, spaces, folders, integrations, API, MCP, consent and trust UX.",
    urls: [
      "https://docs.granola.ai/help-center/getting-started/granola-101",
      "https://docs.granola.ai/article/integrations-with-granola",
      "https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates",
      "https://docs.granola.ai/help-center/getting-more-from-your-notes/recipes",
      "https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs",
    ],
  },
  {
    competitor: "OpenOats",
    bar: "Open-source local-first live meeting copilot, local transcripts, knowledge-base search, local or BYOK LLM path.",
    urls: ["https://github.com/yazinsai/OpenOats"],
  },
];

const topGaps = blockedRows.map((row) => ({
  capability: row.capability,
  status: row.status,
  competitiveBar: row.competitiveBar,
  requiredAction: requiredActionFor(row.capability, launchReport, qaBundle),
}));

const differentiation = passRows.map((row) => ({
  capability: row.capability,
  status: row.status,
  claimBoundary:
    row.capability === "Launch claim discipline"
      ? "Differentiator is trust posture, not a feature parity claim."
      : [
            "Provider fallback transparency",
            "Overlay lifecycle control",
            "Settings first-load guard",
            "Sidecar trust boundary",
            "IPC drift and timeout guard",
          ].includes(row.capability)
        ? "Internal quality differentiator. Keep it in product proof, not broad public parity copy."
      : "Can support narrow positioning only while launch report remains NO-GO.",
}));

const report = {
  generatedAt,
  status: parityReady ? "PARITY_OR_BETTER_READY" : "BLOCKED",
  claimDecision: parityReady ? "PARITY_OR_BETTER_CLAIM_ALLOWED" : "DO_NOT_CLAIM_PARITY_OR_BETTER",
  sourceRegister,
  summary: {
    competitiveRows: statusSummary,
    launchStatus: launchReport?.status ?? "UNKNOWN",
    dictationStatus: launchReport?.areas?.dictation?.status ?? "UNKNOWN",
    meetingStatus: launchReport?.areas?.meetings?.status ?? "UNKNOWN",
    trustStatus: launchReport?.areas?.trust?.status ?? "UNKNOWN",
    claimStatus: launchReport?.areas?.launchClaims?.status ?? "UNKNOWN",
  },
  topGaps,
  differentiation,
  activeBlockers: launchReport?.blockers ?? [],
  externalBlockers: launchReport?.externalBlockers ?? [],
  sourceArtifacts: {
    competitiveMatrix: matrixPath,
    launchReport: launchReportPath,
    qaBundle: qaBundlePath,
    researchBrief: "docs/research/competitive-research-2026-05-05.md",
    researchMatrix: "docs/research/competitive-matrix-2026-05-05.csv",
  },
};

const sourceLines = sourceRegister.flatMap((source) =>
  source.urls.map((url) => `- ${source.competitor}: ${url}`)
);
const gapLines =
  topGaps.length === 0
    ? ["- none"]
    : topGaps.map(
        (gap) =>
          `- ${gap.capability}: ${gap.requiredAction}`
      );
const differentiationLines =
  differentiation.length === 0
    ? ["- none"]
    : differentiation.map(
        (item) =>
          `- ${item.capability}: ${item.claimBoundary}`
      );
const blockerLines =
  report.activeBlockers.length === 0
    ? ["- none"]
    : report.activeBlockers.map(
        (blocker) => `- ${blocker.gate}: ${blocker.reason}`
      );

const markdown = `# Competitive Parity Report

Generated: ${generatedAt}
Status: \`${report.status}\`
Claim decision: \`${report.claimDecision}\`

Do not claim parity-or-better yet.

This report checks Nautilus against the current evidence bar set by Wispr Flow, Superwhisper, Granola, and OpenOats. It is intentionally stricter than feature inventory: a capability is competitive only when the repo has packaged or source-backed evidence for the launch scope.

## Current Read

- Competitive matrix rows: ${statusSummary.pass} PASS / ${statusSummary.blocked} BLOCKED / ${statusSummary.total} total
- Launch status: \`${report.summary.launchStatus}\`
- Dictation: \`${report.summary.dictationStatus}\`
- Meetings: \`${report.summary.meetingStatus}\`
- Trust: \`${report.summary.trustStatus}\`
- Launch claims: \`${report.summary.claimStatus}\`

## Competitive Gaps To Close

${gapLines.join("\n")}

## Narrow Differentiators That Are Evidence-Backed

${differentiationLines.join("\n")}

## Active Product Blockers

${blockerLines.join("\n")}

## Source Register

${sourceLines.join("\n")}

## Rule

Nautilus can claim parity-or-better only when this report is \`PARITY_OR_BETTER_READY\`, ` +
`\`artifacts/launch-readiness-report.json\` is \`GO\`, and \`docs/launch-completion-audit.md\` has no non-external blocked requirements.
`;

writeJson(outPath, report);
writeText(markdownPath, markdown);
console.log(JSON.stringify(report, null, 2));
