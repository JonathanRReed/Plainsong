#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function shellOut(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Nautilus.app")
);
const fixturesPath = path.resolve(
  repoRoot,
  valueFor("--fixtures", "docs/evals/dictation-parity-fixture.json")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "docs/evals/benchmark-run-packaged-macos.json")
);
const reportPath = path.resolve(
  repoRoot,
  valueFor("--report", "artifacts/benchmark-packaged-macos.json")
);
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);

if (process.platform !== "darwin") {
  fail("capture-packaged-dictation-benchmark can only run on macOS.");
}
if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}
if (!fs.existsSync(fixturesPath)) {
  fail(`Fixture file not found: ${fixturesPath}`);
}

const fixture = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
const generatedAt = new Date().toISOString();
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const commit = shellOut("git", ["rev-parse", "--short", "HEAD"]) ?? "unknown0";
const osVersion = shellOut("sw_vers", ["-productVersion"]) ?? os.release();
const device =
  shellOut("sysctl", ["-n", "machdep.cpu.brand_string"])?.replace(/\s+/g, " ") ??
  `${os.type()} ${os.arch()}`;

const context = {
  runId: `dictation-parity-packaged-macos-${Date.now()}`,
  generatedAt,
  buildVersion: `Nautilus ${packageJson.version} packaged macOS`,
  buildCommit: commit.length >= 7 ? commit : commit.padEnd(7, "0"),
  platformOs: "macOS",
  platformOsVersion: osVersion,
  device,
  latencyScale: Number(valueFor("--latency-scale", "1.0")),
};

const child = spawn(sidecarPath, [], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

let didTimeOut = false;
let response = null;
let parseError = null;

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id !== "1") {
    return;
  }
  response = message;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "shutdown",
      params: {},
    })}\n`
  );
});

const timeout = setTimeout(() => {
  didTimeOut = true;
  child.kill("SIGTERM");
}, timeoutMs);

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    method: "generate_dictation_benchmark_run",
    params: { fixture, context },
  })}\n`
);

child.on("exit", (code) => {
  clearTimeout(timeout);

  let run = null;
  if (response?.result) {
    run = response.result;
  } else if (response?.error) {
    parseError = response.error.message ?? String(response.error);
  } else if (!didTimeOut) {
    parseError = "Packaged sidecar exited without benchmark response.";
  }

  const pass = Boolean(code === 0 && !didTimeOut && run?.rows?.length > 0);
  const report = {
    generatedAt,
    appPath,
    sidecarPath,
    fixturesPath,
    outPath,
    pass,
    timedOut: didTimeOut,
    error: parseError,
    runId: run?.runId ?? null,
    sampleCount: run?.summary?.sampleCount ?? 0,
    packagedEvidence: true,
    platform: "macOS",
    stderr: stderr.join("").trim(),
  };

  if (run) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));

  process.exit(pass ? 0 : 1);
});
