import { useEffect, useState } from "react";
import { describeMeetingTranscriptionActivity, type MeetingTranscriptionActivity } from "@/lib/meeting-transcription-activity";

export function TranscriptionActivity({ activity }: { activity: MeetingTranscriptionActivity | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!activity?.active || activity.receivedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity?.active, activity?.receivedAt]);
  if (!activity?.active) return null;
  return <div role="region" aria-label="Transcription activity" className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
    <p role="status" aria-live="polite" className="text-sm font-medium">{activity.stage}</p>
    <p aria-live="off" className="mt-1 text-xs text-muted-foreground">{describeMeetingTranscriptionActivity(activity, now)}</p>
  </div>;
}
