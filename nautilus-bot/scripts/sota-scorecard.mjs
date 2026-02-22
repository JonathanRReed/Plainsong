#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

const manifestPath = path.resolve(process.cwd(), argValue("--manifest", "docs/evals/corpus-manifest.json"));
const resultsPath = path.resolve(process.cwd(), argValue("--results", "docs/evals/benchmark-results.json"));
const outJsonPath = path.resolve(process.cwd(), argValue("--out-json", "docs/evals/sota-scorecard.json"));
const outMdPath = path.resolve(process.cwd(), argValue("--out-md", "docs/evals/sota-scorecard.md"));
const strict = !hasFlag("--no-strict");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function wer(referenceText, hypothesisText) {
  const ref = normalizeText(referenceText).split(" ").filter(Boolean);
  const hyp = normalizeText(hypothesisText).split(" ").filter(Boolean);
  if (!ref.length) return null;
  return levenshtein(ref, hyp) / ref.length;
}

function parseCompetitorClaims(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const jsonBlock = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonBlock) {
    return { numericClaims: [], qualitativeClaims: [], sourceFile: filePath };
  }
  try {
    const parsed = JSON.parse(jsonBlock[1]);
    return {
      numericClaims: Array.isArray(parsed.numericClaims) ? parsed.numericClaims : [],
      qualitativeClaims: Array.isArray(parsed.qualitativeClaims) ? parsed.qualitativeClaims : [],
      sourceFile: filePath,
    };
  } catch {
    return { numericClaims: [], qualitativeClaims: [], sourceFile: filePath };
  }
}

const manifest = readJson(manifestPath);
const resultsPayload = readJson(resultsPath);
const runs = Array.isArray(resultsPayload.runs) ? resultsPayload.runs : [];

if (!Array.isArray(runs) || runs.length === 0) {
  console.error("No benchmark runs found. Expected results JSON with a non-empty 'runs' array.");
  process.exit(1);
}

const localProviders = new Set([
  "whisper",
  "parakeet",
  "canary",
  "distil_whisper",
  "moonshine",
  "voxtral",
]);
const cloudProviders = new Set(["openai_cloud", "elevenlabs_scribe"]);

let crashedSessions = 0;
const providerStats = new Map();
const localRtfs = [];
const cloudLatencies = [];
const dictationLatencies = [];
const meetingWers = [];
const dictationWers = [];
const ders = [];
const summaryScores = [];
const actionScores = [];

for (const run of runs) {
  const providerType = String(run.providerType || "unknown");
  const processingTimeMs = Number(run.processingTimeMs || 0);
  const durationSeconds = Number(run.durationSeconds || 0);
  const success = run.success !== false;
  const crashed = run.crashed === true;

  if (!providerStats.has(providerType)) {
    providerStats.set(providerType, { total: 0, success: 0 });
  }
  const stats = providerStats.get(providerType);
  stats.total += 1;
  if (success) stats.success += 1;

  if (crashed) crashedSessions += 1;

  if (localProviders.has(providerType) && durationSeconds > 0 && processingTimeMs > 0) {
    localRtfs.push(processingTimeMs / (durationSeconds * 1000));
  }

  if (cloudProviders.has(providerType) && processingTimeMs > 0) {
    cloudLatencies.push(processingTimeMs);
  }

  if (String(run.taskType) === "dictation") {
    const latency = Number(run.endToEndLatencyMs || processingTimeMs || 0);
    if (latency > 0 && durationSeconds <= 10) dictationLatencies.push(latency);
    const currentWer = wer(run.referenceText, run.hypothesisText);
    if (currentWer !== null) dictationWers.push(currentWer);
  }

  if (String(run.taskType) === "meeting") {
    const currentWer = wer(run.referenceText, run.hypothesisText);
    if (currentWer !== null) meetingWers.push(currentWer);
  }

  if (run.diarizationDer !== undefined && run.diarizationDer !== null) {
    ders.push(Number(run.diarizationDer));
  }
  if (run.summaryFactuality !== undefined && run.summaryFactuality !== null) {
    summaryScores.push(Number(run.summaryFactuality));
  }
  if (run.actionItemF1 !== undefined && run.actionItemF1 !== null) {
    actionScores.push(Number(run.actionItemF1));
  }
}

const providerSuccessRates = {};
let minProviderSuccessRate = null;
for (const [providerType, stats] of providerStats.entries()) {
  const rate = stats.total > 0 ? stats.success / stats.total : 0;
  providerSuccessRates[providerType] = rate;
  minProviderSuccessRate = minProviderSuccessRate === null ? rate : Math.min(minProviderSuccessRate, rate);
}

const totalSessions = runs.length;
const crashFreeSessions = totalSessions > 0 ? 1 - crashedSessions / totalSessions : null;

const metrics = {
  crashFreeSessions,
  providerSuccessRateMin: minProviderSuccessRate,
  providerSuccessRates,
  localRtfP95: percentile(localRtfs, 95),
  cloudMedianLatencyMs: median(cloudLatencies),
  dictationEndToEndLatencyP95Ms: percentile(dictationLatencies, 95),
  meetingWer: meetingWers.length ? meetingWers.reduce((a, b) => a + b, 0) / meetingWers.length : null,
  dictationWer: dictationWers.length ? dictationWers.reduce((a, b) => a + b, 0) / dictationWers.length : null,
  diarizationDer: ders.length ? ders.reduce((a, b) => a + b, 0) / ders.length : null,
  summaryFactuality: summaryScores.length ? summaryScores.reduce((a, b) => a + b, 0) / summaryScores.length : null,
  actionItemF1: actionScores.length ? actionScores.reduce((a, b) => a + b, 0) / actionScores.length : null,
};

const thresholds = manifest.scorecardThresholds;

function checkMetric(metricName, actual, comparator, threshold) {
  if (actual === null || Number.isNaN(actual)) {
    return { metric: metricName, pass: false, actual: null, threshold, comparator, note: "missing metric" };
  }
  let pass = false;
  if (comparator === ">=") pass = actual >= threshold;
  if (comparator === "<=") pass = actual <= threshold;
  return { metric: metricName, pass, actual, threshold, comparator };
}

const thresholdChecks = [
  checkMetric("crashFreeSessions", metrics.crashFreeSessions, ">=", thresholds.crashFreeSessionsMin),
  checkMetric("providerSuccessRateMin", metrics.providerSuccessRateMin, ">=", thresholds.providerSuccessRateMin),
  checkMetric("localRtfP95", metrics.localRtfP95, "<=", thresholds.localRtfP95Max),
  checkMetric("cloudMedianLatencyMs", metrics.cloudMedianLatencyMs, "<=", thresholds.cloudMedianLatencyMsMax),
  checkMetric(
    "dictationEndToEndLatencyP95Ms",
    metrics.dictationEndToEndLatencyP95Ms,
    "<=",
    thresholds.dictationEndToEndLatencyP95MsMax
  ),
  checkMetric("meetingWer", metrics.meetingWer, "<=", thresholds.meetingWerMax),
  checkMetric("dictationWer", metrics.dictationWer, "<=", thresholds.dictationWerMax),
  checkMetric("diarizationDer", metrics.diarizationDer, "<=", thresholds.diarizationDerMax),
  checkMetric("summaryFactuality", metrics.summaryFactuality, ">=", thresholds.summaryFactualityMin),
  checkMetric("actionItemF1", metrics.actionItemF1, ">=", thresholds.actionItemF1Min),
];

const claimsPath = path.resolve(path.dirname(manifestPath), path.basename(manifest.competitorBaseline.sourceFile));
const claims = parseCompetitorClaims(claimsPath);
const competitorComparisons = [];
const qualitativeParityChecks = [];
const relativeImprovement = Number(manifest.competitorBaseline.relativeImprovement || 0.1);
const capabilityParity = manifest.capabilityParity || {};

for (const claim of claims.numericClaims) {
  const metric = String(claim.metric || "");
  const value = Number(claim.value);
  const direction = String(claim.direction || "lower_is_better");
  if (!metric || Number.isNaN(value)) continue;
  const actual = metrics[metric];
  if (actual === undefined || actual === null) {
    competitorComparisons.push({ metric, pass: false, note: "metric unavailable", competitorValue: value, direction });
    continue;
  }

  let target;
  let pass;
  if (direction === "higher_is_better") {
    target = value * (1 + relativeImprovement);
    pass = actual >= target;
  } else {
    target = value * (1 - relativeImprovement);
    pass = actual <= target;
  }
  competitorComparisons.push({ metric, pass, competitorValue: value, target, actual, direction });
}

for (const claim of claims.qualitativeClaims) {
  const capabilityKey = String(claim.capabilityKey || claim.id || "").trim();
  if (!capabilityKey) {
    qualitativeParityChecks.push({
      id: String(claim.id || "unknown"),
      pass: false,
      note: "missing capabilityKey on qualitative claim",
    });
    continue;
  }

  const supported = capabilityParity[capabilityKey];
  qualitativeParityChecks.push({
    id: String(claim.id || capabilityKey),
    capabilityKey,
    pass: supported === true,
    actual: supported === true ? "supported" : "missing",
    required: "supported",
    tool: claim.tool || null,
  });
}

const scorecard = {
  generatedAt: new Date().toISOString(),
  manifestPath,
  resultsPath,
  baselineDate: manifest.baselineDate,
  hardwareProfile: manifest.hardwareProfile,
  runCount: runs.length,
  metrics,
  thresholdChecks,
  competitorComparisons,
  qualitativeParityChecks,
  summary: {
    thresholdPass: thresholdChecks.every((check) => check.pass),
    competitorPass: competitorComparisons.every((check) => check.pass),
    qualitativePass: qualitativeParityChecks.every((check) => check.pass),
    numericClaimCount: competitorComparisons.length,
    qualitativeClaimCount: qualitativeParityChecks.length,
  },
};

const mdLines = [];
mdLines.push("# Nautilus SOTA Scorecard");
mdLines.push("");
mdLines.push(`Generated at: ${scorecard.generatedAt}`);
mdLines.push(`Baseline date: ${manifest.baselineDate}`);
mdLines.push(`Runs analyzed: ${runs.length}`);
mdLines.push("");
mdLines.push("## Threshold Results");
mdLines.push("");
mdLines.push("| Metric | Comparator | Target | Actual | Pass |");
mdLines.push("| --- | --- | --- | --- | --- |");
for (const check of thresholdChecks) {
  mdLines.push(
    `| ${check.metric} | ${check.comparator} | ${check.threshold} | ${check.actual ?? "N/A"} | ${check.pass ? "PASS" : "FAIL"} |`
  );
}
mdLines.push("");
mdLines.push("## Competitor Relative Checks");
mdLines.push("");
if (competitorComparisons.length === 0) {
  mdLines.push("No numeric competitor claims were available in the snapshot; relative checks skipped.");
} else {
  mdLines.push("| Metric | Direction | Competitor | Nautilus Target | Actual | Pass |");
  mdLines.push("| --- | --- | --- | --- | --- | --- |");
  for (const item of competitorComparisons) {
    mdLines.push(
      `| ${item.metric} | ${item.direction} | ${item.competitorValue} | ${item.target ?? "N/A"} | ${item.actual ?? "N/A"} | ${item.pass ? "PASS" : "FAIL"} |`
    );
  }
}
mdLines.push("");
mdLines.push("## Qualitative Capability Parity");
mdLines.push("");
if (qualitativeParityChecks.length === 0) {
  mdLines.push("No qualitative claims were available in the snapshot; parity checks skipped.");
} else {
  mdLines.push("| Claim ID | Capability Key | Actual | Required | Pass |");
  mdLines.push("| --- | --- | --- | --- | --- |");
  for (const item of qualitativeParityChecks) {
    mdLines.push(
      `| ${item.id} | ${item.capabilityKey ?? "N/A"} | ${item.actual ?? "N/A"} | ${item.required ?? "N/A"} | ${item.pass ? "PASS" : "FAIL"} |`
    );
  }
}
mdLines.push("");
mdLines.push("## Final Verdict");
mdLines.push("");
mdLines.push(
  scorecard.summary.thresholdPass && scorecard.summary.competitorPass && scorecard.summary.qualitativePass
    ? "GO: Scorecard thresholds passed."
    : "NO-GO: One or more scorecard gates failed."
);

writeText(outJsonPath, `${JSON.stringify(scorecard, null, 2)}\n`);
writeText(outMdPath, `${mdLines.join("\n")}\n`);

console.log(JSON.stringify(scorecard, null, 2));

if (
  strict &&
  (!scorecard.summary.thresholdPass || !scorecard.summary.competitorPass || !scorecard.summary.qualitativePass)
) {
  process.exit(1);
}
