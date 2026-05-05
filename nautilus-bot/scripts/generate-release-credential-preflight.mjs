#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/release-credential-preflight.json"),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/release-credential-preflight.md"),
);

function present(name) {
  return Boolean(process.env[name]?.trim());
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function findDeveloperIdIdentity() {
  if (process.platform !== "darwin") {
    return {
      checked: false,
      available: false,
      reason: "Keychain identity check only runs on macOS.",
    };
  }

  const result = spawnSync("security", ["find-identity", "-p", "codesigning", "-v"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const developerIdLines = output
    .split(/\r?\n/)
    .filter((line) => line.includes("Developer ID Application:"));
  const configuredName = process.env.CSC_NAME?.trim() ?? "";
  const matchingConfiguredName =
    configuredName.length > 0 &&
    developerIdLines.some((line) => line.includes(configuredName));

  return {
    checked: true,
    available: developerIdLines.length > 0,
    developerIdIdentityCount: developerIdLines.length,
    configuredNamePresent: configuredName.length > 0,
    matchingConfiguredName,
  };
}

const generatedAt = new Date().toISOString();
const macCertificatePresent = present("CSC_LINK") || present("CSC_NAME");
const macCertificatePasswordReady = present("CSC_KEY_PASSWORD") || present("CSC_NAME");
const macNotarizationReady =
  present("APPLE_ID") &&
  present("APPLE_APP_SPECIFIC_PASSWORD") &&
  present("APPLE_TEAM_ID");
const macKeychain = findDeveloperIdIdentity();
const macReady =
  macCertificatePresent &&
  macCertificatePasswordReady &&
  macNotarizationReady &&
  (macKeychain.available || present("CSC_LINK"));

const windowsCertificatePresent = present("WIN_CSC_LINK") || present("WINDOWS_CERTIFICATE");
const windowsCertificatePasswordPresent =
  present("WIN_CSC_KEY_PASSWORD") || present("WINDOWS_CERTIFICATE_PASSWORD");
const windowsPublisherPresent = present("WIN_PUBLISHER_NAME") || present("WINDOWS_PUBLISHER_NAME");
const windowsReady = windowsCertificatePresent && windowsCertificatePasswordPresent;
const publishReady = present("GH_TOKEN") || present("GITHUB_TOKEN");

const report = {
  generatedAt,
  status: macReady && windowsReady && publishReady ? "READY" : "BLOCKED",
  pass: macReady && windowsReady && publishReady,
  artifactPolicy:
    "Only environment variable names, boolean presence, and keychain identity counts are recorded. Secret values and certificate contents are never written.",
  macOS: {
    ready: macReady,
    requiredEnvironment: [
      { name: "CSC_LINK or CSC_NAME", present: macCertificatePresent },
      { name: "CSC_KEY_PASSWORD or Keychain identity", present: macCertificatePasswordReady },
      { name: "APPLE_ID", present: present("APPLE_ID") },
      { name: "APPLE_APP_SPECIFIC_PASSWORD", present: present("APPLE_APP_SPECIFIC_PASSWORD") },
      { name: "APPLE_TEAM_ID", present: present("APPLE_TEAM_ID") },
    ],
    keychain: macKeychain,
    validationCommands: [
      "bun run electron:build:dmg",
      "codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app",
      "spctl --assess --verbose=4 release/mac-arm64/Nautilus.app",
      "xcrun stapler validate release/mac-arm64/Nautilus.app",
    ],
  },
  windows: {
    ready: windowsReady,
    requiredEnvironment: [
      { name: "WIN_CSC_LINK or WINDOWS_CERTIFICATE", present: windowsCertificatePresent },
      {
        name: "WIN_CSC_KEY_PASSWORD or WINDOWS_CERTIFICATE_PASSWORD",
        present: windowsCertificatePasswordPresent,
      },
      { name: "WIN_PUBLISHER_NAME or WINDOWS_PUBLISHER_NAME", present: windowsPublisherPresent },
    ],
    validationCommands: [
      "bun run electron:build:win",
      "Get-AuthenticodeSignature .\\release\\Nautilus Setup 1.0.0.exe | Format-List",
      "pwsh scripts/windows-packaged-qa-runner.ps1",
    ],
    smartScreenNote:
      "A signed first release may still show reputation warnings until the publisher and file reputation are established.",
  },
  publish: {
    ready: publishReady,
    requiredEnvironment: [
      { name: "GH_TOKEN or GITHUB_TOKEN", present: publishReady },
    ],
    validationCommands: [
      "Create a draft GitHub release.",
      "Validate update metadata from a prior signed build before promotion.",
    ],
  },
};

const macMissing = report.macOS.requiredEnvironment
  .filter((entry) => !entry.present)
  .map((entry) => entry.name);
const winMissing = report.windows.requiredEnvironment
  .filter((entry) => !entry.present && !entry.name.includes("PUBLISHER"))
  .map((entry) => entry.name);
const publishMissing = report.publish.requiredEnvironment
  .filter((entry) => !entry.present)
  .map((entry) => entry.name);

writeJson(outPath, report);
writeText(
  markdownPath,
  `# Release Credential Preflight

Status: ${report.status}
Generated: ${generatedAt}

This preflight is intentionally secret-safe. It records only environment variable names, boolean presence, and keychain identity counts.

## macOS

- Ready: ${macReady ? "yes" : "no"}
- Missing required inputs: ${macMissing.length > 0 ? macMissing.join(", ") : "none"}
- Developer ID identities found: ${
    "developerIdIdentityCount" in macKeychain
      ? macKeychain.developerIdIdentityCount
      : "not checked"
  }
- Configured identity matched: ${
    "matchingConfiguredName" in macKeychain && macKeychain.matchingConfiguredName
      ? "yes"
      : "no"
  }

Required validation:

- \`bun run electron:build:dmg\`
- \`codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app\`
- \`spctl --assess --verbose=4 release/mac-arm64/Nautilus.app\`
- \`xcrun stapler validate release/mac-arm64/Nautilus.app\`

## Windows

- Ready: ${windowsReady ? "yes" : "no"}
- Missing required inputs: ${winMissing.length > 0 ? winMissing.join(", ") : "none"}
- Publisher name present: ${windowsPublisherPresent ? "yes" : "no"}

Required validation:

- \`bun run electron:build:win\`
- \`Get-AuthenticodeSignature .\\\\release\\\\Nautilus Setup 1.0.0.exe | Format-List\`
- \`pwsh scripts/windows-packaged-qa-runner.ps1\`

SmartScreen note: ${report.windows.smartScreenNote}

## Publishing

- Ready: ${publishReady ? "yes" : "no"}
- Missing required inputs: ${publishMissing.length > 0 ? publishMissing.join(", ") : "none"}
- Required flow: draft GitHub release first, update metadata validation second, public promotion last.
`,
);

console.log(JSON.stringify(report, null, 2));
