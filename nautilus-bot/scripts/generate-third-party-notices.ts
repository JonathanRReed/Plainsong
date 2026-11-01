#!/usr/bin/env bun
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";
import {
  MODEL_WEIGHTS,
  renderModelWeightsSection,
} from "./model-weights-manifest.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(appRoot, "..");
const projectLicensePath = path.join(repositoryRoot, "LICENSE");
const outputPath = path.join(appRoot, "THIRD-PARTY-NOTICES.txt");
const cargoManifestPath = path.join(appRoot, "rust-sidecar", "Cargo.toml");
/** The llama.cpp text helper ships beside the sidecar with its own lockfile. */
const textHelperManifestPath = path.join(
  appRoot,
  "rust-sidecar",
  "text-helper",
  "Cargo.toml",
);
const cpalDirectory = path.join(
  appRoot,
  "rust-sidecar",
  "vendor",
  "cpal-0.18.1",
);
const cpalLicensePath = path.join(cpalDirectory, "LICENSE");
// The speech helper (plainsong-native-asr-helper) is a Swift package that
// statically links FluidAudio. SwiftPM has no metadata command like
// `cargo metadata`, so the license texts are copied from the pinned FluidAudio
// revision into the repository and reproduced here verbatim.
const asrHelperDirectory = path.join(appRoot, "rust-sidecar", "native", "asr_helper");
const asrHelperLicenseFiles = [
  "FluidAudio-LICENSE",
  "fastcluster-LICENSE.md",
  "vbx-LICENSE.md",
  "JapaneseG2P-LICENSE.md",
  "KokoroAneSpanishFrenchG2P-LICENSE.md",
  "KokoroANE-v3/NOTICE",
  "KokoroANE-v3/conversion-LICENSE",
  "KokoroANE-v3/mattmireles-LICENSE",
];
const electronDirectory = path.join(appRoot, "node_modules", "electron");
const electronPackagePath = path.join(electronDirectory, "package.json");
const electronLicensePath = path.join(electronDirectory, "dist", "LICENSE");
const chromiumNoticesPath = path.join(
  electronDirectory,
  "dist",
  "LICENSES.chromium.html",
);

export interface NoticesComparisonInput {
  /** Notices regenerated from the current dependency graph. */
  current: string;
  /** Committed THIRD-PARTY-NOTICES.txt contents, or null when missing. */
  source: string | null;
  /** Packaged Contents/Resources/THIRD-PARTY-NOTICES.txt contents, or null when missing. */
  packaged: string | null;
  sourcePath: string;
  packagedPath: string;
}

/** The fields of `cargo metadata --format-version 1` this script reads. */
interface CargoPackage {
  id: string;
  name: string;
  version: string;
  source: string | null;
  manifest_path: string;
  license?: string | null;
  license_file?: string | null;
  repository?: string | null;
}

interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members?: string[];
  resolve?: { nodes?: { id: string }[] } | null;
}

/** The fields of a package.json this script reads. */
interface PackageManifest {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NpmRequest {
  name: string;
  fromDirectory: string;
  optional: boolean;
}

interface LicenseDocument {
  hash: string;
  content: string;
  fileNames: Set<string>;
  packages: Set<string>;
}

interface IdentifiedLicenseDocument extends LicenseDocument {
  id: string;
}

interface PackageRecord {
  name: string;
  version: string;
  license: string;
  repository: string;
  documentHashes: string[];
}

interface RustPackageRecord extends PackageRecord {
  isVendoredCpal: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const args = process.argv.slice(2);
const verifyAppIndex = args.indexOf("--verify-app");

function fail(message: string): void {
  console.error(`Third-party notices: FAIL\n${message}`);
  process.exitCode = 1;
}

function ensureElectronDistribution(): void {
  if (fs.existsSync(chromiumNoticesPath)) return;
  const installerPath = path.join(electronDirectory, "install.js");
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Electron installer not found at ${installerPath}`);
  }
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0 || !fs.existsSync(chromiumNoticesPath)) {
    throw new Error("Electron distribution could not be installed for license generation");
  }
}

function readRequiredText(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  const value = fs.readFileSync(filePath, "utf8");
  if (value.length === 0) {
    throw new Error(`${label} is empty at ${filePath}`);
  }
  return value;
}

function withFinalNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Compare the committed notices file and the packaged copy against the
 * notices regenerated from the current dependency graph. Comparing the
 * packaged file only to the source file would let `release:mac` package a
 * stale THIRD-PARTY-NOTICES.txt and still pass the license gate, so both are
 * held to the regenerated text. Returns one failure line per stale or
 * missing file, each saying which file is stale and how to fix it; an empty
 * array means both match.
 */
export function compareNoticesToCurrent({
  current,
  source,
  packaged,
  sourcePath,
  packagedPath,
}: NoticesComparisonInput): string[] {
  const failures: string[] = [];
  const currentHash = sha256(current);
  const regenerate =
    "run `bun run licenses:generate` from nautilus-bot/, commit THIRD-PARTY-NOTICES.txt, then rebuild the app";
  const sourceIsCurrent = source === current;

  if (source === null) {
    failures.push(`source third-party notices are missing: ${sourcePath}; ${regenerate}`);
  } else if (!sourceIsCurrent) {
    failures.push(
      `source third-party notices are stale: ${sourcePath} (sha256 ${sha256(source)}) does not match the notices regenerated from the current cargo metadata and npm production dependencies (sha256 ${currentHash}); ${regenerate}`,
    );
  }

  if (packaged === null) {
    failures.push(`packaged third-party notices are missing: ${packagedPath}`);
  } else if (packaged.length === 0) {
    failures.push(`packaged third-party notices are empty: ${packagedPath}`);
  } else if (packaged !== current) {
    failures.push(
      `packaged third-party notices are stale: ${packagedPath} (sha256 ${sha256(packaged)}) does not match the regenerated notices (sha256 ${currentHash}); ${
        sourceIsCurrent
          ? "the source file is current, so rebuild the app so it packages the current THIRD-PARTY-NOTICES.txt"
          : regenerate
      }`,
    );
  }

  return failures;
}

function readOptionalText(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function verifyPackagedApp(appArgument: string): void {
  const appPath = path.resolve(appRoot, appArgument);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const checks = [
    {
      name: "project LICENSE",
      packagedPath: path.join(resourcesPath, "LICENSE"),
      sourcePath: projectLicensePath,
    },
    {
      name: "Chromium attributions",
      packagedPath: path.join(resourcesPath, "LICENSES.chromium.html"),
      sourcePath: chromiumNoticesPath,
    },
  ];

  const failures: string[] = [];

  // Third-party notices: regenerate from the live dependency graph (same
  // macOS feature set as the shipped sidecar) and hold both the committed
  // file and the packaged copy to it.
  const packagedNoticesPath = path.join(resourcesPath, "THIRD-PARTY-NOTICES.txt");
  const { notices: currentNotices } = buildNotices();
  const noticesFailures = compareNoticesToCurrent({
    current: currentNotices,
    source: readOptionalText(outputPath),
    packaged: readOptionalText(packagedNoticesPath),
    sourcePath: outputPath,
    packagedPath: packagedNoticesPath,
  });
  if (noticesFailures.length === 0) {
    console.log(
      `PASS third-party notices: ${packagedNoticesPath} (source and packaged copies match the regenerated notices, sha256 ${sha256(currentNotices)})`,
    );
  }
  failures.push(...noticesFailures);

  for (const check of checks) {
    if (!fs.existsSync(check.sourcePath)) {
      failures.push(`source ${check.name} is missing: ${check.sourcePath}`);
      continue;
    }
    if (!fs.existsSync(check.packagedPath)) {
      failures.push(`packaged ${check.name} is missing: ${check.packagedPath}`);
      continue;
    }

    const source = fs.readFileSync(check.sourcePath);
    const packaged = fs.readFileSync(check.packagedPath);
    if (packaged.length === 0) {
      failures.push(`packaged ${check.name} is empty: ${check.packagedPath}`);
    } else if (!source.equals(packaged)) {
      failures.push(
        `packaged ${check.name} does not match its source (expected ${sha256(source)}, got ${sha256(packaged)}): ${check.packagedPath}`,
      );
    } else {
      console.log(`PASS ${check.name}: ${check.packagedPath}`);
    }
  }

  if (failures.length > 0) {
    fail(failures.map((failure) => `- ${failure}`).join("\n"));
    return;
  }

  console.log(`Third-party notices: PASS (${appPath})`);
}

function cargoMetadataFor(manifestPath: string, featureArgs: string[]): CargoMetadata {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      manifestPath,
      ...featureArgs,
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`cargo metadata failed${details ? `:\n${details}` : ""}`);
  }
  return JSON.parse(result.stdout) as CargoMetadata;
}

/** Both shipped Rust binaries' dependency graphs, merged by package id. */
export function mergeCargoMetadata(graphs: CargoMetadata[]): CargoMetadata {
  const packages = new Map<string, CargoPackage>();
  const nodes = new Map<string, { id: string }>();
  const members = new Set<string>();
  for (const graph of graphs) {
    for (const pkg of graph.packages) packages.set(pkg.id, pkg);
    for (const node of graph.resolve?.nodes ?? []) nodes.set(node.id, node);
    for (const member of graph.workspace_members ?? []) members.add(member);
  }
  return {
    packages: [...packages.values()],
    workspace_members: [...members],
    resolve: { nodes: [...nodes.values()] },
  };
}

function cargoMetadata(): CargoMetadata {
  return mergeCargoMetadata([
    // Resolve the same feature set scripts/build-rust-sidecar.ts ships on
    // this host, so crates pulled in only by the macOS acceleration
    // features (Metal, CoreML) get their notices too.
    cargoMetadataFor(cargoManifestPath, sidecarCargoFeatureArgs()),
    cargoMetadataFor(textHelperManifestPath, []),
  ]);
}

/**
 * llama-cpp-sys-2 compiles llama.cpp and the libraries llama.cpp vendors
 * into the text helper. Their terms sit below the crate root, where the
 * top-level scan does not look. nlohmann/json carries its terms only as an
 * SPDX header, which is reproduced verbatim.
 */
function bundledNativeLegalTexts(
  pkg: CargoPackage,
): { name: string; content: string }[] {
  if (pkg.name !== "llama-cpp-sys-2") return [];
  const root = path.join(path.dirname(pkg.manifest_path), "llama.cpp");
  const texts: { name: string; content: string }[] = [];
  const add = (relative: string) => {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) {
      texts.push({ name: `llama.cpp/${relative}`, content: fs.readFileSync(file, "utf8") });
    }
  };
  add("LICENSE");
  const vendor = path.join(root, "vendor");
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (LEGAL_FILE_PATTERN.test(entry.name)) add(path.relative(root, full));
    }
  };
  walk(vendor);
  const json = path.join(vendor, "nlohmann", "json.hpp");
  if (fs.existsSync(json)) {
    const header = fs
      .readFileSync(json, "utf8")
      .split("\n")
      .slice(0, 8)
      .join("\n");
    if (header.includes("SPDX-License-Identifier")) {
      texts.push({ name: "llama.cpp/vendor/nlohmann/json.hpp (header)", content: `${header}\n` });
    }
  }
  if (!texts.some((text) => text.name === "llama.cpp/LICENSE")) {
    throw new Error(`llama.cpp LICENSE not found under ${root}`);
  }
  return texts;
}

const LEGAL_FILE_PATTERN =
  /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:$|[._-])/i;

function legalFiles(
  packageDirectory: string,
  explicitLicenseFile: string | null = null,
): string[] {
  const candidates = new Set<string>();
  if (explicitLicenseFile) {
    candidates.add(
      path.isAbsolute(explicitLicenseFile)
        ? explicitLicenseFile
        : path.resolve(packageDirectory, explicitLicenseFile),
    );
  }

  for (const entry of fs.readdirSync(packageDirectory, { withFileTypes: true })) {
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      LEGAL_FILE_PATTERN.test(entry.name)
    ) {
      candidates.add(path.join(packageDirectory, entry.name));
    }
  }

  return [...candidates]
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function createDocumentCollector() {
  const documents = new Map<string, LicenseDocument>();
  return {
    add(filePath: string, packageReference: string): string | null {
      return this.addText(
        path.basename(filePath),
        fs.readFileSync(filePath, "utf8"),
        packageReference,
      );
    },
    addText(fileName: string, content: string, packageReference: string): string | null {
      if (content.length === 0) return null;
      const hash = sha256(content);
      const existing = documents.get(hash);
      if (existing) {
        existing.fileNames.add(fileName);
        existing.packages.add(packageReference);
      } else {
        documents.set(hash, {
          hash,
          content,
          fileNames: new Set([fileName]),
          packages: new Set([packageReference]),
        });
      }
      return hash;
    },
    sorted(prefix: string): IdentifiedLicenseDocument[] {
      return [...documents.values()]
        .sort((left, right) => left.hash.localeCompare(right.hash))
        .map((document, index) => ({
          ...document,
          id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
        }));
    },
  };
}

function normalizeRepository(repository: unknown): string {
  const value =
    typeof repository === "string"
      ? repository
      : isRecord(repository) && typeof repository.url === "string"
        ? repository.url
        : null;
  if (!value) return "not declared";
  return value
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function normalizeLicense(license: unknown): string {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (isRecord(license) && typeof license.type === "string") return license.type;
  if (Array.isArray(license)) {
    const values = license.map(normalizeLicense).filter((value) => value !== "not declared");
    if (values.length > 0) return values.join(" OR ");
  }
  return "not declared";
}

function rustDependencies(metadata: CargoMetadata): CargoPackage[] {
  const resolvedIds = new Set(metadata.resolve?.nodes?.map((node) => node.id) ?? []);
  const workspaceIds = new Set(metadata.workspace_members ?? []);
  return metadata.packages
    .filter((pkg) => resolvedIds.has(pkg.id) && !workspaceIds.has(pkg.id))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version) ||
        String(left.source).localeCompare(String(right.source)),
    );
}

function collectRust(metadata: CargoMetadata): {
  packages: RustPackageRecord[];
  documents: IdentifiedLicenseDocument[];
} {
  const collector = createDocumentCollector();
  const packages = rustDependencies(metadata).map((pkg) => {
    const packageReference = `${pkg.name}@${pkg.version}`;
    const isVendoredCpal =
      pkg.name === "cpal" &&
      pkg.version === "0.18.1" &&
      path.resolve(path.dirname(pkg.manifest_path)) === cpalDirectory;
    const documentHashes = isVendoredCpal
      ? []
      : [
          ...legalFiles(path.dirname(pkg.manifest_path), pkg.license_file).map((filePath) =>
            collector.add(filePath, packageReference),
          ),
          ...bundledNativeLegalTexts(pkg).map((text) =>
            collector.addText(text.name, text.content, packageReference),
          ),
        ].filter((hash): hash is string => Boolean(hash));
    return {
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicense(pkg.license),
      repository: normalizeRepository(
        pkg.repository ?? `https://crates.io/crates/${pkg.name}/${pkg.version}`,
      ),
      documentHashes: [...new Set(documentHashes)],
      isVendoredCpal,
    };
  });
  return { packages, documents: collector.sorted("RUST-LICENSE") };
}

function resolveInstalledPackage(name: string, fromDirectory: string): string | null {
  let current = path.resolve(fromDirectory);
  while (true) {
    const candidate = path.join(current, "node_modules", ...name.split("/"), "package.json");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function npmProductionPackages(
  rootPackage: PackageManifest,
): { manifest: PackageManifest; packageDirectory: string }[] {
  const pending = Object.keys(rootPackage.dependencies ?? {})
    .sort()
    .map((name) => ({ name, fromDirectory: appRoot, optional: false }));
  const visitedPaths = new Set<string>();
  const packages: { manifest: PackageManifest; packageDirectory: string }[] = [];

  while (pending.length > 0) {
    const request = pending.shift() as NpmRequest;
    const packageJsonPath = resolveInstalledPackage(
      request.name,
      request.fromDirectory,
    );
    if (!packageJsonPath) {
      if (request.optional) continue;
      throw new Error(
        `production npm dependency ${request.name} could not be resolved from ${request.fromDirectory}; install dependencies before generating notices`,
      );
    }
    if (visitedPaths.has(packageJsonPath)) continue;
    visitedPaths.add(packageJsonPath);

    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    const packageDirectory = path.dirname(packageJsonPath);
    packages.push({ manifest, packageDirectory });

    const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...optionalNames,
    ]);
    for (const name of [...dependencyNames].sort()) {
      pending.push({
        name,
        fromDirectory: packageDirectory,
        optional: optionalNames.has(name),
      });
    }
  }

  return packages;
}

function collectNpm(rootPackage: PackageManifest): {
  packages: PackageRecord[];
  documents: IdentifiedLicenseDocument[];
} {
  const collector = createDocumentCollector();
  const records = new Map<
    string,
    Omit<PackageRecord, "documentHashes"> & { documentHashes: Set<string> }
  >();

  for (const { manifest, packageDirectory } of npmProductionPackages(rootPackage)) {
    const name = manifest.name ?? path.basename(packageDirectory);
    const version = manifest.version ?? "unknown";
    const packageReference = `${name}@${version}`;
    const documentHashes = legalFiles(packageDirectory)
      .map((filePath) => collector.add(filePath, packageReference))
      .filter((hash): hash is string => Boolean(hash));
    const existing = records.get(packageReference);
    if (existing) {
      for (const hash of documentHashes) existing.documentHashes.add(hash);
      continue;
    }
    records.set(packageReference, {
      name,
      version,
      license: normalizeLicense(manifest.license ?? manifest.licenses),
      repository: normalizeRepository(
        manifest.repository ??
          manifest.homepage ??
          `https://www.npmjs.com/package/${name}/v/${version}`,
      ),
      documentHashes: new Set(documentHashes),
    });
  }

  const packages = [...records.values()]
    .map((record) => ({
      ...record,
      documentHashes: [...record.documentHashes],
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
  return { packages, documents: collector.sorted("NPM-LICENSE") };
}

function documentIdMap(documents: IdentifiedLicenseDocument[]): Map<string, string> {
  return new Map(documents.map((document) => [document.hash, document.id]));
}

function renderPackageIndex<T extends PackageRecord>(
  packages: T[],
  documents: IdentifiedLicenseDocument[],
  extraReference: (pkg: T) => string | null = () => null,
): string {
  const ids = documentIdMap(documents);
  return packages
    .map((pkg) => {
      const references = pkg.documentHashes
        .map((hash) => ids.get(hash))
        .filter((id): id is string => Boolean(id));
      const extra = extraReference(pkg);
      if (extra) references.unshift(extra);
      const material =
        references.length > 0
          ? references.join(", ")
          : "no local license file found; use the SPDX/license declaration and repository above";
      return [
        `${pkg.name} ${pkg.version}`,
        `  License: ${pkg.license}`,
        `  Repository: ${pkg.repository}`,
        `  License material: ${material}`,
      ].join("\n");
    })
    .join("\n\n");
}

function renderDocuments(documents: IdentifiedLicenseDocument[]): string {
  if (documents.length === 0) return "No local license documents were found.\n";
  return documents
    .map((document) => {
      const fileNames = [...document.fileNames].sort().join(", ");
      const packageReferences = [...document.packages].sort().join(", ");
      return [
        "--------------------------------------------------------------------------------",
        document.id,
        `File name(s): ${fileNames}`,
        `Applies to: ${packageReferences}`,
        `SHA-256: ${document.hash}`,
        "--------------------------------------------------------------------------------",
        withFinalNewline(document.content),
      ].join("\n");
    })
    .join("\n");
}

/** FluidAudio's pin, read from the Package.resolved the build is forced to use. */
function fluidAudioPin(): { version: string; revision: string } {
  const resolved = JSON.parse(
    readRequiredText(path.join(asrHelperDirectory, "Package.resolved"), "speech helper Package.resolved"),
  ) as { pins?: { identity?: string; state?: { version?: string; revision?: string } }[] };
  const pin = resolved.pins?.find((entry) => entry.identity === "fluidaudio");
  if (!pin?.state?.version || !pin.state.revision) {
    throw new Error("speech helper Package.resolved does not pin FluidAudio");
  }
  return { version: pin.state.version, revision: pin.state.revision };
}

function renderAsrHelperSection(): string {
  const pin = fluidAudioPin();
  const files = asrHelperLicenseFiles.map((relative) => {
    const content = readRequiredText(
      path.join(asrHelperDirectory, "licenses", relative),
      `speech helper license ${relative}`,
    );
    return [
      `----- BEGIN FluidAudio ${relative} -----`,
      withFinalNewline(content),
      `----- END FluidAudio ${relative} -----`,
    ].join("\n");
  });
  return [
    `FluidAudio ${pin.version} (revision ${pin.revision}), Apache-2.0, by FluidInference.`,
    "Repository: https://github.com/FluidInference/FluidAudio",
    "Statically linked into plainsong-native-asr-helper, the speech helper that runs",
    "Parakeet on the Neural Engine. The texts below are FluidAudio's LICENSE and the",
    "third-party licenses it ships for code compiled into the library (fastcluster,",
    "VBx, text frontends), copied from that revision. FluidAudio's optional prebuilt",
    "NemoTextProcessing framework is turned off in the helper's Package.swift and is",
    "not linked or shipped.",
    "",
    ...files,
  ].join("\n");
}

function renderNotices({
  rootPackage,
  rust,
  npm,
  cpalLicense,
  electron,
}: {
  rootPackage: PackageManifest;
  rust: ReturnType<typeof collectRust>;
  npm: ReturnType<typeof collectNpm>;
  cpalLicense: string;
  electron: PackageManifest;
}): string {
  const electronRepository = normalizeRepository(
    electron.repository ?? electron.homepage,
  );
  const electronLicense = normalizeLicense(electron.license);
  const electronLicenseText = readRequiredText(
    electronLicensePath,
    "Electron license",
  );

  return [
    "PLAINSONG THIRD-PARTY SOFTWARE NOTICES",
    "================================================================================",
    "This file is generated. Do not edit it by hand.",
    "Regenerate from nautilus-bot/ with:",
    "  bun scripts/generate-third-party-notices.ts",
    "",
    `Application package: ${rootPackage.name}@${rootPackage.version}`,
    `Rust dependency packages: ${rust.packages.length}`,
    `npm production dependency packages: ${npm.packages.length}`,
    `Downloadable model artifacts: ${MODEL_WEIGHTS.length}`,
    "",
    "The dependency indexes retain declared license identifiers and repository URLs",
    "even when no license file is available in the installed package or Cargo cache.",
    "",
    "================================================================================",
    "VENDORED CPAL 0.18.1 — APACHE LICENSE 2.0",
    "================================================================================",
    "CPAL is vendored at rust-sidecar/vendor/cpal-0.18.1 and statically linked into",
    "the Plainsong sidecar. The following is the complete vendored LICENSE file,",
    "reproduced verbatim. The vendored CPAL source contains no NOTICE file.",
    "",
    "----- BEGIN rust-sidecar/vendor/cpal-0.18.1/LICENSE -----",
    withFinalNewline(cpalLicense),
    "----- END rust-sidecar/vendor/cpal-0.18.1/LICENSE -----",
    "",
    "================================================================================",
    "SPEECH HELPER — FLUIDAUDIO (SWIFT PACKAGE)",
    "================================================================================",
    renderAsrHelperSection(),
    "",
    "================================================================================",
    "MODEL WEIGHTS",
    "================================================================================",
    renderModelWeightsSection(),
    "",
    "================================================================================",
    "RUST DEPENDENCY INDEX",
    "================================================================================",
    renderPackageIndex(
      rust.packages,
      rust.documents,
      (pkg) => (pkg.isVendoredCpal ? "vendored CPAL LICENSE section above" : null),
    ),
    "",
    "================================================================================",
    "RUST LICENSE DOCUMENTS",
    "================================================================================",
    renderDocuments(rust.documents),
    "",
    "================================================================================",
    "NPM PRODUCTION DEPENDENCY INDEX",
    "================================================================================",
    renderPackageIndex(npm.packages, npm.documents),
    "",
    "================================================================================",
    "NPM LICENSE DOCUMENTS",
    "================================================================================",
    renderDocuments(npm.documents),
    "",
    "================================================================================",
    `ELECTRON ${electron.version} LICENSE`,
    "================================================================================",
    `Package: electron@${electron.version}`,
    `License: ${electronLicense}`,
    `Repository: ${electronRepository}`,
    `Source file: node_modules/electron/dist/LICENSE`,
    "",
    "----- BEGIN ELECTRON LICENSE -----",
    withFinalNewline(electronLicenseText),
    "----- END ELECTRON LICENSE -----",
    "",
    "================================================================================",
    "CHROMIUM AND BUNDLED THIRD-PARTY NOTICES",
    "================================================================================",
    "Electron's Chromium and bundled third-party attributions are distributed beside",
    "this file as LICENSES.chromium.html. That accompanying file is copied verbatim",
    "from node_modules/electron/dist/LICENSES.chromium.html during packaging.",
    "",
  ].join("\n");
}

/**
 * Render the notices from the current dependency graph without touching the
 * filesystem output. Shared by `generate()` (which writes it) and
 * `verifyPackagedApp()` (which compares against it).
 */
function buildNotices() {
  const rootPackage = JSON.parse(
    readRequiredText(path.join(appRoot, "package.json"), "package.json"),
  ) as PackageManifest;
  const metadata = cargoMetadata();
  const rust = collectRust(metadata);
  const npm = collectNpm(rootPackage);
  const cpalLicense = readRequiredText(cpalLicensePath, "vendored CPAL license");
  const electron = JSON.parse(
    readRequiredText(electronPackagePath, "Electron package.json"),
  ) as PackageManifest;
  readRequiredText(chromiumNoticesPath, "Chromium attribution file");
  const notices = renderNotices({
    rootPackage,
    rust,
    npm,
    cpalLicense,
    electron,
  });

  if (!notices.includes(cpalLicense)) {
    throw new Error("generated notices do not contain the vendored CPAL license verbatim");
  }

  // Every downloadable model must appear by name. The weights are the one
  // class of third-party material with no dependency graph to derive them
  // from, so a model added to the Rust source without an entry in
  // scripts/model-weights-manifest.mjs would otherwise ship unmentioned.
  for (const entry of MODEL_WEIGHTS) {
    if (!notices.includes(entry.name) || !notices.includes(entry.revision)) {
      throw new Error(
        `generated notices do not name the model artifact ${entry.name} at ${entry.revision}`,
      );
    }
  }

  return { notices, rust, npm };
}

function generate(): void {
  const { notices, rust, npm } = buildNotices();
  fs.writeFileSync(outputPath, notices, "utf8");
  console.log(
    `Wrote ${outputPath} (${fs.statSync(outputPath).size} bytes, ${rust.packages.length} Rust packages, ${npm.packages.length} npm production packages, ${MODEL_WEIGHTS.length} model artifacts).`,
  );
}

function main(): void {
  try {
    ensureElectronDistribution();
    if (verifyAppIndex >= 0) {
      const appArgument = args[verifyAppIndex + 1];
      if (!appArgument || appArgument.startsWith("--")) {
        throw new Error("--verify-app requires a path to a packaged .app bundle");
      }
      verifyPackagedApp(appArgument);
    } else if (args.length > 0) {
      throw new Error(`unknown arguments: ${args.join(" ")}`);
    } else {
      generate();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// Only run when executed directly; tests import `compareNoticesToCurrent`.
const entrypointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entrypointUrl === import.meta.url) {
  main();
}
