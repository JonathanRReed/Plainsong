#!/usr/bin/env bun
// Builds plainsong-native-asr-helper: Parakeet on the Neural Engine through
// FluidAudio, spoken to by the Rust sidecar over stdio
// (rust-sidecar/src/asr/neural_engine.rs).
//
// FluidAudio is pinned twice: `exact:` in Package.swift and the revision in
// Package.resolved, which `--force-resolved-versions` makes binding, so a
// build can never float to another release. Its optional prebuilt text
// normalizer is turned off in Package.swift; the helper is built from source.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const packagePath = resolve(repoRoot, "rust-sidecar/native/asr_helper");
const scratchPath = resolve(repoRoot, "dist-native/asr-helper-build");
const outputPath = resolve(repoRoot, "dist-native/plainsong-native-asr-helper");
const entitlementsPath = resolve(
  repoRoot,
  "build-resources/entitlements.mac.asr-helper.plist",
);

if (process.platform !== "darwin") {
  console.log("Skipping native ASR helper build on non-macOS host.");
  process.exit(0);
}

for (const required of [
  resolve(packagePath, "Package.swift"),
  resolve(packagePath, "Package.resolved"),
  entitlementsPath,
]) {
  if (!existsSync(required)) {
    console.error(`ASR helper build input is missing: ${required}`);
    process.exit(1);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
// A stale binary that survives a failed build would be signed and shipped
// with the previous protocol.
rmSync(outputPath, { force: true });

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    // FluidAudio's floor; the sidecar never starts the helper below it.
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("swift", [
  "build",
  "-c",
  "release",
  "--jobs",
  "4",
  "--arch",
  "arm64",
  "--package-path",
  packagePath,
  "--scratch-path",
  scratchPath,
  "--force-resolved-versions",
]);

copyFileSync(resolve(scratchPath, "release/PlainsongAsrHelper"), outputPath);

// Ad-hoc signature for local builds, with the hardened runtime so a dev run
// exercises the same runtime policy as the shipped binary. electron-builder
// re-signs the packaged copy with the Developer ID identity and these same
// (empty) entitlements, routed by scripts/sign-macos.mjs.
run("/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--entitlements",
  entitlementsPath,
  outputPath,
]);

run("python3", [resolve(repoRoot, "scripts/test-native-asr-helper.py"), outputPath]);
