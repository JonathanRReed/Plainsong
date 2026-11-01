import type { TranscriptSegment } from "@/types";

export function transcriptNavigationEnd(segments: readonly TranscriptSegment[]) {
  return segments.reduce((latest, segment) => {
    if (!Number.isFinite(segment.startTime) || segment.startTime < 0) return latest;
    const end = Number.isFinite(segment.endTime) && segment.endTime >= segment.startTime
      ? segment.endTime : segment.startTime;
    return Math.max(latest, end);
  }, 0);
}

export function transcriptSections(segments: readonly TranscriptSegment[], speakerId = "") {
  const sections = new Map<number, TranscriptSegment[]>();
  for (const segment of segments.filter(segment => Number.isFinite(segment.startTime) && segment.startTime >= 0).sort((a, b) => a.startTime - b.startTime)) {
    if (speakerId && segment.speakerId !== speakerId) continue;
    const interval = Math.floor(segment.startTime / 300);
    const section = sections.get(interval) ?? [];
    section.push(segment);
    sections.set(interval, section);
  }
  return [...sections.entries()].map(([interval, turns]) => ({
    interval, first: turns[0], count: turns.length,
    speakers: [...new Set(turns.map(turn => turn.speakerId).filter((id): id is string => Boolean(id)))],
  }));
}

export function parseTranscriptTime(value: string): number | null {
  const text = value.trim();
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(text)) return null;
  const parts = text.split(":").map(Number);
  if (parts[parts.length - 1] >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  const time = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return Number.isSafeInteger(time) ? time : null;
}

export function transcriptSegmentAt(segments: readonly TranscriptSegment[], time: number) {
  const ordered = [...segments].filter(segment => Number.isFinite(segment.startTime) && segment.startTime >= 0).sort((a, b) => a.startTime - b.startTime);
  return ordered.find((segment, index) => {
    const hasEnd = Number.isFinite(segment.endTime) && segment.endTime > segment.startTime;
    if (hasEnd) return segment.endTime > time;
    // A missing end bounds reading selection only, not the saved audio time.
    const next = ordered[index + 1];
    return !next || next.startTime > time;
  }) ?? ordered[ordered.length - 1];
}

export function transcriptTimeLabel(time: number) {
  return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
}
