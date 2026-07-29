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

export type DictationPhaseTone = "idle" | "active" | "success" | "error";

interface DictationCaptureHeroProps {
  phase: DictationPhase;
  phaseTitle: string;
  phaseDetail: string;
  phaseTone: DictationPhaseTone;
  isCaptureLive: boolean;
  isBusy: boolean;
  formattedDuration: string;
  hotkeyInstruction: string;
  hotkeyPressed: boolean;
  livePreview: string | null;
  activeProfileTitle: string;
  resolvedModeLabel: string | null;
  smartContextSummary: string;
  isReadingSelectedText: boolean;
  onStart: () => void;
  onStop: () => void;
  onReadSelectedText: () => void;
}

/**
 * The signature surface of the Dictation page: the mic, the resolved hotkey,
 * live state, and the single earned gold CTA. Everything configuration-shaped
 * lives below it.
 */
export function DictationCaptureHero({
  phase,
  phaseTitle,
  phaseDetail,
  phaseTone,
  isCaptureLive,
  isBusy,
  formattedDuration,
  hotkeyInstruction,
  hotkeyPressed,
  livePreview,
  activeProfileTitle,
  resolvedModeLabel,
  smartContextSummary,
  isReadingSelectedText,
  onStart,
  onStop,
  onReadSelectedText,
}: DictationCaptureHeroProps) {
  const ringToneClass = isCaptureLive
    ? "border-gold/20 bg-gold/5"
    : phase === "done"
      ? "border-gold/20 bg-gold/5"
      : phase === "error"
        ? "border-rust/30 bg-rust/10"
        : hotkeyPressed
          ? "border-gold/30 bg-gold/5"
          : "border-border bg-muted/20";

  return (
    <Card
      className={cn(
        "border transition-colors duration-200",
        isBusy ? "border-gold/40" : "border-border/60",
      )}
    >
      <CardContent className="space-y-6 p-6">
        <div className="min-w-0">
          <h2 className="section-heading">Capture</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {hotkeyInstruction}
          </p>
        </div>

        <div className="flex flex-col items-center gap-5 py-2">
          <div
            className={cn(
              "relative flex h-24 w-24 items-center justify-center rounded-full border transition-transform duration-150",
              ringToneClass,
              isCaptureLive && "gilt-halo",
              hotkeyPressed && !isCaptureLive && "scale-[1.03]",
            )}
          >
            {isCaptureLive ? (
              <>
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full border border-gold/20 animate-ping opacity-40"
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-[10px] rounded-full border border-gold/20 opacity-60"
                />
                <Mic className="relative h-10 w-10 text-gold" />
              </>
            ) : isBusy ? (
              <RefreshCw className="h-10 w-10 animate-spin text-foreground" />
            ) : phase === "done" ? (
              <CheckCircle2 className="h-10 w-10 text-gold-text" />
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
                    "relative h-10 w-10 transition-colors",
                    hotkeyPressed ? "text-gold" : "text-muted-foreground",
                  )}
                />
              </>
            )}
          </div>

          <div className="text-center">
            <p className="text-lg font-medium">
              <span
                aria-hidden="true"
                className={cn(
                  "mr-2 align-middle neume",
                  phaseTone === "error"
                    ? "neume-rust"
                    : phaseTone === "idle"
                      ? "neume-hollow"
                      : "neume-lit",
                  isCaptureLive && "neume-live",
                )}
              />
              {phaseTitle}
            </p>
            {isCaptureLive ? (
              <p className="time-spec mt-2 font-mono text-3xl font-semibold text-foreground">
                {phase === "recording" ? formattedDuration : "--:--"}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{phaseDetail}</p>
            )}
          </div>

          {isCaptureLive ? (
            <Button variant="outline" size="lg" onClick={onStop}>
              <Square className="mr-2 h-4 w-4 fill-current" />
              Stop dictation
            </Button>
          ) : isBusy ? (
            <Button variant="outline" size="lg" disabled>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {phase === "delivering" ? "Inserting..." : "Working..."}
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

        <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-3">
          <div className="min-w-0">
            <p className="rubric-muted">Profile</p>
            <p className="mt-1 text-sm font-medium">{activeProfileTitle}</p>
            {resolvedModeLabel ? (
              <p className="mt-1 font-mono text-sm text-muted-foreground">
                Runtime mode: {resolvedModeLabel}
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
