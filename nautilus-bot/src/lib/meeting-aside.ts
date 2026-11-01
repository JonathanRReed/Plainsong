/**
 * Dictating while a meeting records: an "aside".
 *
 * The sidecar takes the dictation's audio from the meeting's own microphone
 * and keeps its words out of the meeting's transcript and notes
 * (`rust-sidecar/src/meeting_asides.rs`). The call still hears the person,
 * which is what the one-time notice says.
 *
 * Whether the notice has been shown lives in browser storage rather than
 * `Settings`, for the reason `ai-notes-preference.ts` gives: the settings
 * schema mirrors `settings.rs` field for field, and this is the pill's own
 * memory, not a setting.
 */

/** What the pill says while an aside listens. */
export const MEETING_ASIDE_LABEL = "Dictating during a meeting";

/** Shown once, the first time an aside listens. */
export const MEETING_ASIDE_NOTICE = "Your call can still hear you. Mute the call if this is private.";

// Renaming this shows the notice again on every Mac that has seen it.
const MEETING_ASIDE_NOTICE_STORAGE_KEY = "plainsong_meeting_aside_notice_seen";

/**
 * Whether the notice has been shown on this Mac. Unreadable storage reads as
 * not shown: an extra notice costs a glance, a missing one could cost privacy.
 */
export function readMeetingAsideNoticeSeen(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(MEETING_ASIDE_NOTICE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markMeetingAsideNoticeSeen(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(MEETING_ASIDE_NOTICE_STORAGE_KEY, "true");
  } catch {
    // Nothing to fall back to; the notice shows again next time.
  }
}
