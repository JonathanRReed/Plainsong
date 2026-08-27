import { describe, expect, it } from "vitest";
import {
  channelFeedUrl,
  channelManifestUrl,
  evaluatePublicUpdateFeedEvidence,
  parseMacUpdateManifest,
  parsePackagedUpdateConfig,
  resolveFeedAssetUrl,
  resolveFeedBaseUrl,
  UPDATE_CHANNELS,
  updaterChannelManifestFilename,
  validatePublicFeedUrl,
  type PublicUpdateFeedEvidence,
} from "../../scripts/lib/public-update-feed.mjs";
import {
  updaterChannelManifestFilename as appUpdaterChannelManifestFilename,
  updaterFeedUrl,
} from "../../electron/updater-channel";

const VERSION = "0.9.0-beta.2";
const ZIP_NAME = `Plainsong-${VERSION}-arm64-mac.zip`;
const ZIP_SHA256 = "a".repeat(64);
const ZIP_SHA512 = "b".repeat(88);
const BLOCKMAP_SHA256 = "c".repeat(64);
const MANIFEST_SHA256 = "d".repeat(64);

function passingEvidence(): PublicUpdateFeedEvidence {
  return {
    feedUrl: "https://updates.plainsong.example/beta/",
    feedBaseUrl: "https://updates.plainsong.example/",
    channelManifests: {
      stable: {
        url: "https://updates.plainsong.example/stable/latest-mac.yml",
        status: 200,
        finalUrl: "https://updates.plainsong.example/stable/latest-mac.yml",
      },
      beta: {
        url: "https://updates.plainsong.example/beta/beta-mac.yml",
        status: 200,
        finalUrl: "https://updates.plainsong.example/beta/beta-mac.yml",
      },
    },
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

describe("per-channel update feeds", () => {
  it("gives each channel its own directory", () => {
    // The packaged app-update.yml can only name one feed. The app derives the
    // directory from the channel at runtime instead, so a stable install never
    // reads a manifest out of the beta bucket.
    const base = "https://updates.plainsong.example/";
    expect(channelFeedUrl(base, "stable")).toBe(
      "https://updates.plainsong.example/stable/",
    );
    expect(channelFeedUrl(base, "beta")).toBe(
      "https://updates.plainsong.example/beta/",
    );
    // A base that already names a channel must not compound into /beta/stable/.
    expect(channelFeedUrl("https://updates.plainsong.example/beta/", "stable")).toBe(
      "https://updates.plainsong.example/stable/",
    );
    expect(channelFeedUrl(null, "stable")).toBeNull();
  });

  it("resolves the manifest electron-updater actually requests", () => {
    // Stable maps to `latest`, not `stable`: electron-builder publishes no
    // stable-mac.yml, so requesting one 404s with no fallback.
    expect(updaterChannelManifestFilename("stable")).toBe("latest-mac.yml");
    expect(updaterChannelManifestFilename("beta")).toBe("beta-mac.yml");
    expect(
      channelManifestUrl("https://updates.plainsong.example/", "stable"),
    ).toBe("https://updates.plainsong.example/stable/latest-mac.yml");
    expect(channelManifestUrl("https://updates.plainsong.example/", "beta")).toBe(
      "https://updates.plainsong.example/beta/beta-mac.yml",
    );
  });

  it("mirrors the rule the shipped app uses", () => {
    // The gate is a .mjs script and cannot import the TypeScript module, so the
    // duplication is pinned here rather than left to drift.
    for (const channel of UPDATE_CHANNELS) {
      expect(updaterChannelManifestFilename(channel, "darwin")).toBe(
        appUpdaterChannelManifestFilename(channel, "darwin"),
      );
      expect(channelFeedUrl("https://updates.plainsong.jonathanrreed.com/", channel)).toBe(
        updaterFeedUrl(channel),
      );
    }
  });

  it("accepts a feed URL that already names a channel", () => {
    expect(resolveFeedBaseUrl("https://updates.plainsong.example/beta/")).toBe(
      "https://updates.plainsong.example/",
    );
    expect(resolveFeedBaseUrl("https://updates.plainsong.example/stable/")).toBe(
      "https://updates.plainsong.example/",
    );
    expect(resolveFeedBaseUrl("https://updates.plainsong.example/")).toBe(
      "https://updates.plainsong.example/",
    );
    expect(resolveFeedBaseUrl("http://updates.plainsong.example/beta/")).toBeNull();
  });

  it("blocks when either channel's manifest is unpublished", () => {
    // The first stable release would otherwise have shipped with an empty
    // stable feed and every stable check failing.
    const evidence = passingEvidence();
    evidence.channelManifests.stable = {
      url: "https://updates.plainsong.example/stable/latest-mac.yml",
      status: 404,
      finalUrl: null,
    };

    const result = evaluatePublicUpdateFeedEvidence(evidence);
    expect(result.pass).toBe(false);
    expect(result.checks.stableChannelManifestReachable).toBe(false);
    expect(result.checks.betaChannelManifestReachable).toBe(true);
  });

  it("blocks when a channel is probed against the wrong directory", () => {
    const evidence = passingEvidence();
    // The exact confusion the finding describes: stable's manifest fetched out
    // of the beta bucket.
    evidence.channelManifests.stable = {
      url: "https://updates.plainsong.example/beta/latest-mac.yml",
      status: 200,
      finalUrl: "https://updates.plainsong.example/beta/latest-mac.yml",
    };

    const result = evaluatePublicUpdateFeedEvidence(evidence);
    expect(result.pass).toBe(false);
    expect(result.checks.stableChannelManifestReachable).toBe(true);
    expect(result.checks.stableChannelManifestUsesOwnDirectory).toBe(false);
  });

  it("blocks when a channel was never probed at all", () => {
    const evidence = passingEvidence();
    evidence.channelManifests = {};

    const result = evaluatePublicUpdateFeedEvidence(evidence);
    expect(result.pass).toBe(false);
    expect(result.checks.stableChannelManifestReachable).toBe(false);
    expect(result.checks.betaChannelManifestReachable).toBe(false);
  });
});
