#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
const UPDATER_PUBKEY_PLACEHOLDER = "TODO_REPLACE_WITH_OUTPUT_OF_tauri_signer_generate";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseBundles(args) {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--bundles" || value === "-b") {
      return args[i + 1] ?? null;
    }
    if (value.startsWith("--bundles=")) {
      return value.slice("--bundles=".length);
    }
    if (value.startsWith("-b=")) {
      return value.slice(3);
    }
  }
  return null;
}

function removeBundleArgs(args) {
  const filtered = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--bundles" || value === "-b") {
      i += 1;
      continue;
    }
    if (value.startsWith("--bundles=") || value.startsWith("-b=")) {
      continue;
    }
    filtered.push(value);
  }
  return filtered;
}

function archSuffix() {
  if (process.arch === "arm64") {
    return "aarch64";
  }
  if (process.arch === "x64") {
    return "x64";
  }
  return process.arch;
}

function ensureUpdaterPubkey() {
  if (!existsSync(tauriConfigPath)) {
    throw new Error(`Expected Tauri config not found at ${tauriConfigPath}`);
  }

  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const updater = tauriConfig?.plugins?.updater;
  if (!updater) {
    throw new Error("plugins.updater config is missing in src-tauri/tauri.conf.json");
  }

  const currentPubkey = String(updater.pubkey ?? "").trim();
  const envPubkey = String(process.env.TAURI_SIGNING_PUBLIC_KEY ?? "").trim();

  if (envPubkey) {
    if (currentPubkey !== envPubkey) {
      tauriConfig.plugins.updater.pubkey = envPubkey;
      writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, "utf8");
      console.log("Injected updater pubkey from TAURI_SIGNING_PUBLIC_KEY");
    }
    return;
  }

  const ci = String(process.env.CI ?? "").toLowerCase();
  const runningInCi = ci === "1" || ci === "true" || ci === "yes";
  if (runningInCi && currentPubkey === UPDATER_PUBKEY_PLACEHOLDER) {
    throw new Error(
      "TAURI_SIGNING_PUBLIC_KEY is missing and updater pubkey is still placeholder. Refusing CI build."
    );
  }
}

function buildDmgWithApfs() {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  const productName = tauriConfig.productName || packageJson.name || "Nautilus";
  const version = tauriConfig.version || packageJson.version;
  if (!version) {
    throw new Error("Could not resolve app version for DMG naming.");
  }

  const bundleDir = path.join(projectRoot, "src-tauri", "target", "release", "bundle");
  const macosDir = path.join(bundleDir, "macos");
  const dmgDir = path.join(bundleDir, "dmg");
  const appName = `${productName}.app`;
  const appPath = path.join(macosDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`Expected app bundle not found at ${appPath}`);
  }
  mkdirSync(dmgDir, { recursive: true });

  const dmgName = `${productName}_${version}_${archSuffix()}.dmg`;
  const dmgPath = path.join(dmgDir, dmgName);
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), "nautilus-dmg-"));
  try {
    cpSync(appPath, path.join(stagingDir, appName), { recursive: true });
    symlinkSync("/Applications", path.join(stagingDir, "Applications"));

    run("hdiutil", [
      "create",
      "-volname",
      productName,
      "-srcfolder",
      stagingDir,
      "-fs",
      "APFS",
      "-format",
      "UDZO",
      "-ov",
      dmgPath,
    ]);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const command = args[0];

if (command === "build") {
  ensureUpdaterPubkey();
}

// Forward all non-build commands to the Tauri CLI unchanged.
if (command !== "build" || process.platform !== "darwin") {
  run("tauri", args);
  process.exit(0);
}

const bundles = parseBundles(args.slice(1));
const bundleTargets = bundles
  ? bundles
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  : null;
const wantsDmg = !bundleTargets || bundleTargets.includes("all") || bundleTargets.includes("dmg");

if (!wantsDmg) {
  run("tauri", args);
  process.exit(0);
}

const buildArgs = removeBundleArgs(args.slice(1));
run("tauri", ["build", "--bundles", "app", ...buildArgs]);

try {
  buildDmgWithApfs();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create APFS DMG: ${message}`);
  process.exit(1);
}
