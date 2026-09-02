import { Button } from "@/components/ui/button";
import { PhoneCall } from "lucide-react";
import { useDetectedCall } from "@/hooks/use-detected-call";
import {
  buildDetectedCallCapturePrefill,
  describeDetectedCall,
  detectedCallIsOfferable,
  type DetectedCallCapturePrefill,
} from "@/lib/detected-call";

interface DetectedCallCueProps {
  /**
   * Starts a meeting named after the call. The view owns what "start" means —
   * the consent dialog, the template picker, the readiness check — so this
   * component only ever hands over the prefill. Nothing here records.
   */
  onStartCapture: (prefill: DetectedCallCapturePrefill) => void;
  /** Hidden outright while a meeting is running: there is nothing to offer. */
  captureInProgress: boolean;
}

/**
 * The Meetings header's live-call affordance, sibling to the calendar cue.
 *
 * One line, and most of the time nothing. It appears when the sidecar has
 * seen a conferencing app with a call in progress for two polls running, and
 * goes away when the call ends or the reader dismisses it. The dismissal is
 * per call: waving away this Zoom call does not silence the next one.
 *
 * The state glyph is the hollow rust neume — "not yet", an offer standing
 * open — and the controls are the rubric outline, never gold: the earned
 * gold moment is the recording itself, which this cue does not start.
 */
export function DetectedCallCue({ onStartCapture, captureInProgress }: DetectedCallCueProps) {
  const detected = useDetectedCall({ enabled: !captureInProgress });
  const call = detected.call;
  if (!detectedCallIsOfferable(call, captureInProgress) || !call) {
    return null;
  }
  const prefill = buildDetectedCallCapturePrefill(call);
  if (!prefill) {
    return null;
  }

  return (
    <div
      className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rust/30 bg-muted/30 px-4 py-2.5"
      role="status"
      aria-label="Call in progress"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="neume neume-hollow shrink-0" aria-hidden="true" />
        <PhoneCall className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 truncate text-sm">
          <span className="font-medium">{describeDetectedCall(call)}</span>
          <span className="text-muted-foreground"> · Record it with Plainsong?</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" onClick={() => onStartCapture(prefill)}>
          Start capture
        </Button>
        <Button
          size="sm"
          variant="ghost"
          // Scoped to this call's id on the sidecar side, so the next call in
          // the same app is offered again.
          onClick={() => void detected.dismiss(call.callId)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
