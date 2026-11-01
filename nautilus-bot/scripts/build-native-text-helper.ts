#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(repoRoot, "rust-sidecar/text-helper/Cargo.toml");
const builtPath = resolve(
  repoRoot,
  "rust-sidecar/text-helper/target/release/plainsong-text-helper",
);
const outputPath = resolve(repoRoot, "dist-native/plainsong-text-helper");
const entitlementsPath = resolve(
  repoRoot,
  "build-resources/entitlements.mac.text-helper.plist",
);

if (process.platform !== "darwin") {
  console.log("Skipping native macOS text helper build on non-macOS host.");
  process.exit(0);
}

for (const required of [manifestPath, entitlementsPath]) {
  if (!existsSync(required)) {
    console.error(`Text helper build input is missing: ${required}`);
    process.exit(1);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
// A stale binary that survives a failed build is worse than no binary: the
// packaging gate would sign and ship the previous protocol.
rmSync(outputPath, { force: true });

// Cargo reads CARGO_BUILD_JOBS from the inherited environment.
const build = spawnSync(
  process.execPath,
  ["scripts/cargo-sidecar.ts", "--text-helper", "build", "--release", "--locked"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  },
);
if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
if (!existsSync(builtPath)) {
  console.error(`Text helper build did not produce ${builtPath}`);
  process.exit(1);
}

copyFileSync(builtPath, outputPath);

// Ad-hoc signature for local builds. electron-builder re-signs the packaged
// copy with the Developer ID identity and these same entitlements, routed by
// scripts/sign-macos.mjs.
const signature = spawnSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "--entitlements", entitlementsPath, outputPath],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
if (signature.error) {
  throw signature.error;
}
process.exit(signature.status ?? 1);
