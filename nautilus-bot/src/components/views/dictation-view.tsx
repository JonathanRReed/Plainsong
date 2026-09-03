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
  EXTERNAL_APP_CORRECTION_SOURCE,
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
  type DictationHistorySearchHit,
  type DictationReprocessOutcome,
  type DictationInsights,
  getDictationHistoryDetails,
  getDictationInsights,
  captureSelectedTextForPlayback,
  reprocessDictation,
  reprocessDictationText,
  searchDictationHistory,
} from "@/lib/backend/dictation";
import { deleteRecording, getTranscript } from "@/lib/backend/recordings";
import { downloadAsrModels, getAsrProviders } from "@/lib/backend/asr";
import { getSettings, saveSettings } from "@/lib/backend/settings";
import {
  getLivePreviewEngineStatus,
  type LivePreviewEngineStatus,
} from "@/lib/backend/ai";
import { normalizeDownloadStatus } from "@/lib/download-status";
import {
  defaultDictationShortcut,
  dictationInstruction,
  formatShortcutForDisplay,
  matchesShortcut,
} from "@/lib/shortcuts";
import {
  asrLanguageName,
  asrLanguageOptions,
  isDownloadableProvider,
  isKnownAsrProvider,
  providerHostingPreference,
  resolveAsrLanguageBoundary,
  type DictationRoutePreference,
} from "@/lib/asr-capabilities";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatAppliedDictationCommandLabel } from "@/lib/dictation-command-labels";
import {
  probeDictationAiLane,
  resolveTranslateToEnglishAvailability,
} from "@/lib/dictation-translation";
import {
  INSERTION_MODE_LABELS,
  formatInsertionModeLabel,
  normalizeInsertionMode,
  splitHistorySnippet,
} from "@/lib/dictation-history-labels";
import {
  CUSTOM_MODE_NUMBERS_CHOICE_LABELS,
  DICTATION_NUMBER_MODE_IDS,
  DICTATION_NUMBERS_SECTION_DESCRIPTION,
  DICTATION_NUMBERS_SECTION_HEADING,
  customModeNumbersChoice,
  customModeNumbersValue,
  numbersAsDigitsModeHint,
  resolveCustomModeNumbersAsDigits,
  resolveNumbersAsDigits,
  type CustomModeNumbersChoice,
  type DictationNumbersAsDigitsMap,
} from "@/lib/dictation-numbers";
import {
  CONTEXT_SOURCE_LABELS,
  DICTATION_MODE_DEFINITIONS,
  DICTATION_MODE_DEFINITION_BY_ID,
  DICTATION_PROFILE_TILES,
  RECOMMENDED_APP_STYLES,
  CODING_PROFILE_STYLE_ID,
  QUIET_PROFILE_STYLE_ID,
  coerceBaseModePreset,
  resolveActiveDictationProfileId,
  summarizeMode,
  type DictationBaseModePreset,
  type DictationProfileIconKey,
  type RecommendedAppStyle,
} from "@/lib/dictation-profiles";
import {
  DICTATION_HOTKEY_MODE_CHIP_LABELS,
  resolveDictationHotkeyMode,
} from "@/lib/dictation-hotkey-mode";
import {
  requestMainView,
  requestReadinessDestination,
} from "@/lib/navigation";
import {
  describeCloudDictationVocabularyNote,
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";
import { invoke, listen } from "@/lib/electron";
import { speakTextAloud, stopSpeakingText } from "@/lib/text-to-speech";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Keyboard,
  Mic,
  Zap,
  RefreshCw,
  Download,
  Upload,
  Copy,
  Sparkles,
  Terminal,
  Volume2,
  BookOpen,
  NotebookPen,
  Replace,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DictationCaptureHero } from "@/components/views/dictation/dictation-capture-hero";
import { DictationHistoryDialog } from "@/components/views/dictation/dictation-history-dialog";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import { selectReadinessForSurface } from "@/features/readiness/product-readiness";
import { DictationTextActionsEditor } from "@/components/views/dictation/dictation-text-actions-editor";
import {
  DICTATION_TEXT_ACTIONS,
  getDictationTextContextDescription,
  type SelectedTextActionCommandPresetKey,
} from "@/lib/selected-text-actions";

import type {
  AsrProviderInfo,
  AsrProviderType,
  Recording,
  Transcript,
} from "@/types";
import type {
  DictationAppCategoryKey,
  DictationAppCategoryOverride,
  DictationCustomMode,
  Settings,
} from "@/types/settings";
import {
  useDictationRuntime,
  type DictationContextSource,
  type DictationInsertionMode,
  type DictationModePreset,
  type DictationPhase,
} from "@/features/dictation/runtime";
import { compareStrings, formatDateTime } from "@/lib/format-locale";

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

type CorrectionSuggestionGroup = {
  key: string;
  suggestionIds: string[];
  spokenForm: string;
  replacement: string;
  appTarget: string | null;
  source: string | null;
  updatedAt: string;
  sampleOriginalText: string;
  sampleCorrectedText: string;
};

/**
 * Where the one-time card offering "learn from corrections in other apps" is
 * remembered once the user has closed it. Per-machine, like the coach steps
 * above it — this is a "you have seen this" marker, not a preference, and the
 * preference itself lives in settings.
 */
const EXTERNAL_CORRECTION_CARD_STORAGE_KEY =
  "plainsong-external-correction-card-dismissed";

/**
 * How many dictations someone has to have finished before Plainsong mentions
 * the feature at all. Offering it on day one would be asking permission to read
 * other apps' text from someone with no reason yet to want it; by five they
 * have seen the app get a word wrong somewhere and fixed it themselves.
 */
const EXTERNAL_CORRECTION_CARD_MIN_DICTATIONS = 5;

/**
 * Whether to show the one-time card. Every condition has to hold: it never
 * appears once the feature is on (there is nothing left to offer), never
 * appears again after it is closed, and never appears before the user has done
 * enough dictating for it to mean anything. There is no second showing and no
 * nagging — closing it is final.
 */
function shouldShowExternalCorrectionCard(input: {
  featureEnabled: boolean;
  dismissed: boolean;
  totalDictations: number;
}): boolean {
  return (
    !input.featureEnabled &&
    !input.dismissed &&
    input.totalDictations >= EXTERNAL_CORRECTION_CARD_MIN_DICTATIONS
  );
}

/**
 * One queued correction, in either section of the inbox.
 *
 * The "Heard"/"Corrected" panels only appear when the stored sample says
 * something the headline does not. Readback suggestions store only the words
 * that changed — the sentence they came out of is never written down — so for
 * those the panels would just repeat the line above them.
 */
function CorrectionSuggestionRow({
  group,
  busy,
  onApprove,
  onDismiss,
}: {
  group: CorrectionSuggestionGroup;
  busy: boolean;
  onApprove: (suggestionIds: string[]) => void | Promise<void>;
  onDismiss: (suggestionIds: string[]) => void | Promise<void>;
}) {
  const hasSampleContext =
    group.sampleOriginalText.trim() !== group.spokenForm.trim() ||
    group.sampleCorrectedText.trim() !== group.replacement.trim();

  return (
    <div className="rounded-md border bg-background px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {group.spokenForm} {"->"} {group.replacement}
          </p>
          <p className="text-sm text-muted-foreground">
            {group.appTarget
              ? `${
                  group.source === EXTERNAL_APP_CORRECTION_SOURCE
                    ? "Corrected in"
                    : "Seen in"
                } ${group.appTarget}`
              : "Seen anywhere"}
            {" · "}
            {formatDateTime(group.updatedAt)}
            {group.suggestionIds.length > 1
              ? ` · ${group.suggestionIds.length} similar edits`
              : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void onApprove(group.suggestionIds)}
          >
            {group.suggestionIds.length > 1 ? "Approve all" : "Approve"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onDismiss(group.suggestionIds)}
          >
            {group.suggestionIds.length > 1 ? "Dismiss all" : "Dismiss"}
          </Button>
        </div>
      </div>
      {hasSampleContext && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div className="rounded-md bg-muted/40 px-2 py-2">
            <p className="rubric-muted">Heard</p>
            <p className="mt-1 text-sm">{group.sampleOriginalText}</p>
          </div>
          <div className="rounded-md bg-muted/40 px-2 py-2">
            <p className="rubric-muted">Corrected</p>
            <p className="mt-1 text-sm">{group.sampleCorrectedText}</p>
          </div>
        </div>
      )}
    </div>
  );
}

type DictationCustomModeDraft = {
  name: string;
  description: string;
  baseModePreset: DictationBaseModePreset;
  customPrompt: string;
  activationAppMatcher: string;
  activationDomainMatcher: string;
  languageOverride: string;
  livePreviewEnabled: boolean;
  numbersAsDigits: CustomModeNumbersChoice;
  /**
   * Deliver English however the words were spoken. Mirrors
   * `translateToEnglish` on the saved profile; whether it can be switched on
   * depends on the model (see `resolveTranslateToEnglishAvailability`).
   */
  translateToEnglish: boolean;
};

type DictationRouteReadiness = {
  status: "missing" | "downloading";
  providerType: AsrProviderType;
  modelId: string;
  providerLabel: string;
  routeLabel: string;
};

/**
 * Reports when the route dictation would actually resolve to has no model on
 * disk yet.
 *
 * `start_dictation` returns an error out of `resolve_ready_dictation_selection`
 * before the sidecar emits `dictation-state-changed`. Electron mirrors that
 * failure into the error HUD, while this view offers the proactive download
 * action. A brand-new install ships no model (the packaged extraResources carry
 * the sidecar, not weights), so this is the normal first-run state, not an
 * exotic one.
 */
function resolveDictationRouteReadiness(
  settings: Settings,
  providers: AsrProviderInfo[],
): DictationRouteReadiness | null {
  const transcription = settings.transcription;
  const useShared = transcription.useSharedAsrSelection ?? true;
  const providerType = (
    useShared
      ? transcription.defaultProvider
      : (transcription.dictationProvider ?? transcription.defaultProvider)
  ) as AsrProviderType | undefined;

  // Cloud and platform-native routes fail for other reasons (a missing API
  // key, a missing speech grant) that other surfaces already name. "No model
  // downloaded" is only meaningful for the local, downloadable engines.
  if (!providerType || !isDownloadableProvider(providerType)) {
    return null;
  }

  const provider = providers.find((item) => item.providerType === providerType);
  if (!provider) {
    return null;
  }

  const downloadKind = normalizeDownloadStatus(provider.downloadStatus).kind;
  if (
    provider.runtimeStatus === "ready" ||
    provider.runtimeStatus === "error" ||
    provider.runtimeStatus === "missing_runtime"
  ) {
    return null;
  }

  const modelId =
    (useShared
      ? transcription.selectedModelId
      : (transcription.dictationModelId ?? transcription.selectedModelId)) ??
    provider.selectedModelId;
  const modelLabel =
    provider.modelOptions.find((option) => option.id === modelId)?.label ??
    modelId;

  return {
    status: downloadKind === "downloading" ? "downloading" : "missing",
    providerType,
    modelId,
    providerLabel: provider.name,
    routeLabel: modelLabel ? `${provider.name} · ${modelLabel}` : provider.name,
  };
}

type LastDictationTone = "ready" | "insertion" | "transcription";

type LastDictationDetail = {
  label: string;
  value: string;
};

type LastDictationSummary = {
  tone: LastDictationTone;
  title: string;
  detail: string;
  /** Only set when something actually needs doing. */
  nextAction: string | null;
  items: LastDictationDetail[];
};

function formatDurationMetric(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

// Mirrors the case-only-match check inside `infer_learned_correction` in
// rust-sidecar/src/dictation_parity.rs: two phrases are a "case-only" edit
// when they're identical ignoring case but differ in actual casing (i.e. not
// a no-op, and not a change to the underlying letters/words/whitespace).
function isCaseOnlyDifference(original: string, corrected: string): boolean {
  const normalizedOriginal = original.trim().split(/\s+/).join(" ");
  const normalizedCorrected = corrected.trim().split(/\s+/).join(" ");
  if (!normalizedOriginal || !normalizedCorrected) {
    return false;
  }
  if (normalizedOriginal === normalizedCorrected) {
    return false;
  }
  return (
    normalizedOriginal.toLowerCase() === normalizedCorrected.toLowerCase()
  );
}

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

// Mirrors the built-in category descriptions from
// rust-sidecar/src/text/format.rs's `dictation_category_prompt_fragment`.
// Keep this in sync manually if the Rust copy changes (same precedent as
// RECOMMENDED_APP_STYLES below, which duplicates Rust-default copy into TS).
const DICTATION_APP_CATEGORY_REFERENCE: {
  key: DictationAppCategoryKey;
  label: string;
  description: string;
}[] = [
  {
    key: "messaging",
    label: "Messaging",
    description: "Casual and conversational, kept brief like a text message.",
  },
  {
    key: "email",
    label: "Email",
    description:
      "Formal, professional tone: full sentences, standard grammar, minimal contractions.",
  },
  {
    key: "notes",
    label: "Notes",
    description:
      "Preserves existing structure; only cleans up grammar and punctuation.",
  },
  {
    key: "worklog",
    label: "Project tools",
    description:
      "Keeps status, blockers, and next-steps explicit and concise.",
  },
  {
    key: "ai_chat",
    label: "AI chat",
    description:
      "Formats as a prompt or question; preserves code blocks and technical syntax exactly.",
  },
  {
    key: "code_editor",
    label: "Code editor",
    description:
      "Preserves code identifiers, file paths, CLI flags, and technical casing exactly.",
  },
];

const DICTATION_APP_CATEGORY_SELECT_OPTIONS: {
  value: DictationAppCategoryKey;
  label: string;
}[] = [
  ...DICTATION_APP_CATEGORY_REFERENCE.map((entry) => ({
    value: entry.key,
    label: entry.label,
  })),
  { value: "other", label: "Other (no special formatting)" },
];

const ACTIVATION_APP_SUGGESTIONS = ["Slack", "Notion", "Cursor", "Messages"];
const ACTIVATION_DOMAIN_SUGGESTIONS = [
  "gmail.com",
  "linear.app",
  "docs.google.com",
  "notion.so",
];
/**
 * Auto detect is the default and the first option in every list. The rest of
 * the list is the selected model's own coverage — see `asr-capabilities.ts`.
 * A hardcoded seven used to stand in for it, which was wrong in both
 * directions: it hid 92 of Whisper's languages, and offered six that
 * `base.en` answers with English-sounding nonsense.
 */
const DICTATION_AUTO_LANGUAGE_OPTION = {
  value: "auto",
  label: "Auto detect",
};

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
    title: "Save a profile per app",
    body: "A profile remembers the style, context, and insertion behavior that suits one kind of writing. Keep one for Slack, one for email, one for code, and switch with a click.",
    actionLabel: "I’ll use this",
  },
];

const DEFAULT_DICTATION_MODE: DictationModePreset = "voice";
const DEFAULT_BASE_MODE: DictationBaseModePreset = "voice";

/** Resolves the profile catalog's icon names to components at the render site. */
const PROFILE_TILE_ICONS: Record<DictationProfileIconKey, typeof Mic> = {
  sparkles: Sparkles,
  zap: Zap,
  book: BookOpen,
  notebook: NotebookPen,
  replace: Replace,
  terminal: Terminal,
  volume: Volume2,
  sliders: SlidersHorizontal,
};

type DictationConfigTab =
  | "profiles"
  | "capture"
  | "dictionary"
  | "snippets"
  | "corrections"
  | "text-actions"
  | "destinations";

const DICTATION_CONFIG_TABS: { value: DictationConfigTab; label: string }[] = [
  { value: "profiles", label: "Profiles" },
  { value: "capture", label: "Capture" },
  { value: "dictionary", label: "Dictionary" },
  { value: "snippets", label: "Snippets" },
  { value: "corrections", label: "Corrections" },
  { value: "text-actions", label: "Text actions" },
  { value: "destinations", label: "Destinations" },
];

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

/**
 * Keep only the languages the selected model can actually transcribe.
 *
 * A saved set can outlive the model it was chosen for — switching from Whisper
 * to Parakeet drops Mandarin, Hindi and Arabic — and a narrowing hint naming a
 * language the engine cannot produce is worse than no hint at all.
 */
function normalizeActiveLanguageSet(
  languages: string[],
  allowed: ReadonlySet<string> | null,
): string[] {
  const normalized: string[] = [];
  for (const language of languages) {
    const value = language.trim().toLowerCase();
    if (!value || value === "auto" || normalized.includes(value)) {
      continue;
    }
    if (allowed && !allowed.has(value)) {
      continue;
    }
    normalized.push(value);
  }
  return normalized;
}

function describeActivationRules(
  appMatcher: string | null | undefined,
  domainMatcher: string | null | undefined,
): string {
  const normalizedAppMatcher = appMatcher?.trim();
  const normalizedDomainMatcher = domainMatcher?.trim();

  if (normalizedAppMatcher && normalizedDomainMatcher) {
    return `While this profile is selected, captures are tagged when the frontmost app contains "${normalizedAppMatcher}" or the browser tab is on ${normalizedDomainMatcher}.`;
  }

  if (normalizedDomainMatcher) {
    return `While this profile is selected, captures are tagged when the browser tab is on ${normalizedDomainMatcher}.`;
  }

  if (normalizedAppMatcher) {
    return `While this profile is selected, captures are tagged when the frontmost app contains "${normalizedAppMatcher}".`;
  }

  return "No rule set. The profile still works — captures just aren't tagged with an app.";
}

function describeSmartContextState(
  activationMatcher: string | null,
  appTarget: string | null,
  contextChars: number | null,
): string {
  if (activationMatcher && appTarget) {
    return `Matched your "${activationMatcher}" rule, and read context from ${appTarget}.`;
  }
  if (activationMatcher) {
    return `Matched your "${activationMatcher}" rule, so destination formatting used that app.`;
  }
  if (appTarget && contextChars && contextChars > 0) {
    return `Read ${contextChars} characters of context from ${appTarget}.`;
  }
  if (appTarget) {
    return `Text goes into ${appTarget}.`;
  }
  return "Text goes into whichever app is in front when you start.";
}

function createCustomModeDraft(
  overrides?: Partial<DictationCustomModeDraft>,
): DictationCustomModeDraft {
  return {
    name: "Custom profile",
    description: "",
    baseModePreset: DEFAULT_BASE_MODE,
    customPrompt: "",
    activationAppMatcher: "",
    activationDomainMatcher: "",
    languageOverride: "",
    livePreviewEnabled: true,
    numbersAsDigits: "inherit",
    translateToEnglish: false,
    ...overrides,
  };
}

function getDictationPhaseSummary(
  phase: DictationPhase,
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
    case "preparing":
      return {
        title: "Loading local model",
        detail:
          message?.trim() ||
          "Plainsong is preparing the selected model before it opens the microphone.",
        tone: "active",
      };
    case "primed":
      return {
        title: "Model primed",
        detail:
          message?.trim() ||
          "The model is loaded and Plainsong is about to listen.",
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
        // "Ready to launch" borrowed a rocket metaphor from nothing in this
        // app, and the detail line under it ("Plainsong will take it from
        // there") spent a sentence saying nothing the button and the hotkey
        // line above had not already said twice.
        title: "Ready",
        detail: message?.trim() || "Speak when you are.",
        tone: "idle",
      };
  }
}

export function DictationView() {
  const {
    productReadiness,
    engineNotice,
    dismissEngineNotice,
    refresh: refreshProductReadiness,
  } = useProductReadinessStatus();
  const dictationReadiness = selectReadinessForSurface(
    productReadiness,
    "dictation",
  );
  const {
    stateEvent: dictationStateEvent,
    textReadyEvent: dictationTextReadyEvent,
  } = useDictationRuntime();
  const { formattedDuration, startDictation, stopDictation } = useRecording();
  const { toast } = useToast();
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
  const [repasteShortcutLabel, setRepasteShortcutLabel] = useState<
    string | null
  >(null);
  const [transcribedText, setTranscribedText] = useState("");
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModelId, setLastModelId] = useState<string | null>(null);
  const [lastRoutePreference, setLastRoutePreference] =
    useState<DictationRoutePreference | null>(null);
  const [lastProviderModelLabel, setLastProviderModelLabel] = useState<
    string | null
  >(null);
  const [lastResolvedHosting, setLastResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [startupLatencyMs, setStartupLatencyMs] = useState<number | null>(null);
  const [acknowledgementLatencyMs, setAcknowledgementLatencyMs] = useState<
    number | null
  >(null);
  const [captureReadyLatencyMs, setCaptureReadyLatencyMs] = useState<
    number | null
  >(null);
  const [firstStablePartialLatencyMs, setFirstStablePartialLatencyMs] = useState<
    number | null
  >(null);
  const [finalTranscriptLatencyMs, setFinalTranscriptLatencyMs] = useState<
    number | null
  >(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [insertionModeUsed, setInsertionModeUsed] = useState<string | null>(
    null,
  );
  const [commandApplied, setCommandApplied] = useState<string | null>(null);
  const [snippetAppliedCount, setSnippetAppliedCount] = useState(0);
  const [dictationPhase, setDictationPhase] =
    useState<DictationPhase>("idle");
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
  // Must match the shipped default in rust-sidecar/src/settings.rs
  // (`dictation_push_to_talk: false` — "Toggle mode is safer for new users and
  // avoids silent hold-to-talk confusion"). This seeds what the page renders
  // before real settings arrive, and it drives the hotkey instruction: seeding
  // it `true` made every launch briefly tell the user to HOLD the key, which is
  // the wrong mode, and left it wrong for good if settings ever failed to load.
  const [dictationPushToTalk, setDictationPushToTalk] = useState(false);
  const [dictationHandsFreeEnabled, setDictationHandsFreeEnabled] =
    useState(false);
  const [dictationRoutePreference, setDictationRoutePreference] =
    useState<DictationRoutePreference>("local");
  const [dictationRouteOverrideEnabled, setDictationRouteOverrideEnabled] =
    useState(true);
  const [dictationKeepWarm, setDictationKeepWarm] = useState<"off" | "on">(
    "on",
  );
  const [dictationLivePreviewEngine, setDictationLivePreviewEngine] = useState<
    "auto" | "redecode" | "streaming"
  >("auto");
  // Whether this build has a streaming preview engine, and whether its weights
  // are installed. Null until the sidecar answers, and left null if it cannot:
  // the engine control stays hidden rather than offering a choice between one
  // engine that exists and one that might not.
  const [livePreviewEngineStatus, setLivePreviewEngineStatus] =
    useState<LivePreviewEngineStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    void getLivePreviewEngineStatus()
      .then((status) => {
        if (!disposed) {
          setLivePreviewEngineStatus(status);
        }
      })
      .catch(() => {
        if (!disposed) {
          setLivePreviewEngineStatus(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);
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
  const [
    dictationLearnFromExternalCorrections,
    setDictationLearnFromExternalCorrections,
  ] = useState(false);
  const [
    externalCorrectionCardDismissed,
    setExternalCorrectionCardDismissed,
  ] = useState(true);
  const [
    dictationCategoryFormattingEnabled,
    setDictationCategoryFormattingEnabled,
  ] = useState(true);
  const [
    dictationAppCategoryOverrides,
    setDictationAppCategoryOverrides,
  ] = useState<DictationAppCategoryOverride[]>([]);
  const [dictationNumbersAsDigits, setDictationNumbersAsDigits] =
    useState<DictationNumbersAsDigitsMap>({});
  const [newCategoryOverrideAppMatcher, setNewCategoryOverrideAppMatcher] =
    useState("");
  const [newCategoryOverrideCategory, setNewCategoryOverrideCategory] =
    useState<DictationAppCategoryKey>("messaging");
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
  const [newDictionaryCategoryScope, setNewDictionaryCategoryScope] =
    useState<DictationAppCategoryKey | "any">("any");
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
  const [newSnippetCategoryScope, setNewSnippetCategoryScope] = useState<
    DictationAppCategoryKey | "any"
  >("any");
  const [dictationRetentionPreset, setDictationRetentionPreset] = useState<
    "immediate" | "24h" | "72h" | "never" | "custom"
  >("never");
  const [dictationRetentionCustomHours, setDictationRetentionCustomHours] =
    useState(24);
  const [dictationKeepAudio, setDictationKeepAudio] = useState(false);
  const [hotkeyPressed, setHotkeyPressed] = useState(false);
  const [activeConfigTab, setActiveConfigTab] =
    useState<DictationConfigTab>("profiles");
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(
    null,
  );
  const [pendingHistoryDelete, setPendingHistoryDelete] =
    useState<Recording | null>(null);
  const [selectedTranscript, setSelectedTranscript] =
    useState<Transcript | null>(null);
  const [selectedHistoryDetails, setSelectedHistoryDetails] =
    useState<DictationHistoryDetails | null>(null);
  const [dictationInsights, setDictationInsights] =
    useState<DictationInsights | null>(null);
  const [latestCorrectionBaseline, setLatestCorrectionBaseline] = useState("");
  // "Edited since capture" is deliberately NOT the correction baseline: both
  // correction paths reset that baseline to the edited wording, while the text
  // Plainsong actually captured (and the sidecar still stores for the
  // "Paste last result" shortcut) never changes. Only a fresh capture clears it.
  const [latestResultDirty, setLatestResultDirty] = useState(false);
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
  // "Process again": the kept audio through the recognizer and a chosen mode,
  // saved as a new history entry. Distinct from the text-only restyle above.
  const [processAgainModeId, setProcessAgainModeId] = useState<string>("voice");
  const [processAgainOutcome, setProcessAgainOutcome] =
    useState<DictationReprocessOutcome | null>(null);
  const [isProcessingAgain, setIsProcessingAgain] = useState(false);
  const [processAgainError, setProcessAgainError] = useState<string | null>(
    null,
  );
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
  // Whether cloud AI is allowed at all, and whether the dictation AI lane can
  // actually answer right now (`null` until the probe returns). Only the
  // profile's translate-to-English switch reads them.
  const [remoteProcessingEnabled, setRemoteProcessingEnabled] = useState(false);
  const [dictationAiLaneReady, setDictationAiLaneReady] = useState<
    boolean | null
  >(null);
  const [dictationRouteReadiness, setDictationRouteReadiness] =
    useState<DictationRouteReadiness | null>(null);
  const [routeDownloadBusy, setRouteDownloadBusy] = useState(false);
  const [routeDownloadError, setRouteDownloadError] = useState<string | null>(
    null,
  );
  const [currentAiProvider, setCurrentAiProvider] = useState<string | null>(
    null,
  );
  const [currentAiModelId, setCurrentAiModelId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const activeProfileId = useMemo(
    () =>
      resolveActiveDictationProfileId(dictationModePreset, selectedCustomModeId),
    [dictationModePreset, selectedCustomModeId],
  );

  const activeProfile = useMemo(
    () =>
      DICTATION_PROFILE_TILES.find((tile) => tile.id === activeProfileId) ??
      DICTATION_PROFILE_TILES[0],
    [activeProfileId],
  );

  const hotkeyMode = useMemo(
    () =>
      resolveDictationHotkeyMode(
        dictationPushToTalk,
        dictationHandsFreeEnabled,
      ),
    [dictationHandsFreeEnabled, dictationPushToTalk],
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
    dictationPhase === "preparing" ||
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
  // What the selected route can actually transcribe. Everything the language
  // controls offer is derived from this, so the picker's boundary is the
  // model's boundary rather than a list someone typed once.
  const dictationLanguageBoundary = useMemo(
    () =>
      resolveAsrLanguageBoundary(
        isKnownAsrProvider(currentDictationProvider)
          ? (currentDictationProvider as AsrProviderType)
          : null,
        currentDictationModelId,
      ),
    [currentDictationModelId, currentDictationProvider],
  );
  const dictationLanguageChoices = useMemo(
    () => asrLanguageOptions(dictationLanguageBoundary),
    [dictationLanguageBoundary],
  );
  // Translate-to-English for a saved profile (roadmap item B7a). Multilingual
  // whisper.cpp translates inside its own decode; every other recognizer needs
  // the dictation AI lane, so the switch is only offered when that lane can
  // answer. Re-probed whenever the lane's provider or the remote-processing
  // switch changes.
  useEffect(() => {
    let mounted = true;
    void probeDictationAiLane({
      dictationAi: { provider: currentAiProvider ?? "", modelId: null },
      remoteProcessingEnabled,
    }).then((ready) => {
      if (mounted) {
        setDictationAiLaneReady(ready);
      }
    });
    return () => {
      mounted = false;
    };
  }, [currentAiProvider, remoteProcessingEnabled]);
  const profileTranslateAvailability = useMemo(
    () =>
      resolveTranslateToEnglishAvailability({
        provider: currentDictationProvider,
        modelId: currentDictationModelId,
        aiLaneReady: dictationAiLaneReady,
      }),
    [currentDictationModelId, currentDictationProvider, dictationAiLaneReady],
  );
  const dictationLanguageCodes = useMemo(
    () =>
      dictationLanguageBoundary.kind === "enumerated"
        ? new Set(dictationLanguageBoundary.codes)
        : null,
    [dictationLanguageBoundary],
  );
  const dictationSessionLanguageOptions = useMemo(
    () => [DICTATION_AUTO_LANGUAGE_OPTION, ...dictationLanguageChoices],
    [dictationLanguageChoices],
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
        // Kept in the key so an edit made inside Plainsong and the same edit
        // read back out of Slack stay two separate rows: they are shown in
        // different sections and say different things about where the text
        // came from.
        suggestion.source ?? "",
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
          source: suggestion.source ?? null,
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

  // Two lists, not one. A suggestion read back out of another app is a
  // different kind of thing from one the user typed in Plainsong's own result
  // box — it carries a claim about text that was on screen somewhere else — so
  // it gets its own section, its own explanation, and its own approval.
  const externalCorrectionSuggestionGroups = useMemo(
    () =>
      groupedCorrectionSuggestions.filter(
        (group) => group.source === EXTERNAL_APP_CORRECTION_SOURCE,
      ),
    [groupedCorrectionSuggestions],
  );
  const inAppCorrectionSuggestionGroups = useMemo(
    () =>
      groupedCorrectionSuggestions.filter(
        (group) => group.source !== EXTERNAL_APP_CORRECTION_SOURCE,
      ),
    [groupedCorrectionSuggestions],
  );
  const showExternalCorrectionCard = shouldShowExternalCorrectionCard({
    featureEnabled: dictationLearnFromExternalCorrections,
    dismissed: externalCorrectionCardDismissed,
    totalDictations: dictationInsights?.totalDictations ?? 0,
  });

  // Sourced entirely from the existing listDictationDictionaryEntries data
  // (DictationDictionaryEntry already carries createdAt/updatedAt from the
  // backend) — no new endpoint needed, just a client-side sort + slice.
  const recentlyLearnedDictionaryEntries = useMemo(() => {
    return [...dictationDictionaryEntries]
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )
      .slice(0, 8);
  }, [dictationDictionaryEntries]);

  /**
   * Which built-in mode a set of controls adds up to.
   *
   * Clipboard behaviour is not part of the comparison: it is the reader's own
   * setting, kept across profile changes, so including it would report a
   * plainly-General setup as "custom" purely because copying is on.
   */
  const inferModePreset = (values: {
    profile: "normal_speed" | "power_rewrite";
    insertionMode: DictationInsertionMode;
    contextSource: DictationContextSource;
    saveToInbox: boolean;
    commandModeEnabled: boolean;
  }): DictationModePreset => {
    const matched = DICTATION_MODE_DEFINITIONS.find((definition) => {
      if (definition.id === "custom") return false;
      return (
        definition.profile === values.profile &&
        definition.insertionMode === values.insertionMode &&
        definition.contextSource === values.contextSource &&
        definition.saveToInbox === values.saveToInbox &&
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
    setProcessAgainOutcome(null);
    setProcessAgainError(null);
    setProcessAgainModeId(
      dictationModePreset === "custom"
        ? (selectedCustomMode?.id ?? DEFAULT_BASE_MODE)
        : dictationModePreset,
    );
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
    selectedCustomMode?.id,
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

  // History search: the query is debounced so typing does not send a request
  // per keystroke, and results are keyed to the query that produced them so a
  // slow answer to an old query can never overwrite a newer one.
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchResults, setHistorySearchResults] = useState<
    DictationHistorySearchHit[] | null
  >(null);
  const [historySearchPending, setHistorySearchPending] = useState(false);
  const [historySearchError, setHistorySearchError] = useState<string | null>(
    null,
  );
  const historyResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const trimmedHistorySearchQuery = historySearchQuery.trim();
  useEffect(() => {
    if (!trimmedHistorySearchQuery) {
      setHistorySearchResults(null);
      setHistorySearchPending(false);
      setHistorySearchError(null);
      return;
    }
    let cancelled = false;
    setHistorySearchPending(true);
    const timer = window.setTimeout(() => {
      searchDictationHistory(trimmedHistorySearchQuery, { limit: 25 })
        .then((hits) => {
          if (cancelled) return;
          setHistorySearchResults(hits);
          setHistorySearchError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          setHistorySearchResults([]);
          setHistorySearchError(
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          if (!cancelled) setHistorySearchPending(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `recordings` is a dependency on purpose: a new or deleted dictation
    // re-runs the same query so the list never shows a stale hit.
  }, [trimmedHistorySearchQuery, recordings]);
  const openHistoryEntryById = (recordingId: string) => {
    const recording = recordings.find((entry) => entry.id === recordingId);
    if (!recording) return;
    setSelectedRecording(recording);
    setIsDialogOpen(true);
  };
  // Arrow keys wrap around the rendered hits. The ref array is trimmed to the
  // current result count first, so a shorter result set cannot send focus to a
  // button that no longer exists.
  const focusHistoryResult = (index: number) => {
    const count = historySearchResults?.length ?? 0;
    historyResultRefs.current.length = count;
    if (count === 0) return;
    const clamped = ((index % count) + count) % count;
    historyResultRefs.current[clamped]?.focus();
  };

  const lastDictationStatus = useMemo<LastDictationSummary | null>(() => {
    const hasTelemetry =
      Boolean(lastProvider) ||
      Boolean(lastModelId) ||
      Boolean(lastResolvedHosting) ||
      Boolean(lastRoutePreference) ||
      Boolean(lastProviderModelLabel) ||
      Boolean(insertionModeUsed) ||
      Boolean(commandApplied) ||
      snippetAppliedCount > 0 ||
      Boolean(appTarget) ||
      Boolean(activationMatcher) ||
      contextChars !== null ||
      acknowledgementLatencyMs !== null ||
      captureReadyLatencyMs !== null ||
      firstStablePartialLatencyMs !== null ||
      finalTranscriptLatencyMs !== null ||
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
    // The happy path says "Paste command sent", so the words "paste" and
    // "clipboard" appear on a capture that landed perfectly. Carve the
    // success wording out first, otherwise every successful insert is
    // reported as "insertion needs a look". Carving out the one known
    // success string (rather than enumerating failure phrasings) keeps a
    // failure we haven't seen before on the attention path.
    const insertionSucceeded = paste
      .toLowerCase()
      .startsWith("paste command sent");
    const insertionNeedsAttention =
      !insertionSucceeded &&
      (combined.includes("accessibility") ||
        combined.includes("cursor insertion") ||
        combined.includes("paste") ||
        combined.includes("clipboard") ||
        combined.includes("frontmost"));
    // Matches both the sidecar's own wording ("route", "provider") and the
    // plainer sentence this view builds for a fallback ("engine").
    const routeNeedsAttention =
      combined.includes("fallback") ||
      combined.includes("engine") ||
      combined.includes("provider") ||
      combined.includes("model") ||
      combined.includes("route");
    const tone: LastDictationTone = insertionNeedsAttention
      ? "insertion"
      : routeNeedsAttention
        ? "transcription"
        : "ready";
    const nextAction = insertionNeedsAttention
      ? "Make sure the app you want the text in is in front. If it keeps failing, set Insertion mode to Clipboard only for this kind of app."
      : routeNeedsAttention
        ? "Download the model you asked for, or pick the one that actually finished this capture."
        : null;

    // One engine line, not four: the sidecar's own label already reads
    // "Engine · model", so the raw slug and the "provider/model" id it also
    // sends are the same fact twice more.
    const engineLabel =
      lastProviderModelLabel ||
      [lastProvider, lastModelId].filter(Boolean).join(" · ") ||
      null;
    // Only worth saying where it ran if that isn't where you asked it to run.
    const hostingDiffered =
      Boolean(lastResolvedHosting) &&
      Boolean(lastRoutePreference) &&
      lastResolvedHosting !== lastRoutePreference;

    const items: LastDictationDetail[] = [
      appTarget ? { label: "Target app", value: appTarget } : null,
      insertionModeUsed
        ? {
            label: "Delivery",
            value: formatInsertionModeLabel(insertionModeUsed) ?? insertionModeUsed,
          }
        : null,
      engineLabel ? { label: "Transcribed by", value: engineLabel } : null,
      lastResolvedHosting
        ? {
            label: "Ran on",
            value: lastResolvedHosting === "cloud" ? "The cloud" : "This Mac",
          }
        : null,
      hostingDiffered
        ? {
            label: "You asked for",
            value: lastRoutePreference === "cloud" ? "The cloud" : "This Mac",
          }
        : null,
      endToEndMs !== null
        ? { label: "Total time", value: formatDurationMetric(endToEndMs) ?? "" }
        : null,
      acknowledgementLatencyMs !== null
        ? {
            label: "Acknowledged",
            value: formatDurationMetric(acknowledgementLatencyMs) ?? "",
          }
        : null,
      captureReadyLatencyMs !== null
        ? {
            label: "Capture ready",
            value: formatDurationMetric(captureReadyLatencyMs) ?? "",
          }
        : null,
      firstStablePartialLatencyMs !== null
        ? {
            label: "First preview",
            value: formatDurationMetric(firstStablePartialLatencyMs) ?? "",
          }
        : null,
      finalTranscriptLatencyMs !== null
        ? {
            label: "Final transcript",
            value: formatDurationMetric(finalTranscriptLatencyMs) ?? "",
          }
        : null,
      latencyMs !== null
        ? { label: "Transcribing", value: formatDurationMetric(latencyMs) ?? "" }
        : null,
      insertLatencyMs !== null
        ? { label: "Inserting", value: formatDurationMetric(insertLatencyMs) ?? "" }
        : null,
      startupLatencyMs !== null
        ? { label: "Starting up", value: formatDurationMetric(startupLatencyMs) ?? "" }
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
        ? { label: "Phrases expanded", value: String(snippetAppliedCount) }
        : null,
      activationMatcher ? { label: "Auto mode", value: activationMatcher } : null,
      contextChars !== null && contextChars > 0
        ? { label: "Context read", value: `${contextChars} characters` }
        : null,
    ].filter((item): item is LastDictationDetail => Boolean(item));

    return {
      tone,
      title:
        tone === "ready"
          ? "Last dictation: inserted cleanly"
          : tone === "transcription"
            ? "Last dictation: transcription needs a look"
            : "Last dictation: insertion needs a look",
      detail:
        paste ||
        fallback ||
        "Where the text came from, where it went, and how long it took.",
      nextAction,
      items,
    };
  }, [
    activationMatcher,
    acknowledgementLatencyMs,
    appTarget,
    commandApplied,
    contextChars,
    captureReadyLatencyMs,
    endToEndMs,
    fallbackStatus,
    finalTranscriptLatencyMs,
    firstStablePartialLatencyMs,
    insertLatencyMs,
    insertionModeUsed,
    lastModelId,
    lastProvider,
    lastProviderModelLabel,
    lastResolvedHosting,
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

  const refreshDictationRouteReadiness = async () => {
    try {
      const [settings, providers] = await Promise.all([
        getSettings(),
        getAsrProviders(),
      ]);
      setDictationRouteReadiness(
        resolveDictationRouteReadiness(settings, providers),
      );
    } catch (error) {
      // Keep whatever the last known answer was rather than inventing either
      // a blocker or an all-clear from a failed probe.
      console.warn("Failed to check the dictation route readiness:", error);
    }
  };

  const handleDownloadDictationRouteModel = async () => {
    if (!dictationRouteReadiness || routeDownloadBusy) {
      return;
    }
    setRouteDownloadBusy(true);
    setRouteDownloadError(null);
    try {
      await downloadAsrModels(
        dictationRouteReadiness.providerType,
        dictationRouteReadiness.modelId
      );
      await Promise.all([
        refreshDictationRouteReadiness(),
        refreshProductReadiness(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRouteDownloadError(message);
      toast("Couldn't download the dictation model.", "error");
    } finally {
      setRouteDownloadBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void refreshDictationInsights();
    void refreshDictationRouteReadiness();
    void getSettings()
      .then((settings) => {
        if (!mounted) return;
        const nextSaveToInbox = settings.transcription.dictationSaveToInbox;
        const nextProfile = settings.transcription.dictationProfile;
        const nextCopyToClipboard =
          settings.transcription.dictationCopyToClipboard ?? false;
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
        // Dictation cleanup runs on the dictation lane, never the meetings one.
        setCurrentAiProvider(settings.privacy.dictationAi?.provider ?? null);
        setCurrentAiModelId(settings.privacy.dictationAi?.modelId ?? null);
        setRemoteProcessingEnabled(
          settings.privacy.remoteProcessingEnabled ?? false,
        );
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
          settings.transcription.dictationKeepWarm ?? "on",
        );
        setDictationLivePreviewEnabled(
          settings.transcription.dictationLivePreviewEnabled ?? true,
        );
        setDictationLivePreviewEngine(
          settings.transcription.dictationLivePreviewEngine ?? "auto",
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
            null,
          ),
        );
        setDictationSnippetsEnabled(
          settings.transcription.dictationSnippetsEnabled ?? true,
        );
        setDictationAutoLearnCorrections(
          settings.transcription.dictationAutoLearnCorrections ?? true,
        );
        // Defaults to off, and a settings file that predates the setting must
        // read as off too — this is the switch that lets Plainsong look at
        // another app's text.
        setDictationLearnFromExternalCorrections(
          settings.transcription.dictationLearnFromExternalCorrections ?? false,
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
        setDictationKeepAudio(settings.transcription.dictationKeepAudio ?? false);
        setDictationCategoryFormattingEnabled(
          settings.transcription.dictationCategoryFormattingEnabled ?? true,
        );
        setDictationAppCategoryOverrides(
          settings.transcription.dictationAppCategoryOverrides ?? [],
        );
        setDictationNumbersAsDigits(
          settings.transcription.dictationNumbersAsDigits ?? {},
        );
        const shortcut = settings.shortcuts.toggleDictation || defaultShortcut;
        setHotkeyLabel(formatShortcutForDisplay(shortcut));
        setHotkeyShortcut(shortcut);
        const repasteShortcut = settings.shortcuts.repasteLastDictation?.trim();
        setRepasteShortcutLabel(
          repasteShortcut ? formatShortcutForDisplay(repasteShortcut) : null,
        );
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

  // Starts at "dismissed" so the card cannot flash on screen for a frame before
  // storage is read; a machine that has never seen it flips to false here.
  useEffect(() => {
    try {
      const storage = getSafeLocalStorage();
      if (!storage) {
        return;
      }
      setExternalCorrectionCardDismissed(
        storage.getItem(EXTERNAL_CORRECTION_CARD_STORAGE_KEY) === "true",
      );
    } catch (error) {
      console.warn(
        "Failed to restore the external-correction card state:",
        error,
      );
    }
  }, []);

  const dismissExternalCorrectionCard = () => {
    setExternalCorrectionCardDismissed(true);
    try {
      getSafeLocalStorage()?.setItem(
        EXTERNAL_CORRECTION_CARD_STORAGE_KEY,
        "true",
      );
    } catch (error) {
      console.warn(
        "Failed to persist the external-correction card state:",
        error,
      );
    }
  };

  // The sidecar queues readback suggestions on its own timer, seconds after an
  // insert, so the inbox has to be told rather than polled.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen("dictation-correction-suggestions-changed", () => {
      if (disposed) {
        return;
      }
      void listDictationCorrectionSuggestions()
        .then((suggestions) => {
          if (!disposed) {
            setDictationCorrectionSuggestions(suggestions);
          }
        })
        .catch((error) => {
          console.warn(
            "Failed to refresh dictation correction suggestions:",
            error,
          );
        });
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
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
      keepWarm: "off" | "on";
      livePreviewEnabled: boolean;
      livePreviewEngine: "auto" | "redecode" | "streaming";
      copyToClipboard: boolean;
      commandModeEnabled: boolean;
      commandPrefix: string;
      insertionMode: DictationInsertionMode;
      sessionLanguage: string | null;
      activeLanguages: string[];
      snippetsEnabled: boolean;
      autoLearnCorrections: boolean;
      learnFromExternalCorrections: boolean;
      silenceTimeoutSeconds: number;
      retentionPreset: "immediate" | "24h" | "72h" | "never" | "custom";
      retentionCustomHours: number;
      keepAudio: boolean;
      categoryFormattingEnabled: boolean;
      appCategoryOverrides: DictationAppCategoryOverride[];
      numbersAsDigits: DictationNumbersAsDigitsMap;
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
      const nextLivePreviewEngine =
        updates.livePreviewEngine ?? dictationLivePreviewEngine;
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
          ? normalizeActiveLanguageSet(
              updates.activeLanguages,
              dictationLanguageCodes,
            )
          : dictationActiveLanguages;
      const nextAutoLearnCorrections =
        updates.autoLearnCorrections ?? dictationAutoLearnCorrections;
      const nextLearnFromExternalCorrections =
        updates.learnFromExternalCorrections ??
        dictationLearnFromExternalCorrections;
      const nextSilenceTimeoutSeconds = normalizeDictationSilenceTimeoutSeconds(
        updates.silenceTimeoutSeconds ?? dictationSilenceTimeoutSeconds,
      );
      const nextCategoryFormattingEnabled =
        updates.categoryFormattingEnabled ?? dictationCategoryFormattingEnabled;
      const nextAppCategoryOverrides =
        updates.appCategoryOverrides ?? dictationAppCategoryOverrides;
      const nextModePreset =
        updates.modePreset ??
        inferModePreset({
          profile: nextProfile,
          insertionMode: nextInsertionMode,
          contextSource: nextContextSource,
          saveToInbox: nextSaveToInbox,
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
      settings.transcription.dictationLivePreviewEngine = nextLivePreviewEngine;
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
      settings.transcription.dictationLearnFromExternalCorrections =
        nextLearnFromExternalCorrections;
      settings.transcription.dictationSilenceTimeoutSeconds =
        nextSilenceTimeoutSeconds;
      settings.transcription.dictationRetentionPreset =
        updates.retentionPreset ?? dictationRetentionPreset;
      settings.transcription.dictationRetentionCustomHours =
        updates.retentionCustomHours ?? dictationRetentionCustomHours;
      settings.transcription.dictationKeepAudio =
        updates.keepAudio ?? dictationKeepAudio;
      settings.transcription.dictationCategoryFormattingEnabled =
        nextCategoryFormattingEnabled;
      settings.transcription.dictationAppCategoryOverrides =
        nextAppCategoryOverrides;
      settings.transcription.dictationNumbersAsDigits =
        updates.numbersAsDigits ?? dictationNumbersAsDigits;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist dictation preferences:", error);
      const changed = Object.keys(updates).join(", ");
      toast(
        changed
          ? `Couldn't save dictation settings (${changed}) — the change may not stick.`
          : "Couldn't save dictation settings — the change may not stick.",
        "error",
      );
    }
  };

  const applyDictationMode = (modeId: DictationModePreset) => {
    setDictationModePreset(modeId);
    setSelectedCustomModeId(null);
    const definition = DICTATION_MODE_DEFINITION_BY_ID[modeId];
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
    const nextCommandModeEnabled =
      definition.commandModeEnabled ?? dictationCommandModeEnabled;

    setDictationProfile(nextProfile);
    setDictationInsertionMode(nextInsertionMode);
    setDictationContextSource(nextContextSource);
    setSaveToInbox(nextSaveToInbox);
    setDictationCommandModeEnabled(nextCommandModeEnabled);

    // Clipboard behaviour is deliberately not written here. Picking a profile
    // must never replace what is on the reader's clipboard from then on; that
    // is its own toggle, and it keeps whatever value it already had.
    void persistDictationPreferences({
      modePreset: modeId,
      selectedCustomModeId: null,
      profile: nextProfile,
      insertionMode: nextInsertionMode,
      contextSource: nextContextSource,
      saveToInbox: nextSaveToInbox,
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
    name: (overrides?.name ?? customModeDraft.name).trim() || "Custom profile",
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
    numbersAsDigits:
      overrides?.numbersAsDigits ??
      customModeNumbersValue(customModeDraft.numbersAsDigits),
    // A model that cannot translate must not save a profile claiming it will.
    translateToEnglish:
      overrides?.translateToEnglish ??
      (profileTranslateAvailability.enabled &&
        customModeDraft.translateToEnglish),
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
    // A profile saved before `paste`/`inline` were retired still carries one
    // until the sidecar rewrites settings.json, and feeding that straight into
    // the picker leaves a `<select>` with no matching option.
    const insertionMode = normalizeInsertionMode(mode.insertionMode);
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
        numbersAsDigits: customModeNumbersChoice(mode.numbersAsDigits),
        translateToEnglish: mode.translateToEnglish ?? false,
      }),
    );
    setDictationProfile(mode.profile);
    setDictationRoutePreference(
      mode.routePreference ?? dictationRoutePreference,
    );
    setDictationInsertionMode(insertionMode);
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
      insertionMode,
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
        settings.transcription.dictationInsertionMode = insertionMode;
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
        // A dictation mode only ever moves the dictation lane; meeting
        // summaries keep whichever provider the AI settings tab chose.
        settings.privacy.dictationAi = {
          provider: mode.aiProvider || settings.privacy.dictationAi.provider,
          modelId: mode.aiModelId ?? settings.privacy.dictationAi.modelId ?? null,
        };
        await saveSettings(settings);
      } catch (error) {
        console.warn("Failed to apply saved profile engine settings:", error);
        toast("Couldn't apply this mode's engine settings — check Settings.", "error");
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
        numbersAsDigits: customModeNumbersChoice(nextMode.numbersAsDigits),
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
      // A dictation mode only ever moves the dictation lane; meeting
      // summaries keep whichever provider the AI settings tab chose.
      settings.privacy.dictationAi = {
        provider: nextMode.aiProvider || settings.privacy.dictationAi.provider,
        modelId:
          nextMode.aiModelId ?? settings.privacy.dictationAi.modelId ?? null,
      };
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist saved profile engine snapshot:", error);
      toast("Couldn't save this mode's engine settings — they may reset on restart.", "error");
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
        numbersAsDigits: customModeNumbersChoice(nextMode.numbersAsDigits),
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
      // A dictation mode only ever moves the dictation lane; meeting
      // summaries keep whichever provider the AI settings tab chose.
      settings.privacy.dictationAi = {
        provider: nextMode.aiProvider || settings.privacy.dictationAi.provider,
        modelId:
          nextMode.aiModelId ?? settings.privacy.dictationAi.modelId ?? null,
      };
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist recommended profile:", error);
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
          numbersAsDigits: customModeNumbersChoice(
            selectedCustomMode.numbersAsDigits,
          ),
        }),
      );
      return;
    }
    if (dictationModePreset === "custom") {
      setCustomModeDraft((current) => ({
        ...current,
        name: current.name || "Custom profile",
      }));
    }
  }, [dictationLivePreviewEnabled, dictationModePreset, selectedCustomMode]);

  useEffect(() => {
    // Listen for hotkey visual feedback
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, hotkeyShortcut)) {
        setHotkeyPressed(true);

        // A press against a route with no model is answered by nothing at
        // all: the sidecar returns an error before it emits any dictation
        // state, so the chip below would flash as though capture started.
        // Say out loud what actually happened.
        if (dictationRouteReadiness) {
          toast(
            dictationRouteReadiness.status === "downloading"
              ? `${dictationRouteReadiness.routeLabel} is still downloading. Dictation starts once it finishes.`
              : `Dictation can't start yet — ${dictationRouteReadiness.routeLabel} is not downloaded.`,
            "error",
          );
        }

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
  }, [dictationRouteReadiness, hotkeyShortcut, toast]);

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
      setLatestResultDirty(false);
      setLatestLearnStatus(null);
    }
    if (payload.actualProvider) {
      setLastProvider(payload.actualProvider);
    }
    if (payload.fallbackMessage) {
      setFallbackStatus(payload.fallbackMessage);
    } else if (payload.isFallback === true) {
      const reason =
        payload.fallbackReason?.trim() ||
        "The engine you asked for could not finish the transcription.";
      setFallbackStatus(
        `Used a different engine: you asked for '${payload.requestedProvider}', Plainsong used '${payload.actualProvider}'. ${reason}`,
      );
    } else {
      setFallbackStatus(null);
    }
    if (payload.modelId) {
      setLastModelId(payload.modelId);
    }
    setLastRoutePreference(payload.routePreference ?? null);
    setLastProviderModelLabel(payload.providerModelLabel ?? null);
    setLastResolvedHosting(payload.resolvedHosting ?? null);
    setStartupLatencyMs(payload.startupLatencyMs ?? null);
    setAcknowledgementLatencyMs(payload.acknowledgementLatencyMs ?? null);
    setCaptureReadyLatencyMs(payload.captureReadyLatencyMs ?? null);
    setFirstStablePartialLatencyMs(payload.firstStablePartialLatencyMs ?? null);
    setFinalTranscriptLatencyMs(payload.finalTranscriptLatencyMs ?? null);
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
    // `copied` reports whether the text is still on the clipboard afterwards.
    // With "Copy to clipboard" off (the default) the staged copy is restored,
    // so an unconditional "also copied" would send the user to Cmd+V for
    // whatever they had copied before dictating.
    const leftOnClipboard = payload.copied === true;
    // A refused delivery (password or secure field) is not "ready to review":
    // nothing was inserted or copied, and the message has to say so.
    const deliveryRefusal = describeDictationDeliveryRefusal(payload.outcome);
    setDictationPhaseMessage(
      deliveryRefusal
        ? deliveryRefusal.message
        : payload.pasted
          ? leftOnClipboard
            ? "Inserted into the target app and copied to the clipboard."
            : "Inserted into the target app."
          : leftOnClipboard
            ? "Copied to the clipboard and ready to paste."
            : "Result is ready to review.",
    );
    setDictationPhasePreview(text || null);
    if (payload.pasted) {
      setPasteStatus(
        leftOnClipboard
          ? "Paste command sent (also copied to clipboard)"
          : "Paste command sent",
      );
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
      if (dictationPhase === "preparing") {
        await invoke("force_stop_dictation");
        return;
      }
      const text = await stopDictation();
      if (text?.trim()) {
        setTranscribedText(text);
        setLatestCorrectionBaseline(text);
        setLatestResultDirty(false);
        setLatestLearnStatus(null);
        void refetchDictationHistory();
      }
    } catch (error) {
      const message =
        sanitizeUserFacingDictationMessage(
          error instanceof Error ? error.message : String(error),
          { phase: "error" },
        ) ?? "Dictation failed.";
      setDictationPhase("error");
      setDictationPhaseMessage(message);
      setDictationPhasePreview(null);
    }
  };

  const launchDictation = async () => {
    if (dictationReadiness.state !== "ready") {
      const message =
        dictationReadiness.cause?.message ??
        "Plainsong could not confirm that dictation is ready.";
      setDictationPhase("error");
      setDictationPhaseMessage(message);
      setDictationPhasePreview(null);
      return;
    }

    const routePreference =
      dictationRouteOverrideEnabled && nextCaptureRoutePreference
        ? nextCaptureRoutePreference
        : dictationRoutePreference;
    if (dictationRouteOverrideEnabled) {
      setNextCaptureRoutePreference(null);
    }
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
        ...(newSnippetCategoryScope !== "any"
          ? { categoryScope: newSnippetCategoryScope }
          : {}),
      });
      setDictationSnippets((prev) => [...prev, created]);
      setNewSnippetTrigger("");
      setNewSnippetExpansion("");
      setNewSnippetAppScope("");
      setNewSnippetCaseSensitive(false);
      setNewSnippetCategoryScope("any");
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
        ...(newDictionaryCategoryScope !== "any"
          ? { categoryScope: newDictionaryCategoryScope }
          : {}),
      });
      setDictationDictionaryEntries((prev) => [...prev, created]);
      setNewDictionarySpokenForm("");
      setNewDictionaryReplacement("");
      setNewDictionaryAppScope("");
      setNewDictionaryCaseSensitive(false);
      setNewDictionaryCategoryScope("any");
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

  const handleAddCategoryOverride = () => {
    const appMatcher = newCategoryOverrideAppMatcher.trim();
    if (!appMatcher) {
      return;
    }
    const created: DictationAppCategoryOverride = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `override-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      appMatcher,
      category: newCategoryOverrideCategory,
      enabled: true,
    };
    const nextOverrides = [...dictationAppCategoryOverrides, created];
    setDictationAppCategoryOverrides(nextOverrides);
    setNewCategoryOverrideAppMatcher("");
    setNewCategoryOverrideCategory("messaging");
    void persistDictationPreferences({
      appCategoryOverrides: nextOverrides,
    });
  };

  const patchCategoryOverride = (
    overrideId: string,
    updates: Partial<Omit<DictationAppCategoryOverride, "id">>,
  ) => {
    const nextOverrides = dictationAppCategoryOverrides.map((entry) =>
      entry.id === overrideId ? { ...entry, ...updates } : entry,
    );
    setDictationAppCategoryOverrides(nextOverrides);
    void persistDictationPreferences({
      appCategoryOverrides: nextOverrides,
    });
  };

  const handleDeleteCategoryOverride = (overrideId: string) => {
    const nextOverrides = dictationAppCategoryOverrides.filter(
      (entry) => entry.id !== overrideId,
    );
    setDictationAppCategoryOverrides(nextOverrides);
    void persistDictationPreferences({
      appCategoryOverrides: nextOverrides,
    });
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
    commandKey: SelectedTextActionCommandPresetKey,
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
    commandKey: SelectedTextActionCommandPresetKey,
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

  const setCommandPresetDraft = (
    commandKey: SelectedTextActionCommandPresetKey,
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
      categoryScope: string | null;
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
      categoryScope: string | null;
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
        compareStrings(left.spokenForm, right.spokenForm),
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

  // "Process again": the sidecar re-runs the kept audio and saves a NEW
  // history entry. It inserts nothing, so the only thing to do here is
  // refresh the list and show what was saved.
  const handleProcessSelectedDictationAgain = async () => {
    if (!selectedRecording) {
      return;
    }
    setIsProcessingAgain(true);
    setProcessAgainError(null);
    try {
      const outcome = await reprocessDictation({
        historyId: selectedRecording.id,
        modeId: processAgainModeId,
      });
      setProcessAgainOutcome(outcome);
      await refetchDictationHistory();
      void refreshDictationInsights();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProcessAgainError(sanitizeUserFacingDictationMessage(message));
      setProcessAgainOutcome(null);
    } finally {
      setIsProcessingAgain(false);
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
      toast("Couldn't copy that dictation to the clipboard.", "error");
    }
  };

  const handleDeleteHistoryItem = async () => {
    if (!pendingHistoryDelete) {
      return;
    }
    const recordingId = pendingHistoryDelete.id;
    try {
      await deleteRecording(recordingId);
      setPendingHistoryDelete(null);
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
      toast("Couldn't delete that dictation — it's still in your history.", "error");
    }
  };

  /**
   * Copy exactly what the result editor shows.
   *
   * There is deliberately no "insert into the app I was in" button here. The
   * sidecar's re-insert path (`repaste_dictation_result`, bound to the
   * "Paste last result" shortcut and the tray) targets whatever is frontmost
   * when it runs — and a button inside this window can only be clicked while
   * Plainsong itself is frontmost, so it would insert into Plainsong while
   * reporting that it reached the user's target app. The shortcut works
   * because it is pressed from the target app; the copy below is what a
   * button in this window can honestly do.
   */
  const handleCopyLatestResult = async () => {
    try {
      await navigator.clipboard.writeText(transcribedText);
      setPasteStatus("Copied — paste it where you want it with Cmd+V");
    } catch (error) {
      console.warn("Failed to copy the latest dictation result:", error);
      toast("Couldn't copy that result to the clipboard.", "error");
    }
  };

  // A correction can only be taught while the editor differs from the text the
  // learner last saw. This is the baseline diff, not "edited since capture" —
  // learning resets the baseline but never changes the stored capture.
  const canLearnLatestCorrection =
    latestCorrectionBaseline.trim() !== transcribedText.trim();
  const activeProfileTitle =
    dictationModePreset === "custom" && selectedCustomMode
      ? selectedCustomMode.name
      : activeProfile.title;
  const hotkeyModeLabel = DICTATION_HOTKEY_MODE_CHIP_LABELS[hotkeyMode];
  const hotkeyInstruction = dictationInstruction(hotkeyShortcut, hotkeyMode);
  const dictationAvailable =
    dictationReadiness.state === "ready" && !dictationRouteReadiness;
  const dictationUnavailableTitle =
    dictationReadiness.state === "unknown"
      ? "Checking setup"
      : dictationRouteReadiness?.status === "downloading"
        ? "Model downloading"
        : dictationRouteReadiness?.status === "missing"
          ? "Dictation has no model yet"
        : "Setup needed";
  const dictationUnavailableDetail = dictationRouteReadiness
    ? dictationRouteReadiness.status === "downloading"
      ? `${dictationRouteReadiness.routeLabel} is still downloading. Use Re-check model when the transfer finishes.`
      : routeDownloadError
        ? `Download failed: ${routeDownloadError}`
        : `${dictationRouteReadiness.routeLabel} is not on this Mac. Download it before capture can start.`
    : dictationReadiness.cause?.message ??
      "Plainsong could not confirm that dictation is ready.";
  const dictationUnavailableActionLabel = dictationRouteReadiness
    ? dictationRouteReadiness.status === "missing"
      ? routeDownloadBusy
        ? "Downloading…"
        : `Download ${dictationRouteReadiness.providerLabel}`
      : "Re-check model"
    : dictationReadiness.cause?.action.label ?? "Re-check setup";
  const handleDictationUnavailableAction = () => {
    if (dictationRouteReadiness?.status === "missing") {
      void handleDownloadDictationRouteModel();
      return;
    }
    if (dictationRouteReadiness?.status === "downloading") {
      void refreshDictationRouteReadiness();
      return;
    }
    if (dictationReadiness.cause) {
      requestReadinessDestination(
        dictationReadiness.cause.action.destination,
      );
      return;
    }
    void refreshProductReadiness();
  };

  return (
    <div className="h-full flex flex-col">
      {/* The eyebrow names the area, never the page: WORKSPACE over Home,
          LIBRARY over Projects, SHARE over Exports. DICTATION over Dictation
          was the same word twice in two registers, spending the page's one
          rust rubric to repeat its own title. */}
      <PageHeader
        eyebrow="CAPTURE"
        title="Dictation"
        subtitle="Fast voice capture that inserts text where you work"
        actions={
          <div
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 transition-all",
              hotkeyPressed
                ? "border-gold/40 bg-gold/10 text-gold-text scale-105"
                : "border-border bg-muted",
            )}
          >
            <Keyboard className="h-4 w-4" aria-hidden="true" />
            <span className="font-mono text-sm font-medium">{hotkeyLabel}</span>
            <span className="text-sm text-muted-foreground">
              {hotkeyModeLabel}
            </span>
          </div>
        }
      />

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-4xl mx-auto space-y-6">
          {/* Engine loss, said in plain words on the surface the reader is
              actually on. It used to appear only as the bridge's own log line
              on the buried Setup view. */}
          {engineNotice ? (
            <StatusBanner
              tone={engineNotice.recovering ? "muted" : "rust"}
              role={engineNotice.recovering ? "status" : "alert"}
              title={engineNotice.title}
              message={engineNotice.message}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissEngineNotice?.()}
                >
                  Dismiss
                </Button>
              }
            />
          ) : null}

          <DictationCaptureHero
            phase={dictationPhase}
            phaseTitle={dictationPhaseSummary.title}
            phaseDetail={dictationPhaseSummary.detail}
            phaseTone={dictationPhaseSummary.tone}
            isCaptureLive={isDictationCaptureLive}
            isBusy={isDictationBusy}
            isAvailable={dictationAvailable}
            unavailableTitle={dictationUnavailableTitle}
            unavailableDetail={dictationUnavailableDetail}
            unavailableActionLabel={dictationUnavailableActionLabel}
            unavailableActionBusy={routeDownloadBusy}
            unavailableRole={
              dictationReadiness.state === "unknown" ? "status" : "alert"
            }
            formattedDuration={formattedDuration}
            hotkeyInstruction={hotkeyInstruction}
            hotkeyPressed={hotkeyPressed}
            livePreview={dictationPhasePreview}
            activeProfileTitle={activeProfileTitle}
            resolvedModeLabel={dictationResolvedModeLabel}
            smartContextSummary={smartContextSummary}
            isReadingSelectedText={activeSpeechTarget === "selected-text"}
            onStart={launchDictation}
            onStop={handleStopDictation}
            onReadSelectedText={() => void handleReadSelectedText()}
            onUnavailableAction={handleDictationUnavailableAction}
          />

          {transcribedText && (
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="section-heading">Latest result</h2>
                    <p className="text-sm text-muted-foreground">
                      The text Plainsong set down from your last capture.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleCopyLatestResult()}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy again
                    </Button>
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
                      <Volume2 className="mr-2 h-4 w-4" />
                      {activeSpeechTarget === "latest-result"
                        ? "Stop reading"
                        : "Read aloud"}
                    </Button>
                  </div>
                </div>
                <textarea
                  aria-label="Latest dictation result"
                  className="manuscript min-h-[120px] w-full resize-y rounded-md bg-muted p-4 text-sm outline-none"
                  value={transcribedText}
                  onChange={(event) => {
                    setTranscribedText(event.target.value);
                    setLatestResultDirty(true);
                  }}
                  onBlur={() => {
                    void maybeAutoLearnLatestCorrection();
                  }}
                />
                <p className="text-sm text-muted-foreground">
                  {repasteShortcutLabel
                    ? `To put this into another app, switch to that app and press ${repasteShortcutLabel}.`
                    : 'To put this into another app, set a "Paste last result" shortcut in Settings and press it from that app.'}{" "}
                  A button here can only reach Plainsong, because Plainsong is
                  the frontmost app while you are clicking in this window.
                </p>
                {latestResultDirty ? (
                  <p className="text-sm text-muted-foreground">
                    You changed this after capture.{" "}
                    {repasteShortcutLabel ?? 'The "Paste last result" shortcut'}{" "}
                    still delivers the words Plainsong captured, not your edit —
                    use Copy again for the text you see here. Learn correction
                    teaches Plainsong the fix for next time.
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canLearnLatestCorrection}
                    onClick={() =>
                      void learnCorrection(
                        latestCorrectionBaseline,
                        transcribedText,
                        {
                          force: true,
                          appTarget,
                          setStatus: setLatestLearnStatus,
                          onSuccess: () =>
                            setLatestCorrectionBaseline(transcribedText.trim()),
                        },
                      )
                    }
                  >
                    Learn correction
                  </Button>
                  {isCaseOnlyDifference(
                    latestCorrectionBaseline,
                    transcribedText,
                  ) && (
                    <Button
                      variant="outline"
                      size="sm"
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
                      Fix capitalization
                    </Button>
                  )}
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
                        "Loaded the current result into the Dictionary tab.",
                      );
                      setActiveConfigTab("dictionary");
                    }}
                  >
                    Quick add to dictionary
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Edit a mistaken word here and Plainsong can remember it for
                    next time.
                  </p>
                </div>
                {latestLearnStatus && (
                  <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                    {latestLearnStatus}
                  </p>
                )}
                {lastDictationStatus && (
                  <div
                    className={cn(
                      "rounded-md border p-3 text-sm",
                      lastDictationStatus.tone === "ready"
                        ? "border-gold/40 bg-gold/10 text-gold-text"
                        : "border-rust/40 bg-rust/10 text-rust",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "neume mt-1.5 flex-none",
                          lastDictationStatus.tone === "ready"
                            ? "neume-lit"
                            : "neume-rust",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {lastDictationStatus.title}
                        </p>
                        <p className="mt-1 text-current/85">
                          {lastDictationStatus.detail}
                        </p>
                        <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                          {lastDictationStatus.items.map((item) => (
                            <div
                              key={`${item.label}-${item.value}`}
                              className="min-w-0 text-current"
                            >
                              <span className="sr-only">
                                {item.label}: {item.value}
                              </span>
                              <p className="rubric-muted text-current/70">
                                {item.label}
                              </p>
                              <p className="mt-0.5 truncate font-medium">
                                {item.value}
                              </p>
                            </div>
                          ))}
                        </div>
                        {lastDictationStatus.nextAction ? (
                          <p className="mt-3 border-t border-current/15 pt-3 text-current/90">
                            Next: {lastDictationStatus.nextAction}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <section className="surface-panel-subtle rounded-md p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-xl">
                <h2 className="section-heading">The main path</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Trigger, speak, insert, then repair only when the target app
                  needs it.
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
                      className="flex gap-3 rounded-md border border-border/70 bg-background/55 p-3"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/45 text-muted-foreground">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-card-foreground">
                          {item.label}
                        </p>
                        <p className="mt-1 text-sm leading-5 text-muted-foreground">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {activeCoachCards.length > 0 && (
            <section className="space-y-3">
              <div>
                <h2 className="section-heading">Dictation coach</h2>
                <p className="text-sm text-muted-foreground">
                  A few habits that make dictating faster than typing.
                </p>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {activeCoachCards.map((card) => (
                  <div
                    key={card.id}
                    className="space-y-3 rounded-md border bg-muted/20 p-4"
                  >
                    <div>
                      <p className="text-sm font-medium">{card.title}</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {card.body}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {card.id === "command_mode" ? (
                        <Button
                          size="sm"
                          variant="outline"
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
                          variant="outline"
                          onClick={() => {
                            const style = RECOMMENDED_APP_STYLES.find(
                              (candidate) =>
                                candidate.id === CODING_PROFILE_STYLE_ID,
                            );
                            if (style) {
                              void handleInstallRecommendedStyle(style);
                            }
                            dismissCoachCard(card.id);
                          }}
                        >
                          Install a profile
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dismissCoachCard(card.id)}
                        >
                          {card.actionLabel}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dismissCoachCard(card.id)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="section-heading">Recent dictations</h2>
                <p className="text-sm text-muted-foreground">
                  Saved captures, kept for as long as your auto-delete setting
                  allows.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void refetchDictationHistory();
                  void refreshDictationInsights();
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </div>
            {dictationInsights ? (
              <div className="flex flex-wrap gap-x-6 gap-y-3 border-y border-border/60 py-3">
                {[
                  {
                    label: "Total dictations",
                    value: String(dictationInsights.totalDictations),
                  },
                  {
                    label: "Words dictated",
                    value: String(dictationInsights.dictatedWords),
                  },
                  {
                    label: "Average words",
                    value: String(dictationInsights.averageWordsPerDictation),
                  },
                  {
                    label: "Active days",
                    value: String(dictationInsights.activeDays),
                  },
                  {
                    label: "Last 7 days",
                    value: String(dictationInsights.lastSevenDaysDictations),
                  },
                  {
                    label: "Commands used",
                    value: String(dictationInsights.commandsUsed),
                  },
                  {
                    label: "Backtracks",
                    value: String(dictationInsights.backtracksUsed),
                  },
                  {
                    label: "Phrases expanded",
                    value: String(dictationInsights.snippetsTriggered),
                  },
                  {
                    label: "Top app",
                    value: dictationInsights.topAppTarget
                      ? `${dictationInsights.topAppTarget} (${dictationInsights.topAppTargetCount})`
                      : "None yet",
                  },
                ].map((stat) => (
                  <div key={stat.label}>
                    <p className="rubric-muted">{stat.label}</p>
                    <p className="mt-0.5 text-sm font-medium">{stat.value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No saved dictation stats yet. Stats start filling in once
                dictations are retained in history.
              </p>
            )}
            <div className="space-y-2">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search saved dictations"
                  className="bg-muted/30 pl-9"
                  placeholder="Search saved dictations…"
                  value={historySearchQuery}
                  onChange={(event) =>
                    setHistorySearchQuery(event.target.value)
                  }
                  onKeyDown={(event) => {
                    // Down from the field lands on the first hit; Escape
                    // clears the query and puts the whole list back.
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusHistoryResult(0);
                    } else if (event.key === "Escape") {
                      setHistorySearchQuery("");
                    }
                  }}
                />
              </div>
              {trimmedHistorySearchQuery && (
                <p className="text-sm text-muted-foreground">
                  Searches what was delivered and, where it was kept, what the
                  recognizer heard.
                </p>
              )}
            </div>
            {trimmedHistorySearchQuery ? (
              historySearchError ? (
                <div className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  Search failed: {historySearchError}
                </div>
              ) : historySearchResults === null || historySearchPending ? (
                <p className="text-sm text-muted-foreground">Searching…</p>
              ) : historySearchResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved dictation matches &ldquo;
                  {trimmedHistorySearchQuery}&rdquo;. Only dictations still in
                  history can be searched — auto-delete removes the rest.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {historySearchResults.length === 1
                      ? "1 match"
                      : `${historySearchResults.length} matches`}
                  </p>
                  {historySearchResults.map((hit, index) => (
                    <button
                      key={hit.recordingId}
                      type="button"
                      ref={(element) => {
                        historyResultRefs.current[index] = element;
                      }}
                      aria-label={`Open saved dictation: ${hit.recordingTitle}`}
                      className="w-full rounded-md border p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onClick={() => openHistoryEntryById(hit.recordingId)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          focusHistoryResult(index + 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          focusHistoryResult(index - 1);
                        }
                      }}
                    >
                      <p className="font-medium">{hit.recordingTitle}</p>
                      <p className="text-sm">
                        {splitHistorySnippet(hit.snippet).map((run, runIndex) =>
                          run.matched ? (
                            <mark
                              key={runIndex}
                              className="rounded-sm bg-gold/25 text-foreground"
                            >
                              {run.text}
                            </mark>
                          ) : (
                            <span key={runIndex}>{run.text}</span>
                          ),
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {formatDateTime(hit.createdAt)} ·{" "}
                        {hit.matchedField === "raw"
                          ? "Matched what Plainsong heard"
                          : "Matched the delivered text"}
                      </p>
                    </button>
                  ))}
                </div>
              )
            ) : dictationHistoryLoading ? (
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
                    className="flex items-center justify-between gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      aria-label={`Open saved dictation: ${recording.title}`}
                      className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onClick={() => {
                        setSelectedRecording(recording);
                        setIsDialogOpen(true);
                      }}
                    >
                      <p className="font-medium">{recording.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDateTime(recording.createdAt)} ·{" "}
                        {recording.status}
                      </p>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <p className="time-spec text-sm text-muted-foreground">
                        {formatRecordingDuration(recording.duration)}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Copy ${recording.title}`}
                        onClick={() => void handleCopyHistoryTranscript(recording.id)}
                      >
                        Copy
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${recording.title}`}
                        onClick={() => setPendingHistoryDelete(recording)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4 border-t border-border/60 pt-6">
            <div>
              <h2 className="section-heading">Set up dictation</h2>
              <p className="text-sm text-muted-foreground">
                Profiles, vocabulary, and delivery settings. Capture above keeps
                working while you tune these.
              </p>
            </div>
            <Tabs
              value={activeConfigTab}
              onValueChange={(value) =>
                setActiveConfigTab(value as DictationConfigTab)
              }
            >
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
                {DICTATION_CONFIG_TABS.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="profiles" className="mt-4 space-y-6">
                <div className="space-y-3">
                  <div>
                    <h3 className="section-heading">Pick a profile</h3>
                    <p className="text-sm text-muted-foreground">
                      One profile is active at a time. It sets the style,
                      insertion, context, and history behavior for every
                      capture — including hotkey dictation.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {DICTATION_PROFILE_TILES.map((tile) => {
                      const Icon = PROFILE_TILE_ICONS[tile.iconKey];
                      const isActive = activeProfile.id === tile.id;
                      return (
                        <button
                          key={tile.id}
                          type="button"
                          aria-pressed={isActive}
                          aria-label={`Profile: ${tile.title}`}
                          onClick={() => {
                            if (tile.kind === "style") {
                              const style = RECOMMENDED_APP_STYLES.find(
                                (candidate) => candidate.id === tile.styleId,
                              );
                              if (style) {
                                void handleInstallRecommendedStyle(style);
                              }
                              return;
                            }
                            applyDictationMode(tile.modeId);
                          }}
                          className={cn(
                            "rounded-md border p-4 text-left transition-colors",
                            isActive
                              ? "border-rust/40 bg-rust/8 shadow-sm"
                              : "border-border bg-background hover:border-rust/40 hover:bg-muted/40",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "h-4 w-4",
                                isActive
                                  ? "text-rust"
                                  : "text-muted-foreground",
                              )}
                            />
                            {isActive ? (
                              <span className="rounded-full bg-rust px-2 py-0.5 text-sm font-semibold text-destructive-foreground">
                                Active
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-3 font-medium">{tile.title}</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {tile.description}
                          </p>
                          <p className="mt-3 text-sm text-muted-foreground">
                            {tile.emphasis}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    {dictationModePreset === "custom"
                      ? selectedCustomMode
                        ? `${selectedCustomMode.name} is active. Update it when you want the current controls to become the new default profile.`
                        : "Unsaved custom setup is active. Save it as a profile when it feels right."
                      : `${DICTATION_MODE_DEFINITION_BY_ID[dictationModePreset]?.label ?? "General"} profile is active. The controls in these tabs stay editable if you want to fine-tune them.`}
                  </p>
                </div>

                <div className="space-y-3 border-t pt-4">
                  <div>
                    <h3 className="section-heading">What this profile changes</h3>
                    <p className="text-sm text-muted-foreground">
                      Everything the active profile decides for you: how text is
                      inserted, what context it reads, what it saves, and which
                      transcription and AI engines it uses.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeModeSummary.map((item) => (
                      <span
                        key={item.label}
                        className="rounded-full border bg-background px-2.5 py-1 text-sm text-muted-foreground"
                      >
                        <span className="font-medium text-foreground">
                          {item.label}:
                        </span>{" "}
                        {item.value}
                      </span>
                    ))}
                  </div>

                  {/* Copying to the clipboard changes something outside
                      Plainsong and cannot be undone, so it is asked for
                      plainly here instead of riding along with a profile. */}
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-background/75 p-4">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium" id="dictation-clipboard-label">
                        Also copy every dictation to the clipboard
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Off by default. Turning it on replaces whatever is on
                        your clipboard each time you dictate — Plainsong does
                        not put the previous contents back.
                      </p>
                    </div>
                    <Switch
                      aria-labelledby="dictation-clipboard-label"
                      checked={dictationCopyToClipboard}
                      onCheckedChange={(checked) => {
                        setDictationCopyToClipboard(checked);
                        void persistDictationPreferences({
                          copyToClipboard: checked,
                        });
                      }}
                    />
                  </div>
                </div>

                <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="section-heading">Where transcription runs</h3>
                    <p className="text-sm text-muted-foreground">
                      What this profile prefers for every capture, hotkey
                      included. If your preference isn't ready, Plainsong uses
                      whichever engine is.
                    </p>
                    <div className="flex gap-2">
                      {(["local", "cloud"] as const).map((route) => (
                        <Button
                          key={route}
                          type="button"
                          size="sm"
                          variant={
                            dictationRoutePreference === route
                              ? "active"
                              : "outline"
                          }
                          onClick={() => {
                            setDictationRoutePreference(route);
                            void persistDictationPreferences({
                              routePreference: route,
                            });
                          }}
                        >
                          {route === "local" ? "On this Mac" : "In the cloud"}
                        </Button>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      The engine chosen in Settings runs{" "}
                      {currentDictationProvider
                        ? providerHostingPreference(
                            currentDictationProvider as AsrProviderType,
                          ) === "cloud"
                          ? "in the cloud."
                          : "on this Mac."
                        : "somewhere not yet known."}
                    </p>
                    {currentDictationProvider &&
                    describeCloudDictationVocabularyNote(currentDictationProvider) ? (
                      <p className="text-sm text-muted-foreground">
                        {describeCloudDictationVocabularyNote(currentDictationProvider)}
                      </p>
                    ) : null}
                    {!useSharedAsrSelection &&
                    currentDictationProvider &&
                    currentMeetingProvider &&
                    currentDictationProvider !== currentMeetingProvider ? (
                      <p className="text-sm text-rust">
                        Dictation uses {currentDictationProvider} while meetings
                        use {currentMeetingProvider}.
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <h3 className="section-heading">Override the next capture</h3>
                    <p className="text-sm text-muted-foreground">
                      Send one capture the other way without changing the
                      profile. Only the Start dictation button uses this; the
                      hotkey always follows the profile.
                    </p>
                    <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
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
                      Show the one-off choice
                    </label>
                    {dictationRouteOverrideEnabled ? (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            nextCaptureRoutePreference === null
                              ? "active"
                              : "outline"
                          }
                          onClick={() => setNextCaptureRoutePreference(null)}
                        >
                          Profile default
                        </Button>
                        {(["local", "cloud"] as const).map((route) => (
                          <Button
                            key={`next-${route}`}
                            type="button"
                            size="sm"
                            variant={
                              nextCaptureRoutePreference === route
                                ? "active"
                                : "outline"
                            }
                            onClick={() => setNextCaptureRoutePreference(route)}
                          >
                            {route === "local" ? "This Mac" : "The cloud"}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Every capture follows the profile until you turn this
                        on.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-3 border-t pt-4">
                  <div>
                    <h3 className="section-heading">Recommended flow profiles</h3>
                    <p className="text-sm text-muted-foreground">
                      Ready-made setups for common kinds of writing. Installing
                      one selects it and saves a copy under Your saved profiles,
                      where you can edit it.
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
                          className="rounded-md border border-border bg-muted/20 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{style.name}</p>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {style.description}
                              </p>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {style.activationDomainMatcher
                                  ? `Tagged on ${style.activationDomainMatcher}`
                                  : style.activationAppMatcher
                                    ? `Tagged in ${style.activationAppMatcher}`
                                    : "No app rule"}
                                {" · "}
                                {CONTEXT_SOURCE_LABELS[style.contextSource]}
                                {" · "}
                                {INSERTION_MODE_LABELS[style.insertionMode]}
                              </p>
                            </div>
                            {installedMode && (
                              <span className="rounded-full border bg-background px-2 py-0.5 text-sm font-medium text-muted-foreground">
                                Installed
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              variant="outline"
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
                      <h3 className="section-heading">Your saved profiles</h3>
                      <p className="text-sm text-muted-foreground">
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
                              "rounded-md border p-4",
                              isActive
                                ? "border-rust/40 bg-rust/8 shadow-sm"
                                : "border-border bg-muted/20",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-medium">{mode.name}</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {mode.description || "No description"}
                                </p>
                                <p className="mt-2 text-sm text-muted-foreground">
                                  {mode.dictationProvider ||
                                    "Current transcription"}{" "}
                                  · {mode.dictationModelId || "Current model"}
                                  {mode.activationAppMatcher
                                    ? ` · Tagged in ${mode.activationAppMatcher}`
                                    : ""}
                                  {mode.activationDomainMatcher
                                    ? ` · Tagged on ${mode.activationDomainMatcher}`
                                    : ""}
                                  {!mode.activationAppMatcher &&
                                  !mode.activationDomainMatcher
                                    ? " · No app rule"
                                    : ""}
                                </p>
                              </div>
                              {isActive && (
                                <span className="rounded-full bg-rust px-2 py-0.5 text-sm font-semibold text-destructive-foreground">
                                  Active
                                </span>
                              )}
                            </div>
                            <div className="mt-3 flex gap-2">
                              <Button
                                variant={isActive ? "active" : "outline"}
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
                                  className="rounded-full border bg-background px-2.5 py-1 text-sm text-muted-foreground"
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

                {dictationModePreset === "custom" && (
                  <div className="space-y-3 border-t pt-4">
                    <div>
                      <h3 className="section-heading">Custom profile</h3>
                      <p className="text-sm text-muted-foreground">
                        Saving records everything set right now: the style, what
                        happens to the result, what context is read, the
                        transcription and AI engines, and any app or website
                        rules below.
                      </p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor="custom-profile-name"
                        >
                          Profile name
                        </label>
                        <input
                          id="custom-profile-name"
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
                          placeholder="Slack replies"
                        />
                      </div>
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor="custom-profile-description"
                        >
                          Short description
                        </label>
                        <input
                          id="custom-profile-description"
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
                          placeholder="What this profile is for"
                        />
                      </div>
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor="custom-profile-base"
                        >
                          Base style
                        </label>
                        <select
                          id="custom-profile-base"
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
                        <p className="text-sm text-muted-foreground">
                          The formatting this profile starts from, before its
                          own style prompt runs.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor="custom-profile-numbers"
                        >
                          {DICTATION_NUMBERS_SECTION_HEADING}
                        </label>
                        <select
                          id="custom-profile-numbers"
                          aria-label="Numbers as digits"
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={customModeDraft.numbersAsDigits}
                          onChange={(event) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              numbersAsDigits: event.target
                                .value as CustomModeNumbersChoice,
                            }))
                          }
                        >
                          {(
                            Object.keys(
                              CUSTOM_MODE_NUMBERS_CHOICE_LABELS,
                            ) as CustomModeNumbersChoice[]
                          ).map((choice) => (
                            <option key={choice} value={choice}>
                              {CUSTOM_MODE_NUMBERS_CHOICE_LABELS[choice]}
                            </option>
                          ))}
                        </select>
                        <p className="text-sm text-muted-foreground">
                          {customModeDraft.numbersAsDigits === "inherit"
                            ? numbersAsDigitsModeHint(
                                customModeDraft.baseModePreset,
                              )
                            : DICTATION_NUMBERS_SECTION_DESCRIPTION}{" "}
                          {resolveCustomModeNumbersAsDigits(
                            customModeNumbersValue(
                              customModeDraft.numbersAsDigits,
                            ),
                            customModeDraft.baseModePreset,
                            dictationNumbersAsDigits,
                          )
                            ? "Right now this profile writes numbers as digits."
                            : "Right now this profile keeps numbers as spoken."}
                        </p>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label
                          className="text-sm font-medium"
                          htmlFor="custom-profile-prompt"
                        >
                          Style prompt
                        </label>
                        <textarea
                          id="custom-profile-prompt"
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
                        <p className="text-sm text-muted-foreground">
                          Optional. Overrides the global Smart Format prompt
                          only when this profile is active.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3 border-t pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="section-heading">App rules</h4>
                          <p className="text-sm text-muted-foreground">
                            While this profile is selected, these rules tag each
                            capture with the app you are writing in. They do not
                            select the profile for you.
                          </p>
                        </div>
                        <span className="rounded-full border bg-background px-2 py-1 text-sm font-medium text-muted-foreground">
                          {customModeDraft.activationAppMatcher.trim() ||
                          customModeDraft.activationDomainMatcher.trim()
                            ? "Rule set"
                            : "No rule"}
                        </span>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <label
                            className="text-sm font-medium"
                            htmlFor="custom-profile-app-matcher"
                          >
                            App this profile is for
                          </label>
                          <input
                            id="custom-profile-app-matcher"
                            type="text"
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
                          <p className="text-sm text-muted-foreground">
                            Optional. When the name of the app you are writing
                            in contains this, Plainsong sorts the capture into
                            that app's destination category, so formatting
                            matches where the text is going.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {ACTIVATION_APP_SUGGESTIONS.map((suggestion) => (
                              <button
                                key={suggestion}
                                type="button"
                                className="rounded-full border bg-background px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted"
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
                          <label
                            className="text-sm font-medium"
                            htmlFor="custom-profile-domain-matcher"
                          >
                            Website this profile is for
                          </label>
                          <input
                            id="custom-profile-domain-matcher"
                            type="text"
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
                          <p className="text-sm text-muted-foreground">
                            Optional. Same idea, matched against the address of
                            the browser tab you are writing in.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {ACTIVATION_DOMAIN_SUGGESTIONS.map((suggestion) => (
                              <button
                                key={suggestion}
                                type="button"
                                className="rounded-full border bg-background px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted"
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
                      <p className="rounded-md border bg-background/80 px-3 py-2 text-sm text-muted-foreground">
                        {describeActivationRules(
                          customModeDraft.activationAppMatcher,
                          customModeDraft.activationDomainMatcher,
                        )}{" "}
                        Domain rules are checked first.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <label
                            className="text-sm font-medium"
                            htmlFor="custom-profile-language"
                          >
                            Language override
                          </label>
                          <input
                            id="custom-profile-language"
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
                          <p className="text-sm text-muted-foreground">
                            Optional. Save a language tag like{" "}
                            <span className="font-mono">en</span> or{" "}
                            <span className="font-mono">es</span> with this
                            profile.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Live preview</p>
                          <label className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              checked={
                                currentDictationProvider === "macos_apple_speech"
                                  ? false
                                  : customModeDraft.livePreviewEnabled
                              }
                              disabled={
                                currentDictationProvider === "macos_apple_speech"
                              }
                              onChange={(event) =>
                                setCustomModeDraft((current) => ({
                                  ...current,
                                  livePreviewEnabled: event.target.checked,
                                }))
                              }
                            />
                            Show words in the popup as you speak
                          </label>
                          <p className="text-sm text-muted-foreground">
                            {currentDictationProvider === "macos_apple_speech"
                              ? "Unavailable with Apple Speech, which waits for the final on-device result."
                              : "Turn this off when watching partial text is distracting."}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Translate to English</p>
                          <label className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              aria-label="Translate to English"
                              checked={
                                profileTranslateAvailability.enabled &&
                                customModeDraft.translateToEnglish
                              }
                              disabled={!profileTranslateAvailability.enabled}
                              onChange={(event) =>
                                setCustomModeDraft((current) => ({
                                  ...current,
                                  translateToEnglish: event.target.checked,
                                }))
                              }
                            />
                            Deliver English whatever language you speak
                          </label>
                          <p className="text-sm text-muted-foreground">
                            {profileTranslateAvailability.description}
                          </p>
                        </div>
                      </div>
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

                <div className="grid gap-4 border-t pt-4 xl:grid-cols-2">
                  <div className="space-y-3">
                    <div>
                      <h3 className="section-heading">Developer dictation</h3>
                      <p className="text-sm text-muted-foreground">
                        Settings that suit Cursor, terminals, commit messages,
                        markdown, and prompt writing.
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-sm font-medium">
                        {currentDictationProvider && currentDictationModelId
                          ? `${currentDictationProvider} · ${currentDictationModelId}`
                          : "Use a fast engine on this Mac, with live preview"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Code goes best with a fast engine on this Mac, selected
                        text as context, and voice commands left on. Say “open
                        paren”, “close brace”, “snake case”, “camel case”, file
                        names, and terminal commands. Start a phrase with{" "}
                        <code>{dictationCommandPrefix}</code> to rewrite,
                        bulletize, or clean up whatever you have selected.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                        {[
                          "commit messages",
                          "PR summaries",
                          "terminal commands",
                          "issue updates",
                          "Cursor prompts",
                        ].map((label) => (
                          <span
                            key={label}
                            className="rounded-full border px-2 py-1"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const style = RECOMMENDED_APP_STYLES.find(
                            (candidate) =>
                              candidate.id === CODING_PROFILE_STYLE_ID,
                          );
                          if (style) {
                            void handleInstallRecommendedStyle(style);
                          }
                        }}
                      >
                        Use Coding profile
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
                  </div>

                  <div className="space-y-3">
                    <div>
                      <h3 className="section-heading">Quiet dictation</h3>
                      <p className="text-sm text-muted-foreground">
                        Settings that suit speaking softly, in shared rooms, or
                        late at night.
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-sm font-medium">
                        Silence auto-stop{" "}
                        {formatTimeoutSeconds(dictationSilenceTimeoutSeconds)} ·
                        Keep warm {dictationKeepWarm}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Whispering gets cut off less with the model already
                        loaded and a slightly longer silence window. Keep
                        transcription on this Mac so quiet speech doesn't wait
                        on the network, and turn live preview off for a calmer
                        screen.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                        {[
                          "late-night writing",
                          "shared spaces",
                          "focus sessions",
                          "private drafting",
                        ].map((label) => (
                          <span
                            key={label}
                            className="rounded-full border px-2 py-1"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const style = RECOMMENDED_APP_STYLES.find(
                            (candidate) =>
                              candidate.id === QUIET_PROFILE_STYLE_ID,
                          );
                          if (style) {
                            void handleInstallRecommendedStyle(style);
                          }
                        }}
                      >
                        Use Quiet profile
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setDictationRoutePreference("local");
                          setDictationKeepWarm("on");
                          setDictationSilenceTimeoutSeconds(1.8);
                          const nextModePreset = syncModePreset({});
                          void persistDictationPreferences({
                            routePreference: "local",
                            keepWarm: "on",
                            silenceTimeoutSeconds: 1.8,
                            modePreset: nextModePreset,
                          });
                        }}
                      >
                        Apply whisper-friendly defaults
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="capture" className="mt-4 space-y-4">
                <div>
                  <h3 className="section-heading">Capture and insert</h3>
                  <p className="text-sm text-muted-foreground">
                    Profiles handle the recommended defaults. These controls are
                    here when you want to tune the details.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Hotkey behavior</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Currently {hotkeyModeLabel}. The shortcut and how it
                      behaves are both set in Settings, so they stay in one
                      place.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => requestMainView("settings")}
                  >
                    <Keyboard className="mr-2 h-4 w-4" />
                    Change in Settings
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-style"
                    >
                      Dictation style
                    </label>
                    <select
                      id="dictation-style"
                      className="w-full rounded-md border bg-background p-2 text-sm"
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
                    <p className="text-sm text-muted-foreground">
                      Uses the transcription method you chose in Settings.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-project"
                    >
                      Default Project
                    </label>
                    <select
                      id="dictation-project"
                      className="w-full rounded-md border bg-background p-2 text-sm"
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
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-session-language"
                    >
                      Session language
                    </label>
                    {dictationLanguageBoundary.kind === "english_only" ? (
                      <>
                        {/* One option in a picker is not a choice, and a
                            lonely "English" explains nothing. Say why. */}
                        <p className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                          {currentDictationModelId
                            ? `${currentDictationModelId} transcribes English only.`
                            : "The selected model transcribes English only."}{" "}
                          Speak anything else into it and it returns
                          English-sounding words rather than admitting it
                          cannot. Choose a multilingual model in Settings to
                          dictate in another language.
                        </p>
                        <input
                          type="hidden"
                          id="dictation-session-language"
                          value="en"
                          readOnly
                        />
                      </>
                    ) : dictationLanguageBoundary.kind === "unenumerated" ? (
                      <p className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                        Plainsong has no confirmed language list for this
                        model ({dictationLanguageBoundary.label}), so every
                        capture is left on auto detect.
                      </p>
                    ) : (
                      <>
                        <SearchableSelect
                          id="dictation-session-language"
                          ariaLabel="Session language"
                          value={dictationSessionLanguage}
                          options={dictationSessionLanguageOptions}
                          searchPlaceholder="Search languages"
                          emptyText={`This model does not transcribe that language. It covers ${dictationLanguageBoundary.label}.`}
                          onChange={(next) => {
                            setDictationSessionLanguage(next);
                            void persistDictationPreferences({
                              sessionLanguage: next === "auto" ? null : next,
                            });
                          }}
                        />
                        <p className="text-sm text-muted-foreground">
                          Auto detect is the default. Picking a language here
                          settles it; otherwise the list below narrows the
                          guess. This model covers{" "}
                          {dictationLanguageBoundary.label}.
                        </p>
                        <div className="rounded-md border bg-muted/20 px-3 py-3">
                          <p className="text-sm font-medium text-foreground">
                            Languages you actually speak
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Used only while Session language is on auto detect.
                          </p>
                          <div className="mt-3 space-y-2">
                            <SearchableSelect
                              ariaLabel="Add a language you speak"
                              value=""
                              options={dictationLanguageChoices.filter(
                                (option) =>
                                  !dictationActiveLanguages.includes(
                                    option.value,
                                  ),
                              )}
                              searchPlaceholder="Search languages"
                              emptyText="Every language this model covers is already listed."
                              onChange={(next) => {
                                const normalized = normalizeActiveLanguageSet(
                                  [...dictationActiveLanguages, next],
                                  dictationLanguageCodes,
                                );
                                setDictationActiveLanguages(normalized);
                                void persistDictationPreferences({
                                  activeLanguages: normalized,
                                });
                              }}
                            />
                            {dictationActiveLanguages.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {dictationActiveLanguages.map((language) => (
                                  <button
                                    key={language}
                                    type="button"
                                    aria-label={`Remove ${asrLanguageName(language)} from the languages you speak`}
                                    className="rounded-full border border-foreground bg-foreground px-3 py-1 text-sm text-background transition-colors"
                                    onClick={() => {
                                      const normalized =
                                        normalizeActiveLanguageSet(
                                          dictationActiveLanguages.filter(
                                            (value) => value !== language,
                                          ),
                                          dictationLanguageCodes,
                                        );
                                      setDictationActiveLanguages(normalized);
                                      void persistDictationPreferences({
                                        activeLanguages: normalized,
                                      });
                                    }}
                                  >
                                    {asrLanguageName(language)} ×
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <p className="mt-3 text-sm text-muted-foreground">
                            {dictationActiveLanguages.length === 0
                              ? "Nothing picked, so auto detect considers every language this model covers."
                              : dictationActiveLanguages.length === 1
                                ? `Every capture will be treated as ${asrLanguageName(dictationActiveLanguages[0])} until you add another language.`
                                : `Auto detect chooses between: ${dictationActiveLanguages
                                    .map(asrLanguageName)
                                    .join(", ")}.`}
                          </p>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-live-preview"
                    >
                      Live preview
                    </label>
                    <select
                      id="dictation-live-preview"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={
                        currentDictationProvider === "macos_apple_speech"
                          ? "off"
                          : dictationLivePreviewEnabled
                            ? "on"
                            : "off"
                      }
                      disabled={currentDictationProvider === "macos_apple_speech"}
                      onChange={(event) => {
                        const next = event.target.value === "on";
                        setDictationLivePreviewEnabled(next);
                        void persistDictationPreferences({
                          livePreviewEnabled: next,
                        });
                      }}
                    >
                      <option value="on">Show words as you speak</option>
                      <option value="off">Wait for the finished text</option>
                    </select>
                    <p className="text-sm text-muted-foreground">
                      {currentDictationProvider === "macos_apple_speech"
                        ? "Unavailable with Apple Speech: Plainsong waits for the final on-device result rather than restarting transcription over and over while you speak."
                        : "Rough text appears in the popup while you talk, then is replaced by the finished version."}
                    </p>
                  </div>

                  {dictationLivePreviewEnabled &&
                  currentDictationProvider !== "macos_apple_speech" &&
                  livePreviewEngineStatus?.supported ? (
                    <div className="space-y-2">
                      <label
                        className="text-sm font-medium"
                        htmlFor="dictation-live-preview-engine"
                      >
                        What draws the live preview
                      </label>
                      <select
                        id="dictation-live-preview-engine"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={dictationLivePreviewEngine}
                        onChange={(event) => {
                          const next = event.target.value as
                            | "auto"
                            | "redecode"
                            | "streaming";
                          setDictationLivePreviewEngine(next);
                          void persistDictationPreferences({
                            livePreviewEngine: next,
                          });
                        }}
                      >
                        <option value="auto">
                          Whichever is available (recommended)
                        </option>
                        <option value="streaming">
                          Streaming engine when it can
                        </option>
                        <option value="redecode">
                          Re-transcribe as you speak
                        </option>
                      </select>
                      <p className="text-sm text-muted-foreground">
                        {livePreviewEngineStatus.ready
                          ? "The streaming engine is installed, so the preview keeps what it has already heard and the words land while you are still talking. Whichever engine draws it, the text Plainsong types is the finished transcription from your dictation engine, made after you stop."
                          : "The streaming engine is not downloaded, so the preview re-transcribes everything you have said so far every few hundred milliseconds and the words arrive a little behind you. Install it from the Models screen. Either way, the text Plainsong types is the finished transcription from your dictation engine, made after you stop."}
                      </p>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-silence-timeout"
                    >
                      Silence auto-stop
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="dictation-silence-timeout"
                        type="number"
                        min={0}
                        max={30}
                        step={0.1}
                        className="w-28 rounded-md border bg-background p-2 text-sm"
                        value={
                          dictationSilenceTimeoutSeconds <= 0
                            ? 0
                            : dictationSilenceTimeoutSeconds
                        }
                        onChange={(event) => {
                          const rawValue = Number.parseFloat(
                            event.target.value,
                          );
                          const next = Number.isFinite(rawValue) ? rawValue : 0;
                          setDictationSilenceTimeoutSeconds(
                            next <= 0 ? 0 : next,
                          );
                        }}
                        onBlur={(event) => {
                          const rawValue = Number.parseFloat(
                            event.target.value,
                          );
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
                    <p className="text-sm text-muted-foreground">
                      Stop recording after this much silence.{" "}
                      <span className="font-mono">0</span> turns it off — except
                      in hands-free mode, which still stops after 1.8 seconds.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-keep-warm"
                    >
                      Keep warm
                    </label>
                    <select
                      id="dictation-keep-warm"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={dictationKeepWarm}
                      onChange={(event) => {
                        const next = event.target.value as "off" | "on";
                        setDictationKeepWarm(next);
                        void persistDictationPreferences({ keepWarm: next });
                      }}
                    >
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                    <p className="text-sm text-muted-foreground">
                      Loads the dictation model as soon as a session starts, so
                      the first result does not wait on a cold load. Off loads
                      it during that first result instead, which makes only
                      that one slower. The speech model stays in memory until
                      you quit either way; with this off, the built-in cleanup
                      model is released a minute after your last dictation.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-context-source"
                    >
                      Text context
                    </label>
                    <select
                      id="dictation-context-source"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={dictationContextSource}
                      onChange={(event) => {
                        const contextSource = event.target
                          .value as DictationContextSource;
                        setDictationContextSource(contextSource);
                        const nextModePreset = syncModePreset({
                          contextSource,
                        });
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
                    <p className="text-sm text-muted-foreground">
                      {getDictationTextContextDescription(
                        dictationCommandPrefix,
                      )}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-insertion-mode"
                    >
                      Insertion mode
                    </label>
                    <select
                      id="dictation-insertion-mode"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={dictationInsertionMode}
                      onChange={(event) => {
                        const mode = event.target
                          .value as DictationInsertionMode;
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
                      <option value="auto">Insert at cursor</option>
                      <option value="clipboard_only">Clipboard only</option>
                    </select>
                    <p className="text-sm text-muted-foreground">
                      Insert at cursor puts the text into the frontmost app.
                      Clipboard only copies it and leaves the insert to you.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-retention"
                    >
                      Auto-delete dictation recordings
                    </label>
                    <p
                      id="dictation-retention-description"
                      className="text-sm text-muted-foreground"
                    >
                      Deletes the whole dictation once it is this old — the
                      text in History and any audio kept for it. The same
                      setting appears in Settings &rarr; Storage; changing it
                      in either place changes both.
                    </p>
                    <select
                      id="dictation-retention"
                      aria-describedby="dictation-retention-description"
                      className="w-full rounded-md border bg-background p-2 text-sm"
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
                        <label
                          className="text-sm text-muted-foreground"
                          htmlFor="dictation-retention-hours"
                        >
                          Custom hours
                        </label>
                        <input
                          id="dictation-retention-hours"
                          type="number"
                          min={1}
                          className="w-full rounded-md border bg-background p-2 text-sm"
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

                  <div className="space-y-2 md:col-span-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <label
                          className="text-sm font-medium"
                          htmlFor="dictation-keep-audio"
                        >
                          Keep dictation audio for Process again
                        </label>
                        <p className="text-sm text-muted-foreground">
                          Off by default. When on, each new dictation keeps its
                          recording in Plainsong's local recordings folder so
                          you can run it through another engine or style later.
                          The audio is deleted with the history entry, by
                          auto-delete or by hand.
                        </p>
                      </div>
                      <Switch
                        id="dictation-keep-audio"
                        checked={dictationKeepAudio}
                        onCheckedChange={(checked) => {
                          setDictationKeepAudio(checked);
                          void persistDictationPreferences({ keepAudio: checked });
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-md border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">
                    The next capture will be transcribed as
                  </p>
                  <p className="mt-1">
                    <span className="font-mono">
                      {effectiveCaptureLanguage ?? "auto"}
                    </span>
                    {dictationModePreset === "custom" &&
                    customModeDraft.languageOverride.trim()
                      ? " — from this profile's language override."
                      : dictationSessionLanguage !== "auto"
                        ? " — from the session language you picked."
                        : dictationActiveLanguages.length === 1
                          ? " — from the one language you left selected."
                          : " — chosen by the engine as you speak."}
                  </p>
                </div>
              </TabsContent>

              <TabsContent
                value="dictionary"
                className="mt-4 space-y-4"
                data-testid="dictionary-section"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="section-heading">Dictionary</h3>
                    <p className="text-sm text-muted-foreground">
                      Words Plainsong should always spell your way — names,
                      brands, and jargon. {dictionaryCoverageSummary}
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
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  Leave App scope blank to apply everywhere. Fill it in when the
                  replacement should only happen in one app. These run before
                  phrase expansions.
                </p>

                {recentlyLearnedDictionaryEntries.length > 0 && (
                  <div
                    className="space-y-2 rounded-md border bg-muted/20 p-3"
                    data-testid="recently-learned-dictionary"
                  >
                    <p className="text-sm font-medium">Recently learned</p>
                    <ul className="space-y-1">
                      {recentlyLearnedDictionaryEntries.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span className="truncate">
                            <span className="font-mono text-muted-foreground">
                              {entry.spokenForm}
                            </span>
                            <span className="mx-1 text-muted-foreground">
                              {"->"}
                            </span>
                            <span className="font-medium">
                              {entry.replacement}
                            </span>
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {formatDateTime(entry.updatedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_1fr_auto]">
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Say (e.g. open ai)"
                    value={newDictionarySpokenForm}
                    onChange={(event) =>
                      setNewDictionarySpokenForm(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Insert (e.g. OpenAI)"
                    value={newDictionaryReplacement}
                    onChange={(event) =>
                      setNewDictionaryReplacement(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,240px)]">
                  <Select
                    value={newDictionaryCategoryScope}
                    onValueChange={(value) =>
                      setNewDictionaryCategoryScope(
                        value as DictationAppCategoryKey | "any",
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">
                        Any destination category
                      </SelectItem>
                      {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
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
                        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,220px)]">
                          <Select
                            value={entry.categoryScope ?? "any"}
                            onValueChange={(value) =>
                              void patchDictionaryEntry(entry.id, {
                                categoryScope: value === "any" ? null : value,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="any">
                                Any destination category
                              </SelectItem>
                              {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map(
                                (option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
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
                  <p className="text-sm text-muted-foreground">
                    {dictionaryCsvStatus}
                  </p>
                )}
              </TabsContent>

              <TabsContent
                value="snippets"
                className="mt-4 space-y-4"
                data-testid="snippet-section"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="section-heading">Phrase expansions</h3>
                    <p className="text-sm text-muted-foreground">
                      Say a short trigger, get the long version inserted.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
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

                <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_1fr_auto]">
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Trigger (e.g. brb)"
                    value={newSnippetTrigger}
                    onChange={(event) =>
                      setNewSnippetTrigger(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Expansion (e.g. be right back)"
                    value={newSnippetExpansion}
                    onChange={(event) =>
                      setNewSnippetExpansion(event.target.value)
                    }
                  />
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,240px)]">
                  <Select
                    value={newSnippetCategoryScope}
                    onValueChange={(value) =>
                      setNewSnippetCategoryScope(
                        value as DictationAppCategoryKey | "any",
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">
                        Any destination category
                      </SelectItem>
                      {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
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
                        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,220px)]">
                          <Select
                            value={snippet.categoryScope ?? "any"}
                            onValueChange={(value) =>
                              void patchSnippet(snippet.id, {
                                categoryScope: value === "any" ? null : value,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="any">
                                Any destination category
                              </SelectItem>
                              {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map(
                                (option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
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
              </TabsContent>

              <TabsContent value="corrections" className="mt-4 space-y-4">
                {showExternalCorrectionCard && (
                  <div className="rounded-md border bg-muted/20 px-3 py-3 space-y-2">
                    <h3 className="section-heading">
                      Corrections you make elsewhere
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      You fix Plainsong&apos;s mistakes where the text lands —
                      in Slack, in mail, in your editor — and it never finds
                      out. It can watch for that, but only if you ask it to: it
                      would re-read the one field it just typed into, for a few
                      seconds after the insert, and show you the word changes to
                      approve. Off unless you turn it on.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setDictationLearnFromExternalCorrections(true);
                          dismissExternalCorrectionCard();
                          void persistDictationPreferences({
                            learnFromExternalCorrections: true,
                          });
                        }}
                      >
                        Turn it on
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={dismissExternalCorrectionCard}
                      >
                        Not now
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="section-heading">Correction inbox</h3>
                    <p className="text-sm text-muted-foreground">
                      Edits you made to a result inside Plainsong. Approving one
                      adds it to the dictionary.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
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
                    <span className="text-sm text-muted-foreground">
                      {inAppCorrectionSuggestionGroups.reduce(
                        (total, group) => total + group.suggestionIds.length,
                        0,
                      )}{" "}
                      pending
                    </span>
                    {inAppCorrectionSuggestionGroups.length > 1 && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={correctionInboxBusy}
                          onClick={() =>
                            void handleApproveCorrectionSuggestionGroup(
                              inAppCorrectionSuggestionGroups.flatMap(
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
                              inAppCorrectionSuggestionGroups.flatMap(
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

                {inAppCorrectionSuggestionGroups.length > 0 ? (
                  <div className="space-y-2">
                    {inAppCorrectionSuggestionGroups.map((group) => (
                      <CorrectionSuggestionRow
                        key={group.key}
                        group={group}
                        busy={correctionInboxBusy}
                        onApprove={handleApproveCorrectionSuggestionGroup}
                        onDismiss={handleRejectCorrectionSuggestionGroup}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nothing waiting. Edits you make to a result show up here for
                    review.
                  </p>
                )}

                <div className="space-y-3 border-t pt-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="section-heading">
                        Suggested from other apps
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Word changes Plainsong saw you make where it inserted.
                        Approving one adds it to the dictionary; dismissing
                        drops it. Anything left unreviewed for a week expires on
                        its own.
                      </p>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {externalCorrectionSuggestionGroups.reduce(
                        (total, group) => total + group.suggestionIds.length,
                        0,
                      )}{" "}
                      pending
                    </span>
                  </div>

                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={dictationLearnFromExternalCorrections}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationLearnFromExternalCorrections(next);
                        dismissExternalCorrectionCard();
                        void persistDictationPreferences({
                          learnFromExternalCorrections: next,
                        });
                      }}
                    />
                    <span>
                      <span className="font-medium">
                        Learn from corrections you make in other apps
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        Off by default. With it on, Plainsong re-reads the one
                        field it just typed into — only that field, only in the
                        app it inserted into, and only for the 8 seconds after
                        the insert. It compares that text with what it typed, on
                        this machine; nothing is sent anywhere. The only thing
                        written down is the word-level changes it finds, held
                        here for your review — never the sentence they came out
                        of — and anything you don&apos;t approve is deleted
                        within a week. If you switch apps or put the cursor in
                        another field, Plainsong stops and reads nothing.
                      </span>
                    </span>
                  </label>

                  {externalCorrectionSuggestionGroups.length > 0 ? (
                    <div className="space-y-2">
                      {externalCorrectionSuggestionGroups.map((group) => (
                        <CorrectionSuggestionRow
                          key={group.key}
                          group={group}
                          busy={correctionInboxBusy}
                          onApprove={handleApproveCorrectionSuggestionGroup}
                          onDismiss={handleRejectCorrectionSuggestionGroup}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {dictationLearnFromExternalCorrections
                        ? "Nothing yet. Fix a word right after Plainsong types it somewhere, and the change shows up here to approve."
                        : "Nothing here while this is off — Plainsong is not reading any other app's text."}
                    </p>
                  )}
                </div>

                <div className="space-y-2 border-t pt-4">
                  <h3 className="section-heading">Fixing what you just said</h3>
                  <p className="text-sm text-muted-foreground">
                    Straight after an insert, say <code>scratch that</code> to
                    undo it, or <code>actually ...</code>,{" "}
                    <code>no, say ...</code>, <code>replace X with Y</code>, or{" "}
                    <code>change X to Y</code> to correct it — no keyboard
                    needed.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="text-actions" className="mt-4 space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-command-prefix"
                    >
                      {DICTATION_TEXT_ACTIONS.commandPrefixLabel}
                    </label>
                    <input
                      id="dictation-command-prefix"
                      type="text"
                      className="w-full rounded-md border bg-background p-2 text-sm"
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
                    <p className="text-sm text-muted-foreground">
                      {DICTATION_TEXT_ACTIONS.prefixDescription}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      {DICTATION_TEXT_ACTIONS.commandModeLabel}
                    </p>
                    <label className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
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
                      {DICTATION_TEXT_ACTIONS.commandModeEnabledLabel}
                    </label>
                    <p className="text-sm text-muted-foreground">
                      {DICTATION_TEXT_ACTIONS.settingsDescription}
                    </p>
                  </div>
                </div>

                <div className="border-t pt-4">
                  <DictationTextActionsEditor
                    presets={dictationCommandPresets}
                    commandPrefix={dictationCommandPrefix}
                    onDraftChange={setCommandPresetDraft}
                    onCommit={(commandKey, systemPrompt, enabled) =>
                      void upsertCommandPreset(commandKey, systemPrompt, enabled)
                    }
                    onReset={(commandKey) =>
                      void resetCommandPreset(commandKey)
                    }
                  />
                </div>
              </TabsContent>

              <TabsContent value="destinations" className="mt-4 space-y-4">
                <h3 className="section-heading">Destination-aware formatting</h3>

                <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-background/75 p-4">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      Format for destination app
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Match the tone and structure to the app you're writing
                      into — brief in chat, fuller in email. Off formats
                      everything the same way.
                    </p>
                  </div>
                  <Switch
                    checked={dictationCategoryFormattingEnabled}
                    onCheckedChange={(checked) => {
                      setDictationCategoryFormattingEnabled(checked);
                      void persistDictationPreferences({
                        categoryFormattingEnabled: checked,
                      });
                    }}
                  />
                </div>

                <div
                  className="space-y-3 border-t pt-4"
                  data-testid="numbers-as-digits-section"
                >
                  <div>
                    <h4 className="section-heading">
                      {DICTATION_NUMBERS_SECTION_HEADING}
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      {DICTATION_NUMBERS_SECTION_DESCRIPTION}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {DICTATION_NUMBER_MODE_IDS.map((modeId) => (
                      <div
                        key={modeId}
                        className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <p className="text-sm font-medium">
                            {DICTATION_MODE_DEFINITION_BY_ID[modeId].label}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {numbersAsDigitsModeHint(modeId)}
                          </p>
                        </div>
                        <Switch
                          aria-label={`${DICTATION_MODE_DEFINITION_BY_ID[modeId].label}: numbers as digits`}
                          checked={resolveNumbersAsDigits(
                            modeId,
                            dictationNumbersAsDigits,
                          )}
                          onCheckedChange={(checked) => {
                            const next = {
                              ...dictationNumbersAsDigits,
                              [modeId]: checked,
                            };
                            setDictationNumbersAsDigits(next);
                            void persistDictationPreferences({
                              numbersAsDigits: next,
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="section-heading">Built-in categories</h4>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {DICTATION_APP_CATEGORY_REFERENCE.map((entry) => (
                      <div
                        key={entry.key}
                        className="rounded-md border bg-background px-3 py-2"
                      >
                        <p className="text-sm font-medium">{entry.label}</p>
                        <p className="text-sm text-muted-foreground">
                          {entry.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  className="space-y-3 border-t pt-4"
                  data-testid="category-override-section"
                >
                  <div>
                    <h4 className="section-heading">App overrides</h4>
                    <p className="text-sm text-muted-foreground">
                      Put a specific app in a category yourself when Plainsong
                      guesses wrong. Matching is on part of the name, so "slack"
                      matches Slack. The first enabled match wins.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                    <input
                      type="text"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      placeholder="App matcher (e.g. slack)"
                      value={newCategoryOverrideAppMatcher}
                      onChange={(event) =>
                        setNewCategoryOverrideAppMatcher(event.target.value)
                      }
                    />
                    <Select
                      value={newCategoryOverrideCategory}
                      onValueChange={(value) =>
                        setNewCategoryOverrideCategory(
                          value as DictationAppCategoryKey,
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" onClick={handleAddCategoryOverride}>
                      Add
                    </Button>
                  </div>

                  {dictationAppCategoryOverrides.length > 0 && (
                    <div className="space-y-2">
                      {dictationAppCategoryOverrides.map((override) => (
                        <div
                        key={override.id}
                        className="rounded-md border p-2 space-y-2"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={override.appMatcher}
                            onChange={(event) =>
                              setDictationAppCategoryOverrides((prev) =>
                                prev.map((current) =>
                                  current.id === override.id
                                    ? {
                                        ...current,
                                        appMatcher: event.target.value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            onBlur={(event) =>
                              patchCategoryOverride(override.id, {
                                appMatcher: event.target.value.trim(),
                              })
                            }
                          />
                          <Select
                            value={override.category}
                            onValueChange={(value) =>
                              patchCategoryOverride(override.id, {
                                category: value as DictationAppCategoryKey,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DICTATION_APP_CATEGORY_SELECT_OPTIONS.map(
                                (option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between">
                          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={override.enabled}
                              onChange={(event) =>
                                patchCategoryOverride(override.id, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            Enabled
                          </label>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleDeleteCategoryOverride(override.id)
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      </ScrollArea>

      <DictationHistoryDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        recording={selectedRecording}
        transcript={selectedTranscript}
        historyDetails={selectedHistoryDetails}
        isLoadingTranscript={isLoadingTranscript}
        durationLabel={
          selectedRecording
            ? formatRecordingDuration(selectedRecording.duration)
            : "N/A"
        }
        reprocessModePreset={reprocessModePreset}
        onReprocessModePresetChange={setReprocessModePreset}
        reprocessedResult={reprocessedResult}
        isReprocessing={isReprocessing}
        reprocessError={reprocessError}
        onReprocess={() => void handleReprocessSelectedDictation()}
        processAgainModeId={processAgainModeId}
        onProcessAgainModeIdChange={setProcessAgainModeId}
        processAgainCustomModes={dictationCustomModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
        }))}
        processAgainOutcome={processAgainOutcome}
        isProcessingAgain={isProcessingAgain}
        processAgainError={processAgainError}
        onProcessAgain={() => void handleProcessSelectedDictationAgain()}
        onOpenProcessAgainResult={() => {
          if (!processAgainOutcome) {
            return;
          }
          setSelectedRecording(processAgainOutcome.recording);
        }}
        onUseReprocessedResult={() => {
          if (!reprocessedResult) {
            return;
          }
          setTranscribedText(reprocessedResult.outputText);
          // Reprocessed text is not what the sidecar stored either.
          setLatestResultDirty(true);
          setPasteStatus(
            `Reprocessed with ${
              DICTATION_MODE_DEFINITION_BY_ID[
                reprocessedResult.modePreset as DictationModePreset
              ]?.label ?? reprocessedResult.modePreset
            }`,
          );
        }}
        correctionText={historyCorrectionText}
        onCorrectionTextChange={setHistoryCorrectionText}
        onCorrectionBlur={() => {
          void maybeAutoLearnHistoryCorrection();
        }}
        canLearnCorrection={
          historyCorrectionBaseline.trim() !== historyCorrectionText.trim()
        }
        showFixCapitalization={isCaseOnlyDifference(
          historyCorrectionBaseline,
          historyCorrectionText,
        )}
        onLearnCorrection={() =>
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
                setHistoryCorrectionBaseline(historyCorrectionText.trim()),
            },
          )
        }
        learnStatus={historyLearnStatus}
        isReadingAloud={
          activeSpeechTarget === `history-${selectedRecording?.id ?? ""}`
        }
        onToggleReadAloud={() => {
          if (!selectedRecording || !selectedTranscript?.fullText) {
            return;
          }
          void toggleReadAloudPlayback(
            selectedTranscript.fullText,
            `history-${selectedRecording.id}`,
          );
        }}
        onCopyTranscript={() => {
          if (!selectedRecording) {
            return;
          }
          void handleCopyHistoryTranscript(selectedRecording.id);
        }}
        onDelete={() => {
          if (!selectedRecording) {
            return;
          }
          setPendingHistoryDelete(selectedRecording);
        }}
      />

      <Dialog
        open={pendingHistoryDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingHistoryDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this dictation?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingHistoryDelete?.title}&rdquo; and its saved transcript are gone for good.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingHistoryDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteHistoryItem()}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete dictation
            </Button>
          </DialogFooter>
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
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {dictionaryCsvStatus}
              </div>
            )}
            {dictionaryCsvImportResult?.errors.length ? (
              <div className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
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
