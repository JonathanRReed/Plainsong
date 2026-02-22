#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pythonRunnerPath = path.join(scriptDir, "..", "src-tauri", "python", "asr", "runner.py");
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

const nautilusDataDir = path.join(defaultDataDir(), "Nautilus");
const modelsRoot =
  valueFor("--models-root") ||
  process.env.NAUTILUS_MODELS_ROOT ||
  path.join(nautilusDataDir, "models");
const runtimeRoot =
  valueFor("--runtime-root") ||
  process.env.NAUTILUS_RUNTIME_ROOT ||
  path.join(nautilusDataDir, "runtime", "python");

const managedVenvDir = path.join(runtimeRoot, "asr");
const managedPythonPath =
  process.platform === "win32"
    ? path.join(managedVenvDir, "Scripts", "python.exe")
    : path.join(managedVenvDir, "bin", "python3");

const bundlePathArg = valueFor("--asset-bundle") || process.env.NAUTILUS_ASR_ASSET_BUNDLE || null;
const bundleUrlArg = valueFor("--asset-bundle-url") || process.env.NAUTILUS_ASR_ASSET_BUNDLE_URL || null;

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

function checkParakeet() {
  const dir = path.join(modelsRoot, "parakeet");
  const missing = [];
  if (!isLikelyBinaryArtifact(path.join(dir, "encoder.onnx"), 4096)) missing.push("encoder.onnx");
  const tokensPath = path.join(dir, "tokens.txt");
  if (!hasParakeetTokens(tokensPath)) missing.push("tokens.txt");
  return providerCheck("parakeet", { modelDir: dir, missing });
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

function hasAnyValidSafetensors(dir, minBytes = 1024) {
  if (!exists(dir)) return false;
  const entries = fs.readdirSync(dir);
  return entries.some(
    (entry) => entry.endsWith(".safetensors") && isLikelyBinaryArtifact(path.join(dir, entry), minBytes)
  );
}

function checkVoxtralLocal() {
  const dir = path.join(modelsRoot, "voxtral");
  const missing = [];
  if (!parseJson(path.join(dir, "config.json"), 64)) missing.push("config.json");
  if (!parseJson(path.join(dir, "processor_config.json"), 64)) missing.push("processor_config.json");
  if (!parseJson(path.join(dir, "tekken.json"), 64)) missing.push("tekken.json");

  const primaryWeight =
    isLikelyBinaryArtifact(path.join(dir, "model.safetensors"), 1024) ||
    isLikelyBinaryArtifact(path.join(dir, "consolidated.safetensors"), 1024);
  if (!primaryWeight && !hasAnyValidSafetensors(dir, 1024)) {
    missing.push("model.safetensors|consolidated.safetensors|*.safetensors");
  }

  return providerCheck("voxtral_local", { modelDir: dir, missing });
}

function checkCloudSecrets() {
  const required = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MISTRAL_API_KEY"];
  const entries = required.map((name) => {
    const value = process.env[name] || "";
    return { name, present: value.trim().length > 0 };
  });
  const missing = entries.filter((entry) => !entry.present).map((entry) => entry.name);
  return { entries, missing, ready: missing.length === 0 };
}

function runCommand(program, commandArgs, opts = {}) {
  return spawnSync(program, commandArgs, {
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });
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

function probePythonCandidate(candidate, probeCode) {
  const result = runCommand(candidate, ["-c", probeCode]);
  return result.status === 0;
}

function resolvePython() {
  const explicit = valueFor("--python") || process.env.NAUTILUS_PYTHON;
  const candidates = [
    explicit,
    managedPythonPath,
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python",
  ].filter(Boolean);

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

const PYTHON_PROVIDER_REQUIREMENTS = {
  voxtral_local: [
    "torch>=2.3.0",
    "transformers>=5.2.0,<6",
    "mistral-common[audio]>=1.9.0",
    "huggingface_hub>=0.29.0",
    "soundfile>=0.12.1",
    "librosa>=0.10.2",
    "numpy>=1.26.0",
  ],
};

function checkPythonRuntimes() {
  const probes = {
    voxtral_local: "import torch; import soundfile; import librosa; import transformers; import mistral_common",
  };

  const candidates = resolvePython();
  const result = {
    candidates,
    selected: null,
    checks: {
      voxtral_local: { ready: false },
    },
  };

  for (const candidate of candidates) {
    const voxOk = probePythonCandidate(candidate, probes.voxtral_local);
    if (voxOk) {
      if (!result.selected) result.selected = candidate;
      if (voxOk) result.checks.voxtral_local = { ready: true, python: candidate };
    }
    if (result.checks.voxtral_local.ready) break;
  }

  if (!result.checks.voxtral_local.ready) {
    result.checks.voxtral_local = {
      ready: false,
      reason: "No Python runtime with required Voxtral modules",
    };
  }

  return result;
}

function collectReadiness() {
  const providers = {
    whisper: checkWhisper(),
    parakeet: checkParakeet(),
    canary: checkCanary(),
    distil_whisper: checkDistil(),
    moonshine: checkMoonshine(),
    voxtral_local: checkVoxtralLocal(),
  };

  const python = checkPythonRuntimes();
  if (!python.checks.voxtral_local.ready) {
    providers.voxtral_local.missing.push("python runtime modules for voxtral_local");
    providers.voxtral_local.ready = false;
  }

  const cloudSecrets = checkCloudSecrets();
  const failingProviders = Object.values(providers)
    .filter((provider) => !provider.ready)
    .map((provider) => ({ provider: provider.name, missing: provider.missing }));

  return {
    cloudSecrets,
    python,
    providers,
    summary: {
      providerCount: Object.keys(providers).length,
      providersReady: Object.values(providers).filter((provider) => provider.ready).length,
      failingProviders,
      cloudSecretsReady: cloudSecrets.ready,
    },
  };
}

function chooseBootstrapPython() {
  const candidates = resolvePython().filter((candidate) => candidate !== managedPythonPath);
  for (const candidate of candidates) {
    const probe = runCommand(candidate, ["-c", "import venv"]);
    if (probe.status === 0) return candidate;
  }
  return null;
}

function ensureManagedPythonBase(actions) {
  fs.mkdirSync(path.dirname(managedVenvDir), { recursive: true });
  if (!exists(managedPythonPath)) {
    const bootstrap = chooseBootstrapPython();
    if (!bootstrap) {
      actions.push({ step: "python.create_venv", ok: false, detail: "No bootstrap python with venv available" });
      return null;
    }
    const created = runCommand(bootstrap, ["-m", "venv", managedVenvDir]);
    if (created.status !== 0) {
      actions.push({
        step: "python.create_venv",
        ok: false,
        detail: (created.stderr || created.stdout || "venv creation failed").trim(),
      });
      return null;
    }
    actions.push({ step: "python.create_venv", ok: true, python: managedPythonPath });
  }

  const pipBootstrap = runCommand(managedPythonPath, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
  if (pipBootstrap.status !== 0) {
    actions.push({
      step: "python.bootstrap_tools",
      ok: false,
      detail: (pipBootstrap.stderr || pipBootstrap.stdout || "pip bootstrap failed").trim(),
    });
    return null;
  }

  actions.push({ step: "python.bootstrap_tools", ok: true, python: managedPythonPath });
  return managedPythonPath;
}

function installPythonProvider(provider, actions) {
  const requirements = PYTHON_PROVIDER_REQUIREMENTS[provider] || [];
  if (requirements.length === 0) return;

  const python = ensureManagedPythonBase(actions);
  if (!python) return;

  const install = runCommand(python, ["-m", "pip", "install", "--upgrade", ...requirements]);
  if (install.status !== 0) {
    actions.push({
      step: `python.install.${provider}`,
      ok: false,
      detail: (install.stderr || install.stdout || "dependency install failed").trim(),
    });
    return;
  }

  actions.push({ step: `python.install.${provider}`, ok: true, python });
}

async function downloadBundle(url, destination) {
  await downloadFile(url, destination);
  return destination;
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

function providerMissingModelArtifacts(providerCheckResult) {
  if (!providerCheckResult || !Array.isArray(providerCheckResult.missing)) return true;
  return providerCheckResult.missing.some((item) => !item.includes("python runtime modules"));
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

  const parakeet = readiness.providers.parakeet;
  if (parakeet && !parakeet.ready) {
    const onnxTarget = path.join(modelsRoot, "parakeet", "encoder.onnx");
    const tokensTarget = path.join(modelsRoot, "parakeet", "tokens.txt");
    const onnx = await downloadWithFallback(
      [
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/main/model.onnx",
        "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/encoder.onnx",
      ],
      onnxTarget,
      (pathname) => isLikelyBinaryArtifact(pathname, 4096)
    );
    if (onnx.ok) {
      actions.push({
        step: "assets.download.parakeet.encoder",
        ok: true,
        destination: onnxTarget,
        url: onnx.url,
      });
    } else {
      actions.push({
        step: "assets.download.parakeet.encoder",
        ok: false,
        destination: onnxTarget,
        detail: onnx.failures.join("; "),
      });
    }

    const tokens = await downloadWithFallback(
      [
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000/resolve/main/tokens.txt",
        "https://huggingface.co/k2-fsa/sherpa-onnx-nemo-parakeet-tdt-0.6b-en/resolve/main/tokens.txt",
      ],
      tokensTarget,
      hasParakeetTokens
    );
    if (tokens.ok) {
      actions.push({
        step: "assets.download.parakeet.tokens",
        ok: true,
        destination: tokensTarget,
        url: tokens.url,
      });
    } else {
      actions.push({
        step: "assets.download.parakeet.tokens",
        ok: false,
        destination: tokensTarget,
        detail: tokens.failures.join("; "),
      });
    }
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

function downloadPythonModelWithRunner(provider, modelDir, actions) {
  if (!exists(pythonRunnerPath)) {
    actions.push({
      step: `assets.download.${provider}`,
      ok: false,
      detail: `Python ASR runner not found at ${pythonRunnerPath}`,
    });
    return;
  }

  const python = ensureManagedPythonBase(actions);
  if (!python) return;

  const env = { ...process.env };
  if (hfToken) {
    env.HF_TOKEN = hfToken;
    env.HUGGINGFACE_HUB_TOKEN = hfToken;
  }

  const result = runCommand(python, [pythonRunnerPath, "--provider", provider, "--action", "download", "--model-dir", modelDir], {
    env,
  });

  if (result.status !== 0) {
    actions.push({
      step: `assets.download.${provider}`,
      ok: false,
      detail: (result.stderr || result.stdout || `download failed with status ${result.status}`).trim(),
    });
    return;
  }

  actions.push({
    step: `assets.download.${provider}`,
    ok: true,
    modelDir,
  });
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

  if (readiness.python.checks.voxtral_local.ready === false) {
    installPythonProvider("voxtral_local", actions);
  }

  readiness = collectReadiness();
  if (readiness.providers.voxtral_local && !readiness.providers.voxtral_local.ready) {
    if (providerMissingModelArtifacts(readiness.providers.voxtral_local)) {
      downloadPythonModelWithRunner("voxtral_local", path.join(modelsRoot, "voxtral"), actions);
    }
  }

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
    python: after.python,
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
