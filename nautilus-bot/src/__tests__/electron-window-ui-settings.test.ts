import { describe, expect, it } from "vitest";
import { resolveWindowUiSettings } from "../../electron/window-ui-settings";

describe("resolveWindowUiSettings", () => {
  it("keeps the pre-existing behavior when nothing is saved", () => {
    // The overlays were always shown and always-on-top was never applied, so
    // reading these settings for the first time must not change what a user
    // with an old settings file sees.
    expect(resolveWindowUiSettings(null)).toEqual({
      minimizeToTray: false,
      alwaysOnTop: false,
      showDictationOverlay: true,
      showRecordingOverlay: true,
    });
  });

  it("honors every switch the Settings view writes", () => {
    expect(
      resolveWindowUiSettings({
        ui: {
          minimizeToTray: true,
          alwaysOnTop: true,
          showDictationPopup: false,
          showRecordingPopup: false,
        },
      })
    ).toEqual({
      minimizeToTray: true,
      alwaysOnTop: true,
      showDictationOverlay: false,
      showRecordingOverlay: false,
    });
  });

  it("treats a missing overlay flag as shown, not as hidden", () => {
    const resolved = resolveWindowUiSettings({ ui: { alwaysOnTop: true } });

    expect(resolved.showDictationOverlay).toBe(true);
    expect(resolved.showRecordingOverlay).toBe(true);
  });
});
