import channelPolicy from "../../release-channel-policy.json";

export type ParsedMacUpdateManifest = {
  version: string | null;
  zipName: string | null;
  sha512: string | null;
  size: number | null;
};

export type PackagedUpdateConfig = {
  provider: string | null;
  url: string | null;
  channel: string | null;
  useMultipleRangeRequest: boolean | null;
};

export type PublicFeedUrlValidation = {
  valid: boolean;
  normalizedUrl: string | null;
  reason: string | null;
};

export type UpdateChannelName = "stable" | "beta";

export type ChannelManifestProbe = {
  url: string | null;
  status: number | null;
  finalUrl: string | null;
  manifest?: ParsedMacUpdateManifest;
};

export type PublicUpdateFeedEvidence = {
  stableReleaseExists: boolean;
  feedUrl: string;
  /** The feed origin+path with any trailing channel segment removed. */
  feedBaseUrl: string | null;
  /** One reachability probe per channel a running app can select. */
  channelManifests: Partial<Record<UpdateChannelName, ChannelManifestProbe>>;
  requestedManifest: string;
  credentialsUsed: boolean;
  packagedProvider: string | null;
  packagedFeedUrl: string | null;
  packagedChannel: string | null;
  packagedUseMultipleRangeRequest: boolean | null;
  manifestUrl: string | null;
  manifestFinalUrl: string | null;
  manifestStatus: number | null;
  remoteManifestSha256: string | null;
  candidateManifestSha256: string | null;
  manifestVersion: string | null;
  candidateVersion: string | null;
  manifestZipName: string | null;
  candidateZipName: string | null;
  manifestZipSha512: string | null;
  candidateZipSha512: string | null;
  zipUrl: string | null;
  zipFinalUrl: string | null;
  zipStatus: number | null;
  remoteZipBytes: number | null;
  candidateZipBytes: number | null;
  remoteZipSha256: string | null;
  candidateZipSha256: string | null;
  remoteZipSha512: string | null;
  blockmapUrl: string | null;
  blockmapFinalUrl: string | null;
  blockmapStatus: number | null;
  remoteBlockmapBytes: number | null;
  candidateBlockmapBytes: number | null;
  remoteBlockmapSha256: string | null;
  candidateBlockmapSha256: string | null;
  rangeStatus: number | null;
  rangeBytes: number | null;
  contentRange: string | null;
};

export type PublicUpdateFeedEvaluation = {
  pass: boolean;
  checks: Record<string, boolean>;
  feedValidation: PublicFeedUrlValidation;
};

/**
 * The channel manifest filename electron-updater requests, per channel.
 *
 * Mirrors `updaterChannelManifestFilename` in electron/updater-channel.ts,
 * which the app itself uses — a .mjs gate cannot import the TypeScript module,
 * so the rule is duplicated and the duplication is pinned by a unit test.
 * Stable maps to `latest`, not `stable`: electron-builder publishes no
 * `stable-mac.yml`.
 */
export const UPDATE_CHANNELS: UpdateChannelName[] = ["stable", "beta"];

export const RELEASE_CHANNEL_POLICY = channelPolicy;

export function evaluateChannelManifest(
  channel: UpdateChannelName,
  probe: ChannelManifestProbe | undefined,
  feedBaseUrl: string | null,
  stableReleaseExists: boolean,
): { pass: boolean; state: string } {
  const expectedUrl = channelManifestUrl(feedBaseUrl, channel);
  if (!probe || !expectedUrl || probe.url !== expectedUrl || probe.finalUrl !== expectedUrl) {
    return { pass: false, state: "missing-or-wrong-channel-url" };
  }
  if (channel === "stable" && !stableReleaseExists) {
    return probe.status === 404
      ? { pass: true, state: "expected-absent-before-first-stable-release" }
      : { pass: false, state: "unexpected-stable-response-before-first-stable-release" };
  }
  const manifest = probe.manifest;
  const versionPattern = channel === "stable"
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
  const valid = probe.status === 200 && manifest &&
    versionPattern.test(manifest.version ?? "") &&
    manifest.zipName === `Plainsong-${manifest.version}-arm64-mac.zip` &&
    /^[A-Za-z0-9+/]{86}==$/.test(manifest.sha512 ?? "") &&
    Number.isSafeInteger(manifest.size) && (manifest.size ?? 0) > 0;
  return { pass: Boolean(valid), state: valid ? "published" : "missing-or-invalid-channel-manifest" };
}

export function updaterChannelManifestFilename(
  channel: UpdateChannelName,
  platform: string = "darwin",
): string {
  const suffix = platform === "darwin" ? "-mac" : platform === "linux" ? "-linux" : "";
  const channelName = channel === "beta" ? "beta" : "latest";
  return `${channelName}${suffix}.yml`;
}

/**
 * The feed directory for `channel`, given the feed's base origin+path.
 *
 * Each channel has its OWN directory (/stable/, /beta/), so the two feeds
 * cannot be confused for each other even where their manifest names coincide.
 *
 * The base is normalized through {@link resolveFeedBaseUrl} first, so passing
 * a URL that already names a channel cannot produce `/beta/stable/`.
 */
export function channelFeedUrl(
  baseUrl: string | null,
  channel: UpdateChannelName,
): string | null {
  const base = resolveFeedBaseUrl(baseUrl ?? "");
  if (!base) return null;
  return new URL(`${channel}/`, base).href;
}

/** The full manifest URL a channel resolves to, or null for an unusable base. */
export function channelManifestUrl(
  baseUrl: string | null,
  channel: UpdateChannelName,
  platform: string = "darwin",
): string | null {
  const feedUrl = channelFeedUrl(baseUrl, channel);
  if (!feedUrl) return null;
  return new URL(updaterChannelManifestFilename(channel, platform), feedUrl).href;
}

/**
 * The base a per-channel feed URL was derived from: strip a trailing channel
 * segment if the URL already names one, so `--feed-url .../beta/` and
 * `--feed-url .../` both work.
 */
export function resolveFeedBaseUrl(feedUrl: string): string | null {
  const validation = validatePublicFeedUrl(feedUrl);
  if (!validation.valid) return null;
  // A valid validation always carries the normalized URL.
  const url = new URL(validation.normalizedUrl!);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  if (last && UPDATE_CHANNELS.includes(last as UpdateChannelName)) {
    url.pathname = `/${segments.slice(0, -1).join("/")}`;
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  }
  return url.href;
}

function scalarValue(text: string, key: string): string | null {
  const match = text.match(
    new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

function firstFileUrl(text: string): string | null {
  const match = text.match(/^\s*-\s+url:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return match?.[1]?.trim() ?? null;
}

function firstIndentedScalarValue(text: string, key: string): string | null {
  const match = text.match(
    new RegExp(`^\\s+${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

export function parseMacUpdateManifest(text: string): ParsedMacUpdateManifest {
  const sizeRaw =
    firstIndentedScalarValue(text, "size") ?? scalarValue(text, "size");
  const size = Number(sizeRaw);
  return {
    version: scalarValue(text, "version"),
    zipName: scalarValue(text, "path") ?? firstFileUrl(text),
    sha512:
      scalarValue(text, "sha512") ??
      firstIndentedScalarValue(text, "sha512"),
    size: sizeRaw && Number.isSafeInteger(size) && size > 0 ? size : null,
  };
}

export function parsePackagedUpdateConfig(text: string): PackagedUpdateConfig {
  const rangeRequestRaw = scalarValue(text, "useMultipleRangeRequest");
  return {
    provider: scalarValue(text, "provider"),
    url: scalarValue(text, "url"),
    channel: scalarValue(text, "channel"),
    useMultipleRangeRequest:
      rangeRequestRaw === "true"
        ? true
        : rangeRequestRaw === "false"
          ? false
          : null,
  };
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function validatePublicFeedUrl(rawUrl: string): PublicFeedUrlValidation {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      return { valid: false, normalizedUrl: null, reason: "https-required" };
    }
    if (url.username || url.password) {
      return { valid: false, normalizedUrl: null, reason: "credentials-forbidden" };
    }
    if (isLocalHostname(url.hostname)) {
      return { valid: false, normalizedUrl: null, reason: "public-host-required" };
    }
    if (url.search || url.hash) {
      return { valid: false, normalizedUrl: null, reason: "query-and-hash-forbidden" };
    }
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return { valid: true, normalizedUrl: url.href, reason: null };
  } catch {
    return { valid: false, normalizedUrl: null, reason: "invalid-url" };
  }
}

function sameOrigin(left: string | null, right: string): boolean {
  try {
    // A null URL throws here and falls through to false, as before.
    return new URL(left as string).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function resolveFeedAssetUrl(
  feedUrl: string,
  manifestUrl: string,
  assetName: string | null,
): string | null {
  const feedValidation = validatePublicFeedUrl(feedUrl);
  if (!feedValidation.valid || !assetName) return null;
  try {
    const manifest = new URL(manifestUrl);
    const asset = new URL(assetName, manifest);
    const feed = new URL(feedValidation.normalizedUrl!);
    if (
      manifest.protocol !== "https:" ||
      asset.protocol !== "https:" ||
      manifest.origin !== feed.origin ||
      asset.origin !== feed.origin ||
      asset.username ||
      asset.password
    ) {
      return null;
    }
    return asset.href;
  } catch {
    return null;
  }
}

export function evaluatePublicUpdateFeedEvidence(
  evidence: PublicUpdateFeedEvidence,
): PublicUpdateFeedEvaluation {
  const feedValidation = validatePublicFeedUrl(evidence.feedUrl);
  const packagedFeedValidation = validatePublicFeedUrl(
    evidence.packagedFeedUrl ?? "",
  );
  const expectedManifestUrl = feedValidation.valid
    ? new URL(evidence.requestedManifest, feedValidation.normalizedUrl!).href
    : null;
  const expectedContentRange = Number.isSafeInteger(evidence.candidateZipBytes)
    ? `bytes 0-0/${evidence.candidateZipBytes}`
    : null;
  const checks: Record<string, boolean> = {
    feedUrlIsPublicHttps: feedValidation.valid,
    credentialsAbsent: evidence.credentialsUsed === false,
    packagedProviderIsGeneric: evidence.packagedProvider === "generic",
    packagedChannelIsBeta: evidence.packagedChannel === "beta",
    packagedUsesSingleRangeRequests:
      evidence.packagedUseMultipleRangeRequest === false,
    packagedFeedUrlMatches:
      feedValidation.valid &&
      packagedFeedValidation.valid &&
      packagedFeedValidation.normalizedUrl === feedValidation.normalizedUrl,
    manifestUrlMatchesRequest:
      Boolean(expectedManifestUrl) && evidence.manifestUrl === expectedManifestUrl,
    manifestUrlUsesFeedOrigin:
      Boolean(expectedManifestUrl) &&
      sameOrigin(evidence.manifestUrl, evidence.feedUrl),
    manifestFetched: evidence.manifestStatus === 200,
    manifestRedirectAbsent:
      Boolean(evidence.manifestUrl) &&
      evidence.manifestFinalUrl === evidence.manifestUrl,
    manifestMatchesCandidate:
      Boolean(evidence.remoteManifestSha256) &&
      evidence.remoteManifestSha256 === evidence.candidateManifestSha256,
    manifestVersionMatchesCandidate:
      Boolean(evidence.manifestVersion) &&
      evidence.manifestVersion === evidence.candidateVersion,
    manifestZipNameMatchesCandidate:
      Boolean(evidence.manifestZipName) &&
      evidence.manifestZipName === evidence.candidateZipName,
    manifestZipSha512MatchesCandidate:
      Boolean(evidence.manifestZipSha512) &&
      evidence.manifestZipSha512 === evidence.candidateZipSha512,
    zipUrlUsesFeedOrigin:
      Boolean(evidence.zipUrl) && sameOrigin(evidence.zipUrl, evidence.feedUrl),
    zipFetched: evidence.zipStatus === 200,
    zipRedirectAbsent:
      Boolean(evidence.zipUrl) && evidence.zipFinalUrl === evidence.zipUrl,
    zipBytesMatchCandidate:
      Number.isSafeInteger(evidence.remoteZipBytes) &&
      evidence.remoteZipBytes === evidence.candidateZipBytes,
    zipSha256MatchesCandidate:
      Boolean(evidence.remoteZipSha256) &&
      evidence.remoteZipSha256 === evidence.candidateZipSha256,
    zipSha512MatchesCandidate:
      Boolean(evidence.remoteZipSha512) &&
      evidence.remoteZipSha512 === evidence.candidateZipSha512,
    blockmapUrlUsesFeedOrigin:
      Boolean(evidence.blockmapUrl) &&
      sameOrigin(evidence.blockmapUrl, evidence.feedUrl),
    blockmapFetched: evidence.blockmapStatus === 200,
    blockmapRedirectAbsent:
      Boolean(evidence.blockmapUrl) &&
      evidence.blockmapFinalUrl === evidence.blockmapUrl,
    blockmapBytesMatchCandidate:
      Number.isSafeInteger(evidence.remoteBlockmapBytes) &&
      evidence.remoteBlockmapBytes === evidence.candidateBlockmapBytes,
    blockmapSha256MatchesCandidate:
      Boolean(evidence.remoteBlockmapSha256) &&
      evidence.remoteBlockmapSha256 === evidence.candidateBlockmapSha256,
    rangeRequestSupported:
      evidence.rangeStatus === 206 &&
      evidence.rangeBytes === 1 &&
      Boolean(expectedContentRange) &&
      evidence.contentRange?.toLowerCase() === expectedContentRange!.toLowerCase(),
    ...Object.fromEntries(
      UPDATE_CHANNELS.map((channel) => [
        `${channel}ChannelManifestMatchesPolicy`,
        evaluateChannelManifest(channel, evidence.channelManifests[channel], evidence.feedBaseUrl,
          evidence.stableReleaseExists).pass,
      ]),
    ),
    ...Object.fromEntries(
      UPDATE_CHANNELS.map((channel) => [
        `${channel}ChannelManifestUsesOwnDirectory`,
        evidence.channelManifests?.[channel]?.url ===
          channelManifestUrl(evidence.feedBaseUrl, channel),
      ]),
    ),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    feedValidation,
  };
}
