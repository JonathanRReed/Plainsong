import { describe, expect, it } from "vitest";
import {
  evaluatePublicUpdateFeedEvidence,
  parseMacUpdateManifest,
  parsePackagedUpdateConfig,
  resolveFeedAssetUrl,
  validatePublicFeedUrl,
  type PublicUpdateFeedEvidence,
} from "../../scripts/lib/public-update-feed.mjs";

const VERSION = "0.9.0-beta.1";
const ZIP_NAME = `Plainsong-${VERSION}-arm64-mac.zip`;
const ZIP_SHA256 = "a".repeat(64);
const ZIP_SHA512 = "b".repeat(88);
const BLOCKMAP_SHA256 = "c".repeat(64);
const MANIFEST_SHA256 = "d".repeat(64);

function passingEvidence(): PublicUpdateFeedEvidence {
  return {
    feedUrl: "https://updates.plainsong.example/beta/",
    requestedManifest: "beta-mac.yml",
    credentialsUsed: false,
    packagedProvider: "generic",
    packagedFeedUrl: "https://updates.plainsong.example/beta/",
    packagedChannel: "beta",
    packagedUseMultipleRangeRequest: false,
    manifestUrl: "https://updates.plainsong.example/beta/beta-mac.yml",
    manifestFinalUrl: "https://updates.plainsong.example/beta/beta-mac.yml",
    manifestStatus: 200,
    remoteManifestSha256: MANIFEST_SHA256,
    candidateManifestSha256: MANIFEST_SHA256,
    manifestVersion: VERSION,
    candidateVersion: VERSION,
    manifestZipName: ZIP_NAME,
    candidateZipName: ZIP_NAME,
    manifestZipSha512: ZIP_SHA512,
    candidateZipSha512: ZIP_SHA512,
    zipUrl: `https://updates.plainsong.example/beta/${ZIP_NAME}`,
    zipFinalUrl: `https://updates.plainsong.example/beta/${ZIP_NAME}`,
    zipStatus: 200,
    remoteZipBytes: 142_706_076,
    candidateZipBytes: 142_706_076,
    remoteZipSha256: ZIP_SHA256,
    candidateZipSha256: ZIP_SHA256,
    remoteZipSha512: ZIP_SHA512,
    blockmapUrl: `https://updates.plainsong.example/beta/${ZIP_NAME}.blockmap`,
    blockmapFinalUrl: `https://updates.plainsong.example/beta/${ZIP_NAME}.blockmap`,
    blockmapStatus: 200,
    remoteBlockmapBytes: 150_000,
    candidateBlockmapBytes: 150_000,
    remoteBlockmapSha256: BLOCKMAP_SHA256,
    candidateBlockmapSha256: BLOCKMAP_SHA256,
    rangeStatus: 206,
    rangeBytes: 1,
    contentRange: "bytes 0-0/142706076",
  };
}

describe("public update feed evidence", () => {
  it("parses the beta manifest fields used by electron-updater", () => {
    expect(
      parseMacUpdateManifest(`version: ${VERSION}\nfiles:\n  - url: ${ZIP_NAME}\n    sha512: ${ZIP_SHA512}\n    size: 142706076\npath: ${ZIP_NAME}\nsha512: ${ZIP_SHA512}\n`),
    ).toEqual({
      version: VERSION,
      zipName: ZIP_NAME,
      sha512: ZIP_SHA512,
      size: 142_706_076,
    });
  });

  it("parses the packaged provider that the installed app will use", () => {
    expect(
      parsePackagedUpdateConfig(
        "provider: generic\nurl: https://updates.plainsong.example/beta/\nchannel: beta\nuseMultipleRangeRequest: false\n",
      ),
    ).toEqual({
      provider: "generic",
      url: "https://updates.plainsong.example/beta/",
      channel: "beta",
      useMultipleRangeRequest: false,
    });
  });

  it("accepts only credential-free public HTTPS feed bases", () => {
    expect(validatePublicFeedUrl("https://updates.plainsong.example/beta/")).toEqual({
      valid: true,
      normalizedUrl: "https://updates.plainsong.example/beta/",
      reason: null,
    });

    for (const invalid of [
      "http://updates.plainsong.example/beta/",
      "https://localhost/beta/",
      "https://127.0.0.1/beta/",
      "https://user:secret@updates.plainsong.example/beta/",
      "not a URL",
    ]) {
      expect(validatePublicFeedUrl(invalid).valid).toBe(false);
    }
  });

  it("resolves manifest assets only on the approved feed origin", () => {
    const feedUrl = "https://updates.plainsong.example/beta/";
    const manifestUrl = `${feedUrl}beta-mac.yml`;

    expect(resolveFeedAssetUrl(feedUrl, manifestUrl, ZIP_NAME)).toBe(
      `${feedUrl}${ZIP_NAME}`,
    );
    expect(
      resolveFeedAssetUrl(feedUrl, manifestUrl, "https://other.example/update.zip"),
    ).toBeNull();
    expect(
      resolveFeedAssetUrl(feedUrl, manifestUrl, "//other.example/update.zip"),
    ).toBeNull();
  });

  it("requires an exact candidate match plus byte-range support", () => {
    const result = evaluatePublicUpdateFeedEvidence(passingEvidence());

    expect(result.pass).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it("fails closed on changed bytes, redirects, credentials, or missing range support", () => {
    const evidence = passingEvidence();
    evidence.remoteZipSha256 = "e".repeat(64);
    evidence.manifestFinalUrl = "https://other.example/beta-mac.yml";
    evidence.credentialsUsed = true;
    evidence.packagedProvider = "github";
    evidence.packagedUseMultipleRangeRequest = null;
    evidence.rangeStatus = 200;
    evidence.contentRange = null;

    const result = evaluatePublicUpdateFeedEvidence(evidence);

    expect(result.pass).toBe(false);
    expect(result.checks.manifestRedirectAbsent).toBe(false);
    expect(result.checks.credentialsAbsent).toBe(false);
    expect(result.checks.packagedProviderIsGeneric).toBe(false);
    expect(result.checks.packagedUsesSingleRangeRequests).toBe(false);
    expect(result.checks.zipSha256MatchesCandidate).toBe(false);
    expect(result.checks.rangeRequestSupported).toBe(false);
  });
});
