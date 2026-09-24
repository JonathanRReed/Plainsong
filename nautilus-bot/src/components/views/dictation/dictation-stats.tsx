import { useEffect, useRef, useState } from "react";
import type { DictationInsights } from "@/lib/backend";
import {
  dictationHeadlineStats,
  formatCount,
  formatDuration,
  TYPING_WPM,
} from "@/lib/dictation-stats";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Counts up to `value` once, eased; jumps straight there with reduced motion. */
function useCountUp(value: number, durationMs = 700): number {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(origin + (value - origin) * eased);
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);
  return shown;
}

function Stat({
  label,
  value,
  format,
  detail,
}: {
  label: string;
  value: number | null;
  format: (value: number) => string;
  detail: string;
}) {
  const counted = useCountUp(value ?? 0);
  return (
    <div className="min-w-0 space-y-1">
      <p className="rubric-muted">{label}</p>
      <p
        className="font-serif text-3xl leading-none tabular-nums text-foreground"
        aria-label={value === null ? `${label}: not enough audio yet` : `${label}: ${format(value)}`}
      >
        {value === null ? "–" : format(counted)}
      </p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/** The four headline numbers above dictation history. */
export function DictationStats({ insights }: { insights: DictationInsights }) {
  const stats = dictationHeadlineStats(insights);
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-xl border border-border/60 bg-card/60 px-5 py-4 sm:grid-cols-4">
      <Stat
        label="Words"
        value={stats.words}
        format={formatCount}
        detail={`${insights.totalDictations} ${insights.totalDictations === 1 ? "dictation" : "dictations"}`}
      />
      <Stat label="Pace" value={stats.wordsPerMinute} format={(v) => `${v} wpm`} detail="Speaking speed" />
      <Stat
        label="Time saved"
        value={stats.minutesSaved}
        format={formatDuration}
        detail={`Against typing at ${TYPING_WPM} wpm`}
      />
      <Stat
        label="Streak"
        value={stats.streakDays}
        format={(v) => `${v} ${v === 1 ? "day" : "days"}`}
        detail={stats.streakDays > 0 ? "Keep it going" : "Dictate today to start one"}
      />
    </div>
  );
}
