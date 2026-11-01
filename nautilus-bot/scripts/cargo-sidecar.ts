#!/usr/bin/env bun
/**
 * Run a cargo subcommand against the Rust sidecar with the same feature set the
 * release build ships on this host.
 *
 *   bun scripts/cargo-sidecar.ts <subcommand> [cargo args...] [-- passthrough]
 *
 * expands to
 *
 *   cargo <subcommand> --manifest-path rust-sidecar/Cargo.toml \
 *         [--features <macOS list> on macOS] [cargo args...] [-- passthrough]
 *
 * so `lint:rust`, `test:rust`, `benchmark:latency`, and CI lint/test the
 * configuration users actually get instead of the narrower `default` set. The
 * feature list itself lives in scripts/sidecar-cargo-features.ts. Everything
 * after `--` is passed through untouched (clippy lint flags, benchmark CLI
 * flags).
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const helper = process.argv[2] === "--text-helper";
const manifestPath = path.join(repoRoot, "rust-sidecar", ...(helper ? ["text-helper"] : []), "Cargo.toml");

const [subcommand, ...rest] = process.argv.slice(helper ? 3 : 2);
if (!subcommand || subcommand.startsWith("-")) {
  console.error(
    "Usage: bun scripts/cargo-sidecar.ts [--text-helper] <cargo-subcommand> [cargo args...] [-- passthrough args...]",
  );
  process.exit(2);
}

const separator = rest.indexOf("--");
const cargoArgs = separator === -1 ? rest : rest.slice(0, separator);
const passthrough = separator === -1 ? [] : rest.slice(separator);

// Explicit feature-matrix checks must not inherit the host release features.
const result = spawnSync(
  "cargo",
  [
    subcommand,
    "--manifest-path",
    manifestPath,
    ...(subcommand === "fmt" || helper || cargoArgs.includes("--no-default-features") ? [] : sidecarCargoFeatureArgs()),
    ...cargoArgs,
    ...passthrough,
  ],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  // cargo died from a signal (Ctrl-C, a cancelled CI job): re-raise it so the
  // caller sees the same termination instead of a generic exit 1, and fall
  // back to the shell convention of 128 + signal number if the re-raise is
  // caught or ignored.
  console.error(`cargo terminated by ${result.signal}`);
  process.kill(process.pid, result.signal);
  process.exit(128 + (os.constants.signals[result.signal] ?? 0));
}
process.exit(result.status ?? 1);
