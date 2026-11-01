// Exact catalog IDs, pinned in asr/parakeet.rs and asr/transcribe_cpp.rs.
const parakeetModels = {
  parakeet: ["parakeet-tdt-0.6b-v3", "parakeet-tdt-0.6b-v2", "parakeet-tdt-ctc-110m"],
  transcribe_cpp: ["parakeet-tdt-0.6b-v3-q8_0", "parakeet-unified-en-0.6b-q8_0"],
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}

function completeDuration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 3 * 60 * 60 * 1000;
}

export function meetingSoakReceiptQualifies(receipt: unknown, candidateSidecarSha256: string | null): boolean {
  const artifact = object(receipt);
  const transcript = object(artifact?.transcriptDetails);
  const provider = transcript?.actualProvider;
  const model = transcript?.modelId;
  const parakeetRoute = (provider === "parakeet" || provider === "transcribe_cpp") &&
    transcript?.requestedProvider === provider &&
    typeof model === "string" && parakeetModels[provider].includes(model);
  const checks = Object.values(object(artifact?.checks) ?? {});
  return artifact?.pass === true &&
    completeDuration(artifact.recordMs) && completeDuration(artifact.minRecordMs) &&
    completeDuration(artifact.recordingDurationMs) && artifact.includeSystemAudio === true &&
    artifact.expectedCaptureMode === "me_and_them" &&
    object(artifact.transcriptWait)?.timedOut === false &&
    object(artifact.fixtureTranscriptMatch)?.matched === true && parakeetRoute &&
    checks.length > 0 && checks.every((check) => check === true) &&
    typeof candidateSidecarSha256 === "string" && /^[a-f0-9]{64}$/.test(candidateSidecarSha256) &&
    artifact.sidecarSha256 === candidateSidecarSha256;
}
