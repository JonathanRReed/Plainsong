import { invoke } from "@/lib/electron";

export interface AudioStorageStatus {
  audioBytes: number;
  bytesSaved: number;
  pendingTracks: number;
}

export function getAudioStorageStatus(): Promise<AudioStorageStatus> {
  return invoke("get_audio_storage_status");
}

export function freeMeetingAudio(preset: string, customMonths: number, storageMode: "always" | "transcript_only"): Promise<{ deletedAudioFiles: number; audioPathsCleared: number }> {
  return invoke("run_storage_retention_maintenance", { audioOnly: true, confirmed: true, preset, customMonths, storageMode });
}
