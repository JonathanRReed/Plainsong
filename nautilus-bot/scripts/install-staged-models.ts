#!/usr/bin/env bun
/**
 * Dev/QA only: install the staged `models-2026-10` artifacts into an isolated
 * Plainsong data directory, so a candidate build can be exercised before the
 * GitHub release that the app downloads from exists.
 *
 *   export PLAINSONG_QA_DATA="$(mktemp -d)/plainsong-qa"
 *   bun scripts/install-staged-models.ts --data-dir "$PLAINSONG_QA_DATA" --dry-run
 *
 * What it installs, and where. `--data-dir` is the same directory the sidecar
 * takes as `PLAINSONG_DATA_DIR` (rust-sidecar/src/paths.rs `data_dir()`); the
 * app then appends `Plainsong/models`. The files land exactly where the app's
 * own download code puts them:
 *
 *   <data-dir>/Plainsong/models/diarization/pyannote-community-1/   COMMUNITY1_BUNDLE (6 files)
 *   <data-dir>/Plainsong/models/transcribe_cpp/                       the two GGUFs + LICENSE/NOTICE
 *
 * Pins. Every file name and SHA-256 is read from the Rust source at run time
 * (COMMUNITY1_BUNDLE in rust-sidecar/src/download/mod.rs; MODEL_SPECS and the
 * auxiliary specs in rust-sidecar/src/asr/transcribe_cpp.rs). Nothing is
 * duplicated here. A pin that cannot be found, a staged file that does not
 * match its pin, or a copied destination that does not match its pin stops the
 * run with a non-zero exit.
 *
 * Verification records. This script writes none, and the sidecar keeps
 * none on disk. A present pinned file reads as installed
 * (`is_model_artifact_installed` in rust-sidecar/src/download/model_trust.rs);
 * each sidecar run hashes it against its pin the first time it is loaded,
 * and a background pass after launch checks the active speech models.
 *
 * Copies use APFS clones (`cp -c`). When the destination volume cannot clone
 * (another file system, or a different volume from the staging folder), the
 * script warns and makes an ordinary copy; the hash check on the destination
 * is the same either way.
 *
 * Never point this at a real Plainsong profile. It refuses any path inside
 * ~/Library/Application Support.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DOWNLOAD_MOD_RS = "rust-sidecar/src/download/mod.rs";
const TRANSCRIBE_CPP_RS = "rust-sidecar/src/asr/transcribe_cpp.rs";

const DEFAULT_STAGING_DIR =
  "/Users/jonathanreed/Documents/Plainsong/nautilus-bot/artifacts/continuation-2026-10-20/models-release-staging";

/** The transcribe.cpp models served from Plainsong's own model release. */
const STAGED_TRANSCRIBE_CPP_MODEL_IDS = ["fluid-speech-mini-q8_0", "underdog-bark-3.0-pro-q8_0"];

/**
 * `crate::paths::data_dir()` joined with these, in that order, is the models
 * root every download path in the sidecar uses. `diarization` is the segment
 * `diarization_models_dir()` adds. The unit test holds these to the Rust
 * source.
 */
export const MODELS_ROOT_SEGMENTS = ["Plainsong", "models"] as const;
export const DIARIZATION_DIR = "diarization";

export interface PinnedFile {
  fileName: string;
  sha256: string;
}

export interface PlannedInstall extends PinnedFile {
  /** Which pin table the digest came from, for the log. */
  pinnedIn: string;
  source: string;
  destination: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireMatch(source: string, pattern: RegExp, what: string): RegExpMatchArray {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find ${what} in the Rust source.`);
  return match;
}

function requireDigest(value: string, what: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${what} is not a 64-hex SHA-256: ${JSON.stringify(value)}`);
  }
  return value;
}

function stringConst(source: string, name: string): string {
  return requireMatch(
    source,
    new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"\\s*;`),
    `const ${name}`,
  )[1];
}

/** String-valued fields of one Rust struct literal body. */
function stringFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of body.matchAll(/^\s*([a-z_0-9]+)\s*:\s*"([^"]*)"\s*,/gm)) {
    fields.set(match[1], match[2]);
  }
  return fields;
}

/** Bodies of every `TypeName { ... }` struct literal in `source`. */
function structLiterals(source: string, typeName: string): string[] {
  const bodies: string[] = [];
  const opener = new RegExp(`\\b${typeName}\\s*\\{`, "g");
  for (const match of source.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = source.indexOf("}", start);
    if (end < 0) continue;
    const body = source.slice(start, end);
    // Skip the struct definition itself (`pub(crate) struct TypeName {`).
    if (/^\s*pub\b/.test(body)) continue;
    bodies.push(body);
  }
  return bodies;
}

/**
 * The pyannote community-1 bundle as `download/mod.rs` pins it: the
 * directory name under `models/diarization/` and each file's name and digest.
 */
export function parseCommunity1BundlePins(downloadModSource: string): {
  dirName: string;
  files: PinnedFile[];
} {
  const dirName = stringConst(downloadModSource, "COMMUNITY1_BUNDLE_DIR");
  const block = requireMatch(
    downloadModSource,
    /const\s+COMMUNITY1_BUNDLE\s*:\s*&\[ModelBundleFile\]\s*=\s*&\[([\s\S]*?)\n\];/,
    "COMMUNITY1_BUNDLE",
  )[1];
  const files = [...block.matchAll(/community1_file!\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map(
    (match) => ({
      fileName: match[1],
      sha256: requireDigest(match[2], `COMMUNITY1_BUNDLE pin for ${match[1]}`),
    }),
  );
  if (files.length === 0) throw new Error("COMMUNITY1_BUNDLE lists no files.");
  return { dirName, files };
}

export interface TranscribeCppModelPins {
  modelId: string;
  model: PinnedFile;
  auxiliary: PinnedFile[];
}

/**
 * The named transcribe.cpp models as `asr/transcribe_cpp.rs` pins them: the
 * model directory under `models/`, each GGUF from MODEL_SPECS, and the
 * LICENSE/NOTICE files `auxiliary_specs_for` returns for it.
 */
export function parseTranscribeCppPins(
  transcribeCppSource: string,
  modelIds: readonly string[],
): { dirName: string; models: TranscribeCppModelPins[] } {
  const dirName = stringConst(transcribeCppSource, "TRANSCRIBE_CPP_MODEL_DIR");

  // `pub const FOO_MODEL_ID: &str = "foo";` so spec and match arms can name
  // models by constant.
  const idByConst = new Map<string, string>();
  for (const match of transcribeCppSource.matchAll(
    /const\s+([A-Z0-9_]+_MODEL_ID)\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g,
  )) {
    idByConst.set(match[1], match[2]);
  }
  const resolveId = (token: string) => idByConst.get(token) ?? token.replace(/^"|"$/g, "");

  const auxArrays = new Map<string, PinnedFile[]>();
  for (const match of transcribeCppSource.matchAll(
    /const\s+([A-Z0-9_]+)\s*:\s*&\[TranscribeCppAuxiliarySpec\]\s*=\s*&\[([\s\S]*?)\n\];/g,
  )) {
    auxArrays.set(
      match[1],
      structLiterals(match[2], "TranscribeCppAuxiliarySpec").map((body) => {
        const fields = stringFields(body);
        const fileName = fields.get("local_file_name");
        const sha256 = fields.get("sha256");
        if (!fileName || !sha256) {
          throw new Error(`An auxiliary spec in ${match[1]} has no local_file_name or sha256.`);
        }
        return { fileName, sha256: requireDigest(sha256, `${match[1]} pin for ${fileName}`) };
      }),
    );
  }

  const auxBody = requireMatch(
    transcribeCppSource,
    /fn\s+auxiliary_specs_for\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
    "fn auxiliary_specs_for",
  )[1];
  const auxArrayByModelId = new Map<string, string>();
  for (const match of auxBody.matchAll(/([A-Z0-9_]+|"[^"]+")\s*=>\s*([A-Z0-9_]+)\s*,/g)) {
    auxArrayByModelId.set(resolveId(match[1]), match[2]);
  }

  const specBodies = structLiterals(transcribeCppSource, "TranscribeCppModelSpec");

  const models = modelIds.map((modelId) => {
    const body = specBodies.find((candidate) => {
      const token = candidate.match(/^\s*model_id\s*:\s*([A-Z0-9_]+|"[^"]+")\s*,/m)?.[1];
      return token !== undefined && resolveId(token) === modelId;
    });
    if (body === undefined) throw new Error(`MODEL_SPECS has no transcribe.cpp spec for ${modelId}.`);
    const fields = stringFields(body);
    const fileName = fields.get("file_name");
    const sha256 = fields.get("sha256");
    if (!fileName || !sha256) {
      throw new Error(`The transcribe.cpp spec for ${modelId} has no file_name or sha256.`);
    }
    const auxName = auxArrayByModelId.get(modelId);
    const auxiliary = auxName ? auxArrays.get(auxName) : [];
    if (!auxiliary) throw new Error(`Could not find ${auxName}, the auxiliary specs for ${modelId}.`);
    return {
      modelId,
      model: { fileName, sha256: requireDigest(sha256, `MODEL_SPECS pin for ${modelId}`) },
      auxiliary,
    };
  });
  return { dirName, models };
}

/** `<data-dir>/Plainsong/models`, matching `crate::paths::data_dir()` + joins. */
export function modelsRootFor(dataDir: string): string {
  return path.join(dataDir, ...MODELS_ROOT_SEGMENTS);
}

/** Every copy the install makes, in a stable order. */
export function planInstall(options: {
  dataDir: string;
  stagingDir: string;
  community1: ReturnType<typeof parseCommunity1BundlePins>;
  transcribeCpp: ReturnType<typeof parseTranscribeCppPins>;
}): PlannedInstall[] {
  const modelsRoot = modelsRootFor(options.dataDir);
  const community1Dir = path.join(modelsRoot, DIARIZATION_DIR, options.community1.dirName);
  const transcribeCppDir = path.join(modelsRoot, options.transcribeCpp.dirName);
  const plan: PlannedInstall[] = options.community1.files.map((file) => ({
    ...file,
    pinnedIn: `${DOWNLOAD_MOD_RS} COMMUNITY1_BUNDLE`,
    source: path.join(options.stagingDir, file.fileName),
    destination: path.join(community1Dir, file.fileName),
  }));
  for (const model of options.transcribeCpp.models) {
    for (const file of [model.model, ...model.auxiliary]) {
      plan.push({
        ...file,
        pinnedIn: `${TRANSCRIBE_CPP_RS} ${model.modelId}`,
        source: path.join(options.stagingDir, file.fileName),
        destination: path.join(transcribeCppDir, file.fileName),
      });
    }
  }
  return plan;
}

/**
 * Refuse anything that could be a real profile: `dirs::data_dir()` on macOS is
 * ~/Library/Application Support, and the app's live data sits beneath it.
 */
export function assertIsolatedDataDir(dataDir: string, homeDir: string = os.homedir()): void {
  const realProfileRoot = path.join(homeDir, "Library", "Application Support");
  const relative = path.relative(realProfileRoot, dataDir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(
      `Refusing to install into ${dataDir}: it is inside ${realProfileRoot}, where real Plainsong profiles live. Use a temporary directory.`,
    );
  }
}

export interface CliOptions {
  dataDir: string;
  stagingDir: string;
  dryRun: boolean;
}

export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliOptions {
  let dataDir: string | null = null;
  let stagingDir = DEFAULT_STAGING_DIR;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === "--data-dir") dataDir = value();
    else if (arg === "--staging-dir") stagingDir = value();
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!dataDir?.trim()) {
    throw new Error(
      "--data-dir is required: the isolated directory you will pass to the sidecar as PLAINSONG_DATA_DIR.",
    );
  }
  const resolved = path.resolve(cwd, dataDir);
  assertIsolatedDataDir(resolved);
  return { dataDir: resolved, stagingDir: path.resolve(cwd, stagingDir), dryRun };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function cloneOrCopy(source: string, destination: string): "clone" | "copy" {
  const clone = spawnSync("/bin/cp", ["-c", source, destination], { encoding: "utf8" });
  if (clone.status === 0) return "clone";
  fs.rmSync(destination, { force: true });
  console.warn(
    `warning: APFS clone failed for ${path.basename(source)} (${clone.stderr.trim() || `exit ${clone.status}`}); making an ordinary copy.`,
  );
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  return "copy";
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const read = (relative: string) => fs.readFileSync(path.join(APP_ROOT, relative), "utf8");
  const plan = planInstall({
    dataDir: options.dataDir,
    stagingDir: options.stagingDir,
    community1: parseCommunity1BundlePins(read(DOWNLOAD_MOD_RS)),
    transcribeCpp: parseTranscribeCppPins(read(TRANSCRIBE_CPP_RS), STAGED_TRANSCRIBE_CPP_MODEL_IDS),
  });

  console.log(`${options.dryRun ? "Dry run: would install" : "Installing"} ${plan.length} files`);
  console.log(`  staging:   ${options.stagingDir}`);
  console.log(`  data dir:  ${options.dataDir}  (PLAINSONG_DATA_DIR)`);
  console.log(`  models:    ${modelsRootFor(options.dataDir)}`);

  // Every staged file must match its pin before anything is written.
  for (const item of plan) {
    if (!fs.statSync(item.source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Staged file is missing: ${item.source}`);
    }
    const actual = await sha256File(item.source);
    if (actual !== item.sha256) {
      throw new Error(
        `Staged ${item.fileName} does not match its pin (${item.pinnedIn}): expected ${item.sha256}, got ${actual}.`,
      );
    }
  }
  console.log("All staged files match their pins.");

  let installed = 0;
  for (const item of plan) {
    const rel = path.relative(options.dataDir, item.destination);
    const existing = fs.statSync(item.destination, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile()) throw new Error(`${item.destination} exists and is not a file.`);
      const actual = await sha256File(item.destination);
      if (actual !== item.sha256) {
        throw new Error(
          `${item.destination} already exists with a different digest (${actual}); remove it and run again.`,
        );
      }
      console.log(`  present   ${rel}  sha256 ${item.sha256} ok`);
      continue;
    }
    if (options.dryRun) {
      console.log(`  would copy ${item.fileName} -> ${rel}  then verify sha256 ${item.sha256}`);
      continue;
    }
    fs.mkdirSync(path.dirname(item.destination), { recursive: true });
    const partial = `${item.destination}.install-partial`;
    fs.rmSync(partial, { force: true });
    const method = cloneOrCopy(item.source, partial);
    fs.renameSync(partial, item.destination);
    const actual = await sha256File(item.destination);
    if (actual !== item.sha256) {
      fs.rmSync(item.destination, { force: true });
      throw new Error(
        `Copied ${item.destination} does not match its pin (${item.pinnedIn}): expected ${item.sha256}, got ${actual}. Removed it.`,
      );
    }
    installed += 1;
    console.log(`  ${method.padEnd(9)} ${rel}  sha256 ${actual} ok`);
  }

  if (options.dryRun) {
    console.log("Dry run: nothing written.");
    return;
  }
  console.log(`Done: ${installed} copied, ${plan.length - installed} already present, all verified.`);
  console.log(
    "No verification records were written; the sidecar hashes these files against the same pins at its next startup.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
