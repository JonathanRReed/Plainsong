import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  Mic,
  Shield,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import {
  downloadAsrModels,
  getAsrProviders,
} from "@/lib/backend/asr";
import { listen } from "@/lib/electron";
import {
  getPermissionDiagnostics,
  getSettings,
  openInstalledPlainsongApp,
  openPermissionSettings,
  requestDictationPermissions,
  saveSettings,
  verifyMeetingSetup,
  type PermissionDiagnostics,
  type SetupVerificationResult,
} from "@/lib/backend/settings";
import {
  getSystemAudioCapability,
  testSystemAudioCapture,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import {
  startDictation,
  stopDictation,
} from "@/lib/backend/dictation";
import {
  defaultDictationShortcut,
  dictationInstruction,
  formatShortcutForDisplay,
  normalizeShortcut,
} from "@/lib/shortcuts";
import {
  buildAsrRouteCatalog,
  getRecommendedLaneRoute,
} from "@/lib/asr-route-catalog";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import { MEETING_ONBOARDING_STORAGE_KEY, type OnboardingMode } from "@/lib/onboarding";
import { readAiNotesOptOut, writeAiNotesOptOut } from "@/lib/ai-notes-preference";
import { getOllamaStatus } from "@/lib/backend/ai";
import {
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
} from "@/components/models/ai-lanes";
import { requestReadinessDestination } from "@/lib/navigation";
import { findConflictingShortcuts } from "../../electron/shortcut-registration";

type Props = {
  mode?: OnboardingMode;
  onComplete(result?: { markOnboardingComplete?: boolean; meetingsCompleted?: boolean }): void;
};

type Step =
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
const POWER_MODEL_OPTIONS: Array<{
  id: string;
  providerType: AsrProviderType;
  label: string;
  size: string;
  desc: string;
  recommended?: boolean;
}> = [
  {
    id: "parakeet-tdt-0.6b-v3",
    providerType: "parakeet",
    label: "Parakeet TDT 0.6B v3",
    size: "640 MB",
    desc: "Recommended default — more accurate transcription, works for meetings too",
    recommended: true,
  },
  {
    id: "base.en",
    providerType: "whisper",
    label: "Whisper base.en",
    size: "142 MB",
    desc: "Smaller download (142 MB vs. 640 MB), but less accurate on unfamiliar words",
  },
  {
    id: "distil-large-v3.5",
    providerType: "distil_whisper",
    label: "Distil Whisper",
    size: "2.8 GiB",
    desc: "Accuracy upgrade for demanding solo dictation",
  },
  {
    id: "moonshine-base",
    providerType: "moonshine",
    label: "Moonshine Base",
    size: "246 MB",
    desc: "Lightweight alternative for lower-end machines",
  },
];

type PermissionGate = {
  key: string;
  label: string;
  purpose: string;
  section: "microphone" | "speech" | "accessibility" | "automation";
  settingsLabel: string;
  // Optional gates are shown with a neutral (not red/urgent) indicator and
  // don't imply setup is broken when ungranted -- the app's default route
  // doesn't need them.
  optional?: boolean;
  ready(perms: PermissionDiagnostics | null): boolean | undefined;
};

// Sequential, purpose-labeled gates: microphone first, then the speech and
// cursor-control grants. Each row states *why* the grant is needed so the
// request reads as a purpose, not a demand.
const PERMISSION_GATES: PermissionGate[] = [
  {
    key: "microphone",
    label: "Microphone",
    purpose: "So Plainsong can hear what you say out loud.",
    section: "microphone",
    settingsLabel: "Microphone",
    ready: (perms) => perms?.microphonePermissionReady ?? perms?.microphoneReady,
  },
  {
    key: "speech",
    label: "Speech recognition",
    purpose:
      "Optional -- only needed when you explicitly choose Apple Speech for on-device dictation. macOS transcribes on this Mac; the permission records your consent to that, not permission to use a server. Plainsong never uses this route as a fallback.",
    section: "speech",
    settingsLabel: "Speech Recognition",
    optional: true,
    ready: (perms) => perms?.speechRecognitionReady,
  },
  {
    key: "accessibility",
    label: "Accessibility",
    purpose: "So Plainsong can insert your spoken words into other apps.",
    section: "accessibility",
    settingsLabel: "Accessibility",
    ready: (perms) => perms?.accessibilityReady,
  },
  {
    key: "automation",
    label: "Keyboard fallback",
    purpose: "So Plainsong can type words in when direct insertion is unavailable.",
    // The capability this row describes is actually tracked by postEventReady
    // (CGPreflightPostEventAccess), which is granted from the same macOS
    // Accessibility pane as the row above -- not a separate "Automation"
    // pane, which governs unrelated inter-app scripting permissions.
    section: "accessibility",
    settingsLabel: "Accessibility",
    ready: (perms) => perms?.postEventReady,
  },
];

const PERMISSION_GATE_ICONS: Record<string, ReactNode> = {
  microphone: <Mic className="h-4 w-4" />,
  speech: <Brain className="h-4 w-4" />,
  accessibility: <ShieldCheck className="h-4 w-4" />,
  automation: <Shield className="h-4 w-4" />,
};

const STEP_LABELS: Record<Step, string> = {
  "try-dictation": "Try dictation here",
  "use-everywhere": "Use it everywhere",
  ready: "Ready",
  permissions: "Permissions",
  "dictation-model": "Dictation model",
  hotkey: "Hotkey",
  "meeting-setup": "Meeting setup",
  "ai-notes": "Meeting notes",
};

// Mirrors settings-view-simple.tsx's dictationShortcutBehaviorHint copy, so
// the wizard describes whichever mode is actually configured (hold-to-talk
// and hands-free are real, working modes, not stubs) instead of assuming
// everyone is on toggle.
const HOTKEY_MODE_LABELS: Record<"hold_to_talk" | "toggle" | "hands_free", { name: string; hint: string }> = {
  toggle: { name: "Toggle", hint: "press to start, press again to stop" },
  hold_to_talk: { name: "Hold to talk", hint: "hold the shortcut to record, release to stop" },
  hands_free: { name: "Hands-free", hint: "starts automatically when you speak, stops on silence" },
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
  const [autoRequestPermissions, setAutoRequestPermissions] = useState(true);
  const permRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [modelState, setModelState] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelSkipped, setModelSkipped] = useState(false);
  // Placeholder only, corrected by the settings-load effect below before any
  // download can actually fire (see the dictationProvider branches there).
  // Kept as "base.en" rather than the new "parakeet-tdt-0.6b-v3" default so
  // a settings.json that already names a non-default provider (e.g. an
  // existing whisper/base.en setup) is never at risk of racing a real click
  // against the correction effect and downloading the wrong model; the
  // fresh-install case corrects to Parakeet the same way.
  const [selectedModelId, setSelectedModelId] = useState("base.en");
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const downloadingProviderTypeRef = useRef<AsrProviderType | null>(null);
  const [meetingModelState, setMeetingModelState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [meetingModelError, setMeetingModelError] = useState<string | null>(null);
  const [meetingDownloadPercent, setMeetingDownloadPercent] = useState<number | null>(null);
  const meetingDownloadingProviderTypeRef = useRef<AsrProviderType | null>(null);
  const modelInteractionStartedRef = useRef(false);
  // Captures whatever dictation provider was already persisted at mount, so
  // ensureDefaultModelDownloading can tell "nothing configured yet" apart
  // from "user already has a different, working route" -- see its comment.
  const initialDictationProviderRef = useRef<string | null>(null);

  const [shortcutValue, setShortcutValue] = useState(defaultDictationShortcut());
  // Hold-to-talk and hands-free are real, working modes configured from
  // Settings (see settings-view-simple.tsx's resolveDictationHotkeyBehavior);
  // this wizard step only manages the key combo, so it reads the existing
  // mode to describe it accurately instead of assuming toggle.
  const [hotkeyMode, setHotkeyMode] = useState<"hold_to_talk" | "toggle" | "hands_free">("toggle");
  const [hotkeyDemoActive, setHotkeyDemoActive] = useState(false);
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
    return [
      "dictation-model",
      "try-dictation",
      "use-everywhere",
      "meeting-setup",
      "ai-notes",
      "ready",
    ] as Step[];
  }, [mode]);

  const stepIndex = steps.indexOf(step);
  const progress = steps.length > 1 ? ((stepIndex + 1) / steps.length) * 100 : 100;
  const isLastStep = stepIndex === steps.length - 1;
  const stepAnnouncement = `Step ${stepIndex + 1} of ${steps.length}: ${STEP_LABELS[step]}`;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      stepHeadingRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      getSettings(),
      getAsrProviders().catch(() => [] as AsrProviderInfo[]),
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
        const configuredProviderInfo = providers.find(
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
      })
      .catch(() => {
        // Keep defaults if onboarding loads before settings are ready.
      });

    return () => {
      mounted = false;
    };
  }, []);

  const refreshPerms = useCallback(async () => {
    setPermsLoading(true);
    try {
      const result = await getPermissionDiagnostics();
      setPerms(result);
      return result;
    } catch {
      return null;
    } finally {
      setPermsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (
      step === "permissions" ||
      step === "try-dictation" ||
      step === "use-everywhere"
    ) {
      void refreshPerms();
    }
  }, [refreshPerms, step]);

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
    const revoked = PERMISSION_GATES.find(
      (gate) => !gate.optional && gate.ready(previous) === true && gate.ready(fresh) !== true
    );
    if (!revoked) {
      setPermissionRevocation(null);
      return true;
    }
    const message = `${revoked.label} access was turned off again. ${revoked.purpose} Re-grant it to continue.`;
    setPermissionRevocation(message);
    setPermissionRequestStatus(null);
    requestAnimationFrame(() => focusPermissionCard(revoked.key));
    return false;
  }, [focusPermissionCard, perms, refreshPerms]);

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
              "Meetings need a meeting-grade ASR route plus a ready microphone and permission. System audio is optional for Me + Them capture."
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
      setPermissionRequestStatus("Requested macOS permissions and refreshed Plainsong readiness.");
    } catch (error) {
      setPermissionRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPermissionRequestBusy(false);
    }
  }, []);

  const openPermissionSettingsFromWizard = useCallback(
    async (section: "microphone" | "speech" | "accessibility" | "automation", label: string) => {
      setPermissionRequestError(null);
      setPermissionRequestStatus(null);
      try {
        await openPermissionSettings(section);
        setPermissionRequestStatus(`Opened macOS ${label} settings.`);
      } catch (error) {
        setPermissionRequestError(error instanceof Error ? error.message : String(error));
      }
    },
    []
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
    const option =
      POWER_MODEL_OPTIONS.find((candidate) => candidate.id === modelId) ?? POWER_MODEL_OPTIONS[0];
    modelInteractionStartedRef.current = true;
    setModelSkipped(false);
    setModelState("downloading");
    setModelError(null);
    setDownloadPercent(0);
    downloadingProviderTypeRef.current = option.providerType;
    try {
      await downloadAsrModels(option.providerType, option.id);
      if (!mountedRef.current) {
        return false;
      }
      // Read settings *after* the download, never before it. save_settings is
      // a whole-struct replace, so a snapshot taken before a multi-minute
      // fetch would roll back everything written while it ran -- the hotkey
      // this wizard just taught the user, the auto-request-permissions
      // toggle, the meeting storage/retention answers, the repaired meeting
      // route. Only the ASR fields this step actually owns are mutated on the
      // fresh copy.
      const settings = await getSettings();
      if (!mountedRef.current) {
        return false;
      }
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
  }, []);

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
  // downgraded/overwritten. Both "parakeet" (the current default) and
  // "whisper" (the default for every install that predates this default
  // change -- i.e. the entire pre-upgrade user base) count as "still on a
  // default route" here, not as a deliberate non-default choice.
  const ensureDefaultModelDownloading = useCallback(() => {
    const existingProvider = initialDictationProviderRef.current;
    const hasExistingNonDefaultRoute =
      Boolean(existingProvider) &&
      existingProvider !== "parakeet" &&
      existingProvider !== "whisper";
    if (hasExistingNonDefaultRoute) {
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
      await saveSettings(settings);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveErrorContext("hotkey");
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [autoRequestPermissions, shortcutValue]);

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
      if (aiNotesChoice === "ollama") {
        const settings = await getSettings();
        if (settings.privacy.meetingsAi.provider !== "ollama") {
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
      try {
        localStorage.setItem(MEETING_ONBOARDING_STORAGE_KEY, "true");
      } catch {
        // The saved settings are authoritative if browser storage is unavailable.
      }
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
    (result?: { markOnboardingComplete?: boolean; meetingsCompleted?: boolean }) => {
      const markOnboardingComplete = result?.markOnboardingComplete ?? mode === "full";
      onComplete({
        markOnboardingComplete,
        meetingsCompleted: result?.meetingsCompleted ?? false,
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

  const subtitle =
    step === "meeting-setup"
      ? "Meetings can be configured now or revisited later from Setup."
      : `Step ${stepIndex + 1} of ${steps.length}`;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col gap-6 overflow-y-auto rounded-2xl border border-border bg-card/95 p-8 text-card-foreground shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="rubric">
              {mode === "meetings" ? "MEETINGS" : mode === "dictation" ? "DICTATION" : "ONBOARDING"}
            </p>
            <h2
              ref={stepHeadingRef}
              id={titleId}
              tabIndex={-1}
              className="font-serif text-xl font-semibold text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {wizardTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {stepAnnouncement}
            </p>
          </div>
          {steps.length > 1 ? (
            <div className="flex gap-2">
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

        {steps.length > 1 ? <Progress value={progress} className="h-1" /> : null}

        {step === "try-dictation" ? (
          <TryDictationStep
            perms={perms}
            permsLoading={permsLoading}
            onRefreshPermissions={() => void refreshPerms()}
            onRequestPermissions={() => void requestPermissionsNow()}
            onOpenMicrophoneSettings={() =>
              void openPermissionSettingsFromWizard("microphone", "Microphone")
            }
            permissionRequestBusy={permissionRequestBusy}
            permissionRequestError={permissionRequestError}
            permissionRequestStatus={permissionRequestStatus}
            modelState={modelState}
            modelError={modelError}
            modelPercent={downloadPercent}
            onDownloadModel={() => void startModelDownload("parakeet-tdt-0.6b-v3")}
            scratchState={scratchState}
            scratchText={scratchText}
            scratchError={scratchError}
            onStartScratch={() => void startScratchDictation()}
            onFinishScratch={() => void finishScratchDictation()}
          />
        ) : null}

        {step === "use-everywhere" ? (
          <UseEverywhereStep
            perms={perms}
            permsLoading={permsLoading}
            onRefreshPermissions={() => void refreshPerms()}
            onOpenAccessibilitySettings={() =>
              void openPermissionSettingsFromWizard(
                "accessibility",
                "Accessibility"
              )
            }
            displayShortcut={displayShortcut}
            onShortcutChange={setShortcutValue}
            hotkeyMode={hotkeyMode}
            saveError={saveError}
          />
        ) : null}

        {step === "ready" ? (
          <ReadyStep
            displayShortcut={displayShortcut}
            hotkeyMode={hotkeyMode}
            modelState={modelState}
            modelError={modelError}
            modelSkipped={modelSkipped}
            onRetryModel={() => void startModelDownload("parakeet-tdt-0.6b-v3")}
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
            loading={permsLoading}
            onRefresh={() => void refreshPerms()}
            autoRequestPermissions={autoRequestPermissions}
            onAutoRequestPermissionsChange={setAutoRequestPermissions}
            onRequestNow={() => void requestPermissionsNow()}
            onOpenPermissionSettings={(section, label) =>
              void openPermissionSettingsFromWizard(section, label)
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
          <DictationModelStep
            state={modelState}
            error={modelError}
            percent={downloadPercent}
            selectedId={selectedModelId}
            downloadFromFooter={mode === "full"}
            onSelect={setSelectedModelId}
            onDownload={() => void startModelDownload(selectedModelId)}
          />
        ) : null}

        {step === "hotkey" ? (
          <HotkeyStep
            active={hotkeyDemoActive}
            onToggle={() => setHotkeyDemoActive((value) => !value)}
            displayShortcut={displayShortcut}
            onShortcutChange={setShortcutValue}
            hotkeyMode={hotkeyMode}
            includeMeetings={false}
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

        <div className="flex justify-between">
          <div className="flex gap-2">
            {mode === "full" ? (
              step === "dictation-model" && modelState !== "done" ? (
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
                  completeWizard({ markOnboardingComplete: true, meetingsCompleted: false })
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
              (step === "meeting-setup" && meetingModelState === "downloading") ||
              // Only block Continue for a download in progress while the
              // user is still on a visible, foreground model surface.
              (modelState === "downloading" &&
                (step === "dictation-model" ||
                  step === "try-dictation" ||
                  step === "ready")) ||
              ((modelState === "idle" || modelState === "error") &&
                step === "ready" &&
                !modelSkipped &&
                scratchState !== "complete") ||
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
  onDownloadModel,
  scratchState,
  scratchText,
  scratchError,
  onStartScratch,
  onFinishScratch,
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
  onDownloadModel(): void;
  scratchState: ScratchDictationState;
  scratchText: string;
  scratchError: string | null;
  onStartScratch(): void;
  onFinishScratch(): void;
}) {
  const microphoneReady =
    perms?.microphonePermissionReady ?? perms?.microphoneReady;
  const scratchInFlight =
    scratchState === "starting" || scratchState === "transcribing";

  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        Get a real transcript before setting up system-wide insertion. This test
        uses Plainsong&apos;s normal local capture and history path, but keeps
        the result inside Plainsong.
      </p>

      <div className="divide-y divide-border rounded-xl border border-border">
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 text-muted-foreground">
              <Mic className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">Dictation permissions</p>
              <p className="text-sm text-muted-foreground">
                {microphoneReady
                  ? "The microphone is ready for this test."
                  : "macOS may ask for Microphone so Plainsong can hear you, then Accessibility so it can insert text in other apps."}
              </p>
            </div>
          </div>
          {permsLoading || permissionRequestBusy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : microphoneReady ? (
            <span className="neume neume-lit mt-1" aria-label="Microphone ready" />
          ) : (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={onRequestPermissions}>
                Request dictation permissions
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onOpenMicrophoneSettings}
              >
                Open Settings
              </Button>
            </div>
          )}
        </div>

        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 text-muted-foreground">
              <Download className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">Recommended local model</p>
              <p className="text-sm text-muted-foreground">
                Parakeet TDT 0.6B v3 is a 640 MB download. A smaller 142 MB option is
                available later, with less accuracy on unfamiliar words.
              </p>
            </div>
          </div>
          {modelState === "done" ? (
            <span className="neume neume-lit mt-1" aria-label="Model ready" />
          ) : modelState === "downloading" ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {modelPercent === null ? "Downloading" : `${Math.round(modelPercent)}%`}
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={onDownloadModel}>
              {modelState === "error" ? "Retry download" : "Download"}
            </Button>
          )}
        </div>
      </div>

      {modelState === "downloading" ? (
        <Progress value={modelPercent} className="h-1.5" />
      ) : null}
      {modelError ? (
        <p className="text-xs text-destructive" role="alert">
          Model download failed: {modelError}
        </p>
      ) : null}

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
        <div className="flex flex-col items-center text-center">
          <div
            className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full border ${
              scratchState === "listening"
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {scratchInFlight ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Mic className="h-6 w-6" />
            )}
          </div>
          <p className="font-serif text-lg font-semibold">
            {scratchState === "listening"
              ? "Listening"
              : scratchState === "transcribing"
                ? "Turning speech into text"
                : scratchState === "complete"
                  ? "That worked"
                  : "Say one sentence"}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {scratchState === "listening"
              ? "Speak naturally, then finish when you are done."
              : "This result is saved locally. It will not touch the clipboard or another app."}
          </p>

          <div className="mt-4">
            {scratchState === "listening" ? (
              <Button onClick={onFinishScratch}>Finish and transcribe</Button>
            ) : (
              <Button
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

        {scratchState === "complete" ? (
          <div
            className="mt-5 rounded-lg border border-border bg-background/70 p-4 text-left"
            role="status"
            aria-live="polite"
          >
            {scratchText ? (
              <p className="text-sm leading-relaxed text-foreground">
                {scratchText}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No speech was detected. Try again and speak a little closer to
                the microphone.
              </p>
            )}
          </div>
        ) : null}

        {scratchError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {scratchError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefreshPermissions}
          disabled={permsLoading}
        >
          Re-check microphone
        </Button>
        {permissionRequestStatus ? <span>{permissionRequestStatus}</span> : null}
        {permissionRequestError ? (
          <span className="text-destructive" role="alert">
            {permissionRequestError}
          </span>
        ) : null}
      </div>
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
  hotkeyMode,
  saveError,
}: {
  perms: PermissionDiagnostics | null;
  permsLoading: boolean;
  onRefreshPermissions(): void;
  onOpenAccessibilitySettings(): void;
  displayShortcut: string;
  onShortcutChange(value: string): void;
  hotkeyMode: "hold_to_talk" | "toggle" | "hands_free";
  saveError: string | null;
}) {
  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        The first test stayed in Plainsong. To dictate at the cursor in any app,
        macOS needs one cursor-control grant and a shortcut you can remember.
      </p>

      <div className="space-y-3">
        <PermRow
          order={1}
          label="Accessibility"
          purpose="Lets Plainsong insert finished words at your cursor."
          icon={<ShieldCheck className="h-4 w-4" />}
          ready={perms?.accessibilityReady}
          loading={permsLoading}
          onFix={onOpenAccessibilitySettings}
          registerRef={() => {}}
        />
        <PermRow
          order={2}
          label="Keyboard fallback"
          purpose="Lets Plainsong type when direct insertion is unavailable."
          icon={<Shield className="h-4 w-4" />}
          ready={perms?.postEventReady}
          loading={permsLoading}
          onFix={onOpenAccessibilitySettings}
          registerRef={() => {}}
        />
      </div>

      <Button
        size="sm"
        variant="ghost"
        onClick={onRefreshPermissions}
        disabled={permsLoading}
      >
        Re-check cursor access
      </Button>

      <div className="space-y-3 border-t border-border pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Your dictation shortcut</p>
            <p className="text-xs text-muted-foreground">
              {dictationInstruction(displayShortcut, hotkeyMode)}
            </p>
          </div>
          <span className="rubric-muted text-[0.65rem]">
            {HOTKEY_MODE_LABELS[hotkeyMode].name}
          </span>
        </div>
        <Input
          aria-label="Dictation shortcut"
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
        <p className="text-xs text-muted-foreground">
          Click the field, then press the key combination you want. After setup,
          place the cursor in any text field and use this shortcut.
        </p>
      </div>

      {saveError ? (
        <p className="text-xs text-destructive" role="alert">
          Failed to save shortcut: {saveError}
        </p>
      ) : null}
    </div>
  );
}

function ReadyStep({
  displayShortcut,
  hotkeyMode,
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
  displayShortcut: string;
  hotkeyMode: "hold_to_talk" | "toggle" | "hands_free";
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
          detail: "First transcript completed inside Plainsong.",
          tone: "ready" as const,
        }
      : modelState === "downloading"
        ? {
            detail: "Downloading Parakeet TDT 0.6B v3 in the background.",
            tone: "progress" as const,
          }
        : modelState === "error"
          ? {
              detail: modelSkipped
                ? "The download was skipped after it failed. Download the model here or from Dictation before using the shortcut."
                : modelError
                  ? `Model download failed: ${modelError}`
                  : "The local model download needs another try.",
              tone: "attention" as const,
            }
          : modelState === "done"
            ? {
                detail: "Parakeet TDT 0.6B v3 is ready for your first dictation.",
                tone: "ready" as const,
              }
            : {
                detail: modelSkipped
                  ? "The model download was skipped. Download it here or from Dictation before using the shortcut."
                  : "The local model has not been downloaded yet.",
                tone: "attention" as const,
              };
  const rows = [
    {
      label: "Local dictation",
      ...localDictation,
    },
    {
      label: "Microphone",
      detail: microphoneReady
        ? "Permission is ready."
        : "macOS permission still needs attention.",
      tone: microphoneReady ? ("ready" as const) : ("attention" as const),
    },
    {
      label: displayShortcut,
      detail: `${HOTKEY_MODE_LABELS[hotkeyMode].name}: ${HOTKEY_MODE_LABELS[hotkeyMode].hint}.`,
      tone: "ready" as const,
    },
    {
      label: "System-wide insertion",
      detail: insertionReady
        ? "Cursor control is ready."
        : "Finish the Accessibility grant before relying on insertion.",
      tone: insertionReady ? ("ready" as const) : ("attention" as const),
    },
    {
      label: "Meetings",
      detail: fullMeetingCaptureReady
        ? "Mic and system audio are verified for Me + Them capture."
        : meetingReady
          ? "Mic-only capture is ready. You can verify system audio later from Setup."
          : "Meeting capture still needs a meeting-ready transcription route.",
      tone: meetingReady ? ("ready" as const) : ("attention" as const),
    },
  ];

  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        Plainsong saves every finished dictation before it attempts delivery.
        If another app rejects insertion, your words remain in dictation
        history.
      </p>

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
            Dictation and meeting audio remain on this Mac unless you explicitly
            enable a remote transcription or analysis provider.
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionsStep({
  perms,
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
  loading: boolean;
  onRefresh(): void;
  autoRequestPermissions: boolean;
  onAutoRequestPermissionsChange(next: boolean): void;
  onRequestNow(): void;
  onOpenPermissionSettings(
    section: "microphone" | "speech" | "accessibility" | "automation",
    label: string
  ): void;
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
        Grant these in order. Microphone first so Plainsong can hear you, then the
        cursor-control grant so it can insert your spoken words into other apps. Speech
        recognition is optional -- it is only used when you explicitly select Apple's
        on-device, dictation-only route.
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
          <p className="text-xs text-rust">
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
              label={gate.label}
              purpose={gate.purpose}
              icon={PERMISSION_GATE_ICONS[gate.key]}
              ready={gate.ready(perms)}
              optional={gate.optional}
              loading={gate.key === "microphone" ? loading : loading || requestBusy}
              onFix={() => onOpenPermissionSettings(gate.section, gate.settingsLabel)}
              registerRef={(node) => registerCardRef(gate.key, node)}
            />
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-border p-3 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Auto-request permissions before dictation</p>
            <p className="text-xs text-muted-foreground">
              Prompt for microphone access, plus Speech Recognition only when the selected dictation route needs it. Leave this off if you are not at the Mac to respond to system prompts.
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
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {requestStatus}
          </p>
        ) : null}
        {requestError ? (
          <p className="text-xs text-destructive" role="alert">
            {requestError}
          </p>
        ) : null}
      </div>

      {perms?.notes?.map((note, index) => (
        <p key={index} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

function PermRow({
  order,
  label,
  purpose,
  icon,
  ready,
  optional,
  loading,
  onFix,
  registerRef,
}: {
  order: number;
  label: string;
  purpose: string;
  icon: ReactNode;
  ready: boolean | undefined;
  optional?: boolean;
  loading: boolean;
  onFix(): void;
  registerRef(node: HTMLDivElement | null): void;
}) {
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
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {label}
            {optional ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-normal text-muted-foreground">
                Optional
              </span>
            ) : null}
          </span>
          <p className="text-xs text-muted-foreground">{purpose}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : ready ? (
          <span className="neume neume-lit" aria-hidden="true" />
        ) : (
          <>
            <span className={optional ? "neume neume-hollow" : "neume neume-rust"} aria-hidden="true" />
            <Button
              variant="outline"
              size="sm"
              onClick={onFix}
              className="h-7 text-xs"
              aria-label={`Fix ${label}`}
            >
              Fix
            </Button>
          </>
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
  onSelect,
  onDownload,
}: {
  state: "idle" | "downloading" | "done" | "error";
  error: string | null;
  percent: number | null;
  selectedId: string;
  downloadFromFooter: boolean;
  onSelect(id: string): void;
  onDownload(): void;
}) {
  const selectedOption = POWER_MODEL_OPTIONS.find((option) => option.id === selectedId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose the local model Plainsong will use for dictation. Parakeet TDT 0.6B v3 is the
        recommended default and downloads on demand; Whisper base.en is a smaller download with
        less accuracy on unfamiliar words, and the larger choices trade space and time for
        accuracy.
      </p>

      <div className="space-y-2">
        {POWER_MODEL_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => {
              if (state !== "downloading") {
                onSelect(option.id);
              }
            }}
            className={`flex w-full items-center justify-between rounded-lg border-2 p-3 text-left transition-all ${
              selectedId === option.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
            }`}
          >
            <div>
              <p className="text-sm font-medium">
                {option.label}
                {option.recommended ? (
                  <span className="ml-1.5 inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <span className="neume neume-lit" aria-hidden="true" />
                    Fast default
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">{option.desc}</p>
            </div>
            <span className="text-xs text-muted-foreground">{option.size}</span>
          </button>
        ))}
      </div>

      {state === "idle" && !downloadFromFooter ? (
        <Button id="download-model-btn" onClick={onDownload} className="gap-2">
          <Download className="h-4 w-4" />
          Download {selectedOption?.label}
        </Button>
      ) : null}

      {state === "downloading" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Downloading {selectedOption?.label}
            {percent !== null ? ` — ${Math.round(percent)}%` : "…"}
          </div>
          <Progress value={percent} className="h-2" />
        </div>
      ) : null}

      {state === "done" ? (
        <div className="flex items-center gap-2 text-sm text-gold-text">
          <CheckCircle2 className="h-4 w-4" />
          Local dictation route downloaded and selected.
        </div>
      ) : null}

      {state === "error" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="h-4 w-4" />
            Download failed: {error}
          </div>
          {!downloadFromFooter ? (
            <Button variant="outline" size="sm" onClick={onDownload}>
              Retry download
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {downloadFromFooter
          ? "Download the selected model to continue, or choose Skip model download. Dictation will keep showing a download reminder until a model is ready."
          : "Start the download here, or keep your existing dictation model. You can change models later in Settings."}
      </p>
    </div>
  );
}

function HotkeyStep({
  active,
  onToggle,
  displayShortcut,
  onShortcutChange,
  hotkeyMode,
  includeMeetings,
  saveError,
}: {
  active: boolean;
  onToggle(): void;
  displayShortcut: string;
  onShortcutChange(value: string): void;
  hotkeyMode: "hold_to_talk" | "toggle" | "hands_free";
  includeMeetings: boolean;
  saveError: string | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {dictationInstruction(displayShortcut, hotkeyMode)}
      </p>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <label
          htmlFor="first-run-dictation-shortcut"
          className="text-xs font-medium text-muted-foreground"
        >
          Dictation shortcut
        </label>
        <Input
          id="first-run-dictation-shortcut"
          aria-label="Dictation shortcut"
          value={displayShortcut}
          readOnly
          onKeyDown={(event) => {
            if (event.key === "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") return;
            const parsed = formatShortcutFromKeyboardEvent(event);
            if (!parsed) return;
            onShortcutChange(parsed);
          }}
          className="font-mono text-center"
        />
        <p className="text-xs text-muted-foreground">
          Click the field and press the shortcut you want Plainsong to use.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="rubric-muted text-[0.65rem]">Hotkey behavior</p>
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
          {HOTKEY_MODE_LABELS[hotkeyMode].name}{" "}
          <span className="text-muted-foreground">— {HOTKEY_MODE_LABELS[hotkeyMode].hint}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          Change this in Settings → Dictation if you want a different behavior.
        </p>
      </div>

      <button
        type="button"
        id="hotkey-demo-btn"
        onClick={onToggle}
        className={`relative w-full rounded-xl border-2 p-6 text-center transition-all duration-200 ${
          active
            ? "border-primary bg-primary/5 shadow-[0_0_20px_hsl(var(--primary)/0.3)]"
            : "border-border bg-muted/30 hover:border-primary/40"
        }`}
      >
        <div
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all ${
            active ? "bg-primary text-primary-foreground scale-105" : "bg-muted text-muted-foreground"
          }`}
        >
          <KeyRound className="h-4 w-4" />
          {active ? "Listening preview…" : "Click to preview"}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {active ? "Click again to dismiss demo" : "The real hotkey works system-wide"}
        </p>
      </button>

      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
        <p className="text-xs font-medium">After this step:</p>
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex items-center gap-1.5">
            <Mic className="h-3 w-3 shrink-0" />
            <span>Dictation is ready to test</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 shrink-0" />
            <span>Permissions can be revisited later</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Users className="h-3 w-3 shrink-0" />
            <span>{includeMeetings ? "Next: meeting setup" : "Meetings can be configured later"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Brain className="h-3 w-3 shrink-0" />
            <span>AI/analysis setup stays optional</span>
          </div>
        </div>
      </div>

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
    label: "Transcripts only — no AI notes",
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
        Meeting summaries, action items and automatic titles are written by an AI
        route you choose. Capture and the transcript never depend on it.
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
        Dictation cleanup is separate. It uses a small built-in model that runs
        on this Mac with nothing to install — it tidies punctuation, fillers and
        spoken numbers, but it cannot write meeting notes. Change either lane
        later in Models.
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
      ? "Core Audio process tap"
      : systemAudioCapability?.backend === "virtual_loopback"
        ? "virtual loopback"
        : "no route";
  const systemAudioRouteAvailable =
    Boolean(systemAudioCapability) && systemAudioCapability?.backend !== "none";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Meetings work best with a meeting-grade ASR route and, when available, both microphone and system audio capture.
        Parakeet is the recommended local route; for a language it does not cover, whisper.cpp small, medium,
        large-v3 or large-v3-turbo can run meetings too (100 languages, on the GPU, slower than Parakeet).
      </p>

      <div className="space-y-3">
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Meeting transcription route</p>
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
                <p className="text-xs text-muted-foreground">Checking routes…</p>
              ) : systemAudioCapability.ready ? (
                <p className="text-xs text-gold-text">
                  Verified via {systemAudioBackendLabel}
                  {systemAudioCapability.routeDevice
                    ? ` on ${systemAudioCapability.routeDevice}`
                    : ""}
                  {systemAudioCapability.nativeSampleRate && systemAudioCapability.nativeChannels
                    ? ` · ${systemAudioCapability.nativeSampleRate} Hz / ${systemAudioCapability.nativeChannels} ch`
                    : ""}
                  .
                </p>
              ) : systemAudioRouteAvailable ? (
                <p className="text-xs text-rust">
                  Route detected via {systemAudioBackendLabel}, but permission and non-silent audio are not verified yet.
                </p>
              ) : (
                <p className="text-xs text-rust">
                  No usable system-audio route is ready. Mic-only meetings still work.
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
            macOS may ask for system-audio permission the first time. Plainsong stops waiting if macOS does not finish setup, so you can open Privacy Settings and try again. Plainsong plays a brief low-volume tone only for the native Core Audio process tap. Virtual loopback routes must carry external audio during the test. A route is only marked ready after callbacks contain the expected non-silent verification signal.
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
        <p className="text-xs font-medium">Meeting storage defaults</p>
        {/* One sentence, because it is the one thing here the reader did not
            ask for: the app will notice a call and offer. It never records
            without a click. */}
        <p className="text-sm text-muted-foreground">
          Plainsong also notices when a Zoom, Teams, Meet, Webex, Slack,
          Discord or FaceTime call is in progress on this Mac and offers to
          record it; it never starts on its own, and you can turn the offer off
          in Settings › General.
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
          You can reopen this flow anytime from Setup if system audio or meeting models change later.
        </span>
      </div>
    </div>
  );
}
