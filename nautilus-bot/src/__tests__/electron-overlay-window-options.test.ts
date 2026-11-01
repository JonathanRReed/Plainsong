import { describe, expect, it } from "vitest";
import { overlayWindowOptions } from "../../electron/overlay-window-options";

describe("overlay window options", () => {
  it("builds both macOS overlays as non-activating panels", () => {
    // A click on the pill's Stop button must not activate Plainsong: that
    // took the frontmost-app slot from the app the user was dictating into,
    // and the insertion that followed refused to paste into the wrong app.
    for (const kind of ["dictation", "recording"] as const) {
      const options = overlayWindowOptions(kind, "darwin");
      expect(options.type).toBe("panel");
      expect(options.focusable).toBe(false);
      expect(options.acceptFirstMouse).toBe(true);
      expect(options.show).toBe(false);
      expect(options.alwaysOnTop).toBe(true);
    }
  });

  it("does not use the macOS-only panel type elsewhere", () => {
    for (const platform of ["win32", "linux"] as const) {
      const options = overlayWindowOptions("dictation", platform);
      expect(options.type).toBeUndefined();
      expect(options.acceptFirstMouse).toBeUndefined();
      expect(options.focusable).toBe(false);
    }
  });

  it("keeps each overlay's base size", () => {
    expect(overlayWindowOptions("dictation", "darwin")).toMatchObject({ width: 420, height: 120 });
    expect(overlayWindowOptions("recording", "darwin")).toMatchObject({ width: 320, height: 80 });
  });
});
