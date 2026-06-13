import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { useRecording } from "@/hooks/use-recording";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import {
  listDictationDictionaryEntries,
  createDictationDictionaryEntry,
  updateDictationDictionaryEntry,
  deleteDictationDictionaryEntry,
  exportDictationDictionaryCsv,
  importDictationDictionaryCsv,
  listDictationCorrectionSuggestions,
  queueDictationCorrectionSuggestion,
  approveDictationCorrectionSuggestion,
  rejectDictationCorrectionSuggestion,
  learnDictationCorrection,
  listDictationSnippets,
  createDictationSnippet,
  updateDictationSnippet,
  deleteDictationSnippet,
  listDictationCommandPresets,
  upsertDictationCommandPreset,
  deleteDictationCommandPreset,
  type DictationDictionaryEntry,
  type LearnDictationCorrectionResult,
  type DictationDictionaryCsvImportResult,
  type DictationCorrectionSuggestion,
  type QueueDictationCorrectionSuggestionResult,
  type DictationSnippet,
  type DictationCommandPreset,
  type DictationReprocessResult,
  type DictationHistoryDetails,
  type DictationInsights,
  getDictationHistoryDetails,
  getDictationInsights,
  captureSelectedTextForPlayback,
  reprocessDictationText,
} from "@/lib/backend/dictation";
import { deleteRecording, getTranscript } from "@/lib/backend/recordings";
import { getSettings, saveSettings } from "@/lib/backend/settings";
import {
  defaultDictationShortcut,
  dictationInstruction,
  formatShortcutForDisplay,
  matchesShortcut,
} from "@/lib/shortcuts";
import {
  providerHostingPreference,
  type DictationRoutePreference,
} from "@/lib/asr-capabilities";
import { formatAppliedDictationCommandLabel } from "@/lib/dictation-command-labels";
import { sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";
import { speakTextAloud, stopSpeakingText } from "@/lib/text-to-speech";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Keyboard,
  Mic,
  Square,
  Zap,
  Save,
  RefreshCw,
  Download,
  Upload,
  Copy,
  Brain,
  Sparkles,
  Terminal,
  Volume2,
  BookOpen,
  Replace,
  CheckCircle2,
  TriangleAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type {
  AsrProviderType,
  Recording,
  Transcript,
} from "@/types";
import type { DictationCustomMode } from "@/types/settings";
import {
  useDictationRuntime,
  type DictationContextSource,
  type DictationInsertionMode,
  type DictationModePreset,
} from "@/features/dictation/runtime";

function getSafeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storage = window.localStorage;
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    return null;
  }

  return storage;
}

type DictationBaseModePreset = Exclude<DictationModePreset, "custom">;
type CorrectionSuggestionGroup = {
  key: string;
  suggestionIds: string[];
  spokenForm: string;
  replacement: string;
  appTarget: string | null;
  updatedAt: string;
  sampleOriginalText: string;
  sampleCorrectedText: string;
};

type DictationModeDefinition = {
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

type DictationCustomModeDraft = {
  name: string;
  description: string;
  baseModePreset: DictationBaseModePreset;
  customPrompt: string;
  activationAppMatcher: string;
  activationDomainMatcher: string;
  languageOverride: string;
  livePreviewEnabled: boolean;
};

type DictationRecoveryState = {
  tone: "warning" | "attention";
  title: string;
  detail: string;
  hints: string[];
};

type DeliveryDoctorTone = "ready" | "attention" | "warning";

type DeliveryDoctorItem = {
  label: string;
  value: string;
};

type DeliveryDoctorSummary = {
  tone: DeliveryDoctorTone;
  title: string;
  detail: string;
  nextAction: string;
  items: DeliveryDoctorItem[];
};

function describeDictationRecoveryState(
  fallbackStatus: string | null,
  pasteStatus: string | null,
): DictationRecoveryState | null {
  const fallback = fallbackStatus?.trim() ?? "";
  const paste = pasteStatus?.trim() ?? "";
  const combined = `${fallback} ${paste}`.toLowerCase();

  if (!fallback && !paste) {
    return null;
  }

  if (
    combined.includes("accessibility") ||
    combined.includes("cursor insertion") ||
    combined.includes("clipboard")
  ) {
    return {
      tone: "attention",
      title: "Insertion needs a safer path",
      detail:
        paste || fallback || "Plainsong could not deliver the result into the target app cleanly.",
      hints: [
        "Switch to Clipboard only if the target app blocks direct insertion.",
        "Grant Accessibility or cursor-insertion permissions if you want automatic delivery.",
      ],
    };
  }

  if (
    combined.includes("provider") ||
    combined.includes("fallback") ||
    combined.includes("model") ||
    combined.includes("route")
  ) {
    return {
      tone: "warning",
      title: "Transcription route fell back",
      detail:
        fallback || paste || "Plainsong used a different transcription route than requested.",
      hints: [
        "Download the requested local model or choose a route that is already ready.",
        "Keep an eye on the provider badge below so you know what actually ran.",
      ],
    };
  }

  return {
    tone: "attention",
    title: "Dictation needs attention",
    detail: fallback || paste,
    hints: [
      "Retry once after checking the current route and insertion mode.",
      "If this keeps happening, switch to the more reliable path for this app.",
    ],
  };
}

function formatDurationMetric(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function formatInsertionModeLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value as DictationInsertionMode;
  return INSERTION_MODE_LABELS[normalized] ?? value.replace(/_/g, " ");
}

type DictationModeSummaryItem = {
  label: string;
  value: string;
};

type DictationRuntimePhase =
  | "idle"
  | "primed"
  | "recording"
  | "stopping"
  | "transcribing"
  | "delivering"
  | "done"
  | "error";

type RecommendedAppStyle = {
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

type SoloLane = {
  id: string;
  title: string;
  description: string;
  icon: typeof Mic;
  modeId?: DictationModePreset;
  styleId?: string;
  emphasis: string;
};

type DictationCoachStep =
  | "backtrack"
  | "dictionary"
  | "command_mode"
  | "profiles";

type DictationCoachCard = {
  id: DictationCoachStep;
  title: string;
  body: string;
  actionLabel: string;
};

const ACTIVATION_APP_SUGGESTIONS = ["Slack", "Notion", "Cursor", "Messages"];
const ACTIVATION_DOMAIN_SUGGESTIONS = [
  "gmail.com",
  "linear.app",
  "docs.google.com",
  "notion.so",
];
const DICTATION_SESSION_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];
const DICTATION_ACTIVE_LANGUAGE_OPTIONS =
  DICTATION_SESSION_LANGUAGE_OPTIONS.filter(
    (option) => option.value !== "auto",
  );

const RECOMMENDED_APP_STYLES: RecommendedAppStyle[] = [
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

const SOLO_LANES: SoloLane[] = [
  {
    id: "everywhere",
    title: "General",
    description:
      "Fast default dictation for everyday text targets with clean inserts and light cleanup.",
    icon: Sparkles,
    modeId: "voice",
    emphasis: "Best all-around starting point",
  },
  {
    id: "messages",
    title: "Slack",
    description: "Short replies for Slack, chat, and quick-response work.",
    icon: Zap,
    modeId: "messages",
    emphasis: "Best for compact replies",
  },
  {
    id: "writing",
    title: "Writing",
    description: "Long-form drafting for docs, email, and polished prose.",
    icon: BookOpen,
    modeId: "email",
    emphasis: "Best for polished language",
  },
  {
    id: "follow_up",
    title: "Follow-up",
    description:
      "Turn rough notes into a polished meeting follow-up without forcing an insert.",
    icon: Replace,
    modeId: "meeting_follow_up",
    emphasis: "Best for post-call writing",
  },
  {
    id: "coding",
    title: "Coding",
    description:
      "Developer-first dictation for prompts, issue updates, markdown, and commands.",
    icon: Terminal,
    styleId: "builtin-coding-copilot",
    emphasis: "Optimized for software work",
  },
  {
    id: "quiet",
    title: "Quiet",
    description:
      "Low-noise dictation when you want whisper-friendly capture and fewer distractions.",
    icon: Volume2,
    styleId: "builtin-quiet-focus",
    emphasis: "Best for low-volume speaking",
  },
];

const DICTATION_COACH_CARDS: DictationCoachCard[] = [
  {
    id: "backtrack",
    title: "Fix the last insert with your voice",
    body: "Say 'scratch that', 'actually ...', or 'replace X with Y' right after an insert. Plainsong already supports it, and this is one of the fastest ways to beat the keyboard.",
    actionLabel: "Got it",
  },
  {
    id: "dictionary",
    title: "Teach Plainsong names and jargon",
    body: "Edit the latest result, then choose Learn correction. Use the dictionary for words that need to stick across apps.",
    actionLabel: "Show me later",
  },
  {
    id: "command_mode",
    title: "Use voice editing, not just voice typing",
    body: "Command mode is best for rewrite, bulletize, summarize, and coding cleanup on selected text. Keep it on when you want the app to act like a writing copilot.",
    actionLabel: "Keep enabled",
  },
  {
    id: "profiles",
    title: "Let app-aware flows switch for you",
    body: "Install a lane or flow profile for the apps you use most so Plainsong automatically matches style, context, and insertion behavior.",
    actionLabel: "I’ll use this",
  },
];

const COMMAND_PRESET_FIELDS: Array<{
  key: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection";
  label: string;
  defaultPrompt: string;
}> = [
  {
    key: "rewrite_shorter",
    label: "Rewrite Shorter",
    defaultPrompt:
      "Rewrite the user's text to be shorter while preserving intent. Keep the same language and tone. Return only the rewritten text.",
  },
  {
    key: "rewrite_professional",
    label: "Rewrite Professional",
    defaultPrompt:
      "Rewrite the user's text in a professional tone while preserving meaning. Keep it clear and concise. Return only the rewritten text.",
  },
  {
    key: "bulletize_selection",
    label: "Bulletize Selection",
    defaultPrompt:
      "Convert the user's text into concise bullet points. Use one bullet per idea. Return only the bullet list.",
  },
];

const DEFAULT_DICTATION_MODE: DictationModePreset = "voice";
const DEFAULT_BASE_MODE: DictationBaseModePreset = "voice";

const INSERTION_MODE_LABELS: Record<DictationInsertionMode, string> = {
  auto: "Recommended",
  paste: "Paste at cursor",
  inline: "Insert on release",
  clipboard_only: "Clipboard only",
};

const CONTEXT_SOURCE_LABELS: Record<DictationContextSource, string> = {
  none: "No context",
  clipboard: "Clipboard",
  selected_text: "Selected text",
  application_context: "Application context",
};

const PROFILE_LABELS = {
  normal_speed: "Fast capture",
  power_rewrite: "Power rewrite",
} as const;

const shortcutMode = (pushToTalk: boolean, handsFreeEnabled: boolean) =>
  handsFreeEnabled ? "hands_free" : pushToTalk ? "hold_to_talk" : "toggle";

function formatTimeoutSeconds(seconds: number): string {
  if (seconds <= 0) return "off";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function normalizeDictationSilenceTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(30, Math.max(0.8, value));
}

function normalizeActiveLanguageSet(languages: string[]): string[] {
  const allowed = new Set(
    DICTATION_ACTIVE_LANGUAGE_OPTIONS.map((option) => option.value),
  );
  const normalized: string[] = [];
  for (const language of languages) {
    const value = language.trim().toLowerCase();
    if (!allowed.has(value) || normalized.includes(value)) {
      continue;
    }
    normalized.push(value);
  }
  return normalized;
}

const DICTATION_MODE_DEFINITIONS: DictationModeDefinition[] = [
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

function describeActivationRules(
  appMatcher: string | null | undefined,
  domainMatcher: string | null | undefined,
): string {
  const normalizedAppMatcher = appMatcher?.trim();
  const normalizedDomainMatcher = domainMatcher?.trim();

  if (normalizedAppMatcher && normalizedDomainMatcher) {
    return `Auto-switches when the frontmost app contains "${normalizedAppMatcher}" or the active browser tab is on ${normalizedDomainMatcher}.`;
  }

  if (normalizedDomainMatcher) {
    return `Auto-switches when the active browser tab is on ${normalizedDomainMatcher}.`;
  }

  if (normalizedAppMatcher) {
    return `Auto-switches when the frontmost app contains "${normalizedAppMatcher}".`;
  }

  return "Manual only. This mode stays available, but Plainsong will not switch into it automatically.";
}

function describeSmartContextState(
  activationMatcher: string | null,
  appTarget: string | null,
  contextChars: number | null,
): string {
  if (activationMatcher && appTarget) {
    return `${activationMatcher} matched, and Plainsong captured context from ${appTarget}.`;
  }
  if (activationMatcher) {
    return `${activationMatcher} matched before capture, so Plainsong used an app-aware flow.`;
  }
  if (appTarget && contextChars && contextChars > 0) {
    return `Plainsong captured ${contextChars} chars of context from ${appTarget}.`;
  }
  if (appTarget) {
    return `Plainsong targeted ${appTarget} for insertion.`;
  }
  return "Plainsong is ready for the active target and will use the current flow settings.";
}

function createCustomModeDraft(
  overrides?: Partial<DictationCustomModeDraft>,
): DictationCustomModeDraft {
  return {
    name: "Custom Mode",
    description: "",
    baseModePreset: DEFAULT_BASE_MODE,
    customPrompt: "",
    activationAppMatcher: "",
    activationDomainMatcher: "",
    languageOverride: "",
    livePreviewEnabled: true,
    ...overrides,
  };
}

function dictationModeLabel(
  modePreset: Exclude<DictationModePreset, "custom">,
): string {
  return (
    DICTATION_MODE_DEFINITIONS.find(
      (definition) => definition.id === modePreset,
    )?.label ?? "General"
  );
}

function getDictationPhaseSummary(
  phase: DictationRuntimePhase,
  message: string | null,
  preview: string | null,
): {
  title: string;
  detail: string;
  tone: "idle" | "active" | "success" | "error";
} {
  const fallbackDetail =
    preview?.trim() ||
    message?.trim() ||
    "Plainsong is ready for the next capture.";

  switch (phase) {
    case "primed":
      return {
        title: "Mic primed",
        detail:
          message?.trim() ||
          "The route is warm and Plainsong is getting ready to listen.",
        tone: "active",
      };
    case "recording":
      return {
        title: "Listening",
        detail:
          preview?.trim() ||
          message?.trim() ||
          "Capture is live and the next result is building.",
        tone: "active",
      };
    case "stopping":
      return {
        title: "Stopping capture",
        detail:
          message?.trim() ||
          "Audio is closing cleanly so the result can be finalized.",
        tone: "active",
      };
    case "transcribing":
      return {
        title: "Transcribing",
        detail:
          preview?.trim() ||
          message?.trim() ||
          "Speech is turning into text now.",
        tone: "active",
      };
    case "delivering":
      return {
        title: "Inserting",
        detail:
          message?.trim() ||
          "Plainsong is inserting or copying the final result.",
        tone: "active",
      };
    case "done":
      return {
        title: "Ready again",
        detail: message?.trim() || fallbackDetail,
        tone: "success",
      };
    case "error":
      return {
        title: "Needs attention",
        detail:
          message?.trim() ||
          "Capture or delivery hit a problem. Your latest text is still available.",
        tone: "error",
      };
    case "idle":
    default:
      return {
        title: "Ready to launch",
        detail:
          message?.trim() ||
          "Start from the hotkey or the button below and Plainsong will take it from there.",
        tone: "idle",
      };
  }
}

function coerceBaseModePreset(
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

function historyModeLabel(details: DictationHistoryDetails | null): string {
  if (!details) {
    return "Unavailable";
  }
  if (details.modeLabel) {
    return details.modeLabel;
  }
  if (details.modePreset) {
    return (
      modeDefinitionByIdStatic[details.modePreset as DictationModePreset]
        ?.label ?? details.modePreset
    );
  }
  return "Unavailable";
}

const modeDefinitionByIdStatic = DICTATION_MODE_DEFINITIONS.reduce<
  Record<DictationModePreset, DictationModeDefinition>
>(
  (accumulator, definition) => {
    accumulator[definition.id] = definition;
    return accumulator;
  },
  {} as Record<DictationModePreset, DictationModeDefinition>,
);

function historyPromptSourceLabel(
  promptSource: string | null | undefined,
): string {
  if (!promptSource) {
    return "Direct transcript";
  }
  if (promptSource.startsWith("command:")) {
    return `Command: ${promptSource.slice("command:".length)}`;
  }
  if (promptSource.startsWith("custom_mode_format:")) {
    return "Custom mode prompt";
  }
  if (promptSource === "custom_dictation_format") {
    return "Custom dictation prompt";
  }
  if (promptSource === "default_dictation_format") {
    return "Standard dictation prompt";
  }
  return promptSource;
}

function historyPipelineStageLabel(stageKey: string): string {
  switch (stageKey) {
    case "dictionary":
      return "Dictionary";
    case "backtrack":
      return "Backtrack";
    case "snippets":
      return "Snippets";
    case "smart_formatting":
      return "Smart formatting";
    default:
      return stageKey;
  }
}

function summarizeMode(mode: {
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

export function DictationView() {
  const {
    stateEvent: dictationStateEvent,
    textReadyEvent: dictationTextReadyEvent,
  } = useDictationRuntime();
  const { formattedDuration, startDictation, stopDictation } = useRecording();
  const { projects } = useProjects();
  const {
    recordings,
    isLoading: dictationHistoryLoading,
    refetch: refetchDictationHistory,
  } = useRecordings();
  const defaultShortcut = defaultDictationShortcut();
  const [hotkeyLabel, setHotkeyLabel] = useState(
    formatShortcutForDisplay(defaultShortcut),
  );
  const [hotkeyShortcut, setHotkeyShortcut] = useState(defaultShortcut);
  const [transcribedText, setTranscribedText] = useState("");
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModelId, setLastModelId] = useState<string | null>(null);
  const [lastRoutePreference, setLastRoutePreference] =
    useState<DictationRoutePreference | null>(null);
  const [lastResolvedRoute, setLastResolvedRoute] = useState<string | null>(
    null,
  );
  const [lastProviderModelLabel, setLastProviderModelLabel] = useState<
    string | null
  >(null);
  const [lastResolvedHosting, setLastResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [startupLatencyMs, setStartupLatencyMs] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [insertionModeUsed, setInsertionModeUsed] = useState<string | null>(
    null,
  );
  const [commandApplied, setCommandApplied] = useState<string | null>(null);
  const [snippetAppliedCount, setSnippetAppliedCount] = useState(0);
  const [dictationPhase, setDictationPhase] =
    useState<DictationRuntimePhase>("idle");
  const [dictationPhaseMessage, setDictationPhaseMessage] = useState<
    string | null
  >(null);
  const [dictationPhasePreview, setDictationPhasePreview] = useState<
    string | null
  >(null);
  const [dictationResolvedModeLabel, setDictationResolvedModeLabel] = useState<
    string | null
  >(null);
  const [appTarget, setAppTarget] = useState<string | null>(null);
  const [activationMatcher, setActivationMatcher] = useState<string | null>(
    null,
  );
  const [contextChars, setContextChars] = useState<number | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [saveToInbox, setSaveToInbox] = useState(true);
  const [dictationProfile, setDictationProfile] = useState<
    "normal_speed" | "power_rewrite"
  >("normal_speed");
  const [dictationModePreset, setDictationModePreset] =
    useState<DictationModePreset>(DEFAULT_DICTATION_MODE);
  const [dictationCustomModes, setDictationCustomModes] = useState<
    DictationCustomMode[]
  >([]);
  const [selectedCustomModeId, setSelectedCustomModeId] = useState<
    string | null
  >(null);
  const [customModeDraft, setCustomModeDraft] =
    useState<DictationCustomModeDraft>(createCustomModeDraft());
  const [defaultProjectId, setDefaultProjectId] = useState("inbox");
  const [dictationPushToTalk, setDictationPushToTalk] = useState(true);
  const [dictationHandsFreeEnabled, setDictationHandsFreeEnabled] =
    useState(false);
  const [dictationRoutePreference, setDictationRoutePreference] =
    useState<DictationRoutePreference>("local");
  const [dictationRouteOverrideEnabled, setDictationRouteOverrideEnabled] =
    useState(true);
  const [dictationKeepWarm, setDictationKeepWarm] = useState<
    "off" | "short" | "long"
  >("short");
  const [dictationLivePreviewEnabled, setDictationLivePreviewEnabled] =
    useState(true);
  const [nextCaptureRoutePreference, setNextCaptureRoutePreference] =
    useState<DictationRoutePreference | null>(null);
  const [dictationContextSource, setDictationContextSource] =
    useState<DictationContextSource>("none");
  const [dictationCopyToClipboard, setDictationCopyToClipboard] =
    useState(true);
  const [dictationCommandModeEnabled, setDictationCommandModeEnabled] =
    useState(true);
  const [dictationCommandPrefix, setDictationCommandPrefix] =
    useState("command");
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("auto");
  const [dictationSessionLanguage, setDictationSessionLanguage] =
    useState("auto");
  const [dictationActiveLanguages, setDictationActiveLanguages] = useState<
    string[]
  >([]);
  const [dictationSnippetsEnabled, setDictationSnippetsEnabled] =
    useState(true);
  const [dictationAutoLearnCorrections, setDictationAutoLearnCorrections] =
    useState(true);
  const [dictationSilenceTimeoutSeconds, setDictationSilenceTimeoutSeconds] =
    useState(0);
  const [dictationDictionaryEntries, setDictationDictionaryEntries] = useState<
    DictationDictionaryEntry[]
  >([]);
  const [dictationCorrectionSuggestions, setDictationCorrectionSuggestions] =
    useState<DictationCorrectionSuggestion[]>([]);
  const [correctionInboxBusy, setCorrectionInboxBusy] = useState(false);
  const [dictationSnippets, setDictationSnippets] = useState<
    DictationSnippet[]
  >([]);
  const [dictationCommandPresets, setDictationCommandPresets] = useState<
    DictationCommandPreset[]
  >([]);
  const [newDictionarySpokenForm, setNewDictionarySpokenForm] = useState("");
  const [newDictionaryReplacement, setNewDictionaryReplacement] = useState("");
  const [newDictionaryAppScope, setNewDictionaryAppScope] = useState("");
  const [newDictionaryCaseSensitive, setNewDictionaryCaseSensitive] =
    useState(false);
  const [dictionaryCsvDialogOpen, setDictionaryCsvDialogOpen] = useState(false);
  const [dictionaryCsvMode, setDictionaryCsvMode] = useState<
    "import" | "export"
  >("import");
  const [dictionaryCsvText, setDictionaryCsvText] = useState("");
  const [dictionaryCsvStatus, setDictionaryCsvStatus] = useState<string | null>(
    null,
  );
  const [dictionaryCsvImportResult, setDictionaryCsvImportResult] =
    useState<DictationDictionaryCsvImportResult | null>(null);
  const [dictionaryCsvBusy, setDictionaryCsvBusy] = useState(false);
  const [newSnippetTrigger, setNewSnippetTrigger] = useState("");
  const [newSnippetExpansion, setNewSnippetExpansion] = useState("");
  const [newSnippetAppScope, setNewSnippetAppScope] = useState("");
  const [newSnippetCaseSensitive, setNewSnippetCaseSensitive] = useState(false);
  const [dictationRetentionPreset, setDictationRetentionPreset] = useState<
    "immediate" | "24h" | "72h" | "never" | "custom"
  >("never");
  const [dictationRetentionCustomHours, setDictationRetentionCustomHours] =
    useState(24);
  const [hotkeyPressed, setHotkeyPressed] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(
    null,
  );
  const [selectedTranscript, setSelectedTranscript] =
    useState<Transcript | null>(null);
  const [selectedHistoryDetails, setSelectedHistoryDetails] =
    useState<DictationHistoryDetails | null>(null);
  const [dictationInsights, setDictationInsights] =
    useState<DictationInsights | null>(null);
  const [latestCorrectionBaseline, setLatestCorrectionBaseline] = useState("");
  const [latestLearnStatus, setLatestLearnStatus] = useState<string | null>(
    null,
  );
  const [historyCorrectionText, setHistoryCorrectionText] = useState("");
  const [historyCorrectionBaseline, setHistoryCorrectionBaseline] =
    useState("");
  const [historyLearnStatus, setHistoryLearnStatus] = useState<string | null>(
    null,
  );
  const [activeSpeechTarget, setActiveSpeechTarget] = useState<string | null>(
    null,
  );
  const [dismissedCoachSteps, setDismissedCoachSteps] = useState<
    DictationCoachStep[]
  >([]);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reprocessModePreset, setReprocessModePreset] =
    useState<DictationModePreset>(DEFAULT_DICTATION_MODE);
  const [reprocessedResult, setReprocessedResult] =
    useState<DictationReprocessResult | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const [currentDictationProvider, setCurrentDictationProvider] = useState<
    string | null
  >(null);
  const [currentDictationModelId, setCurrentDictationModelId] = useState<
    string | null
  >(null);
  const [currentMeetingProvider, setCurrentMeetingProvider] = useState<
    string | null
  >(null);
  const [useSharedAsrSelection, setUseSharedAsrSelection] = useState(true);
  const [currentAiProvider, setCurrentAiProvider] = useState<string | null>(
    null,
  );
  const [currentAiModelId, setCurrentAiModelId] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const modeDefinitionById = useMemo(
    () =>
      DICTATION_MODE_DEFINITIONS.reduce<
        Record<DictationModePreset, DictationModeDefinition>
      >(
        (acc, definition) => {
          acc[definition.id] = definition;
          return acc;
        },
        {} as Record<DictationModePreset, DictationModeDefinition>,
      ),
    [],
  );

  useEffect(() => {
    return () => {
      stopSpeakingText();
    };
  }, []);

  const toggleReadAloudPlayback = (text: string, target: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (activeSpeechTarget === target) {
      stopSpeakingText();
      setActiveSpeechTarget(null);
      setPasteStatus("Stopped read aloud");
      return;
    }

    setPasteStatus(null);
    setActiveSpeechTarget(target);
    const started = speakTextAloud(trimmed, {
      onEnd: () =>
        setActiveSpeechTarget((current) =>
          current === target ? null : current,
        ),
      onError: () => setPasteStatus("Read aloud unavailable"),
    });

    if (!started) {
      setActiveSpeechTarget(null);
      setPasteStatus("Read aloud not supported here");
    }
  };

  const handleReadSelectedText = async () => {
    if (activeSpeechTarget === "selected-text") {
      stopSpeakingText();
      setActiveSpeechTarget(null);
      setPasteStatus("Stopped playback");
      return;
    }

    setPasteStatus(null);

    try {
      const selectedText = await captureSelectedTextForPlayback();
      const trimmed = selectedText?.trim();
      if (!trimmed) {
        setPasteStatus("No selected text found");
        return;
      }

      toggleReadAloudPlayback(trimmed, "selected-text");
    } catch (error) {
      setPasteStatus(
        error instanceof Error
          ? error.message
          : "Couldn't read the selected text",
      );
    }
  };

  const selectedCustomMode = useMemo(
    () =>
      selectedCustomModeId
        ? (dictationCustomModes.find(
            (mode) => mode.id === selectedCustomModeId,
          ) ?? null)
        : null,
    [dictationCustomModes, selectedCustomModeId],
  );

  const activeLaneId = useMemo(() => {
    if (
      dictationModePreset === "custom" &&
      selectedCustomModeId === "builtin-coding-copilot"
    ) {
      return "coding";
    }
    if (
      dictationModePreset === "custom" &&
      selectedCustomModeId === "builtin-quiet-focus"
    ) {
      return "quiet";
    }
    switch (dictationModePreset) {
      case "messages":
        return "messages";
      case "meeting_follow_up":
        return "follow_up";
      case "email":
      case "notes":
        return "writing";
      default:
        return "everywhere";
    }
  }, [dictationModePreset, selectedCustomModeId]);

  const activeLane = useMemo(
    () => SOLO_LANES.find((lane) => lane.id === activeLaneId) ?? SOLO_LANES[0],
    [activeLaneId],
  );

  const dictationPhaseSummary = useMemo(
    () =>
      getDictationPhaseSummary(
        dictationPhase,
        dictationPhaseMessage,
        dictationPhasePreview,
      ),
    [dictationPhase, dictationPhaseMessage, dictationPhasePreview],
  );

  const isDictationCaptureLive =
    dictationPhase === "primed" || dictationPhase === "recording";
  const isDictationBusy =
    dictationPhase === "primed" ||
    dictationPhase === "recording" ||
    dictationPhase === "stopping" ||
    dictationPhase === "transcribing" ||
    dictationPhase === "delivering";

  const smartContextSummary = useMemo(
    () => describeSmartContextState(activationMatcher, appTarget, contextChars),
    [activationMatcher, appTarget, contextChars],
  );

  const dictionaryCoverageSummary = useMemo(() => {
    const enabledEntries = dictationDictionaryEntries.filter(
      (entry) => entry.enabled,
    ).length;
    const scopedEntries = dictationDictionaryEntries.filter(
      (entry) => entry.enabled && entry.appScope?.trim(),
    ).length;
    if (enabledEntries === 0) {
      return "No custom words yet. Add names, brands, and recurring terms Plainsong should always get right.";
    }
    return `${enabledEntries} active dictionary entr${enabledEntries === 1 ? "y" : "ies"}${
      scopedEntries > 0 ? ` · ${scopedEntries} app-specific` : ""
    }.`;
  }, [dictationDictionaryEntries]);

  const activeCoachCards = useMemo(() => {
    return DICTATION_COACH_CARDS.filter((card) => {
      if (dismissedCoachSteps.includes(card.id)) {
        return false;
      }
      if (card.id === "dictionary") {
        return dictationDictionaryEntries.length < 3;
      }
      if (card.id === "command_mode") {
        return !dictationCommandModeEnabled;
      }
      if (card.id === "profiles") {
        return dictationCustomModes.length < 2;
      }
      return true;
    }).slice(0, 2);
  }, [
    dictationCommandModeEnabled,
    dictationCustomModes.length,
    dictationDictionaryEntries.length,
    dismissedCoachSteps,
  ]);

  const activeModeSummary = useMemo(
    () =>
      summarizeMode({
        profile: dictationProfile,
        routePreference: dictationRoutePreference,
        insertionMode: dictationInsertionMode,
        contextSource: dictationContextSource,
        saveToInbox,
        copyToClipboard: dictationCopyToClipboard,
        commandModeEnabled: dictationCommandModeEnabled,
        dictationProvider: currentDictationProvider,
        dictationModelId: currentDictationModelId,
        aiProvider: currentAiProvider,
        aiModelId: currentAiModelId,
        activationAppMatcher: selectedCustomMode?.activationAppMatcher ?? null,
        activationDomainMatcher:
          selectedCustomMode?.activationDomainMatcher ?? null,
        languageOverride:
          selectedCustomMode?.languageOverride ??
          (dictationSessionLanguage !== "auto"
            ? dictationSessionLanguage
            : null),
        livePreviewEnabled: dictationLivePreviewEnabled,
      }),
    [
      currentAiModelId,
      currentAiProvider,
      currentDictationModelId,
      currentDictationProvider,
      dictationRoutePreference,
      dictationCommandModeEnabled,
      dictationContextSource,
      dictationCopyToClipboard,
      dictationInsertionMode,
      dictationLivePreviewEnabled,
      dictationProfile,
      saveToInbox,
      selectedCustomMode?.activationAppMatcher,
      selectedCustomMode?.activationDomainMatcher,
      selectedCustomMode?.languageOverride,
      dictationSessionLanguage,
    ],
  );
  const effectiveCaptureLanguage = useMemo(() => {
    const profileLanguage = customModeDraft.languageOverride.trim();
    if (dictationModePreset === "custom" && profileLanguage) {
      return profileLanguage;
    }
    if (dictationSessionLanguage !== "auto") {
      return dictationSessionLanguage;
    }
    return dictationActiveLanguages.length === 1
      ? dictationActiveLanguages[0]
      : null;
  }, [
    customModeDraft.languageOverride,
    dictationActiveLanguages,
    dictationModePreset,
    dictationSessionLanguage,
  ]);
  const groupedCorrectionSuggestions = useMemo<
    CorrectionSuggestionGroup[]
  >(() => {
    const groups = new Map<string, CorrectionSuggestionGroup>();
    for (const suggestion of dictationCorrectionSuggestions) {
      const key = [
        suggestion.spokenForm.trim().toLowerCase(),
        suggestion.replacement.trim(),
        suggestion.appTarget?.trim().toLowerCase() ?? "",
      ].join("::");
      const existing = groups.get(key);
      if (existing) {
        existing.suggestionIds.push(suggestion.id);
        if (
          new Date(suggestion.updatedAt).getTime() >
          new Date(existing.updatedAt).getTime()
        ) {
          existing.updatedAt = suggestion.updatedAt;
          existing.sampleOriginalText = suggestion.originalText;
          existing.sampleCorrectedText = suggestion.correctedText;
        }
      } else {
        groups.set(key, {
          key,
          suggestionIds: [suggestion.id],
          spokenForm: suggestion.spokenForm,
          replacement: suggestion.replacement,
          appTarget: suggestion.appTarget,
          updatedAt: suggestion.updatedAt,
          sampleOriginalText: suggestion.originalText,
          sampleCorrectedText: suggestion.correctedText,
        });
      }
    }

    return Array.from(groups.values()).sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() -
        new Date(left.updatedAt).getTime(),
    );
  }, [dictationCorrectionSuggestions]);

  const inferModePreset = (values: {
    profile: "normal_speed" | "power_rewrite";
    insertionMode: DictationInsertionMode;
    contextSource: DictationContextSource;
    saveToInbox: boolean;
    copyToClipboard: boolean;
    commandModeEnabled: boolean;
  }): DictationModePreset => {
    const matched = DICTATION_MODE_DEFINITIONS.find((definition) => {
      if (definition.id === "custom") return false;
      return (
        definition.profile === values.profile &&
        definition.insertionMode === values.insertionMode &&
        definition.contextSource === values.contextSource &&
        definition.saveToInbox === values.saveToInbox &&
        definition.copyToClipboard === values.copyToClipboard &&
        definition.commandModeEnabled === values.commandModeEnabled
      );
    });

    return matched?.id ?? "custom";
  };

  useEffect(() => {
    try {
      const storage = getSafeLocalStorage();
      if (!storage) {
        return;
      }
      const raw = storage.getItem("nautilus-dictation-coach-dismissed");
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setDismissedCoachSteps(
          parsed.filter((value): value is DictationCoachStep =>
            ["backtrack", "dictionary", "command_mode", "profiles"].includes(
              String(value),
            ),
          ),
        );
      }
    } catch (error) {
      console.warn("Failed to restore dictation coach state:", error);
    }
  }, []);

  useEffect(() => {
    try {
      const storage = getSafeLocalStorage();
      if (!storage) {
        return;
      }
      storage.setItem(
        "nautilus-dictation-coach-dismissed",
        JSON.stringify(dismissedCoachSteps),
      );
    } catch (error) {
      console.warn("Failed to persist dictation coach state:", error);
    }
  }, [dismissedCoachSteps]);

  useEffect(() => {
    if (!isDialogOpen || !selectedRecording) {
      setSelectedTranscript(null);
      setSelectedHistoryDetails(null);
      setReprocessedResult(null);
      setReprocessError(null);
      setHistoryCorrectionText("");
      setHistoryCorrectionBaseline("");
      setHistoryLearnStatus(null);
      return;
    }
    setIsLoadingTranscript(true);
    setReprocessedResult(null);
    setReprocessError(null);
    setReprocessModePreset(
      dictationModePreset === "custom"
        ? (selectedCustomMode?.baseModePreset ?? DEFAULT_BASE_MODE)
        : dictationModePreset,
    );
    const fetchTranscript = async () => {
      try {
        const [transcript, historyDetails] = await Promise.all([
          getTranscript(selectedRecording.id),
          getDictationHistoryDetails(selectedRecording.id),
        ]);
        setSelectedTranscript(transcript);
        setSelectedHistoryDetails(historyDetails);
        const transcriptText = transcript?.fullText ?? "";
        setHistoryCorrectionText(transcriptText);
        setHistoryCorrectionBaseline(transcriptText);
        setHistoryLearnStatus(null);
        if (historyDetails?.baseModePreset) {
          setReprocessModePreset(
            coerceBaseModePreset(historyDetails.baseModePreset),
          );
        } else if (historyDetails?.modePreset) {
          setReprocessModePreset(
            coerceBaseModePreset(historyDetails.modePreset),
          );
        }
      } catch (error) {
        console.error("Failed to fetch transcript:", error);
        setSelectedTranscript(null);
        setSelectedHistoryDetails(null);
      } finally {
        setIsLoadingTranscript(false);
      }
    };
    void fetchTranscript();
  }, [
    dictationModePreset,
    isDialogOpen,
    selectedCustomMode?.baseModePreset,
    selectedRecording,
  ]);

  const dictationHistory = useMemo(
    () =>
      recordings
        .filter((recording) => recording.sourceType === "dictation")
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
    [recordings],
  );
  const recoveryState = useMemo(
    () => describeDictationRecoveryState(fallbackStatus, pasteStatus),
    [fallbackStatus, pasteStatus],
  );
  const deliveryDoctor = useMemo<DeliveryDoctorSummary | null>(() => {
    const hasTelemetry =
      Boolean(lastProvider) ||
      Boolean(lastModelId) ||
      Boolean(lastResolvedHosting) ||
      Boolean(lastRoutePreference) ||
      Boolean(lastResolvedRoute) ||
      Boolean(lastProviderModelLabel) ||
      Boolean(insertionModeUsed) ||
      Boolean(commandApplied) ||
      snippetAppliedCount > 0 ||
      Boolean(appTarget) ||
      Boolean(activationMatcher) ||
      contextChars !== null ||
      startupLatencyMs !== null ||
      latencyMs !== null ||
      insertLatencyMs !== null ||
      endToEndMs !== null ||
      Boolean(fallbackStatus) ||
      Boolean(pasteStatus);

    if (!hasTelemetry) {
      return null;
    }

    const fallback = fallbackStatus?.trim() ?? "";
    const paste = pasteStatus?.trim() ?? "";
    const combined = `${fallback} ${paste}`.toLowerCase();
    const insertionNeedsAttention =
      combined.includes("accessibility") ||
      combined.includes("cursor insertion") ||
      combined.includes("paste") ||
      combined.includes("clipboard") ||
      combined.includes("frontmost");
    const routeNeedsAttention =
      combined.includes("fallback") ||
      combined.includes("provider") ||
      combined.includes("model") ||
      combined.includes("route");
    const tone: DeliveryDoctorTone = insertionNeedsAttention
      ? "attention"
      : routeNeedsAttention
        ? "warning"
        : "ready";
    const nextAction = insertionNeedsAttention
      ? "Verify the target app is focused, then switch this app to Clipboard only if automatic delivery keeps failing."
      : routeNeedsAttention
        ? "Download or enable the requested local model, or choose the route that actually completed this session."
        : "Use this route and insertion mode as the known-good baseline for the next app-matrix run.";

    const items: DeliveryDoctorItem[] = [
      appTarget ? { label: "Target app", value: appTarget } : null,
      insertionModeUsed
        ? {
            label: "Delivery",
            value: formatInsertionModeLabel(insertionModeUsed) ?? insertionModeUsed,
          }
        : null,
      lastResolvedHosting
        ? {
            label: "Resolved route",
            value: lastResolvedHosting === "cloud" ? "Cloud" : "Local",
          }
        : null,
      lastRoutePreference
        ? {
            label: "Requested route",
            value: lastRoutePreference === "cloud" ? "Cloud" : "Local",
          }
        : null,
      lastResolvedRoute ? { label: "Route id", value: lastResolvedRoute } : null,
      lastProviderModelLabel
        ? { label: "Route label", value: lastProviderModelLabel }
        : null,
      lastProvider ? { label: "Engine", value: lastProvider } : null,
      lastModelId ? { label: "Model", value: lastModelId } : null,
      endToEndMs !== null
        ? { label: "End to end", value: formatDurationMetric(endToEndMs) ?? "" }
        : null,
      latencyMs !== null
        ? { label: "Transcription", value: formatDurationMetric(latencyMs) ?? "" }
        : null,
      insertLatencyMs !== null
        ? { label: "Insert", value: formatDurationMetric(insertLatencyMs) ?? "" }
        : null,
      startupLatencyMs !== null
        ? { label: "Start", value: formatDurationMetric(startupLatencyMs) ?? "" }
        : null,
      commandApplied
        ? {
            label: "Command",
            value:
              formatAppliedDictationCommandLabel(commandApplied) ??
              commandApplied,
          }
        : null,
      snippetAppliedCount > 0
        ? { label: "Snippets", value: String(snippetAppliedCount) }
        : null,
      activationMatcher ? { label: "Auto mode", value: activationMatcher } : null,
      contextChars !== null && contextChars > 0
        ? { label: "Context", value: `${contextChars} chars` }
        : null,
    ].filter((item): item is DeliveryDoctorItem => Boolean(item));

    return {
      tone,
      title:
        tone === "ready"
          ? "Delivery doctor: ready baseline"
          : tone === "warning"
            ? "Delivery doctor: route needs review"
            : "Delivery doctor: insertion needs review",
      detail:
        paste ||
        fallback ||
        "Latest dictation has the route, delivery path, and timing needed for launch evidence.",
      nextAction,
      items,
    };
  }, [
    activationMatcher,
    appTarget,
    commandApplied,
    contextChars,
    endToEndMs,
    fallbackStatus,
    insertLatencyMs,
    insertionModeUsed,
    lastModelId,
    lastProvider,
    lastProviderModelLabel,
    lastResolvedHosting,
    lastResolvedRoute,
    lastRoutePreference,
    latencyMs,
    pasteStatus,
    snippetAppliedCount,
    startupLatencyMs,
  ]);

  const refreshDictationInsights = async () => {
    try {
      const nextInsights = await getDictationInsights();
      setDictationInsights(nextInsights);
    } catch (error) {
      console.warn("Failed to load dictation insights:", error);
      setDictationInsights(null);
    }
  };

  useEffect(() => {
    let mounted = true;
    void refreshDictationInsights();
    void getSettings()
      .then((settings) => {
        if (!mounted) return;
        const nextSaveToInbox = settings.transcription.dictationSaveToInbox;
        const nextProfile = settings.transcription.dictationProfile;
        const nextCopyToClipboard =
          settings.transcription.dictationCopyToClipboard ?? true;
        const nextCommandModeEnabled =
          settings.transcription.dictationCommandModeEnabled ?? true;
        const nextRoutePreference =
          settings.transcription.dictationRoutePreference === "cloud"
            ? "cloud"
            : "local";
        const nextContextSource =
          (settings.transcription.dictationContextSource as
            | DictationContextSource
            | undefined) ?? "none";
        const nextInsertionMode =
          (settings.transcription.dictationInsertionMode as
            | DictationInsertionMode
            | undefined) ?? "auto";
        const nextModePreset =
          settings.transcription.dictationModePreset ??
          inferModePreset({
            profile: nextProfile,
            insertionMode: nextInsertionMode,
            contextSource: nextContextSource,
            saveToInbox: nextSaveToInbox,
            copyToClipboard: nextCopyToClipboard,
            commandModeEnabled: nextCommandModeEnabled,
          });
        setSaveToInbox(nextSaveToInbox);
        setDictationProfile(nextProfile);
        setDictationModePreset(nextModePreset);
        setDictationCustomModes(
          settings.transcription.dictationCustomModes ?? [],
        );
        setSelectedCustomModeId(
          settings.transcription.dictationSelectedCustomModeId ?? null,
        );
        setCurrentDictationProvider(
          settings.transcription.dictationProvider ??
            settings.transcription.defaultProvider ??
            null,
        );
        setCurrentDictationModelId(
          settings.transcription.dictationModelId ??
            settings.transcription.selectedModelId ??
            null,
        );
        setCurrentMeetingProvider(
          settings.transcription.meetingProvider ?? null,
        );
        setUseSharedAsrSelection(
          settings.transcription.useSharedAsrSelection ?? true,
        );
        setCurrentAiProvider(settings.privacy.llmProvider ?? null);
        setCurrentAiModelId(settings.privacy.llmModelId ?? null);
        setDefaultProjectId(
          settings.transcription.dictationProjectId || "inbox",
        );
        setDictationPushToTalk(settings.transcription.dictationPushToTalk);
        setDictationHandsFreeEnabled(
          settings.transcription.dictationHandsFreeEnabled ?? false,
        );
        setDictationRoutePreference(nextRoutePreference);
        setDictationRouteOverrideEnabled(
          settings.transcription.dictationRouteOverrideEnabled ?? true,
        );
        setDictationKeepWarm(
          settings.transcription.dictationKeepWarm ?? "short",
        );
        setDictationLivePreviewEnabled(
          settings.transcription.dictationLivePreviewEnabled ?? true,
        );
        setDictationContextSource(nextContextSource);
        setDictationCopyToClipboard(nextCopyToClipboard);
        setDictationCommandModeEnabled(nextCommandModeEnabled);
        setDictationCommandPrefix(
          settings.transcription.dictationCommandPrefix ?? "command",
        );
        setDictationInsertionMode(nextInsertionMode);
        setDictationSessionLanguage(settings.transcription.language ?? "auto");
        setDictationActiveLanguages(
          normalizeActiveLanguageSet(
            settings.transcription.dictationActiveLanguages ?? [],
          ),
        );
        setDictationSnippetsEnabled(
          settings.transcription.dictationSnippetsEnabled ?? true,
        );
        setDictationAutoLearnCorrections(
          settings.transcription.dictationAutoLearnCorrections ?? true,
        );
        setDictationSilenceTimeoutSeconds(
          settings.transcription.dictationSilenceTimeoutSeconds ?? 0,
        );
        setDictationRetentionPreset(
          settings.transcription.dictationRetentionPreset ?? "never",
        );
        setDictationRetentionCustomHours(
          settings.transcription.dictationRetentionCustomHours ?? 24,
        );
        const shortcut = settings.shortcuts.toggleDictation || defaultShortcut;
        setHotkeyLabel(formatShortcutForDisplay(shortcut));
        setHotkeyShortcut(shortcut);
      })
      .catch((error) => {
        console.warn("Failed to load dictation preferences:", error);
      });
    return () => {
      mounted = false;
    };
  }, [defaultShortcut]);

  useEffect(() => {
    let mounted = true;
    void listDictationDictionaryEntries()
      .then((entries) => {
        if (mounted) {
          setDictationDictionaryEntries(entries);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation dictionary entries:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void listDictationCorrectionSuggestions()
      .then((suggestions) => {
        if (mounted) {
          setDictationCorrectionSuggestions(suggestions);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation correction suggestions:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void listDictationSnippets()
      .then((snippets) => {
        if (mounted) {
          setDictationSnippets(snippets);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation snippets:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void listDictationCommandPresets()
      .then((presets) => {
        if (mounted) {
          setDictationCommandPresets(presets);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation command presets:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const persistDictationPreferences = async (
    updates: Partial<{
      saveToInbox: boolean;
      profile: "normal_speed" | "power_rewrite";
      modePreset: DictationModePreset;
      selectedCustomModeId: string | null;
      customModes: DictationCustomMode[];
      contextSource: DictationContextSource;
      projectId: string;
      pushToTalk: boolean;
      handsFreeEnabled: boolean;
      routePreference: DictationRoutePreference;
      routeOverrideEnabled: boolean;
      keepWarm: "off" | "short" | "long";
      livePreviewEnabled: boolean;
      copyToClipboard: boolean;
      commandModeEnabled: boolean;
      commandPrefix: string;
      insertionMode: DictationInsertionMode;
      sessionLanguage: string | null;
      activeLanguages: string[];
      snippetsEnabled: boolean;
      autoLearnCorrections: boolean;
      silenceTimeoutSeconds: number;
      retentionPreset: "immediate" | "24h" | "72h" | "never" | "custom";
      retentionCustomHours: number;
    }>,
  ) => {
    try {
      const settings = await getSettings();
      const nextSaveToInbox = updates.saveToInbox ?? saveToInbox;
      const nextProfile = updates.profile ?? dictationProfile;
      const nextCustomModes = updates.customModes ?? dictationCustomModes;
      const nextContextSource = updates.contextSource ?? dictationContextSource;
      const nextRoutePreference =
        updates.routePreference ?? dictationRoutePreference;
      const nextRouteOverrideEnabled =
        updates.routeOverrideEnabled ?? dictationRouteOverrideEnabled;
      const nextHandsFreeEnabled =
        updates.handsFreeEnabled ?? dictationHandsFreeEnabled;
      const nextKeepWarm = updates.keepWarm ?? dictationKeepWarm;
      const nextLivePreviewEnabled =
        updates.livePreviewEnabled ?? dictationLivePreviewEnabled;
      const nextCopyToClipboard =
        updates.copyToClipboard ?? dictationCopyToClipboard;
      const nextCommandModeEnabled =
        updates.commandModeEnabled ?? dictationCommandModeEnabled;
      const nextInsertionMode = updates.insertionMode ?? dictationInsertionMode;
      const nextSessionLanguage =
        updates.sessionLanguage !== undefined
          ? updates.sessionLanguage
          : dictationSessionLanguage === "auto"
            ? null
            : dictationSessionLanguage;
      const nextActiveLanguages =
        updates.activeLanguages !== undefined
          ? normalizeActiveLanguageSet(updates.activeLanguages)
          : dictationActiveLanguages;
      const nextAutoLearnCorrections =
        updates.autoLearnCorrections ?? dictationAutoLearnCorrections;
      const nextSilenceTimeoutSeconds = normalizeDictationSilenceTimeoutSeconds(
        updates.silenceTimeoutSeconds ?? dictationSilenceTimeoutSeconds,
      );
      const nextModePreset =
        updates.modePreset ??
        inferModePreset({
          profile: nextProfile,
          insertionMode: nextInsertionMode,
          contextSource: nextContextSource,
          saveToInbox: nextSaveToInbox,
          copyToClipboard: nextCopyToClipboard,
          commandModeEnabled: nextCommandModeEnabled,
        });

      settings.transcription.dictationSaveToInbox = nextSaveToInbox;
      settings.transcription.dictationProfile = nextProfile;
      settings.transcription.dictationModePreset = nextModePreset;
      settings.transcription.dictationSelectedCustomModeId =
        updates.selectedCustomModeId ?? null;
      settings.transcription.dictationCustomModes = nextCustomModes;
      settings.transcription.dictationContextSource = nextContextSource;
      settings.transcription.dictationRoutePreference = nextRoutePreference;
      settings.transcription.dictationRouteOverrideEnabled =
        nextRouteOverrideEnabled;
      settings.transcription.dictationKeepWarm = nextKeepWarm;
      settings.transcription.dictationLivePreviewEnabled =
        nextLivePreviewEnabled;
      settings.transcription.dictationProjectId =
        updates.projectId ?? defaultProjectId;
      settings.transcription.dictationPushToTalk =
        updates.pushToTalk ?? dictationPushToTalk;
      settings.transcription.dictationHandsFreeEnabled = nextHandsFreeEnabled;
      settings.transcription.dictationCopyToClipboard = nextCopyToClipboard;
      settings.transcription.dictationCommandModeEnabled =
        nextCommandModeEnabled;
      settings.transcription.dictationCommandPrefix =
        updates.commandPrefix ?? dictationCommandPrefix;
      settings.transcription.dictationInsertionMode = nextInsertionMode;
      settings.transcription.language = nextSessionLanguage;
      settings.transcription.dictationActiveLanguages = nextActiveLanguages;
      settings.transcription.dictationSnippetsEnabled =
        updates.snippetsEnabled ?? dictationSnippetsEnabled;
      settings.transcription.dictationAutoLearnCorrections =
        nextAutoLearnCorrections;
      settings.transcription.dictationSilenceTimeoutSeconds =
        nextSilenceTimeoutSeconds;
      settings.transcription.dictationRetentionPreset =
        updates.retentionPreset ?? dictationRetentionPreset;
      settings.transcription.dictationRetentionCustomHours =
        updates.retentionCustomHours ?? dictationRetentionCustomHours;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist dictation preferences:", error);
    }
  };

  const applyDictationMode = (modeId: DictationModePreset) => {
    setDictationModePreset(modeId);
    setSelectedCustomModeId(null);
    const definition = modeDefinitionById[modeId];
    if (!definition || modeId === "custom") {
      setCustomModeDraft((current) => ({
        ...current,
        baseModePreset:
          dictationModePreset === "custom"
            ? current.baseModePreset
            : coerceBaseModePreset(dictationModePreset),
      }));
      void persistDictationPreferences({
        modePreset: modeId,
        selectedCustomModeId: null,
      });
      return;
    }

    const nextProfile = definition.profile ?? dictationProfile;
    const nextInsertionMode =
      definition.insertionMode ?? dictationInsertionMode;
    const nextContextSource =
      definition.contextSource ?? dictationContextSource;
    const nextSaveToInbox = definition.saveToInbox ?? saveToInbox;
    const nextCopyToClipboard =
      definition.copyToClipboard ?? dictationCopyToClipboard;
    const nextCommandModeEnabled =
      definition.commandModeEnabled ?? dictationCommandModeEnabled;

    setDictationProfile(nextProfile);
    setDictationInsertionMode(nextInsertionMode);
    setDictationContextSource(nextContextSource);
    setSaveToInbox(nextSaveToInbox);
    setDictationCopyToClipboard(nextCopyToClipboard);
    setDictationCommandModeEnabled(nextCommandModeEnabled);

    void persistDictationPreferences({
      modePreset: modeId,
      selectedCustomModeId: null,
      profile: nextProfile,
      insertionMode: nextInsertionMode,
      contextSource: nextContextSource,
      saveToInbox: nextSaveToInbox,
      copyToClipboard: nextCopyToClipboard,
      commandModeEnabled: nextCommandModeEnabled,
    });
  };

  const syncModePreset = (
    overrides: Partial<{
      profile: "normal_speed" | "power_rewrite";
      insertionMode: DictationInsertionMode;
      contextSource: DictationContextSource;
      saveToInbox: boolean;
      copyToClipboard: boolean;
      commandModeEnabled: boolean;
    }> = {},
  ) => {
    const nextModePreset = inferModePreset({
      profile: overrides.profile ?? dictationProfile,
      insertionMode: overrides.insertionMode ?? dictationInsertionMode,
      contextSource: overrides.contextSource ?? dictationContextSource,
      saveToInbox: overrides.saveToInbox ?? saveToInbox,
      copyToClipboard: overrides.copyToClipboard ?? dictationCopyToClipboard,
      commandModeEnabled:
        overrides.commandModeEnabled ?? dictationCommandModeEnabled,
    });
    setDictationModePreset(nextModePreset);
    if (nextModePreset === "custom") {
      setSelectedCustomModeId(null);
    } else {
      setSelectedCustomModeId(null);
    }
    return nextModePreset;
  };

  const buildCurrentCustomMode = (
    overrides?: Partial<DictationCustomMode>,
  ): DictationCustomMode => ({
    id:
      overrides?.id ??
      selectedCustomModeId ??
      `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: (overrides?.name ?? customModeDraft.name).trim() || "Custom Mode",
    description: (overrides?.description ?? customModeDraft.description).trim(),
    baseModePreset:
      overrides?.baseModePreset ??
      (dictationModePreset === "custom"
        ? (selectedCustomMode?.baseModePreset ?? customModeDraft.baseModePreset)
        : coerceBaseModePreset(dictationModePreset)),
    customPrompt:
      overrides?.customPrompt ?? (customModeDraft.customPrompt.trim() || null),
    profile: overrides?.profile ?? dictationProfile,
    routePreference: overrides?.routePreference ?? dictationRoutePreference,
    languageOverride:
      overrides?.languageOverride ??
      (customModeDraft.languageOverride.trim() || null),
    livePreviewEnabled:
      overrides?.livePreviewEnabled ?? customModeDraft.livePreviewEnabled,
    insertionMode: overrides?.insertionMode ?? dictationInsertionMode,
    contextSource: overrides?.contextSource ?? dictationContextSource,
    saveToInbox: overrides?.saveToInbox ?? saveToInbox,
    copyToClipboard: overrides?.copyToClipboard ?? dictationCopyToClipboard,
    commandModeEnabled:
      overrides?.commandModeEnabled ?? dictationCommandModeEnabled,
    dictationProvider: overrides?.dictationProvider ?? currentDictationProvider,
    dictationModelId: overrides?.dictationModelId ?? currentDictationModelId,
    aiProvider: overrides?.aiProvider ?? currentAiProvider,
    aiModelId: overrides?.aiModelId ?? currentAiModelId,
    activationAppMatcher:
      overrides?.activationAppMatcher ??
      (customModeDraft.activationAppMatcher.trim() || null),
    activationDomainMatcher:
      overrides?.activationDomainMatcher ??
      (customModeDraft.activationDomainMatcher.trim() || null),
  });

  const applySavedCustomMode = (mode: DictationCustomMode) => {
    setDictationModePreset("custom");
    setSelectedCustomModeId(mode.id);
    setCustomModeDraft(
      createCustomModeDraft({
        name: mode.name,
        description: mode.description,
        baseModePreset: mode.baseModePreset ?? DEFAULT_BASE_MODE,
        customPrompt: mode.customPrompt ?? "",
        activationAppMatcher: mode.activationAppMatcher ?? "",
        activationDomainMatcher: mode.activationDomainMatcher ?? "",
        languageOverride: mode.languageOverride ?? "",
        livePreviewEnabled:
          mode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      }),
    );
    setDictationProfile(mode.profile);
    setDictationRoutePreference(
      mode.routePreference ?? dictationRoutePreference,
    );
    setDictationInsertionMode(mode.insertionMode);
    setDictationContextSource(mode.contextSource);
    setDictationLivePreviewEnabled(
      mode.livePreviewEnabled ?? dictationLivePreviewEnabled,
    );
    setSaveToInbox(mode.saveToInbox);
    setDictationCopyToClipboard(mode.copyToClipboard);
    setDictationCommandModeEnabled(mode.commandModeEnabled);
    setCurrentDictationProvider(
      mode.dictationProvider ?? currentDictationProvider,
    );
    setCurrentDictationModelId(
      mode.dictationModelId ?? currentDictationModelId,
    );
    setCurrentAiProvider(mode.aiProvider ?? currentAiProvider);
    setCurrentAiModelId(mode.aiModelId ?? currentAiModelId);
    void persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: mode.id,
      profile: mode.profile,
      routePreference: mode.routePreference ?? dictationRoutePreference,
      livePreviewEnabled:
        mode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      insertionMode: mode.insertionMode,
      contextSource: mode.contextSource,
      saveToInbox: mode.saveToInbox,
      copyToClipboard: mode.copyToClipboard,
      commandModeEnabled: mode.commandModeEnabled,
    });
    void (async () => {
      try {
        const settings = await getSettings();
        settings.transcription.dictationModePreset = "custom";
        settings.transcription.dictationSelectedCustomModeId = mode.id;
        settings.transcription.dictationProfile = mode.profile;
        settings.transcription.dictationInsertionMode = mode.insertionMode;
        settings.transcription.dictationContextSource = mode.contextSource;
        settings.transcription.dictationSaveToInbox = mode.saveToInbox;
        settings.transcription.dictationCopyToClipboard = mode.copyToClipboard;
        settings.transcription.dictationCommandModeEnabled =
          mode.commandModeEnabled;
        if (mode.dictationProvider)
          settings.transcription.dictationProvider = mode.dictationProvider;
        if (mode.dictationModelId)
          settings.transcription.dictationModelId = mode.dictationModelId;
        settings.transcription.dictationRoutePreference =
          mode.routePreference ??
          settings.transcription.dictationRoutePreference ??
          "local";
        settings.transcription.dictationLivePreviewEnabled =
          mode.livePreviewEnabled ??
          settings.transcription.dictationLivePreviewEnabled;
        if (mode.aiProvider) settings.privacy.llmProvider = mode.aiProvider;
        settings.privacy.llmModelId =
          mode.aiModelId ?? settings.privacy.llmModelId ?? null;
        await saveSettings(settings);
      } catch (error) {
        console.warn("Failed to apply custom mode engine settings:", error);
      }
    })();
  };

  const handleSaveCustomMode = async (saveAsNew = false) => {
    const nextMode = buildCurrentCustomMode({
      id: saveAsNew ? undefined : (selectedCustomModeId ?? undefined),
    });
    const nextModes = saveAsNew
      ? [...dictationCustomModes, nextMode]
      : dictationCustomModes.some((mode) => mode.id === nextMode.id)
        ? dictationCustomModes.map((mode) =>
            mode.id === nextMode.id ? nextMode : mode,
          )
        : [...dictationCustomModes, nextMode];
    setDictationCustomModes(nextModes);
    setDictationModePreset("custom");
    setSelectedCustomModeId(nextMode.id);
    setCustomModeDraft(
      createCustomModeDraft({
        name: nextMode.name,
        description: nextMode.description,
        baseModePreset: nextMode.baseModePreset ?? DEFAULT_BASE_MODE,
        customPrompt: nextMode.customPrompt ?? "",
        activationAppMatcher: nextMode.activationAppMatcher ?? "",
        activationDomainMatcher: nextMode.activationDomainMatcher ?? "",
        languageOverride: nextMode.languageOverride ?? "",
        livePreviewEnabled:
          nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      }),
    );
    await persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: nextMode.id,
      customModes: nextModes,
      livePreviewEnabled:
        nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
    });
    try {
      const settings = await getSettings();
      settings.transcription.dictationModePreset = "custom";
      settings.transcription.dictationSelectedCustomModeId = nextMode.id;
      settings.transcription.dictationCustomModes = nextModes;
      settings.transcription.dictationProfile = nextMode.profile;
      settings.transcription.dictationInsertionMode = nextMode.insertionMode;
      settings.transcription.dictationContextSource = nextMode.contextSource;
      settings.transcription.dictationSaveToInbox = nextMode.saveToInbox;
      settings.transcription.dictationCopyToClipboard = nextMode.copyToClipboard;
      settings.transcription.dictationCommandModeEnabled =
        nextMode.commandModeEnabled;
      settings.transcription.dictationProvider =
        nextMode.dictationProvider ?? settings.transcription.dictationProvider;
      settings.transcription.dictationModelId =
        nextMode.dictationModelId ?? settings.transcription.dictationModelId;
      settings.transcription.dictationRoutePreference =
        nextMode.routePreference ??
        settings.transcription.dictationRoutePreference ??
        "local";
      settings.transcription.dictationLivePreviewEnabled =
        nextMode.livePreviewEnabled ??
        settings.transcription.dictationLivePreviewEnabled;
      settings.privacy.llmProvider =
        nextMode.aiProvider ?? settings.privacy.llmProvider;
      settings.privacy.llmModelId =
        nextMode.aiModelId ?? settings.privacy.llmModelId ?? null;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist custom mode engine snapshot:", error);
    }
  };

  const handleInstallRecommendedStyle = async (style: RecommendedAppStyle) => {
    const nextMode = buildCurrentCustomMode({
      id: style.id,
      name: style.name,
      description: style.description,
      baseModePreset: style.baseModePreset,
      customPrompt: style.customPrompt,
      profile: style.profile,
      routePreference: style.routePreference,
      insertionMode: style.insertionMode,
      contextSource: style.contextSource,
      saveToInbox: style.saveToInbox,
      copyToClipboard: style.copyToClipboard,
      commandModeEnabled: style.commandModeEnabled,
      activationAppMatcher: style.activationAppMatcher ?? null,
      activationDomainMatcher: style.activationDomainMatcher ?? null,
      livePreviewEnabled:
        style.livePreviewEnabled ?? dictationLivePreviewEnabled,
    });
    const nextModes = dictationCustomModes.some(
      (mode) => mode.id === nextMode.id,
    )
      ? dictationCustomModes.map((mode) =>
          mode.id === nextMode.id ? nextMode : mode,
        )
      : [...dictationCustomModes, nextMode];

    setDictationCustomModes(nextModes);
    setDictationModePreset("custom");
    setSelectedCustomModeId(nextMode.id);
    setCustomModeDraft(
      createCustomModeDraft({
        name: nextMode.name,
        description: nextMode.description,
        baseModePreset: nextMode.baseModePreset ?? DEFAULT_BASE_MODE,
        customPrompt: nextMode.customPrompt ?? "",
        activationAppMatcher: nextMode.activationAppMatcher ?? "",
        activationDomainMatcher: nextMode.activationDomainMatcher ?? "",
        languageOverride: nextMode.languageOverride ?? "",
        livePreviewEnabled:
          nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      }),
    );
    setDictationProfile(nextMode.profile);
    setDictationRoutePreference(
      nextMode.routePreference ?? dictationRoutePreference,
    );
    setDictationInsertionMode(nextMode.insertionMode);
    setDictationContextSource(nextMode.contextSource);
    setDictationLivePreviewEnabled(
      nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
    );
    setSaveToInbox(nextMode.saveToInbox);
    setDictationCopyToClipboard(nextMode.copyToClipboard);
    setDictationCommandModeEnabled(nextMode.commandModeEnabled);

    await persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: nextMode.id,
      customModes: nextModes,
      profile: nextMode.profile,
      routePreference: nextMode.routePreference ?? dictationRoutePreference,
      livePreviewEnabled:
        nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      insertionMode: nextMode.insertionMode,
      contextSource: nextMode.contextSource,
      saveToInbox: nextMode.saveToInbox,
      copyToClipboard: nextMode.copyToClipboard,
      commandModeEnabled: nextMode.commandModeEnabled,
    });

    try {
      const settings = await getSettings();
      settings.transcription.dictationModePreset = "custom";
      settings.transcription.dictationSelectedCustomModeId = nextMode.id;
      settings.transcription.dictationCustomModes = nextModes;
      settings.transcription.dictationProfile = nextMode.profile;
      settings.transcription.dictationInsertionMode = nextMode.insertionMode;
      settings.transcription.dictationContextSource = nextMode.contextSource;
      settings.transcription.dictationSaveToInbox = nextMode.saveToInbox;
      settings.transcription.dictationCopyToClipboard = nextMode.copyToClipboard;
      settings.transcription.dictationCommandModeEnabled =
        nextMode.commandModeEnabled;
      settings.transcription.dictationProvider =
        nextMode.dictationProvider ?? settings.transcription.dictationProvider;
      settings.transcription.dictationModelId =
        nextMode.dictationModelId ?? settings.transcription.dictationModelId;
      settings.transcription.dictationRoutePreference =
        nextMode.routePreference ??
        settings.transcription.dictationRoutePreference ??
        "local";
      settings.transcription.dictationLivePreviewEnabled =
        nextMode.livePreviewEnabled ??
        settings.transcription.dictationLivePreviewEnabled;
      settings.privacy.llmProvider =
        nextMode.aiProvider ?? settings.privacy.llmProvider;
      settings.privacy.llmModelId =
        nextMode.aiModelId ?? settings.privacy.llmModelId ?? null;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist recommended flow profile:", error);
    }
  };

  const handleDeleteCustomMode = async (modeId: string) => {
    const nextModes = dictationCustomModes.filter((mode) => mode.id !== modeId);
    setDictationCustomModes(nextModes);
    const shouldClearSelection = selectedCustomModeId === modeId;
    if (shouldClearSelection) {
      setSelectedCustomModeId(null);
      setCustomModeDraft(
        createCustomModeDraft({
          livePreviewEnabled: dictationLivePreviewEnabled,
        }),
      );
    }
    await persistDictationPreferences({
      selectedCustomModeId: shouldClearSelection ? null : selectedCustomModeId,
      customModes: nextModes,
    });
  };

  useEffect(() => {
    if (selectedCustomMode) {
      setCustomModeDraft(
        createCustomModeDraft({
          name: selectedCustomMode.name,
          description: selectedCustomMode.description,
          baseModePreset:
            selectedCustomMode.baseModePreset ?? DEFAULT_BASE_MODE,
          customPrompt: selectedCustomMode.customPrompt ?? "",
          activationAppMatcher: selectedCustomMode.activationAppMatcher ?? "",
          activationDomainMatcher:
            selectedCustomMode.activationDomainMatcher ?? "",
          languageOverride: selectedCustomMode.languageOverride ?? "",
          livePreviewEnabled:
            selectedCustomMode.livePreviewEnabled ??
            dictationLivePreviewEnabled,
        }),
      );
      return;
    }
    if (dictationModePreset === "custom") {
      setCustomModeDraft((current) => ({
        ...current,
        name: current.name || "Custom Mode",
      }));
    }
  }, [dictationLivePreviewEnabled, dictationModePreset, selectedCustomMode]);

  useEffect(() => {
    // Listen for hotkey visual feedback
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, hotkeyShortcut)) {
        setHotkeyPressed(true);

        // Clear any existing timeout
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        // Set new timeout
        timeoutRef.current = setTimeout(() => setHotkeyPressed(false), 200);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [hotkeyShortcut]);

  useEffect(() => {
    if (!dictationStateEvent) {
      return;
    }

    const payload = dictationStateEvent;
    setDictationPhase(payload.phase);
    setDictationPhaseMessage(payload.message ?? null);
    setDictationPhasePreview(payload.preview ?? payload.partialText ?? null);
    setDictationResolvedModeLabel(payload.resolvedModeLabel ?? null);
    setAppTarget(payload.appTarget ?? null);
    setActivationMatcher(payload.activationMatcher ?? null);
    if (payload.providerModelLabel) {
      setLastProviderModelLabel(payload.providerModelLabel);
    }
    if (payload.phase === "error") {
      setDictationError(payload.message ?? "Dictation failed.");
    }
  }, [dictationStateEvent]);

  useEffect(() => {
    if (!dictationTextReadyEvent) {
      return;
    }

    const payload = dictationTextReadyEvent;
    const text = payload.text ?? "";
    if (text) {
      setTranscribedText(text);
      setLatestCorrectionBaseline(text);
      setLatestLearnStatus(null);
      setDictationError(null);
    }
    if (payload.actualProvider) {
      setLastProvider(payload.actualProvider);
    }
    if (payload.fallbackMessage) {
      setFallbackStatus(payload.fallbackMessage);
    } else if (payload.isFallback === true) {
      const reason =
        payload.fallbackReason?.trim() ||
        "Requested provider could not complete transcription.";
      setFallbackStatus(
        `ASR fallback: requested '${payload.requestedProvider}' but used '${payload.actualProvider}'. ${reason}`,
      );
    } else {
      setFallbackStatus(null);
    }
    if (payload.modelId) {
      setLastModelId(payload.modelId);
    }
    setLastRoutePreference(payload.routePreference ?? null);
    setLastResolvedRoute(payload.resolvedRoute ?? null);
    setLastProviderModelLabel(payload.providerModelLabel ?? null);
    setLastResolvedHosting(payload.resolvedHosting ?? null);
    setStartupLatencyMs(payload.startupLatencyMs ?? null);
    setLatencyMs(payload.latencyMs ?? null);
    setInsertLatencyMs(payload.insertLatencyMs ?? null);
    setEndToEndMs(payload.endToEndMs ?? null);
    setInsertionModeUsed(payload.insertionModeUsed ?? null);
    setCommandApplied(payload.commandApplied ?? null);
    setSnippetAppliedCount(payload.snippetAppliedCount ?? 0);
    setAppTarget(payload.appTarget ?? null);
    setActivationMatcher(payload.activationMatcher ?? null);
    setContextChars(payload.contextChars ?? null);
    setDictationPhase("done");
    setDictationPhaseMessage(
      payload.pasted
        ? "Inserted into the target app and copied to the clipboard."
        : payload.copied
          ? "Copied to the clipboard and ready to paste."
          : "Result is ready to review.",
    );
    setDictationPhasePreview(text || null);
    if (payload.pasted) {
      setPasteStatus("Paste command sent (also copied to clipboard)");
    } else if (payload.copied) {
      setPasteStatus(payload.pasteError ?? "Copied to clipboard");
    } else if (payload.pasteError) {
      setPasteStatus(payload.pasteError);
    } else {
      setPasteStatus(null);
    }
    void refetchDictationHistory();
    void refreshDictationInsights();
  }, [dictationTextReadyEvent, refetchDictationHistory]);

  const handleStopDictation = async () => {
    try {
      const text = await stopDictation();
      if (text?.trim()) {
        setTranscribedText(text);
        setLatestCorrectionBaseline(text);
        setLatestLearnStatus(null);
        setDictationError(null);
        void refetchDictationHistory();
      } else {
        setDictationError(null);
      }
    } catch (error) {
      const message =
        sanitizeUserFacingDictationMessage(
          error instanceof Error ? error.message : String(error),
          { phase: "error" },
        ) ?? "Dictation failed.";
      setDictationError(message);
    }
  };

  const launchDictation = async () => {
    const routePreference =
      dictationRouteOverrideEnabled && nextCaptureRoutePreference
        ? nextCaptureRoutePreference
        : dictationRoutePreference;
    if (dictationRouteOverrideEnabled) {
      setNextCaptureRoutePreference(null);
    }
    setDictationError(null);
    try {
      await startDictation({
        saveToInbox,
        projectId: defaultProjectId,
        profile: dictationProfile,
        contextSource: dictationContextSource,
        routePreference,
        languageOverride: effectiveCaptureLanguage,
        livePreviewEnabled:
          dictationModePreset === "custom"
            ? customModeDraft.livePreviewEnabled
            : dictationLivePreviewEnabled,
      });
    } catch (error) {
      const message =
        sanitizeUserFacingDictationMessage(
          error instanceof Error ? error.message : String(error),
          { phase: "error" },
        ) ?? "Dictation failed.";
      setDictationPhase("error");
      setDictationPhaseMessage(message);
      setDictationPhasePreview(null);
      setDictationError(message);
    }
  };

  const dismissCoachCard = (step: DictationCoachStep) => {
    setDismissedCoachSteps((current) =>
      current.includes(step) ? current : [...current, step],
    );
  };

  const formatRecordingDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleAddSnippet = async () => {
    const trigger = newSnippetTrigger.trim();
    const expansion = newSnippetExpansion.trim();
    if (!trigger || !expansion) {
      return;
    }
    try {
      const created = await createDictationSnippet({
        trigger,
        expansion,
        appScope: newSnippetAppScope.trim() || null,
        caseSensitive: newSnippetCaseSensitive,
        enabled: true,
      });
      setDictationSnippets((prev) => [...prev, created]);
      setNewSnippetTrigger("");
      setNewSnippetExpansion("");
      setNewSnippetAppScope("");
      setNewSnippetCaseSensitive(false);
    } catch (error) {
      console.warn("Failed to create dictation snippet:", error);
    }
  };

  const handleAddDictionaryEntry = async () => {
    const spokenForm = newDictionarySpokenForm.trim();
    const replacement = newDictionaryReplacement.trim();
    if (!spokenForm || !replacement) {
      return;
    }
    try {
      const created = await createDictationDictionaryEntry({
        spokenForm,
        replacement,
        appScope: newDictionaryAppScope.trim() || null,
        caseSensitive: newDictionaryCaseSensitive,
        enabled: true,
      });
      setDictationDictionaryEntries((prev) => [...prev, created]);
      setNewDictionarySpokenForm("");
      setNewDictionaryReplacement("");
      setNewDictionaryAppScope("");
      setNewDictionaryCaseSensitive(false);
    } catch (error) {
      console.warn("Failed to create dictation dictionary entry:", error);
    }
  };

  const handleDeleteDictionaryEntry = async (entryId: string) => {
    try {
      await deleteDictationDictionaryEntry(entryId);
      setDictationDictionaryEntries((prev) =>
        prev.filter((entry) => entry.id !== entryId),
      );
    } catch (error) {
      console.warn("Failed to delete dictation dictionary entry:", error);
    }
  };

  const openDictionaryImportDialog = () => {
    setDictionaryCsvMode("import");
    setDictionaryCsvText(
      "spoken_form,replacement,app_scope,case_sensitive,enabled\nopen ai,OpenAI,,false,true",
    );
    setDictionaryCsvStatus(null);
    setDictionaryCsvImportResult(null);
    setDictionaryCsvBusy(false);
    setDictionaryCsvDialogOpen(true);
  };

  const handleExportDictionaryCsv = async () => {
    setDictionaryCsvBusy(true);
    try {
      const csvText = await exportDictationDictionaryCsv();
      setDictionaryCsvMode("export");
      setDictionaryCsvText(csvText);
      setDictionaryCsvStatus("Dictionary CSV is ready to copy.");
      setDictionaryCsvImportResult(null);
      setDictionaryCsvDialogOpen(true);
    } catch (error) {
      console.warn("Failed to export dictation dictionary CSV:", error);
      setDictionaryCsvStatus("Failed to export dictionary CSV.");
    } finally {
      setDictionaryCsvBusy(false);
    }
  };

  const handleImportDictionaryCsv = async () => {
    const csvText = dictionaryCsvText.trim();
    if (!csvText) {
      setDictionaryCsvStatus("Paste some CSV before importing.");
      return;
    }

    setDictionaryCsvBusy(true);
    try {
      const result = await importDictationDictionaryCsv(csvText);
      setDictionaryCsvImportResult(result);
      const parts = [
        result.createdCount > 0 ? `${result.createdCount} created` : null,
        result.updatedCount > 0 ? `${result.updatedCount} updated` : null,
        result.skippedCount > 0 ? `${result.skippedCount} skipped` : null,
      ].filter(Boolean);
      setDictionaryCsvStatus(
        parts.length > 0
          ? `Import complete: ${parts.join(", ")}.`
          : "Import complete.",
      );
      const nextEntries = await listDictationDictionaryEntries();
      setDictationDictionaryEntries(nextEntries);
    } catch (error) {
      console.warn("Failed to import dictation dictionary CSV:", error);
      setDictionaryCsvStatus("Dictionary import failed.");
      setDictionaryCsvImportResult(null);
    } finally {
      setDictionaryCsvBusy(false);
    }
  };

  const handleCopyDictionaryCsv = async () => {
    try {
      await navigator.clipboard.writeText(dictionaryCsvText);
      setDictionaryCsvStatus("Dictionary CSV copied.");
    } catch (error) {
      console.warn("Failed to copy dictionary CSV:", error);
      setDictionaryCsvStatus("Couldn't copy the dictionary CSV.");
    }
  };

  const handleDeleteSnippet = async (snippetId: string) => {
    try {
      await deleteDictationSnippet(snippetId);
      setDictationSnippets((prev) =>
        prev.filter((snippet) => snippet.id !== snippetId),
      );
    } catch (error) {
      console.warn("Failed to delete dictation snippet:", error);
    }
  };

  const upsertCommandPreset = async (
    commandKey:
      | "rewrite_shorter"
      | "rewrite_professional"
      | "bulletize_selection",
    systemPrompt: string,
    enabled: boolean,
  ) => {
    try {
      const updated = await upsertDictationCommandPreset({
        commandKey,
        systemPrompt,
        enabled,
      });
      setDictationCommandPresets((prev) => {
        const exists = prev.some((preset) => preset.commandKey === commandKey);
        if (exists) {
          return prev.map((preset) =>
            preset.commandKey === commandKey ? updated : preset,
          );
        }
        return [...prev, updated];
      });
    } catch (error) {
      console.warn("Failed to upsert command preset:", error);
    }
  };

  const resetCommandPreset = async (
    commandKey:
      | "rewrite_shorter"
      | "rewrite_professional"
      | "bulletize_selection",
  ) => {
    try {
      await deleteDictationCommandPreset(commandKey);
      setDictationCommandPresets((prev) =>
        prev.filter((preset) => preset.commandKey !== commandKey),
      );
    } catch (error) {
      console.warn("Failed to reset command preset:", error);
    }
  };

  const getCommandPreset = (
    key: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection",
  ) => dictationCommandPresets.find((preset) => preset.commandKey === key);

  const setCommandPresetDraft = (
    commandKey:
      | "rewrite_shorter"
      | "rewrite_professional"
      | "bulletize_selection",
    updates: Partial<Pick<DictationCommandPreset, "systemPrompt" | "enabled">>,
  ) => {
    setDictationCommandPresets((prev) => {
      const existing = prev.find((preset) => preset.commandKey === commandKey);
      if (existing) {
        return prev.map((preset) =>
          preset.commandKey === commandKey ? { ...preset, ...updates } : preset,
        );
      }

      return [
        ...prev,
        {
          id: `draft-${commandKey}`,
          commandKey,
          systemPrompt: updates.systemPrompt ?? "",
          enabled: updates.enabled ?? true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
    });
  };

  const patchSnippet = async (
    snippetId: string,
    updates: Partial<{
      trigger: string;
      expansion: string;
      appScope: string | null;
      caseSensitive: boolean;
      enabled: boolean;
    }>,
  ) => {
    setDictationSnippets((prev) =>
      prev.map((snippet) =>
        snippet.id === snippetId ? { ...snippet, ...updates } : snippet,
      ),
    );
    try {
      const updated = await updateDictationSnippet(snippetId, updates);
      setDictationSnippets((prev) =>
        prev.map((snippet) => (snippet.id === snippetId ? updated : snippet)),
      );
    } catch (error) {
      console.warn("Failed to update dictation snippet:", error);
      void listDictationSnippets()
        .then(setDictationSnippets)
        .catch(() => {
          // Keep optimistic state if reload fails.
        });
    }
  };

  const patchDictionaryEntry = async (
    entryId: string,
    updates: Partial<{
      spokenForm: string;
      replacement: string;
      appScope: string | null;
      caseSensitive: boolean;
      enabled: boolean;
    }>,
  ) => {
    setDictationDictionaryEntries((prev) =>
      prev.map((entry) =>
        entry.id === entryId ? { ...entry, ...updates } : entry,
      ),
    );
    try {
      const updated = await updateDictationDictionaryEntry(entryId, updates);
      setDictationDictionaryEntries((prev) =>
        prev.map((entry) => (entry.id === entryId ? updated : entry)),
      );
    } catch (error) {
      console.warn("Failed to update dictation dictionary entry:", error);
      void listDictationDictionaryEntries()
        .then(setDictationDictionaryEntries)
        .catch(() => {
          // Keep optimistic state if reload fails.
        });
    }
  };

  const syncLearnedDictionaryEntry = (
    result: LearnDictationCorrectionResult,
  ) => {
    const learnedEntry = result.entry;
    if (!learnedEntry) {
      return;
    }

    setDictationDictionaryEntries((prev) => {
      const existingIndex = prev.findIndex(
        (entry) => entry.id === learnedEntry.id,
      );
      if (existingIndex >= 0) {
        return prev.map((entry, index) =>
          index === existingIndex ? learnedEntry : entry,
        );
      }
      return [...prev, learnedEntry].sort((left, right) =>
        left.spokenForm.localeCompare(right.spokenForm),
      );
    });
  };

  const refreshCorrectionSuggestions = async () => {
    try {
      const suggestions = await listDictationCorrectionSuggestions();
      setDictationCorrectionSuggestions(suggestions);
    } catch (error) {
      console.warn(
        "Failed to refresh dictation correction suggestions:",
        error,
      );
    }
  };

  const syncQueuedCorrectionSuggestion = (
    result: QueueDictationCorrectionSuggestionResult,
    setStatus: (value: string | null) => void,
  ) => {
    if (!result.queued || !result.suggestion) {
      setStatus(result.reason ?? "No safe correction detected");
      return false;
    }

    setDictationCorrectionSuggestions((prev) => {
      const existingIndex = prev.findIndex(
        (suggestion) => suggestion.id === result.suggestion?.id,
      );
      if (existingIndex >= 0) {
        return prev.map((suggestion, index) =>
          index === existingIndex ? result.suggestion! : suggestion,
        );
      }
      return [result.suggestion!, ...prev];
    });
    setStatus(
      `${result.action === "updated" ? "Updated" : "Queued"} for review: ${result.spokenForm} -> ${result.replacement}`,
    );
    return true;
  };

  const learnCorrection = async (
    originalText: string,
    correctedText: string,
    options?: {
      force?: boolean;
      appTarget?: string | null;
      onSuccess?: () => void;
      setStatus?: (value: string | null) => void;
    },
  ) => {
    const setStatus = options?.setStatus ?? (() => {});
    try {
      const result = await learnDictationCorrection({
        originalText,
        correctedText,
        appTarget: options?.appTarget ?? null,
        force: options?.force ?? false,
      });

      if (!result.learned) {
        setStatus(result.reason ?? "No safe correction detected");
        return false;
      }

      syncLearnedDictionaryEntry(result);
      setDictationCorrectionSuggestions((prev) =>
        prev.filter(
          (suggestion) =>
            !(
              suggestion.spokenForm === result.spokenForm &&
              suggestion.replacement === result.replacement
            ),
        ),
      );
      setStatus(
        `${result.action === "updated" ? "Updated" : "Learned"}: ${result.spokenForm} -> ${result.replacement}`,
      );
      options?.onSuccess?.();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      return false;
    }
  };

  const queueCorrectionSuggestion = async (
    originalText: string,
    correctedText: string,
    options?: {
      appTarget?: string | null;
      onSuccess?: () => void;
      setStatus?: (value: string | null) => void;
    },
  ) => {
    const setStatus = options?.setStatus ?? (() => {});
    try {
      const result = await queueDictationCorrectionSuggestion({
        originalText,
        correctedText,
        appTarget: options?.appTarget ?? null,
        force: false,
      });

      const queued = syncQueuedCorrectionSuggestion(result, setStatus);
      if (queued) {
        options?.onSuccess?.();
      }
      return queued;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      return false;
    }
  };

  const handleApproveCorrectionSuggestionGroup = async (
    suggestionIds: string[],
  ) => {
    if (suggestionIds.length === 0) {
      return;
    }

    setCorrectionInboxBusy(true);
    try {
      const [firstSuggestionId, ...duplicateSuggestionIds] = suggestionIds;
      const result =
        await approveDictationCorrectionSuggestion(firstSuggestionId);
      for (const suggestionId of duplicateSuggestionIds) {
        await rejectDictationCorrectionSuggestion(suggestionId);
      }
      syncLearnedDictionaryEntry(result);
      setDictationCorrectionSuggestions((prev) =>
        prev.filter((suggestion) => !suggestionIds.includes(suggestion.id)),
      );
      setDictionaryCsvStatus(
        `${result.action === "updated" ? "Updated" : "Learned"}: ${result.spokenForm} -> ${result.replacement}${
          duplicateSuggestionIds.length > 0
            ? ` · cleared ${duplicateSuggestionIds.length} duplicates`
            : ""
        }`,
      );
    } catch (error) {
      console.warn("Failed to approve dictation correction suggestion:", error);
      setDictionaryCsvStatus("Failed to approve correction suggestion.");
      void refreshCorrectionSuggestions();
    } finally {
      setCorrectionInboxBusy(false);
    }
  };

  const handleRejectCorrectionSuggestionGroup = async (
    suggestionIds: string[],
  ) => {
    if (suggestionIds.length === 0) {
      return;
    }

    setCorrectionInboxBusy(true);
    try {
      for (const suggestionId of suggestionIds) {
        await rejectDictationCorrectionSuggestion(suggestionId);
      }
      setDictationCorrectionSuggestions((prev) =>
        prev.filter((suggestion) => !suggestionIds.includes(suggestion.id)),
      );
      setDictionaryCsvStatus(
        suggestionIds.length === 1
          ? "Removed correction suggestion."
          : `Removed ${suggestionIds.length} correction suggestions.`,
      );
    } catch (error) {
      console.warn("Failed to reject dictation correction suggestion:", error);
      setDictionaryCsvStatus("Failed to remove correction suggestion.");
      void refreshCorrectionSuggestions();
    } finally {
      setCorrectionInboxBusy(false);
    }
  };

  const maybeAutoLearnLatestCorrection = async () => {
    const original = latestCorrectionBaseline.trim();
    const corrected = transcribedText.trim();
    if (
      !dictationAutoLearnCorrections ||
      !original ||
      !corrected ||
      original === corrected
    ) {
      return;
    }

    await queueCorrectionSuggestion(original, corrected, {
      appTarget,
      setStatus: setLatestLearnStatus,
      onSuccess: () => setLatestCorrectionBaseline(corrected),
    });
  };

  const maybeAutoLearnHistoryCorrection = async () => {
    const original = historyCorrectionBaseline.trim();
    const corrected = historyCorrectionText.trim();
    if (
      !dictationAutoLearnCorrections ||
      !original ||
      !corrected ||
      original === corrected
    ) {
      return;
    }

    await queueCorrectionSuggestion(original, corrected, {
      appTarget:
        selectedHistoryDetails?.activationMatcher ??
        selectedHistoryDetails?.appTarget ??
        selectedHistoryDetails?.contextAppName ??
        null,
      setStatus: setHistoryLearnStatus,
      onSuccess: () => setHistoryCorrectionBaseline(corrected),
    });
  };

  const handleReprocessSelectedDictation = async () => {
    if (!selectedTranscript?.fullText?.trim()) {
      return;
    }

    setIsReprocessing(true);
    setReprocessError(null);
    try {
      const result = await reprocessDictationText(
        selectedTranscript.fullText,
        reprocessModePreset,
        selectedHistoryDetails?.activationMatcher ??
          selectedHistoryDetails?.appTarget ??
          selectedHistoryDetails?.contextAppName ??
          null,
      );
      setReprocessedResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReprocessError(message);
      setReprocessedResult(null);
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleCopyHistoryTranscript = async (recordingId: string) => {
    try {
      const transcript = await getTranscript(recordingId);
      const text = transcript?.fullText?.trim();
      if (!text) {
        return;
      }
      await navigator.clipboard.writeText(text);
      setPasteStatus("Copied dictation history item");
    } catch (error) {
      console.warn("Failed to copy dictation history transcript:", error);
    }
  };

  const handleDeleteHistoryItem = async (recordingId: string) => {
    try {
      await deleteRecording(recordingId);
      if (selectedRecording?.id === recordingId) {
        setIsDialogOpen(false);
        setSelectedRecording(null);
        setSelectedTranscript(null);
        setReprocessedResult(null);
        setReprocessError(null);
      }
      await refetchDictationHistory();
      await refreshDictationInsights();
    } catch (error) {
      console.warn("Failed to delete dictation history item:", error);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Dictation"
        subtitle="Fast voice capture that inserts text where you work"
        actions={
          <div
            className={cn(
              "flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-all",
              hotkeyPressed
                ? "bg-active text-active-foreground border-active scale-105"
                : "bg-muted",
            )}
          >
            <Keyboard className="h-4 w-4" />
            <span className="font-mono font-medium">{hotkeyLabel}</span>
            <span className="text-muted-foreground ml-2">
              {dictationHandsFreeEnabled
                ? "hands-free"
                : dictationPushToTalk
                  ? "hold to talk"
                  : "toggle"}
            </span>
          </div>
        }
      />

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-4xl mx-auto space-y-6">
          {dictationError && (
            <Card className="border-destructive/30 bg-destructive/10">
              <CardContent className="p-4">
                <p className="text-sm text-destructive">{dictationError}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Flow Profiles</CardTitle>
              <CardDescription>
                Start with a profile tuned for your workflow, then save private
                app-aware flows when you want Plainsong to switch styles for you.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-primary" />
                  <p className="text-sm font-medium">Solo lanes</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pick the lane that matches what you are doing right now.
                  Plainsong keeps the deep controls below, but these presets are
                  the fastest way to feel dialed in.
                </p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {SOLO_LANES.map((lane) => {
                    const Icon = lane.icon;
                    const isActive = activeLane.id === lane.id;
                    return (
                      <button
                        key={lane.id}
                        type="button"
                        aria-label={`Solo lane: ${lane.title}`}
                        onClick={() => {
                          if (lane.styleId) {
                            const style = RECOMMENDED_APP_STYLES.find(
                              (candidate) => candidate.id === lane.styleId,
                            );
                            if (style) {
                              void handleInstallRecommendedStyle(style);
                            }
                            return;
                          }
                          if (lane.modeId) {
                            applyDictationMode(lane.modeId);
                          }
                        }}
                        className={cn(
                          "rounded-xl border p-4 text-left transition-colors",
                          isActive
                            ? "border-active bg-active/10 shadow-sm"
                            : "border-border bg-background hover:border-active/40 hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <Icon className="h-4 w-4 text-primary" />
                          {isActive ? (
                            <span className="rounded-full bg-active px-2 py-0.5 text-[11px] font-semibold text-active-foreground">
                              Active
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-3 font-medium">{lane.title}</p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {lane.description}
                        </p>
                        <p className="mt-3 text-[11px] font-medium text-primary">
                          {lane.emphasis}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {DICTATION_MODE_DEFINITIONS.map((mode) => {
                  const isActive = dictationModePreset === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      aria-label={`Flow profile: ${mode.label}`}
                      onClick={() => applyDictationMode(mode.id)}
                      className={cn(
                        "rounded-xl border p-4 text-left transition-colors",
                        isActive
                          ? "border-active bg-active/10 shadow-sm"
                          : "border-border hover:border-active/50 hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium">{mode.label}</p>
                        {isActive && (
                          <span className="rounded-full bg-active px-2 py-0.5 text-[11px] font-semibold text-active-foreground">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {mode.description}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="space-y-3 border-t pt-4">
                <div>
                  <p className="text-sm font-medium">
                    Recommended flow profiles
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Install ready-made auto-switch profiles for the apps you use
                    most.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {RECOMMENDED_APP_STYLES.map((style) => {
                    const installedMode = dictationCustomModes.find(
                      (mode) => mode.id === style.id,
                    );
                    return (
                      <div
                        key={style.id}
                        className="rounded-xl border border-border bg-muted/20 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{style.name}</p>
                            <p className="mt-2 text-sm text-muted-foreground">
                              {style.description}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {style.activationDomainMatcher
                                ? `Domain ${style.activationDomainMatcher}`
                                : style.activationAppMatcher
                                  ? `App ${style.activationAppMatcher}`
                                  : "Manual profile"}
                              {" · "}
                              {CONTEXT_SOURCE_LABELS[style.contextSource]}
                              {" · "}
                              {INSERTION_MODE_LABELS[style.insertionMode]}
                            </p>
                          </div>
                          {installedMode && (
                            <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                              Installed
                            </span>
                          )}
                        </div>
                        <div className="mt-3 flex gap-2">
                          <Button
                            variant={installedMode ? "outline" : "default"}
                            size="sm"
                            onClick={() =>
                              void handleInstallRecommendedStyle(style)
                            }
                          >
                            {installedMode
                              ? "Update and use"
                              : "Install and use"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {dictationCustomModes.length > 0 && (
                <div className="space-y-3 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">Saved flow profiles</p>
                    <p className="text-xs text-muted-foreground">
                      Reuse your own dictation setups without rebuilding them
                      from scratch.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {dictationCustomModes.map((mode) => {
                      const isActive =
                        dictationModePreset === "custom" &&
                        selectedCustomModeId === mode.id;
                      return (
                        <div
                          key={mode.id}
                          className={cn(
                            "rounded-xl border p-4",
                            isActive
                              ? "border-active bg-active/10 shadow-sm"
                              : "border-border bg-muted/20",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{mode.name}</p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {mode.description || "Private flow profile"}
                              </p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {mode.dictationProvider ||
                                  "Current transcription"}{" "}
                                · {mode.dictationModelId || "Current model"}
                                {mode.activationAppMatcher
                                  ? ` · Auto for ${mode.activationAppMatcher}`
                                  : ""}
                                {mode.activationDomainMatcher
                                  ? ` · Domain ${mode.activationDomainMatcher}`
                                  : ""}
                                {!mode.activationAppMatcher &&
                                !mode.activationDomainMatcher
                                  ? " · Manual profile"
                                  : ""}
                              </p>
                            </div>
                            {isActive && (
                              <span className="rounded-full bg-active px-2 py-0.5 text-[11px] font-semibold text-active-foreground">
                                Active
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              variant={isActive ? "default" : "outline"}
                              size="sm"
                              onClick={() => applySavedCustomMode(mode)}
                            >
                              {isActive ? "Using now" : "Use profile"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void handleDeleteCustomMode(mode.id)
                              }
                            >
                              Delete profile
                            </Button>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {summarizeMode(mode).map((item) => (
                              <span
                                key={`${mode.id}-${item.label}`}
                                className="rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground"
                              >
                                <span className="font-medium text-foreground">
                                  {item.label}:
                                </span>{" "}
                                {item.value}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium">
                    What this profile changes
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The active profile controls insertion, context, saved
                    history, command behavior, and the transcription/AI routes
                    captured below.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeModeSummary.map((item) => (
                    <span
                      key={item.label}
                      className="rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {item.label}:
                      </span>{" "}
                      {item.value}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border bg-background/70 p-4 space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Default route</p>
                    <p className="text-xs text-muted-foreground">
                      This mode prefers one hosting path by default, including
                      hotkey dictation.
                    </p>
                    <div className="flex gap-2">
                      {(["local", "cloud"] as const).map((route) => (
                        <Button
                          key={route}
                          type="button"
                          size="sm"
                          variant={
                            dictationRoutePreference === route
                              ? "default"
                              : "outline"
                          }
                          onClick={() => {
                            setDictationRoutePreference(route);
                            void persistDictationPreferences({
                              routePreference: route,
                            });
                          }}
                        >
                          {route === "local" ? "Local first" : "Cloud first"}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Current provider hosting:{" "}
                      {currentDictationProvider
                        ? providerHostingPreference(
                            currentDictationProvider as AsrProviderType,
                            currentDictationModelId,
                          ) === "cloud"
                          ? "Cloud"
                          : "Local"
                        : "Unknown"}
                    </p>
                    {!useSharedAsrSelection &&
                    currentDictationProvider &&
                    currentMeetingProvider &&
                    currentDictationProvider !== currentMeetingProvider ? (
                      <p className="text-xs text-amber-500">
                        Dictation uses {currentDictationProvider} while meetings
                        use {currentMeetingProvider}.
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      Next button capture override
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Use this when you want one manual capture to ignore the
                      mode default.
                    </p>
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={dictationRouteOverrideEnabled}
                        onChange={(event) => {
                          const next = event.target.checked;
                          setDictationRouteOverrideEnabled(next);
                          if (!next) {
                            setNextCaptureRoutePreference(null);
                          }
                          void persistDictationPreferences({
                            routeOverrideEnabled: next,
                          });
                        }}
                      />
                      Allow next-capture override
                    </label>
                    {dictationRouteOverrideEnabled ? (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            nextCaptureRoutePreference === null
                              ? "default"
                              : "outline"
                          }
                          onClick={() => setNextCaptureRoutePreference(null)}
                        >
                          Use default
                        </Button>
                        {(["local", "cloud"] as const).map((route) => (
                          <Button
                            key={`next-${route}`}
                            type="button"
                            size="sm"
                            variant={
                              nextCaptureRoutePreference === route
                                ? "default"
                                : "outline"
                            }
                            onClick={() => setNextCaptureRoutePreference(route)}
                          >
                            Next {route}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Manual captures follow the active mode route until you
                        re-enable overrides.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {dictationModePreset === "custom"
                  ? selectedCustomMode
                    ? `${selectedCustomMode.name} is active. Update it when you want the current lower controls to become the new default profile.`
                    : "Unsaved custom setup is active. Save it as a reusable flow profile when it feels right."
                  : `${modeDefinitionById[dictationModePreset]?.label ?? "General"} profile is active. Lower controls stay editable if you want to fine-tune them.`}
              </div>
              {dictationModePreset === "custom" && (
                <div className="rounded-xl border border-border/70 bg-background/70 p-4 space-y-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Profile name
                      </label>
                      <input
                        type="text"
                        aria-label="Profile name"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={customModeDraft.name}
                        onChange={(event) =>
                          setCustomModeDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="Custom Flow Profile"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Short description
                      </label>
                      <input
                        type="text"
                        aria-label="Short description"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={customModeDraft.description}
                        onChange={(event) =>
                          setCustomModeDraft((current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        placeholder="What this mode is for"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Base style</label>
                      <select
                        aria-label="Base style"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={customModeDraft.baseModePreset}
                        onChange={(event) =>
                          setCustomModeDraft((current) => ({
                            ...current,
                            baseModePreset: event.target
                              .value as DictationBaseModePreset,
                          }))
                        }
                      >
                        {DICTATION_MODE_DEFINITIONS.filter(
                          (mode) => mode.id !== "custom",
                        ).map((mode) => (
                          <option key={mode.id} value={mode.id}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Sets the deterministic formatting and reprocess behavior
                        this flow profile should inherit before any
                        profile-specific prompt runs.
                      </p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">
                        Style prompt
                      </label>
                      <textarea
                        aria-label="Style prompt"
                        className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
                        value={customModeDraft.customPrompt}
                        onChange={(event) =>
                          setCustomModeDraft((current) => ({
                            ...current,
                            customPrompt: event.target.value,
                          }))
                        }
                        placeholder="Optional. Tell Plainsong how this mode should rewrite dictation for this app or workflow."
                      />
                      <p className="text-xs text-muted-foreground">
                        Optional. Overrides the global Smart Format prompt only
                        when this profile is active.
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Activation rules</p>
                        <p className="text-xs text-muted-foreground">
                          Hotkey and tray dictation can switch into this flow
                          profile automatically before capture starts.
                        </p>
                      </div>
                      <span className="rounded-full border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        {customModeDraft.activationAppMatcher.trim() ||
                        customModeDraft.activationDomainMatcher.trim()
                          ? "Auto-ready"
                          : "Manual only"}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Auto-activate for app
                        </label>
                        <input
                          type="text"
                          aria-label="Auto-activate for app"
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={customModeDraft.activationAppMatcher}
                          onChange={(event) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              activationAppMatcher: event.target.value,
                            }))
                          }
                          placeholder="Slack, Gmail, Cursor"
                        />
                        <p className="text-xs text-muted-foreground">
                          Optional. When the frontmost app name matches,
                          Plainsong can switch to this profile automatically for
                          hotkey and tray dictation.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {ACTIVATION_APP_SUGGESTIONS.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="rounded-full border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
                              onClick={() =>
                                setCustomModeDraft((current) => ({
                                  ...current,
                                  activationAppMatcher: suggestion,
                                }))
                              }
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Auto-activate for domain
                        </label>
                        <input
                          type="text"
                          aria-label="Auto-activate for domain"
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={customModeDraft.activationDomainMatcher}
                          onChange={(event) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              activationDomainMatcher: event.target.value,
                            }))
                          }
                          placeholder="docs.google.com, linear.app"
                        />
                        <p className="text-xs text-muted-foreground">
                          Optional. Browser-focused dictation can switch when
                          the active tab URL host matches this domain.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {ACTIVATION_DOMAIN_SUGGESTIONS.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="rounded-full border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
                              onClick={() =>
                                setCustomModeDraft((current) => ({
                                  ...current,
                                  activationDomainMatcher: suggestion,
                                }))
                              }
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 rounded-md border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                      {describeActivationRules(
                        customModeDraft.activationAppMatcher,
                        customModeDraft.activationDomainMatcher,
                      )}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Language override
                        </label>
                        <input
                          type="text"
                          aria-label="Language override"
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={customModeDraft.languageOverride}
                          onChange={(event) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              languageOverride: event.target.value,
                            }))
                          }
                          placeholder="Leave blank for auto"
                        />
                        <p className="text-xs text-muted-foreground">
                          Optional. Save a language tag like{" "}
                          <span className="font-mono">en</span> or{" "}
                          <span className="font-mono">es</span> with this mode.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Live preview
                        </label>
                        <label className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={customModeDraft.livePreviewEnabled}
                            onChange={(event) =>
                              setCustomModeDraft((current) => ({
                                ...current,
                                livePreviewEnabled: event.target.checked,
                              }))
                            }
                          />
                          Show live partial text in the popup for this mode
                        </label>
                        <p className="text-xs text-muted-foreground">
                          Turn this off for cleaner captures when partial text
                          is distracting.
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Domain rules are checked first. If both are empty, this
                      profile stays available for manual capture only.
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Saving a flow profile snapshots the current dictation style,
                    result behavior, context source, transcription route, AI
                    route, and optional app or domain auto-activation rules.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleSaveCustomMode(false)}
                    >
                      {selectedCustomModeId
                        ? "Update profile"
                        : "Save current setup"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleSaveCustomMode(true)}
                    >
                      Save as new profile
                    </Button>
                    {selectedCustomModeId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void handleDeleteCustomMode(selectedCustomModeId)
                        }
                      >
                        Delete profile
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Capture Card */}
          <Card
            className={cn(
              "border transition-colors duration-200 shadow-sm",
              isDictationBusy ? "border-active" : "border-muted",
            )}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Capture
              </CardTitle>
              <CardDescription>
                {dictationInstruction(
                  hotkeyShortcut,
                  shortcutMode(dictationPushToTalk, dictationHandsFreeEnabled),
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Active lane
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {activeLane.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {activeLane.description}
                    </p>
                    {dictationResolvedModeLabel ? (
                      <p className="mt-2 text-[11px] font-medium text-primary">
                        Runtime mode: {dictationResolvedModeLabel}
                      </p>
                    ) : null}
                  </div>
                  <div className="rounded-xl border bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Smart context
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {smartContextSummary}
                    </p>
                  </div>
                  <div className="rounded-xl border bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Teaching Plainsong
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dictionaryCoverageSummary}
                    </p>
                  </div>
                </div>
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    dictationPhaseSummary.tone === "active"
                      ? "border-active/30 bg-active/5"
                      : dictationPhaseSummary.tone === "success"
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : dictationPhaseSummary.tone === "error"
                          ? "border-destructive/20 bg-destructive/5"
                          : "border-border bg-background",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Capture state
                      </p>
                      <p className="text-sm font-semibold">
                        {dictationPhaseSummary.title}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {dictationPhaseSummary.detail}
                      </p>
                    </div>
                    <div
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                        dictationPhaseSummary.tone === "active"
                          ? "border-active/30 bg-active/5 text-active"
                          : dictationPhaseSummary.tone === "success"
                            ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                            : dictationPhaseSummary.tone === "error"
                              ? "border-destructive/20 bg-destructive/5 text-destructive"
                              : "border-border bg-background text-muted-foreground",
                      )}
                    >
                      {dictationPhaseSummary.title}
                    </div>
                  </div>
                  {dictationPhasePreview ? (
                    <div className="mt-3 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                      {dictationPhasePreview}
                    </div>
                  ) : null}
                </div>
                <div className="rounded-xl border border-border bg-muted/10 p-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
                      Backtrack:{" "}
                      <span className="font-medium text-foreground">
                        scratch that
                      </span>
                    </span>
                    <span className="rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
                      Replace:{" "}
                      <span className="font-medium text-foreground">
                        replace X with Y
                      </span>
                    </span>
                    <span className="rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
                      Quick fix:{" "}
                      <span className="font-medium text-foreground">
                        actually ...
                      </span>
                    </span>
                    <span className="rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
                      Teach words:{" "}
                      <span className="font-medium text-foreground">
                        edit result to Learn correction
                      </span>
                    </span>
                  </div>
                </div>
                <div className="rounded-[20px] border border-border bg-background px-5 py-8">
                  <div className="flex flex-col items-center gap-6">
                    {isDictationCaptureLive ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-active/20 bg-active/5">
                          <span className="absolute inset-0 rounded-full border border-active/20 animate-ping opacity-40" />
                          <span className="absolute inset-[10px] rounded-full border border-active/20 opacity-60" />
                          <Mic className="relative h-10 w-10 text-active" />
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-medium">
                            {dictationPhase === "primed"
                              ? "Ready"
                              : "Listening"}
                          </p>
                          <p className="mt-2 text-3xl font-mono font-semibold text-foreground">
                            {dictationPhase === "recording"
                              ? formattedDuration
                              : "--:--"}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="lg"
                          onClick={handleStopDictation}
                          className="mt-2"
                        >
                          <Square className="h-4 w-4 mr-2 fill-current" />
                          Stop Dictation
                        </Button>
                      </div>
                    ) : isDictationBusy ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="flex h-24 w-24 items-center justify-center rounded-full border border-border bg-muted/20">
                          <RefreshCw className="h-10 w-10 animate-spin text-foreground" />
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-medium">
                            {dictationPhaseSummary.title}
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            {dictationPhaseSummary.detail}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="lg"
                          disabled
                          className="mt-4"
                        >
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          {dictationPhase === "delivering"
                            ? "Inserting..."
                            : "Working..."}
                        </Button>
                      </div>
                    ) : dictationPhase === "done" ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="flex h-24 w-24 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/5">
                          <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-300" />
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-medium">Result ready</p>
                          <p className="text-muted-foreground mt-1">
                            {dictationPhaseSummary.detail}
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="lg"
                          onClick={launchDictation}
                          className="mt-4"
                        >
                          <Mic className="h-4 w-4 mr-2" />
                          Start Next Dictation
                        </Button>
                      </div>
                    ) : dictationPhase === "error" ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="flex h-24 w-24 items-center justify-center rounded-full border border-destructive/20 bg-destructive/5">
                          <TriangleAlert className="h-10 w-10 text-destructive" />
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-medium">
                            Capture needs attention
                          </p>
                          <p className="text-muted-foreground mt-1">
                            {dictationPhaseSummary.detail}
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="lg"
                          onClick={launchDictation}
                          className="mt-4"
                        >
                          <Mic className="h-4 w-4 mr-2" />
                          Retry Dictation
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-4">
                        <div
                          className={cn(
                            "relative flex h-24 w-24 items-center justify-center rounded-full border transition-transform duration-150",
                            hotkeyPressed
                              ? "scale-[1.03] border-active/30 bg-active/5"
                              : "border-border bg-muted/20",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute inset-0 rounded-full border transition-all duration-150",
                              hotkeyPressed
                                ? "border-active/30 opacity-100"
                                : "border-border/60 opacity-70",
                            )}
                          />
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute inset-[10px] rounded-full border transition-all duration-150",
                              hotkeyPressed
                                ? "border-active/25 opacity-100"
                                : "border-border/50 opacity-70",
                            )}
                          />
                          <Mic
                            className={cn(
                              "relative h-10 w-10 transition-colors",
                              hotkeyPressed
                                ? "text-active"
                                : "text-muted-foreground",
                            )}
                          />
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-medium">
                            {dictationPhaseSummary.title}
                          </p>
                          <p className="text-muted-foreground mt-1">
                            {dictationHandsFreeEnabled
                              ? `Press ${hotkeyLabel} to start. It stops after silence or when you press again`
                              : dictationPushToTalk
                                ? `Hold ${hotkeyLabel} to record and release to transcribe`
                                : `Press ${hotkeyLabel} to start, press again to transcribe`}
                          </p>
                        </div>
                        <Button
                          variant="default"
                          size="lg"
                          onClick={launchDictation}
                          className="mt-4"
                          disabled={isDictationBusy}
                        >
                          <Mic className="h-4 w-4 mr-2" />
                          Start Dictation
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                {!isDictationCaptureLive && !isDictationBusy ? (
                  <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border/60 pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleReadSelectedText()}
                    >
                      <Volume2 className="mr-2 h-4 w-4" />
                      {activeSpeechTarget === "selected-text"
                        ? "Stop reading"
                        : "Read selected text"}
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <section className="surface-panel-subtle rounded-2xl p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-xl">
                <p className="quiet-label">Daily dictation guardrails</p>
                <p className="mt-1 text-base font-medium text-card-foreground">
                  The main path stays simple: trigger, speak, insert, then repair only when the target app needs it.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:w-[520px]">
                {[
                  {
                    icon: Keyboard,
                    label: "Trigger",
                    body: "Use the global hotkey without switching back to Plainsong.",
                  },
                  {
                    icon: Zap,
                    label: "Insert",
                    body: "Final text lands after capture finishes.",
                  },
                  {
                    icon: Replace,
                    label: "Repair",
                    body: "Use scratch that, actually, or replace X with Y.",
                  },
                  {
                    icon: BookOpen,
                    label: "Remember",
                    body: "Teach names and terms once.",
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.label}
                      className="flex gap-3 rounded-xl border border-border/70 bg-background/55 p-3"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/45 text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-card-foreground">{item.label}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {activeCoachCards.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Dictation Coach
                </CardTitle>
                <CardDescription>
                  Learn the highest-leverage moves that make Plainsong feel
                  faster than typing.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 xl:grid-cols-2">
                  {activeCoachCards.map((card) => (
                    <div
                      key={card.id}
                      className="rounded-xl border bg-muted/20 p-4 space-y-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{card.title}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {card.body}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {card.id === "command_mode" ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              setDictationCommandModeEnabled(true);
                              const nextModePreset = syncModePreset({
                                commandModeEnabled: true,
                              });
                              void persistDictationPreferences({
                                commandModeEnabled: true,
                                modePreset: nextModePreset,
                              });
                              dismissCoachCard(card.id);
                            }}
                          >
                            {card.actionLabel}
                          </Button>
                        ) : card.id === "profiles" ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              const style = RECOMMENDED_APP_STYLES.find(
                                (candidate) =>
                                  candidate.id === "builtin-coding-copilot",
                              );
                              if (style) {
                                void handleInstallRecommendedStyle(style);
                              }
                              dismissCoachCard(card.id);
                            }}
                          >
                            Install a flow
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => dismissCoachCard(card.id)}
                          >
                            {card.actionLabel}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dismissCoachCard(card.id)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Terminal className="h-4 w-4" />
                  Developer Dictation
                </CardTitle>
                <CardDescription>
                  A tighter lane for Cursor, terminals, commit messages,
                  markdown, and prompt-heavy work.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Best current setup
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {currentDictationProvider && currentDictationModelId
                      ? `${currentDictationProvider} · ${currentDictationModelId}`
                      : "Use a fast local provider with live preview"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Coding benefits from low-latency local capture,
                    selected-text context, and command mode staying on.
                  </p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-md border bg-background px-3 py-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Good spoken patterns
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      “open paren”, “close brace”, “snake case”, “camel case”,
                      file names, CLI commands, and bulletized status updates.
                    </p>
                  </div>
                  <div className="rounded-md border bg-background px-3 py-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Best commands
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Keep <code>{dictationCommandPrefix}</code> mode ready for
                      rewrite, bulletize, and professional cleanup on selected
                      text.
                    </p>
                  </div>
                </div>
                <div className="rounded-md border bg-background px-3 py-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Developer quick starts
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded-full border px-2 py-1">
                      commit messages
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      PR summaries
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      terminal commands
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      issue updates
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      Cursor prompts
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      const style = RECOMMENDED_APP_STYLES.find(
                        (candidate) =>
                          candidate.id === "builtin-coding-copilot",
                      );
                      if (style) {
                        void handleInstallRecommendedStyle(style);
                      }
                    }}
                  >
                    Use Coding lane
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDictationContextSource("selected_text");
                      setDictationCommandModeEnabled(true);
                      setDictationLivePreviewEnabled(true);
                      const nextModePreset = syncModePreset({
                        contextSource: "selected_text",
                        commandModeEnabled: true,
                      });
                      void persistDictationPreferences({
                        contextSource: "selected_text",
                        commandModeEnabled: true,
                        livePreviewEnabled: true,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    Turn on coding helpers
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Volume2 className="h-4 w-4" />
                  Quiet Dictation
                </CardTitle>
                <CardDescription>
                  Better defaults for low-volume speaking, focus sessions, and
                  fewer distracting UI changes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Quiet-friendly defaults
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    Silence auto-stop{" "}
                    {formatTimeoutSeconds(dictationSilenceTimeoutSeconds)}{" "}
                    · Keep warm {dictationKeepWarm}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    For whispering, a warmed local model and a slightly longer
                    stop window reduce awkward cutoffs.
                  </p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-md border bg-background px-3 py-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Recommended route
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Prefer local capture so quiet speech does not depend on
                      network latency or upload timing.
                    </p>
                  </div>
                  <div className="rounded-md border bg-background px-3 py-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Preview behavior
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Leave live preview on when you want reassurance, or turn
                      it off for less visual churn during deep work.
                    </p>
                  </div>
                </div>
                <div className="rounded-md border bg-background px-3 py-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Quiet quick starts
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded-full border px-2 py-1">
                      late-night writing
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      shared spaces
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      focus sessions
                    </span>
                    <span className="rounded-full border px-2 py-1">
                      private drafting
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      const style = RECOMMENDED_APP_STYLES.find(
                        (candidate) => candidate.id === "builtin-quiet-focus",
                      );
                      if (style) {
                        void handleInstallRecommendedStyle(style);
                      }
                    }}
                  >
                    Use Quiet lane
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDictationRoutePreference("local");
                      setDictationKeepWarm("long");
                      setDictationSilenceTimeoutSeconds(1.8);
                      const nextModePreset = syncModePreset({});
                      void persistDictationPreferences({
                        routePreference: "local",
                        keepWarm: "long",
                        silenceTimeoutSeconds: 1.8,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    Apply whisper-friendly defaults
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Last Transcription */}
          {transcribedText && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Latest Result</CardTitle>
                  <CardDescription>
                    {pasteStatus ?? "Latest dictation result"}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void toggleReadAloudPlayback(
                        transcribedText,
                        "latest-result",
                      )
                    }
                  >
                    <Volume2 className="h-4 w-4 mr-2" />
                    {activeSpeechTarget === "latest-result"
                      ? "Stop reading"
                      : "Read aloud"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      navigator.clipboard.writeText(transcribedText)
                    }
                  >
                    <Save className="h-4 w-4 mr-2" />
                    Copy Again
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-md border bg-muted/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Backtrack ready
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        Say “scratch that” after the next insert
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Plainsong can undo the last insert or replace it with a
                        corrected phrase.
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Personal dictionary
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        Fix a word once, then teach it
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Edit the result here and use Learn correction so your
                        names and jargon stick.
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Smart context
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {activationMatcher ?? appTarget ?? "General dictation"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {smartContextSummary}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-4">
                    <textarea
                      className="min-h-[120px] w-full resize-y bg-transparent text-sm outline-none"
                      value={transcribedText}
                      onChange={(event) =>
                        setTranscribedText(event.target.value)
                      }
                      onBlur={() => {
                        void maybeAutoLearnLatestCorrection();
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        latestCorrectionBaseline.trim() ===
                        transcribedText.trim()
                      }
                      onClick={() =>
                        void learnCorrection(
                          latestCorrectionBaseline,
                          transcribedText,
                          {
                            force: true,
                            appTarget,
                            setStatus: setLatestLearnStatus,
                            onSuccess: () =>
                              setLatestCorrectionBaseline(
                                transcribedText.trim(),
                              ),
                          },
                        )
                      }
                    >
                      Learn correction
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const trimmed = transcribedText.trim();
                        if (!trimmed) {
                          return;
                        }
                        setNewDictionarySpokenForm(trimmed);
                        setNewDictionaryReplacement(trimmed);
                        setDictionaryCsvStatus(
                          "Loaded current result into the dictionary editor below.",
                        );
                      }}
                    >
                      Quick add to dictionary
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Edit a mistaken word here and Plainsong can remember it for
                      next time.
                    </p>
                  </div>
                  {latestLearnStatus && (
                    <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">
                      {latestLearnStatus}
                    </div>
                  )}
                </div>
                {recoveryState && (
                  <div
                    className={`mt-3 rounded-md border px-3 py-3 text-xs ${
                      recoveryState.tone === "warning"
                        ? "border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "border-orange-400/50 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                    }`}
                  >
                    <p className="font-medium">{recoveryState.title}</p>
                    <p className="mt-1">{recoveryState.detail}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-current/90">
                      {recoveryState.hints.map((hint) => (
                        <span
                          key={hint}
                          className="rounded-full border border-current/20 px-2 py-1"
                        >
                          {hint}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {deliveryDoctor && (
                  <div
                    className={cn(
                      "mt-3 rounded-lg border p-3 text-xs",
                      deliveryDoctor.tone === "ready" &&
                        "border-emerald-400/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                      deliveryDoctor.tone === "warning" &&
                        "border-amber-400/50 bg-amber-500/10 text-amber-800 dark:text-amber-200",
                      deliveryDoctor.tone === "attention" &&
                        "border-orange-400/50 bg-orange-500/10 text-orange-800 dark:text-orange-200",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {deliveryDoctor.tone === "ready" ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
                      ) : (
                        <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{deliveryDoctor.title}</p>
                          {endToEndMs !== null && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-current/20 px-2 py-0.5 font-medium">
                              <Zap className="h-3 w-3" />
                              {formatDurationMetric(endToEndMs)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-current/85">
                          {deliveryDoctor.detail}
                        </p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {deliveryDoctor.items.map((item) => (
                            <div
                              key={`${item.label}-${item.value}`}
                              className="rounded-md border border-current/15 bg-background/60 px-2 py-1.5 text-current"
                            >
                              <span className="sr-only">
                                {item.label}: {item.value}
                              </span>
                              <p className="text-[10px] font-medium uppercase text-current/60">
                                {item.label}
                              </p>
                              <p className="mt-0.5 truncate font-medium">
                                {item.value}
                              </p>
                            </div>
                          ))}
                        </div>
                        <p className="mt-3 rounded-md border border-current/15 bg-background/60 px-2 py-1.5 text-current/90">
                          Next: {deliveryDoctor.nextAction}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Flow Profile</CardTitle>
                <CardDescription>
                  Private local usage stats across your saved dictations.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshDictationInsights()}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {dictationInsights ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <div className="rounded-md border bg-muted/30 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Total dictations
                      </p>
                      <p className="mt-1 text-lg font-semibold">
                        {dictationInsights.totalDictations}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Words dictated
                      </p>
                      <p className="mt-1 text-lg font-semibold">
                        {dictationInsights.dictatedWords}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Avg words
                      </p>
                      <p className="mt-1 text-lg font-semibold">
                        {dictationInsights.averageWordsPerDictation}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Active days
                      </p>
                      <p className="mt-1 text-lg font-semibold">
                        {dictationInsights.activeDays}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Last 7 days
                      </p>
                      <p className="mt-1 text-lg font-semibold">
                        {dictationInsights.lastSevenDaysDictations}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-md border px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Commands used
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {dictationInsights.commandsUsed}
                      </p>
                    </div>
                    <div className="rounded-md border px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Backtracks
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {dictationInsights.backtracksUsed}
                      </p>
                    </div>
                    <div className="rounded-md border px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Snippet expansions
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {dictationInsights.snippetsTriggered}
                      </p>
                    </div>
                    <div className="rounded-md border px-3 py-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Top app
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {dictationInsights.topAppTarget
                          ? `${dictationInsights.topAppTarget} (${dictationInsights.topAppTargetCount})`
                          : "No insert target yet"}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No saved dictation stats yet. Flow Profile starts filling in
                  once dictations are retained in history.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Dictation History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Dictations</CardTitle>
                <CardDescription>
                  Dictation recordings retained by your current auto-delete
                  policy.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetchDictationHistory()}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {dictationHistoryLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading dictation history...
                </p>
              ) : dictationHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved dictations yet. If auto-delete is set to Immediate,
                  history is intentionally not retained.
                </p>
              ) : (
                <div className="space-y-2">
                  {dictationHistory.slice(0, 25).map((recording) => (
                    <div
                      key={recording.id}
                      className="flex items-center justify-between rounded-md border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => {
                        setSelectedRecording(recording);
                        setIsDialogOpen(true);
                      }}
                    >
                      <div>
                        <p className="font-medium">{recording.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()} ·{" "}
                          {recording.status}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-muted-foreground">
                          {formatRecordingDuration(recording.duration)}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleCopyHistoryTranscript(recording.id);
                          }}
                        >
                          Copy
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteHistoryItem(recording.id);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Capture and Insert</CardTitle>
              <CardDescription>
                Modes handle the recommended defaults. These controls are here
                when you want to tune the details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Dictation profile
                  </label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationProfile}
                    onChange={(event) => {
                      const profile = event.target.value as
                        | "normal_speed"
                        | "power_rewrite";
                      setDictationProfile(profile);
                      const nextModePreset = syncModePreset({ profile });
                      void persistDictationPreferences({
                        profile,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    <option value="normal_speed">Normal Speed</option>
                    <option value="power_rewrite">Power Rewrite</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Uses the transcription method you chose in Settings.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Default Project</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={defaultProjectId}
                    onChange={(event) => {
                      const nextProjectId = event.target.value;
                      setDefaultProjectId(nextProjectId);
                      void persistDictationPreferences({
                        projectId: nextProjectId,
                      });
                    }}
                  >
                    <option value="inbox">Inbox</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Hotkey behavior</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={shortcutMode(
                      dictationPushToTalk,
                      dictationHandsFreeEnabled,
                    )}
                    onChange={(event) => {
                      const nextMode = event.target.value as
                        | "hold_to_talk"
                        | "toggle"
                        | "hands_free";
                      const pushToTalk = nextMode === "hold_to_talk";
                      const handsFreeEnabled = nextMode === "hands_free";
                      setDictationPushToTalk(pushToTalk);
                      setDictationHandsFreeEnabled(handsFreeEnabled);
                      void persistDictationPreferences({
                        pushToTalk,
                        handsFreeEnabled,
                      });
                    }}
                  >
                    <option value="hold_to_talk">Hold-to-talk</option>
                    <option value="toggle">Toggle press</option>
                    <option value="hands_free">Hands-free</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Hands-free starts on press and stops after silence or a
                    second press.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Session language
                  </label>
                  <select
                    aria-label="Session language"
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationSessionLanguage}
                    onChange={(event) => {
                      const next = event.target.value;
                      setDictationSessionLanguage(next);
                      void persistDictationPreferences({
                        sessionLanguage: next === "auto" ? null : next,
                      });
                    }}
                  >
                    {DICTATION_SESSION_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Fixed session languages always win. When this stays on auto,
                    the active set below narrows what you expect in the session
                    and locks capture if you keep only one language enabled.
                  </p>
                  <div className="rounded-md border bg-muted/20 px-3 py-3">
                    <p className="text-xs font-medium text-foreground">
                      Active language set
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Used only while Session language stays on auto detect.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {DICTATION_ACTIVE_LANGUAGE_OPTIONS.map((option) => {
                        const selected = dictationActiveLanguages.includes(
                          option.value,
                        );
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={selected}
                            aria-label={`Toggle ${option.label} active language`}
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs transition-colors",
                              selected
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-background text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => {
                              const nextActiveLanguages = selected
                                ? dictationActiveLanguages.filter(
                                    (language) => language !== option.value,
                                  )
                                : [...dictationActiveLanguages, option.value];
                              const normalized =
                                normalizeActiveLanguageSet(nextActiveLanguages);
                              setDictationActiveLanguages(normalized);
                              void persistDictationPreferences({
                                activeLanguages: normalized,
                              });
                            }}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {dictationActiveLanguages.length === 0
                        ? "No active-set filter yet. Auto detect stays fully open."
                        : dictationActiveLanguages.length === 1
                          ? `Auto detect will lock to ${DICTATION_ACTIVE_LANGUAGE_OPTIONS.find((option) => option.value === dictationActiveLanguages[0])?.label ?? dictationActiveLanguages[0]} until you add another language or set a fixed session language.`
                          : `Auto detect stays on for this set: ${dictationActiveLanguages
                              .map(
                                (language) =>
                                  DICTATION_ACTIVE_LANGUAGE_OPTIONS.find(
                                    (option) => option.value === language,
                                  )?.label ?? language,
                              )
                              .join(", ")}.`}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Live preview</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationLivePreviewEnabled ? "on" : "off"}
                    onChange={(event) => {
                      const next = event.target.value === "on";
                      setDictationLivePreviewEnabled(next);
                      void persistDictationPreferences({
                        livePreviewEnabled: next,
                      });
                    }}
                  >
                    <option value="on">Show live partials</option>
                    <option value="off">Hide live partials</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Controls whether popup and inline flows show partial
                    dictation text while you speak.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Command mode prefix
                  </label>
                  <div className="rounded-md border bg-muted/20 px-3 py-3 space-y-2">
                    <p className="text-sm font-medium">
                      {dictationCommandPrefix}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Use this before voice editing commands when command mode
                      is enabled. Great for rewrite, bulletize, summarize, and
                      coding cleanup flows.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Silence auto-stop
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={30}
                      step={0.1}
                      className="w-28 p-2 border rounded-md bg-background"
                      value={
                        dictationSilenceTimeoutSeconds <= 0
                          ? 0
                          : dictationSilenceTimeoutSeconds
                      }
                      onChange={(event) => {
                        const rawValue = Number.parseFloat(event.target.value);
                        const next = Number.isFinite(rawValue) ? rawValue : 0;
                        setDictationSilenceTimeoutSeconds(next <= 0 ? 0 : next);
                      }}
                      onBlur={(event) => {
                        const rawValue = Number.parseFloat(event.target.value);
                        const next = normalizeDictationSilenceTimeoutSeconds(
                          Number.isFinite(rawValue) ? rawValue : 0,
                        );
                        setDictationSilenceTimeoutSeconds(next);
                        void persistDictationPreferences({
                          silenceTimeoutSeconds: next,
                        });
                      }}
                    />
                    <span className="text-sm text-muted-foreground">
                      seconds
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    `0` disables silence auto-stop. Hands-free falls back to 1.8
                    seconds if this is off.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Keep warm</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationKeepWarm}
                    onChange={(event) => {
                      const next = event.target.value as
                        | "off"
                        | "short"
                        | "long";
                      setDictationKeepWarm(next);
                      void persistDictationPreferences({ keepWarm: next });
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="short">Short</option>
                    <option value="long">Long</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Keeps the active dictation route warmer between captures to
                    reduce startup latency.
                  </p>
                </div>

                <div className="rounded-md border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">
                    Hands-free guide
                  </p>
                  <p className="mt-2">
                    First press starts capture. A second press stops
                    immediately. If silence auto-stop is set to{" "}
                    <span className="font-mono">0</span>, hands-free still uses
                    a 1.8 second fallback so sessions do not hang open.
                  </p>
                  <p className="mt-2">
                    Active capture language:{" "}
                    <span className="font-mono">
                      {effectiveCaptureLanguage ?? "auto"}
                    </span>
                    {dictationModePreset === "custom" &&
                    customModeDraft.languageOverride.trim()
                      ? " via flow profile override."
                      : dictationSessionLanguage !== "auto"
                        ? " from the fixed session setting."
                        : dictationActiveLanguages.length === 1
                          ? " from the active language set."
                          : " from provider auto-detect."}
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Text context</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationContextSource}
                    onChange={(event) => {
                      const contextSource = event.target
                        .value as DictationContextSource;
                      setDictationContextSource(contextSource);
                      const nextModePreset = syncModePreset({ contextSource });
                      void persistDictationPreferences({
                        contextSource,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    <option value="none">Off</option>
                    <option value="application_context">
                      Use application context
                    </option>
                    <option value="selected_text">Use selected text</option>
                    <option value="clipboard">Use clipboard</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Lets voice commands transform existing text. Try
                    &quot;command rewrite professional&quot; , &quot;command
                    bulletize selection&quot;, &quot;command replace roadmap
                    with launch plan&quot;, or editing commands like
                    &quot;command replace selection with approved plan&quot;,
                    &quot;command append today&quot;, &quot;command delete
                    phrase roadmap&quot;, and case changes like &quot;command
                    uppercase selection&quot; or &quot;command title case
                    selection&quot;. Correction commands like &quot;command undo
                    that&quot; work without text context. Application context
                    captures the frontmost app, window title, and selected text
                    when available.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Auto-delete dictation recordings
                  </label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationRetentionPreset}
                    onChange={(event) => {
                      const preset = event.target.value as
                        | "immediate"
                        | "24h"
                        | "72h"
                        | "never"
                        | "custom";
                      setDictationRetentionPreset(preset);
                      void persistDictationPreferences({
                        retentionPreset: preset,
                      });
                    }}
                  >
                    <option value="immediate">Immediately</option>
                    <option value="24h">After 24 hours</option>
                    <option value="72h">After 72 hours</option>
                    <option value="never">Never</option>
                    <option value="custom">Custom</option>
                  </select>
                  {dictationRetentionPreset === "custom" && (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">
                        Custom hours
                      </label>
                      <input
                        type="number"
                        min={1}
                        className="w-full p-2 border rounded-md bg-background"
                        value={dictationRetentionCustomHours}
                        onChange={(event) => {
                          const nextHours = Math.max(
                            1,
                            Number(event.target.value) || 1,
                          );
                          setDictationRetentionCustomHours(nextHours);
                          void persistDictationPreferences({
                            retentionCustomHours: nextHours,
                          });
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Insertion mode</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationInsertionMode}
                    onChange={(event) => {
                      const mode = event.target.value as
                        | "auto"
                        | "paste"
                        | "inline"
                        | "clipboard_only";
                      setDictationInsertionMode(mode);
                      const nextModePreset = syncModePreset({
                        insertionMode: mode,
                      });
                      void persistDictationPreferences({
                        insertionMode: mode,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    <option value="auto">Recommended</option>
                    <option value="paste">Paste at cursor</option>
                    <option value="inline">Insert on release</option>
                    <option value="clipboard_only">Clipboard only</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Recommended tries the best available insertion path. Insert
                    on release keeps the flow simple and consistent.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Command mode prefix
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationCommandPrefix}
                    onChange={(event) =>
                      setDictationCommandPrefix(event.target.value)
                    }
                    onBlur={() => {
                      const nextPrefix =
                        dictationCommandPrefix.trim() || "command";
                      setDictationCommandPrefix(nextPrefix);
                      void persistDictationPreferences({
                        commandPrefix: nextPrefix,
                      });
                    }}
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={dictationCommandModeEnabled}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationCommandModeEnabled(next);
                        const nextModePreset = syncModePreset({
                          commandModeEnabled: next,
                        });
                        void persistDictationPreferences({
                          commandModeEnabled: next,
                          modePreset: nextModePreset,
                        });
                      }}
                    />
                    Enable command mode
                  </label>
                </div>
              </div>

              <div className="mt-5 border-t pt-4 space-y-3">
                <div>
                  <p className="text-sm font-medium">Text actions</p>
                  <p className="text-xs text-muted-foreground">
                    Customize rewrite and bullet actions that run after
                    dictation.
                  </p>
                </div>
                <div className="space-y-3">
                  {COMMAND_PRESET_FIELDS.map((field) => {
                    const preset = getCommandPreset(field.key);
                    const promptValue =
                      preset?.systemPrompt ?? field.defaultPrompt;
                    const enabledValue = preset?.enabled ?? true;
                    return (
                      <div
                        key={field.key}
                        className="rounded-md border p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium">
                            {field.label}
                          </label>
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={enabledValue}
                                onChange={(event) => {
                                  const next = event.target.checked;
                                  setCommandPresetDraft(field.key, {
                                    enabled: next,
                                  });
                                  void upsertCommandPreset(
                                    field.key,
                                    promptValue,
                                    next,
                                  );
                                }}
                              />
                              Enabled
                            </label>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void resetCommandPreset(field.key)}
                            >
                              Reset
                            </Button>
                          </div>
                        </div>
                        <textarea
                          className="w-full min-h-[84px] p-2 border rounded-md bg-background text-sm"
                          value={promptValue}
                          onChange={(event) =>
                            setCommandPresetDraft(field.key, {
                              systemPrompt: event.target.value,
                            })
                          }
                          onBlur={(event) => {
                            const nextPrompt =
                              event.target.value.trim() || field.defaultPrompt;
                            setCommandPresetDraft(field.key, {
                              systemPrompt: nextPrompt,
                            });
                            void upsertCommandPreset(
                              field.key,
                              nextPrompt,
                              enabledValue,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Dictionary</p>
                    <p className="text-xs text-muted-foreground">
                      Normalize names, brands, and phrases before snippets are
                      applied.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={openDictionaryImportDialog}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Import CSV
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleExportDictionaryCsv()}
                      disabled={dictionaryCsvBusy}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={dictationAutoLearnCorrections}
                        onChange={(event) => {
                          const next = event.target.checked;
                          setDictationAutoLearnCorrections(next);
                          void persistDictationPreferences({
                            autoLearnCorrections: next,
                          });
                        }}
                      />
                      Auto-learn corrections
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_auto] gap-2">
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Say (e.g. open ai)"
                    value={newDictionarySpokenForm}
                    onChange={(event) =>
                      setNewDictionarySpokenForm(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Insert (e.g. OpenAI)"
                    value={newDictionaryReplacement}
                    onChange={(event) =>
                      setNewDictionaryReplacement(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="App scope (optional)"
                    value={newDictionaryAppScope}
                    onChange={(event) =>
                      setNewDictionaryAppScope(event.target.value)
                    }
                  />
                  <Button
                    variant="outline"
                    onClick={() => void handleAddDictionaryEntry()}
                  >
                    Add
                  </Button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newDictionaryCaseSensitive}
                    onChange={(event) =>
                      setNewDictionaryCaseSensitive(event.target.checked)
                    }
                  />
                  Case-sensitive match
                </label>

                {dictationDictionaryEntries.length > 0 && (
                  <div className="space-y-2">
                    {dictationDictionaryEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-md border p-2 space-y-2"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={entry.spokenForm}
                            onChange={(event) =>
                              setDictationDictionaryEntries((prev) =>
                                prev.map((current) =>
                                  current.id === entry.id
                                    ? {
                                        ...current,
                                        spokenForm: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchDictionaryEntry(entry.id, {
                                spokenForm: event.target.value.trim(),
                              })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            value={entry.replacement}
                            onChange={(event) =>
                              setDictationDictionaryEntries((prev) =>
                                prev.map((current) =>
                                  current.id === entry.id
                                    ? {
                                        ...current,
                                        replacement: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchDictionaryEntry(entry.id, {
                                replacement: event.target.value.trim(),
                              })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            placeholder="App scope"
                            value={entry.appScope ?? ""}
                            onChange={(event) =>
                              setDictationDictionaryEntries((prev) =>
                                prev.map((current) =>
                                  current.id === entry.id
                                    ? {
                                        ...current,
                                        appScope: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchDictionaryEntry(entry.id, {
                                appScope: event.target.value.trim() || null,
                              })
                            }
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={entry.caseSensitive}
                                onChange={(event) =>
                                  void patchDictionaryEntry(entry.id, {
                                    caseSensitive: event.target.checked,
                                  })
                                }
                              />
                              Case-sensitive
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={entry.enabled}
                                onChange={(event) =>
                                  void patchDictionaryEntry(entry.id, {
                                    enabled: event.target.checked,
                                  })
                                }
                              />
                              Enabled
                            </label>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void handleDeleteDictionaryEntry(entry.id)
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {dictionaryCsvStatus && (
                  <p className="text-xs text-muted-foreground">
                    {dictionaryCsvStatus}
                  </p>
                )}
                <div className="rounded-md border bg-background/60 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium">
                      Teach Plainsong your words
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dictionaryCoverageSummary}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Use global entries for names and jargon you want everywhere.
                    Use app scope when a replacement should only happen in a
                    specific app.
                  </p>
                </div>
                <div className="rounded-md border bg-muted/20 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Correction Inbox</p>
                      <p className="text-xs text-muted-foreground">
                        Auto-learned corrections stay here until you approve
                        them.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {dictationCorrectionSuggestions.length} pending
                      </span>
                      {groupedCorrectionSuggestions.length > 1 && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={correctionInboxBusy}
                            onClick={() =>
                              void handleApproveCorrectionSuggestionGroup(
                                groupedCorrectionSuggestions.flatMap(
                                  (group) => group.suggestionIds,
                                ),
                              )
                            }
                          >
                            Approve all
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={correctionInboxBusy}
                            onClick={() =>
                              void handleRejectCorrectionSuggestionGroup(
                                groupedCorrectionSuggestions.flatMap(
                                  (group) => group.suggestionIds,
                                ),
                              )
                            }
                          >
                            Dismiss all
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {groupedCorrectionSuggestions.length > 0 ? (
                    <div className="space-y-2">
                      {groupedCorrectionSuggestions.map((group) => (
                        <div
                          key={group.key}
                          className="rounded-md border bg-background px-3 py-2"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <p className="text-sm font-medium">
                                {group.spokenForm} {"->"} {group.replacement}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {group.appTarget
                                  ? `Source app: ${group.appTarget}`
                                  : "Global suggestion"}
                                {" · "}
                                {new Date(group.updatedAt).toLocaleString()}
                                {group.suggestionIds.length > 1
                                  ? ` · ${group.suggestionIds.length} similar edits`
                                  : ""}
                              </p>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={correctionInboxBusy}
                                onClick={() =>
                                  void handleApproveCorrectionSuggestionGroup(
                                    group.suggestionIds,
                                  )
                                }
                              >
                                {group.suggestionIds.length > 1
                                  ? "Approve all"
                                  : "Approve"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={correctionInboxBusy}
                                onClick={() =>
                                  void handleRejectCorrectionSuggestionGroup(
                                    group.suggestionIds,
                                  )
                                }
                              >
                                {group.suggestionIds.length > 1
                                  ? "Dismiss all"
                                  : "Dismiss"}
                              </Button>
                            </div>
                          </div>
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div className="rounded-md bg-muted/40 px-2 py-2">
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Heard
                              </p>
                              <p className="mt-1 text-sm">
                                {group.sampleOriginalText}
                              </p>
                            </div>
                            <div className="rounded-md bg-muted/40 px-2 py-2">
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Corrected
                              </p>
                              <p className="mt-1 text-sm">
                                {group.sampleCorrectedText}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No pending corrections. Auto-learned edits will appear
                      here for review.
                    </p>
                  )}
                </div>
                <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                  <p className="text-sm font-medium">Backtrack shortcuts</p>
                  <p className="text-xs text-muted-foreground">
                    Use quick correction phrases right after an insert:{" "}
                    <code>scratch that</code>, <code>actually ...</code>,{" "}
                    <code>no, say ...</code>, <code>replace X with Y</code>, or{" "}
                    <code>change X to Y</code>.
                  </p>
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded-full border bg-background px-2 py-1">
                      Undo last insert
                    </span>
                    <span className="rounded-full border bg-background px-2 py-1">
                      Replace most recent phrase
                    </span>
                    <span className="rounded-full border bg-background px-2 py-1">
                      Keep flow without touching the keyboard
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-5 border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Phrase expansions</p>
                    <p className="text-xs text-muted-foreground">
                      Expand short trigger phrases before text is inserted.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={dictationSnippetsEnabled}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationSnippetsEnabled(next);
                        void persistDictationPreferences({
                          snippetsEnabled: next,
                        });
                      }}
                    />
                    Enabled
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_auto] gap-2">
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Trigger (e.g. brb)"
                    value={newSnippetTrigger}
                    onChange={(event) =>
                      setNewSnippetTrigger(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Expansion (e.g. be right back)"
                    value={newSnippetExpansion}
                    onChange={(event) =>
                      setNewSnippetExpansion(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="App scope (optional)"
                    value={newSnippetAppScope}
                    onChange={(event) =>
                      setNewSnippetAppScope(event.target.value)
                    }
                  />
                  <Button
                    variant="outline"
                    onClick={() => void handleAddSnippet()}
                  >
                    Add
                  </Button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newSnippetCaseSensitive}
                    onChange={(event) =>
                      setNewSnippetCaseSensitive(event.target.checked)
                    }
                  />
                  Case-sensitive trigger
                </label>

                {dictationSnippets.length > 0 && (
                  <div className="space-y-2">
                    {dictationSnippets.map((snippet) => (
                      <div
                        key={snippet.id}
                        className="rounded-md border p-2 space-y-2"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={snippet.trigger}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? {
                                        ...current,
                                        trigger: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, {
                                trigger: event.target.value.trim(),
                              })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            value={snippet.expansion}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? {
                                        ...current,
                                        expansion: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, {
                                expansion: event.target.value.trim(),
                              })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            placeholder="App scope"
                            value={snippet.appScope ?? ""}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? {
                                        ...current,
                                        appScope: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, {
                                appScope: event.target.value.trim() || null,
                              })
                            }
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={snippet.caseSensitive}
                                onChange={(event) =>
                                  void patchSnippet(snippet.id, {
                                    caseSensitive: event.target.checked,
                                  })
                                }
                              />
                              Case-sensitive
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={snippet.enabled}
                                onChange={(event) =>
                                  void patchSnippet(snippet.id, {
                                    enabled: event.target.checked,
                                  })
                                }
                              />
                              Enabled
                            </label>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDeleteSnippet(snippet.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>
                {selectedRecording?.title ?? "Dictation"}
              </DialogTitle>
              {selectedRecording && (
                <div className="flex gap-2">
                  {selectedTranscript?.fullText?.trim() && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void toggleReadAloudPlayback(
                          selectedTranscript.fullText,
                          `history-${selectedRecording.id}`,
                        )
                      }
                    >
                      <Volume2 className="h-4 w-4 mr-2" />
                      {activeSpeechTarget === `history-${selectedRecording.id}`
                        ? "Stop reading"
                        : "Read aloud"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleCopyHistoryTranscript(selectedRecording.id)
                    }
                  >
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleDeleteHistoryItem(selectedRecording.id)
                    }
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </DialogHeader>
          {isLoadingTranscript ? (
            <p className="text-muted-foreground">Loading transcript...</p>
          ) : selectedTranscript ? (
            <div className="space-y-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Capture details</p>
                    <p className="text-xs text-muted-foreground">
                      Inspect the original route, model, and transcript quality
                      before reprocessing.
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Requested engine
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.requestedProvider || "Default route"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Actual engine
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.actualProvider ||
                        selectedTranscript.requestedProvider ||
                        "Unknown"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Model
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.modelId ||
                        selectedTranscript.model ||
                        "Unknown"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Language
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.language || "Unknown"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Confidence
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {Number.isFinite(selectedTranscript.confidence)
                        ? `${Math.round(selectedTranscript.confidence * 100)}%`
                        : "Unavailable"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Segments
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.segments?.length ?? 0}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Start
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedHistoryDetails?.startupLatencyMs != null
                        ? selectedHistoryDetails.startupLatencyMs < 1000
                          ? `${selectedHistoryDetails.startupLatencyMs}ms`
                          : `${(selectedHistoryDetails.startupLatencyMs / 1000).toFixed(1)}s`
                        : "Unavailable"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <div>
                  <p className="text-sm font-medium">Prompt and context</p>
                  <p className="text-xs text-muted-foreground">
                    Inspect the app context and prompt strategy Plainsong used
                    for this dictation.
                  </p>
                </div>
                {selectedHistoryDetails ? (
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Mode
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {historyModeLabel(selectedHistoryDetails)}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Base style
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedHistoryDetails?.baseModeLabel ??
                            (selectedHistoryDetails?.baseModePreset
                              ? (modeDefinitionById[
                                  selectedHistoryDetails.baseModePreset as DictationModePreset
                                ]?.label ??
                                selectedHistoryDetails.baseModePreset)
                              : "Unavailable")}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Context source
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedHistoryDetails.contextSource ??
                            "Unavailable"}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Requested route
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedHistoryDetails.routePreference
                            ? selectedHistoryDetails.routePreference === "cloud"
                              ? "Cloud"
                              : "Local"
                            : "Unavailable"}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Resolved hosting
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedHistoryDetails.resolvedHosting
                            ? selectedHistoryDetails.resolvedHosting === "cloud"
                              ? "Cloud"
                              : "Local"
                            : "Unavailable"}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Prompt strategy
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {historyPromptSourceLabel(
                            selectedHistoryDetails.promptSource,
                          )}
                        </p>
                      </div>
                    </div>
                    {(selectedHistoryDetails.customModeName ||
                      selectedHistoryDetails.contextAppName ||
                      selectedHistoryDetails.appTarget ||
                      selectedHistoryDetails.activationMatcher ||
                      selectedHistoryDetails.commandApplied) && (
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {selectedHistoryDetails.customModeName && (
                          <span>
                            Custom mode: {selectedHistoryDetails.customModeName}
                          </span>
                        )}
                        {selectedHistoryDetails.contextAppName && (
                          <span>
                            Context app: {selectedHistoryDetails.contextAppName}
                          </span>
                        )}
                        {selectedHistoryDetails.appTarget && (
                          <span>
                            Insert target: {selectedHistoryDetails.appTarget}
                          </span>
                        )}
                        {selectedHistoryDetails.activationMatcher && (
                          <span>
                            Auto rule:{" "}
                            {selectedHistoryDetails.customModeName
                              ? `${selectedHistoryDetails.customModeName} via ${selectedHistoryDetails.activationMatcher}`
                              : selectedHistoryDetails.activationMatcher}
                          </span>
                        )}
                        {selectedHistoryDetails.commandApplied && (
                          <span>
                            Command: {selectedHistoryDetails.commandApplied}
                          </span>
                        )}
                      </div>
                    )}
                    {(selectedHistoryDetails.pipelineStageKeys.length > 0 ||
                      selectedHistoryDetails.dictionaryAppliedCount != null ||
                      selectedHistoryDetails.snippetAppliedCount != null ||
                      selectedHistoryDetails.formattingApplied != null ||
                      selectedHistoryDetails.recentInsertReused != null) && (
                      <div className="rounded-md border bg-muted/20 p-3 space-y-3">
                        <div>
                          <p className="text-sm font-medium">Pipeline trace</p>
                          <p className="text-xs text-muted-foreground">
                            Shows which deterministic stages changed the text
                            before delivery.
                          </p>
                        </div>
                        {selectedHistoryDetails.pipelineStageKeys.length >
                          0 && (
                          <div className="flex flex-wrap gap-2">
                            {selectedHistoryDetails.pipelineStageKeys.map(
                              (stageKey) => (
                                <span
                                  key={stageKey}
                                  className="rounded-full border bg-background px-2 py-1 text-[11px] font-medium"
                                >
                                  {historyPipelineStageLabel(stageKey)}
                                </span>
                              ),
                            )}
                          </div>
                        )}
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="rounded-md border bg-background px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Dictionary
                            </p>
                            <p className="mt-1 text-sm font-medium">
                              {selectedHistoryDetails.dictionaryAppliedCount ??
                                0}{" "}
                              rules
                            </p>
                          </div>
                          <div className="rounded-md border bg-background px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Snippets
                            </p>
                            <p className="mt-1 text-sm font-medium">
                              {selectedHistoryDetails.snippetAppliedCount ?? 0}{" "}
                              expansions
                            </p>
                          </div>
                          <div className="rounded-md border bg-background px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Formatting
                            </p>
                            <p className="mt-1 text-sm font-medium">
                              {selectedHistoryDetails.formattingApplied
                                ? "Applied"
                                : "Not applied"}
                            </p>
                          </div>
                          <div className="rounded-md border bg-background px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Recent insert
                            </p>
                            <p className="mt-1 text-sm font-medium">
                              {selectedHistoryDetails.recentInsertReused
                                ? "Reused"
                                : "Not reused"}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    {(selectedHistoryDetails.contextPreview ||
                      selectedHistoryDetails.promptPreview) && (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">
                            Captured context
                          </p>
                          <div className="min-h-[110px] rounded-lg bg-muted p-4 text-sm">
                            <p className="whitespace-pre-wrap">
                              {selectedHistoryDetails.contextPreview ||
                                "No saved context preview."}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Prompt preview</p>
                          <div className="min-h-[110px] rounded-lg bg-muted p-4 text-sm">
                            <p className="whitespace-pre-wrap">
                              {selectedHistoryDetails.promptPreview ||
                                "Using the standard prompt for this path."}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Prompt/context inspection is available for newer dictations
                    saved after this update.
                  </p>
                )}
              </div>

              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Reprocess with mode
                    </label>
                    <select
                      className="w-full min-w-[220px] rounded-md border bg-background p-2 text-sm"
                      value={reprocessModePreset}
                      onChange={(event) =>
                        setReprocessModePreset(
                          event.target.value as DictationModePreset,
                        )
                      }
                    >
                      {DICTATION_MODE_DEFINITIONS.filter(
                        (mode) => mode.id !== "custom",
                      ).map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void handleReprocessSelectedDictation()}
                      disabled={isReprocessing}
                    >
                      {isReprocessing ? "Reprocessing..." : "Reprocess"}
                    </Button>
                    {reprocessedResult && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setTranscribedText(reprocessedResult.outputText);
                          setPasteStatus(
                            `Reprocessed with ${modeDefinitionById[reprocessedResult.modePreset as DictationModePreset]?.label ?? reprocessedResult.modePreset}`,
                          );
                        }}
                      >
                        Use Result
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Compare the saved transcript with a mode-tuned result before
                  you copy or reuse it.
                </p>
                {reprocessError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {reprocessError}
                  </div>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Heard
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {selectedTranscript.requestedProvider || "Default route"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedTranscript.modelId ||
                      selectedTranscript.model ||
                      "Unknown model"}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Ready to use
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {reprocessedResult
                      ? (modeDefinitionById[
                          reprocessedResult.modePreset as DictationModePreset
                        ]?.label ?? reprocessedResult.modePreset)
                      : (modeDefinitionById[reprocessModePreset]?.label ??
                        reprocessModePreset)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {reprocessedResult
                      ? reprocessedResult.usedAi
                        ? "AI-tuned output"
                        : "Rule-based output"
                      : "Pick a mode to preview a final version"}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Compare
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {reprocessedResult
                      ? "Before and after"
                      : "Raw transcript only"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Judge what Plainsong heard versus what you want to paste or
                    save.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">What Plainsong heard</p>
                      <p className="text-xs text-muted-foreground">
                        The saved raw transcript from the original capture. Edit
                        it to teach Plainsong a correction.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigator.clipboard.writeText(historyCorrectionText)
                        }
                      >
                        Copy
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          historyCorrectionBaseline.trim() ===
                          historyCorrectionText.trim()
                        }
                        onClick={() =>
                          void learnCorrection(
                            historyCorrectionBaseline,
                            historyCorrectionText,
                            {
                              force: true,
                              appTarget:
                                selectedHistoryDetails?.activationMatcher ??
                                selectedHistoryDetails?.appTarget ??
                                selectedHistoryDetails?.contextAppName ??
                                null,
                              setStatus: setHistoryLearnStatus,
                              onSuccess: () =>
                                setHistoryCorrectionBaseline(
                                  historyCorrectionText.trim(),
                                ),
                            },
                          )
                        }
                      >
                        Learn correction
                      </Button>
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-4 min-h-[180px]">
                    <textarea
                      className="min-h-[180px] w-full resize-y bg-transparent text-sm outline-none"
                      value={historyCorrectionText}
                      onChange={(event) =>
                        setHistoryCorrectionText(event.target.value)
                      }
                      onBlur={() => {
                        void maybeAutoLearnHistoryCorrection();
                      }}
                    />
                  </div>
                  {historyLearnStatus && (
                    <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">
                      {historyLearnStatus}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Ready to use</p>
                      <p className="text-xs text-muted-foreground">
                        A mode-shaped result for paste, clipboard, or follow-up
                        writing.
                      </p>
                    </div>
                    {reprocessedResult?.outputText && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            reprocessedResult.outputText,
                          )
                        }
                      >
                        Copy
                      </Button>
                    )}
                  </div>
                  <div className="p-4 bg-muted rounded-lg min-h-[180px]">
                    {reprocessedResult ? (
                      <p className="whitespace-pre-wrap text-sm">
                        {reprocessedResult.outputText}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Pick a mode and run Reprocess to preview an alternate
                        result.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                Duration:{" "}
                {selectedRecording
                  ? formatRecordingDuration(selectedRecording.duration)
                  : "N/A"}{" "}
                · Created:{" "}
                {selectedRecording
                  ? new Date(selectedRecording.createdAt).toLocaleString()
                  : "N/A"}
                {reprocessedResult && (
                  <>
                    {" "}
                    · Final mode:{" "}
                    {modeDefinitionById[
                      reprocessedResult.modePreset as DictationModePreset
                    ]?.label ?? reprocessedResult.modePreset}{" "}
                    · {reprocessedResult.usedAi ? "AI tuned" : "Rule based"}
                    {reprocessedResult.provider
                      ? ` · Final engine: ${reprocessedResult.provider}`
                      : ""}
                    {reprocessedResult.modelId
                      ? ` · Final model: ${reprocessedResult.modelId}`
                      : ""}
                  </>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No transcript available for this dictation.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={dictionaryCsvDialogOpen}
        onOpenChange={setDictionaryCsvDialogOpen}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dictionaryCsvMode === "import"
                ? "Import Dictionary CSV"
                : "Export Dictionary CSV"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {dictionaryCsvMode === "import"
                ? "Paste CSV with columns spoken_form, replacement, optional app_scope, case_sensitive, and enabled."
                : "Copy this CSV to keep a portable backup of your dictionary or move it to another device."}
            </p>
            <textarea
              className="min-h-[320px] w-full resize-y rounded-md border bg-background p-3 text-sm font-mono outline-none"
              value={dictionaryCsvText}
              onChange={(event) => setDictionaryCsvText(event.target.value)}
              readOnly={dictionaryCsvMode === "export"}
              spellCheck={false}
            />
            {dictionaryCsvStatus && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {dictionaryCsvStatus}
              </div>
            )}
            {dictionaryCsvImportResult?.errors.length ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {dictionaryCsvImportResult.errors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              {dictionaryCsvMode === "export" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleCopyDictionaryCsv()}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy CSV
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void handleImportDictionaryCsv()}
                  disabled={dictionaryCsvBusy}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Import & Merge
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
