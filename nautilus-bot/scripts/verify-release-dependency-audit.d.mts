export interface BraceExpansionLockEntry {
  key: string;
  version: string;
}

export interface DependencyAdvisory {
  id: number;
  url: string;
  severity?: string;
}

export interface ReleaseDependencyAuditReport {
  pass: boolean;
  checks: {
    auditCompleted: boolean;
    noUnexpectedAdvisories: boolean;
    auditMatchesInstalledState: boolean;
    rootBraceExpansionPatched: boolean;
    affectedCopiesLimitedToReviewedBuildTree: boolean;
    affectedCopiesExcludedFromPackagedApp: boolean;
  };
  acceptedException: boolean;
  counts: {
    advisories: number;
    unexpectedAdvisories: number;
    affectedLockEntries: number;
    unexpectedAffectedLockEntries: number;
    packagedExcludedModules: number;
  };
  affectedLockEntries: BraceExpansionLockEntry[];
  unexpectedAffectedLockEntries: BraceExpansionLockEntry[];
  packagedExcludedModules: string[];
}

export function parseBraceExpansionLockEntries(
  lockText: string,
): BraceExpansionLockEntry[];

export function evaluateReleaseDependencyAudit(options: {
  audit: Record<string, DependencyAdvisory[]>;
  lockEntries: BraceExpansionLockEntry[];
  packagedEntries: string[];
}): ReleaseDependencyAuditReport;
