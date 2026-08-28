type MeetingTemplateOption = {
  value: string;
  label: string;
  description: string;
  summaryPrompt: string;
  notesOutline: string[];
  /** Absent (or false) for every built-in in `MEETING_TEMPLATES` below; true
   * only for a template synthesized from the user's saved list in settings.
   * The picker uses this to label "Your templates" apart from the built-in
   * set (audit finding ux-12 — Granola-style user recipes). */
  isCustom?: boolean;
};

/**
 * A user-saved meeting template ("recipe"). Mirrors `MeetingCustomTemplate`
 * in rust-sidecar/src/settings.rs and `MeetingCustomTemplate` in
 * src/types/settings.ts -- the settings wire contract test pins all three
 * to the same field set.
 */
export type CustomMeetingTemplate = {
  id: string;
  name: string;
  summaryPrompt: string;
  notesOutline: string[];
};

/**
 * A settings.json with more saved templates than this is almost certainly a
 * bug, not a user with genuinely that many playbooks. Mirrors
 * `MAX_MEETING_CUSTOM_TEMPLATES` in rust-sidecar/src/settings.rs so the
 * renderer can refuse a new save before round-tripping to find out that Rust
 * would have dropped it anyway.
 */
export const MAX_CUSTOM_MEETING_TEMPLATES = 50;

/**
 * Field-length and outline-size caps, mirroring `MAX_MEETING_TEMPLATE_NAME_LEN`,
 * `MAX_MEETING_TEMPLATE_PROMPT_LEN`, and `MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS`
 * in rust-sidecar/src/settings.rs. Rust sanitizes on every save regardless, so
 * these exist purely so the editor dialog can stop the user from typing past
 * the point where their content would otherwise be silently trimmed on the
 * next launch -- see FIX 1 in the ux-12 review.
 */
export const MAX_MEETING_TEMPLATE_NAME_LENGTH = 80;
export const MAX_MEETING_TEMPLATE_PROMPT_LENGTH = 4000;
export const MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS = 12;

export const MEETING_TEMPLATES: MeetingTemplateOption[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Let Plainsong shape the meeting based on transcript and notes.",
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

/** Every id a built-in template can carry. New custom templates are always
 * minted with a `custom-` prefix (see recordings-view.tsx), which can never
 * collide with one of these, so nothing on the renderer side needs to check
 * against this set at save time. It exists as the renderer-side mirror of
 * `BUILTIN_MEETING_TEMPLATE_IDS` in rust-sidecar/src/settings.rs, which is
 * the real backstop: it drops any custom entry that *does* carry a built-in
 * id, from a settings.json edited by hand or written by an older client. */
export const BUILTIN_MEETING_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  MEETING_TEMPLATES.map((template) => template.value)
);

/** A custom template as a `MeetingTemplateOption`, so the picker and the
 * outline/notes-parsing helpers below can treat it exactly like a built-in. */
function customTemplateToOption(template: CustomMeetingTemplate): MeetingTemplateOption {
  return {
    value: template.id,
    label: template.name,
    description: "Your template",
    summaryPrompt: template.summaryPrompt,
    notesOutline: template.notesOutline,
    isCustom: true,
  };
}

/** Built-ins first, then the user's saved templates -- the order the picker
 * renders them in. A custom entry carrying a built-in id is filtered out
 * here too (Rust already drops these on load/save -- see
 * `sanitize_meeting_custom_templates` -- but a settings file read before
 * that sanitization ran, or edited by hand, could still hand this one), so
 * the picker never lists the same id twice. */
export function getAllMeetingTemplateOptions(
  customTemplates: readonly CustomMeetingTemplate[] = []
): MeetingTemplateOption[] {
  const customOptions = customTemplates
    .filter((template) => !BUILTIN_MEETING_TEMPLATE_IDS.has(template.id))
    .map(customTemplateToOption);
  return [...MEETING_TEMPLATES, ...customOptions];
}

/**
 * Resolve a template id against the built-in set first, then the caller's
 * custom templates, falling back to the default ("auto") template for
 * anything else -- including a custom id whose template has since been
 * deleted. That fallback is what keeps a past meeting displayable after its
 * template is removed (deleting a template must not break the meetings that
 * used it): there is never an id this function fails to resolve to *some*
 * option.
 */
export function getMeetingTemplateOption(
  templateId: string | null | undefined,
  customTemplates: readonly CustomMeetingTemplate[] = []
): MeetingTemplateOption {
  const builtin = MEETING_TEMPLATES.find((template) => template.value === templateId);
  if (builtin) {
    return builtin;
  }
  const custom = customTemplates.find((template) => template.id === templateId);
  if (custom) {
    return customTemplateToOption(custom);
  }
  return MEETING_TEMPLATES[0];
}

export function buildMeetingTemplateOutline(
  templateId: string | null | undefined,
  customTemplates: readonly CustomMeetingTemplate[] = []
): string {
  const template = getMeetingTemplateOption(templateId, customTemplates);
  return template.notesOutline.map((section) => `${section}\n- `).join("\n\n");
}
