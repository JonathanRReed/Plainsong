#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  repoRoot,
  "scripts/native-macos-language-model-helper.swift",
);
const outputPath = resolve(
  repoRoot,
  "dist-native/plainsong-native-language-model-helper",
);
const entitlementsPath = resolve(
  repoRoot,
  "build-resources/entitlements.mac.language-model-helper.plist",
);

// The app's documented macOS 13 support floor, not the active Command Line
// Tools SDK's default, and arm64 to match the arm64-only beta target and the
// packaged-helper gate. FoundationModels itself needs macOS 26; the helper is
// compiled against whatever SDK is installed but *runs* on 13, answering
// `available: false` everywhere below 26. That is deliberate: one binary that
// reports honestly beats a build that refuses to link on the support floor.
const deploymentTarget = "arm64-apple-macosx13.0";

if (process.platform !== "darwin") {
  console.log(
    "Skipping native macOS language model helper build on non-macOS host.",
  );
  process.exit(0);
}

for (const required of [sourcePath, entitlementsPath]) {
  if (!existsSync(required)) {
    console.error(`Language model helper build input is missing: ${required}`);
    process.exit(1);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
// A stale binary that survives a failed compile is worse than no binary: the
// packaging gate would sign and ship the previous protocol.
rmSync(outputPath, { force: true });

// No `-framework FoundationModels` on the command line. The source imports it
// behind `#if canImport(FoundationModels)`, and Swift autolinks what it
// actually imported, so an SDK without the framework still produces a working
// binary instead of a link error.
const compile = spawnSync(
  "swiftc",
  [
    sourcePath,
    "-O",
    "-target",
    deploymentTarget,
    "-framework",
    "Foundation",
    "-o",
    outputPath,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" },
  },
);

if (compile.error) {
  throw compile.error;
}
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

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
