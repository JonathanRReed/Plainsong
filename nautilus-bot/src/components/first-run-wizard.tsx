import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  Mic,
  Settings2,
  Shield,
  ShieldCheck,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import {
  downloadAsrModels,
  getAsrProviders,
} from "@/lib/backend/asr";
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
  checkSystemAudioAvailability,
  getLoopbackDeviceName,
} from "@/lib/backend/recordings";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { AsrProviderInfo, AsrProviderType } from "@/types";
import { MEETING_ONBOARDING_STORAGE_KEY, type OnboardingMode } from "@/lib/onboarding";

type Props = {
  mode?: OnboardingMode;
  onComplete(result?: { markOnboardingComplete?: boolean; meetingsCompleted?: boolean }): void;
};

type Step = "welcome" | "permissions" | "dictation-model" | "hotkey" | "meeting-setup";

const POWER_MODEL_OPTIONS = [
  {
    id: "distil-large-v3.5",
    label: "Distil Whisper",
    size: "Managed",
    desc: "Best default solo route for fast local dictation",
  },
  {
    id: "moonshine-base",
    label: "Moonshine Base",
    size: "Managed",
    desc: "Lightweight local fallback for lower-end machines",
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3",
    size: "Managed",
    desc: "Higher-accuracy local route when meeting quality matters more",
  },
];

type PermissionGate = {
  key: string;
  label: string;
  purpose: string;
  section: "microphone" | "speech" | "accessibility" | "automation";
  settingsLabel: string;
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
    purpose: "So the native speech engine can turn your voice into text.",
    section: "speech",
    settingsLabel: "Speech Recognition",
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
    section: "automation",
    settingsLabel: "Automation",
    ready: (perms) => perms?.automationReady,
  },
];

const PERMISSION_GATE_ICONS: Record<string, ReactNode> = {
  microphone: <Mic className="h-4 w-4" />,
  speech: <Brain className="h-4 w-4" />,
  accessibility: <ShieldCheck className="h-4 w-4" />,
  automation: <Shield className="h-4 w-4" />,
};

const STEP_LABELS: Record<Step, string> = {
  welcome: "Choose your setup",
  permissions: "Permissions",
  "dictation-model": "Dictation model",
  hotkey: "Hotkey",
  "meeting-setup": "Meeting setup",
};

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
  const [includeMeetings, setIncludeMeetings] = useState(false);
  const [step, setStep] = useState<Step>(mode === "full" ? "welcome" : mode === "meetings" ? "meeting-setup" : "permissions");

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
  const [selectedModelId, setSelectedModelId] = useState("base.en");

  const [shortcutValue, setShortcutValue] = useState(defaultDictationShortcut());
  // v1 ships toggle-only: press to start, press again to stop. Hold-to-talk and
  // hands-free need a native key listener that isn't wired yet, so the wizard
  // shows a static behavior row and always persists toggle.
  const hotkeyMode = "toggle" as const;
  const [hotkeyDemoActive, setHotkeyDemoActive] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [meetingAudioStorageMode, setMeetingAudioStorageMode] = useState<"always" | "transcript_only">("always");
  const [meetingRetentionPreset, setMeetingRetentionPreset] = useState<"1m" | "2m" | "3m" | "custom" | "never">("never");
  const [meetingRetentionCustomMonths, setMeetingRetentionCustomMonths] = useState(1);
  const [meetingRetentionDeleteMode, setMeetingRetentionDeleteMode] = useState<"audio_only" | "audio_and_transcript">("audio_only");
  const [meetingSetupLoading, setMeetingSetupLoading] = useState(false);
  const [meetingRouteSummary, setMeetingRouteSummary] = useState("Checking meeting route…");
  const [meetingRouteReady, setMeetingRouteReady] = useState<boolean | null>(null);
  const [meetingRouteError, setMeetingRouteError] = useState<string | null>(null);
  const [meetingSystemAudioAvailable, setMeetingSystemAudioAvailable] = useState<boolean | null>(null);
  const [loopbackDevice, setLoopbackDevice] = useState<string | null>(null);
  const [meetingVerificationDetails, setMeetingVerificationDetails] = useState<string[]>([]);
  const [meetingRecommendedRoute, setMeetingRecommendedRoute] = useState<{
    providerType: AsrProviderType;
    modelId: string;
  } | null>(null);

  const steps = useMemo(() => {
    if (mode === "meetings") {
      return ["meeting-setup"] as Step[];
    }
    if (mode === "dictation") {
      return ["permissions", "dictation-model", "hotkey"] as Step[];
    }
    return includeMeetings
      ? (["welcome", "permissions", "dictation-model", "hotkey", "meeting-setup"] as Step[])
      : (["welcome", "permissions", "dictation-model", "hotkey"] as Step[]);
  }, [includeMeetings, mode]);

  const stepIndex = steps.indexOf(step);
  const progress = steps.length > 1 ? ((stepIndex + 1) / steps.length) * 100 : 100;
  const isLastStep = stepIndex === steps.length - 1;

  useEffect(() => {
    let mounted = true;
    void getSettings()
      .then((settings) => {
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
        if (settings.transcription.dictationProvider === "moonshine") {
          setSelectedModelId("moonshine-base");
        } else if (settings.transcription.dictationProvider === "parakeet") {
          setSelectedModelId("parakeet-tdt-0.6b-v3");
        } else {
          setSelectedModelId("distil-large-v3.5");
        }
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
    if (step === "permissions") {
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
      (gate) => gate.ready(previous) === true && gate.ready(fresh) !== true
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
      const [settings, providers, systemAudioAvailable, detectedLoopbackDevice, verification] = await Promise.all([
        getSettings(),
        getAsrProviders(),
        checkSystemAudioAvailability().catch(() => false),
        getLoopbackDeviceName().catch(() => null),
        verifyMeetingSetup().catch(() => null as SetupVerificationResult | null),
      ]);

      const currentProvider = (settings.transcription.meetingProvider as AsrProviderType | undefined) ?? null;
      const currentModelId = settings.transcription.meetingModelId ?? null;
      const routeReady = verification?.ok ?? false;

      setMeetingRouteSummary(summarizeMeetingRoute(currentProvider, currentModelId, providers));
      setMeetingRouteReady(routeReady);
      setMeetingVerificationDetails(verification?.details ?? []);
      setMeetingRouteError(
        routeReady
          ? null
          : verification?.summary ??
              "Meetings need a meeting-grade ASR route with microphone and system-audio setup ready."
      );
      setMeetingSystemAudioAvailable(systemAudioAvailable);
      setLoopbackDevice(detectedLoopbackDevice);
      setMeetingRecommendedRoute(getRecommendedMeetingRoute(providers));
      return { routeReady, systemAudioAvailable };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMeetingRouteSummary("Meeting setup check failed");
      setMeetingRouteReady(false);
      setMeetingRouteError(message || "Could not verify the meeting setup right now.");
      setMeetingVerificationDetails([]);
      setMeetingSystemAudioAvailable(null);
      setLoopbackDevice(null);
      setMeetingRecommendedRoute(null);
      return { routeReady: false, systemAudioAvailable: false };
    } finally {
      setMeetingSetupLoading(false);
    }
  }, []);

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

  const startModelDownload = useCallback(async (modelId?: string) => {
    setModelState("downloading");
    setModelError(null);
    try {
      const selected = modelId ?? "distil-large-v3.5";
      const settings = await getSettings();
      const providerType: AsrProviderType =
        selected === "moonshine-base"
          ? "moonshine"
          : selected === "parakeet-tdt-0.6b-v3"
            ? "parakeet"
            : "distil_whisper";
      await downloadAsrModels(providerType);
      settings.transcription.useSharedAsrSelection = false;
      settings.transcription.defaultProvider = providerType;
      settings.transcription.selectedModelId = selected;
      settings.transcription.dictationProvider = providerType;
      settings.transcription.dictationModelId = selected;
      await saveSettings(settings);
      setModelState("done");
    } catch (error) {
      setModelState("error");
      setModelError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const persistDictationStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    try {
      const settings = await getSettings();
      settings.shortcuts.toggleDictation = normalizeShortcut(shortcutValue);
      settings.shortcuts.toggleDictationAlternates = [];
      // v1 is toggle-only, so both push-to-talk and hands-free stay off.
      settings.transcription.dictationPushToTalk = false;
      settings.transcription.dictationHandsFreeEnabled = false;
      settings.transcription.dictationAutoRequestPermissions = autoRequestPermissions;
      await saveSettings(settings);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
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
      return false;
    } finally {
      setSaveBusy(false);
    }
  }, [meetingRecommendedRoute, refreshMeetingSetup]);

  const persistMeetingStep = useCallback(async () => {
    setSaveBusy(true);
    setSaveError(null);
    try {
      const settings = await getSettings();
      settings.transcription.meetingAudioStorageMode = meetingAudioStorageMode;
      settings.transcription.meetingRetentionPreset = meetingRetentionPreset;
      settings.transcription.meetingRetentionCustomMonths = Math.max(1, meetingRetentionCustomMonths);
      settings.transcription.meetingRetentionDeleteMode = meetingRetentionDeleteMode;
      await saveSettings(settings);
      localStorage.setItem(MEETING_ONBOARDING_STORAGE_KEY, "true");
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
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

  const handleWelcomeChoice = (nextIncludeMeetings: boolean) => {
    setIncludeMeetings(nextIncludeMeetings);
    setStep("permissions");
  };

  const completeWizard = useCallback(
    (result?: { markOnboardingComplete?: boolean; meetingsCompleted?: boolean }) => {
      onComplete({
        markOnboardingComplete: result?.markOnboardingComplete ?? mode === "full",
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

    if (step === "hotkey") {
      const saved = await persistDictationStep();
      if (!saved) {
        return;
      }
      if (mode === "full" && !includeMeetings) {
        completeWizard({ markOnboardingComplete: true, meetingsCompleted: false });
        return;
      }
    }

    if (step === "meeting-setup") {
      if (meetingRouteReady === false) {
        const fixed = await applyRecommendedMeetingRoute();
        if (!fixed) {
          return;
        }
      }
      const saved = await persistMeetingStep();
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

  const subtitle =
    step === "welcome"
      ? "Set up Plainsong the way you actually plan to use it."
      : step === "meeting-setup"
        ? "Meetings can be configured now or revisited later from Setup."
        : `Step ${stepIndex + 1} of ${steps.length}, ${STEP_LABELS[step]}`;

  const nextLabel =
    step === "meeting-setup" && meetingRouteReady === false
      ? "Fix meeting route"
      : isLastStep
        ? mode === "meetings" || step === "meeting-setup"
          ? "Finish meeting setup"
          : "Finish"
        : "Continue";

  const displayShortcut = formatShortcutForDisplay(shortcutValue);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col gap-6 overflow-y-auto rounded-2xl border border-border bg-card/95 p-8 text-card-foreground shadow-2xl">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="rubric">
              {mode === "meetings" ? "MEETINGS" : mode === "dictation" ? "DICTATION" : "ONBOARDING"}
            </p>
            <h2 className="font-serif text-xl font-semibold text-card-foreground">
              {mode === "meetings" ? "Set Up Meetings" : mode === "dictation" ? "Fix Dictation Setup" : "Getting Started"}
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
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

        {step === "welcome" ? (
          <WelcomeStep onChoose={handleWelcomeChoice} />
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
            selectedId={selectedModelId}
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
            includeMeetings={mode === "full" && includeMeetings}
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
            systemAudioAvailable={meetingSystemAudioAvailable}
            loopbackDevice={loopbackDevice}
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
          />
        ) : null}

        <div className="flex justify-between">
          <div className="flex gap-2">
            {mode === "full" && step !== "welcome" ? (
              <Button
                variant="ghost"
                onClick={() => completeWizard({ markOnboardingComplete: true, meetingsCompleted: false })}
                className="text-muted-foreground"
              >
                Skip for now
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => completeWizard()} className="text-muted-foreground">
                Close
              </Button>
            )}
            {step === "meeting-setup" && mode !== "meetings" ? (
              <Button
                variant="outline"
                onClick={() => completeWizard({ markOnboardingComplete: true, meetingsCompleted: false })}
              >
                Finish with dictation only
              </Button>
            ) : null}
          </div>
          {step !== "welcome" || mode !== "full" ? (
            <Button onClick={() => void nextStep()} disabled={saveBusy || permissionRequestBusy || modelState === "downloading" || meetingSetupLoading}>
              {saveBusy || meetingSetupLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {nextLabel}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WelcomeStep({ onChoose }: { onChoose(includeMeetings: boolean): void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Start with fast dictation readiness, then decide whether to configure meetings now or later.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <ChoiceCard
          icon={<Zap className="h-6 w-6 text-gold" />}
          title="Get dictation ready"
          description="Best first-run path. Fix permissions, set the hotkey, and start dictating quickly."
          actionLabel="Start with dictation"
          recommended
          onClick={() => onChoose(false)}
        />
        <ChoiceCard
          icon={<Settings2 className="h-6 w-6 text-muted-foreground" />}
          title="Full setup"
          description="Do dictation first, then continue into meeting capture and system-audio setup."
          actionLabel="Set up both"
          onClick={() => onChoose(true)}
        />
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        You can always reopen guided setup later from Setup if you only want to configure meetings after the app is already working for dictation.
      </div>
    </div>
  );
}

function ChoiceCard({
  icon,
  title,
  description,
  actionLabel,
  recommended = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  recommended?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-smooth flex flex-col items-start gap-3 rounded-xl border border-border p-5 text-left hover:border-primary/60 hover:bg-primary/5"
    >
      <div
        className={
          recommended
            ? "flex h-12 w-12 items-center justify-center rounded-full bg-muted/20"
            : "flex h-12 w-12 items-center justify-center rounded-full bg-muted/40"
        }
      >
        {icon}
      </div>
      <div>
        <p className="font-serif font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <span className={recommended ? "inline-flex items-center gap-1.5 text-xs font-medium text-foreground" : "text-xs font-medium text-muted-foreground"}>
        {recommended ? <span className="neume neume-lit" aria-hidden="true" /> : null}
        {actionLabel}
      </span>
    </button>
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
        cursor-control grant so it can insert your spoken words into other apps.
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
              Prompt for native speech and microphone access when needed instead of failing on first use.
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
  loading,
  onFix,
  registerRef,
}: {
  order: number;
  label: string;
  purpose: string;
  icon: ReactNode;
  ready: boolean | undefined;
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
          <span className="text-sm font-medium">{label}</span>
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
            <span className="neume neume-rust" aria-hidden="true" />
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
  selectedId,
  onSelect,
  onDownload,
}: {
  state: "idle" | "downloading" | "done" | "error";
  error: string | null;
  selectedId: string;
  onSelect(id: string): void;
  onDownload(): void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Set up the actual local dictation route Plainsong will use for solo work. Distil Whisper is the recommended default.
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
              <p className="text-sm font-medium">{option.label}</p>
              <p className="text-xs text-muted-foreground">{option.desc}</p>
            </div>
            <span className="text-xs text-muted-foreground">{option.size}</span>
          </button>
        ))}
      </div>

      {state === "idle" ? (
        <Button id="download-model-btn" onClick={onDownload} className="gap-2">
          <Download className="h-4 w-4" />
          Download {POWER_MODEL_OPTIONS.find((option) => option.id === selectedId)?.label}
        </Button>
      ) : null}

      {state === "downloading" ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Downloading local model…
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
          <Button variant="outline" size="sm" onClick={onDownload}>
            Retry download
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        You can keep moving even if you want to configure models later in Setup or Settings → ASR / Providers.
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
          Toggle{" "}
          <span className="text-muted-foreground">
            — press to start, press again to stop
          </span>
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

      {saveError ? <p className="text-xs text-destructive">Failed to save hotkey: {saveError}</p> : null}
    </div>
  );
}

function MeetingSetupStep({
  loading,
  routeSummary,
  routeReady,
  routeError,
  verificationDetails,
  systemAudioAvailable,
  loopbackDevice,
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
}: {
  loading: boolean;
  routeSummary: string;
  routeReady: boolean | null;
  routeError: string | null;
  verificationDetails: string[];
  systemAudioAvailable: boolean | null;
  loopbackDevice: string | null;
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
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Meetings work best with a meeting-grade ASR route and, when available, both microphone and system audio capture.
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
        </div>

        <div className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">System audio capture</p>
              {systemAudioAvailable === null ? (
                <p className="text-xs text-muted-foreground">Checking availability…</p>
              ) : systemAudioAvailable ? (
                <p className="text-xs text-gold-text">
                  Ready{loopbackDevice ? ` via ${loopbackDevice}` : ""}.
                </p>
              ) : (
                <p className="text-xs text-rust">
                  Not ready yet. Mic-only meetings work now, but capturing other speakers/system audio still needs setup.
                </p>
              )}
            </div>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : systemAudioAvailable === null ? (
              <span className="neume neume-hollow" aria-hidden="true" />
            ) : systemAudioAvailable ? (
              <span className="neume neume-lit" aria-hidden="true" />
            ) : (
              <span className="neume neume-rust" aria-hidden="true" />
            )}
          </div>
          {!systemAudioAvailable ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Install and configure a loopback device such as BlackHole if you want Plainsong to capture both sides of calls. Mic-only meetings remain usable immediately.
            </p>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
        <p className="text-xs font-medium">Meeting storage defaults</p>
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
