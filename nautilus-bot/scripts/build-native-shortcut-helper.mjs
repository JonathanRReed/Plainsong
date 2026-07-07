#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "scripts/native-macos-shortcut-helper.swift");
const outputPath = resolve(repoRoot, "dist-native/plainsong-native-shortcut-helper");

if (process.platform !== "darwin") {
  console.log("Skipping native macOS shortcut helper build on non-macOS host.");
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });

const result = spawnSync(
  "swiftc",
  [sourcePath, "-O", "-o", outputPath],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
