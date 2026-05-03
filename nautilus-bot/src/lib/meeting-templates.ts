type MeetingTemplateId =
  | "auto"
  | "1on1"
  | "standup"
  | "sales"
  | "interview"
  | "brainstorm"
  | "coaching"
  | "doctor"
  | "legal"
  | "research"
  | "personal_admin";

type MeetingTemplateOption = {
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
  {
    value: "coaching",
    label: "Coaching",
    description: "Challenges, reframes, commitments, and next experiments.",
    summaryPrompt:
      "Summarize this coaching conversation with the core challenge, reframes, commitments, follow-up experiments, and any open concerns.",
    notesOutline: ["Current challenge", "Reframes", "Commitments", "Experiments", "Open questions"],
  },
  {
    value: "doctor",
    label: "Doctor Visit",
    description: "Symptoms, findings, care plan, and next steps.",
    summaryPrompt:
      "Summarize this medical visit with symptoms discussed, findings, treatment guidance, medications or tests, and next steps.",
    notesOutline: ["Symptoms", "Findings", "Guidance", "Tests or meds", "Next steps"],
  },
  {
    value: "legal",
    label: "Legal Call",
    description: "Facts, advice, risks, deadlines, and follow-up.",
    summaryPrompt:
      "Summarize this legal discussion with relevant facts, advice given, risks, deadlines, and follow-up actions.",
    notesOutline: ["Facts", "Advice", "Risks", "Deadlines", "Follow-up"],
  },
  {
    value: "research",
    label: "Research Call",
    description: "Questions, insights, signals, and open threads.",
    summaryPrompt:
      "Summarize this research call with questions explored, key insights, strong signals, uncertainties, and recommended next steps.",
    notesOutline: ["Questions", "Insights", "Signals", "Uncertainties", "Next steps"],
  },
  {
    value: "personal_admin",
    label: "Personal Admin",
    description: "Decisions, paperwork, logistics, and reminders.",
    summaryPrompt:
      "Summarize this personal admin conversation with decisions, paperwork, logistics, reminders, and immediate next steps.",
    notesOutline: ["Decisions", "Paperwork", "Logistics", "Reminders", "Next steps"],
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
