import { Button } from "@/components/ui/button";
import { CalendarClock, Video } from "lucide-react";
import {
  buildCalendarCapturePrefill,
  videoServiceLabel,
  type CalendarCapturePrefill,
} from "@/lib/calendar-events";
import { PreMeetingBriefPanel } from "@/components/meetings/pre-meeting-brief-panel";
import { useCalendarEvents } from "@/hooks/use-calendar-events";
import {
  CalendarAccessCard,
  showsCalendarAccessCard,
} from "@/components/meetings/calendar-access-card";

interface CalendarMeetingCueProps {
  /**
   * Starts a meeting with the event's title already on it. The view owns what
   * "start" means — the consent dialog, the template picker, the readiness
   * check — so this component only ever hands over the prefill.
   */
  onStartCapture: (prefill: CalendarCapturePrefill) => void;
  /** Hidden outright while a meeting is running: there is nothing to offer. */
  captureInProgress: boolean;
  /** Opens a prior meeting the brief cited, when the view can. */
  onOpenMeeting?: (recordingId: string) => void;
}

/**
 * The Meetings header's one calendar affordance.
 *
 * It renders at most one line, and most of the time nothing at all. The four
 * things it can be are the four honest answers to "does Plainsong know what
 * you are about to join":
 *
 *   - a meeting is coming up      → the offer, with a dismiss
 *   - macOS has not been asked    → an opt-in card, never a prompt
 *   - macOS said no               → where the switch is, in words
 *   - anything else               → nothing
 *
 * That last case is deliberate and covers more than it looks like: a Windows
 * build, a missing helper, an unparseable answer, a granted calendar with no
 * meeting in the next half hour. None of them is a problem the reader has to
 * hear about while looking at their meetings.
 *
 * Nothing here touches readiness. A Mac with no calendar access records
 * meetings exactly as well as one with it, and the readiness system is
 * deliberately never told this component exists.
 */
export function CalendarMeetingCue({
  onStartCapture,
  captureInProgress,
  onOpenMeeting,
}: CalendarMeetingCueProps) {
  const calendar = useCalendarEvents();

  if (captureInProgress) {
    return null;
  }

  if (showsCalendarAccessCard(calendar.view)) {
    return <CalendarAccessCard calendar={calendar} className="mx-6 mb-4" />;
  }

  const connectResult = calendar.connectResult;
  const event = calendar.nextEvent;
  const lead = calendar.lead;
  if (!event || !lead) {
    // Right after a successful Connect there is often no meeting in the next
    // half hour, and an empty header would read as "nothing happened".
    if (calendar.view === "connected" && connectResult?.kind === "connected") {
      return (
        <p className="mx-6 mb-4 text-sm text-muted-foreground" role="status">
          Calendar connected. Plainsong will offer to start capture when a
          meeting is coming up.
        </p>
      );
    }
    return null;
  }
  const prefill = buildCalendarCapturePrefill(event);
  if (!prefill) {
    return null;
  }

  return (
    <div
      className="mx-6 mb-4 rounded-md border border-border/80 bg-muted/30 px-4 py-2.5"
      role="status"
      aria-label="Next meeting on your calendar"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="min-w-0 truncate text-sm">
            <span className="font-medium">{event.title}</span>
            <span className="text-muted-foreground"> {lead.text}</span>
            {event.videoService ? (
              <span className="text-muted-foreground">
                {" · "}
                <Video className="inline h-3.5 w-3.5 align-[-0.15em]" aria-hidden="true" />{" "}
                {videoServiceLabel(event.videoService)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {prefill.conferenceUrl ? (
            <Button size="sm" onClick={() => onStartCapture(prefill)}>
              Join and capture
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => onStartCapture({ ...prefill, conferenceUrl: undefined })}>
            Start capture
          </Button>
          <Button
            size="sm"
            variant="ghost"
            // The whole event, so the dismissal is scoped to this occurrence:
            // waving away today's standup must not silence next Tuesday's.
            onClick={() => calendar.dismiss(event)}
          >
            Dismiss
          </Button>
        </div>
      </div>
      {/* Keyed on the occurrence, not the identifier: a weekly standup reuses
          its EventKit id, and a brief prepared for last Tuesday must not
          appear under this Tuesday's cue. */}
      <PreMeetingBriefPanel
        key={`${event.id}@${event.startsAt}`}
        event={event}
        onOpenMeeting={onOpenMeeting}
      />
    </div>
  );
}
