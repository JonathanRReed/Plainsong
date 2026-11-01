import { getSettings, updateSettings } from "@/lib/backend";
import { useEffect, useState } from "react";
import { ContactNamesSetting } from "./contact-names-setting";
import { SettingsSwitch } from "@/components/ui/settings-control";
import { useCalendarEvents } from "@/hooks/use-calendar-events";
import { getCalendarSnapshot } from "@/lib/backend/calendar";
import { writeCalendarDisconnected } from "@/lib/calendar-preferences";
import { isMacPlatform } from "@/lib/shortcuts";

export function NameSourcesSetting({ calendarEnabled, contactsEnabled, onCalendarChange, onContactsChange }: {
  calendarEnabled: boolean;
  contactsEnabled: boolean;
  onCalendarChange: (enabled: boolean) => void;
  onContactsChange: (enabled: boolean) => void;
}) {
  const calendar = useCalendarEvents({ enabled: false });
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState(false);
  if (!isMacPlatform()) return null;
  const changeCalendar = async (enabled: boolean) => {
    if (!enabled) { onCalendarChange(false); return; }
    setPending(true);
    setProblem(false);
    try {
      // Consume the native gesture before any settings I/O can expire it.
      await calendar.connect({ reconnect: true });
      await writeCalendarDisconnected(false);
      const snapshot = await getCalendarSnapshot({ forceRefresh: true });
      if (snapshot.authorization === "authorized") onCalendarChange(true);
      else setProblem(true);
    } catch { setProblem(true); }
    finally { setPending(false); }
  };
  return (
    <section aria-label="Use names from my calendar and contacts to spell names">
      <h3 className="section-heading pt-3.5">Use names from my calendar and contacts to spell names</h3>
      <p className="mt-1 text-sm text-muted-foreground">Names stay on this Mac and aren't saved.</p>
      <SettingsSwitch
        settingId="calendar-names" label="Calendar"
        description={problem ? "Allow Calendars for Plainsong in System Settings, Privacy & Security, then try again." : "Uses attendee names from the past week and next two days."}
        checked={calendarEnabled && !calendar.disconnected} disabled={pending}
        onCheckedChange={(enabled) => void changeCalendar(enabled)}
      />
      <ContactNamesSetting enabled={contactsEnabled} onEnabledChange={onContactsChange} />
    </section>
  );
}

/** The same opt-ins offered alongside calendar connection. */
export function SavedNameSourcesSetting() {
  const [enabled, setEnabled] = useState({ calendar: false, contacts: false });
  useEffect(() => {
    let cancelled = false;
    void getSettings().then((settings) => {
      if (!cancelled) setEnabled({ calendar: settings.transcription?.dictationCalendarNames === true,
        contacts: settings.transcription?.dictationContactNames === true });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const save = async (source: "calendar" | "contacts", value: boolean) => {
    try {
      await updateSettings((draft) => {
        if (source === "calendar") draft.transcription.dictationCalendarNames = value;
        else draft.transcription.dictationContactNames = value;
      });
      setEnabled((previous) => ({ ...previous, [source]: value }));
    } catch { /* Keep the saved choice when a settings write fails. */ }
  };
  return <NameSourcesSetting calendarEnabled={enabled.calendar} contactsEnabled={enabled.contacts}
    onCalendarChange={(value) => void save("calendar", value)}
    onContactsChange={(value) => void save("contacts", value)} />;
}
