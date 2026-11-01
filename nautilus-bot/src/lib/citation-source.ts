export interface CitationSource {
  text: string;
  sourceKind?: string | null;
  recordingId?: string | null;
  segmentId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
}

export function isCurrentWrittenNoteCitation(
  citation: CitationSource,
  recordingId: string | undefined,
  notes: string | null | undefined,
): boolean {
  if (citation.sourceKind !== "meeting_note" || !recordingId ||
      citation.recordingId !== recordingId || citation.startTime != null || citation.endTime != null) {
    return false;
  }
  const match = /^meeting-note:(0|[1-9]\d*)$/.exec(citation.segmentId ?? "");
  if (!match) return false;
  const line = (notes ?? "").split("\n")[Number(match[1])];
  return typeof line === "string" && citation.text.length > 0 && line.trim() === citation.text;
}
