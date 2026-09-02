export interface NoticesComparisonInput {
  /** Notices regenerated from the current dependency graph. */
  current: string;
  /** Committed THIRD-PARTY-NOTICES.txt contents, or null when missing. */
  source: string | null;
  /** Packaged Contents/Resources/THIRD-PARTY-NOTICES.txt contents, or null when missing. */
  packaged: string | null;
  sourcePath: string;
  packagedPath: string;
}

export function compareNoticesToCurrent(input: NoticesComparisonInput): string[];
