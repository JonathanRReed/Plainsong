import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  CheckCircle2,
  Mic,
  RefreshCw,
  Square,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import type { DictationPhase } from "@/features/dictation/runtime";
import { GoldVoiceGlow } from "@/components/ui/voice-glow";
import { useDictationLevel } from "@/hooks/use-dictation-level";

export type DictationPhaseTone = "idle" | "active" | "success" | "error";

interface DictationCaptureHeroProps {
  compact?: boolean;
  phase: DictationPhase;
  phaseTitle: string;
  phaseDetail: string;
  phaseTone: DictationPhaseTone;
  isCaptureLive: boolean;
  isBusy: boolean;
  isStarting?: boolean;
  startBlockedReason?: string | null;
  isAvailable: boolean;
  unavailableTitle: string;
  unavailableDetail: string;
  unavailableActionLabel: string;
  unavailableActionBusy: boolean;
  unavailableRole: "alert" | "status";
  formattedDuration: ReactNode;
  hotkeyInstruction: string;
  hotkeyPressed: boolean;
  livePreview: string | null;
  speechModelLabel?: string;
  speechModelDetail?: string;
  textProcessingLabel?: string;
  textProcessingDetail?: string;
  activeProfileTitle: string;
  profilePicker?: ReactNode;
  resolvedModeLabel: string | null;
  smartContextSummary: string;
  isReadingSelectedText: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancelProcessing?: () => void;
  processingCancelling?: boolean;
  processingCancelError?: string | null;
  onReadSelectedText: () => void;
  onUnavailableAction: () => void;
  onChooseSpeechModel?: () => void;
}

/**
 * The signature surface of the Dictation page: the mic, the resolved hotkey,
 * live state, and the single earned gold CTA. Everything configuration-shaped
 * lives below it.
 */
export function DictationCaptureHero({
  compact = false,
  phase,
  phaseTitle,
  phaseDetail,
  phaseTone,
  isCaptureLive,
  isBusy,
  isStarting = false,
  startBlockedReason = null,
  isAvailable,
  unavailableTitle,
  unavailableDetail,
  unavailableActionLabel,
  unavailableActionBusy,
  unavailableRole,
  formattedDuration,
  hotkeyInstruction,
  hotkeyPressed,
  livePreview,
  speechModelLabel,
  speechModelDetail,
  textProcessingLabel,
  textProcessingDetail,
  activeProfileTitle,
  profilePicker,
  resolvedModeLabel,
  smartContextSummary,
  isReadingSelectedText,
  onStart,
  onStop,
  onCancelProcessing,
  processingCancelling = false,
  processingCancelError = null,
  onReadSelectedText,
  onUnavailableAction,
  onChooseSpeechModel,
}: DictationCaptureHeroProps) {
  const isUnavailable = !isAvailable && !isCaptureLive && !isBusy && !startBlockedReason;
  // The ring and status sit on a stage that glows with the voice while the
  // mic is live, then sweeps once while the words are set down.
  const voiceLevel = useDictationLevel(isCaptureLive && phase === "recording");
  // Readiness still being checked is a normal loading state, not a
  // problem: a spinner and a disabled "Checking…", never the rust warning.
  const isChecking = isUnavailable && unavailableRole === "status";
  const isCompact = (compact || isUnavailable) && !isCaptureLive && !isBusy && phaseTone !== "error" && (phase === "idle" || phase === "done");
  const iconClass = isCompact ? "h-5 w-5" : "h-10 w-10";
  const ringToneClass = isCaptureLive
    ? "border-gold/20 bg-gold/5"
    : isChecking
      ? "border-border bg-muted/20"
      : isUnavailable
        ? "border-rust/30 bg-rust/10"
      : phase === "done"
        ? "border-gold/20 bg-gold/5"
        : phase === "error"
          ? "border-rust/30 bg-rust/10"
          : hotkeyPressed
            ? "border-gold/30 bg-gold/5"
            : "border-border bg-muted/20";

  return (
    <Card
      role={isUnavailable ? unavailableRole : undefined}
      aria-label={isUnavailable ? "Dictation needs attention" : undefined}
      data-testid="dictation-capture-hero"
      data-layout={isCompact ? "compact" : "full"}
      className={cn(
        "border transition-colors duration-200",
        isBusy
          ? "border-gold/40"
          : isUnavailable && !isChecking
            ? "border-rust/30"
            : "border-border/60",
      )}
    >
      <CardContent className={isCompact ? "space-y-3 p-4" : "space-y-6 p-6"}>
        <div className="min-w-0">
          <h2 className="section-heading">Capture</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {hotkeyInstruction}
          </p>
        </div>

        <div className={isCompact ? "flex items-center gap-3" : "flex flex-col items-center gap-5 py-2"}>
          <GoldVoiceGlow
            className={isCompact ? "min-w-0 flex-1" : "w-full"}
            active={isCaptureLive || isBusy}
            level={voiceLevel}
            processing={isBusy}
          >
            <div className={isCompact ? "flex w-full items-center gap-3 rounded-xl" : "flex w-full flex-col items-center gap-5 rounded-xl pt-2 pb-8"}>
              <div
                className={cn(
                  "relative z-[5] flex shrink-0 items-center justify-center rounded-full border transition-transform duration-150",
                  isCompact ? "h-10 w-10" : "h-24 w-24",
                  ringToneClass,
                  isCaptureLive && "gilt-halo",
                  hotkeyPressed && !isCaptureLive && "scale-[1.03]",
                )}
              >
                {isCaptureLive ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute inset-[10px] rounded-full border border-gold/20 opacity-60"
                    />
                    <Mic className="relative h-10 w-10 text-gold" />
                  </>
                ) : isBusy ? (
                  <RefreshCw className="h-10 w-10 animate-spin text-foreground" />
                ) : isChecking ? (
                  <RefreshCw className={cn(iconClass, "animate-spin text-muted-foreground")} />
                ) : isUnavailable ? (
                  <TriangleAlert className={cn(iconClass, "text-rust")} />
                ) : phase === "done" ? (
                  <CheckCircle2 className={cn(iconClass, "text-gold-text")} />
                ) : phase === "error" ? (
                  <TriangleAlert className="h-10 w-10 text-rust" />
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute inset-0 rounded-full border transition-all duration-150",
                        hotkeyPressed
                          ? "border-gold/30 opacity-100"
                          : "border-border/60 opacity-70",
                      )}
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute inset-[10px] rounded-full border transition-all duration-150",
                        hotkeyPressed
                          ? "border-gold/25 opacity-100"
                          : "border-border/50 opacity-70",
                      )}
                    />
                    <Mic
                      className={cn(
                        "relative transition-colors",
                        iconClass,
                        hotkeyPressed ? "text-gold" : "text-muted-foreground",
                      )}
                    />
                  </>
                )}
              </div>

              <div className={cn("relative z-[5]", isCompact ? "min-w-0 text-left" : "text-center")}>
                {/* Polite and atomic, so a phase change ("Listening",
                    "Transcribing") is read out; the running timer below is
                    outside it on purpose. */}
                <p
                  className={cn("font-medium", isCompact ? "text-sm" : "text-lg")}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mr-2 align-middle neume",
                      (isUnavailable && !isChecking) || phaseTone === "error"
                        ? "neume-rust"
                        : phaseTone === "idle"
                          ? "neume-hollow"
                          : "neume-lit",
                      isCaptureLive && "neume-live",
                    )}
                  />
                  {isUnavailable ? unavailableTitle : phaseTitle}
                </p>
                {isCaptureLive ? (
                  phase === "recording" ? (
                    <p className="time-spec mt-2 font-mono text-3xl font-semibold text-foreground">
                      {formattedDuration}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {phaseDetail}
                    </p>
                  )
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {startBlockedReason && !isCaptureLive && !isBusy
                      ? startBlockedReason : isUnavailable ? unavailableDetail : phaseDetail}
                  </p>
                )}
              </div>
            </div>
          </GoldVoiceGlow>

          {isCaptureLive || phase === "preparing" ? (
            <Button variant="outline" size="lg" onClick={onStop}>
              <Square className="mr-2 h-4 w-4 fill-current" />
              {phase === "preparing" ? "Cancel dictation" : "Stop dictation"}
            </Button>
          ) : isBusy && (phase === "stopping" || phase === "transcribing") && onCancelProcessing ? (
            <div className="space-y-2 text-center">
              <Button variant="outline" size="lg" disabled={processingCancelling} onClick={onCancelProcessing}>
                <Square className="mr-2 h-4 w-4" />
                {processingCancelling ? "Cancelling…" : "Cancel dictation"}
              </Button>
              {processingCancelError && <p role="alert" className="text-sm text-rust">{processingCancelError}</p>}
            </div>
          ) : isBusy ? (
            <Button variant="outline" size="lg" disabled>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {isStarting && (phase === "idle" || phase === "done" || phase === "error")
                ? "Starting…" : phase === "delivering" ? "Inserting…" : "Working…"}
            </Button>
          ) : startBlockedReason ? (
            <Button variant="outline" size="lg" disabled title={startBlockedReason}>
              Meeting in progress
            </Button>
          ) : isChecking ? (
            <Button variant="outline" size="lg" disabled>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Checking…
            </Button>
          ) : isUnavailable ? (
            <Button
              variant="outline"
              size="lg"
              onClick={onUnavailableAction}
              disabled={unavailableActionBusy}
            >
              {unavailableActionBusy ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <TriangleAlert className="mr-2 h-4 w-4" />
              )}
              {unavailableActionLabel}
            </Button>
          ) : (
            <Button variant="default" size="lg" onClick={onStart}>
              <Mic className="mr-2 h-4 w-4" />
              {phase === "error"
                ? "Retry dictation"
                : phase === "done"
                  ? "Start next dictation"
                  : "Start dictation"}
            </Button>
          )}
        </div>

        {livePreview ? (
          <p className="manuscript rounded-md border border-gold/20 bg-gold/5 px-4 py-3 text-sm">
            {livePreview}
          </p>
        ) : null}

        {(speechModelLabel || textProcessingLabel) && (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/60 pt-3 text-sm">
            {speechModelLabel && (
              <div className="min-w-0">
                <dt className="inline text-muted-foreground">Speech </dt>
                <dd className="inline break-words font-medium">{speechModelLabel}</dd>
                {onChooseSpeechModel && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-1 h-7 px-2 text-xs"
                    disabled={isCaptureLive || isBusy}
                    onClick={onChooseSpeechModel}
                  >
                    Change speech model
                  </Button>
                )}
                {speechModelDetail && (
                  <dd className="mt-1 text-xs text-muted-foreground">{speechModelDetail}</dd>
                )}
              </div>
            )}
            {textProcessingLabel && (
              <div className="min-w-0">
                <dt className="inline text-muted-foreground">After recording </dt>
                <dd className="inline font-medium">{textProcessingLabel}</dd>
                {textProcessingDetail && (
                  <dd className="mt-1 text-xs text-muted-foreground">{textProcessingDetail}</dd>
                )}
              </div>
            )}
          </dl>
        )}

        <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-3">
          <div className="min-w-0">
            <p className="rubric-muted">Profile</p>
            {profilePicker ?? <p className="mt-1 text-sm font-medium">{activeProfileTitle}</p>}
            {resolvedModeLabel ? (
              <p className="mt-1 font-mono text-sm text-muted-foreground">
                Mode in use: {resolvedModeLabel}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 sm:col-span-2">
            <p className="rubric-muted">Context</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {smartContextSummary}
            </p>
          </div>
        </div>

        {!isCaptureLive && !isBusy ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onReadSelectedText}>
              <Volume2 className="mr-2 h-4 w-4" />
              {isReadingSelectedText ? "Stop reading" : "Read selected text"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
