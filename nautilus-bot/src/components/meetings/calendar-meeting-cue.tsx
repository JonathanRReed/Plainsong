import { Button } from "@/components/ui/button";
import { CalendarClock, Video } from "lucide-react";
import {
  buildCalendarCapturePrefill,
  videoServiceLabel,
  type CalendarCapturePrefill,
} from "@/lib/calendar-events";
import { useCalendarEvents } from "@/hooks/use-calendar-events";
import { openCalendarPrivacySettings } from "@/lib/backend/calendar";

interface CalendarMeetingCueProps {
  /**
   * Starts a meeting with the event's title already on it. The view owns what
   * "start" means — the consent dialog, the template picker, the readiness
   * check — so this component only ever hands over the prefill.
   */
  onStartCapture: (prefill: CalendarCapturePrefill) => void;
  /** Hidden outright while a meeting is running: there is nothing to offer. */
  captureInProgress: boolean;
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
}: CalendarMeetingCueProps) {
  const calendar = useCalendarEvents();

  if (captureInProgress) {
    return null;
  }

  if (calendar.view === "connect") {
    return (
      <div
        className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/80 bg-muted/30 px-4 py-3"
        role="status"
        aria-label="Connect your calendar"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <CalendarClock
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Connect your calendar</p>
            {/* Says what it reads, what it does with it, and what it never
                does. All three are load-bearing: this is the moment the
                reader decides. */}
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Plainsong can read the next few hours of your calendar on this Mac
              and offer to start capture with the meeting's name already filled
              in. It reads titles and times, never writes to your calendar, and
              sends nothing anywhere.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={calendar.requesting}
          // The prompt follows this click and only this click. There is no
          // path from app launch to the macOS calendar dialog.
          onClick={() => void calendar.connect()}
        >
          {calendar.requesting ? "Waiting for macOS…" : "Connect calendar"}
        </Button>
      </div>
    );
  }

  if (calendar.view === "denied" || calendar.view === "write_only") {
    const message =
      calendar.view === "write_only"
        ? "Plainsong can add calendar events but not read them, so it can't offer to start capture. Turn on Calendars for Plainsong in System Settings › Privacy & Security › Calendars, choosing full access."
        : "Calendar access is turned off for Plainsong, so it can't offer to start capture. Turn it back on in System Settings › Privacy & Security › Calendars. Meetings record normally either way.";
    return (
      <div
        className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/80 bg-muted/30 px-4 py-3"
        role="status"
        aria-label="Calendar access is off"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <CalendarClock
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">Calendar access is off</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openCalendarPrivacySettings()}
        >
          Open System Settings
        </Button>
      </div>
    );
  }

  // "restricted" is a managed Mac, where there is no switch for the reader to
  // flip and no point sending them to look for one.
  if (calendar.view === "restricted") {
    return (
      <p
        className="mx-6 mb-4 text-sm text-muted-foreground"
        role="status"
      >
        Calendar access is managed by this Mac's profile, so Plainsong can't
        read your calendar. Meetings record normally.
      </p>
    );
  }

  const event = calendar.nextEvent;
  const lead = calendar.lead;
  if (!event || !lead) {
    return null;
  }
  const prefill = buildCalendarCapturePrefill(event);
  if (!prefill) {
    return null;
  }

  return (
    <div
      className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/80 bg-muted/30 px-4 py-2.5"
      role="status"
      aria-label="Next meeting on your calendar"
    >
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
        <Button size="sm" variant="outline" onClick={() => onStartCapture(prefill)}>
          Start capture
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => calendar.dismiss(event.id)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
