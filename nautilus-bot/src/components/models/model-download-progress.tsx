import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";

/** Keep announcements stable between milestones rather than reading every update. */
export function ModelDownloadProgress({ name, active, value, className }: {
  name: string;
  active: boolean;
  value: number | null;
  className?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const progress = value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
  const unknown = progress === null;
  useEffect(() => {
    setElapsed(0);
    if (!active || !unknown) return;
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 30), 30_000);
    return () => window.clearInterval(timer);
  }, [active, unknown, name]);

  const milestone = progress === null ? null : Math.floor(progress / 25) * 25;
  useEffect(() => {
    setAnnouncement(!active ? "" : milestone === null
      ? `Downloading ${name}. Progress isn't available yet.${elapsed ? ` ${elapsed} seconds elapsed.` : ""}`
      : milestone === 0 ? `Downloading ${name}. Download started.` : `Downloading ${name}. ${milestone}% complete.`);
  }, [active, milestone, name, elapsed]);

  return <>
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
    {active ? <Progress aria-label={`${name} download`} value={progress} className={className} /> : null}
  </>;
}
