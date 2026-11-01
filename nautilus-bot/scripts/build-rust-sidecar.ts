#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";
import { recordCargoExecutable, requireCargoExecutables } from "./lib/cargo-output-path.ts";
import { sidecarBuildReceiptPath, writeSidecarBuildReceipt } from "./lib/sidecar-build-receipt.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "rust-sidecar", "Cargo.toml");
const env = { ...process.env };
// A failed build must not leave a previous receipt authorizing packaging.
fs.rmSync(sidecarBuildReceiptPath(repoRoot), { force: true });

// The Electron bundle supports macOS 13. Keep the Rust executable's Mach-O
// deployment target aligned with that floor while the Core Audio 14.2 symbols
// are resolved dynamically by the vendored CPAL patch.
if (process.platform === "darwin") {
  env.MACOSX_DEPLOYMENT_TARGET = "13.0";
}

// On macOS the shipped sidecar also compiles the opt-in acceleration features
// (currently Candle's Metal backend). The list, and why it is Darwin-only,
// lives in scripts/sidecar-cargo-features.ts so lint/test/benchmark and the
// third-party notices resolve the same feature set. Other hosts get `[]`.
const outputs = new Map<string, string>();
const cargo = spawn(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--message-format=json-render-diagnostics",
    "--manifest-path",
    manifestPath,
    ...sidecarCargoFeatureArgs(),
    "--bin",
    "plainsong-sidecar",
    // The `plainsong` command-line tool / MCP server ships beside the sidecar.
    "--bin",
    "plainsong-cli",
  ],
  {
    cwd: repoRoot,
    env,
    stdio: ["inherit", "pipe", "inherit"],
  },
);

const lines = createInterface({ input: cargo.stdout });
let receiptError: unknown;
lines.on("line", (line) => {
  try {
    const diagnostic = recordCargoExecutable(line, outputs, manifestPath);
    if (diagnostic) process.stderr.write(diagnostic);
  } catch (error) {
    receiptError ??= error;
  }
});
const status = await new Promise<number>((resolve) => {
  cargo.on("error", (error) => {
    console.error(`Failed to launch cargo: ${error.message}`);
    resolve(1);
  });
  cargo.on("close", (code) => resolve(code ?? 1));
});
if (status !== 0) process.exit(status);

let binaries: Map<string, string>;
try {
  if (receiptError) throw receiptError;
  binaries = requireCargoExecutables(outputs, ["plainsong-sidecar", "plainsong-cli"]);
  for (const [name, executable] of binaries) {
    if (!fs.statSync(executable).isFile()) throw new Error(`${name} output is not a file: ${executable}`);
  }
} catch (error) {
  console.error(`Failed to resolve Cargo build outputs: ${(error as Error).message}`);
  process.exit(1);
}

// The release profile leaves stripping to this step (see `strip = false` in
// Cargo.toml): rustc's own macOS stripper writes a symbol table dyld rejects.
// Apple's /usr/bin/strip does not. Windows keeps its symbols in the PDB.
if (process.platform !== "win32") {
  const strip = process.platform === "darwin" ? "/usr/bin/strip" : "strip";
  for (const [binary, binaryPath] of binaries) {
    const stripped = spawnSync(strip, [binaryPath], { stdio: "inherit" });
    if (stripped.error || stripped.status !== 0) {
      console.error(`Failed to strip ${binary}: ${stripped.error?.message ?? `exit ${stripped.status}`}`);
      process.exit(1);
    }
  }
}

const auditArgs = [
  path.join(repoRoot, "scripts", "verify-macos-system-audio.ts"),
  // requireCargoExecutables above guarantees the sidecar entry.
  binaries.get("plainsong-sidecar")!,
];
if (process.platform !== "darwin") {
  auditArgs.push("--source-only");
}
const audit = spawnSync(process.execPath, auditArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (audit.error) {
  console.error(`Failed to launch system-audio audit: ${audit.error.message}`);
  process.exit(1);
}
if (audit.status !== 0) {
  process.exit(audit.status ?? 1);
}

const speechHelperArgs = [
  path.join(repoRoot, "scripts", "verify-macos-speech-helper.mjs"),
];
if (process.platform !== "darwin") {
  speechHelperArgs.push("--source-only");
}
const speechHelperAudit = spawnSync(process.execPath, speechHelperArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (speechHelperAudit.error) {
  console.error(
    `Failed to launch macOS Speech helper audit: ${speechHelperAudit.error.message}`,
  );
  process.exit(1);
}
if (speechHelperAudit.status !== 0) process.exit(speechHelperAudit.status ?? 1);
try {
  writeSidecarBuildReceipt(repoRoot, binaries, { profile: "release" });
} catch (error) {
  console.error(`Failed to write sidecar build receipt: ${(error as Error).message}`);
  process.exit(1);
}
