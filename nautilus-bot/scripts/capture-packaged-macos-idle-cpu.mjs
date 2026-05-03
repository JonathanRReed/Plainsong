#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Nautilus.app")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/idle-cpu-baseline.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/idle-cpu-baseline.md")
);
const warmupMs = Number(valueFor("--warmup-ms", "30000"));
const sampleCount = Number(valueFor("--samples", "20"));
const sampleIntervalMs = Number(valueFor("--sample-interval-ms", "1000"));
const maxAverageCpuPct = Number(valueFor("--max-average-cpu-pct", "1"));
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "Nautilus");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-idle-cpu can only run on macOS.");
}
if (!fs.existsSync(appExecutablePath)) {
  fail(`Packaged app executable not found at ${appExecutablePath}`);
}
if (!Number.isFinite(warmupMs) || warmupMs < 0) {
  fail("Invalid --warmup-ms value.");
}
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  fail("Invalid --samples value.");
}
if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 100) {
  fail("Invalid --sample-interval-ms value.");
}
if (!Number.isFinite(maxAverageCpuPct) || maxAverageCpuPct <= 0) {
  fail("Invalid --max-average-cpu-pct value.");
}

function runCommand(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quitNautilus() {
  runCommand("osascript", ["-e", 'tell application id "com.nautilus.bot" to quit']);
}

function childPids(parentPid) {
  const result = runCommand("pgrep", ["-P", String(parentPid)]);
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function processTree(rootPid) {
  const seen = new Set();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of childPids(pid)) {
      if (!seen.has(child)) queue.push(child);
    }
  }

  return [...seen].sort((left, right) => left - right);
}

function sampleCpu(pids) {
  if (pids.length === 0) {
    return { totalCpuPct: 0, processes: [] };
  }

  const result = runCommand("ps", [
    "-o",
    "pid=,pcpu=,comm=",
    "-p",
    pids.join(","),
  ]);
  if (result.status !== 0) {
    return { totalCpuPct: 0, processes: [] };
  }

  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([0-9.]+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        cpuPct: Number(match[2]),
        command: match[3],
      };
    })
    .filter(Boolean);

  return {
    totalCpuPct: Number(
      processes.reduce((total, process) => total + process.cpuPct, 0).toFixed(2)
    ),
    processes,
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

function renderMarkdown(artifact) {
  return `# Performance: Idle CPU Baseline

Status: ${artifact.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Generated: ${artifact.generatedAt}

## Command

\`bun run qa:packaged:macos:idle-cpu\`

## Result

- Average total CPU: ${artifact.summary.averageTotalCpuPct}%
- Peak total CPU: ${artifact.summary.maxTotalCpuPct}%
- P95 total CPU: ${artifact.summary.p95TotalCpuPct}%
- Threshold: average total CPU <= ${artifact.thresholds.maxAverageCpuPct}%
- Samples: ${artifact.samples.length}
- Warmup: ${artifact.thresholds.warmupMs} ms
- Sample interval: ${artifact.thresholds.sampleIntervalMs} ms

## Process Tree

${artifact.processTree.map((pid) => `- ${pid}`).join("\n")}
`;
}

async function run() {
  quitNautilus();
  await sleep(1500);

  const stdout = [];
  const stderr = [];
  const child = spawn(appExecutablePath, [], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      NAUTILUS_QA_IDLE_CPU: "1",
    },
  });

  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    appExecutablePath,
    rootPid: child.pid ?? null,
    thresholds: {
      warmupMs,
      sampleCount,
      sampleIntervalMs,
      maxAverageCpuPct,
    },
    processTree: [],
    samples: [],
    summary: {
      averageTotalCpuPct: 0,
      maxTotalCpuPct: 0,
      p95TotalCpuPct: 0,
    },
    pass: false,
    appExit: null,
    stdout: { length: 0, tail: "" },
    stderr: { length: 0, tail: "" },
  };

  try {
    await sleep(warmupMs);

    for (let index = 0; index < sampleCount; index += 1) {
      const pids = processTree(child.pid);
      const sample = sampleCpu(pids);
      artifact.processTree = [...new Set([...artifact.processTree, ...pids])].sort(
        (left, right) => left - right
      );
      artifact.samples.push({
        index,
        sampledAt: new Date().toISOString(),
        pids,
        totalCpuPct: sample.totalCpuPct,
        processes: sample.processes,
      });
      if (index < sampleCount - 1) {
        await sleep(sampleIntervalMs);
      }
    }
  } finally {
    quitNautilus();
    const result = await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!result && !child.killed) {
      child.kill("SIGTERM");
      artifact.appExit = await childExit;
    } else {
      artifact.appExit = result;
    }
    artifact.stdout = stderrEvidence(stdout);
    artifact.stderr = stderrEvidence(stderr);
  }

  const totals = artifact.samples.map((sample) => sample.totalCpuPct);
  artifact.summary = {
    averageTotalCpuPct: Number(
      (totals.reduce((total, value) => total + value, 0) / totals.length).toFixed(2)
    ),
    maxTotalCpuPct: Number(Math.max(...totals).toFixed(2)),
    p95TotalCpuPct: Number(percentile(totals, 95).toFixed(2)),
  };
  artifact.pass =
    artifact.samples.length === sampleCount &&
    artifact.summary.averageTotalCpuPct <= maxAverageCpuPct;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(artifact)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
  process.exit(artifact.pass ? 0 : 1);
}

run().catch((error) => {
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    appExecutablePath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(
    markdownPath,
    `# Performance: Idle CPU Baseline

Status: FAIL
Owner: qa-macos
Generated: ${artifact.generatedAt}

## Error

${artifact.error}
`,
    "utf8"
  );
  console.error(artifact.error);
  process.exit(1);
});
