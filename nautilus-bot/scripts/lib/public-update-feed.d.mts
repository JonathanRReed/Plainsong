export type ParsedMacUpdateManifest = {
  version: string | null;
  zipName: string | null;
  sha512: string | null;
  size: number | null;
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
};

export type PublicUpdateFeedEvidence = {
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

export function parseMacUpdateManifest(text: string): ParsedMacUpdateManifest;
export function parsePackagedUpdateConfig(text: string): {
  provider: string | null;
  url: string | null;
  channel: string | null;
  useMultipleRangeRequest: boolean | null;
};
export function resolveFeedAssetUrl(
  feedUrl: string,
  manifestUrl: string,
  assetName: string | null,
): string | null;
export function validatePublicFeedUrl(rawUrl: string): PublicFeedUrlValidation;
export const UPDATE_CHANNELS: UpdateChannelName[];
export function updaterChannelManifestFilename(
  channel: UpdateChannelName,
  platform?: string,
): string;
export function channelFeedUrl(
  baseUrl: string | null,
  channel: UpdateChannelName,
): string | null;
export function channelManifestUrl(
  baseUrl: string | null,
  channel: UpdateChannelName,
  platform?: string,
): string | null;
export function resolveFeedBaseUrl(feedUrl: string): string | null;
export function evaluatePublicUpdateFeedEvidence(
  evidence: PublicUpdateFeedEvidence,
): {
  pass: boolean;
  checks: Record<string, boolean>;
  feedValidation: PublicFeedUrlValidation;
};
