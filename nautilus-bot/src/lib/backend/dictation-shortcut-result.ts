import { invoke } from "@/lib/electron";

export interface StagedDictationResult {
  text: string;
}

export async function stageSavedDictationResult(
  recordingId: string,
): Promise<StagedDictationResult> {
  return await invoke<StagedDictationResult>("stage_saved_dictation_result", {
    recordingId,
  });
}
