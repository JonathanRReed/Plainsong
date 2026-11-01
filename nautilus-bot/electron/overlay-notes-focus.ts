/**
 * Typing into the meeting overlay's Live notes.
 *
 * The overlay is a non-activating panel that cannot become key
 * (`overlay-window-options.ts`), so clicks on Stop never pull focus away from
 * the app being dictated into. The same property made the Live notes box
 * impossible to type into: keystrokes went to whatever app was in front.
 *
 * Notes get an explicit path instead. A click in the notes box, or the menu
 * bar's "Type Live Notes" item, makes only the meeting overlay focusable and
 * gives it keyboard focus. Being a non-activating panel, it can take keys
 * without activating Plainsong or bringing the main window forward. When the
 * notes box loses focus, the overlay goes back to unfocusable. Nothing else
 * calls this: starting a dictation never focuses the overlay.
 */
export interface NotesFocusWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  setFocusable(focusable: boolean): void;
  focus(): void;
}

/** Give or return keyboard focus for the Live notes box. */
export function setOverlayNotesFocus(win: NotesFocusWindow | null, focus: boolean): boolean {
  if (!win || win.isDestroyed()) return false;
  if (focus) {
    if (!win.isVisible()) return false;
    win.setFocusable(true);
    win.focus();
    return true;
  }
  win.setFocusable(false);
  return true;
}

/** The `__overlay_notes_focus__` argument: `{ focus: boolean }`, anything else is a release. */
export function parseOverlayNotesFocusRequest(args: unknown): boolean {
  return (args as { focus?: unknown } | null | undefined)?.focus === true;
}
