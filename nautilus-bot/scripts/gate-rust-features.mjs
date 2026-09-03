#!/usr/bin/env node
/**
 * Check that the Rust sidecar still compiles for feature combinations other
 * than the one it ships with.
 *
 * # Why this exists
 *
 * `lint:rust` and `test:rust` build the shipped configuration only (default
 * features plus, on macOS, the acceleration features in
 * `scripts/sidecar-cargo-features.mjs`). That set turns everything on, so a
 * module that reaches for an optional dependency without gating it compiles
 * there and nowhere else. `src/diarization/` did exactly that: it used
 * `ndarray` unconditionally, while `ndarray` is only pulled in by
 * `asr-parakeet`, `asr-canary` and `diarization` — so any build that left
 * those off failed with unresolved-import and type-inference errors that no
 * gate would have caught.
 *
 * A `cargo check` per combination is cheap next to a full build and is the
 * smallest thing that keeps the feature flags honest.
 *
 * # What is checked
 *
 * `--lib --tests`, because the test targets are where the untracked optional
 * imports tend to hide (a `use ndarray::array;` inside a `#[cfg(test)]` module
 * breaks the same way and is invisible to `--lib` alone).
 *
 * This is a compile check, not a behavior gate: it must not change what the
 * shipped build does, and it never runs a binary.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "rust-sidecar", "Cargo.toml");

/**
 * Combinations worth holding. Each one leaves out something the shipped set
 * turns on, so between them every optional dependency is absent somewhere.
 *
 * @type {{ name: string, why: string, features: string[] }[]}
 */
const COMBINATIONS = [
  {
    name: "whisper.cpp only",
    why: "no ndarray, no ort, no candle: the narrowest ASR build",
    features: ["asr-whisper"],
  },
  {
    name: "Parakeet only",
    why: "ort and ndarray present, diarization off",
    features: ["asr-parakeet"],
  },
  {
    name: "diarization only",
    why: "the diarization backend without any ASR provider feature",
    features: ["diarization"],
  },
  {
    name: "transcribe.cpp only",
    why: "the optional ggml ASR runtime with no ort, ndarray or candle beside it",
    features: ["asr-transcribe-cpp"],
  },
];

let failed = 0;
for (const combination of COMBINATIONS) {
  const features = combination.features.join(",");
  const label = `${combination.name} (--features ${features}) — ${combination.why}`;
  process.stdout.write(`\n▸ ${label}\n`);
  const result = spawnSync(
    "cargo",
    [
      "check",
      "--locked",
      "--manifest-path",
      manifestPath,
      "--no-default-features",
      "--features",
      features,
      "--lib",
      "--tests",
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) {
    console.error(`Failed to launch cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${label}`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} of ${COMBINATIONS.length} feature combinations failed to compile.`,
  );
  process.exit(1);
}
console.log(
  `\nAll ${COMBINATIONS.length} non-shipped feature combinations compile.`,
);
