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
  const mergedEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const privateKeyPath = String(mergedEnv.TAURI_SIGNING_PRIVATE_KEY_PATH ?? "").trim();
  const privateKey = String(mergedEnv.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
  if (!privateKey && privateKeyPath) {
    if (!existsSync(privateKeyPath)) {
      throw new Error(`TAURI_SIGNING_PRIVATE_KEY_PATH does not exist: ${privateKeyPath}`);
    }
    mergedEnv.TAURI_SIGNING_PRIVATE_KEY = readFileSync(privateKeyPath, "utf8").trim();
  }
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
    env: mergedEnv,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isTruthyEnv(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveLocalMacSigningIdentity() {
  if (process.platform !== "darwin") {
    return null;
  }

  if (process.env.APPLE_SIGNING_IDENTITY) {
    return process.env.APPLE_SIGNING_IDENTITY;
  }

  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    return null;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const preferredIdentity = "Nautilus Local Dev";
  return output.includes(`"${preferredIdentity}"`) ? preferredIdentity : null;
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

  const runningInCi = isTruthyEnv(process.env.CI);
  if (runningInCi && currentPubkey === UPDATER_PUBKEY_PLACEHOLDER) {
    throw new Error(
      "TAURI_SIGNING_PUBLIC_KEY is missing and updater pubkey is still placeholder. Refusing CI build."
    );
  }
}

function hasUpdaterPrivateKey() {
  return Boolean(
    String(process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim() ||
      String(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? "").trim()
  );
}

function applyLocalBuildOverrides(args) {
  const runningInCi = isTruthyEnv(process.env.CI);
  const hasPrivateKey = hasUpdaterPrivateKey();

  if (runningInCi && !hasPrivateKey) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required in CI builds when updater is active."
    );
  }

  if (hasPrivateKey) {
    return { args, cleanup: () => {} };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nautilus-tauri-config-"));
  const overridePath = path.join(tempDir, "tauri.local-build.override.json");
  writeFileSync(
    overridePath,
    `${JSON.stringify({ bundle: { createUpdaterArtifacts: false } }, null, 2)}\n`,
    "utf8"
  );
  console.log("No updater private key found. Disabling updater artifact generation for this local build.");
  return {
    args: [...args, "--config", overridePath],
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function removeStaleReleaseArtifacts() {
  const releaseDir = path.join(projectRoot, "src-tauri", "target", "release");
  const stalePaths = [
    path.join(releaseDir, "dictation-parity-benchmark"),
    path.join(releaseDir, "dictation-parity-benchmark.d"),
    path.join(releaseDir, "dictation-parity-benchmark.dSYM"),
    path.join(
      releaseDir,
      "bundle",
      "macos",
      "Nautilus.app",
      "Contents",
      "MacOS",
      "dictation-parity-benchmark"
    ),
  ];

  for (const stalePath of stalePaths) {
    if (existsSync(stalePath)) {
      rmSync(stalePath, { recursive: true, force: true });
    }
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
  const signingIdentity = resolveLocalMacSigningIdentity();
  removeStaleReleaseArtifacts();
  const { args: localBuildArgs, cleanup } = applyLocalBuildOverrides(args);
  try {
    run("tauri", localBuildArgs, {
      env: signingIdentity ? { APPLE_SIGNING_IDENTITY: signingIdentity } : undefined,
    });
  } finally {
    cleanup();
  }
  process.exit(0);
}

const buildArgs = removeBundleArgs(args.slice(1));
const signingIdentity = resolveLocalMacSigningIdentity();
if (signingIdentity) {
  console.log(`Using macOS signing identity: ${signingIdentity}`);
}
removeStaleReleaseArtifacts();
const { args: appBuildArgs, cleanup: cleanupLocalOverrides } = applyLocalBuildOverrides([
  "build",
  "--bundles",
  "app",
  ...buildArgs,
]);
try {
  run("tauri", appBuildArgs, {
    env: signingIdentity ? { APPLE_SIGNING_IDENTITY: signingIdentity } : undefined,
  });
} finally {
  cleanupLocalOverrides();
}

try {
  buildDmgWithApfs();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create APFS DMG: ${message}`);
  process.exit(1);
}
