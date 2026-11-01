import { OPEN_DICTATION_HISTORY_EVENT, consumePendingDictationHistoryRequest } from "@/lib/navigation";
import { useDictationDrafts, type LocalDictationDraft } from "@/hooks/use-dictation-drafts";
import { UnfinishedDictationEdits } from "@/components/views/dictation/unfinished-dictation-edits";
import { LatestStylePreview } from "@/components/views/dictation/latest-style-preview";
import { EngineRecoveryBanner } from "@/components/engine-recovery-banner";
import { DictationRecoveryBanner } from "@/components/dictation-recovery-banner";
import { assessOneOffDictationCapture, assessInAppDictationCapture } from "@/lib/dictation-capture-readiness";
import { registerMainWindowIdleGuard } from "@/lib/main-window-idle";
import {
  efficientParakeetOffered,
  isOnnxParakeetRoute,
  RECOMMENDED_SPEECH_ROUTE,
  routeIdFor,
  routeDisplayLabel,
  speechRouteName,
} from "@/lib/asr-route-catalog";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { RecordingDurationText, useRecordingSession } from "@/hooks/use-recording";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import { CommittedNumberInput } from "@/components/ui/committed-number-input";
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
  undoDictationCorrectionApproval,
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
import { deleteRecording, getRecording, getTranscript } from "@/lib/backend/recordings";
import { RecognitionWordReview, recognitionWordsToReview } from "@/components/views/dictation/recognition-word-review";
import { DictationChangeReview } from "@/components/views/dictation/dictation-change-review";
import { SelectiveChangeReview } from "@/components/views/dictation/selective-change-review";
import { stageSavedDictationResult } from "@/lib/backend/dictation-shortcut-result";
import { getDictationEdit, saveDictationEdit } from "@/lib/backend/dictation-edits";
import { downloadAsrModels, getAsrProviders, listDownloadedModels, type DownloadedModelFile } from "@/lib/backend/asr";
import { describeModelDownloadError } from "@/lib/model-download-error";
import { buildDownloadedModelIndex } from "@/components/models/downloaded-models";
import { getSettings, updateSettings, setDictationExternalCorrectionLearning } from "@/lib/backend/settings";
import {
  cancelAnalysisRun,
  getLivePreviewEngineStatus,
  listOllamaModelCatalog,
  listOllamaModels,
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
  probeDictationAiLaneReadiness,
  type DictationAiLaneReadiness,
  resolveTranslateToEnglishAvailability,
} from "@/lib/dictation-translation";
import {
  dictationModeNeedsRewrite,
  probeOllamaRewriteReadiness,
  resolveDictationRewriteReadiness,
  resolveDictationCleanupReadiness,
} from "@/lib/dictation-rewrite-readiness";
import {
  INSERTION_MODE_LABELS,
  dictationSearchMatchLabel,
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
  resolveDisplayedDictationHotkeyMode,
} from "@/lib/dictation-hotkey-mode";
import {
  requestMainView,
  requestReadinessDestination,
  registerViewLeaveGuard,
} from "@/lib/navigation";
import {
  describeDictationVocabularyNote,
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
import { DictationStats } from "@/components/views/dictation/dictation-stats";
import { DictationCaptureHero } from "@/components/views/dictation/dictation-capture-hero";
import { DictationHistoryDialog } from "@/components/views/dictation/dictation-history-dialog";
import { DictationHistoryList } from "@/components/views/dictation/dictation-history-list";
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
  SpeechModelKeepReady,
} from "@/types/settings";
import {
  useDictationRuntime,
  type DictationContextSource,
  type DictationInsertionMode,
  type DictationModePreset,
  type DictationPhase,
} from "@/features/dictation/runtime";
import { compareStrings, formatDateTime, formatNumber } from "@/lib/format-locale";

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
  approvalDictionary: DictationCorrectionSuggestion["approvalDictionary"];
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

function CorrectionApprovalPreview({ snapshot }: { snapshot: DictationCorrectionSuggestion["approvalDictionary"] }) {
  if (!snapshot) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Applies everywhere
      {snapshot.kind === "entry" && <><br /><span>Replaces {snapshot.spokenForm} → {snapshot.replacement}</span></>}
    </p>
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
  onApprove: (suggestionIds: string[], trigger: HTMLButtonElement) => void | Promise<void>;
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
            {group.spokenForm} → {group.replacement}
          </p>
          <CorrectionApprovalPreview snapshot={group.approvalDictionary} />
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
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => { if (!busy) void onApprove(group.suggestionIds, event.currentTarget); }}
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

type DictionaryEntrySubmission = {
  spokenForm: string;
  replacement: string;
  appScope: string | null;
  caseSensitive: boolean;
  categoryScope: DictationAppCategoryKey | "any";
};

type DictionaryEntryEditableField =
  | "spokenForm"
  | "replacement"
  | "appScope"
  | "caseSensitive"
  | "enabled"
  | "categoryScope";

type DictionaryEntryPatch = Partial<
  Pick<DictationDictionaryEntry, DictionaryEntryEditableField>
>;

type DictionaryEntryWriteRequest = {
  updates: DictionaryEntryPatch;
  revisions: Partial<Record<DictionaryEntryEditableField, number>>;
  retry: boolean;
};

function dictionarySubmissionKey(submission: DictionaryEntrySubmission): string {
  return JSON.stringify([
    submission.spokenForm,
    submission.replacement,
    submission.appScope,
    submission.caseSensitive,
    submission.categoryScope,
  ]);
}

type DictationRouteReadiness = {
  status: "missing" | "downloading";
  providerType: AsrProviderType;
  modelId: string;
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
  const routeLabel = modelId
    ? speechRouteName(provider, modelId)
    : provider.name;

  return {
    status: downloadKind === "downloading" ? "downloading" : "missing",
    providerType,
    modelId,
    routeLabel,
  };
}

type LastDictationTone = "ready" | "note" | "insertion" | "transcription";

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
      "Formats as a prompt or question. Cleanup checks for changes to technical text and dictionary spellings.",
  },
  {
    key: "code_editor",
    label: "Code editor",
    description:
      "Uses your dictionary and checks cleanup for changes to identifiers, file paths, flags, and casing.",
  },
];

const SPEECH_MODEL_KEEP_READY_OPTIONS: {
  value: SpeechModelKeepReady;
  label: string;
}[] = [
  { value: "auto", label: "Automatic (recommended)" },
  { value: "2m", label: "2 minutes" },
  { value: "5m", label: "5 minutes" },
  { value: "10m", label: "10 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "always", label: "Always" },
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
    actionLabel: "Got it",
  },
  {
    id: "command_mode",
    title: "Use voice editing, not just voice typing",
    body: "Command mode is best for rewrite, bulletize, summarize, and coding cleanup on selected text. Turn it on when you want the app to act like a writing copilot.",
    actionLabel: "Turn on Command mode",
  },
  {
    id: "profiles",
    title: "Save a profile per app",
    body: "A profile remembers the style, context, and insertion behavior that suits one kind of writing. Keep one for Slack, one for email, one for code, and switch with a click. Adding the Coding profile also switches to it.",
    actionLabel: "Add the Coding profile",
  },
];

const DEFAULT_DICTATION_MODE: DictationModePreset = "voice";
const DEFAULT_BASE_MODE: DictationBaseModePreset = "voice";
const HISTORY_SAVED_EDIT_READ_ERROR = "Couldn't load saved corrections. Reopen this dictation before saving changes.";

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
  const usedContext = contextChars !== null && contextChars > 0
    ? `Used ${contextChars} characters of context.` : null;
  if (activationMatcher && appTarget) {
    return [`Matched your "${activationMatcher}" rule for ${appTarget}.`, usedContext].filter(Boolean).join(" ");
  }
  if (activationMatcher) {
    return [`Matched your "${activationMatcher}" rule.`, usedContext].filter(Boolean).join(" ");
  }
  if (appTarget && usedContext) {
    return `${usedContext} Destination: ${appTarget}.`;
  }
  if (appTarget) {
    return `Text goes into ${appTarget}.`;
  }
  if (usedContext) return usedContext;
  return "Start keeps text in Plainsong. The shortcut inserts into the active app.";
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
        title: "Opening microphone",
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
        title: "Ready to record",
        detail: message?.trim() || "Start dictation. Speak when you see Listening.",
        tone: "idle",
      };
  }
}

export function DictationView() {
  const {
    productReadiness,
    productReadinessEvidence,
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
  const consumedDictationTextReadyRef = useRef<typeof dictationTextReadyEvent>(null);
  const currentDictationStateRef = useRef(dictationStateEvent);
  currentDictationStateRef.current = dictationStateEvent;
  const processingCancelPendingIdsRef = useRef(new Set<number>());
  const [processingCancellingId, setProcessingCancellingId] = useState<number | null>(null);
  const [processingCancelError, setProcessingCancelError] = useState<{ sessionId: number; message: string } | null>(null);
  const processingCancelMountedRef = useRef(true);
  useEffect(() => {
    processingCancelMountedRef.current = true;
    return () => { processingCancelMountedRef.current = false; };
  }, []);
  const { startDictation, stopDictation, isRecording: captureIsRecording,
    recordingMode, meetingPhase } = useRecordingSession();
  const meetingOwnsCapture = recordingMode === "meeting" &&
    (captureIsRecording || meetingPhase === "preparing" || meetingPhase === "stopping");
  const meetingOwnsCaptureRef = useRef(meetingOwnsCapture);
  meetingOwnsCaptureRef.current = meetingOwnsCapture;
  const dictationStartBlockedReason = meetingOwnsCapture
    ? "Stop the meeting before starting dictation." : null;
  const { toast } = useToast();
  const { projects } = useProjects();
  const {
    recordings,
    isLoading: dictationHistoryLoading,
    error: dictationHistoryError,
    refetch: refetchDictationHistory,
  } = useRecordings();
  const defaultShortcut = defaultDictationShortcut();
  // Null until settings answer: showing the default binding meanwhile told
  // anyone who had changed it the wrong keys.
  const [hotkeyLabel, setHotkeyLabel] = useState<string | null>(null);
  const [hotkeyBindings, setHotkeyBindings] = useState<Settings["shortcuts"]["dictationBindings"]>();
  const [hotkeyShortcut, setHotkeyShortcut] = useState(defaultShortcut);
  const [repasteShortcutLabel, setRepasteShortcutLabel] = useState<
    string | null
  >(null);
  const [transcribedText, setTranscribedText] = useState("");
  const [lastRoutePreference, setLastRoutePreference] =
    useState<DictationRoutePreference | null>(null);
  const [lastResolvedHosting, setLastResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  // Raw provider ids from the sidecar; the card turns them into display names
  // once the provider list is loaded.
  const [lastFallback, setLastFallback] = useState<{
    requestedProvider: string | null;
    actualProvider: string | null;
    reason: string | null;
  } | null>(null);
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);
  const [textReadyAfterStopMs, setTextReadyAfterStopMs] = useState<number | null>(null);
  const [insertedAfterStopMs, setInsertedAfterStopMs] = useState<number | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [lastDeliveryReceipt, setLastDeliveryReceipt] = useState<{
    kind: "inserted" | "copied" | "preview" | "ready" | "unconfirmed" | "refused";
    message: string;
    needsAttention: boolean;
    context: { id: string | null; original: string; saved: string | null };
    appTarget: string | null;
    returnSent: boolean | null;
    activationMatcher: string | null;
    provider: string | null;
    modelId: string | null;
    providerModelLabel: string | null;
    contextChars: number | null;
  } | null>(null);
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
  const [speechModelKeepReady, setSpeechModelKeepReady] =
    useState<SpeechModelKeepReady>("auto");
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
    useState(false);
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
  const externalCorrectionConsentChange = useRef({ revision: 0, pending: false });
  const [externalCorrectionConsentStatus, setExternalCorrectionConsentStatus] =
    useState<"idle" | "saving" | "unconfirmed">("idle");
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
  const dictationDictionaryEntriesRef = useRef<DictationDictionaryEntry[]>([]);
  dictationDictionaryEntriesRef.current = dictationDictionaryEntries;
  const dictionaryEntryFieldRevisionsRef = useRef(
    new Map<string, Partial<Record<DictionaryEntryEditableField, number>>>(),
  );
  const dictionaryEntryWriteQueuesRef = useRef(
    new Map<string, DictionaryEntryWriteRequest[]>(),
  );
  const dictionaryEntryWriteRunningRef = useRef(new Set<string>());
  const dictionaryEntryUnconfirmedFieldsRef = useRef(
    new Map<string, Partial<Record<DictionaryEntryEditableField, number>>>(),
  );
  const deletedDictionaryEntryIdsRef = useRef(new Set<string>());
  const dictionaryEntryDeletePendingRef = useRef(new Set<string>());
  const [dictionaryEntryDeletingIds, setDictionaryEntryDeletingIds] = useState<Set<string>>(new Set());
  const [dictionaryEntryDeleteFailures, setDictionaryEntryDeleteFailures] = useState<Record<string, string>>({});
  const [dictionaryEntryRetryingIds, setDictionaryEntryRetryingIds] = useState<
    Set<string>
  >(new Set());
  const [dictionaryEntrySaveFailures, setDictionaryEntrySaveFailures] =
    useState<Record<string, string>>({});
  const [dictationCorrectionSuggestions, setDictationCorrectionSuggestions] =
    useState<DictationCorrectionSuggestion[]>([]);
  const [correctionInboxBusy, setCorrectionInboxBusy] = useState(false);
  const [correctionApprovalError, setCorrectionApprovalError] = useState<string | null>(null);
  const correctionInboxPendingRef = useRef(false);
  const correctionApprovalFocusRef = useRef<{
    key: string; target: "undo" | "notice"; trigger: HTMLButtonElement;
  } | null>(null);
  const correctionSuggestionsRevisionRef = useRef(0);
  const [correctionUndoEntryId, setCorrectionUndoEntryId] = useState<string | null>(null);
  const [correctionApprovalNotices, setCorrectionApprovalNotices] = useState<Array<{
    key: string; label: string; message: string; undoToken: string | null;
    entry: DictationDictionaryEntry; error: string | null;
  }>>([]);

  const focusCorrectionApprovalTarget = (element: HTMLElement | null, key: string, target: "undo" | "notice") => {
    const pending = correctionApprovalFocusRef.current;
    if (!element || pending?.key !== key || pending.target !== target || element.getAttribute("aria-disabled") === "true") return;
    correctionApprovalFocusRef.current = null;
    if (document.activeElement === pending.trigger || (!pending.trigger.isConnected && document.activeElement === document.body)) {
      element.focus();
    }
  };

  const [dictationSnippets, setDictationSnippets] = useState<
    DictationSnippet[]
  >([]);
  type SnippetField = "trigger" | "expansion" | "appScope" | "caseSensitive" | "enabled" | "categoryScope";
  type SnippetPatch = Partial<Pick<DictationSnippet, SnippetField>>;
  const snippetFieldRevisionsRef = useRef(new Map<string, Partial<Record<SnippetField, number>>>());
  const snippetWriteQueuesRef = useRef(new Map<string, Array<{
    updates: SnippetPatch;
    revisions: Partial<Record<SnippetField, number>>;
  }>>());
  const snippetWriteRunningRef = useRef(new Set<string>());
  const snippetUnconfirmedFieldsRef = useRef(new Map<string, Set<SnippetField>>());
  const [snippetSaveStates, setSnippetSaveStates] = useState<Record<string, { pending: boolean; failed: boolean }>>({});
  const [dictationCommandPresets, setDictationCommandPresets] = useState<
    DictationCommandPreset[]
  >([]);
  const commandPresetRevisionsRef = useRef(new Map<string, number>());
  const commandPresetWriteQueuesRef = useRef(new Map<string, Array<{
    revision: number;
    reset: boolean;
    systemPrompt: string;
    enabled: boolean;
  }>>());
  const commandPresetWriteRunningRef = useRef(new Set<string>());
  const [commandPresetSaveStates, setCommandPresetSaveStates] = useState<Record<string, {
    pending?: boolean;
    failure?: "save" | "reset";
    unsaved?: boolean;
  }>>({});
  const [newDictionarySpokenForm, setNewDictionarySpokenForm] = useState("");
  const [newDictionaryReplacement, setNewDictionaryReplacement] = useState("");
  const [newDictionaryAppScope, setNewDictionaryAppScope] = useState("");
  const [newDictionaryCaseSensitive, setNewDictionaryCaseSensitive] =
    useState(false);
  const [newDictionaryCategoryScope, setNewDictionaryCategoryScope] =
    useState<DictationAppCategoryKey | "any">("any");
  const dictionaryDraftRevisionRef = useRef(0);
  const dictionaryAddPendingRef = useRef<object | null>(null);
  const [isAddingDictionaryEntry, setIsAddingDictionaryEntry] = useState(false);
  const [dictionaryAddStatus, setDictionaryAddStatus] = useState<string | null>(null);
  const [failedDictionarySubmissions, setFailedDictionarySubmissions] = useState<Array<{
    key: string;
    submission: DictionaryEntrySubmission;
    revision: number;
    message: string;
  }>>([]);
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
  const newSnippetDraftRevisionRef = useRef(0);
  const snippetAddPendingRef = useRef(false);
  const [snippetAdding, setSnippetAdding] = useState(false);
  const [snippetAddError, setSnippetAddError] = useState<string | null>(null);
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
  const [pendingProfileDeleteId, setPendingProfileDeleteId] = useState<string | null>(null);
  const latestResultTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Set by "Quick add to dictionary". The Dictionary tab's field may mount
  // only after the tab switch, so focus moves from its ref callback, or right
  // away when the tab was already open.
  const focusDictionaryHeardAsRef = useRef(false);
  const dictionaryHeardAsNodeRef = useRef<HTMLInputElement | null>(null);
  const focusDictionaryHeardAs = useCallback((input: HTMLInputElement | null) => {
    if (!input || !focusDictionaryHeardAsRef.current) return;
    focusDictionaryHeardAsRef.current = false;
    input.focus();
    input.scrollIntoView?.({ block: "center" });
  }, []);
  const dictionaryHeardAsInputRef = useCallback((input: HTMLInputElement | null) => {
    dictionaryHeardAsNodeRef.current = input;
    focusDictionaryHeardAs(input);
  }, [focusDictionaryHeardAs]);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(
    null,
  );
  const [pendingHistoryDelete, setPendingHistoryDelete] =
    useState<Recording | null>(null);
  const [historyDeleteBusy, setHistoryDeleteBusy] = useState(false);
  const [historyDeleteError, setHistoryDeleteError] = useState<string | null>(null);
  const historyDeletePendingRef = useRef(false);
  const historyDeleteSelectionRef = useRef(selectedRecording);
  historyDeleteSelectionRef.current = selectedRecording;
  const [selectedTranscript, setSelectedTranscript] =
    useState<Transcript | null>(null);
  const [selectedHistoryDetails, setSelectedHistoryDetails] =
    useState<DictationHistoryDetails | null>(null);
  const [dictationInsights, setDictationInsights] =
    useState<DictationInsights | null>(null);
  const [latestCorrectionBaseline, setLatestCorrectionBaseline] = useState("");
  const dictationSetupRef = useRef<HTMLHeadingElement | null>(null);
  const latestQueuedCorrectionRef = useRef<string | null>(null);
  const latestCorrectionEpochRef = useRef(0);
  const latestResultRevisionRef = useRef(0);
  const latestVisibleTextRef = useRef(transcribedText);
  latestVisibleTextRef.current = transcribedText;
  const dictationControlEpochRef = useRef(0);
  const observedDictationSessionRef = useRef<number | null>(null);
  const pendingDictationStartRef = useRef<{ sessionId: number | null } | null>(null);
  const [dictationStarting, setDictationStarting] = useState(false);
  useEffect(() => () => { ++dictationControlEpochRef.current; }, []);
  useEffect(() => () => { ++latestResultRevisionRef.current; }, []);
  useEffect(() => () => { ++latestCorrectionEpochRef.current; }, []);
  const historyQueuedCorrectionRef = useRef<string | null>(null);
  const correctionActionEpochRef = useRef(0);
  const clipboardActionEpochRef = useRef(0);
  const latestCopyPendingRef = useRef(false);
  const [latestCopyPending, setLatestCopyPending] = useState(false);
  const latestCopyMountedRef = useRef(true);
  useEffect(() => {
    latestCopyMountedRef.current = true;
    return () => { latestCopyMountedRef.current = false; };
  }, []);
  useEffect(() => () => { ++clipboardActionEpochRef.current; }, []);
  // Correction learning and the shortcut buffer have separate baselines.
  // Editing alone never changes what the recovery shortcut will insert.
  const [latestResultDirty, setLatestResultDirty] = useState(false);
  const [latestResultOrigin, setLatestResultOrigin] = useState<"capture" | "preview" | "draft">("capture");
  const latestResultIsPreview = latestResultOrigin === "preview";
  const latestResultIsRecoveredDraft = latestResultOrigin === "draft";
  const [latestEditTargetId, setLatestEditTargetId] = useState<string | null>(null);
  const [latestSavedEdit, setLatestSavedEdit] = useState<string | null>(null);
  const [latestEditSaving, setLatestEditSaving] = useState(false);
  const [latestShortcutText, setLatestShortcutText] = useState<string | null>(null);
  const [latestRawTranscript, setLatestRawTranscript] = useState<string | null>(null);
  const [latestShortcutPreparing, setLatestShortcutPreparing] = useState(false);
  const [latestEditStatus, setLatestEditStatus] = useState<string | null>(null);
  const [latestEditError, setLatestEditError] = useState<string | null>(null);
  const latestEditContextRef = useRef<{
    id: string | null; original: string; saved: string | null; appTarget?: string | null;
  }>({ id: null, original: "", saved: null });
  const [latestRecognitionReview, setLatestRecognitionReview] = useState<{
    context: typeof latestEditContextRef.current; words: unknown; original: string;
  } | null>(null);
  const visibleLatestRecognitionReview = latestRecognitionReview?.context === latestEditContextRef.current
    ? latestRecognitionReview : null;
  const latestSaveRequestsRef = useRef(new Set<string>());
  const renderedLatestEditContext = latestEditContextRef.current;
  const latestReviewSessionRef = useRef({ context: renderedLatestEditContext, key: 0 });
  if (latestReviewSessionRef.current.context !== renderedLatestEditContext) {
    latestReviewSessionRef.current = { context: renderedLatestEditContext, key: latestReviewSessionRef.current.key + 1 };
  }
  const [latestPreviewUndo, setLatestPreviewUndo] = useState<{
    kind: "preview" | "restore";
    context: typeof latestEditContextRef.current;
    revision: number;
    appliedText: string;
    text: string;
    correctionBaseline: string;
    origin: typeof latestResultOrigin;
  } | null>(null);
  const visibleLatestPreviewUndo = latestPreviewUndo?.context === renderedLatestEditContext &&
    latestPreviewUndo.revision === latestResultRevisionRef.current &&
    latestPreviewUndo.appliedText === transcribedText ? latestPreviewUndo : null;
  const [draftSavedConflict, setDraftSavedConflict] = useState<{
    context: typeof latestEditContextRef.current; saved: string | null;
  } | null>(null);
  const visibleDraftConflict = draftSavedConflict?.context === latestEditContextRef.current ? draftSavedConflict : null;
  const unfinishedEdits = useDictationDrafts();
  const latestRecoveryDraft = transcribedText !== (latestSavedEdit ?? renderedLatestEditContext.original)
    ? unfinishedEdits.drafts.find((draft) => draft.recordingId === renderedLatestEditContext.id && draft.text === transcribedText)
    : undefined;
  const draftResumeEpochRef = useRef(0);
  const pendingDraftResumeRef = useRef<{ recordingId: string; request: number } | null>(null);
  useEffect(() => () => { ++draftResumeEpochRef.current; }, []);
  const journalLatestDraft = (text: string) => {
    const context = renderedLatestEditContext;
    if (!context.id) return;
    if (text === (context.saved ?? context.original)) {
      const prior = unfinishedEdits.drafts.find((draft) => draft.recordingId === context.id);
      if (prior) void unfinishedEdits.clearDraft(context.id, prior.text);
    } else {
      void unfinishedEdits.saveDraft(context.id, text, context.saved);
    }
  };
  const [latestLearnStatus, setLatestLearnStatus] = useState<string | null>(
    null,
  );
  const [historyCorrectionText, setHistoryCorrectionText] = useState("");
  const [historySavedEdit, setHistorySavedEdit] = useState<string | null>(null);
  const [historyEditSaving, setHistoryEditSaving] = useState(false);
  const [historyEditError, setHistoryEditError] = useState<string | null>(null);
  const [historyEditStatus, setHistoryEditStatus] = useState<string | null>(null);
  const historyEditRef = useRef({ draft: "", original: "", saved: null as string | null, loaded: false });
  const historyEditSaveRef = useRef<{ id: string; promise: Promise<boolean> } | null>(null);
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
  const [coachExpanded, setCoachExpanded] = useState(false);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [historyLoadRevision, setHistoryLoadRevision] = useState(0);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const historyReturnFocusRef = useRef<HTMLElement | null>(null);
  const historySearchInputRef = useRef<HTMLInputElement>(null);
  const [reprocessModePreset, setReprocessModePreset] =
    useState<DictationModePreset>(DEFAULT_DICTATION_MODE);
  const [reprocessedResult, setReprocessedResult] =
    useState<DictationReprocessResult | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const historyRequestEpochRef = useRef(0);
  const historyOpenRequestRef = useRef(0);
  const [isOpeningHistoryEntry, setIsOpeningHistoryEntry] = useState(false);
  useEffect(() => () => { historyOpenRequestRef.current += 1; }, []);
  const reprocessRequestEpochRef = useRef(0);
  const reprocessInputRevisionRef = useRef(0);
  const reprocessRunRef = useRef<{ runId: string; cancelled: boolean } | null>(null);
  const [reprocessCancelling, setReprocessCancelling] = useState(false);
  const cancelHistoryPreview = useCallback(() => {
    const run = reprocessRunRef.current;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    setReprocessCancelling(true);
    setReprocessedResult(null);
    setReprocessError(null);
    void cancelAnalysisRun(run.runId).catch(() => {
      if (reprocessRunRef.current === run) {
        setReprocessError("Couldn't cancel immediately. Waiting for the preview to stop.");
      }
    });
  }, []);
  useEffect(() => () => {
    const run = reprocessRunRef.current;
    if (run && !run.cancelled) {
      run.cancelled = true;
      void cancelAnalysisRun(run.runId).catch(() => undefined);
    }
    reprocessRunRef.current = null;
  }, []);
  const processAgainRequestEpochRef = useRef(0);
  const processAgainOperationRef = useRef<{
    sourceId: string;
    sourceTitle: string;
    modeId: string;
    speechRoute: string;
    token: symbol;
  } | null>(null);
  // "Process again": the kept audio through the recognizer and a chosen mode,
  // saved as a new history entry. Distinct from the text-only restyle above.
  const [processAgainModeId, setProcessAgainModeId] = useState<string>("voice");
  const [processAgainSpeechRoute, setProcessAgainSpeechRoute] = useState("current");
  const [retryModelFiles, setRetryModelFiles] = useState<DownloadedModelFile[]>([]);
  useEffect(() => {
    if (!isDialogOpen) return;
    let cancelled = false;
    void listDownloadedModels().then((files) => {
      if (!cancelled) setRetryModelFiles(files);
    }).catch(() => { if (!cancelled) setRetryModelFiles([]); });
    return () => { cancelled = true; };
  }, [isDialogOpen, selectedRecording?.id]);
  const [processAgainOutcome, setProcessAgainOutcome] =
    useState<DictationReprocessOutcome | null>(null);
  const [isProcessingAgain, setIsProcessingAgain] = useState(false);
  const [processAgainPendingSource, setProcessAgainPendingSource] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [processAgainError, setProcessAgainError] = useState<string | null>(
    null,
  );
  const [processAgainRefreshWarning, setProcessAgainRefreshWarning] =
    useState<string | null>(null);
  const [captureSettings, setCaptureSettings] = useState<Settings | null>(null);
  const [captureProviders, setCaptureProviders] = useState<AsrProviderInfo[]>([]);
  const efficientParakeet = efficientParakeetOffered(captureProviders);
  // Display names for the provider and model ids the sidecar and settings
  // carry, so the reader sees "NVIDIA Parakeet", not "parakeet". The raw id
  // stands in only until the provider list has loaded.
  const speechProviderName = useCallback(
    (providerId: string | null | undefined): string | null =>
      providerId
        ? captureProviders.find((provider) => provider.providerType === providerId)?.name ?? providerId
        : null,
    [captureProviders],
  );
  const speechModelName = useCallback(
    (providerId: string | null | undefined, modelId: string | null | undefined): string | null => {
      if (!modelId) return null;
      const provider = captureProviders.find((candidate) => candidate.providerType === providerId);
      if (!provider) return modelId;
      const label = provider.modelOptions.find((model) => model.id === modelId)?.label ?? modelId;
      return routeDisplayLabel(provider.providerType, modelId, label);
    },
    [captureProviders],
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
  const [rewriteAiLane, setRewriteAiLane] = useState<DictationAiLaneReadiness>({ ready: null, message: null });
  const [rewriteAiLaneRequestKey, setRewriteAiLaneRequestKey] = useState<string | null>(null);
  const [rewriteProbeRevision, setRewriteProbeRevision] = useState(0);
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
  const captureRouteRequestEpochRef = useRef(0);
  useEffect(() => () => { captureRouteRequestEpochRef.current += 1; }, []);
  const refreshDictationRouteReadiness = useCallback(async () => {
    const request = ++captureRouteRequestEpochRef.current;
    try {
      const [settings, providers] = await Promise.all([
        getSettings(),
        getAsrProviders(),
      ]);
      if (captureRouteRequestEpochRef.current !== request) return;
      setCaptureSettings(settings);
      setCaptureProviders(providers);
      setDictationRouteReadiness(
        resolveDictationRouteReadiness(settings, providers),
      );
    } catch (error) {
      if (captureRouteRequestEpochRef.current !== request) return;
      // Keep whatever the last known answer was rather than inventing either
      // a blocker or an all-clear from a failed probe.
      console.warn("Failed to check the dictation route readiness:", error);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const retain = (stop: () => void) => { if (disposed) stop(); else unlisteners.push(stop); };
    void listen("readiness-invalidated", () => {
      if (!disposed) void refreshDictationRouteReadiness();
    }).then(retain).catch(error => console.warn("Could not observe dictation readiness changes:", error));
    void listen<[string, number]>("asr-download-progress", event => {
      const [, progress] = event.payload;
      if (!disposed && Number.isFinite(progress) && progress >= 100) void refreshDictationRouteReadiness();
    }).then(retain).catch(error => console.warn("Could not observe speech downloads:", error));
    return () => { disposed = true; unlisteners.forEach(stop => stop()); };
  }, [refreshDictationRouteReadiness]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      stopSpeakingText();
    };
  }, []);

  useEffect(() => {
    if (
      activeSpeechTarget?.startsWith("history-") &&
      (!isDialogOpen || activeSpeechTarget !== `history-${selectedRecording?.id ?? ""}`)
    ) {
      stopSpeakingText();
      setActiveSpeechTarget(null);
    }
  }, [activeSpeechTarget, isDialogOpen, selectedRecording?.id]);

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
      resolveDisplayedDictationHotkeyMode({
        shortcut: hotkeyShortcut,
        bindings: hotkeyBindings,
        pushToTalk: dictationPushToTalk,
        handsFreeEnabled: dictationHandsFreeEnabled,
      }),
    [dictationHandsFreeEnabled, dictationPushToTalk, hotkeyShortcut, hotkeyBindings],
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
  const isAwaitingDictationStart = dictationStarting &&
    (dictationPhase === "idle" || dictationPhase === "done" || dictationPhase === "error");
  const isDictationBusy =
    dictationStarting ||
    dictationPhase === "preparing" ||
    dictationPhase === "primed" ||
    dictationPhase === "recording" ||
    dictationPhase === "stopping" ||
    dictationPhase === "transcribing" ||
    dictationPhase === "delivering";

  const processingSessionId = typeof dictationStateEvent?.sessionId === "number"
    && Number.isSafeInteger(dictationStateEvent.sessionId) && dictationStateEvent.sessionId > 0
    ? dictationStateEvent.sessionId : null;
  const canCancelProcessing = processingSessionId !== null
    && (dictationStateEvent?.phase === "stopping" || dictationStateEvent?.phase === "transcribing");
  useEffect(() => {
    setProcessingCancelError((current) => current && (!canCancelProcessing || current.sessionId !== processingSessionId) ? null : current);
  }, [canCancelProcessing, processingSessionId]);

  const cancelProcessingDictation = async () => {
    const sessionId = processingSessionId;
    const current = currentDictationStateRef.current;
    if (sessionId === null || current?.sessionId !== sessionId
      || (current.phase !== "stopping" && current.phase !== "transcribing")
      || processingCancelPendingIdsRef.current.has(sessionId)) return;
    processingCancelPendingIdsRef.current.add(sessionId);
    setProcessingCancellingId(sessionId);
    setProcessingCancelError(null);
    try {
      await invoke("force_stop_dictation", { sessionId });
      // Runtime events own phase and text. A command acknowledgement alone
      // does not prove processing or native work has stopped.
    } catch {
      const latest = currentDictationStateRef.current;
      if (processingCancelMountedRef.current && latest?.sessionId === sessionId
        && (latest.phase === "stopping" || latest.phase === "transcribing")) {
        setProcessingCancelError({ sessionId, message: "Could not cancel this dictation. Try again." });
      }
    } finally {
      processingCancelPendingIdsRef.current.delete(sessionId);
      if (processingCancelMountedRef.current) {
        setProcessingCancellingId((pending) => pending === sessionId ? null : pending);
      }
    }
  };

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
      return dictationDictionaryEntries.length ? "All custom entries are disabled." : "No custom entries yet.";
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
      dictationAi: { provider: currentAiProvider ?? "", modelId: currentAiModelId },
      remoteProcessingEnabled,
    }).then((ready) => {
      if (mounted) {
        setDictationAiLaneReady(ready);
      }
    });
    return () => {
      mounted = false;
    };
  }, [currentAiModelId, currentAiProvider, remoteProcessingEnabled, rewriteProbeRevision]);
  useEffect(() => {
    let mounted = true;
    setRewriteAiLane({ ready: null, message: null });
    setRewriteAiLaneRequestKey(null);
    const requestKey = JSON.stringify([currentAiProvider?.trim() ?? "", currentAiModelId?.trim() || null, remoteProcessingEnabled, rewriteProbeRevision]);
    const probe =
      currentAiProvider === "ollama"
        ? probeOllamaRewriteReadiness(
            currentAiModelId,
            listOllamaModels,
            listOllamaModelCatalog,
            { remoteProcessingEnabled },
          )
        : probeDictationAiLaneReadiness({
            dictationAi: {
              provider: currentAiProvider ?? "",
              modelId: currentAiModelId,
            },
            remoteProcessingEnabled,
          });
    void probe.then((readiness) => {
      if (mounted) {
        setRewriteAiLane(readiness);
        setRewriteAiLaneRequestKey(requestKey);
      }
    });
    return () => {
      mounted = false;
    };
  }, [
    currentAiModelId,
    currentAiProvider,
    remoteProcessingEnabled,
    rewriteProbeRevision,
  ]);

  useEffect(() => {
    const refresh = () => setRewriteProbeRevision((revision) => revision + 1);
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<Settings>("settings-changed", (event) => {
      if (cancelled) return;
      void refreshDictationRouteReadiness();
      setCaptureSettings(event.payload);
      const transcription = event.payload.transcription;
      if (!externalCorrectionConsentChange.current.pending) {
        externalCorrectionConsentChange.current.revision += 1;
        setDictationLearnFromExternalCorrections(
          transcription.dictationLearnFromExternalCorrections ?? false,
        );
        setExternalCorrectionConsentStatus("idle");
      }
      setDictationModePreset(transcription.dictationModePreset ?? inferModePreset({
        profile: transcription.dictationProfile,
        insertionMode: (transcription.dictationInsertionMode as DictationInsertionMode | undefined) ?? "auto",
        contextSource: (transcription.dictationContextSource as DictationContextSource | undefined) ?? "none",
        saveToInbox: transcription.dictationSaveToInbox,
        commandModeEnabled: transcription.dictationCommandModeEnabled ?? false,
      }));
      setDictationProfile(transcription.dictationProfile);
      setSelectedCustomModeId(transcription.dictationSelectedCustomModeId ?? null);
      const modes = transcription.dictationCustomModes ?? [];
      // Preserve selected-profile identity on unrelated settings broadcasts,
      // so the profile editor does not replace a draft with the saved version.
      setDictationCustomModes((current) => {
        if (JSON.stringify(current) === JSON.stringify(modes)) return current;
        return modes.map((mode) => {
          const previous = current.find((item) => item.id === mode.id);
          return previous && JSON.stringify(previous) === JSON.stringify(mode) ? previous : mode;
        });
      });
      setCurrentAiProvider(event.payload.privacy.dictationAi?.provider ?? null);
      setCurrentAiModelId(event.payload.privacy.dictationAi?.modelId ?? null);
      setRemoteProcessingEnabled(
        event.payload.privacy.remoteProcessingEnabled ?? false,
      );
      refresh();
    }).then((stop) => {
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshDictationRouteReadiness]);
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
          approvalDictionary: suggestion.approvalDictionary,
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
  const pendingExternalCorrection = activeConfigTab === "corrections" ? null : externalCorrectionSuggestionGroups[0];
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
    const epoch = ++historyRequestEpochRef.current;
    cancelHistoryPreview();
    ++reprocessRequestEpochRef.current;
    ++processAgainRequestEpochRef.current;
    setIsReprocessing(reprocessRunRef.current !== null);
    setIsProcessingAgain(processAgainOperationRef.current !== null);
    setHistoryEditSaving(false);
    setHistorySavedEdit(null);
    setHistoryEditError(null);
    setHistoryEditStatus(null);
    historyEditRef.current = { draft: "", original: "", saved: null, loaded: false };
    setHistoryLoadError(null);
    if (!isDialogOpen || !selectedRecording) {
      setSelectedTranscript(null);
      setSelectedHistoryDetails(null);
      setReprocessedResult(null);
      setReprocessError(null);
      setHistoryCorrectionText("");
      historyQueuedCorrectionRef.current = null;
      setHistoryCorrectionBaseline("");
      setHistoryLearnStatus(null);
      return () => {
        ++historyRequestEpochRef.current;
        ++reprocessRequestEpochRef.current;
        ++processAgainRequestEpochRef.current;
      };
    }
    setIsLoadingTranscript(true);
    setSelectedTranscript(null);
    setSelectedHistoryDetails(null);
    setReprocessedResult(null);
    setReprocessError(null);
    setProcessAgainOutcome(null);
    setProcessAgainError(null);
    setProcessAgainRefreshWarning(null);
    setProcessAgainSpeechRoute("current");
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
        const [transcript, historyDetails, savedEdit] = await Promise.all([
          getTranscript(selectedRecording.id),
          getDictationHistoryDetails(selectedRecording.id),
          getDictationEdit(selectedRecording.id).then((edit): { text: string | null; loaded: true } => ({ text: typeof edit.text === "string" ? edit.text : null, loaded: true }))
            .catch((): { text: null; loaded: false } => ({ text: null, loaded: false })),
        ]);
        if (historyRequestEpochRef.current !== epoch) return;
        setSelectedTranscript(transcript);
        setSelectedHistoryDetails(historyDetails);
        const transcriptText = transcript?.fullText ?? "";
        const correctedText = savedEdit.text ?? transcriptText;
        historyEditRef.current = { draft: correctedText, original: transcriptText, saved: savedEdit.text, loaded: savedEdit.loaded };
        setHistorySavedEdit(savedEdit.text);
        setHistoryCorrectionText(correctedText);
        setHistoryCorrectionBaseline(transcriptText);
        if (!savedEdit.loaded) setHistoryEditError(HISTORY_SAVED_EDIT_READ_ERROR);
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
      } catch {
        if (historyRequestEpochRef.current !== epoch) return;
        setHistoryLoadError("Couldn't load this saved dictation. Try again.");
        setSelectedTranscript(null);
        setSelectedHistoryDetails(null);
      } finally {
        if (historyRequestEpochRef.current === epoch) setIsLoadingTranscript(false);
      }
    };
    void fetchTranscript();
    return () => {
      ++historyRequestEpochRef.current;
      ++reprocessRequestEpochRef.current;
      ++processAgainRequestEpochRef.current;
    };
  }, [
    dictationModePreset,
    isDialogOpen,
    historyLoadRevision,
    cancelHistoryPreview,
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
  const [historySearchResultQuery, setHistorySearchResultQuery] = useState<
    string | null
  >(null);
  const historySearchQueryRef = useRef("");
  const historySearchRevisionRef = useRef(0);
  const historySearchSourceRef = useRef(recordings);
  historySearchSourceRef.current = recordings;
  const pendingHistorySearchRef = useRef<{
    query: string;
    revision: number;
    source: Recording[];
  } | null>(null);
  const historyResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const trimmedHistorySearchQuery = historySearchQuery.trim();
  const handleHistorySearchChange = useCallback((value: string) => {
    const query = value.trim();
    historySearchRevisionRef.current += 1;
    historySearchQueryRef.current = query;
    pendingHistorySearchRef.current = null;
    setHistorySearchQuery(value);
    setHistorySearchResults(null);
    setHistorySearchError(null);
    setHistorySearchResultQuery(null);
    setHistorySearchPending(Boolean(query));
  }, []);
  const runHistorySearch = useCallback(
    (query: string, revision: number, source: Recording[]) => {
      const pending = pendingHistorySearchRef.current;
      if (
        pending?.query === query &&
        pending.revision === revision &&
        pending.source === source
      ) {
        return;
      }

      const request = { query, revision, source };
      pendingHistorySearchRef.current = request;
      setHistorySearchResults(null);
      setHistorySearchError(null);
      setHistorySearchResultQuery(null);
      setHistorySearchPending(true);
      void searchDictationHistory(query, { limit: 25 })
        .then((hits) => {
          if (
            historySearchRevisionRef.current !== revision ||
            historySearchQueryRef.current !== query ||
            historySearchSourceRef.current !== source
          ) {
            return;
          }
          setHistorySearchResults(hits);
          setHistorySearchError(null);
          setHistorySearchResultQuery(query);
        })
        .catch((error) => {
          if (
            historySearchRevisionRef.current !== revision ||
            historySearchQueryRef.current !== query ||
            historySearchSourceRef.current !== source
          ) {
            return;
          }
          setHistorySearchResults([]);
          setHistorySearchError(
            error instanceof Error ? error.message : String(error),
          );
          setHistorySearchResultQuery(query);
        })
        .finally(() => {
          if (pendingHistorySearchRef.current === request) {
            pendingHistorySearchRef.current = null;
          }
          if (
            historySearchRevisionRef.current === revision &&
            historySearchQueryRef.current === query &&
            historySearchSourceRef.current === source
          ) {
            setHistorySearchPending(false);
          }
        });
    },
    [],
  );
  useEffect(() => {
    if (!trimmedHistorySearchQuery) {
      setHistorySearchResults(null);
      setHistorySearchPending(false);
      setHistorySearchError(null);
      setHistorySearchResultQuery(null);
      return;
    }
    const revision = historySearchRevisionRef.current;
    const source = recordings;
    setHistorySearchResults(null);
    setHistorySearchError(null);
    setHistorySearchResultQuery(null);
    setHistorySearchPending(true);
    const timer = window.setTimeout(() => {
      runHistorySearch(trimmedHistorySearchQuery, revision, source);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (historySearchRevisionRef.current === revision) {
        historySearchRevisionRef.current += 1;
      }
    };
    // `recordings` is a dependency on purpose: a new or deleted dictation
    // re-runs the same query so the list never shows a stale hit.
  }, [trimmedHistorySearchQuery, recordings, runHistorySearch]);
  const visibleHistorySearchResults =
    historySearchResultQuery === trimmedHistorySearchQuery
      ? historySearchResults
      : null;
  const visibleHistorySearchError =
    historySearchResultQuery === trimmedHistorySearchQuery
      ? historySearchError
      : null;
  useEffect(() => {
    historyOpenRequestRef.current += 1;
    setIsOpeningHistoryEntry(false);
  }, [trimmedHistorySearchQuery]);
  const openHistoryEntry = async (recording: Recording, opener?: HTMLElement) => {
    const request = ++historyOpenRequestRef.current;
    setIsOpeningHistoryEntry(false);
    if (isDialogOpen && selectedRecording?.id !== recording.id && !await flushHistoryEdit()) return;
    if (historyOpenRequestRef.current !== request) return;
    historyReturnFocusRef.current = opener ?? null;
    ++historyRequestEpochRef.current;
    historyEditRef.current = { draft: "", original: "", saved: null, loaded: false };
    setSelectedTranscript(null);
    setHistoryCorrectionText("");
    setIsLoadingTranscript(true);
    setSelectedRecording(recording);
    setIsDialogOpen(true);
  };
  const openHistoryEntryById = async (recordingId: string, opener?: HTMLElement) => {
    const request = ++historyOpenRequestRef.current;
    const isCurrent = () => historyOpenRequestRef.current === request;
    setIsOpeningHistoryEntry(true);
    try {
      const recording = recordings.find((entry) => entry.id === recordingId)
        ?? await getRecording(recordingId);
      if (!isCurrent()) return;
      if (!recording || recording.sourceType !== "dictation") {
        toast("That saved dictation is no longer available.", "error");
        return;
      }
      openHistoryEntry(recording, opener);
    } catch {
      if (isCurrent()) toast("Couldn't open that saved dictation.", "error");
    } finally {
      if (isCurrent()) setIsOpeningHistoryEntry(false);
    }
  };
  const openHistoryEntryByIdRef = useRef(openHistoryEntryById);
  openHistoryEntryByIdRef.current = openHistoryEntryById;
  useEffect(() => {
    const openRequestedHistory = () => {
      const recordingId = consumePendingDictationHistoryRequest();
      if (recordingId) void openHistoryEntryByIdRef.current(recordingId);
    };
    window.addEventListener(OPEN_DICTATION_HISTORY_EVENT, openRequestedHistory);
    openRequestedHistory();
    return () => window.removeEventListener(OPEN_DICTATION_HISTORY_EVENT, openRequestedHistory);
  }, []);

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
    if (!lastDeliveryReceipt || lastDeliveryReceipt.context !== renderedLatestEditContext) return null;

    const paste = lastDeliveryReceipt.message.trim();
    const insertionUnconfirmed = lastDeliveryReceipt.kind === "unconfirmed";
    const insertionNeedsAttention = lastDeliveryReceipt.needsAttention;
    const requestedModelName = lastFallback
      ? speechProviderName(lastFallback.requestedProvider)
      : null;
    const actualModelName = lastFallback
      ? speechProviderName(lastFallback.actualProvider)
      : null;
    const fallback = lastFallback
      ? [
          requestedModelName && actualModelName
            ? `You chose ${requestedModelName}, so Plainsong used ${actualModelName} for this dictation.`
            : "Plainsong used a different speech model for this dictation.",
          (lastFallback.reason
            ? sanitizeUserFacingDictationMessage(lastFallback.reason, { phase: "done" })
            : null) ?? "",
        ].filter(Boolean).join(" ")
      : "";
    const tone: LastDictationTone = insertionNeedsAttention
      ? "insertion"
      : lastFallback
        ? "transcription"
        : resultWarnings.length > 0
          ? "note"
          : "ready";
    const nextAction = insertionUnconfirmed
      ? "Check the target field before inserting again. The text stays in your latest result."
      : insertionNeedsAttention
      ? lastDeliveryReceipt.kind === "copied"
        ? "Click the field you want, then paste. Your text stays in Plainsong."
        : "Use Copy result, click the field you want, then paste. Your text stays in Plainsong."
      : lastFallback
        ? requestedModelName
          ? `To use ${requestedModelName} next time, finish its setup in Settings > Models.`
          : "To use your chosen speech model next time, finish its setup in Settings > Models."
        : null;

    // One engine line, not four: the sidecar's own label already reads
    // "Engine · model", so the raw slug and the "provider/model" id it also
    // sends are the same fact twice more.
    // The model's own name comes first where the provider is known: the
    // sidecar's label pairs the engine's name with the raw model id.
    const receiptProvider = captureProviders.find(
      (provider) => provider.providerType === lastDeliveryReceipt.provider,
    );
    const engineLabel =
      (receiptProvider && lastDeliveryReceipt.modelId
        ? speechRouteName(receiptProvider, lastDeliveryReceipt.modelId)
        : null) ||
      lastDeliveryReceipt.providerModelLabel ||
      [speechProviderName(lastDeliveryReceipt.provider), lastDeliveryReceipt.modelId].filter(Boolean).join(" · ") ||
      null;
    // Only worth saying where it ran if that isn't where you asked it to run.
    const hostingDiffered =
      Boolean(lastResolvedHosting) &&
      Boolean(lastRoutePreference) &&
      lastResolvedHosting !== lastRoutePreference;

    const items: LastDictationDetail[] = [
      lastDeliveryReceipt.appTarget ? { label: "Target app", value: lastDeliveryReceipt.appTarget } : null,
      insertionModeUsed
        ? {
            label: "Delivery",
            value: formatInsertionModeLabel(insertionModeUsed) ?? insertionModeUsed,
          }
        : null,
      lastDeliveryReceipt.returnSent !== null
        ? { label: "Return", value: lastDeliveryReceipt.returnSent ? "Sent" : "Not sent" }
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
        ? { label: "Whole session", value: formatDurationMetric(endToEndMs) ?? "" }
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
            label: "Speech recognized",
            value: formatDurationMetric(finalTranscriptLatencyMs) ?? "",
          }
        : null,
      textReadyAfterStopMs !== null
        ? { label: "Text ready after stop", value: formatDurationMetric(textReadyAfterStopMs) ?? "" }
        : null,
      insertedAfterStopMs !== null
        ? { label: "Inserted after stop", value: formatDurationMetric(insertedAfterStopMs) ?? "" }
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
      lastDeliveryReceipt.activationMatcher ? { label: "Profile rule", value: lastDeliveryReceipt.activationMatcher } : null,
      lastDeliveryReceipt.contextChars !== null && lastDeliveryReceipt.contextChars > 0
        ? { label: "Context read", value: `${lastDeliveryReceipt.contextChars} characters` }
        : null,
    ].filter((item): item is LastDictationDetail => Boolean(item));

    return {
      tone,
      title:
        tone === "ready"
          ? lastDeliveryReceipt.kind === "preview"
            ? "Last dictation: preview ready"
            : lastDeliveryReceipt.kind === "copied"
              ? "Last dictation: copied to clipboard"
              : lastDeliveryReceipt.kind === "inserted"
                ? "Last dictation: inserted cleanly"
                : "Last dictation: result ready"
          : tone === "note"
            ? lastDeliveryReceipt.kind === "inserted"
              ? "Last dictation: inserted with a note"
              : "Last dictation: finished with a note"
          : tone === "transcription"
            ? "Last dictation: used a different speech model"
            : "Last dictation: insertion needs a look",
      detail:
        [paste, fallback, ...resultWarnings].filter(Boolean).join(" ") ||
        "Where the text came from, where it went, and how long it took.",
      nextAction,
      items,
    };
  }, [
    acknowledgementLatencyMs,
    captureProviders,
    commandApplied,
    captureReadyLatencyMs,
    endToEndMs,
    lastFallback,
    resultWarnings,
    speechProviderName,
    textReadyAfterStopMs,
    insertedAfterStopMs,
    finalTranscriptLatencyMs,
    firstStablePartialLatencyMs,
    insertLatencyMs,
    insertionModeUsed,
    lastResolvedHosting,
    lastRoutePreference,
    latencyMs,
    lastDeliveryReceipt,
    renderedLatestEditContext,
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
      setRouteDownloadError(describeModelDownloadError(error));
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
          settings.transcription.dictationCommandModeEnabled ?? false;
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
        setSpeechModelKeepReady(
          settings.transcription.speechModelKeepReady ?? "auto",
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
        if (externalCorrectionConsentChange.current.revision === 0) {
          setDictationLearnFromExternalCorrections(
            settings.transcription.dictationLearnFromExternalCorrections ?? false,
          );
        }
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
        setHotkeyBindings(settings.shortcuts.toggleDictation?.trim() ? settings.shortcuts.dictationBindings : undefined);
        const repasteShortcut = settings.shortcuts.repasteLastDictation?.trim();
        setRepasteShortcutLabel(
          repasteShortcut ? formatShortcutForDisplay(repasteShortcut) : null,
        );
      })
      .catch((error) => {
        console.warn("Failed to load dictation preferences:", error);
        if (mounted) {
          setHotkeyLabel(formatShortcutForDisplay(defaultShortcut));
        }
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
    void refreshCorrectionSuggestions(() => mounted);
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
      void refreshCorrectionSuggestions(() => !disposed);
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
      speechModelKeepReady: SpeechModelKeepReady;
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
      silenceTimeoutSeconds: number;
      retentionPreset: "immediate" | "24h" | "72h" | "never" | "custom";
      retentionCustomHours: number;
      keepAudio: boolean;
      categoryFormattingEnabled: boolean;
      appCategoryOverrides: DictationAppCategoryOverride[];
      numbersAsDigits: DictationNumbersAsDigitsMap;
      engineMode: DictationCustomMode;
    }>,
  ) => {
    const action = structuredClone(updates);
    try {
      await updateSettings((settings) => {
        const transcription = settings.transcription;
        if (action.saveToInbox !== undefined) transcription.dictationSaveToInbox = action.saveToInbox;
        if (action.profile !== undefined) transcription.dictationProfile = action.profile;
        if (action.selectedCustomModeId !== undefined) transcription.dictationSelectedCustomModeId = action.selectedCustomModeId;
        if (action.customModes !== undefined) transcription.dictationCustomModes = action.customModes;
        if (action.contextSource !== undefined) transcription.dictationContextSource = action.contextSource;
        if (action.projectId !== undefined) transcription.dictationProjectId = action.projectId;
        if (action.pushToTalk !== undefined) transcription.dictationPushToTalk = action.pushToTalk;
        if (action.handsFreeEnabled !== undefined) transcription.dictationHandsFreeEnabled = action.handsFreeEnabled;
        if (action.routePreference !== undefined) transcription.dictationRoutePreference = action.routePreference;
        if (action.routeOverrideEnabled !== undefined) transcription.dictationRouteOverrideEnabled = action.routeOverrideEnabled;
        if (action.keepWarm !== undefined) transcription.dictationKeepWarm = action.keepWarm;
        if (action.speechModelKeepReady !== undefined) transcription.speechModelKeepReady = action.speechModelKeepReady;
        if (action.livePreviewEnabled !== undefined) transcription.dictationLivePreviewEnabled = action.livePreviewEnabled;
        if (action.livePreviewEngine !== undefined) transcription.dictationLivePreviewEngine = action.livePreviewEngine;
        if (action.copyToClipboard !== undefined) transcription.dictationCopyToClipboard = action.copyToClipboard;
        if (action.commandModeEnabled !== undefined) transcription.dictationCommandModeEnabled = action.commandModeEnabled;
        if (action.commandPrefix !== undefined) transcription.dictationCommandPrefix = action.commandPrefix;
        if (action.insertionMode !== undefined) transcription.dictationInsertionMode = action.insertionMode;
        if (action.sessionLanguage !== undefined) transcription.language = action.sessionLanguage;
        if (action.snippetsEnabled !== undefined) transcription.dictationSnippetsEnabled = action.snippetsEnabled;
        if (action.autoLearnCorrections !== undefined) transcription.dictationAutoLearnCorrections = action.autoLearnCorrections;
        if (action.retentionPreset !== undefined) transcription.dictationRetentionPreset = action.retentionPreset;
        if (action.retentionCustomHours !== undefined) transcription.dictationRetentionCustomHours = action.retentionCustomHours;
        if (action.keepAudio !== undefined) transcription.dictationKeepAudio = action.keepAudio;
        if (action.categoryFormattingEnabled !== undefined) transcription.dictationCategoryFormattingEnabled = action.categoryFormattingEnabled;
        if (action.appCategoryOverrides !== undefined) transcription.dictationAppCategoryOverrides = action.appCategoryOverrides;
        if (action.numbersAsDigits !== undefined) transcription.dictationNumbersAsDigits = action.numbersAsDigits;
        if (action.activeLanguages !== undefined) {
          transcription.dictationActiveLanguages = normalizeActiveLanguageSet(action.activeLanguages, dictationLanguageCodes);
        }
        if (action.silenceTimeoutSeconds !== undefined) {
          transcription.dictationSilenceTimeoutSeconds = normalizeDictationSilenceTimeoutSeconds(action.silenceTimeoutSeconds);
        }
        if (action.modePreset !== undefined) {
          transcription.dictationModePreset = action.modePreset;
        } else if (
          action.profile !== undefined || action.insertionMode !== undefined ||
          action.contextSource !== undefined || action.saveToInbox !== undefined ||
          action.commandModeEnabled !== undefined
        ) {
          transcription.dictationModePreset = inferModePreset({
            profile: transcription.dictationProfile,
            insertionMode: transcription.dictationInsertionMode ?? "auto",
            contextSource: transcription.dictationContextSource ?? "none",
            saveToInbox: transcription.dictationSaveToInbox,
            commandModeEnabled: transcription.dictationCommandModeEnabled ?? false,
          });
        }
        const mode = action.engineMode;
        if (mode) {
          if (mode.dictationProvider) transcription.dictationProvider = mode.dictationProvider;
          if (mode.dictationModelId != null) transcription.dictationModelId = mode.dictationModelId;
          if (mode.aiProvider) settings.privacy.dictationAi.provider = mode.aiProvider;
          if (mode.aiModelId !== undefined) settings.privacy.dictationAi.modelId = mode.aiModelId;
        }
      });
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

  const persistExternalCorrectionConsent = async (enabled: boolean) => {
    const revision = externalCorrectionConsentChange.current.revision + 1;
    externalCorrectionConsentChange.current = { revision, pending: true };
    setDictationLearnFromExternalCorrections(enabled);
    setExternalCorrectionConsentStatus("saving");
    dismissExternalCorrectionCard();
    try {
      const confirmed = await setDictationExternalCorrectionLearning(enabled);
      if (externalCorrectionConsentChange.current.revision !== revision) return;
      setDictationLearnFromExternalCorrections(confirmed);
      setExternalCorrectionConsentStatus("idle");
    } catch (error) {
      if (externalCorrectionConsentChange.current.revision !== revision) return;
      console.warn("Failed to persist external correction consent:", error);
      try {
        const settings = await getSettings();
        if (externalCorrectionConsentChange.current.revision !== revision) return;
        setDictationLearnFromExternalCorrections(
          settings.transcription.dictationLearnFromExternalCorrections ?? false,
        );
        setExternalCorrectionConsentStatus("idle");
      } catch {
        if (externalCorrectionConsentChange.current.revision !== revision) return;
        setExternalCorrectionConsentStatus("unconfirmed");
      }
      toast("Couldn't save correction learning. Check the switch and try again.", "error");
    } finally {
      if (externalCorrectionConsentChange.current.revision === revision) {
        externalCorrectionConsentChange.current.pending = false;
      }
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
    // Kept across edits: the editor has no control for it, and dropping it
    // would silently turn a Voice Edit key back into plain dictation.
    voiceEdit: overrides?.voiceEdit ?? selectedCustomMode?.voiceEdit ?? false,
    activationAppMatcher:
      overrides && "activationAppMatcher" in overrides
        ? (overrides.activationAppMatcher ?? null)
        : (customModeDraft.activationAppMatcher.trim() || null),
    activationDomainMatcher:
      overrides && "activationDomainMatcher" in overrides
        ? (overrides.activationDomainMatcher ?? null)
        : (customModeDraft.activationDomainMatcher.trim() || null),
  });

  const applySavedCustomMode = (mode: DictationCustomMode) => {
    // A profile saved before `paste`/`inline` were retired still carries one
    // until the sidecar rewrites settings.json, and feeding that straight into
    // the picker shows a value with no matching option.
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
      engineMode: mode,
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
      engineMode: nextMode,
      modePreset: "custom",
      selectedCustomModeId: nextMode.id,
      customModes: nextModes,
      profile: nextMode.profile,
      insertionMode: nextMode.insertionMode,
      contextSource: nextMode.contextSource,
      saveToInbox: nextMode.saveToInbox,
      copyToClipboard: nextMode.copyToClipboard,
      commandModeEnabled: nextMode.commandModeEnabled,
      routePreference: nextMode.routePreference ?? undefined,
      livePreviewEnabled:
        nextMode.livePreviewEnabled ?? dictationLivePreviewEnabled,
    });
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
      voiceEdit: style.voiceEdit ?? false,
    });
    const nextModes = dictationCustomModes.some(
      (mode) => mode.id === nextMode.id,
    )
      ? dictationCustomModes.map((mode) =>
          mode.id === nextMode.id ? nextMode : mode,
        )
      : [...dictationCustomModes, nextMode];

    if (nextMode.voiceEdit) {
      // Voice Edit is a second key, never the main one: making it the active
      // profile would turn every ordinary dictation into an instruction.
      setDictationCustomModes(nextModes);
      await persistDictationPreferences({ customModes: nextModes });
      toast(
        "Voice Edit is installed. Give it its own key in Settings, Shortcuts, then select text and say what to change.",
        "success",
      );
      return;
    }

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
      engineMode: nextMode,
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

  // Updated at commit, so a press right after the missing-model banner
  // appears is judged by that banner. A listener re-registered by a passive
  // effect could still hold the previous render's readiness.
  const hotkeyFeedbackRef = useRef({ dictationRouteReadiness, hotkeyShortcut });
  useLayoutEffect(() => {
    hotkeyFeedbackRef.current = { dictationRouteReadiness, hotkeyShortcut };
  }, [dictationRouteReadiness, hotkeyShortcut]);

  useEffect(() => {
    // Listen for hotkey visual feedback
    const handleKeyDown = (e: KeyboardEvent) => {
      const { dictationRouteReadiness, hotkeyShortcut } = hotkeyFeedbackRef.current;
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
  }, [toast]);

  useEffect(() => {
    if (!dictationStateEvent) {
      return;
    }

    const payload = dictationStateEvent;
    if (typeof payload.sessionId === "number" && Number.isSafeInteger(payload.sessionId) && payload.sessionId > 0) {
      if (observedDictationSessionRef.current !== payload.sessionId) setContextChars(null);
      observedDictationSessionRef.current = payload.sessionId;
      const pending = pendingDictationStartRef.current;
      if (pending && pending.sessionId === null && payload.phase === "preparing") {
        pending.sessionId = payload.sessionId;
      }
    }
    if (payload.phase === "preparing") {
      ++latestResultRevisionRef.current;
      setContextChars(null);
    }
    setDictationPhase(payload.phase);
    setDictationPhaseMessage(payload.message ?? null);
    setDictationPhasePreview(payload.preview ?? payload.partialText ?? null);
    setDictationResolvedModeLabel(payload.resolvedModeLabel ?? null);
    setAppTarget(payload.appTarget ?? null);
    setActivationMatcher(payload.activationMatcher ?? null);
    if (payload.phase === "error") {
    }
  }, [dictationStateEvent]);

  useEffect(() => {
    if (!dictationTextReadyEvent || consumedDictationTextReadyRef.current === dictationTextReadyEvent) {
      return;
    }
    consumedDictationTextReadyRef.current = dictationTextReadyEvent;

    const payload = dictationTextReadyEvent;
    ++dictationControlEpochRef.current;
    const text = payload.text ?? "";
    if (text) {
      ++latestResultRevisionRef.current;
      ++latestCorrectionEpochRef.current;
      setLatestResultOrigin("capture");
      const id = typeof payload.recordingId === "string" ? payload.recordingId : null;
      latestEditContextRef.current = { id, original: text, saved: null, appTarget: payload.appTarget ?? null };
      setLatestEditTargetId(id);
      setLatestShortcutText(null);
      setLatestRawTranscript(typeof payload.rawTranscript === "string" ? payload.rawTranscript : null);
      const original = typeof payload.rawTranscript === "string" ? payload.rawTranscript : "";
      const words = recognitionWordsToReview(payload.recognitionReviewWords, original);
      const hasCurrentSession = typeof payload.sessionId === "number" && Number.isSafeInteger(payload.sessionId) &&
        payload.sessionId > 0 && (observedDictationSessionRef.current === null || observedDictationSessionRef.current === payload.sessionId);
      setLatestRecognitionReview(hasCurrentSession && original.trim() && words.length > 0
        ? { context: latestEditContextRef.current, words, original } : null);
      setLatestShortcutPreparing(false);
      setLatestSavedEdit(null);
      setLatestEditSaving(false);
      setLatestEditStatus(null);
      setLatestEditError(null);
      setTranscribedText(text);
      latestQueuedCorrectionRef.current = null;
      setLatestCorrectionBaseline(text);
      setLatestResultDirty(false);
      setLatestLearnStatus(null);
    }
    // Decided from the sidecar's own fallback flag, not from keywords in its
    // messages; `fallbackMessage` is only ever set alongside it.
    if (payload.isFallback === true || payload.fallbackMessage) {
      setLastFallback({
        requestedProvider: payload.requestedProvider ?? null,
        actualProvider: payload.actualProvider ?? null,
        reason: payload.fallbackReason?.trim() || null,
      });
    } else {
      setLastFallback(null);
    }
    setLastRoutePreference(payload.routePreference ?? null);
    setLastResolvedHosting(payload.resolvedHosting ?? null);
    setStartupLatencyMs(payload.startupLatencyMs ?? null);
    setAcknowledgementLatencyMs(payload.acknowledgementLatencyMs ?? null);
    setCaptureReadyLatencyMs(payload.captureReadyLatencyMs ?? null);
    setFirstStablePartialLatencyMs(payload.firstStablePartialLatencyMs ?? null);
    setFinalTranscriptLatencyMs(payload.finalTranscriptLatencyMs ?? null);
    setResultWarnings(payload.warnings?.filter((warning) => warning.trim()) ?? []);
    setTextReadyAfterStopMs(payload.timing?.formatCompleteMs ?? payload.timing?.asrCompleteMs ?? null);
    const confirmedAfterStop = payload.timing?.insertionConfirmedMs;
    setInsertedAfterStopMs(
      payload.pasted === true && payload.timing?.insertionConfirmed === true
        && typeof confirmedAfterStop === "number" && Number.isFinite(confirmedAfterStop)
        && confirmedAfterStop >= 0 ? confirmedAfterStop : null,
    );
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
    const insertionUnconfirmed = payload.outcome === "paste_dispatched" ||
      (payload.pasted === true && payload.timing?.insertionConfirmed === false);
    const deliveryMessage =
      deliveryRefusal
        ? deliveryRefusal.message
        : insertionUnconfirmed
          ? "Plainsong couldn't confirm the text landed. Check the field before inserting again."
          : payload.outcome === "copied_instead"
          ? `Couldn't insert into ${payload.appTarget ?? "the app"}, so the text is on your clipboard. Press Cmd+V to paste it.`
          : payload.pasted
          ? leftOnClipboard
            ? "Inserted into the target app and copied to the clipboard."
            : "Inserted into the target app."
          : leftOnClipboard
            ? "Copied to the clipboard and ready to paste."
            : payload.pasteError
              ? "Text kept in Plainsong. Use Copy result to paste it where you want."
              : "Result is ready to review.";
    setDictationPhaseMessage(
      [deliveryMessage, ...(payload.warnings ?? [])].filter((message) => message.trim()).join(" "),
    );
    setLastDeliveryReceipt(text.trim() ? {
      context: latestEditContextRef.current,
      appTarget: payload.appTarget ?? null,
      returnSent: payload.submitAfterInsertSent ?? null,
      activationMatcher: payload.activationMatcher ?? null,
      provider: payload.actualProvider ?? null,
      modelId: payload.modelId ?? null,
      providerModelLabel: payload.providerModelLabel ?? null,
      contextChars: payload.contextChars ?? null,
      kind: deliveryRefusal ? "refused"
        : insertionUnconfirmed ? "unconfirmed"
        : payload.pasted ? "inserted"
        : leftOnClipboard ? "copied"
        : payload.outcome === "previewed" || String(payload.insertionModeUsed) === "preview" ? "preview"
        : "ready",
      message: payload.pasteError?.trim() || (insertionUnconfirmed
        ? "Paste command sent; delivery unconfirmed"
        : payload.pasted
          ? leftOnClipboard ? "Paste command sent (also copied to clipboard)" : "Paste command sent"
          : leftOnClipboard ? "Copied to clipboard"
          : deliveryRefusal ? "Text was kept in Plainsong."
          : ""),
      needsAttention: Boolean(
        deliveryRefusal || insertionUnconfirmed || payload.pasteError || payload.outcome === "copied_instead",
      ),
    } : null);
    setDictationPhasePreview(text || null);
    setPasteStatus(null);
    void refetchDictationHistory();
    void refreshDictationInsights();
  }, [dictationTextReadyEvent, refetchDictationHistory]);

  const handleStopDictation = async () => {
    const resultRevision = latestResultRevisionRef.current;
    const controlEpoch = ++dictationControlEpochRef.current;
    const sessionId = observedDictationSessionRef.current;
    const isCurrent = () => dictationControlEpochRef.current === controlEpoch
      && (sessionId === null || observedDictationSessionRef.current === sessionId);
    try {
      if (dictationPhase === "preparing") {
        if (sessionId === null) await invoke("force_stop_dictation");
        else await invoke("force_stop_dictation", { sessionId });
        return;
      }
      const text = await stopDictation();
      // The text-ready event or a newer edit owns the editor once it arrives.
      // Keep the return value only as a fallback when nothing has replaced it.
      if (text?.trim() && isCurrent() && latestResultRevisionRef.current === resultRevision) {
        ++latestResultRevisionRef.current;
        ++latestCorrectionEpochRef.current;
        setLatestResultOrigin("capture");
        latestEditContextRef.current = { id: null, original: text, saved: null };
        setLatestEditTargetId(null);
        setLatestShortcutText(null);
        setLatestRawTranscript(null);
        setLatestShortcutPreparing(false);
        setLatestSavedEdit(null);
        setLatestEditSaving(false);
        setLatestEditStatus(null);
        setLatestEditError(null);
        setTranscribedText(text);
        latestQueuedCorrectionRef.current = null;
        setLatestCorrectionBaseline(text);
        setLatestResultDirty(false);
        setLatestLearnStatus(null);
        void refetchDictationHistory();
      }
    } catch (error) {
      if (!isCurrent()) return;
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
    if (meetingOwnsCaptureRef.current || pendingDictationStartRef.current || isDictationBusy || isDictationCaptureLive) return;
    if (captureReadiness.state !== "ready") {
      const message =
        captureReadiness.cause?.message ??
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
    ++latestResultRevisionRef.current;
    const controlEpoch = ++dictationControlEpochRef.current;
    const pending = { sessionId: null as number | null };
    pendingDictationStartRef.current = pending;
    setDictationStarting(true);
    try {
      await startDictation({
        // This button is clicked in Plainsong. Keep the result here; the
        // global shortcut starts system delivery from the destination app.
        deliveryMode: "preview",
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
      if (dictationControlEpochRef.current !== controlEpoch
        || (pending.sessionId !== null && observedDictationSessionRef.current !== pending.sessionId)) return;
      const message =
        sanitizeUserFacingDictationMessage(
          error instanceof Error ? error.message : String(error),
          { phase: "error" },
        ) ?? "Dictation failed.";
      setDictationPhase("error");
      setDictationPhaseMessage(message);
      setDictationPhasePreview(null);
    } finally {
      if (pendingDictationStartRef.current === pending) {
        pendingDictationStartRef.current = null;
        if (latestCopyMountedRef.current) setDictationStarting(false);
      }
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
    if (snippetAddPendingRef.current) return;
    const trigger = newSnippetTrigger.trim();
    const expansion = newSnippetExpansion.trim();
    if (!trigger || !expansion) {
      return;
    }
    const submittedRevision = newSnippetDraftRevisionRef.current;
    const submission = {
      trigger,
      expansion,
      appScope: newSnippetAppScope.trim() || null,
      caseSensitive: newSnippetCaseSensitive,
      enabled: true,
      ...(newSnippetCategoryScope !== "any"
        ? { categoryScope: newSnippetCategoryScope }
        : {}),
    };
    snippetAddPendingRef.current = true;
    setSnippetAdding(true);
    setSnippetAddError(null);
    try {
      const created = await createDictationSnippet(submission);
      setDictationSnippets((prev) => prev.some((snippet) => snippet.id === created.id)
        ? prev : [...prev, created]);
      if (newSnippetDraftRevisionRef.current === submittedRevision) {
        setNewSnippetTrigger("");
        setNewSnippetExpansion("");
        setNewSnippetAppScope("");
        setNewSnippetCaseSensitive(false);
        setNewSnippetCategoryScope("any");
      }
    } catch {
      setSnippetAddError("Add wasn't confirmed. Your local inputs are still here. Try again.");
    } finally {
      snippetAddPendingRef.current = false;
      setSnippetAdding(false);
    }
  };

  const markNewSnippetDraftChanged = () => {
    newSnippetDraftRevisionRef.current += 1;
    setSnippetAddError(null);
  };

  const markDictionaryDraftChanged = () => {
    dictionaryDraftRevisionRef.current += 1;
    setDictionaryAddStatus(null);
  };

  const submitDictionaryEntry = async (
    submission: DictionaryEntrySubmission,
    submittedRevision: number,
  ) => {
    if (dictionaryAddPendingRef.current) return;
    const request = {};
    const submissionKey = dictionarySubmissionKey(submission);
    dictionaryAddPendingRef.current = request;
    setIsAddingDictionaryEntry(true);
    setDictionaryAddStatus(null);
    try {
      const created = await createDictationDictionaryEntry({
        spokenForm: submission.spokenForm,
        replacement: submission.replacement,
        appScope: submission.appScope,
        caseSensitive: submission.caseSensitive,
        enabled: true,
        ...(submission.categoryScope !== "any"
          ? { categoryScope: submission.categoryScope }
          : {}),
      });
      setDictationDictionaryEntries((current) =>
        current.some((entry) => entry.id === created.id)
          ? current.map((entry) =>
              entry.id === created.id ? created : entry,
            )
          : [...current, created],
      );
      setFailedDictionarySubmissions((current) =>
        current.filter((failed) => failed.key !== submissionKey),
      );
      setDictionaryAddStatus(
        `Saved “${submission.spokenForm}” → “${submission.replacement}”.`,
      );
      if (dictionaryDraftRevisionRef.current === submittedRevision) {
        dictionaryDraftRevisionRef.current += 1;
        setNewDictionarySpokenForm("");
        setNewDictionaryReplacement("");
        setNewDictionaryAppScope("");
        setNewDictionaryCaseSensitive(false);
        setNewDictionaryCategoryScope("any");
      }
    } catch (error) {
      console.warn("Failed to create dictation dictionary entry:", error);
      setFailedDictionarySubmissions((current) => {
        const failed = {
          key: submissionKey,
          submission,
          revision: submittedRevision,
          message: `Save wasn't confirmed for “${submission.spokenForm}” → “${submission.replacement}”.`,
        };
        const existingIndex = current.findIndex(
          (entry) => entry.key === submissionKey,
        );
        return existingIndex === -1
          ? [...current, failed]
          : current.map((entry, index) =>
              index === existingIndex ? failed : entry,
            );
      });
      setDictionaryAddStatus(null);
    } finally {
      if (dictionaryAddPendingRef.current === request) {
        dictionaryAddPendingRef.current = null;
        setIsAddingDictionaryEntry(false);
      }
    }
  };

  const handleAddDictionaryEntry = async () => {
    const submission: DictionaryEntrySubmission = {
      spokenForm: newDictionarySpokenForm.trim(),
      replacement: newDictionaryReplacement.trim(),
      appScope: newDictionaryAppScope.trim() || null,
      caseSensitive: newDictionaryCaseSensitive,
      categoryScope: newDictionaryCategoryScope,
    };
    if (!submission.spokenForm || !submission.replacement) return;
    await submitDictionaryEntry(
      submission,
      dictionaryDraftRevisionRef.current,
    );
  };

  const handleRetryDictionaryEntry = async (failed: {
    submission: DictionaryEntrySubmission;
    revision: number;
  }) => {
    await submitDictionaryEntry(
      failed.submission,
      failed.revision,
    );
  };

  const handleDeleteDictionaryEntry = async (entryId: string) => {
    if (dictionaryEntryDeletePendingRef.current.has(entryId) || correctionInboxPendingRef.current) return;
    dictionaryEntryDeletePendingRef.current.add(entryId);
    setDictionaryEntryDeletingIds((current) => new Set(current).add(entryId));
    setDictionaryEntryDeleteFailures((current) => {
      const next = { ...current };
      delete next[entryId];
      return next;
    });
    try {
      await deleteDictationDictionaryEntry(entryId);
      deletedDictionaryEntryIdsRef.current.add(entryId);
      setDictationDictionaryEntries((prev) =>
        prev.filter((entry) => entry.id !== entryId),
      );
      dictionaryEntryWriteQueuesRef.current.delete(entryId);
      dictionaryEntryFieldRevisionsRef.current.delete(entryId);
      dictionaryEntryUnconfirmedFieldsRef.current.delete(entryId);
      setDictionaryEntrySaveFailures((current) => {
        const next = { ...current };
        delete next[entryId];
        return next;
      });
    } catch (error) {
      console.warn("Failed to delete dictation dictionary entry:", error);
      setDictionaryEntryDeleteFailures((current) => ({
        ...current,
        [entryId]: "Removal wasn't confirmed. The entry and your local changes are still here. Try removing it again.",
      }));
    } finally {
      dictionaryEntryDeletePendingRef.current.delete(entryId);
      setDictionaryEntryDeletingIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
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
    const request = ++clipboardActionEpochRef.current;
    try {
      await navigator.clipboard.writeText(dictionaryCsvText);
      if (clipboardActionEpochRef.current === request) setDictionaryCsvStatus("Dictionary CSV copied.");
    } catch (error) {
      if (clipboardActionEpochRef.current !== request) return;
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

  async function drainCommandPresetWrites(commandKey: SelectedTextActionCommandPresetKey) {
    if (commandPresetWriteRunningRef.current.has(commandKey)) return;
    commandPresetWriteRunningRef.current.add(commandKey);
    const queue = commandPresetWriteQueuesRef.current.get(commandKey) ?? [];
    try {
      while (queue.length > 0) {
        const request = queue[0];
        try {
          const updated = request.reset
            ? (await deleteDictationCommandPreset(commandKey), null)
            : await upsertDictationCommandPreset({
                commandKey, systemPrompt: request.systemPrompt, enabled: request.enabled,
              });
          if (commandPresetRevisionsRef.current.get(commandKey) === request.revision) {
            setDictationCommandPresets((current) => {
              const others = current.filter((preset) => preset.commandKey !== commandKey);
              return updated ? [...others, updated] : others;
            });
            setCommandPresetSaveStates((current) => ({
              ...current, [commandKey]: { pending: queue.length > 1 },
            }));
          }
        } catch {
          console.warn("Failed to persist command preset.");
          setCommandPresetSaveStates((current) => ({
            ...current,
            [commandKey]: { ...current[commandKey], pending: queue.length > 1,
              failure: request.reset ? "reset" : "save", unsaved: true },
          }));
        } finally {
          queue.shift();
        }
      }
    } finally {
      commandPresetWriteRunningRef.current.delete(commandKey);
      commandPresetWriteQueuesRef.current.delete(commandKey);
      setCommandPresetSaveStates((current) => ({
        ...current, [commandKey]: { ...current[commandKey], pending: false },
      }));
    }
  }

  const enqueueCommandPresetWrite = (
    commandKey: SelectedTextActionCommandPresetKey,
    systemPrompt: string,
    enabled: boolean,
    reset = false,
  ) => {
    const revision = (commandPresetRevisionsRef.current.get(commandKey) ?? 0) + 1;
    commandPresetRevisionsRef.current.set(commandKey, revision);
    const queue = commandPresetWriteQueuesRef.current.get(commandKey) ?? [];
    queue.push({ revision, systemPrompt, enabled, reset });
    commandPresetWriteQueuesRef.current.set(commandKey, queue);
    setCommandPresetSaveStates((current) => ({
      ...current, [commandKey]: { ...current[commandKey], pending: true },
    }));
    void drainCommandPresetWrites(commandKey);
  };

  const upsertCommandPreset = (
    commandKey: SelectedTextActionCommandPresetKey,
    systemPrompt: string,
    enabled: boolean,
  ) => enqueueCommandPresetWrite(commandKey, systemPrompt, enabled);

  const resetCommandPreset = (commandKey: SelectedTextActionCommandPresetKey) =>
    enqueueCommandPresetWrite(commandKey, "", true, true);

  const setCommandPresetDraft = (
    commandKey: SelectedTextActionCommandPresetKey,
    updates: Partial<Pick<DictationCommandPreset, "systemPrompt" | "enabled">>,
  ) => {
    commandPresetRevisionsRef.current.set(commandKey,
      (commandPresetRevisionsRef.current.get(commandKey) ?? 0) + 1);
    setCommandPresetSaveStates((current) => ({
      ...current, [commandKey]: { ...current[commandKey], unsaved: true },
    }));
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

  const updateSnippetDraft = (snippetId: string, updates: SnippetPatch) => {
    const revisions = snippetFieldRevisionsRef.current.get(snippetId) ?? {};
    for (const field of Object.keys(updates) as SnippetField[]) {
      revisions[field] = (revisions[field] ?? 0) + 1;
    }
    snippetFieldRevisionsRef.current.set(snippetId, revisions);
    setDictationSnippets((current) => current.map((snippet) =>
      snippet.id === snippetId ? { ...snippet, ...updates } : snippet,
    ));
  };

  async function drainSnippetWrites(snippetId: string) {
    if (snippetWriteRunningRef.current.has(snippetId)) return;
    snippetWriteRunningRef.current.add(snippetId);
    const queue = snippetWriteQueuesRef.current.get(snippetId)!;
    const unconfirmed = snippetUnconfirmedFieldsRef.current.get(snippetId) ?? new Set<SnippetField>();
    snippetUnconfirmedFieldsRef.current.set(snippetId, unconfirmed);
    try {
      while (queue.length > 0) {
        const request = queue[0];
        try {
          const updated = await updateDictationSnippet(snippetId, request.updates);
          setDictationSnippets((current) => current.map((snippet) => {
            if (snippet.id !== snippetId) return snippet;
            const next = { ...snippet, updatedAt: updated.updatedAt };
            const revisions = snippetFieldRevisionsRef.current.get(snippetId) ?? {};
            for (const field of Object.keys(request.updates) as SnippetField[]) {
              if (revisions[field] === request.revisions[field]) {
                Object.assign(next, { [field]: updated[field] });
              }
            }
            return next;
          }));
          const revisions = snippetFieldRevisionsRef.current.get(snippetId) ?? {};
          for (const field of Object.keys(request.updates) as SnippetField[]) {
            if (revisions[field] === request.revisions[field]) unconfirmed.delete(field);
            else unconfirmed.add(field);
          }
        } catch {
          console.warn("Failed to update dictation snippet.");
          for (const field of Object.keys(request.updates) as SnippetField[]) unconfirmed.add(field);
        } finally {
          queue.shift();
          setSnippetSaveStates((current) => ({ ...current,
            [snippetId]: { pending: queue.length > 0, failed: unconfirmed.size > 0 },
          }));
        }
      }
    } finally {
      snippetWriteRunningRef.current.delete(snippetId);
      snippetWriteQueuesRef.current.delete(snippetId);
    }
  }

  const patchSnippet = (snippetId: string, updates: SnippetPatch) => {
    updateSnippetDraft(snippetId, updates);
    const revisions = { ...snippetFieldRevisionsRef.current.get(snippetId) };
    const queue = snippetWriteQueuesRef.current.get(snippetId) ?? [];
    queue.push({ updates, revisions });
    snippetWriteQueuesRef.current.set(snippetId, queue);
    setSnippetSaveStates((current) => ({ ...current,
      [snippetId]: { pending: true, failed: current[snippetId]?.failed ?? false },
    }));
    void drainSnippetWrites(snippetId);
  };

  const updateDictionaryEntryDraft = <Field extends DictionaryEntryEditableField>(
    entryId: string,
    field: Field,
    value: DictationDictionaryEntry[Field],
  ) => {
    if (correctionInboxPendingRef.current) return;
    const revisions = dictionaryEntryFieldRevisionsRef.current.get(entryId) ?? {};
    revisions[field] = (revisions[field] ?? 0) + 1;
    dictionaryEntryFieldRevisionsRef.current.set(entryId, revisions);
    setDictationDictionaryEntries((prev) =>
      prev.map((entry) =>
        entry.id === entryId ? { ...entry, [field]: value } : entry,
      ),
    );
  };

  async function drainDictionaryEntryWrites(entryId: string) {
    if (dictionaryEntryWriteRunningRef.current.has(entryId)) return;
    dictionaryEntryWriteRunningRef.current.add(entryId);
    const queue = dictionaryEntryWriteQueuesRef.current.get(entryId) ?? [];
    try {
      while (queue.length > 0) {
        const request = queue[0];
        try {
          const updated = await updateDictationDictionaryEntry(
            entryId,
            request.updates,
          );
          if (deletedDictionaryEntryIdsRef.current.has(entryId)) {
            queue.length = 0;
            continue;
          }
          setDictationDictionaryEntries((current) =>
            current.map((entry) => {
              if (entry.id !== entryId) return entry;
              const next = {
                ...entry,
                createdAt: updated.createdAt,
                updatedAt: updated.updatedAt,
              };
              const revisions =
                dictionaryEntryFieldRevisionsRef.current.get(entryId) ?? {};
              for (const field of Object.keys(
                request.updates,
              ) as DictionaryEntryEditableField[]) {
                if (revisions[field] === request.revisions[field]) {
                  Object.assign(next, { [field]: updated[field] });
                }
              }
              return next;
            }),
          );
          const currentRevisions =
            dictionaryEntryFieldRevisionsRef.current.get(entryId) ?? {};
          const unconfirmedFields =
            dictionaryEntryUnconfirmedFieldsRef.current.get(entryId) ?? {};
          for (const field of Object.keys(request.updates) as DictionaryEntryEditableField[]) {
            if (currentRevisions[field] === request.revisions[field]) {
              delete unconfirmedFields[field];
            } else if (request.retry) {
              // A full retry must also leave newer, unsaved drafts recoverable.
              unconfirmedFields[field] = currentRevisions[field];
            }
          }
          dictionaryEntryUnconfirmedFieldsRef.current.set(entryId, unconfirmedFields);
          if (Object.keys(unconfirmedFields).length === 0) {
            setDictionaryEntrySaveFailures((current) => {
              const next = { ...current };
              delete next[entryId];
              return next;
            });
          }
        } catch (error) {
          console.warn("Failed to update dictation dictionary entry:", error);
          if (!deletedDictionaryEntryIdsRef.current.has(entryId)) {
            const unconfirmedFields =
              dictionaryEntryUnconfirmedFieldsRef.current.get(entryId) ?? {};
            for (const field of Object.keys(request.updates) as DictionaryEntryEditableField[]) {
              unconfirmedFields[field] = request.revisions[field];
            }
            dictionaryEntryUnconfirmedFieldsRef.current.set(entryId, unconfirmedFields);
            setDictionaryEntrySaveFailures((current) => ({
              ...current,
              [entryId]: "Save wasn't confirmed. Your local changes are still here.",
            }));
          }
        } finally {
          queue.shift();
          if (request.retry) {
            setDictionaryEntryRetryingIds((current) => {
              const next = new Set(current);
              next.delete(entryId);
              return next;
            });
          }
        }
      }
    } finally {
      dictionaryEntryWriteRunningRef.current.delete(entryId);
      dictionaryEntryWriteQueuesRef.current.delete(entryId);
    }
  }

  const patchDictionaryEntry = (
    entryId: string,
    updates: DictionaryEntryPatch,
    options: { retry?: boolean } = {},
  ) => {
    if (correctionInboxPendingRef.current) return;
    const revisions = dictionaryEntryFieldRevisionsRef.current.get(entryId) ?? {};
    const submittedRevisions: DictionaryEntryWriteRequest["revisions"] = {};
    for (const field of Object.keys(updates) as DictionaryEntryEditableField[]) {
      revisions[field] = (revisions[field] ?? 0) + 1;
      submittedRevisions[field] = revisions[field];
    }
    dictionaryEntryFieldRevisionsRef.current.set(entryId, revisions);
    setDictationDictionaryEntries((current) =>
      current.map((entry) =>
        entry.id === entryId ? { ...entry, ...updates } : entry,
      ),
    );
    const queue = dictionaryEntryWriteQueuesRef.current.get(entryId) ?? [];
    queue.push({
      updates: { ...updates },
      revisions: submittedRevisions,
      retry: options.retry === true,
    });
    dictionaryEntryWriteQueuesRef.current.set(entryId, queue);
    void drainDictionaryEntryWrites(entryId);
  };

  const retryDictionaryEntrySave = (entryId: string) => {
    if (dictionaryEntryWriteQueuesRef.current.get(entryId)?.some((write) => write.retry)) {
      return;
    }
    const entry = dictationDictionaryEntriesRef.current.find(
      (current) => current.id === entryId,
    );
    if (!entry) return;
    setDictionaryEntryRetryingIds((current) => new Set(current).add(entryId));
    patchDictionaryEntry(
      entryId,
      {
        spokenForm: entry.spokenForm.trim(),
        replacement: entry.replacement.trim(),
        appScope: entry.appScope?.trim() || null,
        caseSensitive: entry.caseSensitive,
        enabled: entry.enabled,
        categoryScope: entry.categoryScope ?? null,
      },
      { retry: true },
    );
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

  const refreshCorrectionSuggestions = async (isActive = () => true) => {
    const revision = ++correctionSuggestionsRevisionRef.current;
    try {
      const suggestions = await listDictationCorrectionSuggestions();
      if (!isActive() || revision !== correctionSuggestionsRevisionRef.current) return null;
      setDictationCorrectionSuggestions(suggestions);
      return true;
    } catch (error) {
      if (!isActive() || revision !== correctionSuggestionsRevisionRef.current) return null;
      console.warn(
        "Failed to refresh dictation correction suggestions:",
        error,
      );
      return false;
    }
  };

  const handleRefreshCorrectionSuggestions = async () => {
    if (correctionInboxPendingRef.current) return;
    correctionInboxPendingRef.current = true;
    setCorrectionInboxBusy(true);
    try {
      const refreshed = await refreshCorrectionSuggestions();
      if (refreshed !== null) {
        setCorrectionApprovalError(refreshed ? null : "Couldn't refresh corrections. Try again.");
      }
    } finally {
      correctionInboxPendingRef.current = false;
      setCorrectionInboxBusy(false);
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

    ++correctionSuggestionsRevisionRef.current;
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
      `${result.action === "updated" ? "Updated" : "Queued"} for review: ${result.spokenForm} → ${result.replacement}`,
    );
    return true;
  };

  const showCorrectionApprovalNotice = (
    result: LearnDictationCorrectionResult,
    fallbackKey: string,
    trigger?: HTMLButtonElement,
  ) => {
    const label = `${result.spokenForm} → ${result.replacement}`;
    const message = `${result.action === "updated" ? "Updated" : "Learned"}: ${label}`;
    const key = result.undoToken ?? fallbackKey;
    if (!result.entry) return { key, message };
    if (trigger && document.activeElement === trigger) {
      correctionApprovalFocusRef.current = { key, target: result.undoToken ? "undo" : "notice", trigger };
    }
    const entry = result.entry;
    setCorrectionApprovalNotices((prev) => [...prev, { key, label, message,
      undoToken: result.undoToken ?? null, entry, error: null }].slice(-32));
    return { key, message };
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
    ++correctionActionEpochRef.current;
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

      ++correctionSuggestionsRevisionRef.current;
      ++correctionActionEpochRef.current;
      syncLearnedDictionaryEntry(result);
      if (result.undoToken) showCorrectionApprovalNotice(result, result.undoToken);
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
        `${result.action === "updated" ? "Updated" : "Learned"}: ${result.spokenForm} → ${result.replacement}`,
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
    const actionEpoch = correctionActionEpochRef.current;
    const setStatus = options?.setStatus ?? (() => {});
    try {
      const result = await queueDictationCorrectionSuggestion({
        originalText,
        correctedText,
        appTarget: options?.appTarget ?? null,
        force: false,
      });

      if (actionEpoch !== correctionActionEpochRef.current) return false;
      const queued = syncQueuedCorrectionSuggestion(result, setStatus);
      if (queued) {
        options?.onSuccess?.();
      }
      return queued;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (actionEpoch === correctionActionEpochRef.current) setStatus(message);
      return false;
    }
  };

  const sameDictionaryEntry = (left: DictationDictionaryEntry | undefined, right: DictationDictionaryEntry) =>
    Boolean(left && left.id === right.id && left.spokenForm === right.spokenForm
      && left.replacement === right.replacement && (left.appScope ?? null) === (right.appScope ?? null)
      && left.caseSensitive === right.caseSensitive && left.enabled === right.enabled
      && (left.categoryScope ?? null) === (right.categoryScope ?? null)
      && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt);

  const handleApproveCorrectionGroups = async (groups: string[][], trigger?: HTMLButtonElement) => {
    if (correctionInboxPendingRef.current || !groups.some((ids) => ids.length)) return;
    if (dictionaryEntryWriteRunningRef.current.size || dictionaryEntryDeletePendingRef.current.size
      || [...dictionaryEntryUnconfirmedFieldsRef.current.values()].some((fields) => Object.keys(fields).length)) {
      toast("Finish saving or resolve dictionary changes before approving corrections.", "error");
      return;
    }
    correctionInboxPendingRef.current = true;
    correctionApprovalFocusRef.current = null;
    setCorrectionApprovalError(null);
    setCorrectionInboxBusy(true);
    const acknowledgedEntries = new Map<string, DictationDictionaryEntry>();
    try {
      for (const [firstSuggestionId, ...duplicateIds] of groups.filter((ids) => ids.length)) {
        const suggestion = dictationCorrectionSuggestions.find((entry) => entry.id === firstSuggestionId);
        if (!suggestion?.approvalDictionary) {
          throw new Error("Refresh corrections before approving this suggestion.");
        }
        const priorEntries = new Map(dictationDictionaryEntriesRef.current.map((entry) => [entry.id, entry]));
        const result = await approveDictationCorrectionSuggestion(firstSuggestionId, suggestion.approvalDictionary);
        if (!result.learned || !result.entry) throw new Error(result.reason ?? "Correction was not learned.");
        ++correctionSuggestionsRevisionRef.current;
        ++correctionActionEpochRef.current;
        const learnedEntry = result.entry;
        const expectedPrevious = acknowledgedEntries.get(learnedEntry.id) ?? priorEntries.get(learnedEntry.id) ?? learnedEntry;
        setDictationDictionaryEntries((prev) => {
          const current = prev.find((entry) => entry.id === learnedEntry.id);
          if (current && !sameDictionaryEntry(current, expectedPrevious)) return prev;
          return current ? prev.map((entry) => entry.id === learnedEntry.id ? learnedEntry : entry)
            : [...prev, learnedEntry].sort((left, right) => compareStrings(left.spokenForm, right.spokenForm));
        });
        acknowledgedEntries.set(learnedEntry.id, learnedEntry);
        setDictationCorrectionSuggestions((prev) => prev.filter((s) => s.id !== firstSuggestionId));
        const { key, message } = showCorrectionApprovalNotice(result, firstSuggestionId, trigger);
        setDictionaryCsvStatus(message);
        for (const suggestionId of duplicateIds) {
          try {
            await rejectDictationCorrectionSuggestion(suggestionId);
            ++correctionSuggestionsRevisionRef.current;
            ++correctionActionEpochRef.current;
            setDictationCorrectionSuggestions((prev) => prev.filter((s) => s.id !== suggestionId));
          } catch {
            setCorrectionApprovalNotices((prev) => prev.map((notice) => notice.key === key
              ? { ...notice, message: `${message}. Some duplicate suggestions could not be removed.` } : notice));
            break;
          }
        }
      }
    } catch (error) {
      const message = `Approval stopped: ${error instanceof Error ? error.message : String(error)}. Previously learned corrections remain available to undo.`;
      setDictionaryCsvStatus(message);
      setCorrectionApprovalError(message);
      toast("Couldn't finish approving corrections. Review the remaining suggestions.", "error");
    } finally {
      correctionInboxPendingRef.current = false;
      setCorrectionInboxBusy(false);
    }
  };

  const handleApproveCorrectionSuggestionGroup = (suggestionIds: string[], trigger: HTMLButtonElement) =>
    handleApproveCorrectionGroups([suggestionIds], trigger);

  const handleUndoCorrectionApproval = async (notice: typeof correctionApprovalNotices[number], trigger: HTMLButtonElement) => {
    if (!notice.undoToken || correctionInboxPendingRef.current) return;
    const entryId = notice.entry.id;
    const current = dictationDictionaryEntriesRef.current.find((entry) => entry.id === entryId);
    if (!sameDictionaryEntry(current, notice.entry) || dictionaryEntryWriteRunningRef.current.has(entryId)
      || dictionaryEntryDeletePendingRef.current.has(entryId)
      || Object.keys(dictionaryEntryUnconfirmedFieldsRef.current.get(entryId) ?? {}).length) {
      setCorrectionApprovalNotices((prev) => prev.map((entry) => entry.key === notice.key
        ? { ...entry, error: "This entry has newer or unsaved changes. Undo would replace them." } : entry));
      return;
    }
    correctionInboxPendingRef.current = true;
    correctionApprovalFocusRef.current = null;
    setCorrectionUndoEntryId(entryId);
    setCorrectionInboxBusy(true);
    try {
      const result = await undoDictationCorrectionApproval(notice.undoToken);
      if (result.entryId !== entryId || (result.entry && result.entry.id !== entryId)) {
        throw new Error("Undo returned a different dictionary entry. Reopen the dictionary to review it.");
      }
      ++correctionSuggestionsRevisionRef.current;
      if (document.activeElement === trigger) {
        correctionApprovalFocusRef.current = { key: notice.key, target: "notice", trigger };
      }
      setDictationDictionaryEntries((prev) => prev.flatMap((entry) => entry.id !== entryId
        || !sameDictionaryEntry(entry, notice.entry) ? [entry] : result.entry ? [result.entry] : []));
      const message = `Undone: ${notice.label}`;
      setDictionaryCsvStatus((status) =>
        status === `Learned: ${notice.label}` || status === `Updated: ${notice.label}`
          ? message : status);
      setCorrectionApprovalNotices((prev) => prev.map((entry) => entry.key === notice.key
        ? { ...entry, undoToken: null, error: null, message } : entry));
    } catch (error) {
      setCorrectionApprovalNotices((prev) => prev.map((entry) => entry.key === notice.key
        ? { ...entry, error: error instanceof Error ? error.message : String(error) } : entry));
    } finally {
      correctionInboxPendingRef.current = false;
      setCorrectionUndoEntryId(null);
      setCorrectionInboxBusy(false);
    }
  };

  const handleRejectCorrectionSuggestionGroup = async (
    suggestionIds: string[],
  ) => {
    if (suggestionIds.length === 0 || correctionInboxPendingRef.current) return;
    correctionInboxPendingRef.current = true;
    setCorrectionInboxBusy(true);
    try {
      for (const suggestionId of suggestionIds) {
        await rejectDictationCorrectionSuggestion(suggestionId);
        ++correctionSuggestionsRevisionRef.current;
        ++correctionActionEpochRef.current;
        setDictationCorrectionSuggestions((prev) =>
          prev.filter((suggestion) => suggestion.id !== suggestionId),
        );
      }
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
      correctionInboxPendingRef.current = false;
      setCorrectionInboxBusy(false);
    }
  };

  const changeLatestDraft = (text: string, restoration = false) => {
    if (renderedLatestEditContext !== latestEditContextRef.current ||
        transcribedText !== latestVisibleTextRef.current) return;
    ++latestResultRevisionRef.current;
    ++latestCorrectionEpochRef.current;
    latestQueuedCorrectionRef.current = null;
    setLatestLearnStatus(null);
    setTranscribedText(text);
    journalLatestDraft(text);
    setLatestResultDirty(true);
    setLatestEditStatus(null);
    if (restoration) setLatestCorrectionBaseline(text);
  };

  const maybeAutoLearnLatestCorrection = async () => {
    if (renderedLatestEditContext !== latestEditContextRef.current) return;
    const latestEpoch = latestCorrectionEpochRef.current;
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

    const key = JSON.stringify([original, corrected]);
    if (latestQueuedCorrectionRef.current === key) return;
    latestQueuedCorrectionRef.current = key;
    const queued = await queueCorrectionSuggestion(original, corrected, {
      appTarget: renderedLatestEditContext.appTarget ?? null,
      setStatus: (status) => {
        if (latestCorrectionEpochRef.current === latestEpoch) setLatestLearnStatus(status);
      },
    });
    if (!queued && latestCorrectionEpochRef.current === latestEpoch && latestQueuedCorrectionRef.current === key) {
      latestQueuedCorrectionRef.current = null;
    }
  };

  const handleLearnLatestCorrection = () => {
    if (renderedLatestEditContext !== latestEditContextRef.current) return Promise.resolve(false);
    const latestEpoch = latestCorrectionEpochRef.current;
    const correctedText = transcribedText;
    return learnCorrection(latestCorrectionBaseline, correctedText, {
      force: true,
      appTarget: renderedLatestEditContext.appTarget ?? null,
      setStatus: (status) => {
        if (latestCorrectionEpochRef.current === latestEpoch) setLatestLearnStatus(status);
      },
      onSuccess: () => {
        if (latestCorrectionEpochRef.current === latestEpoch) {
          setLatestCorrectionBaseline(correctedText.trim());
        }
      },
    });
  };

  const maybeAutoLearnHistoryCorrection = async () => {
    const historyEpoch = historyRequestEpochRef.current;
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

    const key = JSON.stringify([selectedRecording?.id, original, corrected]);
    if (historyQueuedCorrectionRef.current === key) return;
    historyQueuedCorrectionRef.current = key;
    const queued = await queueCorrectionSuggestion(original, corrected, {
      appTarget:
        selectedHistoryDetails?.activationMatcher ??
        selectedHistoryDetails?.appTarget ??
        selectedHistoryDetails?.contextAppName ??
        null,
      setStatus: (status) => {
        if (historyRequestEpochRef.current === historyEpoch) setHistoryLearnStatus(status);
      },
    });
    if (!queued && historyRequestEpochRef.current === historyEpoch && historyQueuedCorrectionRef.current === key) {
      historyQueuedCorrectionRef.current = null;
    }
  };

  const handleLearnHistoryCorrection = () => {
    const historyEpoch = historyRequestEpochRef.current;
    const correctedText = historyCorrectionText;
    return learnCorrection(historyCorrectionBaseline, correctedText, {
      force: true,
      appTarget:
        selectedHistoryDetails?.activationMatcher ??
        selectedHistoryDetails?.appTarget ??
        selectedHistoryDetails?.contextAppName ??
        null,
      setStatus: (status) => {
        if (historyRequestEpochRef.current === historyEpoch) setHistoryLearnStatus(status);
      },
      onSuccess: () => {
        if (historyRequestEpochRef.current === historyEpoch) {
          setHistoryCorrectionBaseline(correctedText.trim());
        }
      },
    });
  };

  const saveLatestEdit = async () => {
    const context = renderedLatestEditContext;
    if (context !== latestEditContextRef.current || !context.id || latestEditSaving || visibleDraftConflict ||
        latestSaveRequestsRef.current.has(context.id) || transcribedText === (context.saved ?? context.original)) return;
    const recordingId = context.id;
    latestSaveRequestsRef.current.add(recordingId);
    const savedDraftText = transcribedText;
    const expectedSavedText = context.saved;
    const text = savedDraftText === context.original ? null : savedDraftText;
    setLatestEditSaving(true);
    setLatestEditError(null);
    try {
      const result = await saveDictationEdit(context.id, text, expectedSavedText);
      void unfinishedEdits.acknowledgeSavedEdit(context.id, savedDraftText, expectedSavedText, result.text);
      if (latestEditContextRef.current !== context) return;
      context.saved = result.text;
      setLatestSavedEdit(result.text);
      setLatestEditStatus("Changes saved to history.");
      void refetchDictationHistory();
    } catch (error) {
      if (latestEditContextRef.current !== context) return;
      setLatestEditError(sanitizeUserFacingDictationMessage(error instanceof Error ? error.message : String(error), { phase: "error" }) ?? "Couldn't save. Your text is still here.");
    } finally {
      latestSaveRequestsRef.current.delete(recordingId);
      if (latestEditContextRef.current === context) setLatestEditSaving(false);
    }
  };

  const discardUnfinishedEdit = async (draft: LocalDictationDraft) => {
    // Discard supersedes a pending resume of this draft, even if clearing its
    // recovery copy fails. A delayed history read must not recreate it.
    if (pendingDraftResumeRef.current?.recordingId === draft.recordingId) {
      ++draftResumeEpochRef.current;
      pendingDraftResumeRef.current = null;
    }
    const context = latestEditContextRef.current;
    const revision = latestResultRevisionRef.current;
    const visibleText = transcribedText;
    const cleared = await unfinishedEdits.clearDraft(draft.recordingId, draft.text);
    if (!cleared || context !== latestEditContextRef.current || revision !== latestResultRevisionRef.current ||
        context.id !== draft.recordingId || visibleText !== draft.text) return;
    ++latestResultRevisionRef.current;
    ++latestCorrectionEpochRef.current;
    const restored = context.saved ?? context.original;
    setTranscribedText(restored);
    setLatestCorrectionBaseline(restored);
    latestQueuedCorrectionRef.current = null;
    setLatestResultDirty(restored !== context.original);
    setLatestLearnStatus(null);
    setLatestEditStatus("Unfinished edit discarded.");
    setLatestEditError(null);
  };

  const resumeUnfinishedEdit = async (draft: LocalDictationDraft) => {
    const request = ++draftResumeEpochRef.current;
    const pending = { recordingId: draft.recordingId, request };
    pendingDraftResumeRef.current = pending;
    const revision = latestResultRevisionRef.current;
    const context = latestEditContextRef.current;
    const isCurrent = () => pendingDraftResumeRef.current === pending && request === draftResumeEpochRef.current &&
      revision === latestResultRevisionRef.current && latestEditContextRef.current === context;
    try {
      const [original, saved] = await Promise.all([
        getTranscript(draft.recordingId), getDictationEdit(draft.recordingId),
      ]);
      if (!isCurrent()) return;
      if (!original) throw new Error("This dictation is no longer available.");
      ++latestResultRevisionRef.current;
      ++latestCorrectionEpochRef.current;
      const restoredContext = { id: draft.recordingId, original: original.fullText, saved: draft.expectedSavedText };
      latestEditContextRef.current = restoredContext;
      setDraftSavedConflict(saved.text !== draft.expectedSavedText ? { context: restoredContext, saved: saved.text } : null);
      setLatestEditTargetId(draft.recordingId);
      setLatestSavedEdit(draft.expectedSavedText);
      setLatestEditSaving(false);
      setLatestShortcutText(null);
      setLatestShortcutPreparing(false);
      setLatestRawTranscript(null);
      setLatestResultOrigin("draft");
      setTranscribedText(draft.text);
      void unfinishedEdits.saveDraft(draft.recordingId, draft.text, draft.expectedSavedText);
      setLatestCorrectionBaseline(saved.text ?? original.fullText);
      latestQueuedCorrectionRef.current = null;
      setLatestLearnStatus(null);
      setLatestResultDirty(true);
      setLatestEditStatus("Unfinished edit restored.");
      setLatestEditError(saved.text !== draft.expectedSavedText
        ? "The saved version changed. Your unfinished edit is still here. Compare both versions before choosing which one to keep." : null);
    } catch {
      if (isCurrent()) toast("Couldn't reopen this unfinished edit. Its text is still kept.", "error");
    } finally {
      if (pendingDraftResumeRef.current === pending) pendingDraftResumeRef.current = null;
    }
  };

  const resolveDraftSavedConflict = (useSavedVersion: boolean) => {
    const conflict = visibleDraftConflict;
    if (!conflict || conflict.context !== latestEditContextRef.current) return;
    const context = conflict.context;
    ++latestResultRevisionRef.current;
    ++latestCorrectionEpochRef.current;
    context.saved = conflict.saved;
    setLatestSavedEdit(conflict.saved);
    const text = useSavedVersion ? (conflict.saved ?? context.original) : transcribedText;
    setTranscribedText(text);
    setLatestCorrectionBaseline(text);
    latestQueuedCorrectionRef.current = null;
    journalLatestDraft(text);
    setLatestEditError(null);
    setDraftSavedConflict(null);
    setLatestEditStatus(useSavedVersion ? "Saved version restored." : "Draft kept. Save to history to replace the saved correction.");
    setLatestResultDirty(text !== context.original);
  };

  const prepareSavedTextForShortcut = async () => {
    const context = renderedLatestEditContext;
    if (context !== latestEditContextRef.current || !context.id || latestShortcutPreparing || latestEditSaving ||
        transcribedText !== (context.saved ?? context.original) || !transcribedText.trim()) return;
    setLatestShortcutPreparing(true);
    setLatestEditError(null);
    try {
      const result = await stageSavedDictationResult(context.id);
      if (latestEditContextRef.current !== context) return;
      setLatestShortcutText(result.text);
      setLatestEditStatus('Saved text is ready for "Paste last result".');
    } catch (error) {
      if (latestEditContextRef.current !== context) return;
      setLatestEditError(sanitizeUserFacingDictationMessage(error instanceof Error ? error.message : String(error), { phase: "error" }) ?? "Couldn't prepare the shortcut. Your saved text is unchanged.");
    } finally {
      if (latestEditContextRef.current === context) setLatestShortcutPreparing(false);
    }
  };

  const historyRecoveryError = "Couldn't store a recovery copy. Keep this window open or save your changes to history.";
  const renderedHistoryEditContext = historyEditRef.current;
  const journalHistoryDraft = (text: string) => {
    const current = historyEditRef.current;
    if (!selectedRecording) return;
    const epoch = historyRequestEpochRef.current;
    const isCurrentDraft = () => historyRequestEpochRef.current === epoch
      && historyEditRef.current === current && current.draft === text;
    const clearRecoveryError = () => {
      if (isCurrentDraft()) {
        setHistoryEditError((error) => error === historyRecoveryError
          ? current.loaded ? null : HISTORY_SAVED_EDIT_READ_ERROR
          : error);
      }
    };
    if (current.loaded && text === (current.saved ?? current.original)) {
      void unfinishedEdits.clearDraft(selectedRecording.id, current.draft).then((cleared) => {
        if (cleared) clearRecoveryError();
      });
    } else {
      void unfinishedEdits.saveDraft(selectedRecording.id, text, current.saved).then((stored) => {
        if (!isCurrentDraft()) return;
        if (stored) clearRecoveryError();
        else setHistoryEditError(historyRecoveryError);
      });
    }
  };

  const restoreHistoryText = (text: string) => {
    if (renderedHistoryEditContext !== historyEditRef.current || !selectedRecording
      || !renderedHistoryEditContext.loaded || historyEditSaveRef.current?.id === selectedRecording.id) return;
    cancelHistoryPreview();
    ++reprocessInputRevisionRef.current;
    journalHistoryDraft(text);
    historyEditRef.current.draft = text;
    setHistoryCorrectionText(text);
    setHistoryCorrectionBaseline(text);
    historyQueuedCorrectionRef.current = null;
    setHistoryLearnStatus(null);
    setHistoryEditStatus(null);
    setReprocessedResult(null);
    setReprocessError(null);
  };

  const saveHistoryEdit = async (): Promise<boolean> => {
    if (!selectedRecording) return true;
    const id = selectedRecording.id;
    const epoch = historyRequestEpochRef.current;
    const existing = historyEditSaveRef.current;
    if (existing?.id === id) return existing.promise;
    const current = historyEditRef.current;
    if (current.draft === (current.saved ?? current.original)) return true;
    if (!current.loaded) return false;
    const savedDraftText = current.draft;
    const text = savedDraftText === current.original ? null : savedDraftText;
    const expectedText = current.saved;
    const latestContextAtSave = latestEditContextRef.current;
    const latestRevisionAtSave = latestResultRevisionRef.current;
    const latestBaselineAtSave = latestContextAtSave.saved ?? latestContextAtSave.original;
    const latestWasUntouched = latestVisibleTextRef.current === latestBaselineAtSave;
    setHistoryEditSaving(true);
    setHistoryEditError(null);
    const pendingSave = { id, promise: Promise.resolve(false) };
    historyEditSaveRef.current = pendingSave;
    const promise: Promise<boolean> = (async () => {
      try {
        const result = await saveDictationEdit(id, text, expectedText);
        void unfinishedEdits.acknowledgeSavedEdit(id, savedDraftText, expectedText, result.text);
        if (historyRequestEpochRef.current !== epoch) return false;
        historyEditRef.current.saved = result.text;
        setHistorySavedEdit(result.text);
        setHistoryEditStatus("Changes saved.");
        if (latestEditContextRef.current.id === id) {
          const latestContext = latestEditContextRef.current;
          const canSyncLatest = latestContext === latestContextAtSave && latestWasUntouched
            && latestResultRevisionRef.current === latestRevisionAtSave
            && latestVisibleTextRef.current === latestBaselineAtSave;
          latestContext.saved = result.text;
          setLatestSavedEdit(result.text);
          if (canSyncLatest) {
            const savedText = result.text ?? latestContext.original;
            ++latestResultRevisionRef.current;
            ++latestCorrectionEpochRef.current;
            latestVisibleTextRef.current = savedText;
            setTranscribedText(savedText);
            setLatestCorrectionBaseline(savedText);
            latestQueuedCorrectionRef.current = null;
            setLatestResultDirty(true);
            setLatestLearnStatus(null);
            setLatestEditStatus("Changes saved from history.");
            setLatestEditError(null);
          }
        }
        void refetchDictationHistory();
        return true;
      } catch (error) {
        if (historyRequestEpochRef.current === epoch) {
          setHistoryEditError(sanitizeUserFacingDictationMessage(error instanceof Error ? error.message : String(error), { phase: "error" }) ?? "Couldn't save these changes. Your draft is still here.");
        }
        return false;
      } finally {
        if (historyRequestEpochRef.current === epoch) setHistoryEditSaving(false);
        if (historyEditSaveRef.current === pendingSave) historyEditSaveRef.current = null;
      }
    })();
    pendingSave.promise = promise;
    return promise;
  };

  const flushHistoryEdit = async (): Promise<boolean> => {
    const epoch = historyRequestEpochRef.current;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!await saveHistoryEdit() || historyRequestEpochRef.current !== epoch) return false;
      const current = historyEditRef.current;
      if (current.draft === (current.saved ?? current.original)) return true;
    }
    return false;
  };

  const finishDraftsBeforeLeaving = useCallback(async () => {
    const historyEpoch = historyRequestEpochRef.current;
    if (isDialogOpen && !(await flushHistoryEdit())) return false;
    const saved = await unfinishedEdits.flush();
    if (historyRequestEpochRef.current !== historyEpoch) return false;
    if (!saved) toast("Your unfinished edits couldn't be stored. Keep this view open and retry saving them.", "error");
    return saved;
  }, [isDialogOpen, flushHistoryEdit, unfinishedEdits.flush, toast]);
  useEffect(() => registerViewLeaveGuard("dictation", finishDraftsBeforeLeaving), [finishDraftsBeforeLeaving]);
  useEffect(() => registerMainWindowIdleGuard(() =>
    !isDictationBusy && !isProcessingAgain && !isReprocessing && !isOpeningHistoryEntry &&
    !isDialogOpen && !dictionaryCsvDialogOpen && !latestEditSaving && !historyEditSaving &&
    !latestShortcutPreparing && !activeSpeechTarget && !latestResultDirty && !latestResultIsPreview &&
    !processAgainOperationRef.current && !pendingDraftResumeRef.current),
  [isDictationBusy, isProcessingAgain, isReprocessing, isOpeningHistoryEntry, isDialogOpen,
    dictionaryCsvDialogOpen, latestEditSaving, historyEditSaving, latestShortcutPreparing,
    activeSpeechTarget, latestResultDirty, latestResultIsPreview]);

  const handleReprocessSelectedDictation = async () => {
    if (reprocessRunRef.current || !selectedTranscript || !historyCorrectionText.trim()) {
      return;
    }

    const historyEpoch = historyRequestEpochRef.current;
    const requestEpoch = ++reprocessRequestEpochRef.current;
    const inputRevision = reprocessInputRevisionRef.current;
    const run = { runId: crypto.randomUUID(), cancelled: false };
    reprocessRunRef.current = run;
    setReprocessCancelling(false);
    const isRequestCurrent = () =>
      historyRequestEpochRef.current === historyEpoch &&
      reprocessRequestEpochRef.current === requestEpoch;
    const isCurrent = () =>
      !run.cancelled && isRequestCurrent() && reprocessInputRevisionRef.current === inputRevision;
    setReprocessedResult(null);
    setIsReprocessing(true);
    setReprocessError(null);
    try {
      const result = await reprocessDictationText(
        historyCorrectionText,
        reprocessModePreset,
        selectedHistoryDetails?.activationMatcher ??
          selectedHistoryDetails?.appTarget ??
          selectedHistoryDetails?.contextAppName ??
          null,
        { runId: run.runId },
      );
      if (!result || typeof result !== "object"
        || typeof result.modePreset !== "string"
        || typeof result.outputText !== "string" || !result.outputText.trim()) {
        throw new Error("Couldn't create a style preview. Your text is unchanged.");
      }
      if (isCurrent()) setReprocessedResult(result);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setReprocessError(message);
      setReprocessedResult(null);
    } finally {
      if (reprocessRunRef.current === run) {
        reprocessRunRef.current = null;
        setIsReprocessing(false);
        setReprocessCancelling(false);
        if (run.cancelled) setReprocessError(null);
      }
    }
  };

  // "Process again": the sidecar re-runs the kept audio and saves a NEW
  // history entry. It inserts nothing, so the only thing to do here is
  // refresh the list and show what was saved.
  const retryModelIndex = buildDownloadedModelIndex(retryModelFiles);
  // Parakeet v3 is offered once: where the GGUF build can run and is on this
  // Mac, the ONNX build beside it is an internal fallback, not a choice.
  const ggufParakeetOnDisk =
    efficientParakeet &&
    retryModelIndex.presentRouteIds.has(
      routeIdFor(RECOMMENDED_SPEECH_ROUTE.providerType, RECOMMENDED_SPEECH_ROUTE.modelId),
    );
  const processAgainSpeechOptions = captureProviders.flatMap((provider) =>
    provider.inferenceEnabled === false ? [] : provider.modelOptions
      .filter((model) => retryModelIndex.presentRouteIds.has(`${provider.providerType}:${model.id}`))
      .filter((model) => !(ggufParakeetOnDisk && isOnnxParakeetRoute(provider.providerType, model.id)))
      .map((model) => ({ value: `${provider.providerType}:${model.id}`,
        label: speechRouteName(provider, model.id), provider: provider.providerType, modelId: model.id })),
  );

  const handleProcessSelectedDictationAgain = async () => {
    if (!selectedRecording || processAgainOperationRef.current) {
      return;
    }
    const source = selectedRecording;
    const modeId = processAgainModeId;
    const speechRoute = processAgainSpeechRoute;
    const historyEpoch = historyRequestEpochRef.current;
    const requestEpoch = ++processAgainRequestEpochRef.current;
    const operation = {
      sourceId: source.id,
      sourceTitle: source.title,
      modeId,
      speechRoute,
      token: Symbol("process-again"),
    };
    const isCurrent = () =>
      processAgainOperationRef.current?.token === operation.token &&
      historyRequestEpochRef.current === historyEpoch &&
      processAgainRequestEpochRef.current === requestEpoch;
    processAgainOperationRef.current = operation;
    setProcessAgainOutcome(null);
    setIsProcessingAgain(true);
    setProcessAgainPendingSource({ id: source.id, title: source.title });
    setProcessAgainError(null);
    setProcessAgainRefreshWarning(null);
    try {
      const speech = processAgainSpeechOptions.find((option) => option.value === speechRoute);
      if (speechRoute !== "current" && !speech) {
        throw new Error("That model is no longer listed. Choose another speech model for this retry.");
      }
      const outcome = await reprocessDictation({
        historyId: source.id,
        modeId,
        ...(speech ? { provider: speech.provider, modelId: speech.modelId } : {}),
      });
      if (isCurrent()) setProcessAgainOutcome(outcome);
      try {
        await refetchDictationHistory();
      } catch (refreshError) {
        console.warn("Process again saved a new entry, but history refresh failed:", refreshError);
        if (isCurrent()) {
          setProcessAgainRefreshWarning(
            "The new entry was saved, but history could not refresh. Reload Dictation to update the list."
          );
        }
      }
      void refreshDictationInsights();
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setProcessAgainError(sanitizeUserFacingDictationMessage(message));
      setProcessAgainOutcome(null);
    } finally {
      if (processAgainOperationRef.current?.token === operation.token) {
        processAgainOperationRef.current = null;
        setIsProcessingAgain(false);
        setProcessAgainPendingSource(null);
      }
    }
  };

  const handleCopyHistoryTranscript = async (recordingId: string) => {
    const request = ++clipboardActionEpochRef.current;
    const isCurrent = () => clipboardActionEpochRef.current === request;
    try {
      const [transcript, edit] = await Promise.all([getTranscript(recordingId), getDictationEdit(recordingId)]);
      if (!isCurrent()) return false;
      const text = edit.text ?? transcript?.fullText;
      if (!text?.trim()) {
        toast("No text was saved. Open this dictation to check whether its audio can be processed again.", "error");
        return false;
      }
      await navigator.clipboard.writeText(text);
      if (!isCurrent()) return false;
      if (isDialogOpen) toast("Saved dictation copied.", "success");
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      console.warn("Failed to copy dictation history transcript:", error);
      toast("Couldn't copy that dictation to the clipboard.", "error");
      return false;
    }
  };

  const requestHistoryDelete = (recording: Recording) => {
    if (historyDeletePendingRef.current) return;
    setHistoryDeleteError(null);
    setPendingHistoryDelete(recording);
  };

  const handleDeleteHistoryItem = async () => {
    if (!pendingHistoryDelete || historyDeletePendingRef.current) return;
    const recordingId = pendingHistoryDelete.id;
    historyDeletePendingRef.current = true;
    setHistoryDeleteBusy(true);
    setHistoryDeleteError(null);
    try {
      await deleteRecording(recordingId);
    } catch (error) {
      console.warn("Failed to delete dictation history item:", error);
      if (latestCopyMountedRef.current) setHistoryDeleteError("Could not delete this dictation. It is still saved. Try again.");
      return;
    } finally {
      historyDeletePendingRef.current = false;
      if (latestCopyMountedRef.current) setHistoryDeleteBusy(false);
    }
    if (!latestCopyMountedRef.current) return;
    unfinishedEdits.forgetDraft(recordingId);
    setPendingHistoryDelete(null);
    // The latest-result card may be this same dictation: it is no longer
    // "Saved in history", and Save or "Use for Paste last result" would
    // only fail against the deleted entry. The text stays to copy.
    if (latestEditContextRef.current.id === recordingId) {
      latestEditContextRef.current = { ...latestEditContextRef.current, id: null };
      setLatestEditTargetId(null);
    }
    if (historyDeleteSelectionRef.current?.id === recordingId) {
      historyOpenRequestRef.current += 1;
      setIsOpeningHistoryEntry(false);
      setIsDialogOpen(false);
      setSelectedRecording(null);
      setSelectedTranscript(null);
      setReprocessedResult(null);
      setReprocessError(null);
    }
    try {
      await Promise.all([refetchDictationHistory(), refreshDictationInsights()]);
    } catch (error) {
      console.warn("Failed to refresh after deleting dictation:", error);
      if (latestCopyMountedRef.current) toast("Dictation deleted. Couldn't refresh history; reopen it to update the list.", "error");
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
    if (latestCopyPendingRef.current || renderedLatestEditContext !== latestEditContextRef.current ||
        transcribedText !== latestVisibleTextRef.current) return;
    if (!transcribedText.trim()) {
      toast("Nothing to copy. Enter some text first.", "error");
      return;
    }
    const request = ++clipboardActionEpochRef.current;
    const context = latestEditContextRef.current;
    const revision = latestResultRevisionRef.current;
    const text = transcribedText;
    const isCurrent = () => latestCopyMountedRef.current && clipboardActionEpochRef.current === request &&
      latestEditContextRef.current === context && latestResultRevisionRef.current === revision &&
      latestVisibleTextRef.current === text;
    latestCopyPendingRef.current = true;
    setLatestCopyPending(true);
    try {
      await navigator.clipboard.writeText(text);
      if (isCurrent()) toast("Result copied. Paste it where you want it.", "success");
    } catch (error) {
      if (!isCurrent()) return;
      console.warn("Failed to copy the latest dictation result:", error);
      toast("Could not copy the result. Select the text and copy it manually.", "error");
    } finally {
      latestCopyPendingRef.current = false;
      if (latestCopyMountedRef.current) setLatestCopyPending(false);
    }
  };

  // A correction can only be taught while the editor differs from the text the
  // learner last saw. This is the baseline diff, not "edited since capture" —
  // learning resets the baseline but never changes the stored capture.
  const canLearnLatestCorrection =
    latestCorrectionBaseline.trim() !== transcribedText.trim();
  const hasDictated =
    (dictationInsights?.totalDictations ?? 0) > 0 ||
    dictationHistory.length > 0;
  const activeProfileTitle =
    dictationModePreset === "custom" && selectedCustomMode
      ? selectedCustomMode.name
      : activeProfile.title;
  const captureTranscription = captureSettings?.transcription;
  const captureCustomMode = captureTranscription?.dictationModePreset === "custom"
    ? captureTranscription.dictationCustomModes?.find((mode) => mode.id === captureTranscription.dictationSelectedCustomModeId)
    : null;
  const captureUsesShared = captureCustomMode?.dictationProvider
    ? false
    : captureTranscription?.useSharedAsrSelection ?? true;
  const captureProviderId = captureUsesShared
    ? captureTranscription?.defaultProvider
    : captureCustomMode?.dictationProvider ?? captureTranscription?.dictationProvider ?? captureTranscription?.defaultProvider;
  const captureProvider = captureProviders.find((provider) => provider.providerType === captureProviderId);
  const captureModelId = captureUsesShared
    ? captureTranscription?.selectedModelId
    : captureCustomMode?.dictationModelId ?? captureTranscription?.dictationModelId ?? captureTranscription?.selectedModelId;
  const captureModelLabel = captureProvider?.modelOptions.find((model) => model.id === captureModelId)?.label
    ?? captureModelId ?? captureProvider?.selectedModelId;
  const captureDisplayLabel = captureProvider && captureModelId && captureModelLabel
    ? routeDisplayLabel(captureProvider.providerType, captureModelId, captureModelLabel)
    : captureModelLabel;
  const captureSpeechLabel = captureProvider && captureModelId
    ? speechRouteName(captureProvider, captureModelId)
    : captureProvider
      ? captureDisplayLabel ?? captureProvider.name
      : captureProviderId ?? "Checking speech model…";
  const captureRewrite = (captureCustomMode?.profile ?? captureTranscription?.dictationProfile) === "power_rewrite"
    || Boolean(captureCustomMode?.customPrompt?.trim())
    || Boolean(captureTranscription?.dictationCustomPrompt?.trim());
  const captureAiProvider = captureCustomMode?.aiProvider ?? captureSettings?.privacy.dictationAi.provider;
  const captureAiModelId = captureCustomMode?.aiModelId ?? captureSettings?.privacy.dictationAi.modelId;
  const cleanupReadiness = resolveDictationCleanupReadiness({
    aiFormattingEnabled: captureTranscription?.dictationAiFormatting ?? false,
    needsRewrite: captureRewrite,
    readinessMatchesCapture: captureSettings !== null && rewriteAiLaneRequestKey === JSON.stringify([
      captureAiProvider?.trim() ?? "", captureAiModelId?.trim() || null,
      captureSettings?.privacy.remoteProcessingEnabled ?? false, rewriteProbeRevision,
    ]),
    aiLaneReady: rewriteAiLane.ready,
    aiLaneMessage: rewriteAiLane.message,
  });
  const captureTextLabel = !captureSettings
    ? "Checking text settings…"
    : captureRewrite
      ? "Rewrite"
      : captureTranscription?.dictationAiFormatting && !cleanupReadiness
        ? "AI cleanup"
        : "Basic formatting";
  const captureTextDetail = !captureSettings
    ? undefined
    : captureRewrite
      ? "AI grammar and phrasing changes."
      : captureTranscription?.dictationAiFormatting && !cleanupReadiness
        ? "AI punctuation and light cleanup."
        : "Local punctuation and spoken-correction rules.";
  const rewriteReadiness = resolveDictationRewriteReadiness({
    needsRewrite: dictationModeNeedsRewrite({
      profile: dictationProfile,
      customPrompt: selectedCustomMode?.customPrompt,
    }),
    profileName: activeProfileTitle,
    provider: currentAiProvider,
    remoteProcessingEnabled,
    aiLaneReady: rewriteAiLane.ready,
    aiLaneMessage: rewriteAiLane.message,
  });
  const hotkeyModeLabel = DICTATION_HOTKEY_MODE_CHIP_LABELS[hotkeyMode];
  const hotkeyInstruction =
    hotkeyLabel === null
      ? "Checking your dictation shortcut…"
      : dictationInstruction(hotkeyShortcut, hotkeyMode);
  const oneOffCapturePreference = dictationRouteOverrideEnabled ? nextCaptureRoutePreference : null;
  const captureRoutePreference = oneOffCapturePreference
    ?? captureCustomMode?.routePreference
    ?? captureTranscription?.dictationRoutePreference;
  const captureSpeechDetail = captureProviderId === "whistle" && captureRoutePreference === "local"
    ? "Whistle accepts up to 30 seconds of audio. Choose another speech model for longer dictation."
    : undefined;
  const captureReadiness = oneOffCapturePreference
    ? assessOneOffDictationCapture({
        evidence: productReadinessEvidence, providers: captureProviders,
        preference: oneOffCapturePreference, remoteProcessingEnabled,
        configuredProviders: [captureProviderId, captureTranscription?.defaultProvider, captureTranscription?.dictationProvider],
        requestedProvider: captureProviderId, deliveryMode: "preview",
      })
    : productReadinessEvidence ? assessInAppDictationCapture(productReadinessEvidence) : dictationReadiness;
  const captureRouteReadiness = oneOffCapturePreference ? null : dictationRouteReadiness;
  const dictationAvailable = captureReadiness.state === "ready" && !captureRouteReadiness;
  const captureShortcutInstruction = dictationReadiness.cause?.id === "cursor_insertion"
    && captureReadiness.state === "ready"
      ? "Use Start to keep text here. The shortcut needs Accessibility access to insert into other apps."
      : oneOffCapturePreference
        ? `Use Start for this ${oneOffCapturePreference === "cloud" ? "cloud" : "local"} capture. The shortcut still follows ${activeProfileTitle}.`
        : hotkeyInstruction;
  const dictationUnavailableTitle =
    captureReadiness.state === "unknown"
      ? "Checking setup"
      : captureRouteReadiness?.status === "downloading"
        ? "Model downloading"
        : captureRouteReadiness?.status === "missing"
          ? "Dictation has no model yet"
        : "Setup needed";
  const dictationUnavailableDetail = captureRouteReadiness
    ? captureRouteReadiness.status === "downloading"
      ? `${captureRouteReadiness.routeLabel} is still downloading. Use Re-check model when the transfer finishes.`
      : routeDownloadError
        ? `The download didn't finish. ${routeDownloadError}`
        : `${captureRouteReadiness.routeLabel} is not on this Mac. Download it before capture can start.`
    : captureReadiness.cause?.message ??
      "Plainsong could not confirm that dictation is ready.";
  const dictationUnavailableActionLabel = captureRouteReadiness
    ? captureRouteReadiness.status === "missing"
      ? routeDownloadBusy
        ? "Downloading…"
        : `Download ${captureRouteReadiness.routeLabel}`
      : "Re-check model"
    : captureReadiness.cause?.action.label ?? "Re-check setup";
  const handleDictationUnavailableAction = () => {
    if (captureRouteReadiness?.status === "missing") {
      void handleDownloadDictationRouteModel();
      return;
    }
    if (captureRouteReadiness?.status === "downloading") {
      void refreshDictationRouteReadiness();
      return;
    }
    if (captureReadiness.cause) {
      requestReadinessDestination(
        captureReadiness.cause.action.destination,
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
            {hotkeyLabel === null ? (
              <>
                <span
                  aria-hidden="true"
                  className="animate-pulse-subtle inline-block h-3.5 w-20 rounded-sm bg-muted-foreground/20"
                />
                <span className="sr-only">Loading your shortcut…</span>
              </>
            ) : (
              <span className="font-mono text-sm font-medium">
                {hotkeyLabel}
              </span>
            )}
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
          {engineNotice ? <EngineRecoveryBanner notice={engineNotice} onDismiss={dismissEngineNotice} /> : null}

          {/* A dictation the previous run stopped but never finished. */}
          <DictationRecoveryBanner />

          {pendingExternalCorrection && (
            <div role="status" className="rounded-md border bg-muted/20 px-3 py-2 space-y-2">
              <p className="text-sm">
                You changed &ldquo;{pendingExternalCorrection.spokenForm}&rdquo; to &ldquo;{pendingExternalCorrection.replacement}&rdquo;
                {pendingExternalCorrection.appTarget ? ` in ${pendingExternalCorrection.appTarget}` : ""}.
                {" "}Learn this for every app?
                {pendingExternalCorrection.approvalDictionary?.kind === "entry"
                  ? ` It replaces your dictionary entry “${pendingExternalCorrection.approvalDictionary.spokenForm}” → “${pendingExternalCorrection.approvalDictionary.replacement}”.`
                  : ""}
              </p>
              {/* aria-disabled, not disabled, on every button: a disabled
                  button drops keyboard focus while the inbox is busy. */}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" aria-disabled={correctionInboxBusy}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={(event) => { if (!correctionInboxBusy) void handleApproveCorrectionSuggestionGroup(pendingExternalCorrection.suggestionIds, event.currentTarget); }}>
                  Learn it
                </Button>
                <Button type="button" size="sm" variant="outline" aria-disabled={correctionInboxBusy}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={() => { if (!correctionInboxBusy) void handleRejectCorrectionSuggestionGroup(pendingExternalCorrection.suggestionIds); }}>
                  Dismiss
                </Button>
                {externalCorrectionSuggestionGroups.length > 1 ? (
                  <Button type="button" size="sm" variant="ghost"
                    onClick={() => {
                      setActiveConfigTab("corrections");
                      const heading = dictationSetupRef.current;
                      heading?.scrollIntoView?.({ block: "start" });
                      heading?.focus({ preventScroll: true });
                    }}>
                    Review all ({externalCorrectionSuggestionGroups.length})
                  </Button>
                ) : null}
              </div>
            </div>
          )}
          {activeConfigTab !== "corrections" && (
            <>
              {correctionApprovalError && (
                <div role="alert" className="space-y-2 text-sm text-destructive">
                  <p>{correctionApprovalError}</p>
                  <Button type="button" size="sm" variant="outline" disabled={correctionInboxBusy}
                    onClick={() => void handleRefreshCorrectionSuggestions()}>
                    Refresh corrections
                  </Button>
                </div>
              )}
              {correctionApprovalNotices.slice(-1).map((notice) => (
                <div key={notice.key} role="status" tabIndex={-1}
                  ref={(element) => focusCorrectionApprovalTarget(element, notice.key, "notice")}
                  className="rounded-md border bg-muted/20 px-3 py-2 space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">{notice.message}</p>
                    {notice.undoToken && <Button type="button" size="sm" variant="outline"
                      aria-disabled={correctionInboxBusy} aria-label={`Undo correction: ${notice.label}`}
                      className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                      ref={(element) => focusCorrectionApprovalTarget(element, notice.key, "undo")}
                      onClick={(event) => void handleUndoCorrectionApproval(notice, event.currentTarget)}>
                      {correctionUndoEntryId === notice.entry.id ? "Undoing…" : "Undo"}
                    </Button>}
                    <Button type="button" size="sm" variant="ghost" aria-label={`Dismiss: ${notice.message}`}
                      onClick={() => setCorrectionApprovalNotices((prev) => prev.filter((entry) => entry.key !== notice.key))}>
                      Dismiss
                    </Button>
                  </div>
                  {notice.error && <p role="alert" className="text-sm text-destructive">{notice.error}</p>}
                </div>
              ))}
            </>
          )}

          <DictationCaptureHero
            compact={hasDictated}
            phase={dictationPhase}
            phaseTitle={meetingOwnsCapture && !isDictationBusy && !isDictationCaptureLive
              ? "Meeting capture is active" : isAwaitingDictationStart ? "Starting dictation" : dictationPhaseSummary.title}
            phaseDetail={meetingOwnsCapture && !isDictationBusy && !isDictationCaptureLive
              ? dictationStartBlockedReason! : isAwaitingDictationStart ? "Waiting for capture to start." : dictationPhaseSummary.detail}
            phaseTone={meetingOwnsCapture && !isDictationBusy && !isDictationCaptureLive
              ? "idle" : isAwaitingDictationStart ? "active" : dictationPhaseSummary.tone}
            isCaptureLive={isDictationCaptureLive}
            isBusy={isDictationBusy}
            isStarting={dictationStarting}
            startBlockedReason={dictationStartBlockedReason}
            isAvailable={dictationAvailable}
            unavailableTitle={dictationUnavailableTitle}
            unavailableDetail={dictationUnavailableDetail}
            unavailableActionLabel={dictationUnavailableActionLabel}
            unavailableActionBusy={routeDownloadBusy}
            unavailableRole={
              captureReadiness.state === "unknown" ? "status" : "alert"
            }
            formattedDuration={<RecordingDurationText />}
            hotkeyInstruction={captureShortcutInstruction}
            hotkeyPressed={hotkeyPressed}
            livePreview={dictationPhasePreview}
            speechModelDetail={captureSpeechDetail}
            speechModelLabel={oneOffCapturePreference ? `${oneOffCapturePreference === "cloud" ? "Cloud" : "This Mac"} for this capture` : captureSpeechLabel}
            onChooseSpeechModel={() => requestReadinessDestination("models")}
            textProcessingLabel={captureTextLabel}
            textProcessingDetail={captureTextDetail}
            activeProfileTitle={activeProfileTitle}
            profilePicker={
              <Select
                value={selectedCustomModeId && dictationModePreset === "custom"
                  ? `saved:${selectedCustomModeId}` : `mode:${dictationModePreset}`}
                disabled={isDictationCaptureLive || isDictationBusy}
                onValueChange={(value) => {
                  const saved = dictationCustomModes.find((mode) => `saved:${mode.id}` === value);
                  if (saved) {
                    applySavedCustomMode(saved);
                    return;
                  }
                  const mode = DICTATION_MODE_DEFINITIONS.find((definition) => `mode:${definition.id}` === value);
                  if (mode) applyDictationMode(mode.id);
                }}
              >
                <SelectTrigger aria-label="Capture profile" className="mt-1 max-w-xs">
                  <SelectValue>{activeProfileTitle}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DICTATION_MODE_DEFINITIONS.filter((mode) => mode.id !== "custom").map((mode) => (
                    <SelectItem key={mode.id} value={`mode:${mode.id}`}>
                      {DICTATION_PROFILE_TILES.find((tile) => tile.kind === "mode" && tile.modeId === mode.id)?.title ?? mode.label}
                    </SelectItem>
                  ))}
                  {dictationCustomModes.map((mode) => (
                    <SelectItem key={mode.id} value={`saved:${mode.id}`}>{mode.name}</SelectItem>
                  ))}
                  {dictationModePreset === "custom" && !selectedCustomModeId && (
                    <SelectItem value="mode:custom" disabled>Unsaved custom setup</SelectItem>
                  )}
                </SelectContent>
              </Select>
            }
            resolvedModeLabel={dictationResolvedModeLabel}
            smartContextSummary={smartContextSummary}
            isReadingSelectedText={activeSpeechTarget === "selected-text"}
            onStart={launchDictation}
            onStop={handleStopDictation}
            onCancelProcessing={canCancelProcessing ? () => { void cancelProcessingDictation(); } : undefined}
            processingCancelling={processingSessionId !== null && processingCancellingId === processingSessionId}
            processingCancelError={canCancelProcessing && processingCancelError?.sessionId === processingSessionId ? processingCancelError.message : null}
            onReadSelectedText={() => void handleReadSelectedText()}
            onUnavailableAction={handleDictationUnavailableAction}
          />
          {cleanupReadiness && <StatusBanner
            title={cleanupReadiness.title}
            message={cleanupReadiness.message}
            tone={cleanupReadiness.tone}
            role={cleanupReadiness.role}
            actions={<Button type="button" size="sm" variant="outline"
              onClick={() => requestReadinessDestination("models")}>Check text model</Button>}
          />}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const heading = dictationSetupRef.current;
                heading?.scrollIntoView({ block: "start" });
                heading?.focus({ preventScroll: true });
              }}
            >
              Edit dictation settings
            </Button>
          </div>

          {pasteStatus ? <p role="status" className="text-sm text-muted-foreground">{pasteStatus}</p> : null}

          <UnfinishedDictationEdits drafts={unfinishedEdits.drafts} loading={unfinishedEdits.loading}
            error={unfinishedEdits.error} onResume={(draft) => { void resumeUnfinishedEdit(draft); }}
            onDiscard={(draft) => { void discardUnfinishedEdit(draft); }}
            onRetry={() => { void unfinishedEdits.refresh(); }}
            onCopyStart={() => { ++clipboardActionEpochRef.current; }}
            onRetryDraft={(draft) => { void unfinishedEdits.retryDraft(draft.recordingId); }} />

          {(transcribedText || latestEditContextRef.current.original) && (
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="section-heading">Latest result</h2>
                    <p className="text-sm text-muted-foreground">
                      {latestResultIsRecoveredDraft
                        ? "An edit recovered from dictation history. Save or copy it when you are ready."
                        : latestResultIsPreview
                        ? "A style preview. Save or copy it when you are ready to use it."
                        : "Your last dictation."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {latestEditTargetId && <Button size="sm"
                      title="Save to history (Command-Enter or Control-Enter)"
                      disabled={latestEditSaving || Boolean(visibleDraftConflict) || transcribedText === (latestSavedEdit ?? latestEditContextRef.current.original)}
                      onClick={() => { void saveLatestEdit(); }}>
                      {latestEditSaving ? "Saving…" : "Save to history"}
                    </Button>}
                    {latestEditTargetId && <Button variant="outline" size="sm"
                      disabled={latestEditSaving || latestShortcutPreparing || !transcribedText.trim() ||
                        transcribedText !== (latestSavedEdit ?? latestEditContextRef.current.original) ||
                        isDictationBusy}
                      onClick={() => { void prepareSavedTextForShortcut(); }}>
                      {latestShortcutPreparing ? "Preparing…" : "Use for Paste last result"}
                    </Button>}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={latestCopyPending || !transcribedText.trim()}
                      onClick={() => void handleCopyLatestResult()}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      {latestCopyPending ? "Copying…" : "Copy result"}
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
                  ref={latestResultTextareaRef}
                  aria-label="Latest dictation result"
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  className="manuscript min-h-[120px] w-full resize-y rounded-md bg-muted p-4 text-sm outline-none"
                  value={transcribedText}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void saveLatestEdit();
                  }}
                  onChange={(event) => {
                    changeLatestDraft(event.target.value);
                  }}
                  onBlur={() => {
                    void maybeAutoLearnLatestCorrection();
                  }}
                />
                <RecognitionWordReview words={visibleLatestRecognitionReview?.words}
                  original={visibleLatestRecognitionReview?.original} />
                <DictationChangeReview
                  original={latestRawTranscript ?? latestEditContextRef.current.original}
                  current={transcribedText}
                  originalLabel="Original"
                  onRestoreOriginal={() => {
                    if (renderedLatestEditContext !== latestEditContextRef.current) return;
                    const text = latestRawTranscript ?? latestEditContextRef.current.original;
                    ++latestResultRevisionRef.current;
                    setLatestPreviewUndo({
                      kind: "restore",
                      context: renderedLatestEditContext,
                      revision: latestResultRevisionRef.current,
                      appliedText: text,
                      text: transcribedText,
                      correctionBaseline: latestCorrectionBaseline,
                      origin: latestResultOrigin,
                    });
                    ++latestCorrectionEpochRef.current;
                    setLatestResultOrigin("capture");
                    setTranscribedText(text);
                    journalLatestDraft(text);
                    setLatestCorrectionBaseline(text);
                    latestQueuedCorrectionRef.current = null;
                    setLatestLearnStatus(null);
                    setLatestResultDirty(true);
                    setLatestEditStatus(null);
                  }}
                />
                <SelectiveChangeReview key={latestReviewSessionRef.current.key}
                  original={latestRawTranscript ?? renderedLatestEditContext.original}
                  current={transcribedText}
                  originalLabel="Original"
                  disabled={isDictationBusy || isReprocessing || latestEditSaving || latestShortcutPreparing || Boolean(visibleDraftConflict)}
                  onChange={(text) => {
                    if (isDictationBusy || isReprocessing || latestEditSaving || latestShortcutPreparing || visibleDraftConflict ||
                        (renderedLatestEditContext.id && latestSaveRequestsRef.current.has(renderedLatestEditContext.id))) return;
                    changeLatestDraft(text, true);
                  }}
                />
                {latestEditTargetId && <p className="text-xs text-muted-foreground" role="status">
                  {latestEditSaving ? "Saving changes…" : transcribedText !== (latestSavedEdit ?? latestEditContextRef.current.original)
                    ? "Not saved to history" : latestEditStatus ?? "Saved in history"}
                </p>}
                {latestRecoveryDraft ? (
                  <div aria-label="Draft recovery" role={latestRecoveryDraft.status === "error" ? "alert" : "status"}
                    className={`flex flex-wrap items-center justify-between gap-2 text-xs ${latestRecoveryDraft.status === "error" ? "text-rust" : "text-muted-foreground"}`}>
                    <p>{latestRecoveryDraft.status === "pending"
                      ? "Saving a recovery copy on this Mac…"
                      : latestRecoveryDraft.status === "saved"
                        ? "Recovery copy saved on this Mac."
                        : "Recovery copy couldn't be saved. Keep this window open or copy your text."}</p>
                    {latestRecoveryDraft.status === "error" ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => {
                        if (renderedLatestEditContext !== latestEditContextRef.current || !renderedLatestEditContext.id) return;
                        void unfinishedEdits.retryDraft(renderedLatestEditContext.id);
                      }}>Retry recovery save</Button>
                    ) : null}
                  </div>
                ) : null}
                {latestEditError && <p role="alert" className="text-sm text-rust">{latestEditError}</p>}
                {visibleDraftConflict ? <section aria-label="Saved version changed" className="space-y-3 rounded-md border p-3">
                  <h3 className="text-sm font-medium">Saved version changed</h3>
                  <p className="whitespace-pre-wrap text-sm">{visibleDraftConflict.saved ?? visibleDraftConflict.context.original}</p>
                  <DictationChangeReview original={visibleDraftConflict.saved ?? visibleDraftConflict.context.original}
                    current={transcribedText} originalLabel="Saved version" />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={isDictationBusy || latestEditSaving}
                      onClick={() => resolveDraftSavedConflict(true)}>Use saved version</Button>
                    <Button size="sm" variant="outline" disabled={isDictationBusy || latestEditSaving}
                      onClick={() => resolveDraftSavedConflict(false)}>Keep my draft</Button>
                  </div>
                </section> : null}
                <p className="text-sm text-muted-foreground">
                  {(latestResultIsPreview || latestResultIsRecoveredDraft)
                    ? 'Copy this text, or save it and choose "Use for Paste last result" before switching apps.'
                    : <>
                        {repasteShortcutLabel
                          ? `To put this into another app, switch to that app and press ${repasteShortcutLabel}.`
                          : 'To put this into another app, set a "Paste last result" shortcut in Settings and press it from that app.'}{" "}
                        A button here can only reach Plainsong, because Plainsong is
                        the frontmost app while you are clicking in this window.
                      </>}
                </p>
                {latestResultDirty && latestShortcutText !== transcribedText ? (
                  <p className="text-sm text-muted-foreground">
                    {latestResultIsRecoveredDraft
                      ? "This recovered edit has not been inserted into another app. "
                      : latestResultIsPreview
                      ? "This preview has not been inserted into another app. "
                      : "You changed this after capture. "}
                    {repasteShortcutLabel ?? 'The "Paste last result" shortcut'}{" "}
                    has not been updated to this edit.{" "}
                    {latestEditTargetId ? 'Save your changes, then choose "Use for Paste last result" to update it. ' : ""}
                    Copy result uses the text you see here.
                  </p>
                ) : null}
                <LatestStylePreview text={transcribedText} sourceKey={latestEditContextRef.current}
                  appTarget={renderedLatestEditContext.appTarget ?? null}
                  disabled={isDictationBusy || latestEditSaving || latestShortcutPreparing}
                  onUsePreview={(text) => {
                    if (renderedLatestEditContext !== latestEditContextRef.current) return;
                    ++latestResultRevisionRef.current;
                    setLatestPreviewUndo({
                      kind: "preview",
                      context: renderedLatestEditContext,
                      revision: latestResultRevisionRef.current,
                      appliedText: text,
                      text: transcribedText,
                      correctionBaseline: latestCorrectionBaseline,
                      origin: latestResultOrigin,
                    });
                    ++latestCorrectionEpochRef.current;
                    setLatestResultOrigin("preview");
                    setTranscribedText(text);
                    journalLatestDraft(text);
                    setLatestCorrectionBaseline(text);
                    latestQueuedCorrectionRef.current = null;
                    setLatestLearnStatus(null);
                    setLatestResultDirty(true);
                    setLatestEditStatus(null);
                    setPasteStatus("Style preview ready. Save or copy it when you're ready.");
                  }}
                />
                {visibleLatestPreviewUndo && <Button variant="outline" size="sm"
                  disabled={isDictationBusy || latestEditSaving || latestShortcutPreparing}
                  onClick={() => {
                    const undo = visibleLatestPreviewUndo;
                    if (undo.context !== latestEditContextRef.current ||
                        undo.revision !== latestResultRevisionRef.current ||
                        undo.appliedText !== latestVisibleTextRef.current) return;
                    ++latestResultRevisionRef.current;
                    ++latestCorrectionEpochRef.current;
                    setLatestPreviewUndo(null);
                    setTranscribedText(undo.text);
                    journalLatestDraft(undo.text);
                    setLatestCorrectionBaseline(undo.correctionBaseline);
                    setLatestResultOrigin(undo.origin);
                    setLatestResultDirty(undo.text !== undo.context.original ||
                      (latestShortcutText !== null && undo.text !== latestShortcutText));
                    latestQueuedCorrectionRef.current = null;
                    setLatestLearnStatus(null);
                    setLatestEditStatus(undo.kind === "preview"
                      ? "Style preview undone."
                      : "Original restore undone.");
                    setLatestEditError(null);
                    setPasteStatus(undo.kind === "preview"
                      ? "Style preview undone. Your earlier text is back."
                      : "Restore undone. Your previous draft is back.");
                  }}>{visibleLatestPreviewUndo.kind === "preview"
                    ? "Undo style preview"
                    : "Undo restore"}</Button>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canLearnLatestCorrection}
                    onClick={() => void handleLearnLatestCorrection()}
                  >
                    Learn correction
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!transcribedText.trim()}
                    onClick={() => {
                      // Words selected in the result are the likely fix; with
                      // nothing selected, the whole result stands in.
                      const textarea = latestResultTextareaRef.current;
                      const selected = textarea
                        ? transcribedText.slice(textarea.selectionStart, textarea.selectionEnd).trim()
                        : "";
                      const replacement = selected || transcribedText.trim();
                      if (!replacement) {
                        return;
                      }
                      markDictionaryDraftChanged();
                      setNewDictionarySpokenForm("");
                      setNewDictionaryReplacement(replacement);
                      setDictionaryCsvStatus(
                        'Replace with is filled in. Type what Plainsong heard in Heard as, then choose Add.',
                      );
                      focusDictionaryHeardAsRef.current = true;
                      setActiveConfigTab("dictionary");
                      focusDictionaryHeardAs(dictionaryHeardAsNodeRef.current);
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
                {latestResultOrigin === "capture" && lastDictationStatus && (
                  <div
                    className={cn(
                      "rounded-md border p-3 text-sm",
                      lastDictationStatus.tone === "ready"
                        ? "border-gold/40 bg-gold/10 text-gold-text"
                        : lastDictationStatus.tone === "note"
                          ? "border-border bg-muted/20 text-foreground"
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
                            : lastDictationStatus.tone === "note"
                              ? "neume-hollow"
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
                        <details className="mt-3" data-testid="latest-dictation-details">
                          <summary className="cursor-pointer text-current/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            Dictation details
                          </summary>
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
                        </details>
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

          {activeCoachCards.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                <h2 className="section-heading">Dictation coach</h2>
                <p className="text-sm text-muted-foreground">
                  Tips for dictating with fewer corrections.
                </p>
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={coachExpanded}
                    aria-controls="dictation-coach-tips"
                    onClick={() => setCoachExpanded((expanded) => !expanded)}
                  >
                    {coachExpanded ? "Hide tips" : "Show tips"}
                  </Button>
              </div>
              {coachExpanded && <div id="dictation-coach-tips" className="grid gap-3 xl:grid-cols-2">
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
                          {card.actionLabel}
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
                      {/* A tip whose action is only "Got it" already closes
                          it; a second Dismiss would do the same thing. */}
                      {card.id === "command_mode" || card.id === "profiles" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => dismissCoachCard(card.id)}
                        >
                          Dismiss
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>}
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
            <details className="group">
              <summary className="w-fit cursor-pointer rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                Activity
              </summary>
              <div className="pt-3">
            {dictationInsights ? (
              <div className="space-y-3">
                <DictationStats insights={dictationInsights} />
                <div className="flex flex-wrap gap-x-6 gap-y-2 px-1 text-xs text-muted-foreground">
                  {[
                    { label: "Last 7 days", value: formatNumber(Math.round(dictationInsights.lastSevenDaysDictations)) },
                    { label: "Active days", value: formatNumber(Math.round(dictationInsights.activeDays)) },
                    { label: "Average words", value: formatNumber(Math.round(dictationInsights.averageWordsPerDictation)) },
                    { label: "Commands used", value: formatNumber(Math.round(dictationInsights.commandsUsed)) },
                    { label: "Backtracks", value: formatNumber(Math.round(dictationInsights.backtracksUsed)) },
                    { label: "Phrases expanded", value: formatNumber(Math.round(dictationInsights.snippetsTriggered)) },
                    {
                      label: "Top app",
                      value: dictationInsights.topAppTarget
                        ? `${dictationInsights.topAppTarget} (${dictationInsights.topAppTargetCount})`
                        : "None yet",
                    },
                  ].map((stat) => (
                    <span key={stat.label}>
                      {stat.label}{" "}
                      <span className="font-medium text-foreground">{stat.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No saved dictation stats yet. Stats start filling in once
                dictations are retained in history.
              </p>
            )}
              </div>
            </details>
            <div className="space-y-2">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search saved dictations"
                  ref={historySearchInputRef}
                  className="bg-muted/30 pl-9"
                  placeholder="Search saved dictations…"
                  value={historySearchQuery}
                  onChange={(event) =>
                    handleHistorySearchChange(event.target.value)
                  }
                  onKeyDown={(event) => {
                    // Down from the field lands on the first hit; Escape
                    // clears the query and puts the whole list back.
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusHistoryResult(0);
                    } else if (event.key === "Escape") {
                      handleHistorySearchChange("");
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
              visibleHistorySearchError ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  <p>Search failed: {visibleHistorySearchError}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={historySearchPending}
                    onClick={() =>
                      runHistorySearch(
                        trimmedHistorySearchQuery,
                        historySearchRevisionRef.current,
                        historySearchSourceRef.current,
                      )
                    }
                  >
                    Retry search
                  </Button>
                </div>
              ) : visibleHistorySearchResults === null || historySearchPending ? (
                <p className="text-sm text-muted-foreground">Searching…</p>
              ) : visibleHistorySearchResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved dictation matches &ldquo;
                  {trimmedHistorySearchQuery}&rdquo;. Only dictations still in
                  history can be searched — auto-delete removes the rest.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {visibleHistorySearchResults.length === 1
                      ? "1 match"
                      : `${visibleHistorySearchResults.length} matches`}
                  </p>
                  {isOpeningHistoryEntry && <p role="status" className="text-sm text-muted-foreground">Opening saved dictation…</p>}
                  {visibleHistorySearchResults.map((hit, index) => (
                    <button
                      key={hit.recordingId}
                      type="button"
                      ref={(element) => {
                        historyResultRefs.current[index] = element;
                      }}
                      aria-label={`Open saved dictation: ${hit.recordingTitle}`}
                      className="w-full rounded-md border p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onClick={(event) => void openHistoryEntryById(hit.recordingId, event.currentTarget)}
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
                        {dictationSearchMatchLabel(hit.matchedField)}
                      </p>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <>
              {dictationHistoryError ? (
                <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust">
                  <span>{dictationHistoryError}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void refetchDictationHistory()}>
                    Retry history
                  </Button>
                </div>
              ) : null}
              {(!dictationHistoryError || dictationHistory.length > 0) ? <DictationHistoryList
                recordings={dictationHistory}
                isLoading={dictationHistoryLoading}
                formatDuration={formatRecordingDuration}
                onOpen={openHistoryEntry}
                onCopy={(recording) => handleCopyHistoryTranscript(recording.id)}
                onDelete={requestHistoryDelete}
                shortcutLabel={hotkeyLabel}
              /> : null}
              </>
            )}
          </section>

          <section className="space-y-4 border-t border-border/60 pt-6">
            <div>
              <h2 ref={dictationSetupRef} tabIndex={-1} className="section-heading scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">Set up dictation</h2>
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
                  <TabsTrigger key={tab.value} value={tab.value} aria-label={tab.label}
                    aria-describedby={tab.value === "corrections" && groupedCorrectionSuggestions.length ? "pending-correction-count" : undefined}>
                    {tab.label}
                    {tab.value === "corrections" && groupedCorrectionSuggestions.length > 0 && (
                      <span id="pending-correction-count" className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums">
                        {groupedCorrectionSuggestions.length}{" "}<span className="sr-only">pending {groupedCorrectionSuggestions.length === 1 ? "correction" : "corrections"}</span>
                      </span>
                    )}
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
                              ? "border-gold/40 bg-gold/10 shadow-sm"
                              : "border-border bg-background hover:border-gold/30 hover:bg-muted/40",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "h-4 w-4",
                                isActive
                                  ? "text-gold-text"
                                  : "text-muted-foreground",
                              )}
                            />
                            {isActive ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-text">
                                <span aria-hidden="true" className="neume neume-lit" />
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
                  {rewriteReadiness ? (
                    <StatusBanner
                      title={rewriteReadiness.title}
                      message={rewriteReadiness.message}
                      tone={rewriteReadiness.tone}
                      role={rewriteReadiness.role}
                      actions={
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => requestReadinessDestination("models")}
                        >
                          Choose rewrite model
                        </Button>
                      }
                    />
                  ) : null}
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
                      What this profile prefers for every capture, shortcut
                      included. The capture panel names the selected speech
                      model and tells you when it still needs setup.
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
                          aria-pressed={dictationRoutePreference === route}
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
                      {currentDictationProvider
                        ? `The speech model chosen in Settings runs ${
                            providerHostingPreference(
                              currentDictationProvider as AsrProviderType,
                            ) === "cloud"
                              ? "in the cloud."
                              : "on this Mac."
                          }`
                        : "Checking where your speech model runs…"}
                    </p>
                    {currentDictationProvider &&
                    describeDictationVocabularyNote(currentDictationProvider) ? (
                      <p className="text-sm text-muted-foreground">
                        {describeDictationVocabularyNote(currentDictationProvider)}
                      </p>
                    ) : null}
                    {!useSharedAsrSelection &&
                    currentDictationProvider &&
                    currentMeetingProvider &&
                    currentDictationProvider !== currentMeetingProvider ? (
                      <p className="text-sm text-rust">
                        Dictation uses {speechProviderName(currentDictationProvider)} while
                        meetings use {speechProviderName(currentMeetingProvider)}.
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <h3 className="section-heading">Override the next capture</h3>
                    <p className="text-sm text-muted-foreground">
                      Send one capture the other way without changing the
                      profile. Only the Start dictation button uses this; the
                      shortcut always follows the profile.
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
                          aria-pressed={nextCaptureRoutePreference === null}
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
                            aria-pressed={nextCaptureRoutePreference === route}
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
                                  ? `Switches on automatically on ${style.activationDomainMatcher}`
                                  : style.activationAppMatcher
                                    ? `Switches on automatically in ${style.activationAppMatcher}`
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
                              {style.voiceEdit
                                ? installedMode
                                  ? "Update"
                                  : "Install"
                                : installedMode
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
                                ? "border-gold/40 bg-gold/10 shadow-sm"
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
                                  {speechProviderName(mode.dictationProvider) ||
                                    "Current speech model"}{" "}
                                  · {speechModelName(mode.dictationProvider, mode.dictationModelId) || "Current model"}
                                  {mode.activationAppMatcher
                                    ? ` · Switches on automatically in ${mode.activationAppMatcher}`
                                    : ""}
                                  {mode.activationDomainMatcher
                                    ? ` · Switches on automatically on ${mode.activationDomainMatcher}`
                                    : ""}
                                  {!mode.activationAppMatcher &&
                                  !mode.activationDomainMatcher
                                    ? " · No app rule"
                                    : ""}
                                </p>
                              </div>
                              {isActive && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-text">
                                  <span aria-hidden="true" className="neume neume-lit" />
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
                              {pendingProfileDeleteId === mode.id ? null : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Delete profile ${mode.name}`}
                                  onClick={() => setPendingProfileDeleteId(mode.id)}
                                >
                                  Delete profile
                                </Button>
                              )}
                            </div>
                            {pendingProfileDeleteId === mode.id ? (
                              <div
                                role="group"
                                aria-label={`Confirm deleting ${mode.name}`}
                                className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-rust/40 bg-rust/5 p-2"
                              >
                                <p className="text-sm">
                                  Delete &ldquo;{mode.name}&rdquo;? This can&apos;t be undone.
                                </p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-rust"
                                  onClick={() => {
                                    setPendingProfileDeleteId(null);
                                    void handleDeleteCustomMode(mode.id);
                                  }}
                                >
                                  Delete
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  autoFocus
                                  onClick={() => setPendingProfileDeleteId(null)}
                                >
                                  Keep profile
                                </Button>
                              </div>
                            ) : null}
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
                        <Select
                          value={customModeDraft.baseModePreset}
                          onValueChange={(value) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              baseModePreset: value as DictationBaseModePreset,
                            }))
                          }
                        >
                          <SelectTrigger
                            id="custom-profile-base"
                            aria-label="Base style"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DICTATION_MODE_DEFINITIONS.filter(
                              (mode) => mode.id !== "custom",
                            ).map((mode) => (
                              <SelectItem key={mode.id} value={mode.id}>
                                {mode.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                        <Select
                          value={customModeDraft.numbersAsDigits}
                          onValueChange={(value) =>
                            setCustomModeDraft((current) => ({
                              ...current,
                              numbersAsDigits: value as CustomModeNumbersChoice,
                            }))
                          }
                        >
                          <SelectTrigger
                            id="custom-profile-numbers"
                            aria-label="Numbers as digits"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(
                              Object.keys(
                                CUSTOM_MODE_NUMBERS_CHOICE_LABELS,
                              ) as CustomModeNumbersChoice[]
                            ).map((choice) => (
                              <SelectItem key={choice} value={choice}>
                                {CUSTOM_MODE_NUMBERS_CHOICE_LABELS[choice]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                          placeholder="Optional grammar, tone, or perspective instructions."
                        />
                        <p className="text-sm text-muted-foreground">
                          Optional. Replaces the AI cleanup instructions
                          only when this profile is active. Keep facts, numbers,
                          and negation unchanged. Choose Voice Edit for tasks
                          that change the content.
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
                    <Select
                      value={dictationProfile}
                      onValueChange={(value) => {
                        const profile = value as
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
                      <SelectTrigger id="dictation-style">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal_speed">Normal Speed</SelectItem>
                        <SelectItem value="power_rewrite">Power Rewrite</SelectItem>
                      </SelectContent>
                    </Select>
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
                    <Select
                      value={defaultProjectId}
                      onValueChange={(value) => {
                        const nextProjectId = value;
                        setDefaultProjectId(nextProjectId);
                        void persistDictationPreferences({
                          projectId: nextProjectId,
                        });
                      }}
                    >
                      <SelectTrigger id="dictation-project">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inbox">Inbox</SelectItem>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    <Select
                      value={
                        currentDictationProvider === "macos_apple_speech"
                          ? "off"
                          : dictationLivePreviewEnabled
                            ? "on"
                            : "off"
                      }
                      disabled={currentDictationProvider === "macos_apple_speech"}
                      onValueChange={(value) => {
                        const next = value === "on";
                        setDictationLivePreviewEnabled(next);
                        void persistDictationPreferences({
                          livePreviewEnabled: next,
                        });
                      }}
                    >
                      <SelectTrigger id="dictation-live-preview">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="on">Show words as you speak</SelectItem>
                        <SelectItem value="off">Wait for the finished text</SelectItem>
                      </SelectContent>
                    </Select>
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
                      <Select
                        value={dictationLivePreviewEngine}
                        onValueChange={(value) => {
                          const next = value as
                            | "auto"
                            | "redecode"
                            | "streaming";
                          setDictationLivePreviewEngine(next);
                          void persistDictationPreferences({
                            livePreviewEngine: next,
                          });
                        }}
                      >
                        <SelectTrigger id="dictation-live-preview-engine">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            Whichever is available (recommended)
                          </SelectItem>
                          <SelectItem value="streaming">
                            Streaming engine when it can
                          </SelectItem>
                          <SelectItem value="redecode">
                            Re-transcribe as you speak
                          </SelectItem>
                        </SelectContent>
                      </Select>
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
                    <Select
                      value={dictationKeepWarm}
                      onValueChange={(value) => {
                        const next = value as "off" | "on";
                        setDictationKeepWarm(next);
                        void persistDictationPreferences({ keepWarm: next });
                      }}
                    >
                      <SelectTrigger id="dictation-keep-warm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      On preloads supported local models when memory allows.
                      With Off, other speech models release after transcription
                      and built-in cleanup after a minute idle. Parakeet follows
                      the timer below.
                    </p>
                    {currentAiProvider === "ollama" && (
                      <p className="text-sm text-muted-foreground">
                        With AI cleanup or a rewrite profile active, On also
                        preloads your selected Ollama model. Large models can
                        use several gigabytes of memory. Ollama controls how
                        long they stay loaded.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="speech-model-keep-ready"
                    >
                      Keep speech model ready for
                    </label>
                    <Select
                      value={speechModelKeepReady}
                      onValueChange={(value) => {
                        const next = value as SpeechModelKeepReady;
                        setSpeechModelKeepReady(next);
                        void persistDictationPreferences({
                          speechModelKeepReady: next,
                        });
                      }}
                    >
                      <SelectTrigger id="speech-model-keep-ready">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SPEECH_MODEL_KEEP_READY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Automatic keeps Parakeet ready for up to 30 minutes.
                      Memory pressure or other local models can release it
                      sooner, even on Always.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-context-source"
                    >
                      Text context
                    </label>
                    <Select
                      value={dictationContextSource}
                      onValueChange={(value) => {
                        const contextSource = value as DictationContextSource;
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
                      <SelectTrigger id="dictation-context-source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Off</SelectItem>
                        <SelectItem value="application_context">
                          Use application context
                        </SelectItem>
                        <SelectItem value="selected_text">Use selected text</SelectItem>
                        <SelectItem value="clipboard">Use clipboard</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      For selection edits, select text and start Voice Edit, or
                      choose Use selected text here. Clipboard uses copied text.
                      Application context adds app and window details.
                    </p>
                    <details className="text-sm text-muted-foreground">
                      <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        Spoken command examples
                      </summary>
                      <p className="mt-2">
                        {getDictationTextContextDescription(
                          dictationCommandPrefix,
                        )}
                      </p>
                    </details>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="dictation-insertion-mode"
                    >
                      Insertion mode
                    </label>
                    <Select
                      value={dictationInsertionMode}
                      onValueChange={(value) => {
                        const mode = value as DictationInsertionMode;
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
                      <SelectTrigger id="dictation-insertion-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Insert at cursor</SelectItem>
                        <SelectItem value="clipboard_only">Clipboard only</SelectItem>
                      </SelectContent>
                    </Select>
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
                      setting appears in Settings &gt; Privacy &amp; data; changing it
                      in either place changes both.
                    </p>
                    <Select
                      value={dictationRetentionPreset}
                      onValueChange={(value) => {
                        const preset = value as
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
                      <SelectTrigger
                        id="dictation-retention"
                        aria-describedby="dictation-retention-description"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="immediate">Immediately</SelectItem>
                        <SelectItem value="24h">After 24 hours</SelectItem>
                        <SelectItem value="72h">After 72 hours</SelectItem>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                    {dictationRetentionPreset === "custom" && (
                      <div className="space-y-2">
                        <label
                          className="text-sm text-muted-foreground"
                          htmlFor="dictation-retention-hours"
                        >
                          Custom hours
                        </label>
                        <CommittedNumberInput
                          id="dictation-retention-hours"
                          min={1}
                          className="w-full rounded-md border bg-background p-2 text-sm"
                          value={dictationRetentionCustomHours}
                          onCommit={(nextHours) => {
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
                      Add preferred spellings for names, brands, and jargon.
                      Plainsong replaces matching phrases and passes them as
                      hints to speech models that accept them. Hints may still
                      be misheard.
                      {" "}{dictionaryCoverageSummary}
                    </p>
                    {describeDictationVocabularyNote(currentDictationProvider) ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {describeDictationVocabularyNote(currentDictationProvider)}
                      </p>
                    ) : null}
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
                  Leave Only in app blank to apply everywhere. Fill it in when
                  the replacement should only happen in one app. These run
                  before phrase expansions.
                </p>

                {dictionaryCsvStatus && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {dictionaryCsvStatus}
                  </p>
                )}

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
                              →
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
                    ref={dictionaryHeardAsInputRef}
                    type="text"
                    aria-label="Heard as"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Heard as (e.g. open ai)"
                    value={newDictionarySpokenForm}
                    onChange={(event) => {
                      markDictionaryDraftChanged();
                      setNewDictionarySpokenForm(event.target.value);
                    }}
                  />
                  <input
                    type="text"
                    aria-label="Replace with"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Replace with (e.g. OpenAI)"
                    value={newDictionaryReplacement}
                    onChange={(event) => {
                      markDictionaryDraftChanged();
                      setNewDictionaryReplacement(event.target.value);
                    }}
                  />
                  <input
                    type="text"
                    aria-label="Only in app (optional)"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Only in app (optional)"
                    value={newDictionaryAppScope}
                    onChange={(event) => {
                      markDictionaryDraftChanged();
                      setNewDictionaryAppScope(event.target.value);
                    }}
                  />
                  <Button
                    variant="outline"
                    disabled={isAddingDictionaryEntry}
                    onClick={() => void handleAddDictionaryEntry()}
                  >
                    {isAddingDictionaryEntry ? "Adding…" : "Add"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,240px)]">
                  <Select
                    value={newDictionaryCategoryScope}
                    onValueChange={(value) => {
                      markDictionaryDraftChanged();
                      setNewDictionaryCategoryScope(
                        value as DictationAppCategoryKey | "any",
                      );
                    }}
                  >
                    <SelectTrigger aria-label="New dictionary entry destination category">
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
                    onChange={(event) => {
                      markDictionaryDraftChanged();
                      setNewDictionaryCaseSensitive(event.target.checked);
                    }}
                  />
                  Case-sensitive match
                </label>

                {failedDictionarySubmissions.map((failed) => {
                  const ownsCurrentDraft =
                    dictionaryDraftRevisionRef.current === failed.revision;
                  const retryLabel = ownsCurrentDraft
                    ? "Retry add"
                    : "Retry previous entry";
                  const entryLabel = `${failed.submission.spokenForm} → ${failed.submission.replacement}`;
                  return (
                    <div
                      key={failed.key}
                      role="alert"
                      className="flex flex-wrap items-center gap-2 rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust"
                    >
                      <p>
                        {failed.message}{" "}
                        {ownsCurrentDraft
                          ? "Your draft is unchanged."
                          : "Your newer draft is unchanged."}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isAddingDictionaryEntry}
                        aria-label={
                          failedDictionarySubmissions.length > 1
                            ? `${retryLabel}: ${entryLabel}`
                            : undefined
                        }
                        onClick={() => void handleRetryDictionaryEntry(failed)}
                      >
                        {isAddingDictionaryEntry ? "Adding…" : retryLabel}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={isAddingDictionaryEntry}
                        aria-label={`Dismiss failed entry: ${entryLabel}`}
                        onClick={() =>
                          setFailedDictionarySubmissions((current) =>
                            current.filter((entry) => entry.key !== failed.key),
                          )
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  );
                })}
                {dictionaryAddStatus && (
                  <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                    <p>{dictionaryAddStatus}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDictionaryAddStatus(null)}
                    >
                      Clear
                    </Button>
                  </div>
                )}

                {dictationDictionaryEntries.length > 0 && (
                  <div className="space-y-2">
                    {dictationDictionaryEntries.map((entry) => (
                      <fieldset
                        disabled={correctionInboxBusy}
                        key={entry.id}
                        role="group"
                        aria-label={`Dictionary entry: ${entry.spokenForm} to ${entry.replacement}`}
                        className="rounded-md border p-2 space-y-2"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            aria-label="Heard as"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={entry.spokenForm}
                            onChange={(event) =>
                              updateDictionaryEntryDraft(
                                entry.id,
                                "spokenForm",
                                event.target.value,
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
                            aria-label="Replace with"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            value={entry.replacement}
                            onChange={(event) =>
                              updateDictionaryEntryDraft(
                                entry.id,
                                "replacement",
                                event.target.value,
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
                            aria-label="Only in app"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            placeholder="Only in app"
                            value={entry.appScope ?? ""}
                            onChange={(event) =>
                              updateDictionaryEntryDraft(
                                entry.id,
                                "appScope",
                                event.target.value,
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
                            <SelectTrigger aria-label="Destination category">
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
                            disabled={dictionaryEntryDeletingIds.has(entry.id)}
                            onClick={() =>
                              void handleDeleteDictionaryEntry(entry.id)
                            }
                          >
                            {dictionaryEntryDeletingIds.has(entry.id)
                              ? "Removing…"
                              : dictionaryEntryDeleteFailures[entry.id]
                                ? "Retry remove"
                                : "Remove"}
                          </Button>
                        </div>
                        {dictionaryEntryDeleteFailures[entry.id] && (
                          <p role="alert" className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                            {dictionaryEntryDeleteFailures[entry.id]}
                          </p>
                        )}
                        {dictionaryEntrySaveFailures[entry.id] && (
                          <div
                            role="alert"
                            className="flex flex-wrap items-center gap-2 rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust"
                          >
                            <p>{dictionaryEntrySaveFailures[entry.id]}</p>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={dictionaryEntryRetryingIds.has(entry.id)}
                              onClick={() => retryDictionaryEntrySave(entry.id)}
                            >
                              {dictionaryEntryRetryingIds.has(entry.id)
                                ? "Saving…"
                                : "Retry save"}
                            </Button>
                          </div>
                        )}
                      </fieldset>
                    ))}
                  </div>
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
                    onChange={(event) => {
                      markNewSnippetDraftChanged();
                      setNewSnippetTrigger(event.target.value);
                    }}
                  />
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Expansion (e.g. be right back)"
                    value={newSnippetExpansion}
                    onChange={(event) => {
                      markNewSnippetDraftChanged();
                      setNewSnippetExpansion(event.target.value);
                    }}
                  />
                  <input
                    type="text"
                    aria-label="Only in app (optional)"
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Only in app (optional)"
                    value={newSnippetAppScope}
                    onChange={(event) => {
                      markNewSnippetDraftChanged();
                      setNewSnippetAppScope(event.target.value);
                    }}
                  />
                  <Button
                    variant="outline"
                    disabled={snippetAdding || !newSnippetTrigger.trim() || !newSnippetExpansion.trim()}
                    onClick={() => void handleAddSnippet()}
                  >
                    {snippetAdding ? "Adding…" : snippetAddError ? "Retry add" : "Add"}
                  </Button>
                </div>
                {snippetAddError && <p role="alert" className="text-sm text-rust">{snippetAddError}</p>}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,240px)]">
                  <Select
                    value={newSnippetCategoryScope}
                    onValueChange={(value) => {
                      markNewSnippetDraftChanged();
                      setNewSnippetCategoryScope(value as DictationAppCategoryKey | "any");
                    }}
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
                    onChange={(event) => {
                      markNewSnippetDraftChanged();
                      setNewSnippetCaseSensitive(event.target.checked);
                    }}
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
                        {snippetSaveStates[snippet.id]?.pending && <p role="status" className="text-sm text-muted-foreground">Saving snippet...</p>}
                        {snippetSaveStates[snippet.id]?.failed && (
                          <div className="flex items-center gap-2">
                            <p role="alert" className="text-sm text-destructive">Some changes aren't saved yet. Your local draft is still here.</p>
                            <Button variant="outline" size="sm" disabled={snippetSaveStates[snippet.id]?.pending}
                              onClick={() => patchSnippet(snippet.id, {
                                trigger: snippet.trigger.trim(), expansion: snippet.expansion.trim(),
                                appScope: snippet.appScope?.trim() || null, caseSensitive: snippet.caseSensitive,
                                enabled: snippet.enabled, categoryScope: snippet.categoryScope,
                              })}>Retry save</Button>
                          </div>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={snippet.trigger}
                            onChange={(event) =>
                              updateSnippetDraft(snippet.id, { trigger: event.target.value })
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
                              updateSnippetDraft(snippet.id, { expansion: event.target.value })
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, {
                                expansion: event.target.value.trim(),
                              })
                            }
                          />
                          <input
                            type="text"
                            aria-label="Only in app"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            placeholder="Only in app"
                            value={snippet.appScope ?? ""}
                            onChange={(event) =>
                              updateSnippetDraft(snippet.id, { appScope: event.target.value })
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
                {correctionApprovalError && (
                  <div role="alert" className="space-y-2 text-sm text-destructive">
                    <p>{correctionApprovalError}</p>
                    <Button type="button" size="sm" variant="outline" disabled={correctionInboxBusy}
                      onClick={() => void handleRefreshCorrectionSuggestions()}>
                      Refresh corrections
                    </Button>
                  </div>
                )}

                {correctionApprovalNotices.map((notice) => (
                  <div key={notice.key} role="status" tabIndex={-1}
                    ref={(element) => focusCorrectionApprovalTarget(element, notice.key, "notice")}
                    className="rounded-md border bg-muted/20 px-3 py-2 space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm">{notice.message}</p>
                      {notice.undoToken && <Button type="button" size="sm" variant="outline"
                        aria-disabled={correctionInboxBusy} aria-label={`Undo correction: ${notice.label}`}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        ref={(element) => focusCorrectionApprovalTarget(element, notice.key, "undo")}
                        onClick={(event) => void handleUndoCorrectionApproval(notice, event.currentTarget)}>
                        {correctionUndoEntryId === notice.entry.id ? "Undoing…" : "Undo"}
                      </Button>}
                      <Button type="button" size="sm" variant="ghost" aria-label={`Dismiss: ${notice.message}`}
                        onClick={() => setCorrectionApprovalNotices((prev) => prev.filter((entry) => entry.key !== notice.key))}>
                        Dismiss
                      </Button>
                    </div>
                    {notice.error && <p role="alert" className="text-sm text-destructive">{notice.error}</p>}
                  </div>
                ))}

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
                          void persistExternalCorrectionConsent(true);
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
                      Suggest corrections from edits
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
                          aria-disabled={correctionInboxBusy}
                          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                          onClick={(event) =>
                            void handleApproveCorrectionGroups(
                              inAppCorrectionSuggestionGroups.map((group) => group.suggestionIds),
                              event.currentTarget,
                            )
                          }
                        >
                          Approve whole inbox
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
                          Dismiss whole inbox
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
                        void persistExternalCorrectionConsent(event.target.checked);
                      }}
                    />
                    <span>
                      <span className="font-medium">
                        Learn from corrections you make in other apps
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        Off by default. When enabled, Plainsong checks only the
                        field it just typed into for up to 8 seconds. Some apps
                        support only a single check at 4 seconds. It compares
                        the text on this machine; nothing is sent anywhere.
                        Only word changes are saved for review, never the
                        surrounding sentence. Suggestions expire after a week.
                        Switching apps or fields stops capture.
                      </span>
                    </span>
                  </label>

                  {externalCorrectionConsentStatus !== "idle" && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {externalCorrectionConsentStatus === "saving"
                        ? "Saving correction learning…"
                        : "Couldn't confirm whether correction learning is on. Try the checkbox again."}
                    </p>
                  )}

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
                      {externalCorrectionConsentStatus !== "idle"
                        ? "Saved word changes remain available for review."
                        : dictationLearnFromExternalCorrections
                        ? "Nothing yet. Fix a word right after Plainsong types it somewhere, and the change shows up here to approve."
                        : "Nothing here while this is off — Plainsong is not reading any other app's text."}
                    </p>
                  )}
                </div>

                <div className="space-y-2 border-t pt-4">
                  <h3 className="section-heading">Fixing what you just said</h3>
                  <p className="text-sm text-muted-foreground">
                    Straight after an insert, say <code>scratch that</code> to
                    undo it, or <code>actually …</code>,{" "}
                    <code>no, say …</code>, <code>replace X with Y</code>, or{" "}
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
                    saveStates={commandPresetSaveStates}
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
                      into: brief in chat, fuller in email. Spoken lists
                      become numbered lists, and long dictation gets
                      paragraphs, in email, notes and task apps. Off formats
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
        returnFocusTarget={historyReturnFocusRef.current}
        returnFocusFallback={historySearchInputRef.current}
        onOpenChange={(open) => {
          if (open) { setIsDialogOpen(true); return; }
          const epoch = historyRequestEpochRef.current;
          void flushHistoryEdit().then((saved) => {
            if (!saved || historyRequestEpochRef.current !== epoch) return;
            historyOpenRequestRef.current += 1;
            setIsOpeningHistoryEntry(false);
            setIsDialogOpen(false);
          });
        }}
        recording={selectedRecording}
        transcript={selectedTranscript}
        historyDetails={selectedHistoryDetails}
        isLoadingTranscript={isLoadingTranscript}
        loadError={historyLoadError}
        onRetryLoad={() => {
          if (historyLoadError && !isLoadingTranscript) {
            setHistoryLoadError(null);
            setIsLoadingTranscript(true);
            setHistoryLoadRevision((revision) => revision + 1);
          }
        }}
        durationLabel={
          selectedRecording
            ? formatRecordingDuration(selectedRecording.duration)
            : "N/A"
        }
        reprocessModePreset={reprocessModePreset}
        onReprocessModePresetChange={(mode) => {
          cancelHistoryPreview();
          ++reprocessRequestEpochRef.current;
          setReprocessModePreset(mode);
          setReprocessedResult(null);
          setReprocessError(null);
        }}
        reprocessedResult={reprocessedResult}
        isReprocessing={isReprocessing}
        reprocessError={reprocessError}
        onReprocess={() => void handleReprocessSelectedDictation()}
        onCancelReprocess={cancelHistoryPreview}
        reprocessCancelling={reprocessCancelling}
        processAgainModeId={processAgainModeId}
        processAgainSpeechRoute={processAgainSpeechRoute}
        processAgainSpeechOptions={processAgainSpeechOptions}
        onProcessAgainSpeechRouteChange={(route) => {
          if (processAgainOperationRef.current) return;
          ++processAgainRequestEpochRef.current;
          setProcessAgainSpeechRoute(route);
          setProcessAgainOutcome(null);
          setProcessAgainError(null);
        }}
        onProcessAgainModeIdChange={(mode) => {
          if (processAgainOperationRef.current) return;
          ++processAgainRequestEpochRef.current;
          setProcessAgainModeId(mode);
          setProcessAgainOutcome(null);
          setProcessAgainError(null);
        }}
        processAgainCustomModes={dictationCustomModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
        }))}
        processAgainOutcome={processAgainOutcome}
        isProcessingAgain={isProcessingAgain}
        processAgainBusyMessage={isProcessingAgain
          && processAgainPendingSource?.id !== selectedRecording?.id
          ? `Process again is still running for ${processAgainPendingSource?.title ?? "another dictation"}.`
          : null}
        processAgainError={processAgainError}
        processAgainRefreshWarning={processAgainRefreshWarning}
        onProcessAgain={() => void handleProcessSelectedDictationAgain()}
        onOpenProcessAgainResult={() => {
          if (!processAgainOutcome) {
            return;
          }
          openHistoryEntry(processAgainOutcome.recording);
        }}
        onUseReprocessedResult={() => {
          if (!reprocessedResult || typeof reprocessedResult.outputText !== "string"
            || !reprocessedResult.outputText.trim()) {
            return;
          }
          ++latestResultRevisionRef.current;
          ++latestCorrectionEpochRef.current;
          setLatestResultOrigin("preview");
          const id = historyEditRef.current.loaded ? selectedRecording?.id ?? null : null;
          const saved = historyEditRef.current.saved;
          latestEditContextRef.current = { id, original: selectedTranscript?.fullText ?? "", saved,
            appTarget: selectedHistoryDetails?.activationMatcher ?? selectedHistoryDetails?.appTarget
              ?? selectedHistoryDetails?.contextAppName ?? null };
          setLatestEditTargetId(id);
          setLatestShortcutText(null);
          setLatestRawTranscript(selectedHistoryDetails?.rawTranscript ?? null);
          setLatestShortcutPreparing(false);
          setLatestSavedEdit(saved);
          setLatestEditSaving(false);
          setLatestEditStatus(null);
          setLatestEditError(null);
          setTranscribedText(reprocessedResult.outputText);
          if (id && reprocessedResult.outputText !== (saved ?? selectedTranscript?.fullText ?? "")) {
            void unfinishedEdits.saveDraft(id, reprocessedResult.outputText, saved);
          }
          setLatestCorrectionBaseline(reprocessedResult.outputText);
          latestQueuedCorrectionRef.current = null;
          setLatestLearnStatus(null);
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
        editDirty={historyCorrectionText !== (historySavedEdit ?? selectedTranscript?.fullText ?? "")}
        isSavingEdit={historyEditSaving}
        editError={historyEditError}
        editStatus={historyEditStatus}
        onSaveEdit={() => { void saveHistoryEdit(); }}
        onDiscardEdit={() => {
          if (historyEditSaveRef.current?.id === selectedRecording?.id) return;
          const current = historyEditRef.current;
          restoreHistoryText(current.saved ?? current.original);
          setHistoryEditStatus("Changes discarded.");
        }}
        onRestoreOriginal={() => restoreHistoryText(selectedTranscript?.fullText ?? "")}
        onRestoreText={restoreHistoryText}
        onCorrectionTextChange={(text) => {
          cancelHistoryPreview();
          ++reprocessInputRevisionRef.current;
          journalHistoryDraft(text);
          historyEditRef.current.draft = text;
          setHistoryCorrectionText(text);
          setHistoryEditStatus(null);
          setReprocessedResult(null);
          setReprocessError(null);
        }}
        onCorrectionBlur={() => {
          void maybeAutoLearnHistoryCorrection();
        }}
        canLearnCorrection={
          historyCorrectionBaseline.trim() !== historyCorrectionText.trim()
        }
        onLearnCorrection={() => void handleLearnHistoryCorrection()}
        learnStatus={historyLearnStatus}
        isReadingAloud={
          activeSpeechTarget === `history-${selectedRecording?.id ?? ""}`
        }
        onToggleReadAloud={() => {
          if (!selectedRecording || !selectedTranscript?.fullText) {
            return;
          }
          void toggleReadAloudPlayback(
            historyCorrectionText,
            `history-${selectedRecording.id}`,
          );
        }}
        onCopyStart={() => { ++clipboardActionEpochRef.current; }}
        onDelete={() => {
          if (!selectedRecording) {
            return;
          }
          requestHistoryDelete(selectedRecording);
        }}
      />

      <Dialog
        open={pendingHistoryDelete !== null}
        onOpenChange={(open) => {
          if (!open && !historyDeletePendingRef.current) {
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
              Any unfinished edit for this dictation will also be deleted from recovery.
            </DialogDescription>
          </DialogHeader>
          {historyDeleteError && <p role="alert" className="text-sm text-rust">{historyDeleteError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={historyDeleteBusy}
              onClick={() => setPendingHistoryDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={historyDeleteBusy}
              onClick={() => void handleDeleteHistoryItem()}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {historyDeleteBusy ? "Deleting…" : "Delete dictation"}
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
