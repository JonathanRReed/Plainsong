export type MeetingTemplateId =
  | "auto"
  | "1on1"
  | "standup"
  | "sales"
  | "interview"
  | "brainstorm";

export type MeetingTemplateOption = {
  value: MeetingTemplateId;
  label: string;
  description: string;
  summaryPrompt: string;
  notesOutline: string[];
};

export const MEETING_TEMPLATES: MeetingTemplateOption[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Let Nautilus shape the meeting based on transcript and notes.",
    summaryPrompt:
      "Provide a concise but complete meeting summary with key discussion points, decisions, and concrete outcomes.",
    notesOutline: ["Goals", "Key discussion points", "Decisions", "Follow-ups"],
  },
  {
    value: "1on1",
    label: "1:1 Meeting",
    description: "Topics, feedback, goals, and commitments.",
    summaryPrompt:
      "Summarize this 1:1 with discussion topics, feedback exchanged, goals, commitments, and unresolved concerns.",
    notesOutline: ["Topics discussed", "Feedback", "Goals", "Commitments", "Risks or blockers"],
  },
  {
    value: "standup",
    label: "Standup",
    description: "Done, planned, blockers.",
    summaryPrompt:
      "Format this as a standup summary with work completed, work planned next, blockers, and ownership where stated.",
    notesOutline: ["Done", "Planned next", "Blockers", "Owners"],
  },
  {
    value: "sales",
    label: "Sales Call",
    description: "Pain points, objections, next steps.",
    summaryPrompt:
      "Summarize this sales call with prospect context, pain points, objections, buying signals, next steps, and deal status.",
    notesOutline: ["Prospect and context", "Pain points", "Objections", "Buying signals", "Next steps"],
  },
  {
    value: "interview",
    label: "Interview",
    description: "Strengths, answers, and hiring recommendation.",
    summaryPrompt:
      "Summarize this interview with candidate strengths, weaknesses, notable answers, open concerns, and hiring recommendation.",
    notesOutline: [
      "Candidate strengths",
      "Notable answers",
      "Concerns or gaps",
      "Signals",
      "Hiring recommendation",
    ],
  },
  {
    value: "brainstorm",
    label: "Brainstorm",
    description: "Ideas, top candidates, decisions.",
    summaryPrompt:
      "Summarize this brainstorm with ideas generated, strongest candidates, decisions made, and follow-up experiments or tasks.",
    notesOutline: ["Ideas", "Strong candidates", "Decisions", "Experiments", "Follow-ups"],
  },
];

export function getMeetingTemplateOption(
  templateId: string | null | undefined
): MeetingTemplateOption {
  return (
    MEETING_TEMPLATES.find((template) => template.value === templateId) ??
    MEETING_TEMPLATES[0]
  );
}

export function buildMeetingTemplateOutline(templateId: string | null | undefined): string {
  const template = getMeetingTemplateOption(templateId);
  return template.notesOutline.map((section) => `${section}\n- `).join("\n\n");
}
