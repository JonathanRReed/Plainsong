import { invoke } from "@/lib/electron";

export interface DictationEditResult {
  text: string | null;
}

export async function getDictationEdit(
  recordingId: string
): Promise<DictationEditResult> {
  return await invoke<DictationEditResult>("get_dictation_edit", { recordingId });
}

export async function saveDictationEdit(
  recordingId: string,
  text: string | null,
  expectedText: string | null
): Promise<DictationEditResult> {
  return await invoke<DictationEditResult>("save_dictation_edit", {
    recordingId,
    text,
    expectedText,
  });
}
