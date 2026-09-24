import type { Recording } from "@/types";

/** How many saved dictations the history list shows per "Show more". */
export const DICTATION_HISTORY_PAGE_SIZE = 25;

export interface DictationHistoryGroup {
  key: string;
  label: string;
  recordings: Recording[];
}

/**
 * Same source as `appLocale()` in format-locale.ts: the bridge's locale, or
 * en-US in a browser tab or a test. Read per call for the same reason.
 */
function appLocale(): string {
  const value =
    typeof window === "undefined" ? undefined : window.electronAPI?.appLocale;
  return typeof value === "string" && value.length > 0 ? value : "en-US";
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDayKey(date) === localDayKey(now)) return "Today";
  if (localDayKey(date) === localDayKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(appLocale(), {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/**
 * Buckets history by the reader's local day, keeping the incoming order. The
 * list is already newest first, so the groups come out newest first too.
 */
export function groupDictationHistory(
  recordings: Recording[],
  now: Date = new Date(),
): DictationHistoryGroup[] {
  const groups: DictationHistoryGroup[] = [];
  for (const recording of recordings) {
    const created = new Date(recording.createdAt);
    const valid = !Number.isNaN(created.getTime());
    const key = valid ? localDayKey(created) : "unknown";
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = {
        key,
        label: valid ? dayLabel(created, now) : "Undated",
        recordings: [],
      };
      groups.push(group);
    }
    group.recordings.push(recording);
  }
  return groups;
}

/** "2:37 PM" rather than "9/24/2026, 2:37:23 PM": the day is the heading. */
export function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(appLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * The words themselves when the row already carries them, otherwise the title.
 * Never fetched per row: the list can hold hundreds of dictations.
 */
export function dictationHistoryPreview(recording: Recording): string {
  return (
    recording.dictationPreview?.trim() ||
    recording.transcript?.fullText?.trim() ||
    recording.summary?.trim() ||
    recording.title
  );
}

/**
 * The app the words went into, when the row says. The recordings list does
 * not always carry it, so its absence means "not recorded here", not "none".
 */
export function dictationHistoryAppName(recording: Recording): string | null {
  if (recording.dictationAppTarget?.trim()) return recording.dictationAppTarget.trim();
  const metadata = recording.metadata as { appTarget?: unknown } | undefined;
  const app = metadata?.appTarget;
  return typeof app === "string" && app.trim() ? app.trim() : null;
}

/** Only states worth a reader's attention; a finished dictation says nothing. */
export function dictationHistoryStatusLabel(
  status: Recording["status"],
): string | null {
  switch (status) {
    case "error":
      return "Failed";
    case "processing":
      return "Still processing";
    case "recording":
      return "Recording";
    default:
      return null;
  }
}
