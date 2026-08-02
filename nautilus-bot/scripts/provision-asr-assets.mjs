#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
const requiredProvidersArg = valueFor("--required-providers");
const requestedRequiredProviders = requiredProvidersArg
  ? [...new Set(requiredProvidersArg.split(",").map((name) => name.trim()).filter(Boolean))]
  : null;

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
const PARAKEET_LEGACY_REVISION = "3af92f152d32c836acabf38f4c993bc96b80eb2d";
const PARAKEET_LEGACY_GRAPH_NAMES = ["encoder.onnx", "model.onnx"];
const PARAKEET_LEGACY_SHA256 = {
  "encoder.onnx": "936806cf3dd0db5aba53f8c7410bb5632d7a8ad6b2c51009f5e4fc0890ec76bf",
  "tokens.txt": "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
};

// Kept in step with PARAKEET_V3_ARTIFACTS in
// `rust-sidecar/src/asr/parakeet.rs`:
// `[filename, minimum plausible bytes, sha256]`.
const PARAKEET_V3_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_V3_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
const PARAKEET_V3_ARTIFACTS = [
  [
    "encoder.int8.onnx",
    64 * 1024 * 1024,
    "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
  ],
  [
    "decoder.int8.onnx",
    1024 * 1024,
    "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
  ],
  [
    "joiner.int8.onnx",
    512 * 1024,
    "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
  ],
  [
    "tokens.txt",
    4096,
    "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
  ],
];
const WHISPER_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const WHISPER_SHA256 = {
  "ggml-tiny.bin": "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  "ggml-tiny.en.bin": "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  "ggml-base.bin": "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  "ggml-base.en.bin": "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  "ggml-small.bin": "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  "ggml-small.en.bin": "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  "ggml-medium.bin": "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  "ggml-medium.en.bin": "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
  "ggml-large-v3.bin": "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
  "ggml-large-v3-turbo.bin":
    "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
};
const CANARY_REPO = "openai/whisper-large-v3-turbo";
const CANARY_REVISION = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9";
const CANARY_FILES = {
  "model.safetensors": "542566a422ae4f3fd23f1ba11add198fca01bbf82e66e6a2857b3f608b1eb9d1",
  "config.json": "c5b526b3e3cd64cd8940dabb45e8ba726629e22d8ed389c29b552f9140daf04a",
  "tokenizer.json": "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
  "preprocessor_config.json":
    "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
};
const DISTIL_REPO = "distil-whisper/distil-large-v3.5";
const DISTIL_REVISION = "728a7691f3ff1d3d971528d3203a6e9559165d41";
const DISTIL_FILES = {
  "model.safetensors": "76ec9f754fc4b4810845dc36b71d1897c1342e702810c179e1569690084cfb0c",
  "config.json": "515a10a9979258d3fc71cf79b2cd055c189f07d78879a15bd9bc282673308b85",
  "tokenizer.json": "b3c8202bbf06d8ee4232c5984baa563784ac4737e2e7fdc42fa180200d3cfcdb",
  "preprocessor_config.json":
    "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
};
const MOONSHINE_ONNX_REPO = "UsefulSensors/moonshine";
const MOONSHINE_ONNX_REVISION = "48b4e427b587bcf67797a5be706d6ddc4a298149";
const MOONSHINE_BASE_REPO = "UsefulSensors/moonshine-base";
const MOONSHINE_BASE_REVISION = "7a73d8d55ac0ba2ef3ae761593f6784b51f96dcf";
const MOONSHINE_BASE_FILES = [
  {
    repo: MOONSHINE_ONNX_REPO,
    revision: MOONSHINE_ONNX_REVISION,
    remotePath: "onnx/merged/base/float/encoder_model.onnx",
    localName: "encoder_model.onnx",
    sha256: "153e128e7abd64a74ee47f2c3f585c3171c4d46cbb368b032827934c4e01e779",
  },
  {
    repo: MOONSHINE_ONNX_REPO,
    revision: MOONSHINE_ONNX_REVISION,
    remotePath: "onnx/merged/base/float/decoder_model_merged.onnx",
    localName: "decoder_model_merged.onnx",
    sha256: "58778763ca8438963190244d6b26572bdca2cedec56a4b91e828f3f2d69ef3c5",
  },
  {
    repo: MOONSHINE_BASE_REPO,
    revision: MOONSHINE_BASE_REVISION,
    remotePath: "tokenizer.json",
    localName: "tokenizer.json",
    sha256: "6579793438bc4fbafffacf699169ff53e3769c5a0a0f5e71cdee8853e8130deb",
  },
];
const MODEL_INTEGRITY_RECEIPT_VERSION = "plainsong-model-integrity-v1";

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

function integrityReceiptPath(pathname) {
  return `${pathname}.plainsong-integrity`;
}

function integrityReceiptContents(pathname, expectedSha256) {
  const metadata = fs.statSync(pathname, { bigint: true });
  return [
    MODEL_INTEGRITY_RECEIPT_VERSION,
    `sha256=${expectedSha256}`,
    `size=${metadata.size}`,
    `modified_nanos=${metadata.mtimeNs}`,
    "",
  ].join("\n");
}

function hasIntegrityReceipt(pathname, expectedSha256) {
  if (!fileSizeOk(pathname)) return false;
  try {
    return (
      fs.readFileSync(integrityReceiptPath(pathname), "utf8") ===
      integrityReceiptContents(pathname, expectedSha256)
    );
  } catch {
    return false;
  }
}

function writeIntegrityReceipt(pathname, expectedSha256) {
  const receiptPath = integrityReceiptPath(pathname);
  const temporaryPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, integrityReceiptContents(pathname, expectedSha256), {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, receiptPath);
}

async function sha256File(pathname) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(pathname);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
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
      const expectedSha256 = WHISPER_SHA256[entry];
      if (!expectedSha256) return false;
      const pathname = path.join(dir, entry);
      return (
        isLikelyBinaryArtifact(pathname, 4096) &&
        hasIntegrityReceipt(pathname, expectedSha256)
      );
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
  const hasGraph = PARAKEET_LEGACY_GRAPH_NAMES.some((name) => {
    const pathname = path.join(dir, name);
    return (
      isLikelyBinaryArtifact(pathname, 4096) &&
      hasIntegrityReceipt(pathname, PARAKEET_LEGACY_SHA256["encoder.onnx"])
    );
  });
  if (!hasGraph) missing.push(PARAKEET_LEGACY_GRAPH_NAMES.join("|"));
  const tokensPath = path.join(dir, "tokens.txt");
  if (
    !hasParakeetTokens(tokensPath) ||
    !hasIntegrityReceipt(tokensPath, PARAKEET_LEGACY_SHA256["tokens.txt"])
  ) {
    missing.push("tokens.txt");
  }
  return providerCheck("parakeet_legacy_110m", { modelDir: dir, missing });
}

// The default Parakeet route: sherpa-onnx's int8 export of
// `nvidia/parakeet-tdt-0.6b-v3`, three graphs plus tokens. Reported always,
// provisioned only on request — see PARAKEET_V3_ARTIFACTS.
function checkParakeetV3() {
  const dir = path.join(modelsRoot, "parakeet", "parakeet-tdt-0.6b-v3");
  const missing = [];
  for (const [file, minBytes, expectedSha256] of PARAKEET_V3_ARTIFACTS) {
    const fullPath = path.join(dir, file);
    const ok =
      file === "tokens.txt"
        ? hasParakeetTokens(fullPath)
        : isLikelyBinaryArtifact(fullPath, minBytes);
    if (!ok || !hasIntegrityReceipt(fullPath, expectedSha256)) missing.push(file);
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
  const required = Object.entries(CANARY_FILES);
  for (const [file, expectedSha256] of required) {
    const fullPath = path.join(dir, file);
    const minBytes = file.endsWith(".json") ? 64 : 1024;
    if (file.endsWith(".json")) {
      if (!parseJson(fullPath, minBytes)) missing.push(file);
    } else if (!isLikelyBinaryArtifact(fullPath, minBytes)) {
      missing.push(file);
    }
    if (!hasIntegrityReceipt(fullPath, expectedSha256) && !missing.includes(file)) {
      missing.push(file);
    }
  }
  return providerCheck("canary", { modelDir: dir, missing });
}

function checkDistil() {
  const dir = path.join(modelsRoot, "distil_whisper");
  const missing = [];
  const required = Object.entries(DISTIL_FILES);
  for (const [file, expectedSha256] of required) {
    const fullPath = path.join(dir, file);
    const minBytes = file.endsWith(".json") ? 64 : 1024;
    if (file.endsWith(".json")) {
      if (!parseJson(fullPath, minBytes)) missing.push(file);
    } else if (!isLikelyBinaryArtifact(fullPath, minBytes)) {
      missing.push(file);
    }
    if (!hasIntegrityReceipt(fullPath, expectedSha256) && !missing.includes(file)) {
      missing.push(file);
    }
  }
  return providerCheck("distil_whisper", { modelDir: dir, missing });
}

function checkMoonshine() {
  const dir = path.join(modelsRoot, "moonshine");
  const missing = [];
  const encoder = MOONSHINE_BASE_FILES[0];
  const decoder = MOONSHINE_BASE_FILES[1];
  const tokenizer = MOONSHINE_BASE_FILES[2];
  if (
    !isLikelyBinaryArtifact(path.join(dir, encoder.localName), 4096) ||
    !hasIntegrityReceipt(path.join(dir, encoder.localName), encoder.sha256)
  ) {
    missing.push("encoder_model.onnx");
  }
  if (
    !isLikelyBinaryArtifact(path.join(dir, decoder.localName), 4096) ||
    !hasIntegrityReceipt(path.join(dir, decoder.localName), decoder.sha256)
  ) {
    missing.push("decoder_model_merged.onnx");
  }
  if (
    !parseJson(path.join(dir, tokenizer.localName), 1024) ||
    !hasIntegrityReceipt(path.join(dir, tokenizer.localName), tokenizer.sha256)
  ) {
    missing.push("tokenizer.json");
  }
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

function isTrustedHuggingFaceUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "huggingface.co" ||
        parsed.hostname.endsWith(".huggingface.co"))
    );
  } catch {
    return false;
  }
}

function downloadHeadersForUrl(
  url,
  { includeHfToken = true, token = hfToken } = {},
) {
  const headers = {
    "user-agent": "nautilus-asr-provisioner/1.0",
  };
  if (includeHfToken && token && isTrustedHuggingFaceUrl(url)) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function downloadFile(
  url,
  destination,
  expectedSha256 = null,
  { includeHfToken = true } = {},
) {
  const headers = downloadHeadersForUrl(url, { includeHfToken });

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
    if (expectedSha256) {
      const actualSha256 = await sha256File(tmpPath);
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `integrity verification failed: expected sha256 ${expectedSha256}, got ${actualSha256}`
        );
      }
    }
    fs.renameSync(tmpPath, destination);
    if (expectedSha256) {
      writeIntegrityReceipt(destination, expectedSha256);
    }
  } catch (error) {
    if (exists(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    throw error;
  }
}

async function downloadWithFallback(urls, destination, validate, expectedSha256) {
  const failures = [];
  if (exists(destination) && validate(destination)) {
    const actualSha256 = await sha256File(destination);
    if (actualSha256 === expectedSha256) {
      writeIntegrityReceipt(destination, expectedSha256);
      return { ok: true, url: "existing verified artifact", migrated: true };
    }
  }
  for (const url of urls) {
    try {
      if (exists(destination)) fs.rmSync(destination, { force: true });
      if (exists(integrityReceiptPath(destination))) {
        fs.rmSync(integrityReceiptPath(destination), { force: true });
      }
      await downloadFile(url, destination, expectedSha256);
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
  const providerNames = Object.keys(providers);
  const requiredProviders =
    requestedRequiredProviders ??
    Object.values(providers)
      .filter((provider) => !provider.optional)
      .map((provider) => provider.name);
  const requiredProviderSet = new Set(requiredProviders);
  const unknownRequiredProviders = requiredProviders.filter(
    (provider) => !providerNames.includes(provider),
  );
  // Providers outside the requested route set remain visible in the report,
  // but do not fail a route-specific validation run.
  const failingProviders = Object.values(providers)
    .filter(
      (provider) => !provider.ready && requiredProviderSet.has(provider.name),
    )
    .map((provider) => ({ provider: provider.name, missing: provider.missing }));

  return {
    cloudSecrets,
    providers,
    summary: {
      providerCount: Object.keys(providers).length,
      providersReady: Object.values(providers).filter((provider) => provider.ready).length,
      requiredProviders,
      unknownRequiredProviders,
      failingProviders,
      cloudSecretsReady: cloudSecrets.ready,
    },
  };
}

async function downloadBundle(url, destination) {
  // Bundle URLs are operator supplied. Never attach the Hugging Face token,
  // even when the URL happens to point at Hugging Face.
  await downloadFile(url, destination, null, { includeHfToken: false });
  return destination;
}

function runCommand(program, commandArgs, opts = {}) {
  return spawnSync(program, commandArgs, {
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });
}

function unsafeArchiveMemberReason(memberName) {
  const normalizedSeparators = memberName.replaceAll("\\", "/");
  const normalized = path.posix.normalize(normalizedSeparators);
  if (
    !normalizedSeparators ||
    normalizedSeparators.includes("\0") ||
    path.posix.isAbsolute(normalizedSeparators) ||
    /^[A-Za-z]:\//.test(normalizedSeparators)
  ) {
    return "absolute or invalid path";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return "parent traversal";
  }
  return null;
}

function inspectBundleArchive(archivePath) {
  const commandOptions = {
    env: {
      ...process.env,
      LC_ALL: "C",
    },
  };
  const listed = runCommand("tar", ["-tf", archivePath], commandOptions);
  if (listed.status !== 0) {
    return {
      ok: false,
      detail: (listed.stderr || listed.stdout || "tar listing failed").trim(),
    };
  }

  const members = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (members.length === 0) {
    return { ok: false, detail: "Asset bundle is empty." };
  }
  for (const member of members) {
    const reason = unsafeArchiveMemberReason(member);
    if (reason) {
      return {
        ok: false,
        detail: `Unsafe archive member '${member}': ${reason}.`,
      };
    }
  }

  const verbose = runCommand("tar", ["-tvf", archivePath], commandOptions);
  if (verbose.status !== 0) {
    return {
      ok: false,
      detail: (verbose.stderr || verbose.stdout || "tar inspection failed").trim(),
    };
  }
  const unsafeEntry = verbose.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find(
      (line) =>
        (!line.startsWith("-") && !line.startsWith("d")) ||
        line.includes(" link to ") ||
        line.includes(" -> "),
    );
  if (unsafeEntry) {
    return {
      ok: false,
      detail:
        "Asset bundles may contain only regular files and directories, with no symbolic or hard links.",
    };
  }

  return { ok: true };
}

function copyValidatedBundleTree(source, destination) {
  const sourceRoot = fs.realpathSync(source);
  const destinationRoot = fs.realpathSync(destination);
  const pending = [sourceRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const sourcePath = path.join(current, entry.name);
      const relativePath = path.relative(sourceRoot, sourcePath);
      const destinationPath = path.resolve(destinationRoot, relativePath);
      if (
        destinationPath !== destinationRoot &&
        !destinationPath.startsWith(`${destinationRoot}${path.sep}`)
      ) {
        throw new Error(`Bundle member escapes the models directory: ${relativePath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundle member is a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (fs.existsSync(destinationPath)) {
          const destinationMetadata = fs.lstatSync(destinationPath);
          if (
            destinationMetadata.isSymbolicLink() ||
            !destinationMetadata.isDirectory()
          ) {
            throw new Error(
              `Bundle directory collides with an unsafe destination: ${relativePath}`,
            );
          }
        } else {
          fs.mkdirSync(destinationPath);
        }
        pending.push(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Bundle member is not a regular file: ${relativePath}`);
      }
      if (fs.existsSync(destinationPath) && fs.lstatSync(destinationPath).isSymbolicLink()) {
        throw new Error(
          `Bundle file collides with a destination symbolic link: ${relativePath}`,
        );
      }
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function extractBundle(archivePath, destination, actions) {
  fs.mkdirSync(destination, { recursive: true });
  const inspection = inspectBundleArchive(archivePath);
  if (!inspection.ok) {
    actions.push({
      step: "assets.extract_bundle",
      ok: false,
      archivePath,
      detail: inspection.detail,
    });
    return false;
  }

  const stagingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "plainsong-asr-bundle-"),
  );
  const extract = runCommand("tar", ["-xf", archivePath, "-C", stagingDirectory]);
  if (extract.status !== 0) {
    actions.push({
      step: "assets.extract_bundle",
      ok: false,
      archivePath,
      detail: (extract.stderr || extract.stdout || "tar extraction failed").trim(),
    });
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    return false;
  }
  try {
    copyValidatedBundleTree(stagingDirectory, destination);
    actions.push({ step: "assets.extract_bundle", ok: true, archivePath, destination });
    return true;
  } catch (error) {
    actions.push({
      step: "assets.extract_bundle",
      ok: false,
      archivePath,
      detail: String(error?.message || error),
    });
    return false;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

async function provisionNativeProviderAssets(readiness, actions) {
  const whisper = readiness.providers.whisper;
  if (whisper && !whisper.ready) {
    const target = path.join(modelsRoot, "whisper", "ggml-base.en.bin");
    const result = await downloadWithFallback(
      [
        `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}/ggml-base.en.bin`,
      ],
      target,
      (pathname) => isLikelyBinaryArtifact(pathname, 4096),
      WHISPER_SHA256["ggml-base.en.bin"]
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
      [
        "model.onnx",
        "encoder.onnx",
        (pathname) => isLikelyBinaryArtifact(pathname, 4096),
        PARAKEET_LEGACY_SHA256["encoder.onnx"],
      ],
      ["tokens.txt", "tokens.txt", hasParakeetTokens, PARAKEET_LEGACY_SHA256["tokens.txt"]],
    ];
    for (const [remoteName, localName, validate, expectedSha256] of files) {
      const target = path.join(dir, localName);
      const result = await downloadWithFallback(
        [
          `https://huggingface.co/${PARAKEET_LEGACY_REPO}/resolve/${PARAKEET_LEGACY_REVISION}/${remoteName}`,
        ],
        target,
        validate,
        expectedSha256
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
    for (const [file, minBytes, expectedSha256] of PARAKEET_V3_ARTIFACTS) {
      const target = path.join(dir, file);
      const result = await downloadWithFallback(
        [
          `https://huggingface.co/${PARAKEET_V3_REPO}/resolve/${PARAKEET_V3_REVISION}/${file}`,
        ],
        target,
        file === "tokens.txt"
          ? hasParakeetTokens
          : (pathname) => isLikelyBinaryArtifact(pathname, minBytes),
        expectedSha256
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
    for (const [file, expectedSha256] of Object.entries(CANARY_FILES)) {
      const target = path.join(modelsRoot, "canary", file);
      const result = await downloadWithFallback(
        [`https://huggingface.co/${CANARY_REPO}/resolve/${CANARY_REVISION}/${file}`],
        target,
        file.endsWith(".json")
          ? (pathname) => parseJson(pathname, 64) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 1024),
        expectedSha256
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
    for (const [file, expectedSha256] of Object.entries(DISTIL_FILES)) {
      const target = path.join(modelsRoot, "distil_whisper", file);
      const result = await downloadWithFallback(
        [`https://huggingface.co/${DISTIL_REPO}/resolve/${DISTIL_REVISION}/${file}`],
        target,
        file.endsWith(".json")
          ? (pathname) => parseJson(pathname, 64) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 1024),
        expectedSha256
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
    for (const { repo, revision, remotePath, localName, sha256 } of MOONSHINE_BASE_FILES) {
      const target = path.join(modelsRoot, "moonshine", localName);
      const result = await downloadWithFallback(
        [`https://huggingface.co/${repo}/resolve/${revision}/${remotePath}`],
        target,
        localName.endsWith(".json")
          ? (pathname) => parseJson(pathname, 1024) !== null
          : (pathname) => isLikelyBinaryArtifact(pathname, 4096),
        sha256
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
    (strictAssets &&
      (after.summary.failingProviders.length > 0 ||
        after.summary.unknownRequiredProviders.length > 0));

  console.log(JSON.stringify(report, null, 2));
  if (hasFailures) process.exit(1);
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entrypointUrl === import.meta.url) {
  await main();
}

export {
  downloadHeadersForUrl,
  inspectBundleArchive,
  unsafeArchiveMemberReason,
};
