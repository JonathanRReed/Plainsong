import path from "node:path";
import { collectAppBundleIdentity } from "./release-candidate-identity.ts";

/** Accept current trust-gate receipts and the original version/hash receipt format. */
export function updaterTrustReceiptMatches(
  receipt: unknown,
  version: string | null,
  artifactSha256: string | null,
  appPath: string | null,
  artifactPath: string | null,
): boolean {
  if (!receipt || typeof receipt !== "object" || !("pass" in receipt) || receipt.pass !== true ||
      !version || !artifactSha256) return false;
  if (!("candidateIdentity" in receipt) && "packageVersion" in receipt && "artifactSha256" in receipt) {
    return receipt.packageVersion === version && receipt.artifactSha256 === artifactSha256;
  }
  if (!appPath || !artifactPath || !("candidateIdentity" in receipt)) return false;
  const identity = receipt.candidateIdentity;
  if (!identity || typeof identity !== "object" || !("complete" in identity) || identity.complete !== true ||
      !("artifacts" in identity) || !Array.isArray(identity.artifacts) || !("appBundle" in identity)) return false;
  const bundle = identity.appBundle;
  if (!bundle || typeof bundle !== "object" || !("sha256" in bundle) ||
      bundle.sha256 !== collectAppBundleIdentity(appPath)?.sha256) return false;
  return identity.artifacts.some((entry: unknown) => entry && typeof entry === "object" &&
    "name" in entry && entry.name === path.basename(artifactPath) &&
    "sha256" in entry && entry.sha256 === artifactSha256);
}
