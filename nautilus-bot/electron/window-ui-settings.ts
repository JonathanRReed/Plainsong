/**
 * The `ui` settings the Electron main process owns.
 *
 * These were persisted by the Settings view and never read by anything:
 * "Always on top", "Show dictation mini window" and "Show meeting mini window"
 * all moved a switch and changed nothing. Resolution lives here so the
 * defaults are pinned by a test rather than by a `!== false` buried in main.ts.
 */
export interface WindowUiSettingsInput {
  ui?: {
    minimizeToTray?: boolean;
    alwaysOnTop?: boolean;
    showDictationPopup?: boolean;
    showRecordingPopup?: boolean;
  };
}

export interface WindowUiSettings {
  minimizeToTray: boolean;
  alwaysOnTop: boolean;
  showDictationOverlay: boolean;
  showRecordingOverlay: boolean;
}

/**
 * The overlays default to shown and the window behaviors default to off, so a
 * settings file written before these were read behaves exactly as it did.
 */
export function resolveWindowUiSettings(
  settings: WindowUiSettingsInput | null | undefined,
): WindowUiSettings {
  const ui = settings?.ui;
  return {
    minimizeToTray: ui?.minimizeToTray === true,
    alwaysOnTop: ui?.alwaysOnTop === true,
    showDictationOverlay: ui?.showDictationPopup !== false,
    showRecordingOverlay: ui?.showRecordingPopup !== false,
  };
}

/**
 * Whether an overlay of `kind` is allowed to become visible right now.
 *
 * The main process already gates its OWN `show-dictation-overlay` /
 * `show-recording-overlay` window commands on these settings, but
 * `__window_show__` called `showInactive()` for whatever window sent it, with
 * no reference to them. That let a renderer put an always-on-top,
 * visible-on-full-screen window on screen after the user had turned the
 * overlay off — and, with `__window_set_size__` and
 * `__window_set_ignore_mouse_events__`, do it at an arbitrary size that
 * swallows clicks. The main process's own state is the authority; the
 * renderer's request is a suggestion.
 */
export function overlayVisibilityAllowed(
  kind: "dictation" | "recording",
  settings: Pick<WindowUiSettings, "showDictationOverlay" | "showRecordingOverlay">,
): boolean {
  return kind === "dictation"
    ? settings.showDictationOverlay
    : settings.showRecordingOverlay;
}
