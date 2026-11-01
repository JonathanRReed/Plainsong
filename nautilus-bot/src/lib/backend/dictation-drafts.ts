import { invoke } from "@/lib/electron";

export interface DictationDraft {
  recordingId: string;
  title: string;
  text: string;
  expectedSavedText: string | null;
}

export async function listDictationDrafts(): Promise<DictationDraft[]> {
  return await invoke<DictationDraft[]>("list_dictation_drafts");
}

export async function saveDictationDraft(
  recordingId: string,
  text: string | null,
  expectedSavedText: string | null
): Promise<void> {
  await invoke("save_dictation_draft", { recordingId, text, expectedSavedText });
}

export async function clearDictationDraft(
  recordingId: string,
  expectedDraftText: string
): Promise<boolean> {
  const result = await invoke<{ cleared: boolean }>("clear_dictation_draft", {
    recordingId,
    expectedDraftText,
  });
  return result.cleared;
}
