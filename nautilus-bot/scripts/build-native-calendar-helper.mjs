#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "scripts/native-macos-calendar-helper.swift");
const outputPath = resolve(repoRoot, "dist-native/plainsong-native-calendar-helper");
const entitlementsPath = resolve(
  repoRoot,
  "build-resources/entitlements.mac.calendar-helper.plist",
);
const infoPlistPath = resolve(
  repoRoot,
  "build-resources/info.mac.calendar-helper.plist",
);

// The app's documented macOS 13 support floor, not the active Command Line
// Tools SDK's default. Fixed at arm64 to match the arm64-only beta target and
// the packaged-helper gate, which rejects a fat or x86_64 binary.
const deploymentTarget = "arm64-apple-macosx13.0";

if (process.platform !== "darwin") {
  console.log("Skipping native macOS calendar helper build on non-macOS host.");
  process.exit(0);
}

for (const required of [sourcePath, entitlementsPath, infoPlistPath]) {
  if (!existsSync(required)) {
    console.error(`Calendar helper build input is missing: ${required}`);
    process.exit(1);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
// A stale binary that survives a failed compile is worse than no binary: the
// packaging gate would sign and ship the previous protocol.
rmSync(outputPath, { force: true });

const compile = spawnSync(
  "swiftc",
  [
    sourcePath,
    "-O",
    "-target",
    deploymentTarget,
    "-framework",
    "EventKit",
    "-framework",
    "Foundation",
    // TCC reads the usage strings out of the binary's own __info_plist section;
    // a command-line helper has no bundle to put an Info.plist beside. Same
    // technique rust-sidecar/build.rs uses for the Speech helper.
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    infoPlistPath,
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
