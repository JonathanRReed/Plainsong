#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(appRoot, "..");
const projectLicensePath = path.join(repositoryRoot, "LICENSE");
const outputPath = path.join(appRoot, "THIRD-PARTY-NOTICES.txt");
const cargoManifestPath = path.join(appRoot, "rust-sidecar", "Cargo.toml");
const cpalDirectory = path.join(
  appRoot,
  "rust-sidecar",
  "vendor",
  "cpal-0.18.1",
);
const cpalLicensePath = path.join(cpalDirectory, "LICENSE");
const electronDirectory = path.join(appRoot, "node_modules", "electron");
const electronPackagePath = path.join(electronDirectory, "package.json");
const electronLicensePath = path.join(electronDirectory, "dist", "LICENSE");
const chromiumNoticesPath = path.join(
  electronDirectory,
  "dist",
  "LICENSES.chromium.html",
);

const args = process.argv.slice(2);
const verifyAppIndex = args.indexOf("--verify-app");

function fail(message) {
  console.error(`Third-party notices: FAIL\n${message}`);
  process.exitCode = 1;
}

function readRequiredText(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  const value = fs.readFileSync(filePath, "utf8");
  if (value.length === 0) {
    throw new Error(`${label} is empty at ${filePath}`);
  }
  return value;
}

function withFinalNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyPackagedApp(appArgument) {
  const appPath = path.resolve(appRoot, appArgument);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const checks = [
    {
      name: "project LICENSE",
      packagedPath: path.join(resourcesPath, "LICENSE"),
      sourcePath: projectLicensePath,
    },
    {
      name: "third-party notices",
      packagedPath: path.join(resourcesPath, "THIRD-PARTY-NOTICES.txt"),
      sourcePath: outputPath,
    },
    {
      name: "Chromium attributions",
      packagedPath: path.join(resourcesPath, "LICENSES.chromium.html"),
      sourcePath: chromiumNoticesPath,
    },
  ];

  const failures = [];
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

function cargoMetadata() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      cargoManifestPath,
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
  return JSON.parse(result.stdout);
}

const LEGAL_FILE_PATTERN =
  /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:$|[._-])/i;

function legalFiles(packageDirectory, explicitLicenseFile = null) {
  const candidates = new Set();
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
  const documents = new Map();
  return {
    add(filePath, packageReference) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.length === 0) return null;
      const hash = sha256(content);
      const existing = documents.get(hash);
      if (existing) {
        existing.fileNames.add(path.basename(filePath));
        existing.packages.add(packageReference);
      } else {
        documents.set(hash, {
          hash,
          content,
          fileNames: new Set([path.basename(filePath)]),
          packages: new Set([packageReference]),
        });
      }
      return hash;
    },
    sorted(prefix) {
      return [...documents.values()]
        .sort((left, right) => left.hash.localeCompare(right.hash))
        .map((document, index) => ({
          ...document,
          id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
        }));
    },
  };
}

function normalizeRepository(repository) {
  const value =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : null;
  if (!value) return "not declared";
  return value
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function normalizeLicense(license) {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license.type === "string") return license.type;
  if (Array.isArray(license)) {
    const values = license.map(normalizeLicense).filter((value) => value !== "not declared");
    if (values.length > 0) return values.join(" OR ");
  }
  return "not declared";
}

function rustDependencies(metadata) {
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

function collectRust(metadata) {
  const collector = createDocumentCollector();
  const packages = rustDependencies(metadata).map((pkg) => {
    const packageReference = `${pkg.name}@${pkg.version}`;
    const isVendoredCpal =
      pkg.name === "cpal" &&
      pkg.version === "0.18.1" &&
      path.resolve(path.dirname(pkg.manifest_path)) === cpalDirectory;
    const documentHashes = isVendoredCpal
      ? []
      : legalFiles(path.dirname(pkg.manifest_path), pkg.license_file)
          .map((filePath) => collector.add(filePath, packageReference))
          .filter(Boolean);
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

function resolveInstalledPackage(name, fromDirectory) {
  let current = path.resolve(fromDirectory);
  while (true) {
    const candidate = path.join(current, "node_modules", ...name.split("/"), "package.json");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function npmProductionPackages(rootPackage) {
  const pending = Object.keys(rootPackage.dependencies ?? {})
    .sort()
    .map((name) => ({ name, fromDirectory: appRoot, optional: false }));
  const visitedPaths = new Set();
  const packages = [];

  while (pending.length > 0) {
    const request = pending.shift();
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

    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
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

function collectNpm(rootPackage) {
  const collector = createDocumentCollector();
  const records = new Map();

  for (const { manifest, packageDirectory } of npmProductionPackages(rootPackage)) {
    const name = manifest.name ?? path.basename(packageDirectory);
    const version = manifest.version ?? "unknown";
    const packageReference = `${name}@${version}`;
    const documentHashes = legalFiles(packageDirectory)
      .map((filePath) => collector.add(filePath, packageReference))
      .filter(Boolean);
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

function documentIdMap(documents) {
  return new Map(documents.map((document) => [document.hash, document.id]));
}

function renderPackageIndex(packages, documents, extraReference = () => null) {
  const ids = documentIdMap(documents);
  return packages
    .map((pkg) => {
      const references = pkg.documentHashes.map((hash) => ids.get(hash)).filter(Boolean);
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

function renderDocuments(documents) {
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

function renderNotices({ rootPackage, rust, npm, cpalLicense, electron }) {
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
    "  node scripts/generate-third-party-notices.mjs",
    "",
    `Application package: ${rootPackage.name}@${rootPackage.version}`,
    `Rust dependency packages: ${rust.packages.length}`,
    `npm production dependency packages: ${npm.packages.length}`,
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

function generate() {
  const rootPackage = JSON.parse(
    readRequiredText(path.join(appRoot, "package.json"), "package.json"),
  );
  const metadata = cargoMetadata();
  const rust = collectRust(metadata);
  const npm = collectNpm(rootPackage);
  const cpalLicense = readRequiredText(cpalLicensePath, "vendored CPAL license");
  const electron = JSON.parse(
    readRequiredText(electronPackagePath, "Electron package.json"),
  );
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

  fs.writeFileSync(outputPath, notices, "utf8");
  console.log(
    `Wrote ${outputPath} (${fs.statSync(outputPath).size} bytes, ${rust.packages.length} Rust packages, ${npm.packages.length} npm production packages).`,
  );
}

try {
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
