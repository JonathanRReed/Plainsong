import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bell,
  Brain,
  CalendarDays,
  CheckCircle2,
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
  getAsrProviders,
} from "@/lib/backend/asr";
import { listen } from "@/lib/electron";
import {
  getDictationShortcutCapabilityStatus,
  getPermissionDiagnostics,
  getSettings,
  openInstalledPlainsongApp,
  openPermissionSettings,
  recordOnboardingState,
  requestDictationPermissions,
  saveSettings,
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
} from "@/lib/asr-route-catalog";
import { formatModelSize, getAsrModelCapability } from "@/lib/asr-capabilities";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import { type OnboardingMode } from "@/lib/onboarding";
import { readAiNotesOptOut, writeAiNotesOptOut } from "@/lib/ai-notes-preference";
import { getOllamaStatus } from "@/lib/backend/ai";
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
type AiNotesChoice = "ollama" | "byok" | "none";

type ScratchDictationState =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "complete"
  | "error";

// Ordered so the recommended default (Parakeet TDT 0.6B v3 -- see
// settings.rs's default_provider/default_model_id) is first and
// pre-selected. Whisper base.en mis-transcribes words it hasn't seen before
// -- including "Plainsong" itself, per this repo's own benchmark -- so it is
// offered as the small-download alternative, not the default. Model weights
// are downloaded on demand; none ship inside the app bundle.
//
// A first run reads `title` and `desc`, which say what the choice means for
// the reader. The model's own name (`label`) and download size are the small
// print under them. Sizes come from the capability table through
// `formatModelSize`, so every row uses the same unit as the rest of the app.
const POWER_MODEL_OPTIONS: Array<{
  id: string;
  providerType: AsrProviderType;
  label: string;
  title: string;
  desc: string;
  recommended?: boolean;
}> = [
  {
    id: "parakeet-tdt-0.6b-v3",
    providerType: "parakeet",
    label: "Parakeet TDT 0.6B v3",
    title: "Fast and accurate",
    desc: "Runs on this Mac and handles meetings too. The right choice for most people.",
    recommended: true,
  },
  {
    id: "base.en",
    providerType: "whisper",
    label: "Whisper base.en",
    title: "Smallest download",
    desc: "English only, and more likely to miss names and unusual words.",
  },
  {
    id: "distil-large-v3.5",
    providerType: "distil_whisper",
    label: "Distil Whisper",
    title: "Extra accuracy for long dictation",
    desc: "A much larger download that takes longer to set up.",
  },
  {
    id: "moonshine-base",
    providerType: "moonshine",
    label: "Moonshine Base",
    title: "Easy on older Macs",
    desc: "A light model for slower machines, at some cost to accuracy.",
  },
];

/** The option for a model id, or the recommended default for an unknown one. */
function powerModelOption(modelId: string | undefined): (typeof POWER_MODEL_OPTIONS)[number] {
  return POWER_MODEL_OPTIONS.find((candidate) => candidate.id === modelId) ?? POWER_MODEL_OPTIONS[0];
}

function powerModelSize(option: (typeof POWER_MODEL_OPTIONS)[number]): string {
  return formatModelSize(
    getAsrModelCapability(option.providerType, option.id)?.sizeMib ?? 0,
  );
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
  "dictation-model": "Dictation model",
  hotkey: "Hotkey",
  "meeting-setup": "Meeting setup",
  "ai-notes": "Meeting notes",
};

type HotkeyMode = "hold_to_talk" | "toggle" | "hands_free";

// The same three behaviors Settings > Dictation offers (see
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

function summarizeMeetingRoute(provider: AsrProviderType | null, modelId: string | null, providers: AsrProviderInfo[]) {
  if (!provider) {
    return "No meeting transcription route selected";
  }
  const providerInfo = providers.find((item) => item.providerType === provider);
  const providerLabel = providerInfo?.name ?? provider;
  if (!modelId) {
    return providerLabel;
  }
  const modelLabel =
    providerInfo?.modelOptions.find((option) => option.id === modelId)?.label ?? modelId;
  return `${providerLabel} · ${modelLabel}`;
}

function isMeetingRouteReady(
  providerType: AsrProviderType | null,
  modelId: string | null,
  providers: AsrProviderInfo[]
) {
  if (!providerType || !modelId) {
    return false;
  }
  return buildAsrRouteCatalog(providers, "prefer_local").some(
    (route) =>
      route.providerType === providerType &&
      route.modelId === modelId &&
      route.laneCompatibility.meeting &&
      route.readiness === "ready"
  );
}

function getRecommendedMeetingRoute(providers: AsrProviderInfo[]) {
  const recommended = getRecommendedLaneRoute(
    buildAsrRouteCatalog(providers, "prefer_local"),
    "meeting",
    "prefer_local",
  );
  if (!recommended) {
    return null;
  }
  return {
    providerType: recommended.providerType,
    modelId: recommended.modelId,
  };
}

export function FirstRunWizard({ mode = "full", onComplete }: Props) {
  const [step, setStep] = useState<Step>(
    mode === "full"
      ? "dictation-model"
      : mode === "meetings"
        ? "meeting-setup"
        : "permissions"
  );

  // This wizard is a real modal: give it dialog semantics and trap focus
  // inside it so keyboard users can't Tab into the obscured app behind it.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const stepBodyRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

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

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const firstFocusable = node?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    (firstFocusable ?? node)?.focus();

    return () => {
      previouslyFocused?.focus();
    };
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
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
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
  // Start on the fresh-install default, then keep model actions gated until
  // persisted settings have had a chance to restore an existing selection.
  const [selectedModelId, setSelectedModelId] = useState("parakeet-tdt-0.6b-v3");
  const selectedModelOption = powerModelOption(selectedModelId);
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
  // Hold-to-talk needs the native key helper to see the key go up. null is
  // "not checked", which never hides the option.
  const [holdToTalkAvailable, setHoldToTalkAvailable] = useState<boolean | null>(null);
  // The microphone the reader was heard on, from the microphone step; cleared
  // when that step starts over on another microphone.
  const [micHeard, setMicHeard] = useState<{ deviceName: string | null } | null>(null);
  const [scratchState, setScratchState] =
    useState<ScratchDictationState>("idle");
  const [scratchText, setScratchText] = useState("");
  const [scratchError, setScratchError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorContext, setSaveErrorContext] = useState<
    "hotkey" | "meeting-route" | "meeting-settings" | "ai-notes" | null
  >(null);

  // Meeting notes: which route writes them, and whether the local one answers.
  const [aiNotesChoice, setAiNotesChoice] = useState<AiNotesChoice>("ollama");
  const [aiNotesProvider, setAiNotesProvider] = useState<string>("ollama");
  const [localAiReady, setLocalAiReady] = useState<boolean | null>(null);
  const [localAiChecking, setLocalAiChecking] = useState(false);

  const [meetingAudioStorageMode, setMeetingAudioStorageMode] = useState<"always" | "transcript_only">("always");
  const [meetingRetentionPreset, setMeetingRetentionPreset] = useState<"1m" | "2m" | "3m" | "custom" | "never">("never");
  const [meetingRetentionCustomMonths, setMeetingRetentionCustomMonths] = useState(1);
  const [meetingRetentionDeleteMode, setMeetingRetentionDeleteMode] = useState<"audio_only" | "audio_and_transcript">("audio_only");
  const [meetingSetupLoading, setMeetingSetupLoading] = useState(false);
  const [meetingRouteSummary, setMeetingRouteSummary] = useState("Checking meeting route…");
  const [meetingRouteReady, setMeetingRouteReady] = useState<boolean | null>(null);
  const [meetingRouteError, setMeetingRouteError] = useState<string | null>(null);
  const [meetingSystemAudioCapability, setMeetingSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const [systemAudioTestLoading, setSystemAudioTestLoading] = useState(false);
  const [systemAudioTestStatus, setSystemAudioTestStatus] = useState<string | null>(null);
  const [meetingVerificationDetails, setMeetingVerificationDetails] = useState<string[]>([]);
  const [meetingRecommendedRoute, setMeetingRecommendedRoute] = useState<{
    providerType: AsrProviderType;
    modelId: string;
  } | null>(null);

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
  useEffect(() => {
    if (stepBodyRef.current) {
      stepBodyRef.current.scrollTop = 0;
    }
    const frame = requestAnimationFrame(() => {
      stepHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      getSettings(),
      getAsrProviders().catch(() => null),
    ])
      .then(([settings, providers]) => {
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
          settings.transcription.meetingRetentionPreset === "1m" ||
            settings.transcription.meetingRetentionPreset === "2m" ||
            settings.transcription.meetingRetentionPreset === "3m" ||
            settings.transcription.meetingRetentionPreset === "custom"
            ? settings.transcription.meetingRetentionPreset
            : "never"
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
            : isRemoteAnalysisProvider(configuredNotesProvider)
              ? "byok"
              : "ollama",
        );
        initialDictationProviderRef.current = settings.transcription.dictationProvider ?? null;
        initialDictationModelIdRef.current =
          settings.transcription.dictationModelId ??
          settings.transcription.selectedModelId ??
          null;
        if (settings.transcription.dictationProvider === "moonshine") {
          setSelectedModelId("moonshine-base");
        } else if (settings.transcription.dictationProvider === "parakeet") {
          setSelectedModelId("parakeet-tdt-0.6b-v3");
        } else if (settings.transcription.dictationProvider === "distil_whisper") {
          setSelectedModelId("distil-large-v3.5");
        } else {
          // Whisper and any unrecognized or legacy value fall back to the fast
          // local default, which is the only Whisper option this step offers.
          setSelectedModelId("base.en");
        }
        const configuredProvider = (
          settings.transcription.dictationProvider ??
          settings.transcription.defaultProvider
        ) as AsrProviderType | undefined;
        const configuredModelId =
          settings.transcription.dictationModelId ??
          settings.transcription.selectedModelId ??
          null;
        const isWizardModel = POWER_MODEL_OPTIONS.some(
          (option) =>
            option.providerType === configuredProvider &&
            option.id === configuredModelId
        );
        const configuredProviderInfo = providers?.find(
          (provider) =>
            provider.providerType === configuredProvider &&
            provider.selectedModelId === configuredModelId
        );
        if (
          !modelInteractionStartedRef.current &&
          isWizardModel &&
          configuredProviderInfo?.runtimeStatus === "ready" &&
          normalizeDownloadStatus(configuredProviderInfo.downloadStatus).kind ===
            "downloaded"
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
  }, []);

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
    step === "permissions" || step === "try-dictation" || step === "use-everywhere";

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
      const [settings, providers, systemAudioCapability, verification] = await Promise.all([
        getSettings(),
        getAsrProviders(),
        getSystemAudioCapability().catch(() => null),
        verifyMeetingSetup().catch(() => null as SetupVerificationResult | null),
      ]);

      const currentProvider = (settings.transcription.meetingProvider as AsrProviderType | undefined) ?? null;
      const currentModelId = settings.transcription.meetingModelId ?? null;
      const routeReady = isMeetingRouteReady(
        currentProvider,
        currentModelId,
        providers
      );

      setMeetingRouteSummary(summarizeMeetingRoute(currentProvider, currentModelId, providers));
      setMeetingRouteReady(routeReady);
      setMeetingVerificationDetails(verification?.details ?? []);
      setMeetingRouteError(
        routeReady
          ? null
          : verification?.summary ??
              "Meetings need a meeting transcription model. Download it below, or choose one later in Models."
      );
      setMeetingSystemAudioCapability(systemAudioCapability);
      setMeetingRecommendedRoute(getRecommendedMeetingRoute(providers));
      return {
        routeReady,
        systemAudioAvailable: systemAudioCapability?.backend !== "none",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMeetingRouteSummary("Meeting setup check failed");
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
    setSystemAudioTestStatus(
      "Waiting for macOS and checking the current system-audio signal…"
    );
    try {
      const result = await testSystemAudioCapture();
      setMeetingSystemAudioCapability(result.capability);
      if (result.capability.ready) {
        setSystemAudioTestStatus(
          result.verificationMethod === "external_audio"
            ? `Verified non-silent system audio via ${result.capability.routeDevice ?? "the current external-audio route"}.`
            : `Verified ${Math.round(result.expectedToneHz)} Hz system audio via ${result.capability.routeDevice ?? "the current route"}.`
        );
      } else {
        setSystemAudioTestStatus(
          result.capability.actionableReason ??
            "System audio could not be verified. Check the current route and macOS privacy settings."
        );
      }
      if (result.capability.ready) {
        await refreshMeetingSetup();
      }
    } catch (error) {
      setSystemAudioTestStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSystemAudioTestLoading(false);
    }
  }, [refreshMeetingSetup]);

  useEffect(() => {
    if (step === "meeting-setup") {
      void refreshMeetingSetup();
    }
  }, [refreshMeetingSetup, step]);

  const requestPermissionsNow = useCallback(async () => {
    setPermissionRequestBusy(true);
    setPermissionRequestError(null);
    setPermissionRequestStatus(null);
    try {
      const diagnostics = await requestDictationPermissions();
      setPerms(diagnostics);
      setPermissionRequestStatus("Asked macOS for permission and checked again.");
    } catch (error) {
      setPermissionRequestError(error instanceof Error ? error.message : String(error));
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
        setPermissionRequestError(error instanceof Error ? error.message : String(error));
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
      setPermissionRequestError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const startScratchDictation = useCallback(async () => {
    setScratchState("starting");
    setScratchText("");
    setScratchError(null);
    try {
      await startDictation({
        saveToInbox: true,
        projectId: "inbox",
        profile: "normal_speed",
        contextSource: "none",
        livePreviewEnabled: true,
        deliveryMode: "preview",
      });
      if (mountedRef.current) {
        setScratchState("listening");
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setScratchState("error");
      setScratchError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const finishScratchDictation = useCallback(async () => {
    setScratchState("transcribing");
    setScratchError(null);
    try {
      const text = (await stopDictation()).trim();
      if (!mountedRef.current) {
        return;
      }
      setScratchText(text);
      setScratchState("complete");
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setScratchState("error");
      setScratchError(error instanceof Error ? error.message : String(error));
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

  const startModelDownload = useCallback(async (modelId?: string) => {
    if (modelSelectionHydration !== "ready") {
      return false;
    }
    const option = powerModelOption(modelId);
    modelInteractionStartedRef.current = true;
    setModelSkipped(false);
    setModelState("downloading");
    setModelError(null);
    setDownloadPercent(0);
    downloadingProviderTypeRef.current = option.providerType;
    try {
      await downloadAsrModels(option.providerType, option.id);
      // Read settings *after* the download, never before it. save_settings is
      // a whole-struct replace, so a snapshot taken before a multi-minute
      // fetch would roll back everything written while it ran -- the hotkey
      // this wizard just taught the user, the auto-request-permissions
      // toggle, the meeting storage/retention answers, the repaired meeting
      // route. Only the ASR fields this step actually owns are mutated on the
      // fresh copy. It saves even if the wizard has closed meanwhile: Ready
      // lets the reader finish while this runs, and the finished model is
      // only any use once it is the dictation route.
      const settings = await getSettings();
      settings.transcription.useSharedAsrSelection = false;
      settings.transcription.defaultProvider = option.providerType;
      settings.transcription.selectedModelId = option.id;
      settings.transcription.dictationProvider = option.providerType;
      settings.transcription.dictationModelId = option.id;
      await saveSettings(settings);
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
      setModelError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      downloadingProviderTypeRef.current = null;
    }
  }, [modelSelectionHydration]);

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
    const hasExistingNonDefaultRoute =
      Boolean(existingProvider) &&
      existingProvider !== "parakeet" &&
      (existingProvider !== "whisper" || hasCustomWhisperModel);
    if (hasExistingNonDefaultRoute && !modelSelectionChangedRef.current) {
      return;
    }
    if (modelState === "idle" || modelState === "error") {
      // Already corrected to match the actual configured/default provider
      // by the settings-load effect above -- parakeet-tdt-0.6b-v3 for a
      // fresh install, base.en for a pre-upgrade whisper install -- so this
      // downloads whichever default route the user is really on instead of
      // assuming parakeet unconditionally.
      void startModelDownload(selectedModelId);
    }
  }, [modelState, selectedModelId, startModelDownload]);

  const persistDictationStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      const settings = await getSettings();
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
      }
      await saveSettings(settings);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveErrorContext("hotkey");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [autoRequestPermissions, hotkeyMode, shortcutValue, tapToLock]);

  const applyRecommendedMeetingRoute = useCallback(async () => {
    if (!meetingRecommendedRoute) {
      return false;
    }
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      const settings = await getSettings();
      settings.transcription.useSharedAsrSelection = false;
      settings.transcription.meetingProvider = meetingRecommendedRoute.providerType;
      settings.transcription.meetingModelId = meetingRecommendedRoute.modelId;
      if (!settings.transcription.dictationProvider) {
        settings.transcription.dictationProvider = settings.transcription.defaultProvider;
      }
      if (!settings.transcription.dictationModelId) {
        settings.transcription.dictationModelId = settings.transcription.selectedModelId;
      }
      await saveSettings(settings);
      await refreshMeetingSetup();
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveErrorContext("meeting-route");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [meetingRecommendedRoute, refreshMeetingSetup]);

  const startMeetingModelDownload = useCallback(async () => {
    const route = meetingRecommendedRoute;
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
          "The recommended meeting route could not be saved. Retry after resolving the settings error above."
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
          "The download finished, but the meeting route is still not ready. Re-check the route or choose another model in Settings."
        );
      }

      setMeetingModelState("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) {
        return false;
      }
      setMeetingModelState("error");
      setMeetingModelError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      meetingDownloadingProviderTypeRef.current = null;
    }
  }, [applyRecommendedMeetingRoute, meetingRecommendedRoute, refreshMeetingSetup]);

  /**
   * Ask whether the local analysis runtime is actually answering. A probe that
   * throws leaves this `null` — unknown — because "Ollama is missing" and "we
   * could not ask" are different claims and only one of them is actionable.
   */
  const checkLocalAiRuntime = useCallback(async () => {
    setLocalAiChecking(true);
    try {
      const ready = await getOllamaStatus();
      if (mountedRef.current) {
        setLocalAiReady(typeof ready === "boolean" ? ready : null);
      }
    } catch {
      if (mountedRef.current) {
        setLocalAiReady(null);
      }
    } finally {
      if (mountedRef.current) {
        setLocalAiChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    if (step === "ai-notes") {
      void checkLocalAiRuntime();
    }
  }, [checkLocalAiRuntime, step]);

  const persistAiNotesStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    setSaveErrorContext(null);
    try {
      if (aiNotesChoice === "ollama" || aiNotesChoice === "none") {
        const settings = await getSettings();
        if (aiNotesChoice === "none") {
          // These Rust-backed settings are the authoritative gates used by
          // post-transcription processing. The renderer-only preference below
          // cannot prevent either transcript analysis or title generation.
          settings.transcription.enableAutoAnalysis = false;
          settings.transcription.meetingAutoNameEnabled = false;
          await saveSettings(settings);
        } else if (settings.privacy.meetingsAi.provider !== "ollama") {
          // A provider change invalidates the model id with it: a model name
          // from OpenAI means nothing to Ollama, and null asks for the
          // provider's own default rather than a name that cannot resolve.
          settings.privacy.meetingsAi = { provider: "ollama", modelId: null };
          await saveSettings(settings);
        }
      }
      // Written last so a failed settings save cannot leave the app believing
      // notes were declined when they were not.
      writeAiNotesOptOut(aiNotesChoice === "none");
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
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
      const settings = await getSettings();
      settings.transcription.meetingAudioStorageMode = meetingAudioStorageMode;
      settings.transcription.meetingRetentionPreset = meetingRetentionPreset;
      settings.transcription.meetingRetentionCustomMonths = Math.max(1, meetingRetentionCustomMonths);
      settings.transcription.meetingRetentionDeleteMode = meetingRetentionDeleteMode;
      await saveSettings(settings);
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
      setSaveError(error instanceof Error ? error.message : String(error));
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
        const downloaded = await startModelDownload(selectedModelId);
        if (!downloaded) {
          return;
        }
      } else if (mode !== "full") {
        ensureDefaultModelDownloading();
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
        meetingsCompleted: mode === "full",
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
      if (meetingRouteReady === false) {
        const fixed = await startMeetingModelDownload();
        if (!fixed) {
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
      setStep(steps[nextIndex]);
      return;
    }

    completeWizard({
      markOnboardingComplete: mode === "full",
      meetingsCompleted: step === "meeting-setup" || mode === "meetings",
    });
  };

  const skipModelDownload = () => {
    setModelSkipped(true);
    const nextIndex = steps.indexOf(step) + 1;
    if (nextIndex < steps.length) {
      setStep(steps[nextIndex]);
    }
  };

  const subtitle = `Step ${stepIndex + 1} of ${steps.length}`;

  const nextLabel =
    step === "dictation-model" && mode === "full" && modelState !== "done"
      ? modelState === "error"
        ? "Retry download"
        : modelState === "downloading"
          ? "Downloading…"
          : "Download and continue"
      : step === "ready"
        ? "Start using Plainsong"
        : step === "meeting-setup" && meetingRouteReady === false
          ? meetingModelState === "error"
            ? "Retry meeting model download"
            : meetingModelState === "downloading"
              ? "Downloading meeting model…"
              : "Download meeting model"
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
      tapToLock={tapToLock}
      onTapToLockChange={setTapToLock}
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
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
              {mode === "meetings" ? "MEETINGS" : mode === "dictation" ? "DICTATION" : "ONBOARDING"}
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
                modelSize={powerModelSize(selectedModelOption)}
                onDownloadModel={() => void startModelDownload(selectedModelId)}
                scratchState={scratchState}
                scratchText={scratchText}
                scratchError={scratchError}
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
                saveError={saveError}
              />
            ) : null}

            {step === "ready" ? (
              <ReadyStep
                shortcutValue={shortcutValue}
                displayShortcut={displayShortcut}
                tapToLock={tapToLock}
                micHeardOn={micHeard}
                aiNotesChoice={aiNotesChoice}
                hotkeyMode={hotkeyMode}
                modelState={modelState}
                modelError={modelError}
                modelSkipped={modelSkipped}
                onRetryModel={() => void startModelDownload(selectedModelId)}
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
                  state={modelState}
                  error={modelError}
                  percent={downloadPercent}
                  selectedId={selectedModelId}
                  downloadFromFooter={mode === "full"}
                  downloadDisabled={modelSelectionHydration !== "ready"}
                  onSelect={(modelId) => {
                    modelSelectionChangedRef.current = true;
                    setSelectedModelId(modelId);
                  }}
                  onDownload={() => void startModelDownload(selectedModelId)}
                />
                {modelSelectionHydration === "error" ? (
                  <p
                    role="alert"
                    aria-label="Model setup unavailable"
                    className="text-sm text-destructive"
                  >
                    Model setup could not be loaded. Reopen onboarding and try again.
                  </p>
                ) : null}
              </>
            ) : null}

            {step === "hotkey" ? (
              <HotkeyStep
                displayShortcut={displayShortcut}
                onShortcutChange={setShortcutValue}
                modeChoice={hotkeyModeChoice}
                saveError={saveError}
              />
            ) : null}

            {step === "meeting-setup" ? (
              <MeetingSetupStep
                loading={meetingSetupLoading}
                routeSummary={meetingRouteSummary}
                routeReady={meetingRouteReady}
                routeError={meetingRouteError}
                verificationDetails={meetingVerificationDetails}
                systemAudioCapability={meetingSystemAudioCapability}
                systemAudioTestLoading={systemAudioTestLoading}
                systemAudioTestStatus={systemAudioTestStatus}
                meetingModelState={meetingModelState}
                meetingModelError={meetingModelError}
                meetingDownloadPercent={meetingDownloadPercent}
                onTestSystemAudio={() => void testMeetingSystemAudio()}
                meetingAudioStorageMode={meetingAudioStorageMode}
                onMeetingAudioStorageModeChange={setMeetingAudioStorageMode}
                meetingRetentionPreset={meetingRetentionPreset}
                onMeetingRetentionPresetChange={setMeetingRetentionPreset}
                meetingRetentionCustomMonths={meetingRetentionCustomMonths}
                onMeetingRetentionCustomMonthsChange={setMeetingRetentionCustomMonths}
                meetingRetentionDeleteMode={meetingRetentionDeleteMode}
                onMeetingRetentionDeleteModeChange={setMeetingRetentionDeleteMode}
                onRefresh={() => void refreshMeetingSetup()}
                onApplyRecommendedRoute={
                  meetingRecommendedRoute ? () => void applyRecommendedMeetingRoute() : undefined
                }
                recommendedRouteSummary={
                  meetingRecommendedRoute
                    ? summarizeMeetingRoute(
                        meetingRecommendedRoute.providerType,
                        meetingRecommendedRoute.modelId,
                        []
                      )
                    : null
                }
                saveError={saveError}
                saveErrorContext={saveErrorContext}
              />
            ) : null}

            {step === "ai-notes" ? (
              <AiNotesStep
                choice={aiNotesChoice}
                onChoiceChange={setAiNotesChoice}
                configuredProvider={aiNotesProvider}
                localAiReady={localAiReady}
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
              // The last step has nothing left to skip.
              step === "ready" ? null : step === "dictation-model" &&
                modelState !== "done" ? (
                <Button
                  variant="ghost"
                  onClick={skipModelDownload}
                  className="text-muted-foreground"
                  disabled={modelState === "downloading"}
                >
                  Skip model download
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() =>
                    // Not a completion. Recorded as a deferral against exactly
                    // what is unmet right now, so this stays quiet until
                    // something else breaks -- and Settings > General > Setup
                    // still reopens it on demand.
                    completeWizard({
                      markOnboardingComplete: false,
                      meetingsCompleted: false,
                      deferred: true,
                    })
                  }
                  className="text-muted-foreground"
                  disabled={
                    scratchBusy ||
                    (step === "meeting-setup" && meetingModelState === "downloading")
                  }
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
                onClick={() => completeWizard({ markOnboardingComplete: true, meetingsCompleted: false })}
                disabled={meetingModelState === "downloading"}
              >
                Finish with dictation only
              </Button>
            ) : null}
          </div>
          <Button
            onClick={() => void nextStep()}
            disabled={
              saveBusy ||
              permissionRequestBusy ||
              scratchBusy ||
              (step === "dictation-model" && modelSelectionHydration !== "ready") ||
              (step === "meeting-setup" && meetingModelState === "downloading") ||
              // Only block Continue for a download in progress while the
              // user is still on a model surface they have to wait on. Ready
              // never blocks: it is the last step and has no Skip, so a slow
              // or failed download would otherwise hold the reader in the
              // modal. The download carries on, and Dictation retries it.
              (modelState === "downloading" &&
                (step === "dictation-model" || step === "try-dictation")) ||
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
  modelState,
  modelError,
  modelPercent,
  modelSize,
  onDownloadModel,
  scratchState,
  scratchText,
  scratchError,
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
  modelState: "idle" | "downloading" | "done" | "error";
  modelError: string | null;
  modelPercent: number | null;
  modelSize: string;
  onDownloadModel(): void;
  scratchState: ScratchDictationState;
  scratchText: string;
  scratchError: string | null;
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
                    The test needs your speech model first: a {modelSize}{" "}
                    download that runs on this Mac.
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

      {modelState === "downloading" ? (
        <Progress value={modelPercent} className="h-1.5" />
      ) : null}
      {modelError ? (
        <p className="text-xs text-destructive" role="alert">
          Model download failed: {modelError}
        </p>
      ) : null}
      {permissionRequestStatus || permissionRequestError ? (
        <p
          className={`text-xs ${permissionRequestError ? "text-destructive" : "text-muted-foreground"}`}
          role={permissionRequestError ? "alert" : "status"}
        >
          {permissionRequestError ?? permissionRequestStatus}
        </p>
      ) : null}

      <div
        className={`rounded-xl border p-6 transition-colors motion-reduce:transition-none ${
          scratchState === "complete" && scratchText
            ? "border-gold/40 bg-gold/5"
            : "border-primary/30 bg-primary/5"
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
                    ? "That worked"
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
                  <p className="mt-2 text-xs text-muted-foreground">
                    {wordCount === 1 ? "1 word" : `${wordCount} words`}, written
                    on this Mac. Soon you will do this in any app with{" "}
                    {displayShortcut}.
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
                variant={scratchState === "complete" && scratchText ? "outline" : "default"}
                onClick={onStartScratch}
                disabled={scratchInFlight || modelState !== "done"}
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
          <p className="mt-4 text-center text-sm text-destructive" role="alert">
            {scratchError}
          </p>
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
  tapToLock,
  onTapToLockChange,
}: {
  mode: HotkeyMode;
  onModeChange(mode: HotkeyMode): void;
  offerHandsFree: boolean;
  holdToTalkAvailable: boolean | null;
  tapToLock: boolean;
  onTapToLockChange(next: boolean): void;
}) {
  const options: HotkeyMode[] = offerHandsFree
    ? ["hold_to_talk", "toggle", "hands_free"]
    : ["hold_to_talk", "toggle"];
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id="first-run-hotkey-mode-label">
        How the shortcut works
      </p>
      <div
        role="radiogroup"
        aria-labelledby="first-run-hotkey-mode-label"
        className={`grid gap-2 ${options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={mode === option}
            onClick={() => onModeChange(option)}
            className={`rounded-lg border-2 p-3 text-left transition-colors motion-reduce:transition-none ${
              mode === option
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <p className="text-sm font-medium">{HOTKEY_MODE_LABELS[option].name}</p>
            <p className="text-xs text-muted-foreground">{HOTKEY_MODE_LABELS[option].hint}</p>
          </button>
        ))}
      </div>
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
              <span className="block text-xs text-muted-foreground">
                A quick tap keeps listening without holding the key. Tap again to
                finish.
              </span>
            </span>
          </label>
          {holdToTalkAvailable === false ? (
            <p className="text-xs text-rust">
              Hold to talk is not available on this Mac right now, so the
              shortcut works as press to toggle until it is.
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
  onShortcutChange,
}: {
  inputId: string;
  displayShortcut: string;
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
      <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
        To change it, click the field and press the keys you want, with at
        least one of Command, Control, Option or Shift.
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
  onShortcutChange,
  modeChoice,
  saveError,
}: {
  perms: PermissionDiagnostics | null;
  permsLoading: boolean;
  onRefreshPermissions(): void;
  onOpenAccessibilitySettings(): void;
  displayShortcut: string;
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
          inputId="first-run-everywhere-shortcut"
          displayShortcut={displayShortcut}
          onShortcutChange={onShortcutChange}
        />
        {modeChoice}
      </div>

      {saveError ? (
        <p className="text-xs text-destructive" role="alert">
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
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          aria-hidden="true"
          className="min-w-9 rounded-md border border-gold/40 bg-gold/10 px-2.5 py-1.5 text-center font-mono text-base font-medium text-gold-text shadow-sm"
        >
          {formatShortcutForDisplay(key)}
        </kbd>
      ))}
    </span>
  );
}

function ReadyStep({
  shortcutValue,
  displayShortcut,
  hotkeyMode,
  tapToLock,
  micHeardOn,
  aiNotesChoice,
  modelState,
  modelError,
  modelSkipped,
  onRetryModel,
  microphoneReady,
  insertionReady,
  scratchCompleted,
  meetingReady,
  fullMeetingCaptureReady,
}: {
  shortcutValue: string;
  displayShortcut: string;
  hotkeyMode: HotkeyMode;
  tapToLock: boolean;
  micHeardOn: { deviceName: string | null } | null;
  aiNotesChoice: AiNotesChoice;
  modelState: "idle" | "downloading" | "done" | "error";
  modelError: string | null;
  modelSkipped: boolean;
  onRetryModel(): void;
  microphoneReady: boolean | undefined;
  insertionReady: boolean;
  scratchCompleted: boolean;
  meetingReady: boolean;
  fullMeetingCaptureReady: boolean;
}) {
  const localDictation =
    scratchCompleted
      ? {
          detail: "Ready, and your test dictation worked.",
          tone: "ready" as const,
        }
      : modelState === "downloading"
        ? {
            detail: "Still downloading. You can finish setup; dictation works once it is done.",
            tone: "progress" as const,
          }
        : modelState === "error"
          ? {
              detail: modelSkipped
                ? "The download was skipped after it failed. Download the model here or from Dictation before using the shortcut."
                : modelError
                  ? `Model download failed: ${modelError.replace(/\.$/, "")}. Try again here or later from Dictation.`
                  : "The model download needs another try, here or later from Dictation.",
              tone: "attention" as const,
            }
          : modelState === "done"
            ? {
                detail: "Ready, and it runs on this Mac.",
                tone: "ready" as const,
              }
            : {
                detail: modelSkipped
                  ? "The model download was skipped. Download it here or from Dictation before using the shortcut."
                  : "The model has not been downloaded yet. Download it here or later from Dictation.",
                tone: "attention" as const,
              };
  const modeSummary =
    hotkeyMode === "hold_to_talk" && tapToLock
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
        : "Turn on Accessibility first. Until then your words are copied for you to paste.",
      tone: insertionReady ? ("ready" as const) : ("attention" as const),
    },
    {
      label: "Meetings",
      detail: fullMeetingCaptureReady
        ? "Records both you and the other people on the call."
        : meetingReady
          ? "Records your microphone. Check system audio later in Setup to capture the other side."
          : "Needs the meeting model. You can download it later in Setup.",
      tone: meetingReady ? ("ready" as const) : ("attention" as const),
    },
    {
      label: "Meeting notes",
      detail:
        aiNotesChoice === "none"
          ? "Off. Meetings get transcripts only."
          : aiNotesChoice === "byok"
            ? "Written by the cloud provider you set up in AI & Keys."
            : "Written on this Mac with Ollama, when it is running.",
      tone: "neutral" as const,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gold/30 bg-gold/5 p-5 text-center">
        <p className="text-sm text-muted-foreground">
          Put the cursor in any text field and press
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
            <div>
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.detail}</p>
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
            ? "Retry local model download"
            : "Download local model"}
        </Button>
      ) : null}

      <div className="flex items-start gap-3 border-t border-border pt-5">
        <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Both ways of working stay local by default</p>
          <p className="text-xs text-muted-foreground">
            Dictation and meeting audio stay on this Mac unless you turn on a
            cloud provider. Every dictation is also saved in History, so nothing
            is lost if an app refuses the paste.
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
            className={
              ready === true
                ? "text-sm text-gold-text"
                : gate.observable && ready === false && !gate.optional
                  ? "text-sm text-rust"
                  : "text-sm text-muted-foreground"
            }
          >
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

function DictationModelStep({
  state,
  error,
  percent,
  selectedId,
  downloadFromFooter,
  downloadDisabled,
  onSelect,
  onDownload,
}: {
  state: "idle" | "downloading" | "done" | "error";
  error: string | null;
  percent: number | null;
  selectedId: string;
  downloadFromFooter: boolean;
  downloadDisabled: boolean;
  onSelect(id: string): void;
  onDownload(): void;
}) {
  const selectedOption = POWER_MODEL_OPTIONS.find((option) => option.id === selectedId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Plainsong turns your voice into text on this Mac, so it needs a speech
        model first. The recommended one suits most people and downloads on
        demand. You can switch later in Settings.
      </p>

      <div className="space-y-2">
        {POWER_MODEL_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={selectedId === option.id}
            onClick={() => {
              if (state !== "downloading") {
                onSelect(option.id);
              }
            }}
            className={`flex w-full items-start justify-between gap-4 rounded-lg border-2 p-3 text-left transition-all ${
              selectedId === option.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <div className="min-w-0 space-y-0.5">
              <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                {option.recommended ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gold-text">
                    <span className="neume neume-lit" aria-hidden="true" />
                    Recommended
                  </span>
                ) : null}
                {option.title}
              </p>
              <p className="text-xs text-muted-foreground">{option.desc}</p>
            </div>
            <span className="flex shrink-0 flex-col items-end pt-0.5 text-xs text-muted-foreground">
              <span>{option.label}</span>
              <span>{powerModelSize(option)}</span>
            </span>
          </button>
        ))}
      </div>

      {state === "idle" && !downloadFromFooter ? (
        <Button
          id="download-model-btn"
          onClick={onDownload}
          className="gap-2"
          disabled={downloadDisabled}
        >
          <Download className="h-4 w-4" />
          Download {selectedOption?.label}
        </Button>
      ) : null}

      {state === "downloading" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Downloading {selectedOption?.label}
            {percent !== null ? `: ${Math.round(percent)}%` : "…"}
          </div>
          <Progress value={percent} className="h-2" />
        </div>
      ) : null}

      {state === "done" ? (
        <div className="flex items-center gap-2 text-sm text-gold-text" role="status">
          <CheckCircle2 className="h-4 w-4" />
          Downloaded and ready to use.
        </div>
      ) : null}

      {state === "error" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="h-4 w-4" />
            Download failed: {error}
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

      <p className="text-sm text-muted-foreground">
        {downloadFromFooter
          ? "You can skip this and download later, but dictation will not work until a model is ready."
          : "Start the download here, or keep the model you already use. You can change models later in Settings."}
      </p>
    </div>
  );
}

function HotkeyStep({
  displayShortcut,
  onShortcutChange,
  modeChoice,
  saveError,
}: {
  displayShortcut: string;
  onShortcutChange(value: string): void;
  modeChoice: ReactNode;
  saveError: string | null;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Choose the shortcut you press to dictate in any app, and how it works.
        Both can be changed later in Settings &gt; Dictation.
      </p>

      <ShortcutRecorder
        inputId="first-run-dictation-shortcut"
        displayShortcut={displayShortcut}
        onShortcutChange={onShortcutChange}
      />

      {modeChoice}

      {saveError ? (
        <p className="text-xs text-destructive" role="alert">
          Failed to save hotkey: {saveError}
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
    id: "ollama",
    label: "Write notes on this Mac with Ollama",
    detail:
      "Nothing leaves the machine. Ollama is a separate free download and has to be running.",
  },
  {
    id: "byok",
    label: "Use my own API key",
    detail:
      "Transcripts are sent to the provider you pick. Add the key under AI & Keys.",
  },
  {
    id: "none",
    label: "Transcripts only, no AI notes",
    detail:
      "Meetings are still recorded, transcribed and searchable. No summary, action items or auto-title.",
  },
];

/**
 * How meeting notes get written, asked once, before the first meeting.
 *
 * A default install points the meetings lane at an Ollama nobody installed, so
 * the summary, action items and title of the first meeting all failed silently.
 * The three answers here are the only honest ones: run it locally, bring a key,
 * or say plainly that you do not want notes — and the last one is remembered so
 * readiness reports a decision instead of a fault.
 */
function AiNotesStep({
  choice,
  onChoiceChange,
  configuredProvider,
  localAiReady,
  localAiChecking,
  onRecheckLocalAi,
  onOpenAiSettings,
  saveError,
  saveErrorContext,
}: {
  choice: AiNotesChoice;
  onChoiceChange(choice: AiNotesChoice): void;
  configuredProvider: string;
  localAiReady: boolean | null;
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

      {/*
        Dictation cleanup is a different lane with a different answer, and
        saying so here stops the most common misreading of this step: that
        picking "Transcripts only" also turns dictation cleanup off. The
        built-in model ships as the default for that lane and needs nothing
        from this screen -- but it is a normalizer, so it is not one of the
        three answers below.
      */}
      <p className="text-sm text-muted-foreground">
        Dictation cleanup is separate and already works. A small built-in model
        tidies punctuation, filler words and spoken numbers on this Mac, with
        nothing to install. It does not write meeting notes. You can change
        either one later in Models.
      </p>

      <div
        className="space-y-2"
        role="radiogroup"
        aria-label="How meeting notes are written"
      >
        {AI_NOTES_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={choice === option.id}
            onClick={() => onChoiceChange(option.id)}
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
          </button>
        ))}
      </div>

      {choice === "ollama" ? (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Ollama on this Mac</p>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {localAiChecking
                  ? "Checking whether Ollama is running…"
                  : localAiReady === true
                    ? "Ollama answered. Meeting notes can be written locally."
                    : localAiReady === false
                      ? "Ollama is not running, so notes will not be written yet."
                      : "Plainsong could not reach Ollama to check."}
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
              <p className="text-sm text-muted-foreground">
                Install Ollama from{" "}
                <code className="rounded bg-muted px-1">ollama.com/download</code>
                , start it, then pull a model with{" "}
                <code className="rounded bg-muted px-1">
                  ollama pull qwen3.5:4b
                </code>
                .
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={onRecheckLocalAi}
                disabled={localAiChecking}
              >
                Check again
              </Button>
              <p className="text-sm text-muted-foreground">
                You can continue now. Meetings will record and transcribe, and
                Plainsong will say plainly that notes are unavailable until
                Ollama answers.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {choice === "byok" ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-sm font-medium">
            {isRemoteAnalysisProvider(configuredProvider)
              ? `Currently set to ${describeAnalysisDestination(configuredProvider)}`
              : "No cloud provider is selected yet"}
          </p>
          <p className="text-sm text-muted-foreground">
            Add the key under AI &amp; Keys and turn cloud AI on. Until then,
            meetings still record and transcribe, and Plainsong reports notes as
            unavailable rather than pretending they were written.
          </p>
          <Button size="sm" variant="outline" onClick={onOpenAiSettings}>
            <KeyRound className="mr-2 h-4 w-4" />
            Open AI &amp; Keys settings
          </Button>
        </div>
      ) : null}

      {choice === "none" ? (
        <div className="rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">
            Plainsong will remember this and stop reporting a missing AI route as
            a problem. Change it any time in AI &amp; Keys.
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

function MeetingSetupStep({
  loading,
  routeSummary,
  routeReady,
  routeError,
  verificationDetails,
  systemAudioCapability,
  systemAudioTestLoading,
  systemAudioTestStatus,
  meetingModelState,
  meetingModelError,
  meetingDownloadPercent,
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
  onApplyRecommendedRoute,
  recommendedRouteSummary,
  saveError,
  saveErrorContext,
}: {
  loading: boolean;
  routeSummary: string;
  routeReady: boolean | null;
  routeError: string | null;
  verificationDetails: string[];
  systemAudioCapability: SystemAudioCapability | null;
  systemAudioTestLoading: boolean;
  systemAudioTestStatus: string | null;
  meetingModelState: "idle" | "downloading" | "done" | "error";
  meetingModelError: string | null;
  meetingDownloadPercent: number | null;
  onTestSystemAudio(): void;
  meetingAudioStorageMode: "always" | "transcript_only";
  onMeetingAudioStorageModeChange(value: "always" | "transcript_only"): void;
  meetingRetentionPreset: "1m" | "2m" | "3m" | "custom" | "never";
  onMeetingRetentionPresetChange(value: "1m" | "2m" | "3m" | "custom" | "never"): void;
  meetingRetentionCustomMonths: number;
  onMeetingRetentionCustomMonthsChange(value: number): void;
  meetingRetentionDeleteMode: "audio_only" | "audio_and_transcript";
  onMeetingRetentionDeleteModeChange(value: "audio_only" | "audio_and_transcript"): void;
  onRefresh(): void;
  onApplyRecommendedRoute?: () => void;
  recommendedRouteSummary: string | null;
  saveError: string | null;
  saveErrorContext:
    | "hotkey"
    | "meeting-route"
    | "meeting-settings"
    | "ai-notes"
    | null;
}) {
  const systemAudioBackendLabel =
    systemAudioCapability?.backend === "core_audio_process_tap"
      ? "macOS audio capture"
      : systemAudioCapability?.backend === "virtual_loopback"
        ? "a virtual loopback device"
        : null;
  const systemAudioRouteAvailable =
    Boolean(systemAudioCapability) && systemAudioCapability?.backend !== "none";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Plainsong can also record and transcribe meetings on this Mac. It hears
        you through the microphone and the other people through your Mac&apos;s
        sound output. Parakeet is the recommended meeting model; for a language
        it does not cover, choose a Whisper model later in Models.
      </p>

      <div className="space-y-3">
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Meeting transcription</p>
              <p className="text-xs text-muted-foreground">{routeSummary}</p>
            </div>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : routeReady ? (
              <span className="neume neume-lit" aria-hidden="true" />
            ) : (
              <span className="neume neume-rust" aria-hidden="true" />
            )}
          </div>
          {routeError ? <p className="mt-2 text-xs text-rust">{routeError}</p> : null}
          {verificationDetails.length > 0 ? (
            <div className="mt-2 space-y-1">
              {verificationDetails.map((detail) => (
                <p key={detail} className="text-xs text-muted-foreground">
                  {detail}
                </p>
              ))}
            </div>
          ) : null}
          {recommendedRouteSummary && !routeReady ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={onApplyRecommendedRoute}>
                Use recommended route
              </Button>
              <span className="text-xs text-muted-foreground">{recommendedRouteSummary}</span>
            </div>
          ) : null}
          {saveError && saveErrorContext === "meeting-route" ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              Couldn&apos;t save the recommended meeting route: {saveError}. Retry the route;
              your storage and retention choices are still here.
            </p>
          ) : null}
          {meetingModelState === "downloading" ? (
            <div className="mt-3 space-y-1.5" aria-live="polite">
              <Progress value={meetingDownloadPercent} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                Downloading the local meeting model
                {meetingDownloadPercent === null
                  ? "…"
                  : ` · ${Math.round(meetingDownloadPercent)}%`}
              </p>
            </div>
          ) : null}
          {meetingModelError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              Meeting model download failed: {meetingModelError}
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">System audio capture</p>
              {systemAudioCapability === null ? (
                <p className="text-xs text-muted-foreground">Checking…</p>
              ) : systemAudioCapability.ready ? (
                <p className="text-xs text-gold-text">
                  Working. Plainsong can hear the other people on a call
                  {systemAudioCapability.routeDevice
                    ? ` through ${systemAudioCapability.routeDevice}`
                    : ""}
                  .
                </p>
              ) : systemAudioRouteAvailable ? (
                <p className="text-xs text-rust">
                  Found {systemAudioBackendLabel ?? "a way to capture it"}, but
                  permission and non-silent audio are not verified yet. Run the
                  test below.
                </p>
              ) : (
                <p className="text-xs text-rust">
                  No way to capture your Mac&apos;s sound yet. Meetings still
                  record your microphone.
                </p>
              )}
            </div>
            {loading || systemAudioTestLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : systemAudioCapability?.ready ? (
              <span className="neume neume-lit" aria-hidden="true" />
            ) : systemAudioCapability === null ? (
              <span className="neume neume-hollow" aria-hidden="true" />
            ) : (
              <span className="neume neume-rust" aria-hidden="true" />
            )}
          </div>
          {systemAudioCapability?.actionableReason ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {systemAudioCapability.actionableReason}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            {systemAudioCapability?.backend === "virtual_loopback"
              ? "Play some audio through that device during the test. It is marked ready only once Plainsong actually hears it."
              : "The test plays a short, quiet tone and checks that Plainsong hears it. macOS may ask for permission the first time."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
              Test system audio
            </Button>
            {systemAudioCapability?.backend === "core_audio_process_tap" &&
            !systemAudioCapability.ready ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void openPermissionSettings("system_audio")}
              >
                Open system-audio privacy settings
              </Button>
            ) : null}
          </div>
          {systemAudioTestStatus ? (
            <p
              className={`mt-2 text-xs ${systemAudioCapability?.ready ? "text-gold-text" : "text-muted-foreground"}`}
              role="status"
            >
              {systemAudioTestStatus}
            </p>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
        <p className="text-xs font-medium">What Plainsong keeps</p>
        {/* One sentence, because it is the one thing here the reader did not
            ask for: the app will notice a call and offer. It never records
            without a click. */}
        <p className="text-sm text-muted-foreground">
          Plainsong also notices when a Zoom, Teams, Meet, Webex, Slack,
          Discord or FaceTime call is in progress on this Mac and offers to
          record it. It never starts on its own, and you can turn the offer off
          in Settings &gt; General.
        </p>
        <div className="space-y-2">
          <label
            htmlFor="first-run-meeting-audio-storage"
            className="text-xs text-muted-foreground"
          >
            Meeting audio storage
          </label>
          <select
            id="first-run-meeting-audio-storage"
            aria-label="Meeting audio storage"
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
            value={meetingAudioStorageMode}
            onChange={(event) =>
              onMeetingAudioStorageModeChange(event.target.value as "always" | "transcript_only")
            }
          >
            <option value="always">Always keep audio</option>
            <option value="transcript_only">Transcript only (delete audio after transcription)</option>
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="first-run-meeting-retention" className="text-xs text-muted-foreground">
            Meeting retention
          </label>
          <select
            id="first-run-meeting-retention"
            aria-label="Meeting retention"
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
            value={meetingRetentionPreset}
            onChange={(event) =>
              onMeetingRetentionPresetChange(
                event.target.value as "1m" | "2m" | "3m" | "custom" | "never"
              )
            }
          >
            <option value="1m">After 1 month</option>
            <option value="2m">After 2 months</option>
            <option value="3m">After 3 months</option>
            <option value="never">Never</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {meetingRetentionPreset === "custom" ? (
          <div className="space-y-2">
            <label
              htmlFor="first-run-custom-retention-months"
              className="text-xs text-muted-foreground"
            >
              Custom retention months
            </label>
            <Input
              id="first-run-custom-retention-months"
              aria-label="Custom retention months"
              type="number"
              min={1}
              value={meetingRetentionCustomMonths}
              onChange={(event) =>
                onMeetingRetentionCustomMonthsChange(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </div>
        ) : null}

        <div className="space-y-2">
          <label
            htmlFor="first-run-retention-delete-mode"
            className="text-xs text-muted-foreground"
          >
            Retention delete mode
          </label>
          <select
            id="first-run-retention-delete-mode"
            aria-label="Retention delete mode"
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
            value={meetingRetentionDeleteMode}
            onChange={(event) =>
              onMeetingRetentionDeleteModeChange(
                event.target.value as "audio_only" | "audio_and_transcript"
              )
            }
          >
            <option value="audio_only">Delete audio only</option>
            <option value="audio_and_transcript">Delete audio and transcript</option>
          </select>
        </div>

        {saveError && saveErrorContext === "meeting-settings" ? (
          <p className="text-xs text-destructive" role="alert">
            Meeting storage and retention weren&apos;t saved: {saveError}. Your selections are
            still here; choose Finish meeting setup to retry.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Re-check meeting setup
        </Button>
        <span className="text-xs text-muted-foreground self-center">
          You can come back to this any time from Setup.
        </span>
      </div>
    </div>
  );
}
