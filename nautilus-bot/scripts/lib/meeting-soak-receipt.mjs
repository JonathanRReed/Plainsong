const CAPTURED_TEXT_KEYS = new Set([
  "text",
  "fullText",
  "full_text",
  "transcriptText",
  "transcript_text",
]);

function isCapturedTextKey(key) {
  if (key === "speakFixtureText") return false;
  const normalized = key.replaceAll("_", "").toLocaleLowerCase("en-US");
  return (
    CAPTURED_TEXT_KEYS.has(key) ||
    normalized.endsWith("text") ||
    normalized.endsWith("transcript") ||
    normalized.endsWith("notes") ||
    normalized.endsWith("title") ||
    normalized === "summary" ||
    normalized === "actionitems"
  );
}

function cloneAndRedactCapturedText(value) {
  if (Array.isArray(value)) {
    return value.map(cloneAndRedactCapturedText);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isCapturedTextKey(key) && typeof entry === "string") {
      redacted[`${key}Length`] = entry.length;
      redacted[`${key}Redacted`] = true;
      continue;
    }
    redacted[key] = cloneAndRedactCapturedText(entry);
  }
  return redacted;
}

export function sanitizeMeetingSoakReceipt(artifact) {
  if (!artifact || typeof artifact !== "object") {
    throw new TypeError("Meeting soak receipt must be an object.");
  }
  const fullText =
    typeof artifact.transcript?.fullText === "string"
      ? artifact.transcript.fullText
      : typeof artifact.transcript?.full_text === "string"
        ? artifact.transcript.full_text
        : "";
  const transcriptCharacters =
    fullText.length > 0
      ? fullText.length
      : Number(artifact.transcriptEvidence?.characters ?? 0);
  const segmentCount = Array.isArray(artifact.transcript?.segments)
    ? artifact.transcript.segments.length
    : Number(artifact.transcriptEvidence?.segmentCount ?? 0);
  const transcriptTokenCount = Array.isArray(
    artifact.fixtureTranscriptMatch?.transcriptTokens,
  )
    ? artifact.fixtureTranscriptMatch.transcriptTokens.length
    : Number(artifact.fixtureTranscriptMatch?.transcriptTokenCount ?? 0);
  const stderrTail =
    typeof artifact.stderr?.tail === "string" ? artifact.stderr.tail : "";
  const stderrTailLength =
    stderrTail.length > 0
      ? stderrTail.length
      : Number(artifact.stderr?.tailLength ?? 0);

  const sanitized = cloneAndRedactCapturedText(artifact);
  sanitized.contentRedacted = true;
  sanitized.transcriptEvidence = {
    characters: transcriptCharacters,
    segmentCount,
    contentRedacted: true,
  };

  if (sanitized.fixtureTranscriptMatch) {
    delete sanitized.fixtureTranscriptMatch.transcriptTokens;
    sanitized.fixtureTranscriptMatch.transcriptTokenCount =
      transcriptTokenCount;
    sanitized.fixtureTranscriptMatch.transcriptTokensRedacted = true;
  }

  if (sanitized.stderr) {
    delete sanitized.stderr.tail;
    sanitized.stderr.tailLength = stderrTailLength;
    sanitized.stderr.tailRedacted = true;
  }

  return sanitized;
}
