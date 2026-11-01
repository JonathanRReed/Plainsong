import { invoke } from "@/lib/electron";

export interface MeetingFollowup {
  recordingId: string;
  meetingTitle: string;
  task: string;
  completed: boolean;
  needsReview: boolean;
}

export interface MeetingFollowupPage {
  items: MeetingFollowup[];
  nextOffset: number | null;
}

export interface ListMeetingFollowupsOptions {
  query?: string;
  offset?: number;
  limit?: number;
  includeCompleted?: boolean;
}

export async function listMeetingFollowups(
  options: ListMeetingFollowupsOptions = {},
): Promise<MeetingFollowupPage> {
  return await invoke<MeetingFollowupPage>("list_meeting_followups", { ...options });
}
