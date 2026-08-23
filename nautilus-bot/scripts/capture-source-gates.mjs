#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/source-gates.json")
);
const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const maxOutputChars = Number(valueFor("--max-output-chars", "12000"));

const gateCommands = [
  { id: "lint", command: "bun", args: ["run", "lint"] },
  { id: "tests", command: "bun", args: ["run", "test"] },
  { id: "rust-tests", command: "bun", args: ["run", "test:rust"] },
  { id: "renderer-build", command: "bun", args: ["run", "build:renderer"] },
  { id: "electron-build", command: "bun", args: ["run", "build:electron"] },
  { id: "ipc-contract", command: "bun", args: ["run", "gate:ipc-contract"] },
  { id: "dead-code", command: "bun", args: ["run", "gate:dead-code"] },
  {
    id: "dependency-audit",
    command: "bun",
    args: ["run", "gate:release:dependencies", "--", "--app", appPath],
  },
  {
    id: "rust-dependency-audit",
    command: "bun",
    args: ["run", "gate:release:rust-dependencies"],
  },
  { id: "diff-check", command: "git", args: ["diff", "--check"] },
];

function run(command, commandArgs) {
  const startedAt = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  return {
    command: [command, ...commandArgs].join(" "),
    status: result.status ?? null,
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
    stdoutTail: stdout.slice(-maxOutputChars),
    stderrTail: stderr.slice(-maxOutputChars),
    spawnError: result.error?.message ?? null,
    pass: result.status === 0,
  };
}

function gitOutput(commandArgs) {
  const result = spawnSync("git", commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

function sourcePathInScope(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return (
    /^(src|electron|rust-sidecar|scripts|native|resources)\//.test(normalized) ||
    /^(package\.json|bun\.lock|electron-builder\.yml|vite(?:st)?\.config\.[^/]+|tsconfig[^/]*\.json)$/.test(
      normalized
    )
  );
}

function sourceSnapshot() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  if (result.status !== 0) {
    return {
      pass: false,
      sha256: null,
      fileCount: 0,
      error: String(result.stderr ?? "git ls-files failed"),
    };
  }

  const files = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(sourcePathInScope)
    .sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }
  return {
    pass: true,
    sha256: hash.digest("hex"),
    fileCount: files.length,
    error: null,
  };
}

const generatedAt = new Date().toISOString();
const headRevision = gitOutput(["rev-parse", "HEAD"]);
const branch = gitOutput(["branch", "--show-current"]);
const porcelain = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
const gitDiff = gitOutput(["diff", "--binary", "--no-ext-diff"]) ?? "";
const snapshot = sourceSnapshot();
const gates = gateCommands.map((gate) => ({
  id: gate.id,
  ...run(gate.command, gate.args),
}));
const pass = snapshot.pass && gates.every((gate) => gate.pass);
const artifact = {
  schemaVersion: 1,
  generatedAt,
  repoRoot,
  pass,
  sourceIdentity: {
    headRevision,
    branch,
    workingTreeEntryCount: porcelain ? porcelain.split(/\r?\n/).length : 0,
    workingTreeStatusSha256: crypto.createHash("sha256").update(porcelain).digest("hex"),
    trackedDiffSha256: crypto.createHash("sha256").update(gitDiff).digest("hex"),
    sourceSnapshotSha256: snapshot.sha256,
    sourceFileCount: snapshot.fileCount,
    sourceSnapshotError: snapshot.error,
    note:
      "sourceSnapshotSha256 hashes the path and contents of tracked and untracked source, build, " +
      "native, script, package, and configuration files in scope. Release outputs, QA artifacts, " +
      "dependencies, and Git metadata are excluded.",
  },
  summary: {
    total: gates.length,
    passed: gates.filter((gate) => gate.pass).length,
    failed: gates.filter((gate) => !gate.pass).length,
  },
  gates,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = pass ? 0 : 1;
