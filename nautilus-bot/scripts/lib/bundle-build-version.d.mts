/**
 * The numeric CFBundleVersion for a semantic version.
 *
 * Throws for a version, prerelease tag, or prerelease sequence the encoding
 * cannot order.
 */
export function encodeBundleBuildVersion(version: string): number;
