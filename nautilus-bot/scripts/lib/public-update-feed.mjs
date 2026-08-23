function scalarValue(text, key) {
  const match = text.match(
    new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

function firstFileUrl(text) {
  const match = text.match(/^\s*-\s+url:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return match?.[1]?.trim() ?? null;
}

function firstIndentedScalarValue(text, key) {
  const match = text.match(
    new RegExp(`^\\s+${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? null;
}

export function parseMacUpdateManifest(text) {
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

export function parsePackagedUpdateConfig(text) {
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

function isLocalHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function validatePublicFeedUrl(rawUrl) {
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

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function resolveFeedAssetUrl(feedUrl, manifestUrl, assetName) {
  const feedValidation = validatePublicFeedUrl(feedUrl);
  if (!feedValidation.valid || !assetName) return null;
  try {
    const manifest = new URL(manifestUrl);
    const asset = new URL(assetName, manifest);
    const feed = new URL(feedValidation.normalizedUrl);
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

export function evaluatePublicUpdateFeedEvidence(evidence) {
  const feedValidation = validatePublicFeedUrl(evidence.feedUrl);
  const packagedFeedValidation = validatePublicFeedUrl(
    evidence.packagedFeedUrl ?? "",
  );
  const expectedManifestUrl = feedValidation.valid
    ? new URL(evidence.requestedManifest, feedValidation.normalizedUrl).href
    : null;
  const expectedContentRange = Number.isSafeInteger(evidence.candidateZipBytes)
    ? `bytes 0-0/${evidence.candidateZipBytes}`
    : null;
  const checks = {
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
      evidence.contentRange?.toLowerCase() === expectedContentRange.toLowerCase(),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    feedValidation,
  };
}
