#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const defaultOut = path.join(
  artifactsDir,
  process.platform === "darwin"
    ? "local-release-macos.json"
    : process.platform === "win32"
      ? "local-release-windows.json"
      : "local-release-linux.json"
);

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) {
    return fallback;
  }
  return args[index + 1];
}

function run(label, command, commandArgs, { allowFailure = false } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const passed = (result.status ?? 1) === 0;

  return {
    label,
    command: [command, ...commandArgs].join(" "),
    startedAt,
    finishedAt: new Date().toISOString(),
    passed,
    expectedFailure: allowFailure && !passed,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function parseJsonOutput(check) {
  if (!check?.stdout) {
    return null;
  }
  try {
    return JSON.parse(check.stdout);
  } catch {
    const jsonStart = check.stdout.indexOf("{");
    if (jsonStart < 0) {
      return null;
    }
    try {
      return JSON.parse(check.stdout.slice(jsonStart));
    } catch {
      return null;
    }
  }
}

function currentPlatformChecks() {
  const checks = [
    run("lint", "bun", ["run", "lint"]),
    run("test", "bun", ["run", "test"]),
    run("dictation-artifacts", "bun", ["run", "gate:dictation:artifacts"]),
    run("prompt-eval", "bun", ["run", "gate:prompt-eval"]),
    run("benchmark-refresh", "bun", ["run", "benchmark:dictation:fixtures:refresh"]),
    run("benchmark-gate-macos", "bun", ["run", "gate:benchmark:macos"]),
    run("benchmark-gate-windows", "bun", ["run", "gate:benchmark:windows"]),
    run("electron-build", "bun", ["run", "electron:build"]),
  ];

  if (process.platform === "darwin") {
    checks.push(run("build-dmg-helper", "node", ["scripts/build-dmg.mjs"]));
    checks.push(run("size-gate", "bun", ["run", "gate:size"]));
    checks.push(
      run("codesign-verify", "codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        "release/mac-arm64/Nautilus.app",
      ])
    );
    checks.push(
      run(
        "spctl-assess",
        "spctl",
        ["-a", "-vv", "release/mac-arm64/Nautilus.app"],
        { allowFailure: true }
      )
    );
  }

  return checks;
}

const checks = currentPlatformChecks();
const pass = checks.every((check) => check.passed || check.expectedFailure);
const blockingFailures = checks.filter((check) => !check.passed && !check.expectedFailure);
const outputPath = path.resolve(repoRoot, valueFor("--out", defaultOut));
const sizeGate = parseJsonOutput(checks.find((check) => check.label === "size-gate"));

const artifact = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  pass,
  blockingFailures: blockingFailures.map((check) => ({
    label: check.label,
    command: check.command,
    exitCode: check.exitCode,
  })),
  observations: {
    promptEval: parseJsonOutput(checks.find((check) => check.label === "prompt-eval")),
    sizeGate: sizeGate
      ? {
          target: sizeGate.target,
          sizeMb: sizeGate.sizeMb,
          maxMb: sizeGate.maxMb,
          pass: sizeGate.pass,
        }
      : null,
  },
  checks,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));

if (!pass) {
  process.exit(1);
}
