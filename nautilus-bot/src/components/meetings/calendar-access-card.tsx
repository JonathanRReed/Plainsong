import { SavedNameSourcesSetting } from "@/components/settings/name-sources-setting";
import { Button } from "@/components/ui/button";
import { CalendarClock } from "lucide-react";
import type { CalendarEventsState } from "@/hooks/use-calendar-events";
import type { CalendarPermissionView } from "@/lib/calendar-events";
import { openCalendarPrivacySettings } from "@/lib/backend/calendar";
import { cn } from "@/lib/utils";

/** The permission views this card answers; every other view renders nothing. */
export function showsCalendarAccessCard(view: CalendarPermissionView): boolean {
  return (
    view === "connect" ||
    view === "denied" ||
    view === "write_only" ||
    view === "restricted"
  );
}

interface CalendarAccessCardProps {
  /** The caller's calendar state, so the card and its host share one poll. */
  calendar: CalendarEventsState;
  className?: string;
}

/**
 * Calendar access before macOS has granted it: the opt-in, or where the
 * switch is when macOS said no.
 *
 * Shown in the Meetings header and in Settings > Meetings, so both places
 * answer a Connect click the same way: what happened, and the one place the
 * reader can fix it. Connect is the only path to the macOS prompt, and it
 * follows this card's click and nothing else.
 */
export function CalendarAccessCard({ calendar, className }: CalendarAccessCardProps) {
  const connectResult = calendar.connectResult;
  const connectProblem =
    connectResult?.kind === "no_prompt"
      ? "macOS didn't show a calendar prompt, so access is still off. Check Plainsong in System Settings › Privacy & Security › Calendars."
      : connectResult?.kind === "failed"
        ? `${connectResult.message} You can also turn on Plainsong in System Settings › Privacy & Security › Calendars.`
        : null;

  if (calendar.view === "connect") {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/80 bg-muted/30 px-4 py-3",
          className,
        )}
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
              in. Calendar details stay on this Mac, and Plainsong never changes
              your calendar. Join and capture opens the conference link in your
              browser after you confirm capture.
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
        <div className="w-full border-t border-border/60 pt-3"><SavedNameSourcesSetting /></div>
        {connectProblem ? (
          // A click that changed nothing must still visibly answer: what
          // happened, and the one place the reader can fix it.
          <div
            className="flex w-full flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3"
            role="alert"
          >
            <p className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
              {connectProblem}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void openCalendarPrivacySettings()}
            >
              Open System Settings
            </Button>
          </div>
        ) : null}
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
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/80 bg-muted/30 px-4 py-3",
          className,
        )}
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
      <p className={cn("text-sm text-muted-foreground", className)} role="status">
        Calendar access is managed by this Mac's profile, so Plainsong can't
        read your calendar. Meetings record normally.
      </p>
    );
  }

  return null;
}
