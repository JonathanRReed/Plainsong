/**
 * Whether the reader has said, in so many words, that they do not want AI
 * meeting notes.
 *
 * This lives in browser storage rather than `Settings` on purpose. The settings
 * schema is a field-for-field mirror of `rust-sidecar/src/settings.rs` (see
 * `src/__tests__/settings-wire-contract.test.ts`), so a renderer-only
 * preference cannot be added there without the Rust half. What the sidecar does
 * store is the AI lane itself; this only records that the *absence* of a usable
 * lane is a decision rather than an oversight, which is the difference between
 * "Notes unavailable" and a nag.
 */

export const AI_NOTES_OPT_OUT_STORAGE_KEY = "plainsong_ai_notes_opt_out";
export const AI_NOTES_PREFERENCE_EVENT = "plainsong-ai-notes-preference";

/** True only when the reader explicitly chose transcripts without AI notes. */
export function readAiNotesOptOut(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(AI_NOTES_OPT_OUT_STORAGE_KEY) === "true";
  } catch {
    // Storage can be unavailable (private mode, blocked site data). An
    // unreadable preference is not an opt-out — it is no answer at all, and
    // readiness treats that as "not configured" rather than "declined".
    return false;
  }
}

/**
 * Record the choice and tell the running app about it, so readiness re-reads it
 * without waiting for a reload.
 */
export function writeAiNotesOptOut(optedOut: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (optedOut) {
      window.localStorage.setItem(AI_NOTES_OPT_OUT_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(AI_NOTES_OPT_OUT_STORAGE_KEY);
    }
  } catch {
    // Nothing to fall back to; the event below still updates this session.
  }
  window.dispatchEvent(new CustomEvent(AI_NOTES_PREFERENCE_EVENT));
}
