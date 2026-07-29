#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function valueFor(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

const strictSecrets = !flag("--allow-missing-secrets");
const strictAssets = !flag("--allow-missing-assets");
// Provision by default so clean CI runners are deterministic.
// `--validate-only` keeps legacy validation-only behavior.
const provisionRequested = flag("--provision");
const provisionEnabled = !flag("--no-provision") && (provisionRequested || !flag("--validate-only"));
const outFile = valueFor("--out");
const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || "";

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

const nautilusDataDir = path.join(defaultDataDir(), "Plainsong");
const modelsRoot =
  valueFor("--models-root") ||
  process.env.PLAINSONG_MODELS_ROOT ||
  path.join(nautilusDataDir, "models");
const bundlePathArg = valueFor("--asset-bundle") || process.env.PLAINSONG_ASR_ASSET_BUNDLE || null;
const bundleUrlArg = valueFor("--asset-bundle-url") || process.env.PLAINSONG_ASR_ASSET_BUNDLE_URL || null;
// Parakeet v3 is ~639 MB. Opt in rather than making every runner pay for it.
const provisionParakeetV3 =
  flag("--parakeet-v3") || process.env.PLAINSONG_PROVISION_PARAKEET_V3 === "1";

const PARAKEET_LEGACY_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000";
const PARAKEET_LEGACY_GRAPH_NAMES = ["encoder.onnx", "model.onnx"];

// Kept in step with PARAKEET_V3_ARTIFACTS in
// `rust-sidecar/src/asr/parakeet.rs`: `[filename, minimum plausible bytes]`.
const PARAKEET_V3_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_V3_ARTIFACTS = [
  ["encoder.int8.onnx", 64 * 1024 * 1024],
  ["decoder.int8.onnx", 1024 * 1024],
  ["joiner.int8.onnx", 512 * 1024],
  ["tokens.txt", 4096],
];

function exists(pathname) {
  try {
    fs.accessSync(pathname, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function stat(pathname) {
  try {
    return fs.statSync(pathname);
  } catch {
    return null;
  }
}

function fileSizeOk(pathname, minBytes = 1) {
  const s = stat(pathname);
  return !!s && s.isFile() && s.size >= minBytes;
}

function parseJson(pathname, minBytes = 2) {
  if (!fileSizeOk(pathname, minBytes)) return null;
  try {
    const content = fs.readFileSync(pathname, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readLeadingByte(pathname) {
  try {
    const fd = fs.openSync(pathname, "r");
    const buf = Buffer.alloc(1);
    const bytes = fs.readSync(fd, buf, 0, 1, 0);
    fs.closeSync(fd);
    if (bytes !== 1) return null;
    return buf[0];
  } catch {
    return null;
  }
}

function looksLikeHtmlOrJsonError(pathname) {
  const b = readLeadingByte(pathname);
  if (b === null) return false;
  return b === 60 || b === 123; // '<' or '{'
}

function isLikelyBinaryArtifact(pathname, minBytes = 1024) {
  if (!fileSizeOk(pathname, minBytes)) return false;
  return !looksLikeHtmlOrJsonError(pathname);
}

function hasParakeetTokens(pathname) {
  if (!fileSizeOk(pathname, 128)) return false;
  try {
    const lines = fs
      .readFileSync(pathname, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 50) return false;
    return lines.slice(0, 8).every((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return false;
      const maybeId = Number(parts[parts.length - 1]);
      return Number.isFinite(maybeId);
    });
  } catch {
    return false;
  }
}

function providerCheck(name, details) {
  return {
    name,
    ready: details.missing.length === 0,
    ...details,
  };
}

function checkWhisper() {
  const dir = path.join(modelsRoot, "whisper");
  const missing = [];
  let candidateCount = 0;
  if (exists(dir)) {
    const entries = fs.readdirSync(dir);
    candidateCount = entries.filter((entry) => {
      if (!entry.endsWith(".bin")) return false;
      return isLikelyBinaryArtifact(path.join(dir, entry), 4096);
    }).length;
  }
  if (candidateCount === 0) {
    missing.push("whisper/*.bin (>= 1KB)");
  }
  return providerCheck("whisper", { modelDir: dir, missing });
}

// The legacy English 110M CTC export: one graph plus tokens. model.onnx is
// 458,161,021 bytes (437 MiB) upstream -- still the smaller of the two Parakeet
// routes against v3's 639 MiB, which is why this is the one the script fetches
// by default, but it is not the ~170 MB this comment used to claim.
function checkParakeetLegacy() {
  const dir = path.join(modelsRoot, "parakeet");
  const missing = [];
  // `encoder.onnx` is the name this script writes and the name
  // `rust-sidecar/src/asr/manager.rs` diagnostics look for; `model.onnx` is what
  // older in-app downloads left behind. The Rust provider accepts either.
  const hasGraph = PARAKEET_LEGACY_GRAPH_NAMES.some((name) =>
    isLikelyBinaryArtifact(path.join(dir, name), 4096)
  );
  if (!hasGraph) missing.push(PARAKEET_LEGACY_GRAPH_NAMES.join("|"));
  if (!hasParakeetTokens(path.join(dir, "tokens.txt"))) missing.push("tokens.txt");
  return providerCheck("parakeet_legacy_110m", { modelDir: dir, missing });
}

// The default Parakeet route: sherpa-onnx's int8 export of
// `nvidia/parakeet-tdt-0.6b-v3`, three graphs plus tokens. Reported always,
// provisioned only on request — see PARAKEET_V3_ARTIFACTS.
function checkParakeetV3() {
  const dir = path.join(modelsRoot, "parakeet", "parakeet-tdt-0.6b-v3");
  const missing = [];
  for (const [file, minBytes] of PARAKEET_V3_ARTIFACTS) {
    const fullPath = path.join(dir, file);
    const ok =
      file === "tokens.txt"
        ? hasParakeetTokens(fullPath)
        : isLikelyBinaryArtifact(fullPath, minBytes);
    if (!ok) missing.push(file);
  }
  return providerCheck("parakeet_tdt_v3", {
    modelDir: dir,
    missing,
    optional: !provisionParakeetV3,
  });
}

function checkCanary() {
  const dir = path.join(modelsRoot, "canary");
  const missing = [];
  const required = [
    ["model.safetensors", 1024],
    ["config.json", 64],
    ["tokenizer.json", 64],
    ["preprocessor_config.json", 64],
  ];
  for (const [file, minBytes] of required) {
    const fullPath = path.join(dir, file);
    if (file.endsWith(".json")) {
      if (!parseJson(fullPath, minBytes)) missing.push(file);
    } else if (!isLikelyBinaryArtifact(fullPath, minBytes)) {
      missing.push(file);
    }
  }
  return providerCheck("canary", { modelDir: dir, missing });
}

function checkDistil() {
  const dir = path.join(modelsRoot, "distil_whisper");
  const missing = [];
  const required = [
    ["model.safetensors", 1024],
    ["config.json", 64],
    ["tokenizer.json", 64],
    ["preprocessor_config.json", 64],
  ];
  for (const [file, minBytes] of required) {
    const fullPath = path.join(dir, file);
    if (file.endsWith(".json")) {
      if (!parseJson(fullPath, minBytes)) missing.push(file);
    } else if (!isLikelyBinaryArtifact(fullPath, minBytes)) {
      missing.push(file);
    }
  }
  return providerCheck("distil_whisper", { modelDir: dir, missing });
}

function checkMoonshine() {
  const dir = path.join(modelsRoot, "moonshine");
  const missing = [];
  if (!isLikelyBinaryArtifact(path.join(dir, "encoder_model.onnx"), 4096)) {
    missing.push("encoder_model.onnx");
  }
  if (!isLikelyBinaryArtifact(path.join(dir, "decoder_model_merged.onnx"), 4096)) {
    missing.push("decoder_model_merged.onnx");
  }
  if (!parseJson(path.join(dir, "tokenizer.json"), 1024)) missing.push("tokenizer.json");
  return providerCheck("moonshine", { modelDir: dir, missing });
}

function checkCloudSecrets() {
  // MISTRAL_API_KEY used to be here for Voxtral. Voxtral is gone, and no
  // surviving ASR provider reads a Mistral key, so requiring one would fail
  // runs for a capability that no longer exists.
  const required = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"];
  const entries = required.map((name) => {
    const value = process.env[name] || "";
    return { name, present: value.trim().length > 0 };
  });
  const missing = entries.filter((entry) => !entry.present).map((entry) => entry.name);
  return { entries, missing, ready: missing.length === 0 };
}

async function downloadFile(url, destination) {
  const headers = {
    "user-agent": "nautilus-asr-provisioner/1.0",
  };
  if (hfToken) {
    headers.authorization = `Bearer ${hfToken}`;
  }

  const response = await fetch(url, {
    headers,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("download returned empty body");
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmpPath = `${destination}.tmp-${Date.now()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, destination);
  } catch (error) {
    if (exists(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    throw error;
  }
}

async function downloadWithFallback(urls, destination, validate) {
  const failures = [];
  for (const url of urls) {
    try {
      if (exists(destination)) fs.rmSync(destination, { force: true });
      await downloadFile(url, destination);
      if (!validate(destination)) {
        failures.push(`${url} (invalid artifact payload)`);
        fs.rmSync(destination, { force: true });
        continue;
      }
      return { ok: true, url };
    } catch (error) {
      failures.push(`${url} (${String(error?.message || error)})`);
      if (exists(destination)) fs.rmSync(destination, { force: true });
    }
  }
  return { ok: false, failures };
}

function collectReadiness() {
  const providers = {
    whisper: checkWhisper(),
    parakeet_legacy_110m: checkParakeetLegacy(),
    parakeet_tdt_v3: checkParakeetV3(),
    canary: checkCanary(),
    distil_whisper: checkDistil(),
    moonshine: checkMoonshine(),
  };

  const cloudSecrets = checkCloudSecrets();
  // Optional providers are reported but never fail the run. Parakeet v3 is
  // ~639 MB, so pulling it on every CI runner is a cost nobody asked for; the
  // report still says plainly whether it is present.
  const failingProviders = Object.values(providers)
    .filter((provider) => !provider.ready && !provider.optional)
    .map((provider) => ({ provider: provider.name, missing: provider.missing }));

  return {
    cloudSecrets,
    providers,
    summary: {
      providerCount: Object.keys(providers).length,
      providersReady: Object.values(providers).filter((provider) => provider.ready).length,
      failingProviders,
      cloudSecretsReady: cloudSecrets.ready,
    },
  };
}

async function downloadBundle(url, destination) {
  await downloadFile(url, destination);
  return destination;
}

function runCommand(program, commandArgs, opts = {}) {
  return spawnSync(program, commandArgs, {
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });
}

function extractBundle(archivePath, destination, actions) {
  fs.mkdirSync(destination, { recursive: true });
  const extract = runCommand("tar", ["-xf", archivePath, "-C", destination]);
  if (extract.status !== 0) {
    actions.push({
      step: "assets.extract_bundle",
      ok: false,
      archivePath,
      detail: (extract.stderr || extract.stdout || "tar extraction failed").trim(),
    });
    return false;
  }
  actions.push({ step: "assets.extract_bundle", ok: true, archivePath, destination });
  return true;
}

async function provisionNativeProviderAssets(readiness, actions) {
  const whisper = readiness.providers.whisper;
  if (whisper && !whisper.ready) {
    const target = path.join(modelsRoot, "whisper", "ggml-base.en.bin");
    const result = await downloadWithFallback(
      ["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"],
      target,
      (pathname) => isLikelyBinaryArtifact(pathname, 4096)
    );
    if (result.ok) {
      actions.push({
        step: "assets.download.whisper",
        ok: true,
        destination: target,
        url: result.url,
      });
    } else {
      actions.push({
        step: "assets.download.whisper",
        ok: false,
        destination: target,
        detail: result.failures.join("; "),
      });
    }
  }

  const parakeetLegacy = readiness.providers.parakeet_legacy_110m;
  if (parakeetLegacy && !parakeetLegacy.ready) {
    const dir = path.join(modelsRoot, "parakeet");
    const files = [
      ["model.onnx", "encoder.onnx", (pathname) => isLikelyBinaryArtifact(pathname, 4096)],
      ["tokens.txt", "tokens.txt", hasParakeetTokens],
    ];
    for (const [remoteName, localName, validate] of files) {
      const target = path.join(dir, localName);
      const result = await downloadWithFallback(
        [`https://huggingface.co/${PARAKEET_LEGACY_REPO}/resolve/main/${remoteName}`],
        target,
        validate
      );
      actions.push({
        step: `assets.download.parakeet_legacy_110m.${localName}`,
        ok: result.ok,
        destination: target,
        ...(result.ok ? { url: result.url } : { detail: result.failures.join("; ") }),
      });
    }
  }

  const parakeetV3 = readiness.providers.parakeet_tdt_v3;
  if (provisionParakeetV3 && parakeetV3 && !parakeetV3.ready) {
    const dir = path.join(modelsRoot, "parakeet", "parakeet-tdt-0.6b-v3");
    for (const [file, minBytes] of PARAKEET_V3_ARTIFACTS) {
      const target = path.join(dir, file);
      const result = await downloadWithFallback(
        [`https://huggingface.co/${PARAKEET_V3_REPO}/resolve/main/${file}`],
        target,
        file === "tokens.txt"
          ? hasParakeetTokens
          : (pathname) => isLikelyBinaryArtifact(pathname, minBytes)
      );
      actions.push({
        step: `assets.download.parakeet_tdt_v3.${file}`,
        ok: result.ok,
        destination: target,
        ...(result.ok ? { url: result.url } : { detail: result.failures.join("; ") }),
      });
    }
  } else if (parakeetV3 && !parakeetV3.ready) {
    actions.push({
      step: "assets.download.parakeet_tdt_v3",
      ok: true,
      skipped: true,
      detail:
        "Parakeet TDT v3 (~639 MB) not provisioned. Pass --parakeet-v3 or set PLAINSONG_PROVISION_PARAKEET_V3=1 to fetch it.",
    });
  }

  const canary = readiness.providers.canary;
  if (canary && !canary.ready) {
    const files = [
      "model.safetensors",
      "config.json",
      "tokenizer.json",
      "preprocessor_config.json",
    ];
    for (const file of files) {
      const target = path.join(modelsRoot, "canary", file);
      const result = await downloadWithFallback(
        [`https://huggingface.co/openai/whisper-large-v3-turbo/resolve/main/${file}`],
        target,
        file.endsWith(".json")
          ? (pathname) => parseJson(pathname, 64) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 1024)
      );
      actions.push({
        step: `assets.download.canary.${file}`,
        ok: result.ok,
        destination: target,
        ...(result.ok ? { url: result.url } : { detail: result.failures.join("; ") }),
      });
    }
  }

  const distil = readiness.providers.distil_whisper;
  if (distil && !distil.ready) {
    const files = [
      "model.safetensors",
      "config.json",
      "tokenizer.json",
      "preprocessor_config.json",
    ];
    for (const file of files) {
      const target = path.join(modelsRoot, "distil_whisper", file);
      const result = await downloadWithFallback(
        [`https://huggingface.co/distil-whisper/distil-large-v3.5/resolve/main/${file}`],
        target,
        file.endsWith(".json")
          ? (pathname) => parseJson(pathname, 64) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 1024)
      );
      actions.push({
        step: `assets.download.distil_whisper.${file}`,
        ok: result.ok,
        destination: target,
        ...(result.ok ? { url: result.url } : { detail: result.failures.join("; ") }),
      });
    }
  }

  const moonshine = readiness.providers.moonshine;
  if (moonshine && !moonshine.ready) {
    const files = [
      ["onnx/merged/base/float/encoder_model.onnx", "encoder_model.onnx"],
      ["onnx/merged/base/float/decoder_model_merged.onnx", "decoder_model_merged.onnx"],
      ["onnx/merged/base/float/tokenizer.json", "tokenizer.json"],
    ];
    for (const [remotePath, localName] of files) {
      const target = path.join(modelsRoot, "moonshine", localName);
      const result = await downloadWithFallback(
        [`https://huggingface.co/UsefulSensors/moonshine/resolve/main/${remotePath}`],
        target,
        localName.endsWith(".json")
          ? (pathname) => parseJson(pathname, 1024) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 4096)
      );
      actions.push({
        step: `assets.download.moonshine.${localName}`,
        ok: result.ok,
        destination: target,
        ...(result.ok ? { url: result.url } : { detail: result.failures.join("; ") }),
      });
    }
  }
}

async function provisionAssets() {
  const actions = [];
  fs.mkdirSync(modelsRoot, { recursive: true });

  let bundlePath = bundlePathArg;
  if (!bundlePath && bundleUrlArg) {
    const inferredName = path.basename(new URL(bundleUrlArg).pathname || "asr-assets.tar");
    const tempPath = path.join(os.tmpdir(), `nautilus-asr-assets-${Date.now()}-${inferredName}`);
    try {
      await downloadBundle(bundleUrlArg, tempPath);
      bundlePath = tempPath;
      actions.push({ step: "assets.download_bundle", ok: true, url: bundleUrlArg, path: tempPath });
    } catch (error) {
      actions.push({
        step: "assets.download_bundle",
        ok: false,
        url: bundleUrlArg,
        detail: String(error?.message || error),
      });
    }
  }

  if (bundlePath) {
    extractBundle(bundlePath, modelsRoot, actions);
  } else {
    actions.push({
      step: "assets.extract_bundle",
      ok: false,
      detail: "No asset bundle configured (--asset-bundle or --asset-bundle-url)",
    });
  }

  let readiness = collectReadiness();

  await provisionNativeProviderAssets(readiness, actions);
  readiness = collectReadiness();

  return actions;
}

async function main() {
  let provisionActions = [];

  if (provisionEnabled) {
    provisionActions = await provisionAssets();
  }

  const after = collectReadiness();

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    modelsRoot,
    strict: {
      secrets: strictSecrets,
      assets: strictAssets,
    },
    provision: {
      enabled: provisionEnabled,
      actions: provisionActions,
    },
    cloudSecrets: after.cloudSecrets,
    providers: after.providers,
    summary: after.summary,
  };

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  }

  const hasFailures =
    (strictSecrets && !after.cloudSecrets.ready) ||
    (strictAssets && after.summary.failingProviders.length > 0);

  console.log(JSON.stringify(report, null, 2));
  if (hasFailures) process.exit(1);
}

await main();
