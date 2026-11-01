import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { userFacingErrorMessage } from "@/lib/user-facing-error";
import { isDictationMemoryAdmissionRefusal, sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  Bell,
  Brain,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  Mic,
  Shield,
  ShieldCheck,
  Users,
  Volume2,
  XCircle,
} from "lucide-react";
import {
  downloadAsrModels,
  downloadDiarizationModel,
  getAsrProviders,
  getDiarizationModelPlan,
  listDownloadedModels,
  type DiarizationModelPlan,
  type DownloadedModelFile,
} from "@/lib/backend/asr";
import { NativeTextModelRow } from "@/components/models/native-text-model-row";
import { buildDownloadedModelIndex } from "@/components/models/downloaded-models";
import { speakerModelDownloadName } from "@/components/meetings/speaker-model-download-note";
import { invoke, listen } from "@/lib/electron";
import type {
  DictationStateChangedEvent,
  useDictationRuntime,
} from "@/features/dictation/runtime";
import {
  getDictationShortcutCapabilityStatus,
  getPermissionDiagnostics,
  getSettings,
  openInstalledPlainsongApp,
  openPermissionSettings,
  recordOnboardingState,
  requestDictationPermissions,
  updateSettings,
  verifyMeetingSetup,
  type PermissionDiagnostics,
  type SetupVerificationResult,
} from "@/lib/backend/settings";
import {
  getCalendarSnapshot,
  openCalendarPrivacySettings,
} from "@/lib/backend/calendar";
import type { CalendarAuthorization } from "@/lib/calendar-events";
import {
  PERMISSION_GATES,
  type PermissionGate,
  type PermissionGateKey,
  type PermissionGateObservations,
} from "@/features/onboarding/permission-gates";
import {
  getSystemAudioCapability,
  testSystemAudioCapture,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import {
  getDictationAudioLevel,
  startDictation,
  stopDictation,
} from "@/lib/backend/dictation";
import {
  defaultDictationShortcut,
  formatShortcutForDisplay,
  normalizeShortcut,
} from "@/lib/shortcuts";
import {
  buildAsrRouteCatalog,
  getRecommendedLaneRoute,
  isOnnxParakeetRoute,
  isRecommendedSpeechRoute,
  RECOMMENDED_SPEECH_ROUTE,
  routeDisplayLabel,
  routeIdFor,
} from "@/lib/asr-route-catalog";
import {
  getAsrModelCapability,
  isDownloadableProvider,
} from "@/lib/asr-capabilities";
import {
  canonicalSpeechRoute,
  defaultMeetingChoice,
  groupSpeechChoices,
  speechChoicesForLane,
  type SpeechChoice,
} from "@/lib/speech-model-choices";
import { withParakeetUpgrade } from "@/lib/parakeet-upgrade";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { describeModelDownloadError } from "@/lib/model-download-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelDownloadProgress } from "@/components/models/model-download-progress";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import { type OnboardingMode } from "@/lib/onboarding";
import { readAiNotesOptOut, writeAiNotesOptOut } from "@/lib/ai-notes-preference";
import {
  getNativeTextModelStatus,
  type NativeTextModelStatus,
  getOllamaStatus,
  listOllamaModelCatalog,
  listOllamaModels,
} from "@/lib/backend/ai";
import { probeOllamaModelReadiness } from "@/lib/ollama-model-readiness";
import { probeMeetingNotesRoute } from "@/hooks/use-setup-status";
import { resolveMeetingNotesRoute } from "@/features/readiness/meeting-notes-route";
import { describeMeetingAudio, MEETING_AUDIO_EXPLAINER } from "@/lib/meeting-audio-status";
import {
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
} from "@/components/models/ai-lanes";
import { requestReadinessDestination } from "@/lib/navigation";
import { findConflictingShortcuts } from "../../electron/shortcut-registration";
import { MicLevelMeter } from "@/components/onboarding/mic-level-meter";
import { MicrophoneStep } from "@/components/onboarding/microphone-step";

type Props = {
  mode?: OnboardingMode;
  onComplete(result?: {
    markOnboardingComplete?: boolean;
    meetingsCompleted?: boolean;
    /**
     * The reader closed the wizard with setup unfinished. Recorded durably so
     * "Skip setup for now" suppresses exactly what they declined, and nothing
     * else -- see features/onboarding/onboarding-gate.ts.
     */
    deferred?: boolean;
  }): void;
};

type Step =
  | "microphone"
  | "try-dictation"
  | "use-everywhere"
  | "ready"
  | "permissions"
  | "dictation-model"
  | "hotkey"
  | "meeting-setup"
  | "ai-notes";

/** How meeting summaries, action items and titles get written — or that they don't. */
type AiNotesChoice = "ollama" | "native_text" | "byok" | "none";

type ScratchDictationState =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "complete"
  | "error";

type PreservedDictationRoute = {
  routeId: string;
  providerType: AsrProviderType;
  modelId: string;
  label: string;
  /** Whether this model can also transcribe meetings (`laneCompatibility.meeting`). */
  meetingCapable: boolean;
};

// The speech step lists every distinct model this Mac can run, from the same
// catalog Settings > Models reads (`speechChoicesForLane`). The recommended
// one is computed, not stored: GGUF Parakeet where this build lists the
// transcribe.cpp route for it (Apple Silicon -- see settings.rs's
// `fresh_install_dictation_route`, which also points a new install's meeting
// slot at it, so one download covers both), ONNX Parakeet everywhere else.
// Where GGUF Parakeet can run, the ONNX build is never listed: it is the same
// model, kept as an internal fallback. Model weights are downloaded on
// demand; none ship inside the app bundle.
//
// The recommended card reads as what the choice means for the reader; every
// other model is one line with what sets it apart. Sizes come from the
// capability table and are shown in the decimal MB/GB that Finder uses -- see
// `formatDownloadSize`. No line names a chip, a file format or an engine.

/**
 * Parakeet v3's languages, said plainly: it is built for 25 European
 * languages, and English is the one tested in Plainsong
 * (`PARAKEET_V3_LANGUAGES` in asr-capabilities.ts).
 */
const PARAKEET_LANGUAGE_NOTE = "Tested in English. Also built for 24 other European languages.";

/** What the dictation step remembers about a route it can download or keep. */
type DictationRouteSummary = {
  routeId: string;
  providerType: AsrProviderType;
  modelId: string;
  label: string;
  sizeMib: number | null;
  meetingCapable: boolean;
};

function summarizeChoice(choice: SpeechChoice): DictationRouteSummary {
  return {
    routeId: choice.route.routeId,
    providerType: choice.route.providerType,
    modelId: choice.route.modelId,
    label: choice.route.label,
    sizeMib: choice.sizeMib,
    meetingCapable: choice.route.laneCompatibility.meeting,
  };
}

/** "Set up meetings later" in the meetings picker beside a dictation-only model. */
const MEETINGS_LATER = "later";

/**
 * What the meetings picker says about one model: recommended or not, and
 * what choosing it costs -- a download size, or nothing because it is here.
 */
function meetingOptionLabel(choice: SpeechChoice, available: boolean): string {
  const cost = available
    ? choice.route.hosting === "platform"
      ? "built in"
      : "on this Mac"
    : formatDownloadSize(choice.sizeMib);
  const details = [choice.recommended ? "recommended" : null, cost].filter(Boolean).join(", ");
  return details ? `${choice.route.label} — ${details}` : choice.route.label;
}

/**
 * The primary button on the speech step, naming the bytes it will fetch:
 * "Download 79 MB + 739 MB and continue". A download whose size is unknown
 * keeps the plain wording rather than a partial sum.
 */
function downloadAndContinueLabel(sizes: readonly (number | null)[]): string {
  const formatted = sizes.map((size) => formatDownloadSize(size));
  if (formatted.length === 0) {
    return "Continue";
  }
  return formatted.every((size) => size !== null)
    ? `Download ${formatted.join(" + ")} and continue`
    : "Download and continue";
}


/**
 * The speaker model plan, or null when it could not be read. Unknown is not
 * "missing": the wizard then neither offers nor downloads a speaker model.
 */
async function loadSpeakerModelPlan(): Promise<DiarizationModelPlan | null> {
  try {
    return (await getDiarizationModelPlan()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a route is downloaded and ready. The provider list reports state
 * for the one model each provider points at, so any other model of the same
 * provider counts as not ready rather than borrowing that answer.
 */
function isRouteReady(
  providers: readonly AsrProviderInfo[],
  route: { providerType: AsrProviderType; modelId: string },
): boolean {
  const provider = providers.find(
    (candidate) =>
      candidate.providerType === route.providerType &&
      candidate.selectedModelId === route.modelId,
  );
  return (
    provider !== undefined &&
    provider.inferenceEnabled !== false &&
    provider.runtimeStatus === "ready" &&
    (!isDownloadableProvider(provider.providerType) ||
      normalizeDownloadStatus(provider.downloadStatus).kind === "downloaded")
  );
}

/** The meetings model settings name, when it can transcribe meetings. */
type ConfiguredMeeting = {
  routeId: string;
  /** The listed model it reads as: GGUF Parakeet for the ONNX build. */
  canonicalRouteId: string;
  label: string;
  hosting: "local" | "cloud" | "platform";
};

/**
 * What a meetings picker offers, read once from settings, the provider list
 * and the files on disk: every model that can transcribe meetings, which
 * routes work without a download, and the meetings model settings name.
 *
 * A meetings model that already works but is not one of the listed models
 * (the earlier build of Parakeet v3, a cloud service) is offered as it is, so
 * a picker never replaces it with a download; the earlier Parakeet v3 stands
 * in for the listed one, so Parakeet v3 is offered once. An unreadable file
 * list counts nothing as present: the picker may then name a download that
 * turns out to be unnecessary, never the reverse.
 */
function readMeetingPicker(
  settings: Awaited<ReturnType<typeof getSettings>>,
  providers: readonly AsrProviderInfo[],
  downloadedFiles: readonly DownloadedModelFile[] | null,
): {
  choices: SpeechChoice[];
  availableRouteIds: ReadonlySet<string>;
  configured: ConfiguredMeeting | null;
} {
  const routes = buildAsrRouteCatalog([...providers], "prefer_local");
  const downloadIndex = downloadedFiles ? buildDownloadedModelIndex(downloadedFiles) : null;
  // Ready without a download: a local model on disk, or a built-in or cloud
  // route that reports ready.
  const routeAvailable = (route: (typeof routes)[number]) =>
    route.hosting === "local"
      ? downloadIndex?.presentRouteIds.has(route.routeId) === true ||
        isRouteReady(providers, route)
      : route.readiness === "ready";
  const shared = settings.transcription.useSharedAsrSelection ?? true;
  const provider = shared
    ? settings.transcription.defaultProvider
    : settings.transcription.meetingProvider;
  const modelId =
    (shared ? settings.transcription.selectedModelId : settings.transcription.meetingModelId) ??
    providers.find((candidate) => candidate.providerType === provider)?.selectedModelId ??
    null;
  const configuredRoute =
    routes.find(
      (route) =>
        route.providerType === provider &&
        route.modelId === modelId &&
        route.laneCompatibility.meeting,
    ) ?? null;
  const canonicalId = configuredRoute
    ? canonicalSpeechRoute(routes, configuredRoute)?.routeId ?? configuredRoute.routeId
    : null;
  let choices = speechChoicesForLane(routes, "meeting").filter((choice) => choice.route.selectable);
  if (
    configuredRoute &&
    routeAvailable(configuredRoute) &&
    !choices.some((choice) => choice.route.routeId === configuredRoute.routeId)
  ) {
    choices = [
      { route: configuredRoute, recommended: false, note: "", sizeMib: null },
      ...choices.filter(
        (choice) => !configuredRoute.superseded || choice.route.routeId !== canonicalId,
      ),
    ];
  }
  return {
    choices,
    availableRouteIds: new Set(routes.filter(routeAvailable).map((route) => route.routeId)),
    configured:
      configuredRoute && canonicalId
        ? {
            routeId: configuredRoute.routeId,
            canonicalRouteId: canonicalId,
            label: configuredRoute.label,
            hosting: configuredRoute.hosting,
          }
        : null,
  };
}

/**
 * Point the meeting slot at a model, with dictation and meetings on their
 * own slots from then on. Dictation keeps the model it was reading: the
 * shared pair, when the two lanes were still shared.
 */
function setMeetingSlot(
  settings: Awaited<ReturnType<typeof getSettings>>,
  providerType: AsrProviderType,
  modelId: string,
) {
  const transcription = settings.transcription;
  if (transcription.useSharedAsrSelection) {
    transcription.dictationProvider = transcription.defaultProvider;
    transcription.dictationModelId = transcription.selectedModelId;
  }
  transcription.useSharedAsrSelection = false;
  transcription.meetingProvider = providerType;
  transcription.meetingModelId = modelId;
}

/**
 * A download size the way macOS shows one: decimal MB and GB, as Finder and
 * the App Store count them.
 *
 * The capability table records sizes in MiB (and the shared
 * `formatModelSize` prints MiB/GiB for Settings), so this converts rather than
 * relabels: 639 MiB is 670 MB. Null when the size is unknown, so a caller can
 * leave the number out instead of printing "size unknown" to a first-time
 * reader.
 */
function formatDownloadSize(sizeMib: number | null | undefined): string | null {
  if (typeof sizeMib !== "number" || !Number.isFinite(sizeMib) || sizeMib <= 0) {
    return null;
  }
  const megabytes = (sizeMib * 1024 * 1024) / 1_000_000;
  return megabytes >= 1000
    ? `${(megabytes / 1000).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

// The rows themselves live in features/onboarding/permission-gates.ts, with
// the sentence each one owes the reader: what Plainsong does with the grant,
// and what stops working without it.
/**
 * The two grants the "Use it everywhere" step is about: inserting at the
 * cursor, and typing when insertion is refused. Same definitions, same
 * sentences as the permissions step -- a reader who reads a row twice should
 * read the same thing twice.
 */
const CURSOR_INSERTION_GATES = PERMISSION_GATES.filter(
  (gate) => gate.key === "accessibility" || gate.key === "keyboard_fallback",
);

const PERMISSION_GATE_ICONS: Record<string, ReactNode> = {
  microphone: <Mic className="h-4 w-4" />,
  accessibility: <ShieldCheck className="h-4 w-4" />,
  keyboard_fallback: <Shield className="h-4 w-4" />,
  system_audio: <Volume2 className="h-4 w-4" />,
  speech: <Brain className="h-4 w-4" />,
  calendar: <CalendarDays className="h-4 w-4" />,
  notifications: <Bell className="h-4 w-4" />,
};

const STEP_LABELS: Record<Step, string> = {
  microphone: "Microphone check",
  "try-dictation": "Try dictation here",
  "use-everywhere": "Use it everywhere",
  ready: "Ready",
  permissions: "Permissions",
  "dictation-model": "Speech model",
  hotkey: "Shortcut",
  "meeting-setup": "Meeting setup",
  "ai-notes": "Meeting notes",
};

type HotkeyMode = "hold_to_talk" | "toggle" | "hands_free";

// The same three behaviors Settings > Shortcuts offers (see
// settings-view-simple.tsx's "How the dictation shortcut works"), written
// the same way, so the wizard and Settings describe one feature.
const HOTKEY_MODE_LABELS: Record<HotkeyMode, { name: string; hint: string }> = {
  hold_to_talk: { name: "Hold to talk", hint: "Hold the shortcut while you speak, and let go to paste." },
  toggle: { name: "Press to toggle", hint: "Press once to start, and press again to paste." },
  hands_free: { name: "Hands-free", hint: "Starts on its own when you speak, and stops when you pause." },
};

export function dictationShortcutConflictMessage(
  shortcuts: Parameters<typeof findConflictingShortcuts>[0],
  shortcutValue: string
): string | null {
  const toggleDictation = normalizeShortcut(shortcutValue);
  const conflict = findConflictingShortcuts({
    ...shortcuts,
    toggleDictation,
  }).find(
    (item) =>
      item.field === "toggleDictation" ||
      item.conflictsWithField === "toggleDictation"
  );
  if (!conflict) {
    return null;
  }
  const owner =
    conflict.field === "toggleDictation" ? conflict.conflictsWith : conflict.label;
  return `${toggleDictation} conflicts with ${owner}. Choose a different dictation shortcut.`;
}

function formatShortcutFromKeyboardEvent(event: KeyboardEvent<HTMLInputElement>) {
  const parts: string[] = [];
  if (event.metaKey) parts.push("Cmd");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const key = event.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key) || parts.length === 0) {
    return null;
  }

  let mainKey = "";
  if (key === " ") {
    mainKey = "Space";
  } else if (key.length === 1) {
    mainKey = key.toUpperCase();
  } else {
    const normalized = key.startsWith("Arrow") ? key.replace("Arrow", "") : key;
    mainKey = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return [...parts, mainKey].join("+");
}

/**
 * The meeting model, named the way the model pickers name it: the plain model
 * name for a model on this Mac, and the service beside it for a cloud one.
 */
function summarizeMeetingRoute(provider: AsrProviderType | null, modelId: string | null, providers: AsrProviderInfo[]) {
  if (!provider) {
    return "No meeting model chosen";
  }
  const route = modelId
    ? buildAsrRouteCatalog(providers, "prefer_local").find(
        (candidate) => candidate.providerType === provider && candidate.modelId === modelId,
      )
    : undefined;
  if (route) {
    return route.hosting === "cloud" ? `${route.providerLabel} · ${route.label}` : route.label;
  }
  const providerInfo = providers.find((item) => item.providerType === provider);
  const modelLabel = modelId
    ? routeDisplayLabel(
        provider,
        modelId,
        providerInfo?.modelOptions.find((option) => option.id === modelId)?.label ?? modelId,
      )
    : null;
  return modelLabel ?? providerInfo?.name ?? provider;
}

type MeetingRouteCatalog = ReturnType<typeof buildAsrRouteCatalog>;

async function getMeetingRouteCatalog(
  providers: AsrProviderInfo[],
  currentProvider: AsrProviderType | null,
  currentModelId: string | null,
): Promise<MeetingRouteCatalog> {
  const routes = buildAsrRouteCatalog(providers, "prefer_local");
  const checked = new Map<string, MeetingRouteCatalog[number]>();
  const checkRoute = async (route: MeetingRouteCatalog[number]) => {
    const prior = checked.get(route.routeId);
    if (prior) return prior;
    const provider = providers.find((item) => item.providerType === route.providerType);
    let readiness = route.readiness;
    if (provider && provider.inferenceEnabled && route.hosting === "local") {
      if (provider.selectedModelId === route.modelId) {
        if (provider.runtimeStatus === "missing_model") readiness = "needs_download";
      } else {
        const diagnostics = await invoke<unknown>("get_asr_runtime_diagnostics", {
          providerType: route.providerType,
          modelId: route.modelId,
        });
        if (
          !diagnostics || typeof diagnostics !== "object" ||
          !("providerType" in diagnostics) || diagnostics.providerType !== route.providerType ||
          !("selectedModelId" in diagnostics) || diagnostics.selectedModelId !== route.modelId ||
          !("runtimeStatus" in diagnostics) ||
          (diagnostics.runtimeStatus !== "ready" && diagnostics.runtimeStatus !== "missing_model" &&
            diagnostics.runtimeStatus !== "missing_runtime" && diagnostics.runtimeStatus !== "error")
        ) {
          throw new Error("Could not verify the exact meeting model. Check setup again.");
        }
        readiness = diagnostics.runtimeStatus === "ready"
          ? "ready"
          : diagnostics.runtimeStatus === "missing_model"
            ? "needs_download"
            : "unavailable";
      }
    }
    const result = { ...route, readiness };
    checked.set(route.routeId, result);
    return result;
  };
  const current = routes.find((route) =>
    route.providerType === currentProvider && route.modelId === currentModelId &&
    route.laneCompatibility.meeting
  );
  let checkFailed = false;
  if (current) {
    try {
      const configured = await checkRoute(current);
      // A working configured route needs no replacement or unrelated probes.
      if (configured.readiness === "ready") return [configured];
    } catch {
      checkFailed = true;
    }
  }
  let candidates = routes;
  while (candidates.length > 0) {
    const recommendation = getRecommendedLaneRoute(
      candidates.map((route) => checked.get(route.routeId) ?? route),
      "meeting",
      "prefer_local",
    );
    if (!recommendation) break;
    try {
      const verified = await checkRoute(recommendation);
      if (verified.readiness === "ready") return [verified];
      if (verified.readiness === "needs_download") {
        // Rerank after correcting provider-wide readiness for this exact model.
        const next = getRecommendedLaneRoute(
          candidates.map((route) => checked.get(route.routeId) ?? route),
          "meeting",
          "prefer_local",
        );
        if (next?.routeId === verified.routeId) return [verified];
        continue;
      }
    } catch {
      checkFailed = true;
    }
    candidates = candidates.filter((route) => route.routeId !== recommendation.routeId);
  }
  if (checkFailed) throw new Error("Could not verify a meeting model. Check setup again.");
  return [];
}

function isMeetingRouteReady(
  providerType: AsrProviderType | null,
  modelId: string | null,
  routes: MeetingRouteCatalog,
) {
  return routes.some((route) =>
    route.providerType === providerType &&
    route.modelId === modelId &&
    route.laneCompatibility.meeting &&
    route.readiness === "ready"
  );
}

type MeetingRecommendedRoute = {
  providerType: AsrProviderType;
  modelId: string;
  label: string;
  /** False for a model the reader picked in place of the recommended one. */
  recommended: boolean;
  /** False when the model is already on this Mac and only needs choosing. */
  needsDownload: boolean;
  sizeMib: number | null;
  /**
   * The same model the dictation lane names (GGUF Parakeet on a new Apple
   * Silicon install), so choosing it for meetings costs no second download.
   */
  sameAsDictation: boolean;
};

function getRecommendedMeetingRoute(
  routes: MeetingRouteCatalog,
  dictationRoute: { providerType: string | null; modelId: string | null },
): MeetingRecommendedRoute | null {
  const recommended = getRecommendedLaneRoute(
    routes,
    "meeting",
    "prefer_local",
  );
  if (!recommended) {
    return null;
  }
  return {
    providerType: recommended.providerType,
    modelId: recommended.modelId,
    label: recommended.label,
    recommended: true,
    needsDownload: recommended.readiness !== "ready",
    sizeMib:
      recommended.capability?.sizeMib ??
      getAsrModelCapability(recommended.providerType, recommended.modelId)?.sizeMib ??
      null,
    sameAsDictation:
      recommended.providerType === dictationRoute.providerType &&
      recommended.modelId === dictationRoute.modelId,
  };
}

/**
 * What the system-audio test found, in the reader's words. The sidecar's own
 * sentence (which names callbacks and routes) goes to the Details list.
 */
type SystemAudioTestOutcome = {
  outcome: "passed" | "failed";
  message: string;
  detail: string | null;
};

export function FirstRunWizard({ mode = "full", onComplete }: Props) {
  const [step, setStep] = useState<Step>(
    mode === "full"
      ? "dictation-model"
      : mode === "meetings"
        ? "meeting-setup"
        : "permissions"
  );

  // The steps the reader came through, newest last, so Back returns to the
  // step they actually saw (Ready can be reached straight from the shortcut
  // step when meetings are skipped).
  const [stepHistory, setStepHistory] = useState<Step[]>([]);
  const goToStep = (next: Step) => {
    setStepHistory((history) => [...history, step]);
    setStep(next);
  };

  // This wizard is a real modal: give it dialog semantics and trap focus
  // inside it so keyboard users can't Tab into the obscured app behind it.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const stepBodyRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // The model download can run for minutes, and the wizard unmounts the moment
  // onboarding completes. Anything that resumes after an `await` has to check
  // this before writing settings or state, or a late completion clobbers
  // whatever the user changed in the meantime.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
  }, []);

  const trapDialogFocus = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const node = dialogRef.current;
    if (!node) {
      return;
    }
    const focusables = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.tabIndex >= 0);
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeElement = document.activeElement;
    const activeIsTabbable = focusables.some((element) => element === activeElement);
    if (event.shiftKey && (activeElement === first || !activeIsTabbable)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const [perms, setPerms] = useState<PermissionDiagnostics | null>(null);
  const [permsLoading, setPermsLoading] = useState(false);
  const [permissionRequestBusy, setPermissionRequestBusy] = useState(false);
  const [permissionRequestError, setPermissionRequestError] = useState<string | null>(null);
  const [permissionRequestStatus, setPermissionRequestStatus] = useState<string | null>(null);
  const [permissionRevocation, setPermissionRevocation] = useState<string | null>(null);
  // The two grants that are not in PermissionDiagnostics. Both stay null until
  // their probe answers, and null renders as "not checked", never as "denied".
  const [permissionSystemAudio, setPermissionSystemAudio] =
    useState<SystemAudioCapability | null>(null);
  const [calendarAuthorization, setCalendarAuthorization] =
    useState<CalendarAuthorization | null>(null);
  const [autoRequestPermissions, setAutoRequestPermissions] = useState(true);
  const permRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [modelState, setModelState] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelSkipped, setModelSkipped] = useState(false);
  const [modelSelectionHydration, setModelSelectionHydration] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [modelHydrationAttempt, setModelHydrationAttempt] = useState(0);
  // Nothing is selected until persisted settings and the provider list have
  // loaded: model actions stay gated on `modelSelectionHydration` until then.
  const [speechChoices, setSpeechChoices] = useState<SpeechChoice[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [preservedDictationRoute, setPreservedDictationRoute] =
    useState<PreservedDictationRoute | null>(null);
  // The configured dictation model was ONNX Parakeet on a Mac that runs the
  // GGUF build: the step then says the download replaces the same model.
  const [upgradingFromOnnxParakeet, setUpgradingFromOnnxParakeet] = useState(false);
  const [savedModelUnavailable, setSavedModelUnavailable] = useState(false);
  // The meetings model offered beside a dictation-only choice, on the speech
  // step itself, so the reader sees there and then that meetings need one.
  const [meetingChoices, setMeetingChoices] = useState<SpeechChoice[]>([]);
  const [availableRouteIds, setAvailableRouteIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [configuredMeeting, setConfiguredMeeting] = useState<ConfiguredMeeting | null>(null);
  // The reader's pick in that picker; null follows `defaultMeetingChoice`.
  const [pairedMeetingPick, setPairedMeetingPick] = useState<string | null>(null);
  const [pairedMeetingState, setPairedMeetingState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [pairedMeetingError, setPairedMeetingError] = useState<string | null>(null);
  // The meetings model the speech step last saved, so Continue after a
  // retry or a step back does not save or download it twice.
  const [pairedMeetingSaved, setPairedMeetingSaved] = useState<string | null>(null);
  const routeSummaryFor = useCallback(
    (routeId: string | null): DictationRouteSummary | null => {
      if (routeId === null) return null;
      const choice = speechChoices.find((candidate) => candidate.route.routeId === routeId);
      if (choice) return summarizeChoice(choice);
      return preservedDictationRoute?.routeId === routeId
        ? { ...preservedDictationRoute, sizeMib: null }
        : null;
    },
    [preservedDictationRoute, speechChoices],
  );
  const selectedRoute = routeSummaryFor(selectedRouteId);

  // --- Meetings, decided on the speech step ---------------------------------
  // A model that covers both needs nothing more. A dictation-only model gets
  // a meetings picker right under the list, defaulting to a meetings model
  // already on this Mac or else the recommended one, with "Set up meetings
  // later" beside them. Nothing downloads until the primary button is pressed.
  const defaultPairedMeeting = useMemo(
    () =>
      defaultMeetingChoice(
        meetingChoices,
        (route) => availableRouteIds.has(route.routeId),
        configuredMeeting?.routeId ?? null,
      ),
    [availableRouteIds, configuredMeeting, meetingChoices],
  );
  const offerPairedMeeting =
    mode === "full" &&
    selectedRoute !== null &&
    !selectedRoute.meetingCapable &&
    meetingChoices.length > 0;
  const pairedMeetingValue =
    pairedMeetingPick ?? defaultPairedMeeting?.route.routeId ?? MEETINGS_LATER;
  const pairedMeetingChoice =
    meetingChoices.find((choice) => choice.route.routeId === pairedMeetingValue) ?? null;
  const pairedMeetingPending =
    offerPairedMeeting &&
    pairedMeetingChoice !== null &&
    pairedMeetingSaved !== pairedMeetingChoice.route.routeId;
  const pairedMeetingDownloadMib =
    pairedMeetingPending && pairedMeetingChoice && !availableRouteIds.has(pairedMeetingChoice.route.routeId)
      ? pairedMeetingChoice.sizeMib
      : undefined;

  /**
   * Whether meetings move to the dictation model being downloaded: yes when
   * it can transcribe meetings, unless meetings already use a different
   * model that works on this Mac (that choice is kept).
   */
  const meetingsFollowDictation = useCallback(
    (route: DictationRouteSummary | null) =>
      route !== null &&
      route.meetingCapable &&
      !(
        configuredMeeting !== null &&
        availableRouteIds.has(configuredMeeting.routeId) &&
        configuredMeeting.routeId !== route.routeId &&
        configuredMeeting.canonicalRouteId !== route.routeId
      ),
    [availableRouteIds, configuredMeeting],
  );
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const downloadingProviderTypeRef = useRef<AsrProviderType | null>(null);
  const [meetingModelState, setMeetingModelState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [meetingModelError, setMeetingModelError] = useState<string | null>(null);
  const [meetingDownloadPercent, setMeetingDownloadPercent] = useState<number | null>(null);
  const meetingDownloadingProviderTypeRef = useRef<AsrProviderType | null>(null);
  const modelInteractionStartedRef = useRef(false);
  const modelSelectionChangedRef = useRef(false);
  // Captures whatever dictation route was already persisted at mount, so
  // ensureDefaultModelDownloading can tell "nothing configured yet" apart
  // from "user already has a different, working route" -- see its comment.
  const initialDictationProviderRef = useRef<string | null>(null);
  const initialDictationModelIdRef = useRef<string | null>(null);

  const [shortcutValue, setShortcutValue] = useState(defaultDictationShortcut());
  // Opens on whatever is already configured (see settings-view-simple.tsx's
  // resolveDictationHotkeyBehavior), so re-running setup never quietly
  // switches someone's hold-to-talk back to toggle.
  const [hotkeyMode, setHotkeyMode] = useState<HotkeyMode>("toggle");
  // Hands-free is only offered to someone who already turned it on.
  const [handsFreeConfigured, setHandsFreeConfigured] = useState(false);
  // Absent means on, as in Settings.
  const [tapToLock, setTapToLock] = useState(true);
  const [muteMediaWhileDictating, setMuteMediaWhileDictating] = useState(false);
  const [doubleTapToLock, setDoubleTapToLock] = useState(false);
  // Hold-to-talk needs the native key helper to see the key go up. null is
  // "not checked", which never hides the option.
  const [holdToTalkAvailable, setHoldToTalkAvailable] = useState<boolean | null>(null);
  // The microphone the reader was heard on, from the microphone step; cleared
  // when that step starts over on another microphone.
  const [micHeard, setMicHeard] = useState<{ deviceName: string | null } | null>(null);
  const [scratchState, setScratchState] =
    useState<ScratchDictationState>("idle");
  const scratchSessionRef = useRef<{
    sessionId: number | null;
    terminal: "complete" | "error" | null;
    stopPending: boolean;
  } | null>(null);
  const [scratchText, setScratchText] = useState("");
  // The model a practice dictation was refused memory for, while the reader
  // is back on the model step choosing what to do about it. Continue then
  // needs a different model or an explicit retry of this one.
  const [memoryRefusedRouteId, setMemoryRefusedRouteId] = useState<string | null>(null);
  const [scratchMemoryRefused, setScratchMemoryRefused] = useState(false);
  const [scratchError, setScratchError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorContext, setSaveErrorContext] = useState<
    "hotkey" | "meeting-route" | "meeting-settings" | "ai-notes" | null
  >(null);

  // Meeting notes: which route writes them, and whether the local one answers.
  const [aiNotesChoice, setAiNotesChoice] = useState<AiNotesChoice>("ollama");
  const [notesDownloadStatus, setNotesDownloadStatus] = useState<NativeTextModelStatus | null>(null);
  const [notesStatusFailed, setNotesStatusFailed] = useState(false);
  const [aiNotesProvider, setAiNotesProvider] = useState<string>("ollama");
  const [localAiReady, setLocalAiReady] = useState<boolean | null>(null);
  const [localAiMessage, setLocalAiMessage] = useState<string | null>(null);
  const [localAiNeedsSetup, setLocalAiNeedsSetup] = useState(false);
  const [localAiChecking, setLocalAiChecking] = useState(false);
  const localAiProbeIdRef = useRef(0);

  const [meetingAudioStorageMode, setMeetingAudioStorageMode] = useState<"always" | "transcript_only">("always");
  const [meetingRetentionPreset, setMeetingRetentionPreset] = useState<"1w" | "1m" | "2m" | "3m" | "custom" | "never">("3m");
  const [meetingRetentionCustomMonths, setMeetingRetentionCustomMonths] = useState(1);
  const [meetingRetentionDeleteMode, setMeetingRetentionDeleteMode] = useState<"audio_only" | "audio_and_transcript">("audio_only");
  const [meetingSetupLoading, setMeetingSetupLoading] = useState(false);
  // The reader chose "Skip meetings": Ready says so plainly instead of
  // reporting a missing meeting model as a fault.
  const [meetingsSkipped, setMeetingsSkipped] = useState(false);
  const [meetingSetupCheckFailed, setMeetingSetupCheckFailed] = useState(false);
  const [meetingRouteSummary, setMeetingRouteSummary] = useState("Checking the meeting model…");
  const [meetingRouteReady, setMeetingRouteReady] = useState<boolean | null>(null);
  const [meetingRouteError, setMeetingRouteError] = useState<string | null>(null);
  const [meetingSystemAudioCapability, setMeetingSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const [systemAudioTestLoading, setSystemAudioTestLoading] = useState(false);
  const [systemAudioTestResult, setSystemAudioTestResult] =
    useState<SystemAudioTestOutcome | null>(null);
  const [meetingVerificationDetails, setMeetingVerificationDetails] = useState<string[]>([]);
  const [meetingRecommendedRoute, setMeetingRecommendedRoute] =
    useState<MeetingRecommendedRoute | null>(null);
  // A meetings model the reader picked on the meeting step; null keeps what
  // settings name (or, when that does not work, the recommended model).
  const [meetingStepPick, setMeetingStepPick] = useState<string | null>(null);
  // The speaker model, offered in the same explicit download as the meeting
  // speech model: one click covers both, and skipping meetings downloads
  // neither. Meetings themselves never download it.
  const [speakerModelPlan, setSpeakerModelPlan] = useState<DiarizationModelPlan | null>(null);
  const [speakerSeparationOn, setSpeakerSeparationOn] = useState(true);
  const [speakerModelState, setSpeakerModelState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [speakerModelError, setSpeakerModelError] = useState<string | null>(null);

  const steps = useMemo(() => {
    if (mode === "meetings") {
      return ["meeting-setup", "ai-notes"] as Step[];
    }
    if (mode === "dictation") {
      return ["permissions", "dictation-model", "hotkey"] as Step[];
    }
    // The notes step sits after meeting setup because it is only about what
    // happens once a meeting is captured, and before "ready" so the summary
    // there can tell the truth about whether notes will be written.
    // The microphone check comes before the first practice dictation, so a
    // wrong or silent mic is caught while it is the only thing on screen.
    return [
      "dictation-model",
      "microphone",
      "try-dictation",
      "use-everywhere",
      "meeting-setup",
      "ai-notes",
      "ready",
    ] as Step[];
  }, [mode]);

  const stepIndex = steps.indexOf(step);
  const isLastStep = stepIndex === steps.length - 1;
  const stepAnnouncement = `Step ${stepIndex + 1} of ${steps.length}: ${STEP_LABELS[step]}`;

  // A new step starts at the top of the scrolling body, and focus moves to
  // its heading without scrolling anything: letting focus() scroll pushed the
  // heading to the top edge and cut off the label above it.
  useLayoutEffect(() => {
    if (stepBodyRef.current) {
      stepBodyRef.current.scrollTop = 0;
    }
    // Initial focus belongs to the modal's mounted focus scope.
    if (dialogRef.current?.contains(document.activeElement)) {
      stepHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [step]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      getSettings(),
      getAsrProviders().catch(() => null),
      // Which models are on this Mac, per model: the provider list only
      // knows about the one model each provider points at. Unknown (a failed
      // read) counts nothing as present, so the picker may name a download
      // that turns out to be unnecessary, never the reverse.
      listDownloadedModels().catch(() => null),
    ])
      .then(([settings, providers, downloadedFiles]) => {
        if (!mounted) {
          return;
        }
        setAutoRequestPermissions(settings.transcription.dictationAutoRequestPermissions ?? true);
        setShortcutValue(settings.shortcuts.toggleDictation || defaultDictationShortcut());
        setMeetingAudioStorageMode(
          settings.transcription.meetingAudioStorageMode === "transcript_only"
            ? "transcript_only"
            : "always"
        );
        setMeetingRetentionPreset(
          settings.transcription.meetingRetentionPreset === "1w" ||
            settings.transcription.meetingRetentionPreset === "1m" ||
            settings.transcription.meetingRetentionPreset === "2m" ||
            settings.transcription.meetingRetentionPreset === "3m" ||
            settings.transcription.meetingRetentionPreset === "custom" ||
            settings.transcription.meetingRetentionPreset === "never"
            ? settings.transcription.meetingRetentionPreset
            : "3m"
        );
        setMeetingRetentionCustomMonths(
          Math.max(1, settings.transcription.meetingRetentionCustomMonths ?? 1)
        );
        setMeetingRetentionDeleteMode(
          settings.transcription.meetingRetentionDeleteMode === "audio_and_transcript"
            ? "audio_and_transcript"
            : "audio_only"
        );
        // The notes step opens on whatever is already true: a remembered
        // transcripts-only choice, an already-chosen cloud lane, or the local
        // default. It never silently re-decides for the reader.
        const configuredNotesProvider =
          settings.privacy?.meetingsAi?.provider?.trim() || "ollama";
        setAiNotesProvider(configuredNotesProvider);
        setAiNotesChoice(
          readAiNotesOptOut()
            ? "none"
            : configuredNotesProvider === "native_text"
              ? "native_text"
              : isRemoteAnalysisProvider(configuredNotesProvider)
                ? "byok"
                : "ollama",
        );
        const sharedSelection = settings.transcription.useSharedAsrSelection ?? true;
        const configuredProvider = (
          sharedSelection
            ? settings.transcription.defaultProvider
            : settings.transcription.dictationProvider ?? settings.transcription.defaultProvider
        ) as AsrProviderType | undefined;
        const configuredModelId =
          (sharedSelection
            ? settings.transcription.selectedModelId
            : settings.transcription.dictationModelId ?? settings.transcription.selectedModelId) ??
          null;
        initialDictationProviderRef.current = configuredProvider ?? null;
        initialDictationModelIdRef.current = configuredModelId;
        // A route saved without a model id runs the provider's own model.
        const configuredRouteModelId =
          configuredModelId ??
          providers?.find((provider) => provider.providerType === configuredProvider)
            ?.selectedModelId ??
          null;

        const routes = providers ? buildAsrRouteCatalog(providers, "prefer_local") : [];
        // A model that needs a permission first (Apple Speech before macOS
        // allows it) is set up in Settings, not offered here.
        const choices = speechChoicesForLane(routes, "dictation").filter(
          (choice) => choice.route.selectable,
        );
        setSpeechChoices(choices);
        const meetingPicker = readMeetingPicker(settings, providers ?? [], downloadedFiles);
        setAvailableRouteIds(meetingPicker.availableRouteIds);
        setConfiguredMeeting(meetingPicker.configured);
        setMeetingChoices(meetingPicker.choices);
        const recommendedChoice =
          choices.find((choice) => choice.recommended) ?? choices[0] ?? null;
        const configuredRoute =
          routes.find(
            (route) =>
              route.providerType === configuredProvider &&
              route.modelId === configuredRouteModelId,
          ) ?? null;
        // ONNX Parakeet where the GGUF build can run reads as Parakeet v3,
        // the recommended choice; it is never listed on its own.
        const shownRoute = canonicalSpeechRoute(routes, configuredRoute);
        const configuredChoice = shownRoute
          ? choices.find((choice) => choice.route.routeId === shownRoute.routeId)
          : undefined;
        const readyLocalRoute =
          configuredRoute &&
          configuredRoute.hosting !== "cloud" &&
          configuredRoute.laneCompatibility.dictation &&
          configuredRoute.readiness === "ready" &&
          isRouteReady(providers ?? [], configuredRoute)
            ? configuredRoute
            : null;
        let initialRouteId: string | null = null;
        if (!modelSelectionChangedRef.current) {
          setUpgradingFromOnnxParakeet(
            configuredRoute?.superseded === true && isRouteReady(providers ?? [], configuredRoute),
          );
          // ONNX Parakeet is what every older settings file names by default
          // (serde fills it in), so it is not a choice anyone made: the step
          // opens on the recommended model, which on a Mac that runs the GGUF
          // build is the same Parakeet v3 in its faster version.
          if (
            configuredChoice &&
            !isOnnxParakeetRoute(configuredProvider, configuredRouteModelId)
          ) {
            // A model someone chose, and one this step lists: keep it.
            setPreservedDictationRoute(null);
            initialRouteId = configuredChoice.route.routeId;
          } else if (readyLocalRoute && !configuredChoice) {
            // A working model this step doesn't list (an experimental one):
            // shown as the current model, never silently replaced.
            setPreservedDictationRoute({
              routeId: readyLocalRoute.routeId,
              providerType: readyLocalRoute.providerType,
              modelId: readyLocalRoute.modelId,
              label: readyLocalRoute.label,
              meetingCapable: readyLocalRoute.laneCompatibility.meeting,
            });
            initialRouteId = readyLocalRoute.routeId;
          } else {
            // Nothing configured, or an old default nobody picked (ONNX
            // Parakeet, Whisper Base English): the recommended model.
            setPreservedDictationRoute(null);
            initialRouteId = recommendedChoice?.route.routeId ?? null;
          }
          setSelectedRouteId(initialRouteId);
        }
        const configuredUnavailable = providers?.some((provider) =>
          provider.providerType === configuredProvider && provider.inferenceEnabled === false
        ) ?? false;
        setSavedModelUnavailable(configuredUnavailable);
        if (configuredUnavailable && !modelSelectionChangedRef.current) {
          setModelState("idle");
        }
        const initialRoute = routes.find((route) => route.routeId === initialRouteId);
        if (
          !modelInteractionStartedRef.current &&
          !modelSelectionChangedRef.current &&
          !configuredUnavailable &&
          initialRoute &&
          isRouteReady(providers ?? [], initialRoute)
        ) {
          setModelState("done");
        }
        setHotkeyMode(
          settings.transcription.dictationHandsFreeEnabled
            ? "hands_free"
            : settings.transcription.dictationPushToTalk
              ? "hold_to_talk"
              : "toggle"
        );
        setHandsFreeConfigured(Boolean(settings.transcription.dictationHandsFreeEnabled));
        setTapToLock(settings.transcription.dictationTapToLock !== false);
        setDoubleTapToLock(settings.transcription.dictationDoubleTapToLock === true);
        setMuteMediaWhileDictating(settings.ui.muteMediaWhileDictating === true);
        setModelSelectionHydration(providers ? "ready" : "error");
      })
      .catch(() => {
        if (mounted) {
          // The displayed default is not trustworthy until persisted settings
          // have loaded. Keep model actions fail-closed instead of treating a
          // rejected settings read as hydration.
          setModelSelectionHydration("error");
        }
      });

    return () => {
      mounted = false;
    };
  }, [modelHydrationAttempt]);

  useEffect(() => {
    let mounted = true;
    getDictationShortcutCapabilityStatus()
      .then((status) => {
        if (mounted && typeof status?.nativeShortcutAvailable === "boolean") {
          setHoldToTalkAvailable(status.nativeShortcutAvailable);
        }
      })
      .catch(() => {
        // Unknown stays unknown; the option stays on offer.
      });
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Re-read every grant the permissions step shows.
   *
   * All three probes are preflight reads: none of them can raise a macOS
   * prompt, so this is safe to run on a timer or a focus change. A probe that
   * throws leaves its row unknown rather than turning it into a denial.
   */
  const refreshPerms = useCallback(async () => {
    setPermsLoading(true);
    try {
      const [result, systemAudio, calendar] = await Promise.all([
        getPermissionDiagnostics(),
        getSystemAudioCapability().catch(() => null),
        getCalendarSnapshot()
          .then((snapshot) => snapshot.authorization)
          .catch(() => null),
      ]);
      setPerms(result);
      setPermissionSystemAudio(systemAudio);
      setCalendarAuthorization(calendar);
      return result;
    } catch {
      return null;
    } finally {
      setPermsLoading(false);
    }
  }, []);

  const permissionStepVisible =
    step === "permissions" ||
    step === "try-dictation" ||
    step === "use-everywhere" ||
    step === "meeting-setup" ||
    step === "ready";

  useEffect(() => {
    if (permissionStepVisible) {
      void refreshPerms();
    }
  }, [permissionStepVisible, refreshPerms]);

  // Granting happens in System Settings, in another window. Without this the
  // row the reader just switched on stays rust until they find the Re-check
  // button -- which is exactly the moment someone concludes the app is broken.
  useEffect(() => {
    if (!permissionStepVisible) {
      return;
    }
    const handleFocus = () => {
      void refreshPerms();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [permissionStepVisible, refreshPerms]);

  const permissionObservations: PermissionGateObservations = {
    permissions: perms,
    systemAudio: permissionSystemAudio,
    calendarAuthorization,
  };

  const focusPermissionCard = useCallback((gateKey: string) => {
    const card = permRowRefs.current[gateKey];
    if (!card) {
      return;
    }
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.focus();
  }, []);

  // Re-verify grants before advancing past the permission step. If a grant the
  // user previously saw as green has since been revoked, surface the reason and
  // jump focus to the affected card instead of silently moving on.
  const reverifyPermissionsBeforeAdvance = useCallback(async () => {
    const previous = perms;
    const fresh = await refreshPerms();
    if (!previous || !fresh) {
      setPermissionRevocation(null);
      return true;
    }
    // Only the two diagnostics-backed required rows can regress between one
    // render and the next here; the optional grants never block Continue.
    const revoked = PERMISSION_GATES.find(
      (gate) =>
        !gate.optional &&
        gate.ready({ ...permissionObservations, permissions: previous }) === true &&
        gate.ready({ ...permissionObservations, permissions: fresh }) !== true,
    );
    if (!revoked) {
      setPermissionRevocation(null);
      return true;
    }
    const message = `${revoked.label} was turned off again. ${revoked.consequence} Re-grant it to continue.`;
    setPermissionRevocation(message);
    setPermissionRequestStatus(null);
    requestAnimationFrame(() => focusPermissionCard(revoked.key));
    return false;
  }, [focusPermissionCard, permissionObservations, perms, refreshPerms]);

  const refreshMeetingSetup = useCallback(async () => {
    setMeetingSetupLoading(true);
    try {
      const [settings, providers, systemAudioCapability, verification, speakerPlan, downloadedFiles] = await Promise.all([
        getSettings(),
        getAsrProviders(),
        getSystemAudioCapability().catch(() => null),
        verifyMeetingSetup().catch(() => null as SetupVerificationResult | null),
        loadSpeakerModelPlan(),
        listDownloadedModels().catch(() => null),
      ]);
      setSpeakerModelPlan(speakerPlan);
      const meetingPicker = readMeetingPicker(settings, providers, downloadedFiles);
      setAvailableRouteIds(meetingPicker.availableRouteIds);
      setConfiguredMeeting(meetingPicker.configured);
      setMeetingChoices(meetingPicker.choices);
      setSpeakerSeparationOn(settings.transcription.enableDiarization !== false);

      const currentProvider = (settings.transcription.meetingProvider as AsrProviderType | undefined) ?? null;
      const currentModelId = settings.transcription.meetingModelId ?? null;
      const meetingRoutes = await getMeetingRouteCatalog(providers, currentProvider, currentModelId);
      const routeReady = isMeetingRouteReady(
        currentProvider,
        currentModelId,
        meetingRoutes
      );

      setMeetingRouteSummary(summarizeMeetingRoute(currentProvider, currentModelId, providers));
      setMeetingSetupCheckFailed(false);
      setMeetingRouteReady(routeReady);
      setMeetingVerificationDetails(verification?.details ?? []);
      setMeetingRouteError(
        routeReady
          ? null
          : verification?.summary ??
              "Meetings need a speech model. Download it below, or choose one later in Settings > Models."
      );
      setMeetingSystemAudioCapability(systemAudioCapability);
      const sharedSelection = settings.transcription.useSharedAsrSelection ?? true;
      setMeetingRecommendedRoute(
        getRecommendedMeetingRoute(meetingRoutes, {
          providerType: sharedSelection
            ? settings.transcription.defaultProvider ?? null
            : settings.transcription.dictationProvider ?? null,
          modelId: sharedSelection
            ? settings.transcription.selectedModelId ?? null
            : settings.transcription.dictationModelId ?? null,
        }),
      );
      return {
        routeReady,
        systemAudioAvailable: systemAudioCapability?.backend !== "none",
      };
    } catch (error) {
      const message = userFacingErrorMessage(error, "Could not verify the meeting setup right now.");
      setMeetingRouteSummary("The meeting setup check failed");
      setMeetingSetupCheckFailed(true);
      setMeetingRouteReady(false);
      setMeetingRouteError(message || "Could not verify the meeting setup right now.");
      setMeetingVerificationDetails([]);
      setMeetingSystemAudioCapability(null);
      setMeetingRecommendedRoute(null);
      return { routeReady: false, systemAudioAvailable: false };
    } finally {
      setMeetingSetupLoading(false);
    }
  }, []);

  const testMeetingSystemAudio = useCallback(async () => {
    setSystemAudioTestLoading(true);
    setSystemAudioTestResult(null);
    try {
      const result = await testSystemAudioCapture();
      if (!mountedRef.current) {
        return;
      }
      setMeetingSystemAudioCapability(result.capability);
      const device = result.capability.routeDevice;
      if (result.capability.ready) {
        setSystemAudioTestResult({
          outcome: "passed",
          message:
            result.verificationMethod === "external_audio"
              ? `Heard sound through ${device ?? "that device"}.`
              : result.capability.backend === "core_audio_process_tap"
                ? "Working. Records all audio playing on this Mac, including other apps and notification sounds, with or without headphones."
                : `Heard the test tone${device ? ` through ${device}` : ""}.`,
          detail:
            result.verificationMethod === "external_audio"
              ? "Verified non-silent external audio."
              : `Verified a ${Math.round(result.expectedToneHz)} Hz tone.`,
        });
        await refreshMeetingSetup();
      } else {
        setSystemAudioTestResult({
          outcome: "failed",
          message:
            result.capability.backend === "virtual_loopback"
              ? "Plainsong did not hear anything through that device. Play some audio through it, then check again."
              : describeMeetingAudio(result.capability).sentence,
          detail: result.capability.actionableReason ?? result.capability.reason ?? null,
        });
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setSystemAudioTestResult({
        outcome: "failed",
        message: "The test could not run. Try again in a moment.",
        detail: userFacingErrorMessage(error, "Couldn't check meeting audio. Try again."),
      });
    } finally {
      if (mountedRef.current) {
        setSystemAudioTestLoading(false);
      }
    }
  }, [refreshMeetingSetup]);

  useEffect(() => {
    if (step === "meeting-setup") {
      void refreshMeetingSetup();
      // The meeting summary shows the microphone too; in meetings-only setup
      // nothing earlier has read it.
      void refreshPerms();
    }
  }, [refreshMeetingSetup, refreshPerms, step]);

  // The built-in notes model's size and whether this Mac can run it: the
  // meetings step counts it in the total, and the notes step offers it.
  useEffect(() => {
    if (step !== "meeting-setup" && step !== "ai-notes") return;
    let active = true;
    void getNativeTextModelStatus().then((status) => {
      if (active) { setNotesDownloadStatus(status); setNotesStatusFailed(false); }
    }).catch(() => {
      if (active) setNotesStatusFailed(true);
    });
    return () => { active = false; };
  }, [step]);

  const requestPermissionsNow = useCallback(async () => {
    setPermissionRequestBusy(true);
    setPermissionRequestError(null);
    setPermissionRequestStatus(null);
    try {
      const diagnostics = await requestDictationPermissions();
      setPerms(diagnostics);
      setPermissionRequestStatus("Asked macOS for permission and checked again.");
    } catch (error) {
      setPermissionRequestError(userFacingErrorMessage(error, "Couldn't check permissions. Try again."));
    } finally {
      setPermissionRequestBusy(false);
    }
  }, []);

  /**
   * Open the exact System Settings pane a row is about.
   *
   * Calendar takes its own route: `open_permission_settings` falls back to the
   * Accessibility pane for a section it does not know, and dropping someone
   * looking for the Calendars switch into the Accessibility list is worse than
   * offering no button at all.
   */
  const openPermissionSettingsFromWizard = useCallback(
    async (gate: PermissionGate) => {
      setPermissionRequestError(null);
      setPermissionRequestStatus(null);
      try {
        if (gate.destination.kind === "calendar_pane") {
          await openCalendarPrivacySettings();
        } else {
          await openPermissionSettings(gate.destination.section);
        }
        setPermissionRequestStatus(
          `Opened macOS ${gate.settingsLabel} settings. Plainsong re-checks when you come back.`,
        );
      } catch (error) {
        setPermissionRequestError(userFacingErrorMessage(error, "Couldn't open System Settings. Open it from the Apple menu and try again."));
      }
    },
    []
  );

  const openGateSettingsByKey = useCallback(
    async (key: PermissionGateKey) => {
      const gate = PERMISSION_GATES.find((candidate) => candidate.key === key);
      if (gate) {
        await openPermissionSettingsFromWizard(gate);
      }
    },
    [openPermissionSettingsFromWizard],
  );
  const openMicrophoneSettingsFromWizard = useCallback(
    () => openGateSettingsByKey("microphone"),
    [openGateSettingsByKey],
  );
  const openAccessibilitySettingsFromWizard = useCallback(
    () => openGateSettingsByKey("accessibility"),
    [openGateSettingsByKey],
  );

  const openInstalledAppFromWizard = useCallback(async () => {
    setPermissionRequestError(null);
    setPermissionRequestStatus(null);
    try {
      await openInstalledPlainsongApp();
      setPermissionRequestStatus("Opened the installed Plainsong app from /Applications.");
    } catch (error) {
      setPermissionRequestError(userFacingErrorMessage(error, "Couldn't open the installed app. Open Plainsong from Applications."));
    }
  }, []);

  const startScratchDictation = useCallback(async () => {
    if (scratchSessionRef.current && !scratchSessionRef.current.terminal) return;
    const owner: NonNullable<typeof scratchSessionRef.current> = {
      sessionId: null, terminal: null, stopPending: false,
    };
    scratchSessionRef.current = owner;
    setScratchState("starting");
    setScratchText("");
    try {
      await startDictation({
        saveToInbox: false,
        projectId: "inbox",
        profile: "normal_speed",
        contextSource: "none",
        livePreviewEnabled: true,
        deliveryMode: "preview",
      });
      if (mountedRef.current && scratchSessionRef.current === owner
        && !owner.terminal && !owner.stopPending) {
        setScratchState("listening");
      }
    } catch (error) {
      if (!mountedRef.current || scratchSessionRef.current !== owner || owner.terminal) {
        return;
      }
      owner.terminal = "error";
      setScratchState("error");
      setScratchMemoryRefused(isDictationMemoryAdmissionRefusal(error instanceof Error ? error.message : String(error)));
      setScratchError(sanitizeUserFacingDictationMessage(error instanceof Error ? error.message : String(error), { phase: "error", inSetup: true }));
    }
  }, []);

  const finishScratchDictation = useCallback(async () => {
    const owner = scratchSessionRef.current;
    if (!owner || owner.terminal || owner.stopPending) return;
    owner.stopPending = true;
    setScratchState("transcribing");
    try {
      const text = (await stopDictation()).trim();
      if (!mountedRef.current || scratchSessionRef.current !== owner || owner.terminal) {
        return;
      }
      owner.terminal = "complete";
      setScratchText(text);
      setScratchState("complete");
      setScratchError(null);
      setScratchMemoryRefused(false);
    } catch (error) {
      if (!mountedRef.current || scratchSessionRef.current !== owner || owner.terminal) {
        return;
      }
      owner.terminal = "error";
      setScratchState("error");
      setScratchMemoryRefused(isDictationMemoryAdmissionRefusal(error instanceof Error ? error.message : String(error)));
      setScratchError(sanitizeUserFacingDictationMessage(error instanceof Error ? error.message : String(error), { phase: "error", inSetup: true }));
    }
  }, []);

  // The sidecar reports real download progress as ["providerType", percent]
  // (see download_asr_models in rust-sidecar/src/lib.rs); wire it up instead
  // of showing only an indeterminate spinner for the whole download.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<[AsrProviderType, number]>("asr-download-progress", (event) => {
      const [providerType, percent] = event.payload;
      if (providerType === downloadingProviderTypeRef.current) {
        setDownloadPercent(percent);
      }
      if (providerType === meetingDownloadingProviderTypeRef.current) {
        setMeetingDownloadPercent(percent);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const retain = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void listen<DictationStateChangedEvent>("dictation-state-changed", ({ payload }) => {
      if (disposed) return;
      const owner = scratchSessionRef.current;
      if (!owner || typeof payload.sessionId !== "number"
        || !Number.isSafeInteger(payload.sessionId) || payload.sessionId <= 0) return;
      if (owner.sessionId === null && !owner.terminal && payload.phase === "preparing") {
        owner.sessionId = payload.sessionId;
      }
      if (owner.sessionId !== payload.sessionId || owner.terminal) return;
      switch (payload.phase) {
        case "recording":
          setScratchState("listening");
          break;
        case "stopping":
        case "transcribing":
        case "delivering":
          owner.stopPending = true;
          setScratchState("transcribing");
          break;
        case "done":
          owner.terminal = "complete";
          if (payload.preview !== undefined && payload.preview !== null) {
            setScratchText(payload.preview.trim());
          }
          setScratchState("complete");
          setScratchError(null);
          setScratchMemoryRefused(false);
          break;
        case "error":
        case "idle":
          owner.terminal = "error";
          setScratchMemoryRefused(isDictationMemoryAdmissionRefusal(payload.message));
          setScratchError(sanitizeUserFacingDictationMessage(payload.message, { phase: "error", inSetup: true }) ?? (payload.phase === "idle"
            ? "The dictation test was cancelled. You can try again or continue setup."
            : "The dictation test failed. You can try again or continue setup."));
          setScratchState("error");
          break;
      }
    }).then(retain);
    type PracticeTextEvent = NonNullable<ReturnType<typeof useDictationRuntime>["textReadyEvent"]>;
    void listen<PracticeTextEvent>("dictation-text-ready", ({ payload }) => {
      if (disposed) return;
      const owner = scratchSessionRef.current;
      if (!owner || owner.sessionId === null || owner.sessionId !== payload.sessionId
        || owner.terminal === "error") return;
      owner.terminal = "complete";
      setScratchText(payload.text.trim());
      setScratchState("complete");
      setScratchError(null);
      setScratchMemoryRefused(false);
    }).then(retain);
    return () => {
      disposed = true;
      scratchSessionRef.current = null;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const startModelDownload = useCallback(async (routeId: string | null) => {
    if (modelSelectionHydration !== "ready") {
      return false;
    }
    const route = routeSummaryFor(routeId);
    if (!route) {
      return false;
    }
    const { providerType, modelId: id } = route;
    modelInteractionStartedRef.current = true;
    setModelSkipped(false);
    setModelState("downloading");
    setModelError(null);
    setDownloadPercent(0);
    downloadingProviderTypeRef.current = providerType;
    try {
      // Decided before the download, from what the step showed: "One
      // download covers dictation and meetings" is what the reader agreed to.
      const meetingsFollow = meetingsFollowDictation(route);
      await downloadAsrModels(providerType, id);
      // Persist only this completed download's route, even if the wizard closed.
      await updateSettings((settings) => {
        settings.transcription.useSharedAsrSelection = false;
        // The shared default is the sidecar's second dictation fallback and
        // the nearest substitute for GGUF Parakeet in meetings, so it stays
        // where it was (ONNX Parakeet on a new install) rather than naming
        // GGUF everywhere.
        if (providerType !== RECOMMENDED_SPEECH_ROUTE.providerType) {
          settings.transcription.defaultProvider = providerType;
          settings.transcription.selectedModelId = id;
        }
        settings.transcription.dictationProvider = providerType;
        settings.transcription.dictationModelId = id;
        // A model that covers meetings takes them too, unless meetings
        // already use another model that works here (`meetingsFollow`). A
        // dictation-only model leaves the meeting slot to the meetings
        // picker beside it.
        if (meetingsFollow) {
          settings.transcription.meetingProvider = providerType;
          settings.transcription.meetingModelId = id;
        }
        // GGUF Parakeet is now on this Mac and verified, so a meeting slot
        // still on the ONNX build of the same model moves with dictation.
        if (isRecommendedSpeechRoute(providerType, id)) {
          settings.transcription = withParakeetUpgrade(settings).transcription;
        }
      });
      if (!mountedRef.current) {
        return false;
      }
      setModelState("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) {
        return false;
      }
      setModelState("error");
      setModelError(describeModelDownloadError(error));
      return false;
    } finally {
      downloadingProviderTypeRef.current = null;
    }
  }, [meetingsFollowDictation, modelSelectionHydration, routeSummaryFor]);

  /**
   * Save the meetings model picked beside a dictation-only model, fetching it
   * first when it is not on this Mac. Runs only from the step's primary
   * button, after the dictation model, so each click downloads what the
   * button named and nothing else.
   */
  const savePairedMeetingModel = useCallback(async (choice: SpeechChoice) => {
    const { providerType, modelId, routeId } = choice.route;
    const needsDownload = !availableRouteIds.has(routeId);
    setPairedMeetingState("downloading");
    setPairedMeetingError(null);
    if (needsDownload) {
      setMeetingDownloadPercent(0);
      meetingDownloadingProviderTypeRef.current = providerType;
    }
    try {
      if (needsDownload) {
        await downloadAsrModels(providerType, modelId);
      }
      await updateSettings((settings) => setMeetingSlot(settings, providerType, modelId));
      if (!mountedRef.current) {
        return false;
      }
      setAvailableRouteIds((previous) => new Set(previous).add(routeId));
      setPairedMeetingSaved(routeId);
      setPairedMeetingState("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) {
        return false;
      }
      setPairedMeetingState("error");
      setPairedMeetingError(describeModelDownloadError(error));
      return false;
    } finally {
      meetingDownloadingProviderTypeRef.current = null;
    }
  }, [availableRouteIds]);

  // Advancing past the visible model surface starts the selected fast default
  // in the background so the user can continue setting up the shortcut. The
  // explicit Skip action never calls this function because skipping is not
  // consent for a model download.
  //
  // But only do this when the user doesn't already have a different,
  // previously-configured dictation route (e.g. distil_whisper,
  // macos_apple_speech, a cloud provider). Someone who opens "Fix dictation
  // setup" for an unrelated reason (a hotkey conflict, say) and just clicks
  // through this step must not have their working provider silently
  // downgraded/overwritten. Parakeet is the current default, while only
  // whisper/base.en is the legacy default; other Whisper models may be a
  // deliberate user choice and must be preserved.
  const ensureDefaultModelDownloading = useCallback(() => {
    const existingProvider = initialDictationProviderRef.current;
    const existingModelId = initialDictationModelIdRef.current?.trim() ?? "";
    const hasCustomWhisperModel =
      existingProvider === "whisper" &&
      existingModelId.length > 0 &&
      existingModelId !== "base.en";
    // GGUF Parakeet is the Apple Silicon default, so it counts as one here.
    const isGgufDefault =
      existingProvider !== null &&
      isRecommendedSpeechRoute(existingProvider as AsrProviderType, existingModelId);
    const hasExistingNonDefaultRoute =
      Boolean(existingProvider) &&
      existingProvider !== "parakeet" &&
      !isGgufDefault &&
      (existingProvider !== "whisper" || hasCustomWhisperModel);
    if (hasExistingNonDefaultRoute && !modelSelectionChangedRef.current) {
      return;
    }
    if (modelState === "idle" || modelState === "error") {
      // Already corrected to match the actual configured/default provider
      // by the settings-load effect above -- GGUF Parakeet for a fresh Apple
      // Silicon install, ONNX Parakeet for any other fresh install, base.en
      // for a pre-upgrade whisper install -- so this
      // downloads whichever default route the user is really on instead of
      // assuming parakeet unconditionally.
      void startModelDownload(selectedRouteId);
    }
  }, [modelState, selectedRouteId, startModelDownload]);

  const persistDictationStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      await updateSettings((settings) => {
        const toggleDictation = normalizeShortcut(shortcutValue);
        const conflictMessage = dictationShortcutConflictMessage(
          settings.shortcuts,
          toggleDictation
        );
        if (conflictMessage) {
          throw new Error(conflictMessage);
        }
        settings.shortcuts.toggleDictation = toggleDictation;
        settings.transcription.dictationAutoRequestPermissions = autoRequestPermissions;
        // The same two fields Settings writes for this choice.
        settings.transcription.dictationPushToTalk = hotkeyMode === "hold_to_talk";
        settings.transcription.dictationHandsFreeEnabled = hotkeyMode === "hands_free";
        if (hotkeyMode === "hold_to_talk") {
          settings.transcription.dictationTapToLock = tapToLock;
          settings.transcription.dictationDoubleTapToLock = doubleTapToLock;
        }
        settings.ui.muteMediaWhileDictating = muteMediaWhileDictating;
      });
      return true;
    } catch (error) {
      setSaveError(userFacingErrorMessage(error, "Couldn't save these settings. Try again."));
      setSaveErrorContext("hotkey");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [autoRequestPermissions, hotkeyMode, shortcutValue, tapToLock, doubleTapToLock, muteMediaWhileDictating]);

  // --- The meetings model on the meeting step --------------------------------
  // The step names the model meetings use and lets the reader change it. What
  // it shows by default: the model settings name when it works, else the
  // recommended one (which Continue then downloads). A different pick becomes
  // the target Continue saves and, when it is not on this Mac, downloads.
  const meetingDefaultTargetId = meetingRouteReady
    ? configuredMeeting?.routeId ?? null
    : meetingRecommendedRoute
      ? routeIdFor(meetingRecommendedRoute.providerType, meetingRecommendedRoute.modelId)
      : null;
  const meetingPickChoice =
    meetingStepPick !== null && meetingStepPick !== meetingDefaultTargetId
      ? meetingChoices.find((choice) => choice.route.routeId === meetingStepPick) ?? null
      : null;
  const meetingTarget: MeetingRecommendedRoute | null = meetingPickChoice
    ? {
        providerType: meetingPickChoice.route.providerType,
        modelId: meetingPickChoice.route.modelId,
        label: meetingPickChoice.route.label,
        recommended: meetingPickChoice.recommended,
        needsDownload: !availableRouteIds.has(meetingPickChoice.route.routeId),
        sizeMib: meetingPickChoice.sizeMib,
        sameAsDictation: selectedRoute?.routeId === meetingPickChoice.route.routeId,
      }
    : meetingRecommendedRoute;
  // A pick that differs from a working model is a change still to save.
  const meetingTargetReady = meetingPickChoice ? false : meetingRouteReady;
  const meetingPickerValue = meetingStepPick ?? meetingDefaultTargetId;

  const applyRecommendedMeetingRoute = useCallback(async () => {
    const target = meetingTarget;
    if (!target) {
      return false;
    }
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      await updateSettings((settings) => {
        setMeetingSlot(settings, target.providerType, target.modelId);
        if (!settings.transcription.dictationProvider) {
          settings.transcription.dictationProvider = settings.transcription.defaultProvider;
        }
        if (!settings.transcription.dictationModelId) {
          settings.transcription.dictationModelId = settings.transcription.selectedModelId;
        }
      });
      await refreshMeetingSetup();
      return true;
    } catch (error) {
      setSaveError(userFacingErrorMessage(error, "Couldn't save these settings. Try again."));
      setSaveErrorContext("meeting-route");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [meetingTarget, refreshMeetingSetup]);

  const speakerModelNeeded =
    speakerSeparationOn && speakerModelPlan !== null && !speakerModelPlan.selectedInstalled;

  const startSpeakerModelDownload = useCallback(async () => {
    const plan = speakerModelPlan;
    if (!plan) return true;
    setSpeakerModelState("downloading");
    setSpeakerModelError(null);
    try {
      await downloadDiarizationModel(plan.selectedModelId);
      const after = await loadSpeakerModelPlan();
      if (!mountedRef.current) return false;
      if (after) setSpeakerModelPlan(after);
      if (after && !after.selectedInstalled) {
        throw new Error("The download finished, but the speaker model did not pass its check.");
      }
      setSpeakerModelState("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      setSpeakerModelState("error");
      setSpeakerModelError(describeModelDownloadError(error));
      return false;
    }
  }, [speakerModelPlan]);

  const startMeetingModelDownload = useCallback(async () => {
    const route = meetingTarget;
    if (!route) {
      setMeetingModelState("error");
      setMeetingModelError(
        "No compatible local meeting model is available for this Mac."
      );
      return false;
    }

    setMeetingModelState("downloading");
    setMeetingModelError(null);
    setMeetingDownloadPercent(0);
    try {
      const routeSaved = await applyRecommendedMeetingRoute();
      if (!mountedRef.current) {
        return false;
      }
      if (!routeSaved) {
        setMeetingModelState("error");
        setMeetingModelError(
          "The meeting model couldn't be saved. Try again after fixing the settings error above."
        );
        return false;
      }

      // A repair can be only a route-selection change when the model is
      // already present. Re-check first so reopening onboarding never starts
      // a redundant multi-gigabyte fetch.
      const beforeDownload = await refreshMeetingSetup();
      if (!mountedRef.current) {
        return false;
      }
      if (beforeDownload.routeReady) {
        setMeetingModelState("done");
        return true;
      }

      meetingDownloadingProviderTypeRef.current = route.providerType;
      await downloadAsrModels(route.providerType, route.modelId);
      if (!mountedRef.current) {
        return false;
      }

      const afterDownload = await refreshMeetingSetup();
      if (!mountedRef.current) {
        return false;
      }
      if (!afterDownload.routeReady) {
        throw new Error(
          "The download finished, but the meeting model still isn't ready. Check again, or choose another model in Settings."
        );
      }

      setMeetingModelState("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) {
        return false;
      }
      setMeetingModelState("error");
      setMeetingModelError(describeModelDownloadError(error));
      return false;
    } finally {
      meetingDownloadingProviderTypeRef.current = null;
    }
  }, [applyRecommendedMeetingRoute, meetingTarget, refreshMeetingSetup]);

  /**
   * Ask whether the local analysis runtime is actually answering. A probe that
   * throws leaves this `null` — unknown — because "Ollama is missing" and "we
   * could not ask" are different claims and only one of them is actionable.
   */
  const checkLocalAiRuntime = useCallback(async () => {
    const probeId = ++localAiProbeIdRef.current;
    setLocalAiChecking(true);
    setLocalAiReady(null);
    setLocalAiMessage(null);
    setLocalAiNeedsSetup(false);
    try {
      const settings = await getSettings();
      if (aiNotesChoice === "native_text") {
        const facts = await probeMeetingNotesRoute(settings);
        const readiness = resolveMeetingNotesRoute({
          ...facts,
          optedOut: false,
          provider: "native_text",
          remoteProcessingEnabled: settings.privacy.remoteProcessingEnabled,
        });
        if (mountedRef.current && probeId === localAiProbeIdRef.current) {
          setLocalAiReady(
            readiness.state === "ready" ? true : readiness.state === "unknown" ? null : false,
          );
          setLocalAiMessage(readiness.reason);
        }
        return;
      }
      const savedMeetingAi = settings.privacy.meetingsAi;
      const selectedModelId =
        savedMeetingAi?.provider === "ollama" ? savedMeetingAi.modelId : null;
      const readiness = await probeOllamaModelReadiness(
        selectedModelId,
        {
          getRuntimeStatus: getOllamaStatus,
          listInstalledModels: listOllamaModels,
          listCatalog: listOllamaModelCatalog,
          remoteProcessingEnabled: settings.privacy.remoteProcessingEnabled,
        },
      );
      const ready =
        readiness.runtimeReady === true && readiness.modelReady === true
          ? readiness.executionReady
          : readiness.runtimeReady === false || readiness.modelReady === false
            ? false
            : null;
      if (mountedRef.current && probeId === localAiProbeIdRef.current) {
        setLocalAiReady(ready);
        setLocalAiMessage(readiness.executionMessage);
        setLocalAiNeedsSetup(readiness.runtimeReady === false || readiness.modelReady === false);
      }
    } catch {
      if (mountedRef.current && probeId === localAiProbeIdRef.current) {
        setLocalAiReady(null);
        setLocalAiMessage(aiNotesChoice === "native_text"
          ? "Plainsong could not confirm the built-in text model."
          : null);
        setLocalAiNeedsSetup(false);
      }
    } finally {
      if (mountedRef.current && probeId === localAiProbeIdRef.current) {
        setLocalAiChecking(false);
      }
    }
  }, [aiNotesChoice]);

  useEffect(() => {
    if (step === "ai-notes" && (aiNotesChoice === "ollama" || aiNotesChoice === "native_text")) {
      void checkLocalAiRuntime();
    }
    return () => {
      localAiProbeIdRef.current += 1;
    };
  }, [aiNotesChoice, checkLocalAiRuntime, step]);

  const persistAiNotesStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      const wasOptedOut = readAiNotesOptOut();
      await updateSettings((settings) => {
        if (aiNotesChoice === "none") {
          // These backend gates control automatic analysis and title generation.
          settings.transcription.enableAutoAnalysis = false;
          settings.transcription.meetingAutoNameEnabled = false;
        } else {
          if (wasOptedOut) {
            settings.transcription.enableAutoAnalysis = true;
            settings.transcription.meetingAutoNameEnabled = true;
          }
          if (aiNotesChoice === "ollama" && settings.privacy.meetingsAi.provider !== "ollama") {
            // A model id from another provider cannot resolve in Ollama.
            settings.privacy.meetingsAi = { provider: "ollama", modelId: null };
          }
          if (aiNotesChoice === "native_text" && settings.privacy.meetingsAi.provider !== "native_text") {
            settings.privacy.meetingsAi = { provider: "native_text", modelId: null };
          }
        }
      });
      // Written last so a failed settings save cannot leave the app believing
      // notes were declined when they were not.
      writeAiNotesOptOut(aiNotesChoice === "none");
      return true;
    } catch (error) {
      setSaveError(userFacingErrorMessage(error, "Couldn't save these settings. Try again."));
      setSaveErrorContext("ai-notes");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [aiNotesChoice]);

  const persistMeetingStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      await updateSettings((settings) => {
        settings.transcription.meetingAudioStorageMode = meetingAudioStorageMode;
        settings.transcription.meetingRetentionPreset = meetingRetentionPreset;
        settings.transcription.meetingRetentionCustomMonths = Math.max(1, meetingRetentionCustomMonths);
        settings.transcription.meetingRetentionDeleteMode = meetingRetentionDeleteMode;
      });
      // Replaces the write-only `nautilus_meeting_onboarding_complete` flag,
      // which lived in a localStorage nothing ever read back and which every
      // development build shared with the packaged app.
      await recordOnboardingState({ event: "meetings_completed" }).catch((error) => {
        // The meeting settings above are what actually matter here; a lost
        // stamp costs a repeat of this step, not a wrong configuration.
        console.warn("[onboarding] could not record the meetings setup stamp:", error);
      });
      return true;
    } catch (error) {
      setSaveError(userFacingErrorMessage(error, "Couldn't save these settings. Try again."));
      setSaveErrorContext("meeting-settings");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [
    meetingAudioStorageMode,
    meetingRetentionCustomMonths,
    meetingRetentionDeleteMode,
    meetingRetentionPreset,
  ]);

  const completeWizard = useCallback(
    (result?: {
      markOnboardingComplete?: boolean;
      meetingsCompleted?: boolean;
      deferred?: boolean;
    }) => {
      const markOnboardingComplete = result?.markOnboardingComplete ?? mode === "full";
      onComplete({
        markOnboardingComplete,
        meetingsCompleted: result?.meetingsCompleted ?? false,
        deferred: result?.deferred ?? false,
      });
    },
    [mode, onComplete]
  );

  const nextStep = async () => {
    if (step === "permissions") {
      const stillGranted = await reverifyPermissionsBeforeAdvance();
      if (!stillGranted) {
        return;
      }
    }

    if (step === "dictation-model") {
      if (mode === "full" && modelState !== "done") {
        const downloaded = await startModelDownload(selectedRouteId);
        if (!downloaded) {
          return;
        }
      } else if (mode !== "full") {
        ensureDefaultModelDownloading();
      }
      if (pairedMeetingPending && pairedMeetingChoice) {
        const saved = await savePairedMeetingModel(pairedMeetingChoice);
        if (!saved) {
          return;
        }
      }
      if (memoryRefusedRouteId !== null) {
        setMemoryRefusedRouteId(null);
        goToStep("try-dictation");
        return;
      }
    }

    if (step === "use-everywhere") {
      const saved = await persistDictationStep();
      if (!saved) {
        return;
      }
    }

    if (step === "ready") {
      completeWizard({
        markOnboardingComplete: true,
        meetingsCompleted: mode === "full" && !meetingsSkipped,
      });
      return;
    }

    if (step === "hotkey") {
      const saved = await persistDictationStep();
      if (!saved) {
        return;
      }
    }

    if (step === "meeting-setup") {
      if (meetingSetupCheckFailed) {
        await refreshMeetingSetup();
        return;
      }
      setMeetingsSkipped(false);
      if (meetingTargetReady === false) {
        const fixed = await startMeetingModelDownload();
        if (!fixed) {
          return;
        }
      }
      // The same click is the consent for the speaker model the button
      // named. A failed speaker download stops here once, so the reader sees
      // why; the next press continues without speaker labels.
      if (speakerModelNeeded && speakerModelState !== "error") {
        const fetched = await startSpeakerModelDownload();
        if (!fetched) {
          return;
        }
      }
      const saved = await persistMeetingStep();
      if (!saved) {
        return;
      }
    }

    if (step === "ai-notes") {
      const saved = await persistAiNotesStep();
      if (!saved) {
        return;
      }
    }

    const nextIndex = steps.indexOf(step) + 1;
    if (nextIndex < steps.length) {
      goToStep(steps[nextIndex]);
      return;
    }

    completeWizard({
      markOnboardingComplete: mode === "full",
      meetingsCompleted: step === "meeting-setup" || mode === "meetings",
    });
  };

  const skipMeetingSetup = () => {
    setMeetingsSkipped(true);
    setSaveError(null);
    setSaveErrorContext(null);
    if (steps.includes("ready")) {
      goToStep("ready");
      return;
    }
    completeWizard({ markOnboardingComplete: true, meetingsCompleted: false });
  };

  const previousStep = stepHistory.length > 0 ? stepHistory[stepHistory.length - 1] : null;
  // Back waits for anything this step is in the middle of: a practice
  // dictation, a save, or a download this step started and shows. A speech
  // model download that began earlier keeps running and is shown again on
  // the model step.
  const backDisabled =
    saveBusy ||
    permissionRequestBusy ||
    systemAudioTestLoading ||
    scratchState === "starting" ||
    scratchState === "listening" ||
    scratchState === "transcribing" ||
    pairedMeetingState === "downloading" ||
    meetingModelState === "downloading" ||
    speakerModelState === "downloading" ||
    (step === "dictation-model" && modelState === "downloading");
  const goBack = () => {
    if (previousStep === null || backDisabled) {
      return;
    }
    setStepHistory((history) => history.slice(0, -1));
    setSaveError(null);
    setSaveErrorContext(null);
    setStep(previousStep);
  };

  const skipModelDownload = () => {
    setModelSkipped(true);
    const nextIndex = steps.indexOf(step) + 1;
    if (nextIndex < steps.length) {
      goToStep(steps[nextIndex]);
    }
  };

  const subtitle = `Step ${stepIndex + 1} of ${steps.length}`;
  const meetingModelDownloadSize = formatDownloadSize(meetingTarget?.sizeMib);
  const speakerModelSize = speakerModelPlan?.selectedDownloadSize ?? null;
  // The speaker model rides along with the meeting model's download unless it
  // already failed once; then Continue means "without speaker labels".
  const speakerModelRidesAlong = speakerModelNeeded && speakerModelState !== "error";
  const meetingSpeechDownloadPending =
    step === "meeting-setup" &&
    meetingTargetReady === false &&
    // A model already on this Mac only needs choosing, which is what
    // Continue does; "Download" would promise a fetch that never runs.
    meetingTarget?.needsDownload !== false;

  const meetingSpeechBytes = meetingSpeechDownloadPending
    ? meetingTarget?.sizeMib == null ? null : meetingTarget.sizeMib * 1024 * 1024
    : meetingTargetReady === null ? null : 0;
  const speakerSizeMatch = speakerModelSize?.match(/^(\d+(?:\.\d+)?) (MB|GB)$/);
  const meetingSpeakerBytes = speakerModelRidesAlong
    ? speakerSizeMatch ? Number(speakerSizeMatch[1]) * (speakerSizeMatch[2] === "GB" ? 1_000_000_000 : 1_000_000) : null
    : 0;
  const meetingDownloadBytes = meetingSpeechBytes === null || meetingSpeakerBytes === null
    ? null : meetingSpeechBytes + meetingSpeakerBytes;
  const notesDownloadBytes = aiNotesChoice !== "native_text" ? 0
    : notesDownloadStatus === null ? null
    : notesDownloadStatus.ready || !notesDownloadStatus.runtimePresent ? 0 : notesDownloadStatus.downloadBytes;
  const totalDownloadBytes = meetingDownloadBytes === null || notesDownloadBytes === null
    ? null : meetingDownloadBytes + notesDownloadBytes;
  const downloadSizeForBytes = (bytes: number) => formatDownloadSize(bytes / (1024 * 1024));
  const meetingSetupDownloadSummary =
    meetingDownloadBytes !== null && notesDownloadBytes === null && notesStatusFailed
      ? `${meetingDownloadBytes > 0
          ? `This step downloads ${downloadSizeForBytes(meetingDownloadBytes)} for speech and speaker labels.`
          : "Speech and speaker models are already on this Mac."} Plainsong couldn't check the meeting notes model's size; the next step shows it. Nothing downloads until you click a Download button.`
      : totalDownloadBytes === null || meetingDownloadBytes === null || notesDownloadBytes === null
      ? "Plainsong is still checking how much meetings need to download."
      : totalDownloadBytes === 0
        ? "Meetings need no downloads: these models are already on this Mac."
        : [
            `Meeting setup downloads ${downloadSizeForBytes(totalDownloadBytes)} in all.`,
            meetingDownloadBytes > 0
              ? `This step downloads ${downloadSizeForBytes(meetingDownloadBytes)} for speech and speaker labels.`
              : "Speech and speaker models are already on this Mac.",
            notesDownloadBytes > 0
              ? `Meeting notes need ${downloadSizeForBytes(notesDownloadBytes)} more, offered in the next step.`
              : null,
            "Nothing downloads until you click a Download button.",
          ].filter(Boolean).join(" ");

  const nextLabel =
    step === "dictation-model" &&
    memoryRefusedRouteId !== null &&
    memoryRefusedRouteId === selectedRouteId &&
    modelState !== "downloading"
      ? "Try this model again"
      : step === "dictation-model" && mode === "full" && (modelState !== "done" || pairedMeetingPending)
      ? modelState === "error" || pairedMeetingState === "error"
        ? "Retry download"
        : modelState === "downloading" || pairedMeetingState === "downloading"
          ? "Downloading…"
          : downloadAndContinueLabel([
              // Built-in speech has nothing to fetch, so it adds no size.
              ...(modelState !== "done" && selectedRoute?.sizeMib !== 0
                ? [selectedRoute?.sizeMib ?? null]
                : []),
              ...(pairedMeetingDownloadMib !== undefined ? [pairedMeetingDownloadMib] : []),
            ])
      : step === "use-everywhere" && mode === "full"
        ? "Start dictating"
      : step === "meeting-setup" && meetingSetupCheckFailed
        ? "Check meeting setup again"
      : step === "ready"
        ? "Start using Plainsong"
        : step === "meeting-setup" && speakerModelState === "downloading"
          ? "Downloading speaker model…"
        : meetingSpeechDownloadPending
          ? meetingModelState === "error"
            ? "Retry meeting model download"
            : meetingModelState === "downloading"
              ? "Downloading meeting model…"
              : speakerModelRidesAlong
                ? meetingModelDownloadSize && speakerModelSize
                  ? `Download meeting models (${meetingModelDownloadSize} + ${speakerModelSize})`
                  : "Download meeting models"
                : meetingModelDownloadSize
                  ? `Download meeting model (${meetingModelDownloadSize})`
                  : "Download meeting model"
        : step === "meeting-setup" && speakerModelRidesAlong
          ? speakerModelSize
            ? `Download speaker model (${speakerModelSize})`
            : "Download speaker model"
        : step === "meeting-setup" && speakerModelNeeded && speakerModelState === "error"
          ? "Continue without speaker labels"
          : isLastStep
            ? mode === "meetings" || step === "meeting-setup"
              ? "Finish meeting setup"
              : "Finish"
            : "Continue";

  const displayShortcut = formatShortcutForDisplay(shortcutValue);
  const scratchBusy =
    scratchState === "starting" ||
    scratchState === "listening" ||
    scratchState === "transcribing";
  const wizardTitle = STEP_LABELS[step];
  const hotkeyModeChoice = (
    <HotkeyModeChoice
      mode={hotkeyMode}
      onModeChange={setHotkeyMode}
      offerHandsFree={handsFreeConfigured}
      holdToTalkAvailable={holdToTalkAvailable}
      nativeOnlyTrigger={["fn", "function", "rightcommand", "rightoption"].includes(shortcutValue.trim().toLowerCase())}
      tapToLock={tapToLock}
      onTapToLockChange={setTapToLock}
      doubleTapToLock={doubleTapToLock}
      onDoubleTapToLockChange={setDoubleTapToLock}
    />
  );

  return (
    <DialogPrimitive.Root open>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
      <DialogPrimitive.Content asChild aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); stepHeadingRef.current?.focus(); }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          previouslyFocusedRef.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card/95 text-card-foreground shadow-2xl"
      >
        {/* Header and footer stay put; only the step body scrolls, so the
            title, the progress and the buttons are always on screen. */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-8 pb-5 pt-7">
          <div className="min-w-0 space-y-1">
            <p className="rubric">
              {mode === "meetings"
                ? "MEETING SETUP"
                : mode === "dictation"
                  ? "DICTATION SETUP"
                  : "SETUP"}
            </p>
            <h2
              ref={stepHeadingRef}
              id={titleId}
              tabIndex={-1}
              // Focus lands here only so screen readers start at the new
              // step (the live region below announces it); it is not a
              // control, so it shows no focus ring.
              className="font-serif text-xl font-semibold text-card-foreground outline-none"
            >
              {wizardTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {stepAnnouncement}
            </p>
          </div>
          {steps.length > 1 ? (
            <div className="flex shrink-0 gap-2" aria-hidden="true">
              {steps.map((currentStep, index) => (
                <div
                  key={currentStep}
                  className={`h-2 w-8 rounded-full transition-colors ${
                    index <= stepIndex ? "bg-primary" : "bg-muted"
                  }`}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div
          ref={stepBodyRef}
          className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
        >
          {/* Keyed on the step so each one arrives with a short fade and rise;
              reduced motion drops it. */}
          <div
            key={step}
            className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
          >
            {step === "microphone" ? (
              <MicrophoneStep
                onHeardChange={setMicHeard}
                onOpenMicrophoneSettings={() =>
                  void openMicrophoneSettingsFromWizard()
                }
              />
            ) : null}

            {step === "try-dictation" ? (
              <TryDictationStep
                modelName={selectedRoute?.label ?? "Speech model"}
                perms={perms}
                permsLoading={permsLoading}
                onRefreshPermissions={() => void refreshPerms()}
                onRequestPermissions={() => void requestPermissionsNow()}
                onOpenMicrophoneSettings={() =>
                  void openMicrophoneSettingsFromWizard()
                }
                permissionRequestBusy={permissionRequestBusy}
                permissionRequestError={permissionRequestError}
                permissionRequestStatus={permissionRequestStatus}
                modelState={modelState}
                modelError={modelError}
                modelPercent={downloadPercent}
                modelSize={formatDownloadSize(selectedRoute?.sizeMib)}
                onDownloadModel={() => void startModelDownload(selectedRouteId)}
                scratchState={scratchState}
                scratchText={scratchText}
                scratchError={scratchError}
                onChooseSmallerModel={scratchMemoryRefused ? () => {
                  setMemoryRefusedRouteId(selectedRouteId);
                  goToStep("dictation-model");
                } : undefined}
                onStartScratch={() => void startScratchDictation()}
                onFinishScratch={() => void finishScratchDictation()}
                displayShortcut={displayShortcut}
              />
            ) : null}

            {step === "use-everywhere" ? (
              <UseEverywhereStep
                perms={perms}
                permsLoading={permsLoading}
                onRefreshPermissions={() => void refreshPerms()}
                onOpenAccessibilitySettings={() =>
                  void openAccessibilitySettingsFromWizard()
                }
                displayShortcut={displayShortcut}
                onShortcutChange={setShortcutValue}
                modeChoice={hotkeyModeChoice}
                nativeShortcutAvailable={holdToTalkAvailable === true}
                saveError={saveError}
                muteMedia={muteMediaWhileDictating}
                onMuteMediaChange={setMuteMediaWhileDictating}
              />
            ) : null}

            {step === "ready" ? (
              <ReadyStep
                shortcutValue={shortcutValue}
                displayShortcut={displayShortcut}
                tapToLock={tapToLock && !doubleTapToLock}
                doubleTapToLock={doubleTapToLock}
                micHeardOn={micHeard}
                aiNotesChoice={aiNotesChoice}
                hotkeyMode={hotkeyMode}
                modelState={modelState}
                modelError={modelError}
                modelPercent={downloadPercent}
                modelSize={formatDownloadSize(selectedRoute?.sizeMib)}
                modelSkipped={modelSkipped}
                onRetryModel={() => void startModelDownload(selectedRouteId)}
                onOpenAccessibilitySettings={() =>
                  void openAccessibilitySettingsFromWizard()
                }
                meetingsSkipped={meetingsSkipped}
                microphoneReady={
                  perms?.microphonePermissionReady ?? perms?.microphoneReady
                }
                insertionReady={
                  Boolean(perms?.accessibilityReady) &&
                  Boolean(perms?.postEventReady)
                }
                scratchCompleted={scratchState === "complete"}
                meetingReady={meetingRouteReady === true}
                fullMeetingCaptureReady={meetingSystemAudioCapability?.ready === true}
              />
            ) : null}

            {step === "permissions" ? (
              <PermissionsStep
                perms={perms}
                observations={permissionObservations}
                loading={permsLoading}
                onRefresh={() => void refreshPerms()}
                autoRequestPermissions={autoRequestPermissions}
                onAutoRequestPermissionsChange={setAutoRequestPermissions}
                onRequestNow={() => void requestPermissionsNow()}
                onOpenPermissionSettings={(gate) =>
                  void openPermissionSettingsFromWizard(gate)
                }
                onOpenInstalledApp={() => void openInstalledAppFromWizard()}
                requestBusy={permissionRequestBusy}
                requestError={permissionRequestError}
                requestStatus={permissionRequestStatus}
                revocationNotice={permissionRevocation}
                registerCardRef={(key, node) => {
                  permRowRefs.current[key] = node;
                }}
              />
            ) : null}

            {step === "dictation-model" ? (
              <>
                <DictationModelStep
                  choices={speechChoices}
                  memoryRefusedLabel={routeSummaryFor(memoryRefusedRouteId)?.label ?? null}
                  state={modelState}
                  error={modelError}
                  percent={downloadPercent}
                  selectedRouteId={selectedRouteId}
                  preservedRoute={preservedDictationRoute}
                  upgradingFromOnnxParakeet={
                    upgradingFromOnnxParakeet &&
                    selectedRoute !== null &&
                    isRecommendedSpeechRoute(selectedRoute.providerType, selectedRoute.modelId) &&
                    modelState !== "done"
                  }
                  savedModelUnavailable={savedModelUnavailable}
                  downloadFromFooter={mode === "full"}
                  downloadDisabled={modelSelectionHydration !== "ready" || selectedRoute === null}
                  busy={modelState === "downloading" || pairedMeetingState === "downloading"}
                  meetingCoverage={
                    mode !== "full" || selectedRoute === null || !selectedRoute.meetingCapable
                      ? null
                      : meetingsFollowDictation(selectedRoute)
                        ? modelState === "done"
                          ? `Meetings will use ${selectedRoute.label} too.`
                          : "One download covers dictation and meetings."
                        : configuredMeeting
                          ? `Meetings keep using ${configuredMeeting.label}${
                              configuredMeeting.hosting === "local" ? ", already on this Mac" : ""
                            }.`
                          : null
                  }
                  meetingPairing={
                    offerPairedMeeting && selectedRoute
                      ? {
                          dictationLabel: selectedRoute.label,
                          options: meetingChoices.map((choice) => ({
                            value: choice.route.routeId,
                            label: meetingOptionLabel(
                              choice,
                              availableRouteIds.has(choice.route.routeId),
                            ),
                          })),
                          value: pairedMeetingValue,
                          meetingLabel: pairedMeetingChoice?.route.label ?? null,
                          state: pairedMeetingState,
                          error: pairedMeetingError,
                          percent: meetingDownloadPercent,
                          onChange: (value) => {
                            setPairedMeetingPick(value);
                            setPairedMeetingState("idle");
                            setPairedMeetingError(null);
                          },
                        }
                      : null
                  }
                  onSelect={(routeId) => {
                    modelSelectionChangedRef.current = true;
                    if (routeId !== selectedRouteId) {
                      if (routeId !== preservedDictationRoute?.routeId) {
                        setPreservedDictationRoute(null);
                      }
                      setModelState("idle");
                      setModelError(null);
                      setDownloadPercent(null);
                    }
                    setSelectedRouteId(routeId);
                    if (pairedMeetingState === "error") {
                      setPairedMeetingState("idle");
                      setPairedMeetingError(null);
                    }
                  }}
                  onDownload={() => void startModelDownload(selectedRouteId)}
                />
                {modelSelectionHydration === "loading" ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Checking model setup…
                  </p>
                ) : null}
                {modelSelectionHydration === "error" ? (
                  <div className="space-y-3">
                    <p
                      role="alert"
                      aria-label="Model setup unavailable"
                      className="text-sm text-destructive"
                    >
                      Model setup could not be loaded. Check again after startup or any system prompt finishes.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setModelSelectionHydration("loading");
                        setModelHydrationAttempt((attempt) => attempt + 1);
                      }}
                    >
                      Check model setup again
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}

            {step === "hotkey" ? (
              <HotkeyStep
                displayShortcut={displayShortcut}
                onShortcutChange={setShortcutValue}
                modeChoice={hotkeyModeChoice}
                nativeShortcutAvailable={holdToTalkAvailable === true}
                saveError={saveError}
              />
            ) : null}

            {step === "meeting-setup" ? (
              <>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {meetingSetupDownloadSummary}
              </p>
              <MeetingSetupStep
                loading={meetingSetupLoading}
                checkFailed={meetingSetupCheckFailed}
                routeSummary={meetingRouteSummary}
                routeReady={meetingTargetReady}
                routeError={meetingRouteError}
                verificationDetails={meetingVerificationDetails}
                recommendedModel={
                  meetingTarget
                    ? {
                        label: meetingTarget.label,
                        recommended: meetingTarget.recommended,
                        needsDownload: meetingTarget.needsDownload,
                        size: meetingModelDownloadSize,
                        sameAsDictation: meetingTarget.sameAsDictation,
                      }
                    : null
                }
                modelPicker={
                  !meetingSetupCheckFailed && meetingChoices.length > 0 && meetingPickerValue
                    ? {
                        value: meetingPickerValue,
                        options: [
                          ...(meetingChoices.some((choice) => choice.route.routeId === meetingPickerValue)
                            ? []
                            : [{ value: meetingPickerValue, label: meetingRouteSummary }]),
                          ...meetingChoices.map((choice) => ({
                            value: choice.route.routeId,
                            label: meetingOptionLabel(
                              choice,
                              availableRouteIds.has(choice.route.routeId),
                            ),
                          })),
                        ],
                        disabled:
                          meetingModelState === "downloading" ||
                          speakerModelState === "downloading" ||
                          saveBusy,
                        onChange: (value) => {
                          setMeetingStepPick(value);
                          setMeetingModelState("idle");
                          setMeetingModelError(null);
                        },
                      }
                    : null
                }
                microphoneReady={perms?.microphonePermissionReady ?? perms?.microphoneReady}
                microphoneChecking={permsLoading && perms === null}
                onOpenMicrophoneSettings={() =>
                  void openMicrophoneSettingsFromWizard()
                }
                systemAudioCapability={meetingSystemAudioCapability}
                systemAudioTestLoading={systemAudioTestLoading}
                systemAudioTestResult={systemAudioTestResult}
                meetingModelState={meetingModelState}
                meetingModelError={meetingModelError}
                meetingDownloadPercent={meetingDownloadPercent}
                speakerModel={
                  speakerModelPlan
                    ? {
                        name: speakerModelDownloadName(speakerModelPlan),
                        installed: speakerModelPlan.selectedInstalled,
                        separationOn: speakerSeparationOn,
                        ridesWithSpeechModel:
                          meetingSpeechDownloadPending && meetingModelState !== "done",
                      }
                    : null
                }
                speakerModelState={speakerModelState}
                speakerModelError={speakerModelError}
                onRetrySpeakerModel={() => void startSpeakerModelDownload()}
                onTestSystemAudio={() => void testMeetingSystemAudio()}
                meetingAudioStorageMode={meetingAudioStorageMode}
                onMeetingAudioStorageModeChange={setMeetingAudioStorageMode}
                meetingRetentionPreset={meetingRetentionPreset}
                onMeetingRetentionPresetChange={setMeetingRetentionPreset}
                meetingRetentionCustomMonths={meetingRetentionCustomMonths}
                onMeetingRetentionCustomMonthsChange={setMeetingRetentionCustomMonths}
                meetingRetentionDeleteMode={meetingRetentionDeleteMode}
                onMeetingRetentionDeleteModeChange={setMeetingRetentionDeleteMode}
                onRefresh={() => {
                  void refreshMeetingSetup();
                  void refreshPerms();
                }}
                saveError={saveError}
                saveErrorContext={saveErrorContext}
              />
              </>
            ) : null}

            {step === "ai-notes" ? (
              <AiNotesStep
                choice={aiNotesChoice}
                onChoiceChange={setAiNotesChoice}
                configuredProvider={aiNotesProvider}
                nativeTextAvailable={notesDownloadStatus?.runtimePresent === true}
                localAiReady={localAiReady}
                localAiMessage={localAiMessage}
                localAiNeedsSetup={localAiNeedsSetup}
                localAiChecking={localAiChecking}
                onRecheckLocalAi={() => void checkLocalAiRuntime()}
                onOpenAiSettings={() => {
                  void (async () => {
                    // Save the choice before leaving, or a reader who went to add a
                    // key would come back to a wizard that forgot they had decided.
                    const saved = await persistAiNotesStep();
                    if (!saved) {
                      return;
                    }
                    completeWizard({
                      markOnboardingComplete: mode === "full",
                      meetingsCompleted: mode === "meetings",
                    });
                    requestReadinessDestination("ai");
                  })();
                }}
                saveError={saveError}
                saveErrorContext={saveErrorContext}
              />
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 justify-between gap-2 border-t border-border/60 px-8 py-4">
          <div className="flex gap-2">
            {mode === "full" ? (
              // The last step has nothing left to skip, and meeting setup has
              // its own "Skip meetings" beside the main button.
              step === "ready" || step === "meeting-setup" ? null : step === "dictation-model" &&
                modelState !== "done" ? (
                <Button
                  variant="ghost"
                  onClick={skipModelDownload}
                  className="text-muted-foreground"
                  disabled={modelState === "downloading" || pairedMeetingState === "downloading"}
                >
                  Skip model download
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() =>
                    // Not a completion. Recorded as a deferral against exactly
                    // what is unmet right now, so this stays quiet until
                    // something else breaks -- and Settings > General > Setup guide
                    // still reopens it on demand.
                    completeWizard({
                      markOnboardingComplete: false,
                      meetingsCompleted: false,
                      deferred: true,
                    })
                  }
                  className="text-muted-foreground"
                  disabled={scratchBusy}
                >
                  Skip setup for now
                </Button>
              )
            ) : (
              <Button variant="ghost" onClick={() => completeWizard()} className="text-muted-foreground">
                Close
              </Button>
            )}
            {step === "meeting-setup" && mode !== "meetings" ? (
              <Button
                variant="outline"
                onClick={() => skipMeetingSetup()}
                disabled={
                  meetingModelState === "downloading" ||
                  speakerModelState === "downloading" ||
                  saveBusy
                }
              >
                Skip meetings
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            {previousStep !== null ? (
              <Button variant="ghost" onClick={goBack} disabled={backDisabled}>
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            ) : null}
            {step === "use-everywhere" && mode === "full" ? (
              <Button variant="outline" onClick={() => void nextStep()} disabled={saveBusy || permissionRequestBusy}>
                Set up meetings
              </Button>
            ) : null}
            <Button
              onClick={() => {
                if (step === "use-everywhere" && mode === "full") {
                  // Through Ready, not straight out: it is the only step that
                  // warns about a skipped or failed model download and about
                  // insertion that is not ready yet.
                  void persistDictationStep().then((saved) => { if (saved) skipMeetingSetup(); });
                } else {
                  void nextStep();
                }
              }}
              disabled={
                saveBusy ||
                permissionRequestBusy ||
                scratchBusy ||
                (step === "dictation-model" && (modelSelectionHydration !== "ready" || selectedRoute === null)) ||
                (step === "meeting-setup" &&
                  (meetingModelState === "downloading" || speakerModelState === "downloading")) ||
                // Only block Continue for a download in progress while the
                // user is still on a model surface they have to wait on. Ready
                // never blocks: it is the last step and has no Skip, so a slow
                // or failed download would otherwise hold the reader in the
                // modal. The download carries on, and Dictation retries it.
                (modelState === "downloading" &&
                  (step === "dictation-model" || step === "try-dictation")) ||
                (step === "dictation-model" && pairedMeetingState === "downloading") ||
                meetingSetupLoading
              }
            >
              {saveBusy || meetingSetupLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {nextLabel}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      </DialogPrimitive.Content>
    </div>
    </DialogPrimitive.Root>
  );
}

function TryDictationStep({
  perms,
  permsLoading,
  onRefreshPermissions,
  onRequestPermissions,
  onOpenMicrophoneSettings,
  permissionRequestBusy,
  permissionRequestError,
  permissionRequestStatus,
  modelName,
  modelState,
  modelError,
  modelPercent,
  modelSize,
  onDownloadModel,
  scratchState,
  scratchText,
  scratchError,
  onChooseSmallerModel,
  onStartScratch,
  onFinishScratch,
  displayShortcut,
}: {
  perms: PermissionDiagnostics | null;
  permsLoading: boolean;
  onRefreshPermissions(): void;
  onRequestPermissions(): void;
  onOpenMicrophoneSettings(): void;
  permissionRequestBusy: boolean;
  permissionRequestError: string | null;
  permissionRequestStatus: string | null;
  modelName: string;
  modelState: "idle" | "downloading" | "done" | "error";
  modelError: string | null;
  modelPercent: number | null;
  modelSize: string | null;
  onDownloadModel(): void;
  scratchState: ScratchDictationState;
  scratchText: string;
  scratchError: string | null;
  onChooseSmallerModel?: () => void;
  onStartScratch(): void;
  onFinishScratch(): void;
  displayShortcut: string;
}) {
  const microphoneReady =
    perms?.microphonePermissionReady ?? perms?.microphoneReady;
  const scratchInFlight =
    scratchState === "starting" || scratchState === "transcribing";
  // The rows only earn their place when something still blocks the test.
  const setupNeeded = !microphoneReady || modelState !== "done";
  const wordCount = scratchText ? scratchText.split(/\s+/).filter(Boolean).length : 0;
  // The test runs on the speech model, so until it is on this Mac the whole
  // practice surface stays quiet: no gold, and a sentence saying why.
  const modelReady = modelState === "done";

  // While the test listens, the meter follows the level the dictation engine
  // itself hears (the same reading the dictation pill uses), not a second
  // copy of the microphone.
  const [listeningLevel, setListeningLevel] = useState(0);
  // The result is the reward for this step, so bring it on screen. Smooth
  // scrolling is motion, and reduced motion jumps instead.
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scratchState !== "complete") {
      return;
    }
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView?.({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [scratchState]);
  useEffect(() => {
    if (scratchState !== "listening") {
      setListeningLevel(0);
      return;
    }
    let mounted = true;
    const timer = window.setInterval(() => {
      void getDictationAudioLevel()
        .then((raw) => {
          if (mounted) {
            setListeningLevel(Math.min(1, raw < 0.03 ? 0 : raw * 1.9));
          }
        })
        .catch(() => {});
    }, 90);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [scratchState]);

  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        Now try a real dictation. It runs exactly as it will in other apps, on
        this Mac, but the text stays here in Plainsong.
      </p>

      {setupNeeded ? (
        <div className="divide-y divide-border rounded-xl border border-border">
          {microphoneReady ? null : (
            <div className="flex gap-3 p-4">
              <span className="mt-0.5 text-muted-foreground">
                <Mic className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <p className="text-sm font-medium">Dictation permissions</p>
                  <p className="text-sm text-muted-foreground">
                    macOS may ask for Microphone so Plainsong can hear you, then
                    Accessibility so it can insert text in other apps.
                  </p>
                </div>
                {permsLoading || permissionRequestBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={onRequestPermissions}>
                      Request dictation permissions
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onOpenMicrophoneSettings}>
                      Open Settings
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onRefreshPermissions}
                      disabled={permsLoading}
                    >
                      Check again
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {modelState === "done" ? null : (
            <div className="flex items-start justify-between gap-4 p-4">
              <div className="flex min-w-0 gap-3">
                <span className="mt-0.5 text-muted-foreground">
                  <Download className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">Speech model</p>
                  <p className="text-sm text-muted-foreground">
                    {modelState === "downloading"
                      ? "Downloading the speech model you chose. The test is ready when it finishes."
                      : modelSize
                        ? `The test needs the speech model you chose first. It is a one-time ${modelSize} download.`
                        : "The test needs the speech model you chose first. It is a one-time download."}
                  </p>
                </div>
              </div>
              {modelState === "downloading" ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {modelPercent === null ? "Downloading" : `${Math.round(modelPercent)}%`}
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={onDownloadModel}>
                  {modelState === "error" ? "Retry download" : "Download"}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : null}

      <ModelDownloadProgress name={modelName} active={modelState === "downloading"} value={modelPercent} className="h-1.5" />
      {modelError ? (
        <p className="text-sm text-destructive" role="alert">
          The download didn&apos;t finish. {modelError}
        </p>
      ) : null}
      {permissionRequestStatus || permissionRequestError ? (
        <p
          className={`text-sm ${permissionRequestError ? "text-destructive" : "text-muted-foreground"}`}
          role={permissionRequestError ? "alert" : "status"}
        >
          {permissionRequestError ?? permissionRequestStatus}
        </p>
      ) : null}

      <div
        className={`rounded-xl border p-6 transition-colors motion-reduce:transition-none ${
          scratchState === "complete" && scratchText
            ? "border-gold/40 bg-gold/5"
            : modelReady
              ? "border-primary/30 bg-primary/5"
              : "border-border bg-muted/10"
        }`}
      >
        <div className="flex flex-col items-center text-center">
          {scratchState === "listening" ? (
            <MicLevelMeter level={listeningLevel} active className="mb-3" />
          ) : scratchState === "complete" && scratchText ? null : (
            <div
              className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full border ${
                scratchState === "complete" && scratchText
                  ? "border-gold/50 bg-gold/10 text-gold-text"
                  : "border-border bg-background text-muted-foreground"
              }`}
            >
              {scratchInFlight ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <Mic className="h-6 w-6" />
              )}
            </div>
          )}
          <p className="flex items-center gap-2 font-serif text-lg font-semibold">
            {scratchState === "complete" && scratchText ? (
              <CheckCircle2 className="h-5 w-5 text-gold-text" aria-hidden="true" />
            ) : null}
            {scratchState === "listening"
              ? "Listening"
              : scratchState === "transcribing"
                ? "Writing it down"
                : scratchState === "complete"
                  ? scratchText
                    ? "Your transcript"
                    : "Nothing came through"
                  : "Say one sentence"}
          </p>
          {scratchState === "complete" ? null : (
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {scratchState === "listening"
                ? "Speak naturally, then choose Finish."
                : scratchState === "transcribing"
                  ? "This takes a moment the first time while the model loads."
                  : "Try: “Um, let’s meet on Tuesday, no wait, Wednesday.” Plainsong drops the um and keeps the day you meant."}
            </p>
          )}
          {!modelReady && scratchState === "idle" ? (
            <p
              id="first-run-scratch-unavailable"
              className="mt-2 max-w-md text-sm text-muted-foreground"
            >
              {modelState === "downloading"
                ? "You can try this once the download finishes."
                : "Download the speech model above to try this."}
            </p>
          ) : null}

          {scratchState === "complete" ? (
            <div
              ref={resultRef}
              className="mt-4 w-full text-left"
              role="status"
              aria-live="polite"
            >
              {scratchText ? (
                <>
                  <blockquote className="rounded-lg border border-border border-l-2 border-l-gold bg-background/80 px-4 py-3 font-serif text-base leading-relaxed text-foreground">
                    {scratchText}
                  </blockquote>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {wordCount === 1 ? "1 word" : `${wordCount} words`}, written
                    on this Mac. Check that it matches what you said before
                    continuing. Use {displayShortcut} to dictate in other apps.
                  </p>
                </>
              ) : (
                <p className="text-center text-sm text-muted-foreground">
                  No speech was detected. Try again and speak a little closer to
                  the microphone.
                </p>
              )}
            </div>
          ) : null}

          <div className="mt-4">
            {scratchState === "listening" ? (
              <Button onClick={onFinishScratch}>Finish and transcribe</Button>
            ) : (
              <Button
                // Unavailable reads as unavailable: a disabled gilded button
                // still looks like the thing to press.
                variant={
                  !modelReady || (scratchState === "complete" && scratchText)
                    ? "outline"
                    : "default"
                }
                onClick={onStartScratch}
                disabled={scratchInFlight || !modelReady}
                aria-describedby={
                  !modelReady && scratchState === "idle"
                    ? "first-run-scratch-unavailable"
                    : undefined
                }
              >
                {scratchState === "complete" || scratchState === "error"
                  ? "Try again"
                  : scratchState === "starting"
                    ? "Getting ready"
                    : "Start a test"}
              </Button>
            )}
          </div>
        </div>

        {scratchError ? (
          <div className="mt-4 space-y-2 text-center">
            <p className="text-sm text-destructive" role="alert">{scratchError}</p>
            {onChooseSmallerModel ? (
              <Button variant="outline" onClick={onChooseSmallerModel} disabled={scratchInFlight}>
                Choose a smaller model
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Hold to talk or press to toggle: the one choice competitors ask about
 * before anything else, because it changes how every dictation feels.
 */
function HotkeyModeChoice({
  mode,
  onModeChange,
  offerHandsFree,
  holdToTalkAvailable,
  nativeOnlyTrigger,
  tapToLock,
  onTapToLockChange,
  doubleTapToLock,
  onDoubleTapToLockChange,
}: {
  mode: HotkeyMode;
  onModeChange(mode: HotkeyMode): void;
  offerHandsFree: boolean;
  holdToTalkAvailable: boolean | null;
  nativeOnlyTrigger: boolean;
  tapToLock: boolean;
  onTapToLockChange(next: boolean): void;
  doubleTapToLock: boolean;
  onDoubleTapToLockChange(next: boolean): void;
}) {
  const options: HotkeyMode[] = offerHandsFree
    ? ["hold_to_talk", "toggle", "hands_free"]
    : ["hold_to_talk", "toggle"];
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id="first-run-hotkey-mode-label">
        How the shortcut works
      </p>
      <RadioGroup<HotkeyMode>
        value={mode}
        onValueChange={onModeChange}
        aria-labelledby="first-run-hotkey-mode-label"
        className={`grid gap-2 ${options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        {options.map((option) => (
          <Radio.Root
            key={option}
            value={option}
            nativeButton
            render={<button type="button" />}
            // A <button> centres its content vertically by default, so a
            // one-line hint floated to the middle of a card stretched to
            // match a two-line neighbour. Flex from the top keeps every card
            // the same height with its text on the same top line.
            className={`flex h-full flex-col items-start justify-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors motion-reduce:transition-none ${
              mode === option
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <span className="text-sm font-medium">{HOTKEY_MODE_LABELS[option].name}</span>
            <span className="text-sm text-muted-foreground">{HOTKEY_MODE_LABELS[option].hint}</span>
          </Radio.Root>
        ))}
      </RadioGroup>
      {mode === "hold_to_talk" ? (
        <>
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-gold"
              checked={tapToLock}
              onChange={(event) => onTapToLockChange(event.target.checked)}
            />
            <span>
              <span className="font-medium">Tap to lock</span>
              <span className="block text-sm text-muted-foreground">
                A quick tap keeps listening without holding the key. Tap again to
                finish.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input type="checkbox" className="mt-0.5 accent-gold"
              checked={doubleTapToLock}
              onChange={(event) => onDoubleTapToLockChange(event.target.checked)} />
            <span>
              <span className="font-medium">Double-tap to lock</span>
              <span className="block text-sm text-muted-foreground">
                Two quick taps keep listening. Press again to finish. Replaces single-tap locking, including for Fn.
              </span>
            </span>
          </label>
          {holdToTalkAvailable === false ? (
            <p className="text-sm text-rust">
              {nativeOnlyTrigger
                ? "This shortcut works once Accessibility is on for Plainsong."
                : "Hold to talk is not available on this Mac right now, so the shortcut works as press to toggle until it is."}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ShortcutRecorder({
  inputId,
  displayShortcut,
  nativeShortcutAvailable,
  onShortcutChange,
}: {
  inputId: string;
  displayShortcut: string;
  nativeShortcutAvailable: boolean;
  onShortcutChange(value: string): void;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm font-medium">
        Dictation shortcut
      </label>
      <Input
        id={inputId}
        aria-describedby={`${inputId}-hint`}
        value={displayShortcut}
        readOnly
        onKeyDown={(event) => {
          if (event.key === "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") return;
          const parsed = formatShortcutFromKeyboardEvent(event);
          if (parsed) {
            onShortcutChange(parsed);
          }
        }}
        className="font-mono text-center"
      />
      <div className="flex flex-wrap gap-2" aria-label="Shortcut presets">
        {["Cmd+Shift+Space", "Fn", "RightCommand", "RightOption"].map((shortcut) => (
          <Button key={shortcut} type="button" size="sm" variant="outline"
            onClick={() => onShortcutChange(shortcut)}>
            {shortcut === "Fn" ? "Fn" : formatShortcutForDisplay(shortcut)}
          </Button>
        ))}
      </div>
      {nativeShortcutAvailable ? null : (
        <p className="text-sm text-muted-foreground">
          Fn and right-side modifier keys work once Accessibility is on for Plainsong.
        </p>
      )}
      <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">
        Pick one above, or click the field and press your own combination
        with at least one of Command, Control, Option or Shift.
      </p>
    </div>
  );
}

function UseEverywhereStep({
  perms,
  permsLoading,
  onRefreshPermissions,
  onOpenAccessibilitySettings,
  displayShortcut,
  nativeShortcutAvailable,
  onShortcutChange,
  modeChoice,
  saveError,
  muteMedia,
  onMuteMediaChange,
}: {
  muteMedia: boolean;
  onMuteMediaChange(value: boolean): void;
  perms: PermissionDiagnostics | null;
  permsLoading: boolean;
  onRefreshPermissions(): void;
  onOpenAccessibilitySettings(): void;
  displayShortcut: string;
  nativeShortcutAvailable: boolean;
  onShortcutChange(value: string): void;
  modeChoice: ReactNode;
  saveError: string | null;
}) {
  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        To type into other apps, macOS has to let Plainsong control the cursor.
        Then choose the shortcut you will press to dictate, and how it works.
      </p>

      <div className="space-y-3">
        {CURSOR_INSERTION_GATES.map((gate, index) => (
          <PermRow
            key={gate.key}
            order={index + 1}
            gate={gate}
            icon={PERMISSION_GATE_ICONS[gate.key]}
            ready={gate.ready({
              permissions: perms,
              systemAudio: null,
              calendarAuthorization: null,
            })}
            loading={permsLoading}
            onFix={onOpenAccessibilitySettings}
            registerRef={() => {}}
          />
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefreshPermissions}
          disabled={permsLoading}
        >
          Check again
        </Button>
      </div>

      <div className="space-y-4 border-t border-border pt-5">
        <ShortcutRecorder
          nativeShortcutAvailable={nativeShortcutAvailable}
          inputId="first-run-everywhere-shortcut"
          displayShortcut={displayShortcut}
          onShortcutChange={onShortcutChange}
        />
        {modeChoice}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={muteMedia}
            onChange={(event) => onMuteMediaChange(event.target.checked)}
          />
          <span>
            <span className="font-medium">Mute other audio while you dictate</span>
            <span className="block text-muted-foreground">
              Mutes your Mac's sound output while the microphone is live, including calls,
              music and notifications, then turns back on only what Plainsong muted.
            </span>
          </span>
        </label>
      </div>

      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to save shortcut: {saveError}
        </p>
      ) : null}
    </div>
  );
}

/** The shortcut as keycaps, one per key, in the platform's own symbols. */
function ShortcutKeys({ shortcut }: { shortcut: string }) {
  const keys = normalizeShortcut(shortcut).split("+").filter(Boolean);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" aria-label={formatShortcutForDisplay(shortcut)}>
      {keys.map((key, index) => {
        const label = formatShortcutForDisplay(key);
        // ⌘ ⇧ ⌥ ⌃ render small in the mono face; give single symbols the
        // system font at a larger size so they match "Space" beside them.
        const isSymbol = [...label].length === 1 && !/[A-Za-z0-9]/.test(label);
        return (
          <kbd
            key={`${key}-${index}`}
            aria-hidden="true"
            className={cn(
              "min-w-9 rounded-md border border-gold/40 bg-gold/10 px-2.5 py-1.5 text-center font-medium text-gold-text shadow-sm",
              isSymbol ? "font-sans text-lg leading-6" : "font-mono text-base",
            )}
          >
            {label}
          </kbd>
        );
      })}
    </span>
  );
}

function ReadyStep({
  shortcutValue,
  displayShortcut,
  hotkeyMode,
  tapToLock,
  doubleTapToLock,
  micHeardOn,
  aiNotesChoice,
  modelState,
  modelError,
  modelPercent,
  modelSize,
  modelSkipped,
  onRetryModel,
  onOpenAccessibilitySettings,
  microphoneReady,
  insertionReady,
  scratchCompleted,
  meetingReady,
  meetingsSkipped,
  fullMeetingCaptureReady,
}: {
  shortcutValue: string;
  displayShortcut: string;
  hotkeyMode: HotkeyMode;
  tapToLock: boolean;
  doubleTapToLock: boolean;
  micHeardOn: { deviceName: string | null } | null;
  aiNotesChoice: AiNotesChoice;
  modelState: "idle" | "downloading" | "done" | "error";
  modelError: string | null;
  modelPercent: number | null;
  modelSize: string | null;
  modelSkipped: boolean;
  onRetryModel(): void;
  onOpenAccessibilitySettings(): void;
  microphoneReady: boolean | undefined;
  insertionReady: boolean;
  scratchCompleted: boolean;
  meetingReady: boolean;
  /** The reader chose "Skip meetings" on the meeting step. */
  meetingsSkipped: boolean;
  fullMeetingCaptureReady: boolean;
}) {
  // Dictation only works once the model is on this Mac. Until then the
  // shortcut card must not read as "go ahead and press it".
  const dictationUsable = scratchCompleted || modelState === "done";
  const localDictation =
    scratchCompleted
      ? {
          detail: "Ready, and your test dictation worked.",
          tone: "ready" as const,
        }
      : modelState === "downloading"
        ? {
            detail: `Still downloading${
              modelPercent === null ? "" : ` (${Math.round(modelPercent)}%)`
            }. You can finish setup now; the download must finish before you can try dictation.`,
            tone: "progress" as const,
          }
        : modelState === "error"
          ? {
              detail: modelSkipped
                ? "The download was skipped after it failed. Download the model here or from Dictation before using the shortcut."
                : modelError
                  ? `The model didn't download. ${modelError} You can also download it later from Dictation.`
                  : "The model download needs another try, here or later from Dictation.",
              tone: "attention" as const,
            }
          : modelState === "done"
            ? {
                detail: "Downloaded. Practice dictation has not been verified.",
                tone: "neutral" as const,
              }
            : {
                detail: modelSkipped
                  ? "The model download was skipped. Download it here or from Dictation before using the shortcut."
                  : "The model has not been downloaded yet. Download it here or later from Dictation.",
                tone: "attention" as const,
              };
  const meetingsRow = meetingsSkipped
    ? {
        label: "Meetings",
        detail: "Not set up, as you chose. Set them up any time from More > Setup in the sidebar.",
        tone: "neutral" as const,
      }
    : {
        label: "Meetings",
        detail: fullMeetingCaptureReady
          ? "Records both you and the other people on the call."
          : meetingReady
            ? "Records your microphone. Set up meeting audio later from More > Setup in the sidebar to record the other people too."
            : "Needs the meeting model. You can download it later from More > Setup in the sidebar.",
        tone: meetingReady ? ("ready" as const) : ("attention" as const),
      };
  const modeSummary =
    hotkeyMode === "hold_to_talk" && doubleTapToLock
      ? `${HOTKEY_MODE_LABELS[hotkeyMode].hint} Two quick taps lock it on.`
      : hotkeyMode === "hold_to_talk" && tapToLock
      ? `${HOTKEY_MODE_LABELS[hotkeyMode].hint} A quick tap locks it on.`
      : HOTKEY_MODE_LABELS[hotkeyMode].hint;
  const rows = [
    {
      label: "Speech model",
      ...localDictation,
    },
    {
      label: "Microphone",
      detail: micHeardOn
        ? micHeardOn.deviceName
          ? `Heard you on ${micHeardOn.deviceName}.`
          : "Heard you clearly."
        : microphoneReady
          ? "Access is on."
          : "macOS access still needs attention.",
      tone: micHeardOn || microphoneReady ? ("ready" as const) : ("attention" as const),
    },
    {
      label: "Typing into other apps",
      detail: insertionReady
        ? "Accessibility is on, so your words land at the cursor."
        : "Accessibility is off, so your words are copied for you to paste instead of typed in. Turn it on in System Settings.",
      tone: insertionReady ? ("ready" as const) : ("attention" as const),
      action: insertionReady
        ? null
        : { label: "Open System Settings", onClick: onOpenAccessibilitySettings },
    },
    meetingsRow,
    // Notes are only about meetings; someone who skipped meetings was never
    // asked, so there is nothing to report.
    ...(meetingsSkipped
      ? []
      : [
          {
            label: "Meeting notes",
            detail:
              aiNotesChoice === "none"
                ? "Off. Meetings get transcripts only."
                : aiNotesChoice === "byok"
                  ? "Written by the cloud service you set up in Search & AI."
                  : aiNotesChoice === "native_text"
                    ? "Written on this Mac with the built-in text model, when it is ready."
                    : "Written on this Mac with Ollama, when it is running.",
            tone: "neutral" as const,
          },
        ]),
  ] as Array<{
    label: string;
    detail: string;
    tone: "ready" | "progress" | "attention" | "neutral";
    action?: { label: string; onClick(): void } | null;
  }>;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gold/30 bg-gold/5 p-5 text-center">
        <p className="text-sm text-muted-foreground">
          {dictationUsable
            ? "Put the cursor in any text field and press"
            : modelState === "downloading"
              ? "When the download finishes, put the cursor in any text field and press"
              : "Once the speech model is downloaded, put the cursor in any text field and press"}
        </p>
        <div className="mt-3 flex justify-center">
          <ShortcutKeys shortcut={shortcutValue} />
        </div>
        <p className="mt-3 text-sm text-foreground">
          <span className="font-medium">{HOTKEY_MODE_LABELS[hotkeyMode].name}.</span>{" "}
          <span className="text-muted-foreground">{modeSummary}</span>
        </p>
        <p className="sr-only">Your dictation shortcut is {displayShortcut}.</p>
      </div>

      <div className="divide-y divide-border rounded-xl border border-border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-start justify-between gap-4 p-4"
          >
            <div className="min-w-0 space-y-2">
              <div>
                <p className="text-sm font-medium">{row.label}</p>
                <p className="text-sm text-muted-foreground">{row.detail}</p>
              </div>
              {row.action ? (
                <Button size="sm" variant="outline" onClick={row.action.onClick}>
                  {row.action.label}
                </Button>
              ) : null}
            </div>
            <span
              className={
                row.tone === "ready"
                  ? "neume neume-lit mt-1"
                  : row.tone === "attention"
                    ? "neume neume-rust mt-1"
                    : "neume neume-hollow mt-1"
              }
              aria-hidden="true"
            />
          </div>
        ))}
      </div>

      {modelState === "idle" || modelState === "error" ? (
        <Button size="sm" variant="outline" onClick={onRetryModel}>
          {modelState === "error"
            ? "Retry speech model download"
            : modelSize
              ? `Download speech model (${modelSize})`
              : "Download speech model"}
        </Button>
      ) : null}

      <div className="flex items-start gap-3 border-t border-border pt-5">
        <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Both ways of working stay local by default</p>
          <p className="text-sm text-muted-foreground">
            Dictation and meeting audio stay on this Mac unless you turn on a
            cloud provider. Review and copy the latest dictation result in
            Plainsong. History follows your retention settings.
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionsStep({
  perms,
  observations,
  loading,
  onRefresh,
  autoRequestPermissions,
  onAutoRequestPermissionsChange,
  onRequestNow,
  onOpenPermissionSettings,
  onOpenInstalledApp,
  requestBusy,
  requestError,
  requestStatus,
  revocationNotice,
  registerCardRef,
}: {
  perms: PermissionDiagnostics | null;
  observations: PermissionGateObservations;
  loading: boolean;
  onRefresh(): void;
  autoRequestPermissions: boolean;
  onAutoRequestPermissionsChange(next: boolean): void;
  onRequestNow(): void;
  onOpenPermissionSettings(gate: PermissionGate): void;
  onOpenInstalledApp(): void;
  requestBusy: boolean;
  requestError: string | null;
  requestStatus: string | null;
  revocationNotice: string | null;
  registerCardRef(key: string, node: HTMLDivElement | null): void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Dictation needs the first three. The others each turn on one feature
        and are optional. Each button opens the right switch in System
        Settings, and Plainsong checks again when you come back.
      </p>

      {revocationNotice ? (
        <div
          role="alert"
          className="rounded-lg border border-rust/30 bg-rust/10 p-3 text-sm text-rust"
        >
          {revocationNotice}
        </div>
      ) : null}

      {perms?.runningFromDiskImage ? (
        <div className="rounded-lg border border-rust/30 bg-rust/10 p-3 space-y-2">
          <p className="text-sm font-medium text-rust">
            You are running the DMG copy
          </p>
          <p className="text-sm text-rust">
            macOS permissions granted to the installed app do not apply to the disk image copy. Move Plainsong into
            /Applications and reopen that installed app.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onOpenInstalledApp}>
              Open installed app
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              Re-check
            </Button>
          </div>
        </div>
      ) : null}

      <ol className="space-y-3">
        {PERMISSION_GATES.map((gate, index) => (
          <li key={gate.key}>
            <PermRow
              order={index + 1}
              gate={gate}
              icon={PERMISSION_GATE_ICONS[gate.key]}
              ready={gate.ready(observations)}
              loading={
                gate.key === "microphone" ? loading : loading || requestBusy
              }
              onFix={() => onOpenPermissionSettings(gate)}
              registerRef={(node) => registerCardRef(gate.key, node)}
            />
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-border p-3 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Ask macOS for permission when needed</p>
            <p className="text-sm text-muted-foreground">
              Requests microphone access before dictation starts, and Speech Recognition only if you have chosen Apple Speech. Turn this off if nobody will be at the Mac to answer the prompts.
            </p>
          </div>
          <input
            type="checkbox"
            checked={autoRequestPermissions}
            onChange={(event) => onAutoRequestPermissionsChange(event.target.checked)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRequestNow} disabled={requestBusy}>
            {requestBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Request permissions now
          </Button>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading || requestBusy}>
            Re-check permissions
          </Button>
        </div>
        {requestStatus ? (
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {requestStatus}
          </p>
        ) : null}
        {requestError ? (
          <p className="text-sm text-destructive" role="alert">
            {requestError}
          </p>
        ) : null}
      </div>

      {perms?.notes?.map((note, index) => (
        <p key={index} className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * One macOS grant: what it is for, what breaks without it, whether it is on
 * right now, and a way to go change it.
 *
 * Three states, not two. A grant Plainsong cannot read (Notifications) says
 * "Plainsong cannot read this one" rather than a made-up "not granted", and an
 * optional grant that is off is bronze, never rust -- it is a feature nobody
 * turned on, not a fault.
 */
function PermRow({
  order,
  gate,
  icon,
  ready,
  loading,
  onFix,
  registerRef,
}: {
  order: number;
  gate: PermissionGate;
  icon: ReactNode;
  ready: boolean | undefined;
  loading: boolean;
  onFix(): void;
  registerRef(node: HTMLDivElement | null): void;
}) {
  const stateLabel = !gate.observable
    ? "Plainsong cannot read this one"
    : ready === true
      ? "Granted"
      : ready === false
        ? gate.optional
          ? "Not granted"
          : "Still needed"
        : "Not checked yet";
  return (
    <div
      ref={registerRef}
      tabIndex={-1}
      className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="rubric-muted mt-0.5 shrink-0 text-[0.65rem]" aria-hidden="true">
          {order}
        </span>
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 space-y-1">
          <span className="text-sm font-medium">
            {gate.label}
            {gate.optional ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                Optional
              </span>
            ) : null}
          </span>
          <p className="text-sm text-muted-foreground">{gate.purpose}</p>
          <p className="text-sm text-muted-foreground">{gate.consequence}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="flex items-center gap-2">
          {loading && gate.observable ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <span
              className={
                ready === true
                  ? "neume neume-lit"
                  : !gate.observable || ready === undefined || gate.optional
                    ? "neume neume-hollow"
                    : "neume neume-rust"
              }
              aria-hidden="true"
            />
          )}
          <span
            // Polite and atomic, so a grant switched on in System Settings is
            // read out as "Accessibility: Granted" when the row catches up.
            aria-live="polite"
            aria-atomic="true"
            className={
              ready === true
                ? "text-sm text-gold-text"
                : gate.observable && ready === false && !gate.optional
                  ? "text-sm text-rust"
                  : "text-sm text-muted-foreground"
            }
          >
            <span className="sr-only">{gate.label}: </span>
            {stateLabel}
          </span>
        </span>
        {ready === true ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={onFix}
            className="h-7 text-xs"
            // Two rows send the reader to the same Accessibility list, so the
            // accessible name says which row's button this is.
            aria-label={`Open macOS ${gate.settingsLabel} settings for ${gate.label}`}
          >
            Open System Settings
          </Button>
        )}
      </div>
    </div>
  );
}

/** The meetings picker the speech step shows beside a dictation-only model. */
type MeetingPairing = {
  /** The dictation model selected above, by name. */
  dictationLabel: string;
  /** Every model that can transcribe meetings, with what choosing it costs. */
  options: { value: string; label: string }[];
  /** A model's route id, or `MEETINGS_LATER`. */
  value: string;
  /** The model picked, by name; null when meetings are left for later. */
  meetingLabel: string | null;
  state: "idle" | "downloading" | "done" | "error";
  error: string | null;
  percent: number | null;
  onChange(value: string): void;
};

/**
 * One section of the speech list: a heading that says what the models in it
 * cover, the recommended model as a card when it is in this section, and
 * every other model as one line with what sets it apart.
 */
function SpeechChoiceSection({
  headingId,
  title,
  hint,
  choices,
  selectedRouteId,
}: {
  headingId: string;
  title: string;
  hint: string;
  choices: SpeechChoice[];
  selectedRouteId: string | null;
}) {
  if (choices.length === 0) {
    return null;
  }
  const recommended = choices.find((choice) => choice.recommended) ?? null;
  const others = choices.filter((choice) => !choice.recommended);
  return (
    <div role="group" aria-labelledby={headingId} aria-describedby={`${headingId}-hint`} className="space-y-2">
      <p className="flex flex-wrap items-baseline gap-x-2 px-1 text-xs">
        <span id={headingId} className="font-semibold uppercase tracking-wide text-card-foreground/80">
          {title}
        </span>
        <span id={`${headingId}-hint`} className="text-muted-foreground">
          {hint}
        </span>
      </p>
      {recommended ? (
        <Radio.Root
          value={recommended.route.routeId}
          nativeButton
          render={<button type="button" />}
          className={`flex w-full items-start justify-between gap-4 rounded-lg border-2 p-3 text-left ${
            selectedRouteId === recommended.route.routeId
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/40"
          }`}
        >
          <span className="min-w-0 space-y-0.5">
            <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
              <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gold-text">
                <span className="neume neume-lit" aria-hidden="true" />
                Recommended
              </span>
              {/* A space for the radio's accessible name; flex drops it visually. */}
              {" "}
              {recommended.route.label}
            </span>
            <span className="block text-sm text-muted-foreground">
              {isOnnxParakeetRoute(recommended.route.providerType, recommended.route.modelId) ||
              isRecommendedSpeechRoute(recommended.route.providerType, recommended.route.modelId)
                ? PARAKEET_LANGUAGE_NOTE
                : recommended.note}
            </span>
          </span>
          {formatDownloadSize(recommended.sizeMib) ? (
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
              {formatDownloadSize(recommended.sizeMib)}
            </span>
          ) : null}
        </Radio.Root>
      ) : null}
      {others.length > 0 ? (
        <div
          role="presentation"
          className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
        >
          {others.map((choice) => {
            const selected = selectedRouteId === choice.route.routeId;
            const size = formatDownloadSize(choice.sizeMib);
            return (
              <Radio.Root
                key={choice.route.routeId}
                value={choice.route.routeId}
                nativeButton
                render={<button type="button" />}
                className={`flex w-full items-baseline gap-3 px-3 py-2 text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 ${
                  selected ? "bg-primary/10" : "hover:bg-muted/40"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`relative top-0.5 h-3 w-3 shrink-0 rounded-full border ${
                    selected ? "border-primary bg-primary" : "border-muted-foreground/50"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{choice.route.label}</span>
                  <span className="text-muted-foreground">{" — "}{choice.note}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {size ?? (choice.route.hosting === "platform" ? "Built in" : "")}
                </span>
              </Radio.Root>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Whisper Tiny is for dictation only. Meetings will use: [Parakeet v3]".
 * Directly under the list, so choosing a dictation-only model shows on the
 * same screen that meetings need their own, which one they get, and that
 * they can wait. The primary button below counts its download.
 */
function MeetingPairingRow({ pairing }: { pairing: MeetingPairing }) {
  const selectId = useId();
  const sentenceId = useId();
  const later = pairing.value === MEETINGS_LATER;
  return (
    <div className="space-y-2 rounded-lg border border-gold/40 bg-gold/5 p-3">
      <p id={sentenceId} className="text-sm">
        <span className="font-medium">{pairing.dictationLabel} is for dictation only.</span>{" "}
        <span className="text-muted-foreground">
          Meetings need a model of their own.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={selectId} className="shrink-0 text-sm font-medium">
          Meetings will use
        </label>
        <select
          id={selectId}
          aria-describedby={sentenceId}
          className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm"
          value={pairing.value}
          disabled={pairing.state === "downloading"}
          onChange={(event) => pairing.onChange(event.target.value)}
        >
          {pairing.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value={MEETINGS_LATER}>Set up meetings later</option>
        </select>
      </div>
      {later ? (
        <p className="text-sm text-muted-foreground">
          Dictation works without it. Meeting setup, a few steps on, offers a
          meetings model again, and Settings &gt; Models lists them all.
        </p>
      ) : null}
      <ModelDownloadProgress name={pairing.meetingLabel ?? "Meetings speech model"} active={pairing.state === "downloading"} value={pairing.percent} className="h-2" />
      {pairing.state === "downloading" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Getting {pairing.meetingLabel} for meetings
            {pairing.percent !== null ? `: ${Math.round(pairing.percent)}%` : "…"}
          </div>
        </div>
      ) : null}
      {pairing.state === "error" ? (
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {pairing.meetingLabel ?? "The meetings model"} didn&apos;t download. {pairing.error}{" "}
            Or choose Set up meetings later.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function DictationModelStep({
  choices,
  savedModelUnavailable,
  state,
  error,
  percent,
  selectedRouteId,
  preservedRoute,
  upgradingFromOnnxParakeet,
  downloadFromFooter,
  downloadDisabled,
  busy,
  meetingCoverage,
  meetingPairing,
  memoryRefusedLabel,
  onSelect,
  onDownload,
}: {
  /** Every distinct model this Mac can run, recommended first (`speechChoicesForLane`). */
  choices: SpeechChoice[];
  /** The model a practice dictation just ran out of memory with, if any. */
  memoryRefusedLabel: string | null;
  savedModelUnavailable: boolean;
  state: "idle" | "downloading" | "done" | "error";
  error: string | null;
  percent: number | null;
  selectedRouteId: string | null;
  preservedRoute: PreservedDictationRoute | null;
  /** The selected model replaces the ONNX build of the same Parakeet v3. */
  upgradingFromOnnxParakeet: boolean;
  downloadFromFooter: boolean;
  downloadDisabled: boolean;
  /** A download is running: the list holds still until it finishes. */
  busy: boolean;
  /** What the selected model means for meetings, when it covers them. */
  meetingCoverage: string | null;
  /** The meetings picker, shown while the selected model is for dictation only. */
  meetingPairing: MeetingPairing | null;
  onSelect(routeId: string): void;
  onDownload(): void;
}) {
  const { dictationAndMeetings, dictationOnly } = groupSpeechChoices(choices);
  const sectionId = useId();
  const selectedLabel =
    choices.find((choice) => choice.route.routeId === selectedRouteId)?.route.label ??
    (preservedRoute?.routeId === selectedRouteId ? preservedRoute.label : null);
  return (
    <div className="space-y-4">
      {/* What each model covers is on its own line; the intro does not repeat it. */}
      <p className="text-sm text-muted-foreground">
        Plainsong turns your voice into text on this Mac, so it needs a speech
        model first. It's a one-time download, and you can change it later in
        Settings.
      </p>
      {memoryRefusedLabel ? (
        <p role="alert" className="rounded-lg border border-rust/40 bg-rust/5 p-3 text-sm">
          {memoryRefusedLabel} needed more free memory than this Mac had just
          now. Pick a smaller model below, or close memory-heavy apps and try
          again.
        </p>
      ) : null}
      {savedModelUnavailable ? (
        <p className="text-sm text-muted-foreground">
          Your previous speech model is unavailable in this version. Choose a model below to continue.
        </p>
      ) : null}

      {/* No colour transitions on these options. A pointer moving over the
          list crosses a row edge every few frames, and each crossing started
          two 150 ms transitions, so a window left open on this step repainted
          almost continuously whenever the mouse passed over it. Hover changes
          are instant instead. */}
      <RadioGroup<string>
        value={selectedRouteId ?? ""}
        onValueChange={(value) => {
          if (!busy && value) {
            onSelect(value);
          }
        }}
        disabled={busy}
        aria-label="Speech model"
        className="space-y-4"
      >
        {preservedRoute ? (
          <Radio.Root
            value={preservedRoute.routeId}
            nativeButton
            render={<button type="button" />}
            className={`flex w-full items-start justify-between gap-4 rounded-lg border-2 p-3 text-left ${
              selectedRouteId === preservedRoute.routeId
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm font-medium">Current model</span>
              <span className="block text-sm text-muted-foreground">
                Already set up and ready on this Mac.
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end pt-0.5 text-xs text-muted-foreground">
              {preservedRoute.label}
            </span>
          </Radio.Root>
        ) : null}

        {/* Two sections, so whether a model also does meetings is said once,
            where the reader chooses, instead of on every line. */}
        <SpeechChoiceSection
          headingId={`${sectionId}-both`}
          title="Dictation and meetings"
          hint="One model does both"
          choices={dictationAndMeetings}
          selectedRouteId={selectedRouteId}
        />
        <SpeechChoiceSection
          headingId={`${sectionId}-dictation`}
          title="Dictation only"
          hint="Meetings need a second model"
          choices={dictationOnly}
          selectedRouteId={selectedRouteId}
        />
      </RadioGroup>

      {meetingPairing ? (
        <MeetingPairingRow pairing={meetingPairing} />
      ) : meetingCoverage ? (
        <p className="text-sm text-muted-foreground">{meetingCoverage}</p>
      ) : null}
      {/* Said once when the meetings picker appears, so a screen reader hears
          that meetings now need their own model. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {meetingPairing
          ? `${meetingPairing.dictationLabel} is for dictation only. Choose a model for meetings below the list.`
          : ""}
      </p>

      {upgradingFromOnnxParakeet ? (
        <p className="text-sm text-muted-foreground">
          Your current Parakeet v3 keeps working until this finishes. This is a
          faster, more accurate version of the same model, and Plainsong
          switches to it once it's downloaded.
        </p>
      ) : null}

      {state === "idle" && !downloadFromFooter ? (
        <Button
          id="download-model-btn"
          onClick={onDownload}
          className="gap-2"
          disabled={downloadDisabled}
        >
          <Download className="h-4 w-4" />
          Download {selectedLabel}
        </Button>
      ) : null}

      <ModelDownloadProgress name={selectedLabel ?? "Speech model"} active={state === "downloading"} value={percent} className="h-2" />
      {state === "downloading" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Downloading {selectedLabel}
            {percent !== null ? `: ${Math.round(percent)}%` : "…"}
          </div>
        </div>
      ) : null}

      {state === "done" ? (
        <div className="flex items-center gap-2 text-sm text-gold-text" role="status">
          <CheckCircle2 className="h-4 w-4" />
          {/* Also the state on a second run, when nothing was downloaded now. */}
          {selectedLabel ? `${selectedLabel} is on this Mac and ready.` : "The model is on this Mac and ready."}
        </div>
      ) : null}

      {state === "error" ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>The download didn&apos;t finish. {error}</span>
          </div>
          {!downloadFromFooter ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDownload}
              disabled={downloadDisabled}
            >
              Retry download
            </Button>
          ) : null}
        </div>
      ) : null}

      {state === "done" && !preservedRoute ? null : (
        <p className="text-sm text-muted-foreground">
          {preservedRoute
            ? "Continue to keep your current model, or choose a replacement above."
            : downloadFromFooter
            ? "You can skip this and download later, but dictation won't work until a speech model is downloaded."
            : "Start the download here, or keep the model you already use. You can change models later in Settings."}
        </p>
      )}
    </div>
  );
}

function HotkeyStep({
  displayShortcut,
  nativeShortcutAvailable,
  onShortcutChange,
  modeChoice,
  saveError,
}: {
  displayShortcut: string;
  nativeShortcutAvailable: boolean;
  onShortcutChange(value: string): void;
  modeChoice: ReactNode;
  saveError: string | null;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Choose the shortcut you press to dictate in any app, and how it works.
        Both can be changed later in Settings &gt; Shortcuts.
      </p>

      <ShortcutRecorder
        nativeShortcutAvailable={nativeShortcutAvailable}
        inputId="first-run-dictation-shortcut"
        displayShortcut={displayShortcut}
        onShortcutChange={onShortcutChange}
      />

      {modeChoice}

      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to save shortcut: {saveError}
        </p>
      ) : null}
    </div>
  );
}

const AI_NOTES_OPTIONS: Array<{
  id: AiNotesChoice;
  label: string;
  detail: string;
}> = [
  {
    id: "native_text",
    label: "Use the built-in text model for meeting notes",
    detail: "Download it here when you choose. Runs on this Mac without an account.",
  },
  {
    id: "ollama",
    label: "Use Ollama for meeting notes",
    detail:
      "Ollama's local models run on this Mac. Its cloud models send text off this Mac and need cloud AI processing allowed in Privacy & data. Ollama is a separate free download.",
  },
  {
    id: "byok",
    label: "Use my own API key",
    detail:
      "Transcripts are sent to the service you pick. Add the key under Search & AI.",
  },
  {
    id: "none",
    label: "Transcripts only, no automatic notes",
    detail:
      "Meetings are still recorded, transcribed and searchable. No summary, action items or auto-title.",
  },
];

/**
 * How meeting notes get written, asked once, before the first meeting.
 *
 * A default install points the meetings lane at an Ollama nobody installed, so
 * the summary, action items and title of the first meeting all failed silently.
 * The choices are local notes, a provider key, or transcripts only. A saved
 * built-in model remains available, and transcripts only is remembered so
 * readiness reports a decision instead of a fault.
 */
function AiNotesStep({
  choice,
  onChoiceChange,
  configuredProvider,
  nativeTextAvailable,
  localAiReady,
  localAiMessage,
  localAiNeedsSetup,
  localAiChecking,
  onRecheckLocalAi,
  onOpenAiSettings,
  saveError,
  saveErrorContext,
}: {
  choice: AiNotesChoice;
  onChoiceChange(choice: AiNotesChoice): void;
  configuredProvider: string;
  /** This Mac can run the built-in text model, so the step offers it. */
  nativeTextAvailable: boolean;
  localAiReady: boolean | null;
  localAiMessage: string | null;
  localAiNeedsSetup: boolean;
  localAiChecking: boolean;
  onRecheckLocalAi(): void;
  onOpenAiSettings(): void;
  saveError: string | null;
  saveErrorContext: "hotkey" | "meeting-route" | "meeting-settings" | "ai-notes" | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        After a meeting, Plainsong can write a summary, action items and a
        title. Choose what writes them. Recording and transcripts work either
        way.
      </p>

      <p className="text-sm text-muted-foreground">
        Dictation cleanup is separate from meeting notes. Basic formatting
        handles punctuation and spoken corrections locally. AI cleanup depends
        on the provider and model you select.
      </p>

      <RadioGroup<AiNotesChoice>
        className="space-y-2"
        value={choice}
        onValueChange={onChoiceChange}
        aria-label="How meeting notes are written"
      >
        {AI_NOTES_OPTIONS.filter(
          (option) =>
            option.id !== "native_text" ||
            nativeTextAvailable ||
            configuredProvider === "native_text",
        ).map((option) => (
          <Radio.Root
            key={option.id}
            value={option.id}
            nativeButton
            render={<button type="button" />}
            className={`flex w-full items-start justify-between gap-3 rounded-lg border-2 p-3 text-left transition-all ${
              choice === option.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <div>
              <p className="text-sm font-medium">{option.label}</p>
              <p className="text-sm text-muted-foreground">{option.detail}</p>
            </div>
          </Radio.Root>
        ))}
      </RadioGroup>

      {choice === "ollama" || choice === "native_text" ? (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {choice === "native_text" ? "Built-in text model on this Mac" : "Ollama on this Mac"}
              </p>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {localAiChecking
                  ? choice === "native_text"
                    ? "Checking the built-in text model…"
                    : "Checking Ollama and the selected model…"
                  : localAiMessage ?? (localAiReady === true
                    ? choice === "native_text"
                      ? "The built-in text model is ready for meeting notes on this Mac."
                      : "Ollama and the selected model are ready for meeting notes on this Mac."
                    : localAiReady === false
                      ? choice === "native_text"
                        ? "The built-in text model is not ready, so notes will not be written yet."
                        : "Ollama or the selected model is not ready, so notes will not be written yet."
                      : choice === "native_text"
                        ? "Plainsong could not confirm the built-in text model."
                        : "Plainsong could not confirm Ollama and the selected model.")}
              </p>
            </div>
            {localAiChecking ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span
                className={`neume shrink-0 ${
                  localAiReady === true ? "neume-lit" : "neume-hollow"
                }`}
                aria-hidden="true"
              />
            )}
          </div>
          {localAiReady === true ? null : (
            <div className="mt-3 space-y-2">
              {localAiNeedsSetup && <p className="text-sm text-muted-foreground">
                Install Ollama from{" "}
                <code className="rounded bg-muted px-1">ollama.com/download</code>
                , start it, then pull a model with{" "}
                <code className="rounded bg-muted px-1">
                  ollama pull qwen3.5:4b
                </code>
                .
              </p>}
              <Button
                size="sm"
                variant="outline"
                onClick={onRecheckLocalAi}
                disabled={localAiChecking}
              >
                Check again
              </Button>
              {localAiNeedsSetup && <p className="text-sm text-muted-foreground">
                You can continue now. Meetings will record and transcribe, and
                Plainsong will say plainly that notes are unavailable until
                Ollama and the selected model are ready.
              </p>}
            </div>
          )}
        </div>
      ) : null}

      {choice === "native_text" ? <NativeTextModelRow onChanged={onRecheckLocalAi} /> : null}

      {choice === "byok" ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-sm font-medium">
            {isRemoteAnalysisProvider(configuredProvider)
              ? `Currently set to ${describeAnalysisDestination(configuredProvider)}`
              : "No cloud provider is selected yet"}
          </p>
          <p className="text-sm text-muted-foreground">
            Add the key in Settings &gt; Search &amp; AI and turn cloud AI on. Until then,
            meetings still record and transcribe, and Plainsong reports notes as
            unavailable rather than pretending they were written.
          </p>
          <Button size="sm" variant="outline" onClick={onOpenAiSettings}>
            <KeyRound className="mr-2 h-4 w-4" />
            Open Search &amp; AI settings
          </Button>
        </div>
      ) : null}

      {choice === "none" ? (
        <div className="rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">
            Plainsong will remember this and will not flag missing meeting notes
            as a problem. Change it any time in Settings &gt; Meetings.
          </p>
        </div>
      ) : null}

      {saveError && saveErrorContext === "ai-notes" ? (
        <p className="text-sm text-destructive" role="alert">
          Couldn&apos;t save the meeting-notes choice: {saveError}
        </p>
      ) : null}
    </div>
  );
}

type MeetingSaveErrorContext =
  | "hotkey"
  | "meeting-route"
  | "meeting-settings"
  | "ai-notes"
  | null;

/**
 * One line of the meeting summary: what it is, where it stands in a sentence,
 * and a neume. "Not yet" is hollow and quiet -- a model nobody has downloaded
 * on a first run is the normal state, not a fault. Rust is kept for something
 * that is actually wrong.
 */
function MeetingStatusRow({
  label,
  tone,
  busy,
  children,
}: {
  label: string;
  tone: "ready" | "not-yet" | "problem";
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{label}</p>
        {children}
      </div>
      {busy ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : (
        <span
          className={`neume mt-1 shrink-0 ${
            tone === "ready" ? "neume-lit" : tone === "problem" ? "neume-rust" : "neume-hollow"
          }`}
          aria-hidden="true"
        />
      )}
    </li>
  );
}

/**
 * Meeting setup, as a first-time reader needs it: can Plainsong transcribe a
 * meeting, hear you, and hear the other people -- each in one plain sentence
 * with the one action that fixes it. What the sidecar reports verbatim (audio
 * backends, sample rates, route ids, settings paths) is kept under Details for
 * support, not put in front of someone setting the app up for the first time.
 */
function MeetingSetupStep({
  loading,
  checkFailed,
  routeSummary,
  routeReady,
  routeError,
  verificationDetails,
  recommendedModel,
  modelPicker,
  microphoneReady,
  microphoneChecking,
  onOpenMicrophoneSettings,
  systemAudioCapability,
  systemAudioTestLoading,
  systemAudioTestResult,
  meetingModelState,
  meetingModelError,
  meetingDownloadPercent,
  speakerModel,
  speakerModelState,
  speakerModelError,
  onRetrySpeakerModel,
  onTestSystemAudio,
  meetingAudioStorageMode,
  onMeetingAudioStorageModeChange,
  meetingRetentionPreset,
  onMeetingRetentionPresetChange,
  meetingRetentionCustomMonths,
  onMeetingRetentionCustomMonthsChange,
  meetingRetentionDeleteMode,
  onMeetingRetentionDeleteModeChange,
  onRefresh,
  saveError,
  saveErrorContext,
}: {
  loading: boolean;
  checkFailed: boolean;
  routeSummary: string;
  routeReady: boolean | null;
  routeError: string | null;
  verificationDetails: string[];
  /** The model Continue saves for meetings: the recommended one, or the reader's pick. */
  recommendedModel: {
    label: string;
    recommended: boolean;
    needsDownload: boolean;
    size: string | null;
    sameAsDictation: boolean;
  } | null;
  /** Which model meetings use, changeable here; null while it can't be read. */
  modelPicker: {
    value: string;
    options: { value: string; label: string }[];
    disabled: boolean;
    onChange(value: string): void;
  } | null;
  microphoneReady: boolean | undefined;
  microphoneChecking: boolean;
  onOpenMicrophoneSettings(): void;
  systemAudioCapability: SystemAudioCapability | null;
  systemAudioTestLoading: boolean;
  systemAudioTestResult: SystemAudioTestOutcome | null;
  meetingModelState: "idle" | "downloading" | "done" | "error";
  meetingModelError: string | null;
  meetingDownloadPercent: number | null;
  speakerModel: {
    /** "speaker model (33 MB)" (`speakerModelDownloadName`). */
    name: string;
    installed: boolean;
    separationOn: boolean;
    /** The meeting speech model downloads in the same click. */
    ridesWithSpeechModel: boolean;
  } | null;
  speakerModelState: "idle" | "downloading" | "done" | "error";
  speakerModelError: string | null;
  onRetrySpeakerModel(): void;
  onTestSystemAudio(): void;
  meetingAudioStorageMode: "always" | "transcript_only";
  onMeetingAudioStorageModeChange(value: "always" | "transcript_only"): void;
  meetingRetentionPreset: "1w" | "1m" | "2m" | "3m" | "custom" | "never";
  onMeetingRetentionPresetChange(value: "1w" | "1m" | "2m" | "3m" | "custom" | "never"): void;
  meetingRetentionCustomMonths: number;
  onMeetingRetentionCustomMonthsChange(value: number): void;
  meetingRetentionDeleteMode: "audio_only" | "audio_and_transcript";
  onMeetingRetentionDeleteModeChange(value: "audio_only" | "audio_and_transcript"): void;
  onRefresh(): void;
  saveError: string | null;
  saveErrorContext: MeetingSaveErrorContext;
}) {
  const systemAudioRouteAvailable =
    Boolean(systemAudioCapability) && systemAudioCapability?.backend !== "none";
  const systemAudioReady = systemAudioCapability?.ready === true;
  const meetingAudio = describeMeetingAudio(systemAudioCapability);
  const systemAudioTestFailed =
    !systemAudioReady && systemAudioTestResult?.outcome === "failed";

  // --- Speech model for meetings -------------------------------------------
  const modelChecking = loading && routeReady === null;
  const modelDownloading = meetingModelState === "downloading";
  const modelTone: "ready" | "not-yet" | "problem" = routeReady
    ? "ready"
    : checkFailed || meetingModelError || (!recommendedModel && routeReady === false)
      ? "problem"
      : "not-yet";
  const modelSentence = modelChecking
    ? "Checking…"
    : routeReady
      ? "Ready. Meetings are transcribed on this Mac."
      : checkFailed
        ? "Plainsong could not check this just now. Check again in a moment."
        : modelDownloading
          ? `Downloading the meeting model${
              meetingDownloadPercent === null ? "…" : `: ${Math.round(meetingDownloadPercent)}%`
            }`
          : !recommendedModel
            ? "No meeting model is available for this Mac yet. Dictation still works."
            : !recommendedModel.needsDownload
              ? recommendedModel.sameAsDictation
                ? `${
                    recommendedModel.recommended ? "The recommended model" : recommendedModel.label
                  } is already on this Mac. It is the one you dictate with, so meetings need no second download. Continue to use it for meetings.`
                : `${
                    recommendedModel.recommended ? "The recommended model" : recommendedModel.label
                  } is already on this Mac. Continue to use it for meetings.`
              : `Not downloaded yet. It is a one-time${
                  recommendedModel.size ? ` ${recommendedModel.size}` : ""
                } download, and after that meetings are transcribed on this Mac.`;

  // --- Speaker model -------------------------------------------------------
  const speakerTone: "ready" | "not-yet" | "problem" =
    speakerModelState === "error"
      ? "problem"
      : speakerModel?.installed && speakerModel.separationOn
        ? "ready"
        : "not-yet";
  const speakerSentence = !speakerModel
    ? null
    : !speakerModel.separationOn
      ? "Telling speakers apart is off, so meetings are saved without speaker labels. You can turn it on in Settings > Meetings."
      : speakerModelState === "downloading"
        ? "Downloading the speaker model…"
        : speakerModel.installed
          ? "Ready. The speaker model labels who said what, on this Mac."
          : speakerModelState === "error"
            ? "The speaker model didn't download. You can continue: meetings are saved without speaker labels until it's downloaded, and each of those meetings offers the download."
            : speakerModel.ridesWithSpeechModel
              ? `Not downloaded yet. The ${speakerModel.name} tells voices apart, so the transcript shows who said what. Download meeting models gets it with the speech model; nothing downloads until you choose that.`
              : `Not downloaded yet. The ${speakerModel.name} tells voices apart, so the transcript shows who said what. Nothing downloads until you choose Download speaker model.`;

  // --- Microphone ----------------------------------------------------------
  const microphoneTone: "ready" | "not-yet" | "problem" =
    microphoneReady === true ? "ready" : microphoneReady === false ? "problem" : "not-yet";

  // --- System audio --------------------------------------------------------
  const systemAudioTone: "ready" | "not-yet" | "problem" = systemAudioReady
    ? "ready"
    : systemAudioTestFailed
      ? "problem"
      : meetingAudio.tone;
  const systemAudioSentence =
    systemAudioCapability === null
      ? loading
        ? "Checking…"
        : "Not checked yet."
      : meetingAudio.sentence;

  // Everything the sidecar said, once each, for support.
  const details = Array.from(
    new Set(
      [
        `Meeting model: ${routeSummary}`,
        routeError,
        ...verificationDetails,
        systemAudioCapability?.actionableReason ?? null,
        systemAudioTestResult?.detail ?? null,
      ].filter((line): line is string => Boolean(line && line.trim())),
    ),
  );

  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        Plainsong can also record and transcribe your calls, on this Mac.{" "}
        {MEETING_AUDIO_EXPLAINER} This part is optional: you can skip it now and
        set it up later from More &gt; Setup in the sidebar.
      </p>

      <div className="space-y-2">
        <ul className="divide-y divide-border rounded-xl border border-border" aria-busy={loading}>
          <MeetingStatusRow
            label="Speech model for meetings"
            tone={modelTone}
            busy={modelChecking}
          >
            {modelPicker ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <label htmlFor="first-run-meeting-model" className="shrink-0 text-sm text-muted-foreground">
                  Meetings use
                </label>
                <select
                  id="first-run-meeting-model"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm"
                  value={modelPicker.value}
                  disabled={modelPicker.disabled}
                  onChange={(event) => modelPicker.onChange(event.target.value)}
                >
                  {modelPicker.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {modelSentence}
            </p>
            <ModelDownloadProgress name={recommendedModel?.label ?? "Meetings speech model"} active={modelDownloading} value={meetingDownloadPercent} className="h-1.5" />
            {meetingModelError ? (
              <p className="text-sm text-destructive" role="alert">
                The meeting model didn&apos;t download. {meetingModelError}
              </p>
            ) : null}
            {saveError && saveErrorContext === "meeting-route" ? (
              <p className="text-sm text-destructive" role="alert">
                Couldn&apos;t choose the meeting model: {saveError}. Try again;
                your other choices on this page are kept.
              </p>
            ) : null}
          </MeetingStatusRow>

          {speakerModel && speakerSentence ? (
            <MeetingStatusRow
              label="Telling speakers apart"
              tone={speakerTone}
              busy={speakerModelState === "downloading"}
            >
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {speakerSentence}
              </p>
              {speakerModelState === "error" && speakerModelError ? (
                <p className="text-sm text-destructive" role="alert">
                  {speakerModelError}
                </p>
              ) : null}
              {speakerModelState === "error" ? (
                <Button size="sm" variant="outline" onClick={onRetrySpeakerModel}>
                  Try the download again
                </Button>
              ) : null}
            </MeetingStatusRow>
          ) : null}

          <MeetingStatusRow
            label="Your voice"
            tone={microphoneTone}
            busy={microphoneChecking}
          >
            <p className="text-sm text-muted-foreground">
              {microphoneReady === true
                ? "Microphone access is on."
                : microphoneReady === false
                  ? "Microphone access is off, so meetings could not record you. Turn it on in System Settings."
                  : microphoneChecking
                    ? "Checking…"
                    : "Not checked yet."}
            </p>
            {microphoneReady === false ? (
              <Button size="sm" variant="outline" onClick={onOpenMicrophoneSettings}>
                Open System Settings
              </Button>
            ) : null}
          </MeetingStatusRow>

          <MeetingStatusRow
            label="Other people on the call"
            tone={systemAudioTone}
            busy={systemAudioTestLoading || (loading && systemAudioCapability === null)}
          >
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {systemAudioTestLoading
                ? "Checking the meeting audio. If macOS asks, choose Allow."
                : systemAudioTestFailed && meetingAudio.state !== "denied"
                  ? systemAudioTestResult?.message
                  : systemAudioSentence}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {meetingAudio.action !== "open_settings" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={systemAudioTestLoading || !systemAudioRouteAvailable}
                  onClick={onTestSystemAudio}
                >
                  {systemAudioTestLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {systemAudioTestLoading
                    ? "Checking…"
                    : systemAudioReady
                      ? "Check meeting audio again"
                      : meetingAudio.actionLabel ?? "Check meeting audio"}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void openPermissionSettings("system_audio")}
                  >
                    Open System Settings
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={onRefresh}>
                    Check again
                  </Button>
                </>
              )}
            </div>
            {systemAudioTestResult?.outcome === "passed" ? (
              <p className="text-sm text-gold-text" role="status">
                {systemAudioTestResult.message}
              </p>
            ) : null}
          </MeetingStatusRow>
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <details className="min-w-0 flex-1 text-sm">
            <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Details
            </summary>
            <div className="mt-2 space-y-1 rounded-lg bg-muted/20 p-3">
              <p className="text-sm text-muted-foreground">
                What Plainsong&apos;s own check reported, for troubleshooting.
              </p>
              {details.map((line) => (
                <p key={line} className="break-words font-mono text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          </details>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            Check again
          </Button>
        </div>
      </div>

      <section
        aria-labelledby="first-run-meeting-keeps"
        className="space-y-3 border-t border-border pt-5"
      >
        <div className="space-y-1">
          <p id="first-run-meeting-keeps" className="section-heading text-sm">
            What Plainsong keeps
          </p>
          {/* One sentence, because it is the one thing here the reader did not
              ask for: the app will notice a call and offer. It never records
              without a click. */}
          <p className="text-sm text-muted-foreground">
            These defaults are fine for most people, and you can change them
            later in Settings. Plainsong also notices when a Zoom, Teams, Meet,
            Webex, Slack, Discord or FaceTime call starts and offers to record
            it. It never starts on its own.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="first-run-meeting-audio-storage" className="text-sm text-muted-foreground">
              Meeting audio
            </label>
            <select
              id="first-run-meeting-audio-storage"
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
              value={meetingAudioStorageMode}
              onChange={(event) =>
                onMeetingAudioStorageModeChange(event.target.value as "always" | "transcript_only")
              }
            >
              <option value="always">Keep it with the transcript</option>
              <option value="transcript_only">Delete it once transcribed</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="first-run-meeting-retention" className="text-sm text-muted-foreground">
              Delete old meetings
            </label>
            <select
              id="first-run-meeting-retention"
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
              value={meetingRetentionPreset}
              onChange={(event) =>
                onMeetingRetentionPresetChange(
                  event.target.value as "1w" | "1m" | "2m" | "3m" | "custom" | "never"
                )
              }
            >
              <option value="never">Never</option>
              <option value="1w">After 1 week</option>
              <option value="1m">After 1 month</option>
              <option value="2m">After 2 months</option>
              <option value="3m">After 3 months</option>
              <option value="custom">After a number of months you choose</option>
            </select>
          </div>

          {meetingRetentionPreset === "custom" ? (
            <div className="space-y-1.5">
              <label
                htmlFor="first-run-custom-retention-months"
                className="text-sm text-muted-foreground"
              >
                Months to keep
              </label>
              <Input
                id="first-run-custom-retention-months"
                type="number"
                min={1}
                value={meetingRetentionCustomMonths}
                onChange={(event) =>
                  onMeetingRetentionCustomMonthsChange(Math.max(1, Number(event.target.value) || 1))
                }
              />
            </div>
          ) : null}

          {meetingRetentionPreset === "never" ? null : (
            <div className="space-y-1.5">
              <label
                htmlFor="first-run-retention-delete-mode"
                className="text-sm text-muted-foreground"
              >
                What gets deleted
              </label>
              <select
                id="first-run-retention-delete-mode"
                className="w-full rounded-md border border-border bg-background p-2 text-sm"
                value={meetingRetentionDeleteMode}
                onChange={(event) =>
                  onMeetingRetentionDeleteModeChange(
                    event.target.value as "audio_only" | "audio_and_transcript"
                  )
                }
              >
                <option value="audio_only">The audio only</option>
                <option value="audio_and_transcript">The audio and the transcript</option>
              </select>
            </div>
          )}
        </div>

        {saveError && saveErrorContext === "meeting-settings" ? (
          <p className="text-sm text-destructive" role="alert">
            Meeting storage and retention weren&apos;t saved: {saveError}. Your
            choices are still here; try again.
          </p>
        ) : null}
      </section>
    </div>
  );
}
