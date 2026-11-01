export interface SidecarBuildReceipt {
  version: number;
  createdAt: string;
  profile: string;
  binaries: Record<string, { path: string; sha256: string }>;
}
export function sidecarBuildReceiptPath(repoRoot: string): string;
export function writeSidecarBuildReceipt(
  repoRoot: string,
  binaries: Map<string, string>,
  options?: { profile?: string },
): SidecarBuildReceipt;
export function verifySidecarBuildReceipt(
  repoRoot: string,
  packagedBinaries: Map<string, string>,
): SidecarBuildReceipt;
