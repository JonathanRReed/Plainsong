export interface DownloadHeaderOptions {
  includeHfToken?: boolean;
  token?: string;
}

export function downloadHeadersForUrl(
  url: string,
  options?: DownloadHeaderOptions,
): Record<string, string>;

export function unsafeArchiveMemberReason(
  memberName: string,
): string | null;

export interface BundleInspection {
  ok: boolean;
  detail?: string;
}

export function inspectBundleArchive(
  archivePath: string,
): BundleInspection;
