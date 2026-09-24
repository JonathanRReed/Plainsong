import type { DictationInsights } from "@/lib/backend";

/**
 * The headline dictation numbers, the ones Wispr Flow and Typeless lead
 * their home screens with. Time saved compares speaking with typing the same
 * words at 40 WPM, the commonly cited average typing speed; it is an
 * estimate and the tile says so.
 */
export const TYPING_WPM = 40;

export interface DictationHeadlineStats {
  words: number;
  /** Speaking pace; null until there is at least 30 s of audio to divide by. */
  wordsPerMinute: number | null;
  minutesSaved: number;
  streakDays: number;
}

export function dictationHeadlineStats(insights: DictationInsights): DictationHeadlineStats {
  const words = Math.max(0, insights.dictatedWords);
  const spokenMinutes = Math.max(0, insights.spokenSeconds ?? 0) / 60;
  const wordsPerMinute = spokenMinutes >= 0.5 ? Math.round(words / spokenMinutes) : null;
  const minutesSaved = Math.max(0, Math.round(words / TYPING_WPM - spokenMinutes));
  return { words, wordsPerMinute, minutesSaved, streakDays: Math.max(0, insights.currentStreakDays ?? 0) };
}

/** "45 min", "3.2 h", "12 h". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

/** 999 as is, then 1.2k, 12k, 1.2M. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
