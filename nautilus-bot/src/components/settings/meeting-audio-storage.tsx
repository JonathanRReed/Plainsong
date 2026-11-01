import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsOptionSelect } from "@/components/settings/option-select";
import { SettingsInput, SettingsRow } from "@/components/ui/settings-control";
import type { TranscriptionSettings } from "@/types/settings";
import { freeMeetingAudio, getAudioStorageStatus, type AudioStorageStatus } from "@/lib/backend/audio-storage";
import { settingsErrorMessage } from "@/components/settings/settings-error-message";

const presets = ["never", "1w", "1m", "2m", "3m", "custom"] as const;
const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function storageSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${sizes.format(bytes / 1024 ** 3)} GB` : `${sizes.format(bytes / 1024 ** 2)} MB`;
}

export function MeetingAudioStorage({ transcription, onChange }: {
  transcription: Pick<TranscriptionSettings,
    "meetingRetentionPreset" | "meetingRetentionCustomMonths" | "meetingRetentionConfirmed" |
    "meetingAudioStorageMode" | "meetingRetentionDeleteMode">;
  onChange: (patch: Partial<TranscriptionSettings>) => void;
}) {
  const [status, setStatus] = useState<AudioStorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = transcription.meetingRetentionPreset ?? "3m";
  const audioOnly = transcription.meetingRetentionDeleteMode !== "audio_and_transcript";
  const storageMode = transcription.meetingAudioStorageMode ?? "always";
  const enabled = preset !== "never" || storageMode === "transcript_only";
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void getAudioStorageStatus().then((value) => {
        if (mounted) { setStatus(value); setStatusError(null); }
      }).catch((e: unknown) => {
        if (mounted) setStatusError(settingsErrorMessage(e, "Could not measure stored audio"));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  function confirmPolicy(patch: Partial<TranscriptionSettings>) {
    if (!window.confirm("Enable automatic deletion? This also applies to existing meeting audio. Deleted audio cannot be played or transcribed again. Transcripts and notes stay unless you select whole-meeting deletion.")) return;
    onChange({ ...patch, meetingRetentionConfirmed: true });
  }

  return <>
    <SettingsOptionSelect disabled={busy} settingId="meeting-retention" label="Delete meeting audio after" description={audioOnly ? "Keeps transcripts and notes." : "Deletes the whole meeting, including its transcript and notes."}
      value={preset} onChange={(selected) => {
        const value = presets.find((value) => value === selected);
        if (!value) return;
        if (value === "never") onChange({ meetingRetentionPreset: value });
        else confirmPolicy({ meetingRetentionPreset: value });
      }}>
        <option value="never">Never</option><option value="1w">1 week</option>
        <option value="1m">1 month</option><option value="2m">2 months</option>
        <option value="3m">3 months</option><option value="custom">Custom</option>
    </SettingsOptionSelect>
    {preset === "custom" && <SettingsInput disabled={busy} label="Custom retention months" description="One month is 30 days." type="number" min={1} max={1200}
      value={String(transcription.meetingRetentionCustomMonths ?? 1)}
      onChange={(value) => {
        const months = Number(value);
        if (Number.isInteger(months) && months >= 1 && months <= 1200) onChange({ meetingRetentionCustomMonths: months, meetingRetentionConfirmed: false });
      }} />}
    <SettingsOptionSelect disabled={busy} settingId="meeting-audio" label="After transcription" description="Finalized meetings keep compact 16 kHz, 16-bit FLAC mic and call tracks, with no stored mix. Re-transcribing or relabeling an older meeting uses this audio, so results can differ slightly from the original. Saved transcripts stay unchanged. Deleting audio prevents playback and retries."
      value={transcription.meetingAudioStorageMode ?? "always"} onChange={(value) => {
        if (value === "transcript_only") confirmPolicy({ meetingAudioStorageMode: "transcript_only" });
        else onChange({ meetingAudioStorageMode: "always" });
      }}><option value="always">Keep audio until it expires</option><option value="transcript_only">Delete audio when transcript is ready</option>
    </SettingsOptionSelect>
    <SettingsOptionSelect disabled={busy} settingId="meeting-delete-mode" label="What auto-delete removes" description="Applies when the retention time expires."
      value={audioOnly ? "audio_only" : "audio_and_transcript"} onChange={(value) => {
        if (value === "audio_and_transcript") confirmPolicy({ meetingRetentionDeleteMode: "audio_and_transcript" });
        else onChange({ meetingRetentionDeleteMode: "audio_only" });
      }}><option value="audio_only">Audio only</option><option value="audio_and_transcript">Audio, transcript and notes</option>
    </SettingsOptionSelect>
    {enabled && !transcription.meetingRetentionConfirmed && <div className="flex items-center justify-between gap-4 py-3">
      <p className="text-sm">Automatic audio deletion is paused until you confirm.</p>
      <Button variant="outline" onClick={() => confirmPolicy({})}>Enable auto-delete</Button>
    </div>}
    <SettingsRow label="Audio storage" description={status ? `${storageSize(status.audioBytes)} used. ${storageSize(status.bytesSaved)} saved.` : "Measuring stored audio…"}>
      <Button variant="outline" disabled={busy || (preset === "never" && storageMode !== "transcript_only")} onClick={async () => {
        if (!window.confirm(storageMode === "transcript_only"
          ? "Delete meeting audio whose transcripts are ready now? Transcripts and notes stay. Pending and incomplete transcriptions are protected. This cannot be undone."
          : "Delete meeting audio older than the selected retention time now? Transcripts and notes stay. Pending and incomplete transcriptions are protected. This cannot be undone.")) return;
        setBusy(true); setError(null); setResult(null);
        try {
          const removed = await freeMeetingAudio(preset, transcription.meetingRetentionCustomMonths ?? 1, storageMode);
          setStatus(await getAudioStorageStatus());
          setResult(`Removed audio from ${removed.audioPathsCleared} meeting${removed.audioPathsCleared === 1 ? "" : "s"}.`);
        } catch (e) { setError(settingsErrorMessage(e, "Could not free meeting audio storage")); }
        finally { setBusy(false); }
      }}>{busy ? "Freeing space…" : "Free up space now"}</Button>
    </SettingsRow>
    {result && <p role="status" className="text-sm">{result}</p>}
    {(error || statusError) && <p role="alert" className="text-sm text-destructive">{error || statusError}</p>}
  </>;
}
