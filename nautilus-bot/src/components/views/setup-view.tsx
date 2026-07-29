import { useMemo, useState } from "react";
import {
  Download,
  Loader2,
  Mic,
  MonitorUp,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
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

/**
 * One flat label/value list per readiness card. Bordered detail tiles inside an
 * already-bordered card were card-in-card; hairline rows say the same thing.
 */
function StatusRows({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="border-t border-border/60">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 text-sm"
        >
          <span className="text-muted-foreground">{row.label}</span>
          <span className="text-right font-medium">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

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
        Needs setup
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
      <PageHeader
        eyebrow="Guided setup and repairs"
        title="Setup"
        subtitle="Check that dictation and meetings work, and fix them here when they do not."
        actions={
          <>
            <Button variant="outline" onClick={() => requestOnboarding("full")}>
              Rerun onboarding
            </Button>
            <Button variant="outline" onClick={() => requestOnboarding("dictation")}>
              Fix dictation setup
            </Button>
            <Button variant="outline" onClick={() => requestOnboarding("meetings")}>
              Set up meetings
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-6 py-6 lg:px-8">
          {error ? (
            <div className="rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust">
              {error}
            </div>
          ) : null}
          {statusMessage ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-border/70 bg-muted/25 px-4 py-3 text-sm"
            >
              {statusMessage}
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className={dictationReady ? "border-gold/40" : "border-rust/40"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Mic className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Dictation
                </CardTitle>
                <CardDescription>
                  Speaking into any app and having the words typed for you.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="flex items-start gap-2 text-sm">
                  <span
                    className={dictationReady ? "neume neume-lit mt-1.5" : "neume neume-rust mt-1.5"}
                    aria-hidden="true"
                  />
                  <span>
                    {dictationReady
                      ? "Dictation is ready. If it stops working, run the checks below."
                      : (dictationRoute.reason ??
                        "Dictation is not ready yet. What is missing is listed below.")}
                  </span>
                </p>
                <StatusRows
                  rows={[
                    { label: "Transcribed by", value: dictationRoute.summary },
                    {
                      label: "Preference",
                      value:
                        dictationRoutePreference === "cloud"
                          ? "Prefers the cloud"
                          : "Prefers this Mac",
                    },
                    {
                      label: "Microphone",
                      value: loading ? "Checking" : microphoneReady ? "Ready" : "Needs attention",
                    },
                    {
                      label: "Speech",
                      value: permissionStatusLabel(loading, permissions, "speechRecognitionReady"),
                    },
                    { label: "Cursor insert", value: cursorInsertLabel },
                    {
                      label: "On this Mac",
                      value: dictationLocalReady ? "Ready" : "Not ready",
                    },
                    {
                      label: "In the cloud",
                      value: dictationCloudReady ? "Ready" : "Not ready",
                    },
                  ]}
                />
                {dictationBlockers.length > 0 ? (
                  <div className="rounded-lg border border-rust/20 bg-rust/5 px-3 py-2 text-sm">
                    <p className="mb-1 font-medium">Still missing</p>
                    <ul className="space-y-1">
                      {dictationBlockers.map((blocker) => (
                        <li key={blocker}>• {blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-sm leading-6 text-muted-foreground">
                  Permission and insert tests may open macOS settings, show system prompts, or send test text to the current app. Run them when you are at this Mac.
                </p>
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
                    Reset Accessibility permission
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

            <Card className={meetingReady ? "border-gold/40" : "border-rust/40"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorUp className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Meetings
                </CardTitle>
                <CardDescription>
                  Recording a call. Your microphone alone, or your microphone plus what the other
                  people say.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="flex items-start gap-2 text-sm">
                  <span
                    className={meetingReady ? "neume neume-lit mt-1.5" : "neume neume-rust mt-1.5"}
                    aria-hidden="true"
                  />
                  <span>
                    {meetingRoute.reason
                      ? meetingRoute.reason
                      : fullCaptureReady
                        ? "Both sides of a call will be recorded and transcribed."
                        : meetingReady
                          ? "Mic-only meetings are ready. Test system audio to also capture the other people on the call."
                          : "Meetings still need microphone input, permission, or a transcription engine that can handle a call."}
                  </span>
                </p>
                <StatusRows
                  rows={[
                    { label: "Transcribed by", value: meetingRoute.summary },
                    {
                      label: "Meeting policy",
                      value: meetingRoutePolicy === "best_available" ? "Best available" : "Prefer local",
                    },
                    {
                      label: "System audio",
                      value:
                        systemAudioAvailable === null
                          ? "Checking"
                          : fullCaptureReady
                            ? "Verified"
                            : systemAudioAvailable
                              ? "Found, not yet tested"
                              : "Not detected",
                    },
                    { label: "Audio device", value: loopbackDevice ?? "Not found" },
                    {
                      label: "Meeting capture mode",
                      value:
                        meetingCaptureMode === "me_and_them"
                          ? "Me + Them verified"
                          : meetingCaptureMode === "mic_only" && meetingReady
                            ? "Mic only ready"
                            : meetingCaptureMode === "mic_only"
                              ? "Not ready"
                              : "Checking",
                    },
                  ]}
                />
                <p className="text-sm text-muted-foreground">
                  {meetingCaptureMode === "me_and_them"
                    ? "Microphone, transcription, and sound from the other people were all tested and heard."
                    : meetingReady && systemAudioAvailable
                      ? "Mic-only meetings are ready. A way to capture the other people exists but has never been tested; run Test system audio first."
                      : meetingReady
                        ? "Mic-only meetings are ready. Only your side of the call is recorded until system audio is set up and tested."
                        : meetingCaptureMode === "unknown"
                          ? "Checking the microphone, transcription, and sound from other people."
                          : "The microphone, its permission, or the transcription engine still needs attention."}
                </p>
                {meetingBlockers.length > 0 ? (
                  <div className="rounded-lg border border-rust/20 bg-rust/5 px-3 py-2 text-sm">
                    <p className="mb-1 font-medium">Still missing</p>
                    <ul className="space-y-1">
                      {meetingBlockers.map((blocker) => (
                        <li key={blocker}>• {blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {meetingReady && !fullCaptureReady && fullCaptureBlockers.length > 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
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
                    Test meetings
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
                  <Button variant="outline" onClick={() => requestMainView("settings")}>
                    Open settings
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Transcription engines
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
            <CardContent className="space-y-0">
              {loading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking which engines are ready…
                </div>
              ) : (
                sortedProviders.map((provider) => {
                  const downloadKey = `download-${provider.providerType}`;
                  const canDownload =
                    provider.runtimeStatus === "missing_model" &&
                    isDownloadableProvider(provider.providerType);
                  const actionVariant = providerActionVariant(provider);
                  const modelLabel =
                    provider.modelOptions.find((option) => option.id === provider.selectedModelId)
                      ?.label ?? provider.selectedModelId;

                  return (
                    <div
                      key={provider.providerType}
                      className="border-t border-border/60 py-4 first:border-t-0 first:pt-0"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{provider.name}</p>
                            {providerBadge(provider)}
                            <Badge variant="secondary">
                              {providerCapabilityLabel(provider.providerType)}
                            </Badge>
                            <Badge variant="outline">
                              {providerHostingLabel(provider.providerType)}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{modelLabel}</p>
                          <p className="text-sm text-muted-foreground">
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
                          <p className="text-sm text-muted-foreground">
                            Recognition stays on this Mac; Apple's server fallback is disabled.
                          </p>
                        ) : null}
                        {isCloudProvider(provider.providerType) && provider.runtimeStatus !== "ready" ? (
                          <p className="text-sm text-muted-foreground">
                            Cloud engines usually need an API key added in Settings before they work.
                          </p>
                        ) : null}
                        {provider.runtimeDetails.missingFiles?.length ? (
                          <p className="text-sm text-rust">
                            Missing:{" "}
                            <span className="font-mono">
                              {provider.runtimeDetails.missingFiles.join(", ")}
                            </span>
                          </p>
                        ) : null}
                        {provider.runtimeDetails.setupAction ? (
                          <p className="text-sm text-muted-foreground">
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
        </div>
      </div>
    </div>
  );
}
