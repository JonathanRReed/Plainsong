import { invoke } from "@/lib/electron";
import type { ApprovedLocationSummary } from "@/lib/backend";

export interface NotePublishConfig {
  enabled: boolean;
  locationId: string | null;
  templateId: string;
  includeTranscript: boolean;
}

export interface NotePublishSettings {
  config: NotePublishConfig;
  location: ApprovedLocationSummary | null;
}

export type NotePublishStatus =
  | { state: "none" | "pending" | "saved"; error: null }
  | { state: "error"; error: string };

export async function getNotePublishSettings(): Promise<NotePublishSettings> {
  return await invoke("get_note_publish_config");
}

export async function saveNotePublishConfig(config: NotePublishConfig): Promise<NotePublishSettings> {
  return await invoke("save_note_publish_config", { config });
}

export async function getNotePublishStatus(recordingId: string): Promise<NotePublishStatus> {
  return await invoke("get_note_publish_status", { recordingId });
}

export async function retryNotePublish(recordingId: string): Promise<void> {
  await invoke("retry_note_publish", { recordingId });
}

export async function selectNotePublishLocation(): Promise<ApprovedLocationSummary | null> {
  return await invoke("select_export_location", { forNotes: true });
}
