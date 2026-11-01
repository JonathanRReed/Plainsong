import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsErrorMessage } from "@/components/settings/settings-error-message";
import {
  getNotePublishSettings,
  selectNotePublishLocation,
  saveNotePublishConfig,
  type NotePublishConfig,
  type NotePublishSettings,
} from "@/lib/backend/publishing";

export function NotePublishSettingsSection() {
  const descriptionId = useId();
  const [settings, setSettings] = useState<NotePublishSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getNotePublishSettings()
      .then(value => { if (live) setSettings(value); })
      .catch(() => { if (live) setError("Couldn't load folder settings."); });
    return () => { live = false; };
  }, []);

  const save = async (config: NotePublishConfig) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await saveNotePublishConfig(config));
    } catch (cause) {
      setError(settingsErrorMessage(cause, "Couldn't save folder settings."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t py-5" aria-label="Save notes to a folder">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="publish-notes-enabled" className="text-sm font-medium">
          Save notes to a folder
        </label>
        <Switch
          id="publish-notes-enabled"
          aria-label="Save notes to a folder"
          aria-describedby={descriptionId}
          disabled={busy || !settings || (!settings.config.enabled && !settings.location?.approved)}
          checked={settings?.config.enabled ?? false}
          onCheckedChange={enabled => {
            if (settings) void save({ ...settings.config, enabled });
          }}
        />
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Saves newly finished notes and later edits as Markdown. Your folder's sync service may upload these files.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={busy || !settings}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const location = await selectNotePublishLocation();
              if (location && settings) {
                setSettings(await saveNotePublishConfig({
                  ...settings.config,
                  locationId: location.id,
                }));
              }
            } catch (cause) {
              setError(settingsErrorMessage(cause, "Couldn't choose the notes folder."));
            } finally {
              setBusy(false);
            }
          }}
        >
          Choose notes folder
        </Button>
        {settings?.location && <span className="text-sm">{settings.location.label}</span>}
      </div>
      {settings && (
        <>
          <label className="flex items-center justify-between gap-4 text-sm">
            Format
            <select
              aria-label="Notes format"
              aria-describedby={descriptionId}
              className="rounded border bg-background p-2"
              disabled={busy}
              value={settings.config.templateId}
              onChange={event => void save({ ...settings.config, templateId: event.target.value })}
            >
              <option value="meeting">Meeting notes</option>
              <option value="journal">Journal</option>
              <option value="interview">Interview</option>
              <option value="research">Research notes</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={settings.config.includeTranscript}
              onChange={event => void save({ ...settings.config, includeTranscript: event.target.checked })}
            />
            Include transcript
          </label>
        </>
      )}
      {error && <p role="alert" className="text-sm text-rust">{error}</p>}
    </section>
  );
}
