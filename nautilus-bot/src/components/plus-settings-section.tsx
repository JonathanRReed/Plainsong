import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  activatePlus,
  formatHours,
  getPlusStatus,
  signOutPlus,
  type PlusStatus,
} from "@/lib/plus";

/**
 * Plainsong Plus account: license key in, usage out. NOT LAUNCHED.
 *
 * Renders nothing unless the sidecar was built with the `plainsong-plus`
 * feature, which no release is, the same way the calendar section renders
 * nothing until macOS grants access. Picking Plus as a route happens where
 * every other route is picked (Models); this is only the account.
 */
export function PlusSettingsSection() {
  const [status, setStatus] = useState<PlusStatus | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getPlusStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status?.available) {
    return null;
  }

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await activatePlus(licenseKey));
      setLicenseKey("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutPlus();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const usage = status.usage;

  return (
    <div className="pt-4 border-t space-y-4">
      <div className="space-y-1">
        <p className="section-heading">Plainsong Plus</p>
        <p className="text-sm text-muted-foreground">
          Hosted transcription and cleanup on the most accurate models we can
          find, for $10 a month. Local models stay free and keep working if
          you never sign in, and take over if a month's allowance runs out.
        </p>
      </div>

      {status.signedIn ? (
        <div className="space-y-3">
          {usage ? (
            <p className="text-sm">
              This month: {formatHours(usage.usage.dictationSeconds ?? 0)} of{" "}
              {formatHours(usage.caps.dictationSeconds)} dictation hours,{" "}
              {formatHours(usage.usage.meetingSeconds ?? 0)} of{" "}
              {formatHours(usage.caps.meetingSeconds)} meeting hours.
            </p>
          ) : null}
          {status.error ? (
            <p className="text-sm text-muted-foreground">{status.error}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Choose Plainsong Plus in Models for dictation, cleanup, or both.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
            Sign out on this Mac
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="plus-license-key">License key</Label>
          <div className="flex gap-2">
            <Input
              id="plus-license-key"
              value={licenseKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="From your Plainsong Plus receipt"
              error={Boolean(error)}
              onChange={(event) => setLicenseKey(event.target.value)}
            />
            <Button
              disabled={busy || licenseKey.trim().length === 0}
              onClick={() => void activate()}
            >
              {busy ? "Checking…" : "Activate"}
            </Button>
          </div>
          {error ? <p className="text-sm text-rust">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
