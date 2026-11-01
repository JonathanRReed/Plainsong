import { useEffect, useState } from "react";
import { Mic, Volume2 } from "lucide-react";
import {
  getMeetingSourceLevels,
  type MeetingSourceLevels,
} from "@/lib/backend/recordings";

const POLL_MS = 200;
const FLOOR_DB = -60;
const CEILING_DB = -12;

/**
 * Map an RMS level (0 to 1) onto a 0 to 1 meter fill on a decibel scale, so
 * ordinary speech sits mid-meter instead of hugging the left edge.
 */
export function meterFill(rms: number | null | undefined): number {
  if (!rms || !Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

function LevelRow({
  label,
  icon,
  level,
  note,
}: {
  label: string;
  icon: React.ReactNode;
  level: number;
  note?: string;
}) {
  const fill = meterFill(level);
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-gold/70 transition-[width] duration-150 ease-out"
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      </div>
      {note ? (
        <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}

/**
 * Live loudness of each meeting source while recording: "You" is the
 * microphone and "Meeting audio" is what the meeting app plays on this Mac.
 * Seeing the second meter move while the other person talks is the quickest
 * proof that their side is being recorded, headphones or not. Until meeting
 * audio has carried any sound at all, its row says it is unverified rather
 * than letting an empty meter pass for a quiet call.
 */
export function MeetingSourceLevelMeters({
  recordingId,
  active,
}: {
  recordingId: string | null;
  active: boolean;
}) {
  const [levels, setLevels] = useState<MeetingSourceLevels | null>(null);

  useEffect(() => {
    if (!recordingId || !active) {
      setLevels(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getMeetingSourceLevels(recordingId);
        if (!cancelled) setLevels(next);
      } catch {
        // Transient while the meeting starts or stops; keep the last reading.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, recordingId]);

  if (!levels || (levels.mic === null && levels.system === null)) {
    return null;
  }

  return (
    <div className="mt-3 space-y-1.5" data-testid="meeting-source-levels">
      {levels.mic !== null ? (
        <LevelRow label="You" icon={<Mic className="h-3.5 w-3.5" />} level={levels.mic} />
      ) : null}
      {levels.system !== null ? (
        <LevelRow
          label="Meeting audio"
          icon={<Volume2 className="h-3.5 w-3.5" />}
          level={levels.system}
          note={levels.systemUnverified ? "Unverified: no sound yet" : undefined}
        />
      ) : null}
    </div>
  );
}
