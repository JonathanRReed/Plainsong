import { invoke } from "@/lib/electron";
import type { TranscriptSegment } from "@/types";

export interface MeetingAside {
  asideId: string;
  startTime: number;
  endTime: number;
  rows: TranscriptSegment[];
}

export async function getRecordingAsides(recordingId: string): Promise<MeetingAside[]> {
  const asides = await invoke<MeetingAside[]>("get_recording_asides", { recordingId });
  if (!Array.isArray(asides)) throw new Error("Could not read meeting asides");
  return asides;
}

export async function getRecordingAsideRanges(recordingId: string): Promise<Pick<MeetingAside, "startTime" | "endTime">[]> {
  const ranges = await invoke<Pick<MeetingAside, "startTime" | "endTime">[]>("get_recording_aside_ranges", { recordingId });
  if (!Array.isArray(ranges)) throw new Error("Could not read aside audio ranges");
  return ranges;
}

export function deleteRecordingAside(recordingId: string, asideId: string): Promise<void> {
  return invoke("delete_recording_aside", { recordingId, asideId });
}

export function exportRecordingAudio(recordingId: string): Promise<{ exportPath: string }> {
  return invoke("export_recording_audio", { recordingId });
}
