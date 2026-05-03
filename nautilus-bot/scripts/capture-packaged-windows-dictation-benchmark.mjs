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

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${output}`);
  }
  return output;
}

const appPath = path.resolve(repoRoot, valueFor("--app", "release/win-unpacked"));
const fixturesPath = path.resolve(
  repoRoot,
  valueFor("--fixtures", "docs/evals/dictation-parity-fixture.json")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "docs/evals/benchmark-run-packaged-windows.json")
);
const reportPath = path.resolve(
  repoRoot,
  valueFor("--report", "artifacts/benchmark-packaged-windows.json")
);
const gatePath = path.resolve(
  repoRoot,
  valueFor("--gate", "artifacts/benchmark-gates-packaged-windows.json")
);
const baselinePath = path.resolve(
  repoRoot,
  valueFor("--baseline", "docs/evals/benchmark-run-baseline.json")
);
const schemaPath = path.resolve(
  repoRoot,
  valueFor("--schema", "docs/evals/benchmark-run.schema.json")
);
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const sidecarPath = path.join(appPath, "resources", "sidecar", "nautilus-sidecar.exe");

function blockedReport(reason) {
  return {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    fixturesPath,
    outPath,
    gatePath,
    pass: false,
    status: "BLOCKED",
    reason,
    packagedEvidence: true,
    platform: "Windows",
  };
}

function finish(report, exitCode) {
  writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

if (process.platform !== "win32") {
  finish(
    blockedReport("Run this helper on Windows with a packaged win-unpacked build."),
    0
  );
}
if (!fs.existsSync(sidecarPath)) {
  finish(blockedReport(`Packaged sidecar not found at ${sidecarPath}`), 0);
}
if (!fs.existsSync(fixturesPath)) {
  finish(blockedReport(`Fixture file not found: ${fixturesPath}`), 0);
}

const fixture = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
const generatedAt = new Date().toISOString();
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const commit = shellOut("git", ["rev-parse", "--short", "HEAD"]) ?? "unknown0";
const windowsVersion = os.release();
const device = `${os.type()} ${os.arch()} ${os.cpus()[0]?.model ?? "unknown CPU"}`.replace(/\s+/g, " ");

const context = {
  runId: `dictation-parity-packaged-windows-${Date.now()}`,
  generatedAt,
  buildVersion: `Nautilus ${packageJson.version} packaged Windows`,
  buildCommit: commit.length >= 7 ? commit : commit.padEnd(7, "0"),
  platformOs: "Windows",
  platformOsVersion: windowsVersion,
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

  let runResult = null;
  if (response?.result) {
    runResult = response.result;
  } else if (response?.error) {
    parseError = response.error.message ?? String(response.error);
  } else if (!didTimeOut) {
    parseError = "Packaged sidecar exited without benchmark response.";
  }

  const report = {
    generatedAt,
    appPath,
    sidecarPath,
    fixturesPath,
    outPath,
    gatePath,
    pass: false,
    status: "FAIL",
    timedOut: didTimeOut,
    error: parseError,
    runId: runResult?.runId ?? null,
    sampleCount: runResult?.summary?.sampleCount ?? 0,
    packagedEvidence: true,
    platform: "Windows",
    stderr: stderr.join("").trim(),
  };

  try {
    if (runResult) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      writeJson(outPath, runResult);
      run(process.execPath, [
        "scripts/validate-gate-artifact.mjs",
        "--schema",
        path.relative(repoRoot, schemaPath),
        "--file",
        path.relative(repoRoot, outPath),
      ]);
      run(process.execPath, [
        "scripts/verify-benchmark-gates.mjs",
        "--schema",
        path.relative(repoRoot, schemaPath),
        "--baseline",
        path.relative(repoRoot, baselinePath),
        "--candidate",
        path.relative(repoRoot, outPath),
        "--out",
        path.relative(repoRoot, gatePath),
      ]);
    }
    const gate = fs.existsSync(gatePath)
      ? JSON.parse(fs.readFileSync(gatePath, "utf8"))
      : null;
    report.pass = Boolean(code === 0 && !didTimeOut && runResult?.rows?.length > 0 && gate?.pass);
    report.status = report.pass ? "PASS" : "FAIL";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  finish(report, report.pass ? 0 : 1);
});
