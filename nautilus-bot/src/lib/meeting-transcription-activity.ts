export const MEETING_TRANSCRIPTION_PROGRESS_EVENT = "recording-transcription-progress";

export interface MeetingTranscriptionActivity {
  recordingId: string | null;
  active: boolean;
  stage: string;
  receivedAt: number | null;
  statusAt: number | null;
}

export function emptyMeetingTranscriptionActivity(recordingId: string | null, active: boolean): MeetingTranscriptionActivity {
  return { recordingId, active, stage: "Processing transcript", receivedAt: null, statusAt: null };
}

export function scopeMeetingTranscriptionActivity(current: MeetingTranscriptionActivity, recordingId: string | null, active: boolean): MeetingTranscriptionActivity {
  if (current.recordingId !== recordingId) return emptyMeetingTranscriptionActivity(recordingId, active);
  if (!active || !current.active) return { ...emptyMeetingTranscriptionActivity(recordingId, active), statusAt: current.statusAt };
  return current;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
}

export function reduceMeetingTranscriptionProgress(current: MeetingTranscriptionActivity, payload: unknown, receivedAt: number): MeetingTranscriptionActivity {
  const event = payloadRecord(payload);
  if (!current.active || !current.recordingId || event?.recordingId !== current.recordingId || !Number.isFinite(receivedAt)) return current;
  const index = event.chunkIndex;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0
    || typeof event.progress !== "number" || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1
    || (event.stage !== undefined && event.stage !== "chunk_started")) return current;
  return { ...current, stage: event.stage === "chunk_started" ? "Transcribing an audio segment" : "Processing transcript", receivedAt };
}

export function reduceMeetingTranscriptionStatus(current: MeetingTranscriptionActivity, payload: unknown, receivedAt: number): MeetingTranscriptionActivity {
  const event = payloadRecord(payload);
  if (!current.recordingId || event?.recordingId !== current.recordingId || !Number.isFinite(receivedAt)) return current;
  const parsed = typeof event.updatedAt === "string" ? Date.parse(event.updatedAt) : NaN;
  const statusAt = Number.isFinite(parsed) ? parsed : null;
  if (statusAt !== null && current.statusAt !== null && statusAt < current.statusAt) return current;
  if (event.status === "processing") {
    const message = typeof event.message === "string" ? event.message.trim() : "";
    return { ...current, active: true, stage: message && !message.includes("%") ? message.slice(0, 240) : "Processing transcript", receivedAt, statusAt: statusAt ?? current.statusAt };
  }
  if (["completed", "pending", "error", "cancelled", "recording"].includes(event.status as string)) {
    return { ...emptyMeetingTranscriptionActivity(current.recordingId, false), statusAt: statusAt ?? current.statusAt };
  }
  return current;
}

export function describeMeetingTranscriptionActivity(activity: MeetingTranscriptionActivity, now: number): string {
  if (activity.receivedAt === null) return "Waiting for a transcription update.";
  const seconds = Math.max(0, Math.floor((now - activity.receivedAt) / 1000));
  if (seconds === 0) return "Last update just now.";
  const amount = seconds >= 3600 ? Math.floor(seconds / 3600) : seconds >= 60 ? Math.floor(seconds / 60) : seconds;
  const unit = seconds >= 3600 ? "hour" : seconds >= 60 ? "minute" : "second";
  return `Last update ${amount} ${unit}${amount === 1 ? "" : "s"} ago.`;
}
