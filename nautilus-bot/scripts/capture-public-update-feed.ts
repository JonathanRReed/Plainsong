#!/usr/bin/env bun
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.ts";
import {
  channelManifestUrl,
  evaluateChannelManifest,
  RELEASE_CHANNEL_POLICY,
  evaluatePublicUpdateFeedEvidence,
  parseMacUpdateManifest,
  parsePackagedUpdateConfig,
  resolveFeedAssetUrl,
  resolveFeedBaseUrl,
  UPDATE_CHANNELS,
  validatePublicFeedUrl,
  type ChannelManifestProbe,
  type ParsedMacUpdateManifest,
  type PublicUpdateFeedEvidence,
  type UpdateChannelName,
} from "./lib/public-update-feed.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback?: string | null): string | null;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const candidatePath = path.resolve(
  repoRoot,
  valueFor("--candidate", "release"),
);
const requestedManifest = valueFor("--manifest", "beta-mac.yml");
const rawFeedUrl = valueFor("--feed-url", "");
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/public-update-feed.json"),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/public-update-feed.md"),
);
const timeoutMs = Number(valueFor("--timeout-ms", "180000"));

function fileHash(
  filePath: string,
  algorithm: string,
  encoding: crypto.BinaryToTextEncoding = "hex",
): string {
  return crypto
    .createHash(algorithm)
    .update(fs.readFileSync(filePath))
    .digest(encoding);
}

function plistScalar(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", filePath],
    { encoding: "utf8" },
  );
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

interface FetchedResource {
  status: number;
  finalUrl: string;
  bytes: number;
  sha256: string;
  sha512: string;
  contentRange: string | null;
  text: string | null;
}

async function fetchHashed(
  url: string,
  maxBytes: number,
  headers: Record<string, string> = {},
  captureText = false,
): Promise<FetchedResource> {
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sha256 = crypto.createHash("sha256");
  const sha512 = crypto.createHash("sha512");
  let bytes = 0;
  const chunks: Buffer[] = [];
  if (response.body) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`Response from ${url} exceeded ${maxBytes} bytes.`);
      }
      sha256.update(buffer);
      sha512.update(buffer);
      if (captureText) chunks.push(buffer);
    }
  }
  return {
    status: response.status,
    finalUrl: response.url,
    bytes,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
    contentRange: response.headers.get("content-range"),
    text: captureText ? Buffer.concat(chunks).toString("utf8") : null,
  };
}

type PublicUpdateFeedReceipt = typeof receipt;

function renderMarkdown(receipt: PublicUpdateFeedReceipt): string {
  return `# Plainsong public beta update feed

Status: ${receipt.pass ? "PASS" : "BLOCKED"}
Generated: ${receipt.generatedAt}
Feed: ${receipt.feedUrl || "missing"}
Manifest: ${receipt.requestedManifest}
Candidate version: ${receipt.candidate?.version ?? "missing"}
Candidate ZIP SHA-256: ${receipt.candidateZipSha256 ?? "missing"}

## Channel manifests

${UPDATE_CHANNELS
  .map((channel) => {
    const probe = receipt.channelManifests[channel];
    return `- ${channel}: ${probe?.url ?? "unresolved"} ${probe?.status ?? "no response"}, ${receipt.channelStates[channel]?.state}`;
  })
  .join("\n")}

## Checks

${Object.entries(receipt.checks)
  .map(([name, pass]) => `- ${name}: ${pass ? "PASS" : "FAIL"}`)
  .join("\n")}

## Errors

${receipt.errors.length > 0 ? receipt.errors.map((error) => `- ${error}`).join("\n") : "- none"}
`;
}

function writeReceipt(receipt: PublicUpdateFeedReceipt): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(receipt).trimEnd()}\n`, "utf8");
  console.log(JSON.stringify(receipt, null, 2));
}

const generatedAt = new Date().toISOString();
const errors: string[] = [];
const feedValidation = validatePublicFeedUrl(rawFeedUrl);
const appPath = path.join(candidatePath, "mac-arm64", "Plainsong.app");
const appInfoPath = path.join(appPath, "Contents", "Info.plist");
const appUpdatePath = path.join(
  appPath,
  "Contents",
  "Resources",
  "app-update.yml",
);
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath,
  appPath,
});
const candidateManifestPath = path.join(candidatePath, requestedManifest);
const candidateVersion = plistScalar(
  appInfoPath,
  "CFBundleShortVersionString",
);
const packagedUpdateConfig = fs.existsSync(appUpdatePath)
  ? parsePackagedUpdateConfig(fs.readFileSync(appUpdatePath, "utf8"))
  : {
      provider: null,
      url: null,
      channel: null,
      useMultipleRangeRequest: null,
    };

let parsedManifest: ParsedMacUpdateManifest = {
  version: null,
  zipName: null,
  sha512: null,
  size: null,
};
if (fs.existsSync(candidateManifestPath)) {
  parsedManifest = parseMacUpdateManifest(
    fs.readFileSync(candidateManifestPath, "utf8"),
  );
} else {
  errors.push(`Candidate manifest is missing: ${candidateManifestPath}`);
}

const candidateZipPath = parsedManifest.zipName
  ? path.join(candidatePath, parsedManifest.zipName)
  : null;
const candidateBlockmapPath = candidateZipPath
  ? `${candidateZipPath}.blockmap`
  : null;
for (const [label, filePath] of [
  ["candidate app Info.plist", appInfoPath],
  ["candidate app-update.yml", appUpdatePath],
  ["candidate ZIP", candidateZipPath],
  ["candidate blockmap", candidateBlockmapPath],
]) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${label} is missing.`);
  }
}
if (!feedValidation.valid) {
  errors.push(`Feed URL is invalid: ${feedValidation.reason}.`);
}
if (requestedManifest !== "beta-mac.yml") {
  errors.push("The limited beta must verify beta-mac.yml.");
}

const candidateManifestSha256 = fs.existsSync(candidateManifestPath)
  ? fileHash(candidateManifestPath, "sha256")
  : null;
const candidateZipBytes = candidateZipPath && fs.existsSync(candidateZipPath)
  ? fs.statSync(candidateZipPath).size
  : null;
const candidateZipSha256 = candidateZipPath && fs.existsSync(candidateZipPath)
  ? fileHash(candidateZipPath, "sha256")
  : null;
const candidateZipSha512 = candidateZipPath && fs.existsSync(candidateZipPath)
  ? fileHash(candidateZipPath, "sha512", "base64")
  : null;
const candidateBlockmapBytes =
  candidateBlockmapPath && fs.existsSync(candidateBlockmapPath)
    ? fs.statSync(candidateBlockmapPath).size
    : null;
const candidateBlockmapSha256 =
  candidateBlockmapPath && fs.existsSync(candidateBlockmapPath)
    ? fileHash(candidateBlockmapPath, "sha256")
    : null;

const manifestUrl = feedValidation.valid
  ? new URL(requestedManifest, feedValidation.normalizedUrl as string).href
  : null;
let remoteManifest: FetchedResource | null = null;
let remoteZip: FetchedResource | null = null;
let remoteBlockmap: FetchedResource | null = null;
let remoteRange: FetchedResource | null = null;
let zipUrl: string | null = null;
let blockmapUrl: string | null = null;

if (errors.length === 0 && manifestUrl) {
  try {
    remoteManifest = await fetchHashed(
      manifestUrl,
      1024 * 1024,
      { accept: "application/yaml, text/yaml, text/plain" },
      true,
    );
    // captureText is true above, so the manifest body was kept.
    const remoteParsed = parseMacUpdateManifest(remoteManifest.text as string);
    parsedManifest = remoteParsed;
    if (remoteParsed.zipName) {
      zipUrl = resolveFeedAssetUrl(
        // manifestUrl is only set when feedValidation.valid, which carries normalizedUrl.
        feedValidation.normalizedUrl as string,
        manifestUrl,
        remoteParsed.zipName,
      );
      if (zipUrl) {
        blockmapUrl = `${zipUrl}.blockmap`;
      } else {
        errors.push("Manifest ZIP URL leaves the approved feed origin.");
      }
    }
  } catch (error) {
    errors.push(
      `Manifest request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (zipUrl && candidateZipBytes) {
  try {
    remoteZip = await fetchHashed(zipUrl, candidateZipBytes + 1, {
      accept: "application/zip, application/octet-stream",
    });
  } catch (error) {
    errors.push(
      `ZIP request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    remoteRange = await fetchHashed(zipUrl, 2, { range: "bytes=0-0" });
  } catch (error) {
    errors.push(
      `Range request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (blockmapUrl && candidateBlockmapBytes) {
  try {
    remoteBlockmap = await fetchHashed(
      blockmapUrl,
      candidateBlockmapBytes + 1,
      { accept: "application/octet-stream" },
    );
  } catch (error) {
    errors.push(
      `Blockmap request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const feedBaseUrl = resolveFeedBaseUrl(rawFeedUrl);
const channelManifests: Partial<Record<UpdateChannelName, ChannelManifestProbe>> = {};
for (const channel of UPDATE_CHANNELS) {
  const url = channelManifestUrl(feedBaseUrl, channel);
  if (!url) {
    channelManifests[channel] = { url: null, status: null, finalUrl: null };
    errors.push(`Could not resolve a ${channel} channel manifest URL.`);
    continue;
  }
  try {
    const probe = await fetchHashed(
      url,
      1024 * 1024,
      { accept: "application/yaml, text/yaml, text/plain" },
      true,
    );
    channelManifests[channel] = {
      url,
      status: probe.status,
      finalUrl: probe.finalUrl,
      manifest: parseMacUpdateManifest(probe.text ?? ""),
    };
    const result = evaluateChannelManifest(channel, channelManifests[channel], feedBaseUrl,
      RELEASE_CHANNEL_POLICY.stableReleaseExists);
    if (!result.pass) {
      errors.push(
        `The ${channel} channel manifest violates release policy: ${url} returned ${probe.status}, ${result.state}.`,
      );
    }
  } catch (error) {
    channelManifests[channel] = { url, status: null, finalUrl: null };
    errors.push(
      `The ${channel} channel manifest request failed (${url}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const channelStates = Object.fromEntries(UPDATE_CHANNELS.map((channel) => [channel,
  evaluateChannelManifest(channel, channelManifests[channel], feedBaseUrl, RELEASE_CHANNEL_POLICY.stableReleaseExists),
]));

const evidence: PublicUpdateFeedEvidence = {
  stableReleaseExists: RELEASE_CHANNEL_POLICY.stableReleaseExists,
  feedUrl: feedValidation.normalizedUrl ?? rawFeedUrl,
  feedBaseUrl,
  channelManifests,
  requestedManifest,
  credentialsUsed: false,
  packagedProvider: packagedUpdateConfig.provider,
  packagedFeedUrl: packagedUpdateConfig.url,
  packagedChannel: packagedUpdateConfig.channel,
  packagedUseMultipleRangeRequest:
    packagedUpdateConfig.useMultipleRangeRequest,
  manifestUrl,
  manifestFinalUrl: remoteManifest?.finalUrl ?? null,
  manifestStatus: remoteManifest?.status ?? null,
  remoteManifestSha256: remoteManifest?.sha256 ?? null,
  candidateManifestSha256,
  manifestVersion: parsedManifest.version,
  candidateVersion,
  manifestZipName: parsedManifest.zipName,
  candidateZipName: candidateZipPath ? path.basename(candidateZipPath) : null,
  manifestZipSha512: parsedManifest.sha512,
  candidateZipSha512,
  zipUrl,
  zipFinalUrl: remoteZip?.finalUrl ?? null,
  zipStatus: remoteZip?.status ?? null,
  remoteZipBytes: remoteZip?.bytes ?? null,
  candidateZipBytes,
  remoteZipSha256: remoteZip?.sha256 ?? null,
  candidateZipSha256,
  remoteZipSha512: remoteZip?.sha512 ?? null,
  blockmapUrl,
  blockmapFinalUrl: remoteBlockmap?.finalUrl ?? null,
  blockmapStatus: remoteBlockmap?.status ?? null,
  remoteBlockmapBytes: remoteBlockmap?.bytes ?? null,
  candidateBlockmapBytes,
  remoteBlockmapSha256: remoteBlockmap?.sha256 ?? null,
  candidateBlockmapSha256,
  rangeStatus: remoteRange?.status ?? null,
  rangeBytes: remoteRange?.bytes ?? null,
  contentRange: remoteRange?.contentRange ?? null,
};
const evaluation = evaluatePublicUpdateFeedEvidence(evidence);
const receipt = {
  schemaVersion: 2,
  generatedAt,
  channelPolicy: RELEASE_CHANNEL_POLICY,
  channelStates,
  methods: ["GET"],
  candidateIdentity,
  pass: evaluation.pass && errors.length === 0,
  status: evaluation.pass && errors.length === 0 ? "PASS" : "BLOCKED",
  access: "unauthenticated",
  credentials: "none",
  channel: "beta",
  requestedManifest,
  feedUrl: evidence.feedUrl,
  feedBaseUrl,
  channelManifests,
  manifestVersion: parsedManifest.version,
  candidateZipSha256,
  candidate: {
    path: candidatePath,
    appPath,
    appUpdatePath,
    updateConfig: packagedUpdateConfig,
    version: candidateVersion,
    manifestPath: candidateManifestPath,
    manifestSha256: candidateManifestSha256,
    zipPath: candidateZipPath,
    zipBytes: candidateZipBytes,
    zipSha256: candidateZipSha256,
    zipSha512: candidateZipSha512,
    blockmapPath: candidateBlockmapPath,
    blockmapBytes: candidateBlockmapBytes,
    blockmapSha256: candidateBlockmapSha256,
  },
  remote: {
    manifestUrl,
    manifestStatus: remoteManifest?.status ?? null,
    manifestBytes: remoteManifest?.bytes ?? null,
    manifestSha256: remoteManifest?.sha256 ?? null,
    zipUrl,
    zipStatus: remoteZip?.status ?? null,
    zipBytes: remoteZip?.bytes ?? null,
    zipSha256: remoteZip?.sha256 ?? null,
    zipSha512: remoteZip?.sha512 ?? null,
    blockmapUrl,
    blockmapStatus: remoteBlockmap?.status ?? null,
    blockmapBytes: remoteBlockmap?.bytes ?? null,
    blockmapSha256: remoteBlockmap?.sha256 ?? null,
    rangeStatus: remoteRange?.status ?? null,
    rangeBytes: remoteRange?.bytes ?? null,
    contentRange: remoteRange?.contentRange ?? null,
  },
  checks: evaluation.checks,
  errors,
};

writeReceipt(receipt);
process.exit(receipt.pass ? 0 : 1);
