import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/playback";
import { deleteRecordingAside, exportRecordingAudio, type MeetingAside } from "@/lib/backend/meeting-asides";

export function MeetingAsides({ recordingId, asides, onDelete, onSeek }: {
  recordingId: string;
  asides: MeetingAside[];
  onDelete: (asideId: string) => void;
  onSeek: (time: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (asides.length === 0) return null;

  async function remove(asideId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await deleteRecordingAside(recordingId, asideId);
      onDelete(asideId);
    } catch {
      setMessage("Could not delete this aside. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function exportAudio() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await exportRecordingAudio(recordingId);
      setMessage(`Audio saved to ${result.exportPath}`);
    } catch {
      setMessage("Could not export audio. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 shrink-0 text-sm text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls="meeting-asides" onClick={() => setOpen(value => !value)}>
          {open ? "Hide asides" : "Show asides"} ({asides.length})
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void exportAudio()}>Export audio</Button>
      </div>
      {message ? <p role="status" className="mt-2 break-words">{message}</p> : null}
      {open ? (
        <ul id="meeting-asides" className="mt-2 max-h-48 space-y-2 overflow-y-auto border-l pl-3 pr-1">
          {asides.map(aside => (
            <li key={aside.asideId} className="flex items-start gap-3">
              <button type="button" className="min-w-0 flex-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSeek(aside.startTime)}>
                <span className="mr-2 tabular-nums">{formatClock(aside.startTime)}</span>
                <span>{aside.rows.map(row => row.text).join(" ") || "Audio only"}</span>
              </button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Delete aside at ${formatClock(aside.startTime)}`} onClick={() => void remove(aside.asideId)}>Delete</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
