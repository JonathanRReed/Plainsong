/**
 * Whether the running macOS bundle carries a signature Squirrel.Mac may
 * install an update over.
 *
 * The previous check ran `codesign -dv` — which only DISPLAYS the signature,
 * and succeeds for a broken or foreign one — and rejected exactly one string,
 * `Signature=adhoc`. So a bundle signed by anybody at all, or one whose seal is
 * broken because a file inside it was modified, passed straight into the ShipIt
 * update handoff: the updater would then replace the app in place on the
 * strength of a signature that proves nothing about who built it.
 *
 * Two things have to hold instead:
 *
 * 1. The signature actually verifies (`--verify --strict --deep`), so the seal
 *    covers the bundle as it is on disk right now, nested helpers included.
 * 2. The signature is OURS. `TeamIdentifier` is the field that says so; an
 *    ad-hoc signature has no team identifier at all, which is why the ad-hoc
 *    case no longer needs its own string match.
 */

/**
 * The Apple team the release builds are signed with (see
 * docs/APPLE_DEVELOPER_SETUP.md — the same value the macOS release trust gate
 * checks the packaged artifact against).
 *
 * Hard-coded deliberately: the point of the check is that the running app can
 * tell whether it is an official build, and a value it reads from its own
 * environment or bundle could be supplied by whoever repackaged it.
 */
export const PLAINSONG_RELEASE_TEAM_ID = "AJ9VWBRNZN";

/**
 * The `TeamIdentifier=` field of `codesign -dv --verbose=4` output.
 *
 * `codesign` writes its display output to stderr, so callers must pass both
 * streams. An ad-hoc signature reports `TeamIdentifier=not set`, which is not a
 * team identifier and is normalized to null here.
 */
export function parseCodesignTeamIdentifier(output: string): string | null {
  const match = output.match(/^TeamIdentifier=(.+)$/m);
  const value = match?.[1]?.trim();
  if (!value || value === "not set") {
    return null;
  }
  return value;
}

export type MacAppSignatureEvidence = {
  /** `codesign --verify --strict --deep` exited 0. */
  verified: boolean;
  /** Combined stdout+stderr of `codesign -dv --verbose=4`. */
  displayOutput: string;
  /** Defaults to the release team; overridable so tests can be explicit. */
  expectedTeamId?: string;
};

/**
 * Whether the updater may hand this bundle to ShipIt.
 *
 * Fails closed: an unverifiable signature, a missing team identifier (ad-hoc,
 * which is what electron-builder applies on arm64 with no identity available),
 * or a team that is not ours all mean "download the new version by hand
 * instead", not "install over it".
 */
export function macAppSignatureIsUpdatable(
  evidence: MacAppSignatureEvidence,
): boolean {
  if (!evidence.verified) {
    return false;
  }
  const teamId = parseCodesignTeamIdentifier(evidence.displayOutput);
  if (!teamId) {
    return false;
  }
  return teamId === (evidence.expectedTeamId ?? PLAINSONG_RELEASE_TEAM_ID);
}
