import path from "node:path";
import { collectAppBundleIdentity } from "./release-candidate-identity.ts";

export interface AppReceiptBinding {
  appPath: string;
  appBundleSha256: string | null;
}

interface BoundReceipt {
  candidateIdentity?: { appBundle?: { sha256?: unknown } | null } | null;
  candidateAppUnchanged?: unknown;
}

export function captureAppReceiptBinding(appPath: string): AppReceiptBinding {
  const resolvedPath = path.resolve(appPath);
  return {
    appPath: resolvedPath,
    appBundleSha256: collectAppBundleIdentity(resolvedPath)?.sha256 ?? null,
  };
}

export function appReceiptMatchesBinding(
  receipt: unknown,
  binding: Pick<AppReceiptBinding, "appBundleSha256">,
): boolean {
  const bound = receipt as BoundReceipt | null | undefined;
  return (
    typeof binding.appBundleSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(binding.appBundleSha256) &&
    bound?.candidateIdentity?.appBundle?.sha256 === binding.appBundleSha256 &&
    bound?.candidateAppUnchanged === true
  );
}

export function bindAppReceipt<T extends { pass: boolean; candidateIdentity?: object }>(
  artifact: T,
  binding: AppReceiptBinding,
): T & {
  candidateIdentity: { appBundle: { sha256: string | null } };
  candidateAppUnchanged: boolean;
} {
  let currentSha256: string | null = null;
  try {
    currentSha256 = collectAppBundleIdentity(binding.appPath)?.sha256 ?? null;
  } catch {
    // A failed final read cannot qualify a capture as an unchanged app.
  }
  const unchanged = typeof binding.appBundleSha256 === "string" &&
    binding.appBundleSha256 === currentSha256;
  return {
    ...artifact,
    pass: artifact.pass === true && unchanged,
    candidateIdentity: {
      ...artifact.candidateIdentity,
      appBundle: { sha256: binding.appBundleSha256 },
    },
    candidateAppUnchanged: unchanged,
  };
}
