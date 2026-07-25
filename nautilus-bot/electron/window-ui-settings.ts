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
