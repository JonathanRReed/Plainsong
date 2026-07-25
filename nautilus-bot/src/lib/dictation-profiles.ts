import type { DictationRoutePreference } from "@/lib/asr-capabilities";
import { INSERTION_MODE_LABELS } from "@/lib/dictation-history-labels";
import type {
  DictationContextSource,
  DictationInsertionMode,
  DictationModePreset,
} from "@/features/dictation/runtime";

/** A built-in mode, minus the escape hatch that has no defaults of its own. */
export type DictationBaseModePreset = Exclude<DictationModePreset, "custom">;

export type DictationModeDefinition = {
  id: DictationModePreset;
  label: string;
  description: string;
  profile?: "normal_speed" | "power_rewrite";
  routePreference?: DictationRoutePreference | null;
  insertionMode?: DictationInsertionMode;
  contextSource?: DictationContextSource;
  saveToInbox?: boolean;
  copyToClipboard?: boolean;
  commandModeEnabled?: boolean;
};

export type RecommendedAppStyle = {
  id: string;
  name: string;
  description: string;
  baseModePreset: DictationBaseModePreset;
  customPrompt: string;
  profile: "normal_speed" | "power_rewrite";
  routePreference: DictationRoutePreference;
  insertionMode: DictationInsertionMode;
  contextSource: DictationContextSource;
  saveToInbox: boolean;
  copyToClipboard: boolean;
  commandModeEnabled: boolean;
  activationAppMatcher?: string;
  activationDomainMatcher?: string;
  livePreviewEnabled?: boolean;
};

/**
 * Icons are named here and resolved to components at the render site, so the
 * catalog stays a plain data module (same split as `selected-text-actions.ts`).
 */
export type DictationProfileIconKey =
  | "sparkles"
  | "zap"
  | "book"
  | "notebook"
  | "replace"
  | "terminal"
  | "volume"
  | "sliders";

/**
 * One tile per profile a user can pick, whether it is a built-in mode or a
 * ready-made app style installed as a saved profile.
 *
 * This list replaces the two grids that used to sit back-to-back on this page
 * (quick "lanes" and "saved modes"). They overlapped — both rendered a tile
 * called "General" marked Active, and both wrote the same `dictationModePreset`
 * — so a user could not tell whether they were looking at one system or two.
 * STYLE.md forbids exactly that pattern.
 */
export type DictationProfileTile = {
  id: string;
  title: string;
  description: string;
  emphasis: string;
  iconKey: DictationProfileIconKey;
} & (
  | { kind: "mode"; modeId: DictationModePreset }
  | { kind: "style"; styleId: string }
);

export type DictationModeSummaryItem = {
  label: string;
  value: string;
};

export const CONTEXT_SOURCE_LABELS: Record<DictationContextSource, string> = {
  none: "No context",
  clipboard: "Clipboard",
  selected_text: "Selected text",
  application_context: "Application context",
};

const PROFILE_LABELS = {
  normal_speed: "Fast capture",
  power_rewrite: "Power rewrite",
} as const;

export const RECOMMENDED_APP_STYLES: RecommendedAppStyle[] = [
  {
    id: "builtin-slack-replies",
    name: "Slack Replies",
    description:
      "Short, clean replies that auto-activate in Slack and keep command edits ready.",
    baseModePreset: "messages",
    customPrompt:
      "Rewrite the user's dictation as a concise Slack reply. Keep it direct, natural, and easy to scan. Avoid email-style greetings or sign-offs unless the user explicitly says them. Return only the final reply.",
    profile: "normal_speed",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "application_context",
    saveToInbox: false,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationAppMatcher: "Slack",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-gmail-drafts",
    name: "Gmail Drafts",
    description:
      "Polished email drafting with selected-text context and auto-activation on Gmail.",
    baseModePreset: "email",
    customPrompt:
      "Rewrite the user's dictation into polished email-ready prose. Preserve intent, improve structure, and keep tone professional. Return only the final email body with no subject line unless the user dictates one.",
    profile: "power_rewrite",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "selected_text",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationDomainMatcher: "gmail.com",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-google-docs-writing",
    name: "Google Docs Writing",
    description:
      "Long-form drafting with browser context and clean insert behavior for Docs.",
    baseModePreset: "voice",
    customPrompt:
      "Rewrite the user's dictation into clean long-form prose for a document. Improve flow and clarity, but keep the original meaning. Use paragraphs rather than bullets unless the user explicitly asks for bullets.",
    profile: "power_rewrite",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "application_context",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationDomainMatcher: "docs.google.com",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-notion-notes",
    name: "Notion Notes",
    description:
      "Fast notes and structured edits for Notion pages with live preview on.",
    baseModePreset: "notes",
    customPrompt:
      "Rewrite the user's dictation as crisp structured notes. Prefer short sections and bullets when they make the notes clearer. Keep action items and open questions explicit. Return only the final note text.",
    profile: "normal_speed",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "application_context",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationAppMatcher: "Notion",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-linear-updates",
    name: "Linear Updates",
    description:
      "Issue updates with concise drafting and selected-text editing on linear.app.",
    baseModePreset: "meeting_follow_up",
    customPrompt:
      "Rewrite the user's dictation as a concise project or issue update. Make status, blockers, and next steps explicit. Keep the language short, precise, and suitable for a work-tracking tool.",
    profile: "power_rewrite",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "selected_text",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationDomainMatcher: "linear.app",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-coding-copilot",
    name: "Coding Copilot",
    description:
      "Code-aware dictation for prompts, commits, terminal commands, and editor rewrites.",
    baseModePreset: "messages",
    customPrompt:
      "Rewrite the user's dictation for a software development workflow. Preserve code terms, filenames, CLI commands, markdown, and developer jargon exactly when possible. Prefer concise technical phrasing and keep variable names, casing, and product names intact.",
    profile: "normal_speed",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "selected_text",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    activationAppMatcher: "Cursor",
    livePreviewEnabled: true,
  },
  {
    id: "builtin-quiet-focus",
    name: "Quiet Focus",
    description:
      "Low-friction dictation for whispering, private work, and fewer interruptions.",
    baseModePreset: "voice",
    customPrompt:
      "Rewrite the user's dictation with minimal cleanup. Preserve quiet speech intent, keep corrections natural, and avoid over-formatting. Return only the final text.",
    profile: "normal_speed",
    routePreference: "local",
    insertionMode: "paste",
    contextSource: "none",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
    livePreviewEnabled: true,
  },
];

export const DICTATION_MODE_DEFINITIONS: DictationModeDefinition[] = [
  {
    id: "voice",
    label: "General",
    description: "Fast everyday dictation with reliable insert behavior.",
    profile: "normal_speed",
    insertionMode: "paste",
    contextSource: "none",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
  },
  {
    id: "messages",
    label: "Slack & Chat",
    description:
      "Quick replies that stay compact and paste cleanly into chat apps.",
    profile: "normal_speed",
    insertionMode: "paste",
    contextSource: "none",
    saveToInbox: false,
    copyToClipboard: true,
    commandModeEnabled: false,
  },
  {
    id: "email",
    label: "Writing",
    description:
      "Cleaner output for polished drafting, rewrites, and longer-form prose.",
    profile: "power_rewrite",
    insertionMode: "paste",
    contextSource: "selected_text",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
  },
  {
    id: "notes",
    label: "Notes",
    description: "Capture ideas quickly and keep them saved for later.",
    profile: "normal_speed",
    insertionMode: "paste",
    contextSource: "none",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
  },
  {
    id: "meeting_follow_up",
    label: "Meeting Follow-up",
    description: "Generate polished follow-up text without forcing an insert.",
    profile: "power_rewrite",
    insertionMode: "clipboard_only",
    contextSource: "clipboard",
    saveToInbox: true,
    copyToClipboard: true,
    commandModeEnabled: true,
  },
  {
    id: "custom",
    label: "Custom",
    description: "Keep full control over capture, insertion, and automation.",
  },
];

export const DICTATION_MODE_DEFINITION_BY_ID: Record<
  DictationModePreset,
  DictationModeDefinition
> = Object.fromEntries(
  DICTATION_MODE_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<DictationModePreset, DictationModeDefinition>;

export const CODING_PROFILE_STYLE_ID = "builtin-coding-copilot";
export const QUIET_PROFILE_STYLE_ID = "builtin-quiet-focus";

export const DICTATION_PROFILE_TILES: DictationProfileTile[] = [
  {
    id: "voice",
    kind: "mode",
    modeId: "voice",
    title: DICTATION_MODE_DEFINITION_BY_ID.voice.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.voice.description,
    emphasis: "Best all-around starting point",
    iconKey: "sparkles",
  },
  {
    id: "messages",
    kind: "mode",
    modeId: "messages",
    title: DICTATION_MODE_DEFINITION_BY_ID.messages.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.messages.description,
    emphasis: "Best for compact replies",
    iconKey: "zap",
  },
  {
    id: "email",
    kind: "mode",
    modeId: "email",
    title: DICTATION_MODE_DEFINITION_BY_ID.email.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.email.description,
    emphasis: "Best for polished language",
    iconKey: "book",
  },
  {
    id: "notes",
    kind: "mode",
    modeId: "notes",
    title: DICTATION_MODE_DEFINITION_BY_ID.notes.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.notes.description,
    emphasis: "Best for keeping a record",
    iconKey: "notebook",
  },
  {
    id: "meeting_follow_up",
    kind: "mode",
    modeId: "meeting_follow_up",
    title: DICTATION_MODE_DEFINITION_BY_ID.meeting_follow_up.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.meeting_follow_up.description,
    emphasis: "Best for post-call writing",
    iconKey: "replace",
  },
  {
    id: "coding",
    kind: "style",
    styleId: CODING_PROFILE_STYLE_ID,
    title: "Coding",
    description:
      "Developer-first dictation for prompts, issue updates, markdown, and commands.",
    emphasis: "Optimized for software work",
    iconKey: "terminal",
  },
  {
    id: "quiet",
    kind: "style",
    styleId: QUIET_PROFILE_STYLE_ID,
    title: "Quiet",
    description:
      "Low-noise dictation when you want whisper-friendly capture and fewer distractions.",
    emphasis: "Best for low-volume speaking",
    iconKey: "volume",
  },
  {
    id: "custom",
    kind: "mode",
    modeId: "custom",
    title: DICTATION_MODE_DEFINITION_BY_ID.custom.label,
    description: DICTATION_MODE_DEFINITION_BY_ID.custom.description,
    emphasis: "Build your own from the controls below",
    iconKey: "sliders",
  },
];

/**
 * Which single tile is active right now.
 *
 * Exactly one tile can match: the two ready-made styles claim their tile only
 * while their saved profile is the selected one, everything else falls through
 * to the mode preset, and a hand-rolled custom profile lands on "custom".
 */
export function resolveActiveDictationProfileId(
  modePreset: DictationModePreset,
  selectedCustomModeId: string | null,
): string {
  if (modePreset === "custom") {
    if (selectedCustomModeId === CODING_PROFILE_STYLE_ID) {
      return "coding";
    }
    if (selectedCustomModeId === QUIET_PROFILE_STYLE_ID) {
      return "quiet";
    }
    return "custom";
  }
  return modePreset;
}

function dictationModeLabel(
  modePreset: Exclude<DictationModePreset, "custom">,
): string {
  return DICTATION_MODE_DEFINITION_BY_ID[modePreset]?.label ?? "General";
}

export function coerceBaseModePreset(
  modePreset: string | null | undefined,
): DictationBaseModePreset {
  switch (modePreset) {
    case "messages":
    case "email":
    case "notes":
    case "meeting_follow_up":
      return modePreset;
    default:
      return "voice";
  }
}

export function summarizeMode(mode: {
  baseModePreset?: DictationBaseModePreset | null;
  profile: "normal_speed" | "power_rewrite";
  routePreference?: DictationRoutePreference | null;
  insertionMode: DictationInsertionMode;
  contextSource: DictationContextSource;
  saveToInbox: boolean;
  copyToClipboard: boolean;
  commandModeEnabled: boolean;
  dictationProvider?: string | null;
  dictationModelId?: string | null;
  aiProvider?: string | null;
  aiModelId?: string | null;
  customPrompt?: string | null;
  activationAppMatcher?: string | null;
  activationDomainMatcher?: string | null;
  languageOverride?: string | null;
  livePreviewEnabled?: boolean | null;
}): DictationModeSummaryItem[] {
  const summary: DictationModeSummaryItem[] = [
    {
      label: "Base",
      value: dictationModeLabel(mode.baseModePreset ?? "voice"),
    },
    { label: "Style", value: PROFILE_LABELS[mode.profile] },
    {
      label: "Route",
      value:
        mode.routePreference === "cloud"
          ? "Cloud preferred"
          : mode.routePreference === "local"
            ? "Local preferred"
            : "Current route",
    },
    { label: "Result", value: INSERTION_MODE_LABELS[mode.insertionMode] },
    { label: "Context", value: CONTEXT_SOURCE_LABELS[mode.contextSource] },
    {
      label: "History",
      value: mode.saveToInbox ? "Save to Inbox" : "Do not save",
    },
    {
      label: "Clipboard",
      value: mode.copyToClipboard ? "Copy enabled" : "Copy off",
    },
    {
      label: "Commands",
      value: mode.commandModeEnabled ? "Command mode on" : "Command mode off",
    },
    {
      label: "Transcription",
      value: mode.dictationProvider
        ? mode.dictationModelId
          ? `${mode.dictationProvider} · ${mode.dictationModelId}`
          : mode.dictationProvider
        : "Current route",
    },
    {
      label: "AI",
      value: mode.aiProvider
        ? mode.aiModelId
          ? `${mode.aiProvider} · ${mode.aiModelId}`
          : mode.aiProvider
        : "Current AI route",
    },
    {
      label: "Auto",
      value: mode.activationDomainMatcher
        ? `Domain ${mode.activationDomainMatcher}`
        : mode.activationAppMatcher
          ? `App ${mode.activationAppMatcher}`
          : "Manual only",
    },
  ];

  if (mode.languageOverride?.trim()) {
    summary.push({ label: "Language", value: mode.languageOverride.trim() });
  }

  if (mode.customPrompt?.trim()) {
    summary.push({ label: "Prompt", value: "Mode-specific style prompt" });
  }

  if (typeof mode.livePreviewEnabled === "boolean") {
    summary.push({
      label: "Preview",
      value: mode.livePreviewEnabled ? "Live partials on" : "Live partials off",
    });
  }

  return summary;
}
