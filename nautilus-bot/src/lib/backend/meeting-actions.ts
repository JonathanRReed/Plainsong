import type { Recording } from "@/types";
import { invoke } from "@/lib/electron";

export interface MeetingActionCompletion {
  completedTasks: string[];
}

export async function getMeetingActionCompletion(
  recordingId: string,
): Promise<MeetingActionCompletion> {
  return await invoke("get_meeting_action_completion", { recordingId });
}

export async function setMeetingActionCompleted(
  recordingId: string,
  task: string,
  completed: boolean,
): Promise<MeetingActionCompletion> {
  return await invoke("set_meeting_action_completed", {
    recordingId,
    task,
    completed,
  });
}

export async function editMeetingAction(
  recordingId: string, expectedItems: readonly string[], index: number, replacement: string,
): Promise<MeetingActionCompletion & { recording: Recording }> {
  return await invoke("edit_meeting_action", { recordingId, expectedItems, index, replacement });
}

export async function addMeetingAction(recordingId: string, expectedItems: readonly string[], replacement: string): Promise<MeetingActionCompletion & { recording: Recording }> {
  return await invoke("add_meeting_action", { recordingId, expectedItems, replacement });
}

export async function deleteMeetingAction(recordingId: string, expectedItems: readonly string[], index: number): Promise<MeetingActionCompletion & { recording: Recording }> {
  return await invoke("delete_meeting_action", { recordingId, expectedItems, index });
}

/** Task acknowledgements cannot replace metadata owned by another save. */
export function mergeMeetingActionFields(
  current: Recording | null,
  saved: Pick<Recording, "id" | "actionItems" | "actionItemsProvenance">,
): Recording | null {
  if (!current || current.id !== saved.id) return current;
  return { ...current, actionItems: saved.actionItems, actionItemsProvenance: saved.actionItemsProvenance };
}
