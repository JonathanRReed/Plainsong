import { useEffect, useState } from "react";
import { SettingsSwitch } from "@/components/ui/settings-control";
import {
  contactsAccessGranted,
  getContactsAccessStatus,
  requestContactsAccess,
  type ContactsAuthorization,
} from "@/lib/backend/contacts";
import { isMacPlatform } from "@/lib/shortcuts";

const CONTACT_NAMES_DESCRIPTION =
  "Use names from Contacts to spell people's names. Stays on this Mac.";

const DENIED_DESCRIPTION =
  "Plainsong can't read Contacts. To allow it, turn on Plainsong in System Settings, Privacy & Security, Contacts, then turn this on again.";

/**
 * The opt-in for Contacts names in dictation. Off by default; macOS is asked
 * only when the switch is turned on, and the setting is saved only once
 * macOS says yes.
 */
export function ContactNamesSetting({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [authorization, setAuthorization] = useState<ContactsAuthorization | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!isMacPlatform()) return;
    let cancelled = false;
    void getContactsAccessStatus()
      .then((status) => {
        if (!cancelled) setAuthorization(status.authorization);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (
    !isMacPlatform() ||
    authorization === "unsupported_platform" ||
    authorization === "helper_unavailable"
  ) {
    return null;
  }

  const refused = authorization === "denied" || authorization === "restricted";

  const handleChange = async (checked: boolean) => {
    if (!checked) {
      onEnabledChange(false);
      return;
    }
    setPending(true);
    try {
      const status = await requestContactsAccess();
      setAuthorization(status.authorization);
      if (contactsAccessGranted(status.authorization)) onEnabledChange(true);
    } catch {
      // The switch stays off; turning it on again asks again.
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSwitch
      settingId="contact-names"
      label="Contacts"
      description={refused ? DENIED_DESCRIPTION : CONTACT_NAMES_DESCRIPTION}
      checked={enabled}
      disabled={pending}
      onCheckedChange={(checked) => void handleChange(checked)}
    />
  );
}
