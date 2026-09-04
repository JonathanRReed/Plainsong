/**
 * CFBundleVersion, derived from the semantic version.
 *
 * electron-builder defaults `buildVersion` to `version`, so a prerelease shipped
 * CFBundleVersion="0.9.0-beta.2". Apple defines that key as one to three
 * period-separated INTEGERS: a value with a hyphen and a word in it is not a
 * build number, it is a string macOS has no ordering for, and anything that
 * compares builds (installer downgrade checks, crash-report grouping, MDM
 * inventory) either fails or falls back to string comparison. CFBundleVersion
 * has to be numeric and monotonic; the semantic version stays where it belongs,
 * in CFBundleShortVersionString.
 *
 * The encoding packs the whole version into one integer:
 *
 *     major * 10_000_000 + minor * 100_000 + patch * 1_000 + prereleaseOffset
 *
 * where prereleaseOffset ranks a prerelease BELOW the release it precedes:
 * alpha.N → N, beta.N → 300 + N, rc.N → 600 + N, and a final release → 999.
 * So 0.9.0-beta.2 is 900302 and the 0.9.0 release that follows it is 900999,
 * which is larger — the property every downstream comparison depends on.
 *
 * Applied by hand in electron-builder.yml, which is static YAML, and pinned to
 * package.json by a unit test so a version bump that forgets it fails there
 * rather than in a shipped bundle.
 */

const PRERELEASE_RANK = { alpha: 0, beta: 1, rc: 2 };
const RELEASE_OFFSET = 999;
const RANK_STRIDE = 300;

/**
 * @param {string} version A semantic version, optionally `v`-prefixed.
 * @returns {number} The CFBundleVersion integer for `version`.
 * @throws If the version, its prerelease tag, or its prerelease number is not
 *   one this encoding can order. Failing loudly is deliberate: a silently
 *   wrong build number is worse than a build that does not start.
 */
export function encodeBundleBuildVersion(version) {
  const match = String(version)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    throw new Error(`Not a semantic version: ${version}`);
  }
  const [, major, minor, patch, prerelease] = match;
  const numeric = [major, minor, patch].map(Number);
  if (numeric.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`Version components must be non-negative integers: ${version}`);
  }
  if (numeric[1] > 99 || numeric[2] > 99) {
    // Beyond this the packed fields would collide with the next one up.
    throw new Error(`Minor and patch must be below 100 to encode: ${version}`);
  }

  return (
    numeric[0] * 10_000_000 +
    numeric[1] * 100_000 +
    numeric[2] * 1_000 +
    prereleaseOffset(prerelease, version)
  );
}

function prereleaseOffset(prerelease, version) {
  if (!prerelease) {
    return RELEASE_OFFSET;
  }
  const identifiers = prerelease.split(".");
  const [tag, number] = identifiers;
  const rank = PRERELEASE_RANK[tag];
  if (rank === undefined) {
    throw new Error(
      `Unrankable prerelease tag "${tag}" in ${version}; ` +
        `expected one of ${Object.keys(PRERELEASE_RANK).join(", ")}`,
    );
  }
  if (identifiers.length !== 2 || !/^(?:0|[1-9]\d*)$/.test(number ?? "")) {
    throw new Error(
      `Prerelease must contain exactly a tag and numeric sequence in ${version}`,
    );
  }
  const sequence = Number(number);
  if (!Number.isSafeInteger(sequence) || sequence >= RANK_STRIDE) {
    throw new Error(
      `Prerelease sequence must be an integer below ${RANK_STRIDE} in ${version}`,
    );
  }
  return rank * RANK_STRIDE + sequence;
}
