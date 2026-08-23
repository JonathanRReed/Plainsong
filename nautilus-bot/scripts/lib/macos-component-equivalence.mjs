const REQUIRED_APP_MATRIX_COMPONENTS = [
  "sidecar",
  "shortcutHelper",
  "speechHelper",
];
const REQUIRED_EXACT_CANDIDATE_COMPONENTS = [
  "appAsar",
  ...REQUIRED_APP_MATRIX_COMPONENTS,
];

export function evaluateComponentEquivalence({
  referenceApp,
  candidateApp,
  referenceTrustPass,
  candidateTrustPass,
  sameSigningTeam,
  sameBundleIdentifier,
  components,
}) {
  const componentEntries = REQUIRED_APP_MATRIX_COMPONENTS.map(
    (name) => components?.[name],
  );
  const checks = {
    referenceAndCandidateAreDistinct:
      Boolean(referenceApp) &&
      Boolean(candidateApp) &&
      referenceApp !== candidateApp,
    referenceTrustPass: referenceTrustPass === true,
    candidateTrustPass: candidateTrustPass === true,
    sameSigningTeam: sameSigningTeam === true,
    sameBundleIdentifier: sameBundleIdentifier === true,
    requiredComponentsPresent: componentEntries.every(Boolean),
    requiredComponentsUnsignedCodeIdentical: componentEntries.every(
      (component) =>
        component?.unsignedCodeIdentical === true &&
        Boolean(component?.referenceUnsignedSha256) &&
        component.referenceUnsignedSha256 === component.candidateUnsignedSha256,
    ),
  };

  return {
    pass: Object.values(checks).every(Boolean),
    checks,
  };
}

export function evaluateCandidateEvidenceProvenance({
  artifactAppPath,
  artifactSidecarPath,
  candidateAppPath,
  artifactComponents,
  candidateComponents,
  equivalence,
}) {
  if (!candidateAppPath) {
    return {
      valid: true,
      mode: "unbound",
      summary:
        "No exact candidate was requested, so this preflight validates only the linked capture.",
    };
  }

  const expectedArtifactSidecar = artifactAppPath
    ? `${artifactAppPath}/Contents/Resources/sidecar/plainsong-sidecar`
    : null;
  if (
    !artifactAppPath ||
    !artifactSidecarPath ||
    artifactSidecarPath !== expectedArtifactSidecar
  ) {
    return {
      valid: false,
      mode: "invalid-component-binding",
      summary:
        "The insertion artifact is not bound to the packaged sidecar inside its recorded app bundle.",
    };
  }

  if (artifactAppPath === candidateAppPath) {
    const exactComponentsMatch = REQUIRED_EXACT_CANDIDATE_COMPONENTS.every(
      (name) =>
        /^[a-f0-9]{64}$/i.test(artifactComponents?.[name] ?? "") &&
        artifactComponents[name] === candidateComponents?.[name],
    );
    return {
      valid: exactComponentsMatch,
      mode: exactComponentsMatch
        ? "exact-candidate-components"
        : "stale-same-path-evidence",
      summary: exactComponentsMatch
        ? "The insertion capture is bound to the requested candidate's app archive and packaged helper bytes."
        : "The insertion capture names the candidate path, but its recorded app archive or helper hashes do not match the current bundle at that path.",
    };
  }

  const validTransfer =
    equivalence?.pass === true &&
    equivalence?.identity?.referenceApp === artifactAppPath &&
    equivalence?.identity?.candidateApp === candidateAppPath &&
    equivalence?.checks?.referenceTrustPass === true &&
    equivalence?.checks?.candidateTrustPass === true &&
    equivalence?.checks?.sameSigningTeam === true &&
    equivalence?.checks?.sameBundleIdentifier === true &&
    equivalence?.components?.sidecar?.unsignedCodeIdentical === true;

  return {
    valid: validTransfer,
    mode: validTransfer
      ? "verified-unsigned-component-equivalence"
      : "candidate-mismatch",
    summary: validTransfer
      ? "The capture used a different signed bundle, but the exact candidate has the same trusted bundle identity and byte-identical unsigned sidecar code."
      : "The insertion capture used a different app bundle and no valid component-equivalence receipt binds it to the requested candidate.",
  };
}
