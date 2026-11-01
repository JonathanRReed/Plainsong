import { describe, expect, it, vi } from "vitest";
import { parseOverlayNotesFocusRequest, setOverlayNotesFocus } from "../../electron/overlay-notes-focus";
import { overlayWindowOptions } from "../../electron/overlay-window-options";

function fakeWindow(visible = true) {
  return {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    isFocused: vi.fn(() => false),
    setFocusable: vi.fn(),
    focus: vi.fn(),
  };
}

describe("Live notes focus", () => {
  it("starts unfocusable, so a click on Stop never takes focus from the dictation target", () => {
    expect(overlayWindowOptions("recording", "darwin")).toMatchObject({ focusable: false, type: "panel" });
  });

  it("makes the overlay focusable and focuses it only when asked", () => {
    const win = fakeWindow();
    expect(setOverlayNotesFocus(win, true)).toBe(true);
    expect(win.setFocusable).toHaveBeenCalledWith(true);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("returns to unfocusable when the notes box lets go", () => {
    const win = fakeWindow();
    setOverlayNotesFocus(win, true);
    expect(setOverlayNotesFocus(win, false)).toBe(true);
    expect(win.setFocusable).toHaveBeenLastCalledWith(false);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("never focuses a hidden or missing overlay", () => {
    const hidden = fakeWindow(false);
    expect(setOverlayNotesFocus(hidden, true)).toBe(false);
    expect(hidden.setFocusable).not.toHaveBeenCalled();
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(setOverlayNotesFocus(null, true)).toBe(false);
  });

  it("treats anything but an explicit focus request as a release", () => {
    expect(parseOverlayNotesFocusRequest({ focus: true })).toBe(true);
    for (const value of [{ focus: "true" }, {}, null, undefined, { focus: false }]) {
      expect(parseOverlayNotesFocusRequest(value)).toBe(false);
    }
  });
});
