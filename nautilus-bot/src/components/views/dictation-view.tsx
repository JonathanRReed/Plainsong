import { useState, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useRecording } from "@/hooks/use-recording";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import {
  getSettings,
  saveSettings,
  getTranscript,
  reprocessDictationText,
  deleteRecording,
  listDictationDictionaryEntries,
  createDictationDictionaryEntry,
  updateDictationDictionaryEntry,
  deleteDictationDictionaryEntry,
  listDictationSnippets,
  createDictationSnippet,
  updateDictationSnippet,
  deleteDictationSnippet,
  listDictationCommandPresets,
  upsertDictationCommandPreset,
  deleteDictationCommandPreset,
  type DictationDictionaryEntry,
  type DictationSnippet,
  type DictationCommandPreset,
  type DictationReprocessResult,
  type DictationHistoryDetails,
  getDictationHistoryDetails,
} from "@/lib/tauri";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Keyboard, Mic, Square, Zap, Save, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { AsrProviderType, Recording, Transcript } from "@/types";
import type { DictationCustomMode } from "@/types/settings";

interface DictationTextReadyEvent {
  text: string;
  pasted?: boolean;
  copied?: boolean;
  pasteError?: string | null;
  requestedProvider?: string;
  actualProvider?: string;
  isFallback?: boolean;
  fallbackReason?: string | null;
  fallbackMessage?: string | null;
  modelId?: string;
  startupLatencyMs?: number | null;
  latencyMs?: number;
  insertLatencyMs?: number;
  endToEndMs?: number;
  insertionModeUsed?: "auto" | "paste" | "inline" | "clipboard_only" | "command_only" | "none";
  commandApplied?: string | null;
  snippetAppliedCount?: number;
  appTarget?: string | null;
  activationMatcher?: string | null;
  contextSource?: DictationContextSource | null;
  contextChars?: number | null;
  routePreference?: DictationRoutePreference | null;
  resolvedRoute?: string | null;
  resolvedHosting?: DictationRoutePreference | null;
  providerModelLabel?: string | null;
}

type DictationModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up"
  | "custom";
type DictationBaseModePreset = Exclude<DictationModePreset, "custom">;

type DictationInsertionMode = "auto" | "paste" | "inline" | "clipboard_only";
type DictationContextSource = "none" | "clipboard" | "selected_text" | "application_context";

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

type DictationModeSummaryItem = {
  label: string;
  value: string;
};

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

const ACTIVATION_APP_SUGGESTIONS = ["Slack", "Cursor", "Messages"];
const ACTIVATION_DOMAIN_SUGGESTIONS = ["gmail.com", "linear.app", "docs.google.com"];

const RECOMMENDED_APP_STYLES: RecommendedAppStyle[] = [
  {
    id: "builtin-slack-replies",
    name: "Slack Replies",
    description: "Short, clean replies that auto-activate in Slack and keep command edits ready.",
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
    description: "Polished email drafting with selected-text context and auto-activation on Gmail.",
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
    description: "Long-form drafting with browser context and clean insert behavior for Docs.",
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
    description: "Fast notes and structured edits for Notion pages with live preview on.",
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
    description: "Issue updates with concise drafting and selected-text editing on linear.app.",
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

const DICTATION_MODE_DEFINITIONS: DictationModeDefinition[] = [
  {
    id: "voice",
    label: "Voice",
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
    label: "Messages",
    description: "Quick replies that paste cleanly into the current app.",
    profile: "normal_speed",
    insertionMode: "paste",
    contextSource: "none",
    saveToInbox: false,
    copyToClipboard: true,
    commandModeEnabled: false,
  },
  {
    id: "email",
    label: "Email",
    description: "Slower, cleaner output for polished writing and rewrites.",
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
  domainMatcher: string | null | undefined
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

  return "Manual only. This mode stays available, but Nautilus will not switch into it automatically.";
}

function createCustomModeDraft(
  overrides?: Partial<DictationCustomModeDraft>
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

function dictationModeLabel(modePreset: Exclude<DictationModePreset, "custom">): string {
  return (
    DICTATION_MODE_DEFINITIONS.find((definition) => definition.id === modePreset)?.label ?? "Voice"
  );
}

function coerceBaseModePreset(modePreset: string | null | undefined): DictationBaseModePreset {
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
      modeDefinitionByIdStatic[details.modePreset as DictationModePreset]?.label ?? details.modePreset
    );
  }
  return "Unavailable";
}

const modeDefinitionByIdStatic = DICTATION_MODE_DEFINITIONS.reduce<
  Record<DictationModePreset, DictationModeDefinition>
>((accumulator, definition) => {
  accumulator[definition.id] = definition;
  return accumulator;
}, {} as Record<DictationModePreset, DictationModeDefinition>);

function historyPromptSourceLabel(promptSource: string | null | undefined): string {
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
    { label: "History", value: mode.saveToInbox ? "Save to Inbox" : "Do not save" },
    { label: "Clipboard", value: mode.copyToClipboard ? "Copy enabled" : "Copy off" },
    { label: "Commands", value: mode.commandModeEnabled ? "Command mode on" : "Command mode off" },
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
  const { isRecording, formattedDuration, startDictation, stopDictation } = useRecording();
  const { projects } = useProjects();
  const { recordings, isLoading: dictationHistoryLoading, refetch: refetchDictationHistory } = useRecordings();
  const defaultShortcut = defaultDictationShortcut();
  const [hotkeyLabel, setHotkeyLabel] = useState(formatShortcutForDisplay(defaultShortcut));
  const [hotkeyShortcut, setHotkeyShortcut] = useState(defaultShortcut);
  const [transcribedText, setTranscribedText] = useState("");
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModelId, setLastModelId] = useState<string | null>(null);
  const [lastRoutePreference, setLastRoutePreference] =
    useState<DictationRoutePreference | null>(null);
  const [lastResolvedRoute, setLastResolvedRoute] = useState<string | null>(null);
  const [lastProviderModelLabel, setLastProviderModelLabel] = useState<string | null>(null);
  const [lastResolvedHosting, setLastResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [startupLatencyMs, setStartupLatencyMs] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [insertionModeUsed, setInsertionModeUsed] = useState<string | null>(null);
  const [commandApplied, setCommandApplied] = useState<string | null>(null);
  const [snippetAppliedCount, setSnippetAppliedCount] = useState(0);
  const [appTarget, setAppTarget] = useState<string | null>(null);
  const [activationMatcher, setActivationMatcher] = useState<string | null>(null);
  const [contextChars, setContextChars] = useState<number | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [saveToInbox, setSaveToInbox] = useState(true);
  const [dictationProfile, setDictationProfile] = useState<"normal_speed" | "power_rewrite">(
    "normal_speed"
  );
  const [dictationModePreset, setDictationModePreset] =
    useState<DictationModePreset>(DEFAULT_DICTATION_MODE);
  const [dictationCustomModes, setDictationCustomModes] = useState<DictationCustomMode[]>([]);
  const [selectedCustomModeId, setSelectedCustomModeId] = useState<string | null>(null);
  const [customModeDraft, setCustomModeDraft] = useState<DictationCustomModeDraft>(
    createCustomModeDraft()
  );
  const [defaultProjectId, setDefaultProjectId] = useState("inbox");
  const [dictationPushToTalk, setDictationPushToTalk] = useState(true);
  const [dictationHandsFreeEnabled, setDictationHandsFreeEnabled] = useState(false);
  const [dictationRoutePreference, setDictationRoutePreference] =
    useState<DictationRoutePreference>("local");
  const [dictationRouteOverrideEnabled, setDictationRouteOverrideEnabled] = useState(true);
  const [dictationKeepWarm, setDictationKeepWarm] = useState<"off" | "short" | "long">("short");
  const [dictationLivePreviewEnabled, setDictationLivePreviewEnabled] = useState(true);
  const [nextCaptureRoutePreference, setNextCaptureRoutePreference] = useState<
    DictationRoutePreference | null
  >(null);
  const [dictationContextSource, setDictationContextSource] =
    useState<DictationContextSource>("none");
  const [dictationCopyToClipboard, setDictationCopyToClipboard] = useState(true);
  const [dictationCommandModeEnabled, setDictationCommandModeEnabled] = useState(true);
  const [dictationCommandPrefix, setDictationCommandPrefix] = useState("command");
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("auto");
  const [dictationSnippetsEnabled, setDictationSnippetsEnabled] = useState(true);
  const [dictationDictionaryEntries, setDictationDictionaryEntries] = useState<
    DictationDictionaryEntry[]
  >([]);
  const [dictationSnippets, setDictationSnippets] = useState<DictationSnippet[]>([]);
  const [dictationCommandPresets, setDictationCommandPresets] = useState<
    DictationCommandPreset[]
  >([]);
  const [newDictionarySpokenForm, setNewDictionarySpokenForm] = useState("");
  const [newDictionaryReplacement, setNewDictionaryReplacement] = useState("");
  const [newDictionaryAppScope, setNewDictionaryAppScope] = useState("");
  const [newDictionaryCaseSensitive, setNewDictionaryCaseSensitive] = useState(false);
  const [newSnippetTrigger, setNewSnippetTrigger] = useState("");
  const [newSnippetExpansion, setNewSnippetExpansion] = useState("");
  const [newSnippetAppScope, setNewSnippetAppScope] = useState("");
  const [newSnippetCaseSensitive, setNewSnippetCaseSensitive] = useState(false);
  const [dictationRetentionPreset, setDictationRetentionPreset] = useState<
    "immediate" | "24h" | "72h" | "never" | "custom"
  >("never");
  const [dictationRetentionCustomHours, setDictationRetentionCustomHours] = useState(24);
  const [hotkeyPressed, setHotkeyPressed] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [selectedHistoryDetails, setSelectedHistoryDetails] = useState<DictationHistoryDetails | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reprocessModePreset, setReprocessModePreset] =
    useState<DictationModePreset>(DEFAULT_DICTATION_MODE);
  const [reprocessedResult, setReprocessedResult] = useState<DictationReprocessResult | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const [currentDictationProvider, setCurrentDictationProvider] = useState<string | null>(null);
  const [currentDictationModelId, setCurrentDictationModelId] = useState<string | null>(null);
  const [currentAiProvider, setCurrentAiProvider] = useState<string | null>(null);
  const [currentAiModelId, setCurrentAiModelId] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const modeDefinitionById = useMemo(
    () =>
      DICTATION_MODE_DEFINITIONS.reduce<Record<DictationModePreset, DictationModeDefinition>>(
        (acc, definition) => {
          acc[definition.id] = definition;
          return acc;
        },
        {} as Record<DictationModePreset, DictationModeDefinition>
      ),
    []
  );

  const selectedCustomMode = useMemo(
    () =>
      selectedCustomModeId
        ? dictationCustomModes.find((mode) => mode.id === selectedCustomModeId) ?? null
        : null,
    [dictationCustomModes, selectedCustomModeId]
  );

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
        activationDomainMatcher: selectedCustomMode?.activationDomainMatcher ?? null,
        languageOverride: selectedCustomMode?.languageOverride ?? null,
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
    ]
  );

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
    if (!isDialogOpen || !selectedRecording) {
    setSelectedTranscript(null);
    setSelectedHistoryDetails(null);
    setReprocessedResult(null);
    setReprocessError(null);
    return;
    }
    setIsLoadingTranscript(true);
    setReprocessedResult(null);
    setReprocessError(null);
    setReprocessModePreset(
      dictationModePreset === "custom"
        ? selectedCustomMode?.baseModePreset ?? DEFAULT_BASE_MODE
        : dictationModePreset
    );
    const fetchTranscript = async () => {
      try {
        const [transcript, historyDetails] = await Promise.all([
          getTranscript(selectedRecording.id),
          getDictationHistoryDetails(selectedRecording.id),
        ]);
        setSelectedTranscript(transcript);
        setSelectedHistoryDetails(historyDetails);
        if (historyDetails?.baseModePreset) {
          setReprocessModePreset(coerceBaseModePreset(historyDetails.baseModePreset));
        } else if (historyDetails?.modePreset) {
          setReprocessModePreset(coerceBaseModePreset(historyDetails.modePreset));
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
  }, [dictationModePreset, isDialogOpen, selectedCustomMode?.baseModePreset, selectedRecording]);

  const dictationHistory = useMemo(
    () =>
      recordings
        .filter((recording) => recording.sourceType === "dictation")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [recordings]
  );
  const pasteNeedsAttention = useMemo(() => {
    if (!pasteStatus) return false;
    const normalized = pasteStatus.toLowerCase();
    if (normalized.includes("pasted")) return false;
    return (
      normalized.includes("clipboard") ||
      normalized.includes("accessibility") ||
      normalized.includes("blocked") ||
      normalized.includes("permission")
    );
  }, [pasteStatus]);

  useEffect(() => {
    let mounted = true;
    void getSettings()
      .then((settings) => {
        if (!mounted) return;
        const nextSaveToInbox = settings.transcription.dictationSaveToInbox;
        const nextProfile = settings.transcription.dictationProfile;
        const nextCopyToClipboard = settings.transcription.dictationCopyToClipboard ?? true;
        const nextCommandModeEnabled =
          settings.transcription.dictationCommandModeEnabled ?? true;
        const nextRoutePreference =
          settings.transcription.dictationRoutePreference === "cloud" ? "cloud" : "local";
        const nextContextSource =
          (settings.transcription.dictationContextSource as DictationContextSource | undefined) ??
          "none";
        const nextInsertionMode =
          (settings.transcription.dictationInsertionMode as DictationInsertionMode | undefined) ??
          "auto";
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
        setDictationCustomModes(settings.transcription.dictationCustomModes ?? []);
        setSelectedCustomModeId(settings.transcription.dictationSelectedCustomModeId ?? null);
        setCurrentDictationProvider(settings.transcription.dictationProvider ?? null);
        setCurrentDictationModelId(settings.transcription.dictationModelId ?? null);
        setCurrentAiProvider(settings.privacy.llmProvider ?? null);
        setCurrentAiModelId(settings.privacy.llmModelId ?? null);
        setDefaultProjectId(settings.transcription.dictationProjectId || "inbox");
        setDictationPushToTalk(settings.transcription.dictationPushToTalk);
        setDictationHandsFreeEnabled(settings.transcription.dictationHandsFreeEnabled ?? false);
        setDictationRoutePreference(nextRoutePreference);
        setDictationRouteOverrideEnabled(
          settings.transcription.dictationRouteOverrideEnabled ?? true
        );
        setDictationKeepWarm(settings.transcription.dictationKeepWarm ?? "short");
        setDictationLivePreviewEnabled(
          settings.transcription.dictationLivePreviewEnabled ?? true
        );
        setDictationContextSource(nextContextSource);
        setDictationCopyToClipboard(nextCopyToClipboard);
        setDictationCommandModeEnabled(nextCommandModeEnabled);
        setDictationCommandPrefix(settings.transcription.dictationCommandPrefix ?? "command");
        setDictationInsertionMode(nextInsertionMode);
        setDictationSnippetsEnabled(settings.transcription.dictationSnippetsEnabled ?? true);
        setDictationRetentionPreset(settings.transcription.dictationRetentionPreset ?? "never");
        setDictationRetentionCustomHours(settings.transcription.dictationRetentionCustomHours ?? 24);
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
      snippetsEnabled: boolean;
      retentionPreset: "immediate" | "24h" | "72h" | "never" | "custom";
      retentionCustomHours: number;
    }>
  ) => {
    try {
      const settings = await getSettings();
      const nextSaveToInbox = updates.saveToInbox ?? saveToInbox;
      const nextProfile = updates.profile ?? dictationProfile;
      const nextCustomModes = updates.customModes ?? dictationCustomModes;
      const nextContextSource = updates.contextSource ?? dictationContextSource;
      const nextRoutePreference = updates.routePreference ?? dictationRoutePreference;
      const nextRouteOverrideEnabled =
        updates.routeOverrideEnabled ?? dictationRouteOverrideEnabled;
      const nextHandsFreeEnabled = updates.handsFreeEnabled ?? dictationHandsFreeEnabled;
      const nextKeepWarm = updates.keepWarm ?? dictationKeepWarm;
      const nextLivePreviewEnabled =
        updates.livePreviewEnabled ?? dictationLivePreviewEnabled;
      const nextCopyToClipboard = updates.copyToClipboard ?? dictationCopyToClipboard;
      const nextCommandModeEnabled =
        updates.commandModeEnabled ?? dictationCommandModeEnabled;
      const nextInsertionMode = updates.insertionMode ?? dictationInsertionMode;
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
      settings.transcription.dictationRouteOverrideEnabled = nextRouteOverrideEnabled;
      settings.transcription.dictationKeepWarm = nextKeepWarm;
      settings.transcription.dictationLivePreviewEnabled = nextLivePreviewEnabled;
      settings.transcription.dictationProjectId = updates.projectId ?? defaultProjectId;
      settings.transcription.dictationPushToTalk = updates.pushToTalk ?? dictationPushToTalk;
      settings.transcription.dictationHandsFreeEnabled = nextHandsFreeEnabled;
      settings.transcription.dictationCopyToClipboard = nextCopyToClipboard;
      settings.transcription.dictationCommandModeEnabled = nextCommandModeEnabled;
      settings.transcription.dictationCommandPrefix =
        updates.commandPrefix ?? dictationCommandPrefix;
      settings.transcription.dictationInsertionMode = nextInsertionMode;
      settings.transcription.dictationSnippetsEnabled =
        updates.snippetsEnabled ?? dictationSnippetsEnabled;
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
      void persistDictationPreferences({ modePreset: modeId, selectedCustomModeId: null });
      return;
    }

    const nextProfile = definition.profile ?? dictationProfile;
    const nextInsertionMode = definition.insertionMode ?? dictationInsertionMode;
    const nextContextSource = definition.contextSource ?? dictationContextSource;
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

  const syncModePreset = (overrides: Partial<{
    profile: "normal_speed" | "power_rewrite";
    insertionMode: DictationInsertionMode;
    contextSource: DictationContextSource;
    saveToInbox: boolean;
    copyToClipboard: boolean;
    commandModeEnabled: boolean;
  }> = {}) => {
    const nextModePreset = inferModePreset({
      profile: overrides.profile ?? dictationProfile,
      insertionMode: overrides.insertionMode ?? dictationInsertionMode,
      contextSource: overrides.contextSource ?? dictationContextSource,
      saveToInbox: overrides.saveToInbox ?? saveToInbox,
      copyToClipboard: overrides.copyToClipboard ?? dictationCopyToClipboard,
      commandModeEnabled: overrides.commandModeEnabled ?? dictationCommandModeEnabled,
    });
    setDictationModePreset(nextModePreset);
    if (nextModePreset === "custom") {
      setSelectedCustomModeId(null);
    } else {
      setSelectedCustomModeId(null);
    }
    return nextModePreset;
  };

  const buildCurrentCustomMode = (overrides?: Partial<DictationCustomMode>): DictationCustomMode => ({
    id:
      overrides?.id ??
      selectedCustomModeId ??
      `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: (overrides?.name ?? customModeDraft.name).trim() || "Custom Mode",
    description: (overrides?.description ?? customModeDraft.description).trim(),
    baseModePreset:
      overrides?.baseModePreset ??
      (dictationModePreset === "custom"
        ? selectedCustomMode?.baseModePreset ?? customModeDraft.baseModePreset
        : coerceBaseModePreset(dictationModePreset)),
    customPrompt: overrides?.customPrompt ?? (customModeDraft.customPrompt.trim() || null),
    profile: overrides?.profile ?? dictationProfile,
    routePreference: overrides?.routePreference ?? dictationRoutePreference,
    languageOverride:
      overrides?.languageOverride ?? (customModeDraft.languageOverride.trim() || null),
    livePreviewEnabled: overrides?.livePreviewEnabled ?? customModeDraft.livePreviewEnabled,
    insertionMode: overrides?.insertionMode ?? dictationInsertionMode,
    contextSource: overrides?.contextSource ?? dictationContextSource,
    saveToInbox: overrides?.saveToInbox ?? saveToInbox,
    copyToClipboard: overrides?.copyToClipboard ?? dictationCopyToClipboard,
    commandModeEnabled: overrides?.commandModeEnabled ?? dictationCommandModeEnabled,
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
        livePreviewEnabled: mode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      })
    );
    setDictationProfile(mode.profile);
    setDictationRoutePreference(mode.routePreference ?? dictationRoutePreference);
    setDictationInsertionMode(mode.insertionMode);
    setDictationContextSource(mode.contextSource);
    setDictationLivePreviewEnabled(mode.livePreviewEnabled ?? dictationLivePreviewEnabled);
    setSaveToInbox(mode.saveToInbox);
    setDictationCopyToClipboard(mode.copyToClipboard);
    setDictationCommandModeEnabled(mode.commandModeEnabled);
    setCurrentDictationProvider(mode.dictationProvider ?? currentDictationProvider);
    setCurrentDictationModelId(mode.dictationModelId ?? currentDictationModelId);
    setCurrentAiProvider(mode.aiProvider ?? currentAiProvider);
    setCurrentAiModelId(mode.aiModelId ?? currentAiModelId);
    void persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: mode.id,
      profile: mode.profile,
      routePreference: mode.routePreference ?? dictationRoutePreference,
      livePreviewEnabled: mode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      insertionMode: mode.insertionMode,
      contextSource: mode.contextSource,
      saveToInbox: mode.saveToInbox,
      copyToClipboard: mode.copyToClipboard,
      commandModeEnabled: mode.commandModeEnabled,
    });
    void (async () => {
      try {
        const settings = await getSettings();
        if (mode.dictationProvider) settings.transcription.dictationProvider = mode.dictationProvider;
        if (mode.dictationModelId) settings.transcription.dictationModelId = mode.dictationModelId;
        settings.transcription.dictationRoutePreference =
          mode.routePreference ?? settings.transcription.dictationRoutePreference ?? "local";
        settings.transcription.dictationLivePreviewEnabled =
          mode.livePreviewEnabled ?? settings.transcription.dictationLivePreviewEnabled;
        settings.transcription.language =
          mode.languageOverride ?? settings.transcription.language ?? null;
        if (mode.aiProvider) settings.privacy.llmProvider = mode.aiProvider;
        settings.privacy.llmModelId = mode.aiModelId ?? settings.privacy.llmModelId ?? null;
        await saveSettings(settings);
      } catch (error) {
        console.warn("Failed to apply custom mode engine settings:", error);
      }
    })();
  };

  const handleSaveCustomMode = async (saveAsNew = false) => {
    const nextMode = buildCurrentCustomMode({
      id: saveAsNew ? undefined : selectedCustomModeId ?? undefined,
    });
    const nextModes = saveAsNew
      ? [...dictationCustomModes, nextMode]
      : dictationCustomModes.some((mode) => mode.id === nextMode.id)
        ? dictationCustomModes.map((mode) => (mode.id === nextMode.id ? nextMode : mode))
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
        livePreviewEnabled: nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      })
    );
    await persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: nextMode.id,
      customModes: nextModes,
      livePreviewEnabled: nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
    });
    try {
      const settings = await getSettings();
      settings.transcription.dictationModePreset = "custom";
      settings.transcription.dictationSelectedCustomModeId = nextMode.id;
      settings.transcription.dictationCustomModes = nextModes;
      settings.transcription.dictationProvider = nextMode.dictationProvider ?? settings.transcription.dictationProvider;
      settings.transcription.dictationModelId = nextMode.dictationModelId ?? settings.transcription.dictationModelId;
      settings.transcription.dictationRoutePreference =
        nextMode.routePreference ?? settings.transcription.dictationRoutePreference ?? "local";
      settings.transcription.dictationLivePreviewEnabled =
        nextMode.livePreviewEnabled ?? settings.transcription.dictationLivePreviewEnabled;
      settings.transcription.language =
        nextMode.languageOverride ?? settings.transcription.language ?? null;
      settings.privacy.llmProvider = nextMode.aiProvider ?? settings.privacy.llmProvider;
      settings.privacy.llmModelId = nextMode.aiModelId ?? settings.privacy.llmModelId ?? null;
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
      livePreviewEnabled: style.livePreviewEnabled ?? dictationLivePreviewEnabled,
    });
    const nextModes = dictationCustomModes.some((mode) => mode.id === nextMode.id)
      ? dictationCustomModes.map((mode) => (mode.id === nextMode.id ? nextMode : mode))
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
        livePreviewEnabled: nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      })
    );
    setDictationProfile(nextMode.profile);
    setDictationRoutePreference(nextMode.routePreference ?? dictationRoutePreference);
    setDictationInsertionMode(nextMode.insertionMode);
    setDictationContextSource(nextMode.contextSource);
    setDictationLivePreviewEnabled(nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled);
    setSaveToInbox(nextMode.saveToInbox);
    setDictationCopyToClipboard(nextMode.copyToClipboard);
    setDictationCommandModeEnabled(nextMode.commandModeEnabled);

    await persistDictationPreferences({
      modePreset: "custom",
      selectedCustomModeId: nextMode.id,
      customModes: nextModes,
      profile: nextMode.profile,
      routePreference: nextMode.routePreference ?? dictationRoutePreference,
      livePreviewEnabled: nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
      insertionMode: nextMode.insertionMode,
      contextSource: nextMode.contextSource,
      saveToInbox: nextMode.saveToInbox,
      copyToClipboard: nextMode.copyToClipboard,
      commandModeEnabled: nextMode.commandModeEnabled,
    });
  };

  const handleDeleteCustomMode = async (modeId: string) => {
    const nextModes = dictationCustomModes.filter((mode) => mode.id !== modeId);
    setDictationCustomModes(nextModes);
    const shouldClearSelection = selectedCustomModeId === modeId;
    if (shouldClearSelection) {
      setSelectedCustomModeId(null);
      setCustomModeDraft(
        createCustomModeDraft({ livePreviewEnabled: dictationLivePreviewEnabled })
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
          baseModePreset: selectedCustomMode.baseModePreset ?? DEFAULT_BASE_MODE,
          customPrompt: selectedCustomMode.customPrompt ?? "",
          activationAppMatcher: selectedCustomMode.activationAppMatcher ?? "",
          activationDomainMatcher: selectedCustomMode.activationDomainMatcher ?? "",
          languageOverride: selectedCustomMode.languageOverride ?? "",
          livePreviewEnabled:
            selectedCustomMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
        })
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
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<DictationTextReadyEvent>("dictation-text-ready", (event) => {
        const payload = event.payload;
        const text = payload?.text ?? "";
        if (text) {
          setTranscribedText(text);
          setDictationError(null);
        }
        if (payload?.actualProvider) {
          setLastProvider(payload.actualProvider);
        }
        const hasProviderFallback =
          payload?.isFallback === true ||
          (!!payload?.requestedProvider &&
            !!payload?.actualProvider &&
            payload.requestedProvider !== payload.actualProvider);
        if (payload?.fallbackMessage) {
          setFallbackStatus(payload.fallbackMessage);
        } else if (hasProviderFallback) {
          const reason =
            payload?.fallbackReason?.trim() ||
            "Requested provider could not complete transcription.";
          setFallbackStatus(
            `ASR fallback: requested '${payload.requestedProvider}' but used '${payload.actualProvider}'. ${reason}`
          );
        } else {
          setFallbackStatus(null);
        }
        if (payload?.modelId) {
          setLastModelId(payload.modelId);
        }
        setLastRoutePreference(payload?.routePreference ?? null);
        setLastResolvedRoute(payload?.resolvedRoute ?? null);
        setLastProviderModelLabel(payload?.providerModelLabel ?? null);
        setLastResolvedHosting(payload?.resolvedHosting ?? null);
        setStartupLatencyMs(payload?.startupLatencyMs ?? null);
        setLatencyMs(payload?.latencyMs ?? null);
        setInsertLatencyMs(payload?.insertLatencyMs ?? null);
        setEndToEndMs(payload?.endToEndMs ?? null);
        setInsertionModeUsed(payload?.insertionModeUsed ?? null);
        setCommandApplied(payload?.commandApplied ?? null);
        setSnippetAppliedCount(payload?.snippetAppliedCount ?? 0);
        setAppTarget(payload?.appTarget ?? null);
        setActivationMatcher(payload?.activationMatcher ?? null);
        setContextChars(payload?.contextChars ?? null);
        if (payload?.pasted) {
          setPasteStatus("Paste command sent (also copied to clipboard)");
        } else if (payload?.copied) {
          setPasteStatus(payload?.pasteError ?? "Copied to clipboard");
        } else if (payload?.pasteError) {
          setPasteStatus(payload.pasteError);
        } else {
          setPasteStatus(null);
        }
        void refetchDictationHistory();
      });
    };
    void setup();
    return () => {
      unlisten?.();
    };
  }, [refetchDictationHistory]);

  const handleStopDictation = async () => {
    try {
      const text = await stopDictation();
        if (text?.trim()) {
          setTranscribedText(text);
          setDictationError(null);
          void refetchDictationHistory();
        } else {
          setDictationError(null);
        }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDictationError(message);
    }
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
      setDictationDictionaryEntries((prev) => prev.filter((entry) => entry.id !== entryId));
    } catch (error) {
      console.warn("Failed to delete dictation dictionary entry:", error);
    }
  };

  const handleDeleteSnippet = async (snippetId: string) => {
    try {
      await deleteDictationSnippet(snippetId);
      setDictationSnippets((prev) => prev.filter((snippet) => snippet.id !== snippetId));
    } catch (error) {
      console.warn("Failed to delete dictation snippet:", error);
    }
  };

  const upsertCommandPreset = async (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection",
    systemPrompt: string,
    enabled: boolean
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
          return prev.map((preset) => (preset.commandKey === commandKey ? updated : preset));
        }
        return [...prev, updated];
      });
    } catch (error) {
      console.warn("Failed to upsert command preset:", error);
    }
  };

  const resetCommandPreset = async (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection"
  ) => {
    try {
      await deleteDictationCommandPreset(commandKey);
      setDictationCommandPresets((prev) =>
        prev.filter((preset) => preset.commandKey !== commandKey)
      );
    } catch (error) {
      console.warn("Failed to reset command preset:", error);
    }
  };

  const getCommandPreset = (
    key: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection"
  ) => dictationCommandPresets.find((preset) => preset.commandKey === key);

  const setCommandPresetDraft = (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection",
    updates: Partial<Pick<DictationCommandPreset, "systemPrompt" | "enabled">>
  ) => {
    setDictationCommandPresets((prev) => {
      const existing = prev.find((preset) => preset.commandKey === commandKey);
      if (existing) {
        return prev.map((preset) =>
          preset.commandKey === commandKey ? { ...preset, ...updates } : preset
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
    }>
  ) => {
    setDictationSnippets((prev) =>
      prev.map((snippet) => (snippet.id === snippetId ? { ...snippet, ...updates } : snippet))
    );
    try {
      const updated = await updateDictationSnippet(snippetId, updates);
      setDictationSnippets((prev) =>
        prev.map((snippet) => (snippet.id === snippetId ? updated : snippet))
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
    }>
  ) => {
    setDictationDictionaryEntries((prev) =>
      prev.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry))
    );
    try {
      const updated = await updateDictationDictionaryEntry(entryId, updates);
      setDictationDictionaryEntries((prev) =>
        prev.map((entry) => (entry.id === entryId ? updated : entry))
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
          null
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
    } catch (error) {
      console.warn("Failed to delete dictation history item:", error);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Dictation</h1>
            <p className="text-muted-foreground">Fast voice capture that inserts text where you work</p>
          </div>
          <div className="flex items-center gap-4">
            <div 
              className={cn(
                "flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-all",
                hotkeyPressed ? "bg-active text-active-foreground border-active scale-105" : "bg-muted"
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
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="saveToInbox"
                checked={saveToInbox}
                onChange={(e) => {
                  const next = e.target.checked;
                  setSaveToInbox(next);
                  const nextModePreset = syncModePreset({ saveToInbox: next });
                  void persistDictationPreferences({ saveToInbox: next, modePreset: nextModePreset });
                }}
                className="h-4 w-4"
              />
              <label htmlFor="saveToInbox" className="text-sm text-muted-foreground">
                Save to Inbox
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="copyToClipboard"
                checked={dictationCopyToClipboard}
                onChange={(e) => {
                  const next = e.target.checked;
                  setDictationCopyToClipboard(next);
                  const nextModePreset = syncModePreset({ copyToClipboard: next });
                  void persistDictationPreferences({
                    copyToClipboard: next,
                    modePreset: nextModePreset,
                  });
                }}
                className="h-4 w-4"
              />
              <label htmlFor="copyToClipboard" className="text-sm text-muted-foreground">
                Copy result to clipboard
              </label>
            </div>
          </div>
        </div>
      </div>
      
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
              <CardTitle>Modes</CardTitle>
              <CardDescription>
                Start with a preset tuned for your workflow, then adjust the details below if you
                need something custom.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {DICTATION_MODE_DEFINITIONS.map((mode) => {
                  const isActive = dictationModePreset === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => applyDictationMode(mode.id)}
                      className={cn(
                        "rounded-xl border p-4 text-left transition-colors",
                        isActive
                          ? "border-active bg-active/10 shadow-sm"
                          : "border-border hover:border-active/50 hover:bg-muted/40"
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
                      <p className="mt-2 text-sm text-muted-foreground">{mode.description}</p>
                    </button>
                  );
                })}
              </div>
              <div className="space-y-3 border-t pt-4">
                <div>
                  <p className="text-sm font-medium">Recommended app styles</p>
                  <p className="text-xs text-muted-foreground">
                    Install ready-made auto-switch modes for the apps you use most.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {RECOMMENDED_APP_STYLES.map((style) => {
                    const installedMode = dictationCustomModes.find((mode) => mode.id === style.id);
                    return (
                      <div
                        key={style.id}
                        className="rounded-xl border border-border bg-muted/20 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{style.name}</p>
                            <p className="mt-2 text-sm text-muted-foreground">{style.description}</p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {style.activationDomainMatcher
                                ? `Domain ${style.activationDomainMatcher}`
                                : `App ${style.activationAppMatcher}`}
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
                            onClick={() => void handleInstallRecommendedStyle(style)}
                          >
                            {installedMode ? "Update and use" : "Install and use"}
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
                    <p className="text-sm font-medium">Saved custom modes</p>
                    <p className="text-xs text-muted-foreground">
                      Reuse your own dictation setups without rebuilding them from scratch.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {dictationCustomModes.map((mode) => {
                      const isActive =
                        dictationModePreset === "custom" && selectedCustomModeId === mode.id;
                      return (
                        <div
                          key={mode.id}
                          className={cn(
                            "rounded-xl border p-4",
                            isActive
                              ? "border-active bg-active/10 shadow-sm"
                              : "border-border bg-muted/20"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{mode.name}</p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {mode.description || "Custom dictation workflow"}
                              </p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {mode.dictationProvider || "Current transcription"} ·{" "}
                                {mode.dictationModelId || "Current model"}
                                {mode.activationAppMatcher
                                  ? ` · Auto for ${mode.activationAppMatcher}`
                                  : ""}
                                {mode.activationDomainMatcher
                                  ? ` · Domain ${mode.activationDomainMatcher}`
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
                              {isActive ? "Using now" : "Use mode"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleDeleteCustomMode(mode.id)}
                            >
                              Delete
                            </Button>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {summarizeMode(mode).map((item) => (
                              <span
                                key={`${mode.id}-${item.label}`}
                                className="rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground"
                              >
                                <span className="font-medium text-foreground">{item.label}:</span>{" "}
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
                  <p className="text-sm font-medium">What this mode changes</p>
                  <p className="text-xs text-muted-foreground">
                    The active mode controls insertion, context, saved history, command behavior,
                    and the transcription/AI routes captured below.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeModeSummary.map((item) => (
                    <span
                      key={item.label}
                      className="rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">{item.label}:</span>{" "}
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
                      This mode prefers one hosting path by default, including hotkey dictation.
                    </p>
                    <div className="flex gap-2">
                      {(["local", "cloud"] as const).map((route) => (
                        <Button
                          key={route}
                          type="button"
                          size="sm"
                          variant={dictationRoutePreference === route ? "default" : "outline"}
                          onClick={() => {
                            setDictationRoutePreference(route);
                            void persistDictationPreferences({ routePreference: route });
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
                            currentDictationModelId
                          ) === "cloud"
                          ? "Cloud"
                          : "Local"
                        : "Unknown"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Next button capture override</p>
                    <p className="text-xs text-muted-foreground">
                      Use this when you want one manual capture to ignore the mode default.
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
                          void persistDictationPreferences({ routeOverrideEnabled: next });
                        }}
                      />
                      Allow next-capture override
                    </label>
                    {dictationRouteOverrideEnabled ? (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={nextCaptureRoutePreference === null ? "default" : "outline"}
                          onClick={() => setNextCaptureRoutePreference(null)}
                        >
                          Use default
                        </Button>
                        {(["local", "cloud"] as const).map((route) => (
                          <Button
                            key={`next-${route}`}
                            type="button"
                            size="sm"
                            variant={nextCaptureRoutePreference === route ? "default" : "outline"}
                            onClick={() => setNextCaptureRoutePreference(route)}
                          >
                            Next {route}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Manual captures follow the active mode route until you re-enable overrides.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {dictationModePreset === "custom"
                  ? selectedCustomMode
                    ? `${selectedCustomMode.name} is active. Update it when you want the current lower controls to become the new default.`
                    : "Unsaved custom setup is active. Save it as a reusable mode when it feels right."
                  : `${modeDefinitionById[dictationModePreset]?.label ?? "Voice"} mode is active. Lower controls stay editable if you want to fine-tune them.`}
              </div>
              {dictationModePreset === "custom" && (
                <div className="rounded-xl border border-border/70 bg-background/70 p-4 space-y-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Mode name</label>
                      <input
                        type="text"
                        aria-label="Mode name"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={customModeDraft.name}
                        onChange={(event) =>
                          setCustomModeDraft((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="Custom Mode"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Short description</label>
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
                            baseModePreset: event.target.value as DictationBaseModePreset,
                          }))
                        }
                      >
                        {DICTATION_MODE_DEFINITIONS.filter((mode) => mode.id !== "custom").map(
                          (mode) => (
                            <option key={mode.id} value={mode.id}>
                              {mode.label}
                            </option>
                          )
                        )}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Sets the deterministic formatting and reprocess behavior this custom mode
                        should inherit before any mode-specific prompt runs.
                      </p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">Style prompt</label>
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
                        placeholder="Optional. Tell Nautilus how this mode should rewrite dictation for this app or workflow."
                      />
                      <p className="text-xs text-muted-foreground">
                        Optional. Overrides the global Smart Format prompt only when this mode is active.
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Activation rules</p>
                        <p className="text-xs text-muted-foreground">
                          Hotkey and tray dictation can switch into this mode automatically before capture starts.
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
                      <label className="text-sm font-medium">Auto-activate for app</label>
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
                        Optional. When the frontmost app name matches, Nautilus can switch to this
                        mode automatically for hotkey and tray dictation.
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
                      <label className="text-sm font-medium">Auto-activate for domain</label>
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
                        Optional. Browser-focused dictation can switch when the active tab URL
                        host matches this domain.
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
                        customModeDraft.activationDomainMatcher
                      )}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Language override</label>
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
                        <label className="text-sm font-medium">Live preview</label>
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
                          Turn this off for cleaner captures when partial text is distracting.
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Domain rules are checked first. If both are empty, this mode stays available
                      for manual capture only.
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Saving a custom mode snapshots the current dictation style, result behavior,
                    context source, transcription route, AI route, and optional app or domain
                    auto-activation rules.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void handleSaveCustomMode(false)}>
                      {selectedCustomModeId ? "Update mode" : "Save current setup"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void handleSaveCustomMode(true)}>
                      Save as new mode
                    </Button>
                    {selectedCustomModeId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleDeleteCustomMode(selectedCustomModeId)}
                      >
                        Delete mode
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Capture Card */}
          <Card className={cn(
            "border-2 transition-all duration-300",
            isRecording ? "border-active" : "border-muted"
          )}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Capture
              </CardTitle>
              <CardDescription>
                {dictationInstruction(
                  hotkeyShortcut,
                  shortcutMode(dictationPushToTalk, dictationHandsFreeEnabled)
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center gap-6 py-8">
                {isRecording ? (
                  <div className="flex flex-col items-center gap-4">
                    <div className="h-24 w-24 rounded-full bg-active flex items-center justify-center animate-pulse shadow-lg shadow-active/50">
                      <Mic className="h-12 w-12 text-active-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-medium">Dictating...</p>
                      <p className="text-3xl font-mono mt-2 font-bold text-active">{formattedDuration}</p>
                    </div>
                    <Button variant="destructive" size="lg" onClick={handleStopDictation} className="mt-4">
                      <Square className="h-4 w-4 mr-2 fill-current" />
                      Stop Dictation
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    <div className={cn(
                      "h-24 w-24 rounded-full flex items-center justify-center transition-all",
                      hotkeyPressed ? "bg-active scale-110" : "bg-muted"
                    )}>
                      <Mic className={cn(
                        "h-12 w-12 transition-all",
                        hotkeyPressed ? "text-active-foreground" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-medium">Ready to capture</p>
                      <p className="text-muted-foreground mt-1">
                        {dictationHandsFreeEnabled
                          ? `Press ${hotkeyLabel} to start. It stops after silence or when you press again`
                          : dictationPushToTalk
                          ? `Hold ${hotkeyLabel} to record and release to transcribe`
                          : `Press ${hotkeyLabel} to start, press again to transcribe`}
                      </p>
                    </div>
                    <Button 
                      variant="active" 
                      size="lg" 
                      onClick={() => {
                        const routePreference =
                          dictationRouteOverrideEnabled && nextCaptureRoutePreference
                            ? nextCaptureRoutePreference
                            : dictationRoutePreference;
                        if (dictationRouteOverrideEnabled) {
                          setNextCaptureRoutePreference(null);
                        }
                        void startDictation({
                          saveToInbox,
                          projectId: defaultProjectId,
                          profile: dictationProfile,
                          contextSource: dictationContextSource,
                          routePreference,
                          languageOverride:
                            dictationModePreset === "custom"
                              ? customModeDraft.languageOverride.trim() || null
                              : null,
                          livePreviewEnabled:
                            dictationModePreset === "custom"
                              ? customModeDraft.livePreviewEnabled
                              : dictationLivePreviewEnabled,
                        });
                      }}
                      className="mt-4"
                    >
                      <Mic className="h-4 w-4 mr-2" />
                      Start Dictation
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          
          {/* Instructions */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Keyboard className="h-4 w-4" />
                  Global Hotkey
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Works from anywhere on your computer. No need to switch to the Nautilus window.
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Fast insertion
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                    Your final text is inserted after capture finishes.
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  Save history
                </CardTitle>
              </CardHeader>
              <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Keep dictations in Inbox so they are searchable later.
                  </p>
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
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(transcribedText)}
                >
                  <Save className="h-4 w-4 mr-2" />
                  Copy Again
                </Button>
              </CardHeader>
              <CardContent>
                <div className="p-4 bg-muted rounded-lg">
                  <p className="whitespace-pre-wrap">{transcribedText}</p>
                </div>
                {fallbackStatus && (
                  <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {fallbackStatus}
                  </div>
                )}
                {pasteNeedsAttention && (
                  <div className="mt-3 rounded-md border border-orange-400/50 bg-orange-500/10 px-3 py-2 text-xs text-orange-700 dark:text-orange-300">
                    {pasteStatus}
                  </div>
                )}
                {(lastProvider ||
                  lastModelId ||
                  lastResolvedHosting ||
                  startupLatencyMs !== null ||
                  latencyMs !== null ||
                  insertLatencyMs !== null ||
                  endToEndMs !== null ||
                  insertionModeUsed ||
                  commandApplied ||
                  snippetAppliedCount > 0 ||
                  appTarget ||
                  activationMatcher ||
                  contextChars !== null) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    {startupLatencyMs !== null && (
                      <span>
                        Start:{" "}
                        {startupLatencyMs < 1000
                          ? `${startupLatencyMs}ms`
                          : `${(startupLatencyMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {latencyMs !== null && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-active/10 text-active font-medium">
                        <Zap className="h-3 w-3" />
                        Transcription{" "}
                        {latencyMs < 1000
                          ? `${latencyMs}ms`
                          : `${(latencyMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {endToEndMs !== null && (
                      <span>
                        Ready to insert:{" "}
                        {endToEndMs < 1000
                          ? `${endToEndMs}ms`
                          : `${(endToEndMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {insertLatencyMs !== null && (
                      <span>
                        Insert:{" "}
                        {insertLatencyMs < 1000
                          ? `${insertLatencyMs}ms`
                          : `${(insertLatencyMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {lastResolvedHosting && (
                      <span>Route: {lastResolvedHosting === "cloud" ? "Cloud" : "Local"}</span>
                    )}
                    {lastRoutePreference && (
                      <span>
                        Requested: {lastRoutePreference === "cloud" ? "Cloud" : "Local"}
                      </span>
                    )}
                    {lastResolvedRoute && <span>Resolved: {lastResolvedRoute}</span>}
                    {lastProviderModelLabel && <span>Route label: {lastProviderModelLabel}</span>}
                    {lastProvider && <span>Engine: {lastProvider}</span>}
                    {lastModelId && <span>Model: {lastModelId}</span>}
                    {insertionModeUsed && <span>Inserted via: {insertionModeUsed}</span>}
                    {commandApplied && <span>Command: {commandApplied}</span>}
                    {snippetAppliedCount > 0 && <span>Snippets: {snippetAppliedCount}</span>}
                    {appTarget && <span>Target app: {appTarget}</span>}
                    {activationMatcher && <span>Auto mode: {activationMatcher}</span>}
                    {contextChars !== null && contextChars > 0 && (
                      <span>Context: {contextChars} chars</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Dictation History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Dictations</CardTitle>
                <CardDescription>
                  Dictation recordings retained by your current auto-delete policy.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void refetchDictationHistory()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {dictationHistoryLoading ? (
                <p className="text-sm text-muted-foreground">Loading dictation history...</p>
              ) : dictationHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved dictations yet. If auto-delete is set to Immediate, history is intentionally not retained.
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
                          {new Date(recording.createdAt).toLocaleString()} · {recording.status}
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
                Modes handle the recommended defaults. These controls are here when you want to
                tune the details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Dictation profile</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationProfile}
                    onChange={(event) => {
                      const profile = event.target.value as "normal_speed" | "power_rewrite";
                      setDictationProfile(profile);
                      const nextModePreset = syncModePreset({ profile });
                      void persistDictationPreferences({ profile, modePreset: nextModePreset });
                    }}
                  >
                    <option value="normal_speed">Normal Speed</option>
                    <option value="power_rewrite">Power Rewrite</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Uses the transcription route selected in Settings → Transcription.
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
                      void persistDictationPreferences({ projectId: nextProjectId });
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
                    value={shortcutMode(dictationPushToTalk, dictationHandsFreeEnabled)}
                    onChange={(event) => {
                      const nextMode = event.target.value as "hold_to_talk" | "toggle" | "hands_free";
                      const pushToTalk = nextMode === "hold_to_talk";
                      const handsFreeEnabled = nextMode === "hands_free";
                      setDictationPushToTalk(pushToTalk);
                      setDictationHandsFreeEnabled(handsFreeEnabled);
                      void persistDictationPreferences({ pushToTalk, handsFreeEnabled });
                    }}
                  >
                    <option value="hold_to_talk">Hold-to-talk</option>
                    <option value="toggle">Toggle press</option>
                    <option value="hands_free">Hands-free</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Hands-free starts on press and stops after silence or a second press.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Live preview</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationLivePreviewEnabled ? "on" : "off"}
                    onChange={(event) => {
                      const next = event.target.value === "on";
                      setDictationLivePreviewEnabled(next);
                      void persistDictationPreferences({ livePreviewEnabled: next });
                    }}
                  >
                    <option value="on">Show live partials</option>
                    <option value="off">Hide live partials</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Controls whether popup and inline flows show partial dictation text while you speak.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Keep warm</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationKeepWarm}
                    onChange={(event) => {
                      const next = event.target.value as "off" | "short" | "long";
                      setDictationKeepWarm(next);
                      void persistDictationPreferences({ keepWarm: next });
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="short">Short</option>
                    <option value="long">Long</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Keeps the active dictation route warmer between captures to reduce startup latency.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Text context</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationContextSource}
                    onChange={(event) => {
                      const contextSource = event.target.value as DictationContextSource;
                      setDictationContextSource(contextSource);
                      const nextModePreset = syncModePreset({ contextSource });
                      void persistDictationPreferences({
                        contextSource,
                        modePreset: nextModePreset,
                      });
                    }}
                  >
                    <option value="none">Off</option>
                    <option value="application_context">Use application context</option>
                    <option value="selected_text">Use selected text</option>
                    <option value="clipboard">Use clipboard</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Lets voice commands transform existing text. Try &quot;command rewrite professional&quot;
                    , &quot;command bulletize selection&quot;, &quot;command replace roadmap with launch plan&quot;,
                    or editing commands like &quot;command replace selection with approved plan&quot;,
                    &quot;command append today&quot;, &quot;command delete phrase roadmap&quot;, and
                    case changes like &quot;command uppercase selection&quot; or
                    &quot;command title case selection&quot;. Correction commands like
                    &quot;command undo that&quot; work without text context.
                    Application context captures the frontmost app, window title, and selected text when available.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Auto-delete dictation recordings</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationRetentionPreset}
                    onChange={(event) => {
                      const preset = event.target.value as "immediate" | "24h" | "72h" | "never" | "custom";
                      setDictationRetentionPreset(preset);
                      void persistDictationPreferences({ retentionPreset: preset });
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
                      <label className="text-xs text-muted-foreground">Custom hours</label>
                      <input
                        type="number"
                        min={1}
                        className="w-full p-2 border rounded-md bg-background"
                        value={dictationRetentionCustomHours}
                        onChange={(event) => {
                          const nextHours = Math.max(1, Number(event.target.value) || 1);
                          setDictationRetentionCustomHours(nextHours);
                          void persistDictationPreferences({ retentionCustomHours: nextHours });
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
                      const mode = event.target.value as "auto" | "paste" | "inline" | "clipboard_only";
                      setDictationInsertionMode(mode);
                      const nextModePreset = syncModePreset({ insertionMode: mode });
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
                    Recommended tries the best available insertion path. Insert on release keeps the
                    flow simple and consistent.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Command mode prefix</label>
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationCommandPrefix}
                    onChange={(event) => setDictationCommandPrefix(event.target.value)}
                    onBlur={() => {
                      const nextPrefix = dictationCommandPrefix.trim() || "command";
                      setDictationCommandPrefix(nextPrefix);
                      void persistDictationPreferences({ commandPrefix: nextPrefix });
                    }}
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={dictationCommandModeEnabled}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationCommandModeEnabled(next);
                        const nextModePreset = syncModePreset({ commandModeEnabled: next });
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
                    Customize rewrite and bullet actions that run after dictation.
                  </p>
                </div>
                <div className="space-y-3">
                  {COMMAND_PRESET_FIELDS.map((field) => {
                    const preset = getCommandPreset(field.key);
                    const promptValue = preset?.systemPrompt ?? field.defaultPrompt;
                    const enabledValue = preset?.enabled ?? true;
                    return (
                      <div key={field.key} className="rounded-md border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium">{field.label}</label>
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={enabledValue}
                                onChange={(event) => {
                                  const next = event.target.checked;
                                  setCommandPresetDraft(field.key, { enabled: next });
                                  void upsertCommandPreset(field.key, promptValue, next);
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
                            const nextPrompt = event.target.value.trim() || field.defaultPrompt;
                            setCommandPresetDraft(field.key, {
                              systemPrompt: nextPrompt,
                            });
                            void upsertCommandPreset(field.key, nextPrompt, enabledValue);
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
                      Normalize names, brands, and phrases before snippets are applied.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_auto] gap-2">
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Say (e.g. open ai)"
                    value={newDictionarySpokenForm}
                    onChange={(event) => setNewDictionarySpokenForm(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Insert (e.g. OpenAI)"
                    value={newDictionaryReplacement}
                    onChange={(event) => setNewDictionaryReplacement(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="App scope (optional)"
                    value={newDictionaryAppScope}
                    onChange={(event) => setNewDictionaryAppScope(event.target.value)}
                  />
                  <Button variant="outline" onClick={() => void handleAddDictionaryEntry()}>
                    Add
                  </Button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newDictionaryCaseSensitive}
                    onChange={(event) => setNewDictionaryCaseSensitive(event.target.checked)}
                  />
                  Case-sensitive match
                </label>

                {dictationDictionaryEntries.length > 0 && (
                  <div className="space-y-2">
                    {dictationDictionaryEntries.map((entry) => (
                      <div key={entry.id} className="rounded-md border p-2 space-y-2">
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={entry.spokenForm}
                            onChange={(event) =>
                              setDictationDictionaryEntries((prev) =>
                                prev.map((current) =>
                                  current.id === entry.id
                                    ? { ...current, spokenForm: event.target.value }
                                    : current
                                )
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
                                    ? { ...current, replacement: event.target.value }
                                    : current
                                )
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
                                    ? { ...current, appScope: event.target.value }
                                    : current
                                )
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
                            onClick={() => void handleDeleteDictionaryEntry(entry.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
                        void persistDictationPreferences({ snippetsEnabled: next });
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
                    onChange={(event) => setNewSnippetTrigger(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Expansion (e.g. be right back)"
                    value={newSnippetExpansion}
                    onChange={(event) => setNewSnippetExpansion(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="App scope (optional)"
                    value={newSnippetAppScope}
                    onChange={(event) => setNewSnippetAppScope(event.target.value)}
                  />
                  <Button variant="outline" onClick={() => void handleAddSnippet()}>
                    Add
                  </Button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newSnippetCaseSensitive}
                    onChange={(event) => setNewSnippetCaseSensitive(event.target.checked)}
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
                                    ? { ...current, trigger: event.target.value }
                                    : current
                                )
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, { trigger: event.target.value.trim() })
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
                                    ? { ...current, expansion: event.target.value }
                                    : current
                                )
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, { expansion: event.target.value.trim() })
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
                                    ? { ...current, appScope: event.target.value }
                                    : current
                                )
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
              <DialogTitle>{selectedRecording?.title ?? "Dictation"}</DialogTitle>
              {selectedRecording && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyHistoryTranscript(selectedRecording.id)}
                  >
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDeleteHistoryItem(selectedRecording.id)}
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
                      Inspect the original route, model, and transcript quality before reprocessing.
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
                      {selectedTranscript.actualProvider || selectedTranscript.requestedProvider || "Unknown"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Model
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {selectedTranscript.modelId || selectedTranscript.model || "Unknown"}
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
                    Inspect the app context and prompt strategy Nautilus used for this dictation.
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
                              ? modeDefinitionById[
                                  selectedHistoryDetails.baseModePreset as DictationModePreset
                                ]?.label ?? selectedHistoryDetails.baseModePreset
                              : "Unavailable")}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Context source
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedHistoryDetails.contextSource ?? "Unavailable"}
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
                          {historyPromptSourceLabel(selectedHistoryDetails.promptSource)}
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
                          <span>Custom mode: {selectedHistoryDetails.customModeName}</span>
                        )}
                        {selectedHistoryDetails.contextAppName && (
                          <span>Context app: {selectedHistoryDetails.contextAppName}</span>
                        )}
                        {selectedHistoryDetails.appTarget && (
                          <span>Insert target: {selectedHistoryDetails.appTarget}</span>
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
                          <span>Command: {selectedHistoryDetails.commandApplied}</span>
                        )}
                      </div>
                    )}
                    {(selectedHistoryDetails.contextPreview ||
                      selectedHistoryDetails.promptPreview) && (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Captured context</p>
                          <div className="min-h-[110px] rounded-lg bg-muted p-4 text-sm">
                            <p className="whitespace-pre-wrap">
                              {selectedHistoryDetails.contextPreview || "No saved context preview."}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Prompt preview</p>
                          <div className="min-h-[110px] rounded-lg bg-muted p-4 text-sm">
                            <p className="whitespace-pre-wrap">
                              {selectedHistoryDetails.promptPreview || "Using the standard prompt for this path."}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Prompt/context inspection is available for newer dictations saved after this
                    update.
                  </p>
                )}
              </div>

              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Reprocess with mode</label>
                    <select
                      className="w-full min-w-[220px] rounded-md border bg-background p-2 text-sm"
                      value={reprocessModePreset}
                      onChange={(event) =>
                        setReprocessModePreset(event.target.value as DictationModePreset)
                      }
                    >
                      {DICTATION_MODE_DEFINITIONS.filter((mode) => mode.id !== "custom").map(
                        (mode) => (
                          <option key={mode.id} value={mode.id}>
                            {mode.label}
                          </option>
                        )
                      )}
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
                            `Reprocessed with ${modeDefinitionById[reprocessedResult.modePreset as DictationModePreset]?.label ?? reprocessedResult.modePreset}`
                          );
                        }}
                      >
                        Use Result
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Compare the saved transcript with a mode-tuned result before you copy or reuse it.
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
                    {selectedTranscript.modelId || selectedTranscript.model || "Unknown model"}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Ready to use
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {reprocessedResult
                      ? modeDefinitionById[reprocessedResult.modePreset as DictationModePreset]?.label ??
                        reprocessedResult.modePreset
                      : modeDefinitionById[reprocessModePreset]?.label ?? reprocessModePreset}
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
                    {reprocessedResult ? "Before and after" : "Raw transcript only"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Judge what Nautilus heard versus what you want to paste or save.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">What Nautilus heard</p>
                      <p className="text-xs text-muted-foreground">
                        The saved raw transcript from the original capture.
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(selectedTranscript.fullText)}
                    >
                      Copy
                    </Button>
                  </div>
                  <div className="p-4 bg-muted rounded-lg min-h-[180px]">
                    <p className="whitespace-pre-wrap text-sm">
                      {selectedTranscript.fullText}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Ready to use</p>
                      <p className="text-xs text-muted-foreground">
                        A mode-shaped result for paste, clipboard, or follow-up writing.
                      </p>
                    </div>
                    {reprocessedResult?.outputText && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigator.clipboard.writeText(reprocessedResult.outputText)}
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
                        Pick a mode and run Reprocess to preview an alternate result.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                Duration: {selectedRecording ? formatRecordingDuration(selectedRecording.duration) : "N/A"} · 
                Created: {selectedRecording ? new Date(selectedRecording.createdAt).toLocaleString() : "N/A"}
                {reprocessedResult && (
                  <>
                    {" "}· Final mode: {modeDefinitionById[reprocessedResult.modePreset as DictationModePreset]?.label ?? reprocessedResult.modePreset}
                    {" "}· {reprocessedResult.usedAi ? "AI tuned" : "Rule based"}
                    {reprocessedResult.provider ? ` · Final engine: ${reprocessedResult.provider}` : ""}
                    {reprocessedResult.modelId ? ` · Final model: ${reprocessedResult.modelId}` : ""}
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
    </div>
  );
}
