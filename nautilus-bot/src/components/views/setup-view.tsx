import { useMemo, useState } from "react";
import {
  Download,
  Loader2,
  Mic,
  MonitorUp,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  downloadAsrModels,
  refreshAsrRuntimeProbes,
  repairLocalModelCache,
} from "@/lib/backend/asr";
import { smokeTestCursorInsert } from "@/lib/backend/dictation";
import {
  openPermissionSettings,
  repairCursorInsertPermissions,
  requestAppleSpeechPermission,
  requestDictationPermissions,
  verifyDictationSetup,
  verifyMeetingSetup,
} from "@/lib/backend/settings";
import { testSystemAudioCapture } from "@/lib/backend/recordings";
import {
  isCloudProvider,
  isDownloadableProvider,
  isMeetingGradeProvider,
  providerActionLabel,
  providerCapabilityLabel,
  providerHostingLabel,
  providerRecommendation,
} from "@/lib/asr-capabilities";
import { requestMainView } from "@/lib/navigation";
import { requestOnboarding } from "@/lib/onboarding";
import { useSetupStatus } from "@/hooks/use-setup-status";
import type { AsrProviderInfo } from "@/types";

function statusTone(ready: boolean) {
  return ready
    ? "border-gold/30 bg-gold/10 text-gold-text"
    : "border-rust/30 bg-rust/10 text-rust";
}

const readinessDetailClass = "rounded-lg border border-border/60 bg-background/60 px-3 py-2";
const readinessLabelClass = "rubric-muted text-current opacity-70";

function permissionStatusLabel(
  loading: boolean,
  permissions: { speechRecognitionReady?: boolean } | null | undefined,
  key: "speechRecognitionReady"
) {
  if (loading || !permissions) {
    return "Checking";
  }

  return permissions[key] ? "Ready" : "Needs access";
}

function providerBadge(provider: AsrProviderInfo) {
  if (provider.providerType === "macos_apple_speech" && provider.platformReadiness) {
    return (
      <Badge
        variant="outline"
        className={
          provider.platformReadiness.ready
            ? "border-gold/30 text-gold-text"
            : "border-rust/30 text-rust"
        }
      >
        {provider.platformReadiness.ready
          ? "Ready on-device"
          : provider.platformReadiness.status === "authorization_not_determined"
            ? "Permission required"
            : provider.platformReadiness.status === "authorization_denied"
              ? "Permission denied"
              : provider.platformReadiness.status === "unsupported_locale"
                ? "Locale unsupported"
                : provider.platformReadiness.status === "helper_missing"
                  ? "Helper missing"
                  : provider.platformReadiness.status === "on_device_unavailable"
                    ? "On-device unavailable"
                    : "Unavailable"}
      </Badge>
    );
  }

  if (provider.runtimeStatus === "ready") {
    return (
      <Badge
        variant="outline"
        className="border-gold/30 text-gold-text"
      >
        Ready
      </Badge>
    );
  }

  if (provider.runtimeStatus === "missing_model") {
    return (
      <Badge
        variant="outline"
        className="border-rust/30 text-rust"
      >
        Missing model
      </Badge>
    );
  }

  if (provider.runtimeStatus === "missing_runtime") {
    return (
      <Badge
        variant="outline"
        className="border-rust/30 text-rust"
      >
        Runtime setup
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="border-rust/30 text-rust">
      Error
    </Badge>
  );
}

function providerActionVariant(provider: AsrProviderInfo) {
  if (provider.providerType === "macos_apple_speech") {
    if (provider.platformReadiness?.status === "authorization_not_determined") {
      return "permission";
    }
    if (
      provider.platformReadiness?.status === "authorization_denied" ||
      provider.platformReadiness?.status === "authorization_restricted"
    ) {
      return "speech_settings";
    }
  }

  if (provider.runtimeStatus === "missing_model" && isDownloadableProvider(provider.providerType)) {
    return "download";
  }

  if (provider.runtimeStatus === "missing_runtime") {
    return "settings";
  }

  return "refresh";
}

export function SetupView() {
  const {
    loading,
    error,
    refresh,
    settings,
    permissions,
    providers,
    microphoneReady,
    systemAudioAvailable,
    loopbackDevice,
    systemAudioCapability,
    meetingCaptureMode,
    dictationRoutePreference,
    dictationLocalReady,
    dictationCloudReady,
    meetingRoutePolicy,
    dictationRoute,
    meetingRoute,
    dictationReady,
    meetingReady,
    fullCaptureReady,
    dictationBlockers,
    meetingBlockers,
    fullCaptureBlockers,
  } = useSetupStatus();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const dictationInsertionMode = settings?.transcription.dictationInsertionMode ?? "auto";
  const cursorInsertLabel =
    dictationInsertionMode === "clipboard_only"
      ? "Not needed"
      : permissions?.cursorInsertionReady
        ? permissions?.accessibilityReady
          ? "Ready"
          : "Keyboard fallback"
        : "Needs access";

  const sortedProviders = useMemo(() => {
    return [...providers].sort((left, right) => {
      const leftMeetingGrade = isMeetingGradeProvider(left.providerType) ? 0 : 1;
      const rightMeetingGrade = isMeetingGradeProvider(right.providerType) ? 0 : 1;
      if (leftMeetingGrade !== rightMeetingGrade) {
        return leftMeetingGrade - rightMeetingGrade;
      }
      if (left.runtimeStatus === "ready" && right.runtimeStatus !== "ready") {
        return -1;
      }
      if (left.runtimeStatus !== "ready" && right.runtimeStatus === "ready") {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });
  }, [providers]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setStatusMessage(null);
    try {
      await action();
      await refresh();
    } catch (nextError) {
      setStatusMessage(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const runVerification = async (
    key: string,
    action: () => Promise<{ ok: boolean; title: string; summary: string; details: string[] }>
  ) => {
    setBusyAction(key);
    setStatusMessage(null);
    try {
      const result = await action();
      const suffix = result.details.length > 0 ? ` ${result.details.join(" ")}` : "";
      setStatusMessage(`${result.title}: ${result.summary}${suffix}`);
      await refresh();
    } catch (nextError) {
      setStatusMessage(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border/70 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="rubric inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              Guided setup and repairs
            </p>
            <h1 className="font-serif text-2xl font-semibold tracking-tight">Setup</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Check dictation and meetings, rerun guided setup, and verify every route from one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => requestOnboarding("full")}>
              Rerun onboarding
            </Button>
            <Button variant="outline" onClick={() => requestOnboarding("dictation")}>
              Fix dictation setup
            </Button>
            <Button variant="outline" onClick={() => requestOnboarding("meetings")}>
              Set up meetings
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="space-y-6">
          {error ? (
            <div className="rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust">
              {error}
            </div>
          ) : null}
          {statusMessage ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust"
            >
              {statusMessage}
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className={statusTone(dictationReady)}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-serif text-base">
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  Dictation readiness
                </CardTitle>
                <CardDescription className="text-current opacity-80">
                  Permissions, insert behavior, and the active dictation lane.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className={`flex items-center justify-between ${readinessDetailClass}`}>
                  <span>Active route</span>
                  <span className="font-medium">{dictationRoute.summary}</span>
                </div>
                <div className={`flex items-center justify-between ${readinessDetailClass}`}>
                  <span>Route preference</span>
                  <span className="font-medium">
                    {dictationRoutePreference === "cloud" ? "Cloud preferred" : "Local preferred"}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Microphone</div>
                    <div className="mt-1 font-medium">
                      {loading ? "Checking" : microphoneReady ? "Ready" : "Needs attention"}
                    </div>
                  </div>
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Speech</div>
                    <div className="mt-1 font-medium">
                      {permissionStatusLabel(loading, permissions, "speechRecognitionReady")}
                    </div>
                  </div>
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Cursor insert</div>
                    <div className="mt-1 font-medium">{cursorInsertLabel}</div>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Local dictation</div>
                    <div className="mt-1 font-medium">
                      {dictationLocalReady ? "Ready" : "No ready route"}
                    </div>
                  </div>
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Cloud dictation</div>
                    <div className="mt-1 font-medium">
                      {dictationCloudReady ? "Ready" : "No ready route"}
                    </div>
                  </div>
                </div>
                {dictationRoute.reason ? (
                  <p className="text-sm text-current opacity-90">{dictationRoute.reason}</p>
                ) : (
                  <p className="text-sm text-current opacity-90">
                    Dictation is ready. If something drifts, rerun guided setup or refresh permissions here.
                  </p>
                )}
                {dictationBlockers.length > 0 ? (
                  <div className="rounded-lg border border-rust/20 bg-rust/5 px-3 py-2 text-xs text-current opacity-90">
                    <p className="mb-1 font-medium">Current blockers</p>
                    <ul className="space-y-1">
                      {dictationBlockers.map((blocker) => (
                        <li key={blocker}>• {blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  Permission and insert tests may open macOS settings, show system prompts, or send test text to the current app. Run them when you are at this Mac.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runVerification("verify-dictation", verifyDictationSetup)
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "verify-dictation" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Test dictation
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void runAction("request-dictation-permissions", async () => {
                        await requestDictationPermissions();
                      })
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "request-dictation-permissions" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Request permissions
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("verify-insert-permissions", async () => {
                        const result = await smokeTestCursorInsert("Plainsong insert test");
                        const target = result.targetApp ?? "the current app";
                        if (result.error) {
                          setStatusMessage(`Insert permissions test: ${result.error}`);
                          return;
                        }
                        if (result.pasted) {
                          setStatusMessage(
                            `Insert permissions test: Sent a test insert to ${target}.`
                          );
                          return;
                        }
                        if (result.copied) {
                          setStatusMessage(
                            `Insert permissions test: Direct insert was unavailable, so the test text was copied for manual paste in ${target}.`
                          );
                          return;
                        }
                        setStatusMessage(
                          "Insert permissions test: Plainsong could not confirm insert behavior."
                        );
                      })
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "verify-insert-permissions" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wrench className="mr-2 h-4 w-4" />
                    )}
                    Test insert permissions
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("repair-cursor-permissions", async () => {
                        await repairCursorInsertPermissions();
                      })
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "repair-cursor-permissions" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Repair cursor insert
                  </Button>
                  <Button variant="outline" onClick={() => void openPermissionSettings("microphone")}>
                    Open Microphone
                  </Button>
                  <Button variant="outline" onClick={() => void openPermissionSettings("accessibility")}>
                    Open Accessibility
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className={statusTone(meetingReady)}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-serif text-base">
                  <MonitorUp className="h-4 w-4" aria-hidden="true" />
                  Meeting readiness
                </CardTitle>
                <CardDescription className="text-current opacity-80">
                  Mic-only meeting readiness plus separately verified Me + Them capture.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className={`flex items-center justify-between ${readinessDetailClass}`}>
                  <span>Active route</span>
                  <span className="font-medium">{meetingRoute.summary}</span>
                </div>
                <div className={`flex items-center justify-between ${readinessDetailClass}`}>
                  <span>Meeting policy</span>
                  <span className="font-medium">
                    {meetingRoutePolicy === "best_available" ? "Best available" : "Prefer local"}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>System audio</div>
                    <div className="mt-1 font-medium">
                      {systemAudioAvailable === null
                        ? "Checking"
                        : fullCaptureReady
                          ? "Verified"
                          : systemAudioAvailable
                            ? "Route detected · unverified"
                            : "Not detected"}
                    </div>
                  </div>
                  <div className={readinessDetailClass}>
                    <div className={readinessLabelClass}>Capture route</div>
                    <div className="mt-1 font-medium">{loopbackDevice ?? "Not found"}</div>
                  </div>
                </div>
                <div className={readinessDetailClass}>
                  <div className={readinessLabelClass}>Meeting capture mode</div>
                  <div className="mt-1 font-medium">
                    {meetingCaptureMode === "me_and_them"
                      ? "Me + Them verified"
                      : meetingCaptureMode === "mic_only" && meetingReady
                        ? "Mic only ready"
                        : meetingCaptureMode === "mic_only"
                          ? "Not ready"
                          : "Checking"}
                  </div>
                  <p className="mt-1 text-xs text-current opacity-70">
                    {meetingCaptureMode === "me_and_them"
                      ? "Microphone, meeting ASR, and non-silent system-audio callbacks are verified."
                      : meetingReady && systemAudioAvailable
                        ? "Mic-only meetings are ready. A system-audio route is detected but unverified; run Test system audio before Me + Them."
                        : meetingReady
                          ? "Mic-only meetings are ready. Remote participants may be missed until system audio is configured and tested."
                          : meetingCaptureMode === "unknown"
                            ? "Checking microphone, meeting ASR, and system-audio readiness."
                            : "Microphone input, permission, or the meeting ASR route still needs attention."}
                  </p>
                </div>
                {meetingRoute.reason ? (
                  <p className="text-sm text-current opacity-90">{meetingRoute.reason}</p>
                ) : fullCaptureReady ? (
                  <p className="text-sm text-current opacity-90">
                    Meetings are ready for verified Me + Them capture.
                  </p>
                ) : meetingReady ? (
                  <p className="text-sm text-current opacity-90">
                    Mic-only meetings are ready. Me + Them remains optional until system audio passes its signal test.
                  </p>
                ) : (
                  <p className="text-sm text-current opacity-90">
                    Meeting capture still needs microphone input, permission, or a ready meeting ASR route.
                  </p>
                )}
                {meetingBlockers.length > 0 ? (
                  <div className="rounded-lg border border-rust/20 bg-rust/5 px-3 py-2 text-xs text-current opacity-90">
                    <p className="mb-1 font-medium">Meeting blockers</p>
                    <ul className="space-y-1">
                      {meetingBlockers.map((blocker) => (
                        <li key={blocker}>• {blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {meetingReady && !fullCaptureReady && fullCaptureBlockers.length > 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-current opacity-90">
                    <p className="mb-1 font-medium">Me + Them not verified</p>
                    <ul className="space-y-1">
                      {fullCaptureBlockers.map((blocker) => (
                        <li key={blocker}>• {blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runVerification("verify-meeting", verifyMeetingSetup)
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "verify-meeting" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Test meeting route
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("test-system-audio", async () => {
                        const result = await testSystemAudioCapture();
                        setStatusMessage(
                          result.capability.ready
                            ? `System audio test: Verified ${result.capability.routeDevice ?? "the current route"} for Me + Them capture.`
                            : `System audio test: ${result.capability.actionableReason ?? "No verified signal was detected. Start in Mic only mode or check the route and try again."}`
                        );
                      })
                    }
                    disabled={
                      busyAction !== null ||
                      systemAudioCapability === null ||
                      systemAudioCapability.backend === "none"
                    }
                  >
                    {busyAction === "test-system-audio" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <MonitorUp className="mr-2 h-4 w-4" />
                    )}
                    Test system audio
                  </Button>
                  <Button variant="secondary" onClick={() => requestOnboarding("meetings")}>
                    Guided meeting setup
                  </Button>
                  <Button variant="outline" onClick={() => requestMainView("settings")}>
                    Open settings
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("refresh-setup", async () => {
                        await refreshAsrRuntimeProbes();
                      })
                    }
                    disabled={busyAction !== null}
                  >
                    {busyAction === "refresh-setup" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="mr-2 h-4 w-4" />
                    )}
                    Re-check environment
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 font-serif">
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                  Providers and models
                </CardTitle>
                <CardDescription>
                  Every route's runtime state, missing files, and recovery action in one place.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    void runAction("repair-local-model-cache", async () => {
                      await repairLocalModelCache();
                      await refreshAsrRuntimeProbes();
                    })
                  }
                  disabled={busyAction !== null}
                >
                  {busyAction === "repair-local-model-cache" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wrench className="mr-2 h-4 w-4" />
                  )}
                  Repair model cache
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void runAction("refresh-runtime", async () => {
                      await refreshAsrRuntimeProbes();
                    })
                  }
                  disabled={busyAction !== null}
                >
                  {busyAction === "refresh-runtime" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="mr-2 h-4 w-4" />
                  )}
                  Refresh runtime
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/70 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading provider readiness…
                </div>
              ) : (
                sortedProviders.map((provider) => {
                  const downloadKey = `download-${provider.providerType}`;
                  const canDownload =
                    provider.runtimeStatus === "missing_model" &&
                    isDownloadableProvider(provider.providerType);
                  const actionVariant = providerActionVariant(provider);

                  return (
                    <div
                      key={provider.providerType}
                      className="rounded-xl border border-border/70 bg-card/50 px-4 py-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{provider.name}</p>
                            {providerBadge(provider)}
                            <Badge variant="secondary">
                              {providerCapabilityLabel(provider.providerType)}
                            </Badge>
                            <Badge variant="outline">
                              {providerHostingLabel(
                                provider.providerType,
                                provider.selectedModelId,
                              )}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {provider.modelOptions.find((option) => option.id === provider.selectedModelId)?.label ??
                              provider.selectedModelId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {providerRecommendation(provider)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {canDownload ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                void runAction(downloadKey, async () => {
                                  await downloadAsrModels(provider.providerType);
                                  await refreshAsrRuntimeProbes();
                                })
                              }
                              disabled={busyAction !== null}
                            >
                              {busyAction === downloadKey ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="mr-2 h-4 w-4" />
                              )}
                              {providerActionLabel(provider)}
                            </Button>
                          ) : null}
                          {actionVariant === "permission" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void runAction("request-apple-speech", async () => {
                                  await requestAppleSpeechPermission();
                                })
                              }
                              disabled={busyAction !== null}
                            >
                              {busyAction === "request-apple-speech" ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : null}
                              Request permission
                            </Button>
                          ) : null}
                          {actionVariant === "speech_settings" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void runAction("open-apple-speech-settings", async () => {
                                  await openPermissionSettings("speech");
                                })
                              }
                              disabled={busyAction !== null}
                            >
                              <Settings2 className="mr-2 h-4 w-4" />
                              Open Speech Settings
                            </Button>
                          ) : null}
                          {actionVariant === "settings" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => requestMainView("settings")}
                              disabled={busyAction !== null}
                            >
                              <Settings2 className="mr-2 h-4 w-4" />
                              {providerActionLabel(provider)}
                            </Button>
                          ) : null}
                          {!canDownload && actionVariant === "refresh" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void runAction(`recheck-${provider.providerType}`, async () => {
                                  await refreshAsrRuntimeProbes();
                                })
                              }
                              disabled={busyAction !== null}
                            >
                              {busyAction === `recheck-${provider.providerType}` ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCcw className="mr-2 h-4 w-4" />
                              )}
                              {providerActionLabel(provider)}
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-3 space-y-2 text-sm">
                        <p className="text-muted-foreground">
                          {provider.platformReadiness?.message ??
                            provider.runtimeMessage ??
                            `${provider.name} is not ready yet.`}
                        </p>
                        {provider.providerType === "macos_apple_speech" ? (
                          <p className="text-xs text-muted-foreground">
                            Dictation-only. Recognition stays on-device and Apple
                            server fallback is disabled.
                          </p>
                        ) : null}
                        {isCloudProvider(provider.providerType) && provider.runtimeStatus !== "ready" ? (
                          <p className="text-xs text-muted-foreground">
                            Cloud routes usually need an API key or account setup in Settings before they become usable.
                          </p>
                        ) : null}
                        {provider.runtimeDetails.missingFiles?.length ? (
                          <p className="text-xs text-rust">
                            Missing:{" "}
                            <span className="font-mono">
                              {provider.runtimeDetails.missingFiles.join(", ")}
                            </span>
                          </p>
                        ) : null}
                        {provider.runtimeDetails.setupAction ? (
                          <p className="text-xs text-muted-foreground">
                            Fix: {provider.runtimeDetails.setupAction}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-serif">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Quick recovery
              </CardTitle>
                <CardDescription>
                  Fast paths for the most common launch blockers.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-border/70 p-4">
                <div className="mb-2 flex items-center gap-2.5">
                  <span
                    className={dictationReady ? "neume neume-lit" : "neume neume-rust"}
                    aria-hidden="true"
                  />
                  <p className="font-medium">{dictationReady ? "Dictation ready" : "Dictation not ready"}</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Re-run the dictation-focused guide and re-check permissions, hotkey behavior, and cursor insert.
                </p>
                <Button className="mt-3 w-full" variant="outline" onClick={() => requestOnboarding("dictation")}>
                  Fix dictation setup
                </Button>
              </div>
              <div className="rounded-xl border border-border/70 p-4">
                <div className="mb-2 flex items-center gap-2.5">
                  <span
                    className={meetingReady ? "neume neume-lit" : "neume neume-rust"}
                    aria-hidden="true"
                  />
                  <p className="font-medium">
                    {fullCaptureReady
                      ? "Meetings ready · Me + Them verified"
                      : meetingReady
                        ? "Mic-only meetings ready"
                        : "Meetings not ready"}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Re-run guided meeting setup to validate microphone access and a meeting-grade ASR route, then test system audio if you want Me + Them capture.
                </p>
                <Button className="mt-3 w-full" variant="outline" onClick={() => requestOnboarding("meetings")}>
                  Set up meetings
                </Button>
              </div>
              <div className="rounded-xl border border-border/70 p-4">
                <div className="mb-2 flex items-center gap-2.5">
                  <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <p className="font-medium">Power-user controls</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Use the provider and privacy screens when you need fine-grained control over models, keys, or storage.
                </p>
                <Button className="mt-3 w-full" variant="outline" onClick={() => requestMainView("settings")}>
                  Open settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
