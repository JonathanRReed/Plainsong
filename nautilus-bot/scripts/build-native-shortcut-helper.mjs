#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "scripts/native-macos-shortcut-helper.swift");
const outputPath = resolve(repoRoot, "dist-native/plainsong-native-shortcut-helper");
const entitlementsPath = resolve(
  repoRoot,
  "build-resources/entitlements.mac.shortcut-helper.plist",
);
const swiftArchitecture = process.arch === "x64" ? "x86_64" : process.arch;
const deploymentTarget = `${swiftArchitecture}-apple-macosx13.0`;

if (process.platform !== "darwin") {
  console.log("Skipping native macOS shortcut helper build on non-macOS host.");
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });

// Match the app's documented macOS 13 support floor instead of inheriting the
// active Command Line Tools SDK's deployment target.
const result = spawnSync(
  "swiftc",
  [sourcePath, "-O", "-target", deploymentTarget, "-o", outputPath],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const signature = spawnSync(
  "/usr/bin/codesign",
  [
    "--force",
    "--sign",
    "-",
    "--entitlements",
    entitlementsPath,
    outputPath,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
if (signature.error) {
  throw signature.error;
}
process.exit(signature.status ?? 1);
