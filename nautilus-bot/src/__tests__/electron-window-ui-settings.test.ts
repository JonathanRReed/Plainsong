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
      dictationSounds: true,
      dictationPillSize: "default",
      dictationPillDock: "bottom",
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
          dictationSounds: false,
          dictationPillSize: "xlarge",
          dictationPillDock: "right",
        },
      })
    ).toEqual({
      minimizeToTray: true,
      alwaysOnTop: true,
      showDictationOverlay: false,
      showRecordingOverlay: false,
      dictationSounds: false,
      dictationPillSize: "xlarge",
      dictationPillDock: "right",
    });
  });

  it("reads an unrecognized pill size or dock as the default", () => {
    const resolved = resolveWindowUiSettings({
      ui: { dictationPillSize: "huge", dictationPillDock: "top" },
    });

    expect(resolved.dictationPillSize).toBe("default");
    expect(resolved.dictationPillDock).toBe("bottom");
    expect(
      resolveWindowUiSettings({ ui: { dictationPillSize: "small", dictationPillDock: "left" } }),
    ).toMatchObject({ dictationPillSize: "small", dictationPillDock: "left" });
  });

  it("treats a missing overlay flag as shown, not as hidden", () => {
    const resolved = resolveWindowUiSettings({ ui: { alwaysOnTop: true } });

    expect(resolved.showDictationOverlay).toBe(true);
    expect(resolved.showRecordingOverlay).toBe(true);
  });
});
