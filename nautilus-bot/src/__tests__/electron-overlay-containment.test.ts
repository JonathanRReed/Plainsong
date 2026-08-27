import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERLAY_BASE_SIZE,
  OVERLAY_MAX_SIZE,
  clampOverlaySize,
  resolveOverlayBounds,
} from "../../electron/overlay-placement";
import { overlayVisibilityAllowed } from "../../electron/window-ui-settings";

const LAPTOP_WORK_AREA = { x: 0, y: 38, width: 1512, height: 944 };

function mainSource(): string {
  return readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
}

describe("overlay size containment", () => {
  it("bounds a renderer that asks for a full-screen overlay", () => {
    // The finding: __window_set_size__ handed the renderer's numbers to
    // resolveOverlayBounds, which clamps only to the work area. A frameless,
    // transparent, always-on-top window at work-area size is a click-capture
    // primitive.
    expect(clampOverlaySize("dictation", { width: 5000, height: 5000 })).toEqual(
      OVERLAY_MAX_SIZE.dictation,
    );
    expect(clampOverlaySize("recording", { width: 5000, height: 5000 })).toEqual(
      OVERLAY_MAX_SIZE.recording,
    );

    const bounds = resolveOverlayBounds({
      workArea: LAPTOP_WORK_AREA,
      size: clampOverlaySize("dictation", { width: 5000, height: 5000 }),
      anchor: { bottom: 942, left: 500 },
    });
    expect(bounds.width).toBe(OVERLAY_MAX_SIZE.dictation.width);
    expect(bounds.height).toBe(OVERLAY_MAX_SIZE.dictation.height);
    expect(bounds.width).toBeLessThan(LAPTOP_WORK_AREA.width);
    expect(bounds.height).toBeLessThan(LAPTOP_WORK_AREA.height);
  });

  it("leaves every size the HUD legitimately grows to untouched", () => {
    // The pill is resized on every live partial; the cap must be headroom, not
    // a layout constraint the renderer runs into.
    for (const kind of ["dictation", "recording"] as const) {
      expect(clampOverlaySize(kind, OVERLAY_BASE_SIZE[kind])).toEqual(
        OVERLAY_BASE_SIZE[kind],
      );
      expect(OVERLAY_MAX_SIZE[kind].width).toBeGreaterThan(OVERLAY_BASE_SIZE[kind].width);
      expect(OVERLAY_MAX_SIZE[kind].height).toBeGreaterThan(
        OVERLAY_BASE_SIZE[kind].height,
      );
    }

    // An expanded dictation card, well inside the cap.
    expect(clampOverlaySize("dictation", { width: 560, height: 240 })).toEqual({
      width: 560,
      height: 240,
    });
  });

  it("falls back to the base size for values a typeof check lets through", () => {
    // `typeof NaN === "number"` and `typeof Infinity === "number"`, so the
    // handler's own guard never rejected either.
    expect(clampOverlaySize("dictation", { width: Number.NaN, height: 140 })).toEqual({
      width: OVERLAY_BASE_SIZE.dictation.width,
      height: 140,
    });
    expect(
      clampOverlaySize("recording", {
        width: Number.POSITIVE_INFINITY,
        height: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual(OVERLAY_BASE_SIZE.recording);
  });

  it("never collapses an overlay to a zero or negative size", () => {
    const collapsed = clampOverlaySize("dictation", { width: 0, height: -400 });
    expect(collapsed.width).toBeGreaterThan(0);
    expect(collapsed.height).toBeGreaterThan(0);
  });

  it("clamps before resolving bounds in the resize path", () => {
    const source = mainSource();
    expect(source).toContain("size: clampOverlaySize(kind, size)");
  });
});

describe("overlay visibility authority", () => {
  it("refuses to show an overlay the user turned off", () => {
    expect(
      overlayVisibilityAllowed("dictation", {
        showDictationOverlay: false,
        showRecordingOverlay: true,
      }),
    ).toBe(false);
    expect(
      overlayVisibilityAllowed("recording", {
        showDictationOverlay: true,
        showRecordingOverlay: false,
      }),
    ).toBe(false);
  });

  it("allows each overlay independently of the other", () => {
    expect(
      overlayVisibilityAllowed("dictation", {
        showDictationOverlay: true,
        showRecordingOverlay: false,
      }),
    ).toBe(true);
    expect(
      overlayVisibilityAllowed("recording", {
        showDictationOverlay: false,
        showRecordingOverlay: true,
      }),
    ).toBe(true);
  });

  it("gates __window_show__ on the main process's own overlay state", () => {
    // Previously `case "__window_show__": senderWindow?.showInactive()`, with no
    // reference to showDictationOverlayEnabled / showRecordingOverlayEnabled.
    const source = mainSource();
    const handler = source.slice(
      source.indexOf('case "__window_show__"'),
      source.indexOf('case "__window_start_drag__"'),
    );
    expect(handler).toContain("overlayVisibilityAllowed");
    expect(handler).toContain("showDictationOverlay: showDictationOverlayEnabled");
    expect(handler).toContain("showRecordingOverlay: showRecordingOverlayEnabled");
    expect(handler).not.toMatch(/senderWindow\?\.showInactive\(\)/);
  });
});
