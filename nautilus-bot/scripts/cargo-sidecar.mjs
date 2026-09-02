#!/usr/bin/env node
/**
 * Run a cargo subcommand against the Rust sidecar with the same feature set the
 * release build ships on this host.
 *
 *   node scripts/cargo-sidecar.mjs <subcommand> [cargo args...] [-- passthrough]
 *
 * expands to
 *
 *   cargo <subcommand> --manifest-path rust-sidecar/Cargo.toml \
 *         [--features <macOS list> on macOS] [cargo args...] [-- passthrough]
 *
 * so `lint:rust`, `test:rust`, `benchmark:latency`, and CI lint/test the
 * configuration users actually get instead of the narrower `default` set. The
 * feature list itself lives in scripts/sidecar-cargo-features.mjs. Everything
 * after `--` is passed through untouched (clippy lint flags, benchmark CLI
 * flags).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "rust-sidecar", "Cargo.toml");

const [subcommand, ...rest] = process.argv.slice(2);
if (!subcommand || subcommand.startsWith("-")) {
  console.error(
    "Usage: node scripts/cargo-sidecar.mjs <cargo-subcommand> [cargo args...] [-- passthrough args...]",
  );
  process.exit(2);
}

const separator = rest.indexOf("--");
const cargoArgs = separator === -1 ? rest : rest.slice(0, separator);
const passthrough = separator === -1 ? [] : rest.slice(separator);

const result = spawnSync(
  "cargo",
  [
    subcommand,
    "--manifest-path",
    manifestPath,
    ...sidecarCargoFeatureArgs(),
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
process.exit(result.status ?? 1);
