import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SettingsSwitch } from "@/components/ui/settings-control";
import { useCalendarEvents } from "@/hooks/use-calendar-events";
import { openCalendarPrivacySettings } from "@/lib/backend/calendar";
import {
  setCalendarIgnored,
  writeCalendarDisconnected,
} from "@/lib/calendar-preferences";

/**
 * Where a connected calendar is turned back off, per calendar or entirely.
 *
 * Two levers rather than one because they answer different questions.
 * "Suggest meetings from my calendar" is Plainsong's own switch: macOS keeps
 * the grant, and turning it back on costs a click rather than another trip
 * through System Settings. The per-calendar list is the one people actually
 * need — a subscribed holidays calendar and a partner's shared calendar are
 * both "meetings" to EventKit and neither is something to offer to record.
 *
 * The section renders nothing at all unless macOS has already granted access.
 * A settings page is not the place to ask for a permission: the ask lives on
 * the Meetings view, next to the thing it would improve.
 */
export function CalendarSettingsSection() {
  const calendar = useCalendarEvents();

  if (calendar.snapshot.authorization !== "authorized") {
    return null;
  }

  const ignored = new Set(calendar.ignoredCalendarIds);

  return (
    <div className="pt-4 border-t space-y-4">
      <div className="space-y-1">
        <p className="section-heading">Calendar</p>
        <p className="text-sm text-muted-foreground">
          macOS has already given Plainsong read access to your calendars. This
          is where you narrow that down or switch it back off.
        </p>
      </div>
      <SettingsSwitch
        className="py-0"
        label="Suggest meetings from your calendar"
        description="Shows the meeting you are about to join at the top of Meetings, with a button that starts capture using its name. Turning this off keeps the macOS permission; to revoke that, use System Settings."
        checked={!calendar.disconnected}
        onCheckedChange={(checked) => writeCalendarDisconnected(!checked)}
      />

      {calendar.disconnected ? null : (
        <div className="space-y-2">
          <Label>Calendars to read</Label>
          <p className="text-sm text-muted-foreground">
            Turn off the ones that are not meetings — holidays, birthdays,
            anything subscribed. Plainsong only ever reads titles and times.
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
      )}

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
