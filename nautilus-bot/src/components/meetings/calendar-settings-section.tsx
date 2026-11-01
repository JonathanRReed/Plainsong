import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SettingsSwitch } from "@/components/ui/settings-control";
import {
  CalendarAccessCard,
  showsCalendarAccessCard,
} from "@/components/meetings/calendar-access-card";
import { useCalendarEvents } from "@/hooks/use-calendar-events";
import { openCalendarPrivacySettings } from "@/lib/backend/calendar";
import { isMacPlatform } from "@/lib/shortcuts";
import {
  setCalendarIgnored,
  writeCalendarDisconnected,
} from "@/lib/calendar-preferences";

/**
 * Where a connected calendar is turned back off, per calendar or entirely.
 *
 * Two levers rather than one because they answer different questions.
 * "Suggest meetings from my calendar" is Plainsong's own switch: turning it off
 * stops Plainsong reading the calendar at all, macOS keeps the grant, and
 * turning it back on costs a click rather than another trip through System
 * Settings. The per-calendar list is the one people actually
 * need — a subscribed holidays calendar and a partner's shared calendar are
 * both "meetings" to EventKit and neither is something to offer to record.
 *
 * Before macOS has granted access it shows the same card as the Meetings
 * header: the Connect opt-in, which asks macOS only when clicked and says what
 * came back, or where the switch is when macOS said no. Searching Settings for
 * the calendar therefore always lands on something to do. Failed checks keep
 * recovery available. With no answer to give (another platform, a missing
 * helper) it renders nothing.
 */
export function CalendarSettingsSection() {
  const calendar = useCalendarEvents();

  const connectionSwitch = (
    <SettingsSwitch
      className="py-0"
      label="Suggest meetings from your calendar"
      description="Shows the meeting you are about to join at the top of Meetings, with a button that starts capture using its name. Turning this off stops Plainsong reading your calendar until you turn it back on. macOS keeps the permission; to revoke that, use System Settings."
      checked={!calendar.disconnected}
      onCheckedChange={(checked) => void writeCalendarDisconnected(!checked)}
    />
  );

  // Disconnected means nothing is read, including whether macOS still grants
  // access, so this is the one place to turn it back on.
  if (calendar.disconnected) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="section-heading">Calendar</h3>
          <p className="text-sm text-muted-foreground">
            Plainsong is not reading your calendar. Turn this on to reconnect it.
          </p>
        </div>
        {connectionSwitch}
      </div>
    );
  }

  if (calendar.snapshot.observedAt === 0) return null;

  // Only macOS has a calendar to recover; elsewhere a failed check stays hidden.
  if (calendar.view === "check_failed" && isMacPlatform()) {
    return (
      <section aria-label="Calendar" className="space-y-3">
        <h3 className="section-heading">Calendar</h3>
        <p role="alert">Couldn't check calendar access.</p>
        <Button size="sm" variant="outline" onClick={() => void calendar.refresh()}>Retry</Button>
        <Button size="sm" variant="outline" onClick={() => void openCalendarPrivacySettings()}>Open System Settings</Button>
      </section>
    );
  }

  if (calendar.snapshot.authorization !== "authorized") {
    if (!showsCalendarAccessCard(calendar.view)) {
      return null;
    }
    return (
      <div className="space-y-3">
        <h3 className="section-heading">Calendar</h3>
        <CalendarAccessCard calendar={calendar} />
      </div>
    );
  }

  const ignored = new Set(calendar.ignoredCalendarIds);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="section-heading">Calendar</h3>
        <p className="text-sm text-muted-foreground">
          macOS has already given Plainsong read access to your calendars. This
          is where you narrow that down or switch it back off.
        </p>
      </div>
      {connectionSwitch}

      <div className="space-y-2">
        <Label>Calendars for meeting suggestions</Label>
        <p className="text-sm text-muted-foreground">
          Turn off the ones that are not meetings — holidays, birthdays,
          anything subscribed.
        </p>
        <div className="space-y-1">
          {calendar.snapshot.calendars.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              macOS returned no calendars for this account.
            </p>
          ) : (
            calendar.snapshot.calendars.map((entry) => (
              <SettingsSwitch
                key={entry.id}
                className="py-1.5"
                label={entry.title}
                description={
                  entry.accountName
                    ? `From ${entry.accountName}. On means its events can be suggested as meetings.`
                    : "On means its events can be suggested as meetings."
                }
                checked={!ignored.has(entry.id)}
                onCheckedChange={(checked) =>
                  setCalendarIgnored(entry.id, !checked)
                }
              />
            ))
          )}
        </div>
      </div>

      <Button
        size="sm"
        variant="outline"
        onClick={() => void openCalendarPrivacySettings()}
      >
        Manage calendar access in System Settings
      </Button>
    </div>
  );
}
