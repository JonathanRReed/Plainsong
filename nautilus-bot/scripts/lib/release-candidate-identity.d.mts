export interface ReleaseCandidateFileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseCandidateIdentity {
  schemaVersion: 1;
  complete: boolean;
  missing: string[];
  appComponents: ReleaseCandidateFileIdentity[];
  artifacts: ReleaseCandidateFileIdentity[];
  appComponentsSha256: string;
  releaseSha256: string;
}

export function collectReleaseCandidateIdentity(input: {
  candidatePath: string;
  appPath: string;
}): ReleaseCandidateIdentity;
