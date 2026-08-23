export interface PackagedComponentComparison {
  referenceUnsignedSha256: string;
  candidateUnsignedSha256: string;
  unsignedCodeIdentical: boolean;
}

export interface ComponentEquivalenceChecks {
  referenceAndCandidateAreDistinct: boolean;
  referenceTrustPass: boolean;
  candidateTrustPass: boolean;
  sameSigningTeam: boolean;
  sameBundleIdentifier: boolean;
  requiredComponentsPresent: boolean;
  requiredComponentsUnsignedCodeIdentical: boolean;
}

export interface ComponentEquivalenceArtifact {
  pass: boolean;
  identity: {
    referenceApp: string;
    candidateApp: string;
  };
  checks: ComponentEquivalenceChecks;
  components: Record<string, PackagedComponentComparison>;
}

export interface ExactCandidateComponentDigests {
  appAsar: string | null;
  sidecar: string | null;
  shortcutHelper: string | null;
  speechHelper: string | null;
}

export function evaluateComponentEquivalence(input: {
  referenceApp: string;
  candidateApp: string;
  referenceTrustPass: boolean;
  candidateTrustPass: boolean;
  sameSigningTeam: boolean;
  sameBundleIdentifier: boolean;
  components: Record<string, PackagedComponentComparison>;
}): {
  pass: boolean;
  checks: ComponentEquivalenceChecks;
};

export function evaluateCandidateEvidenceProvenance(input: {
  artifactAppPath: string | null;
  artifactSidecarPath: string | null;
  candidateAppPath: string | null;
  artifactComponents?: ExactCandidateComponentDigests | null;
  candidateComponents?: ExactCandidateComponentDigests | null;
  equivalence?: ComponentEquivalenceArtifact | null;
}): {
  valid: boolean;
  mode: string;
  summary: string;
};
