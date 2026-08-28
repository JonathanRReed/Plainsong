import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampWindowSizeToWorkArea,
  isFiniteWindowNumber,
} from "../../electron/window-bounds-policy";

const LAPTOP_WORK_AREA = { x: 0, y: 38, width: 1512, height: 944 };
const MAIN_WINDOW_MINIMUM = { width: 900, height: 600 };

function localCommandHandler(): string {
  const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
  const start = source.indexOf("async function handleLocalCommand(");
  const end = source.indexOf("type DictationShortcutPhase", start);
  return source.slice(start, end);
}

describe("isFiniteWindowNumber", () => {
  it("rejects the non-numbers a typeof check accepts", () => {
    // `typeof NaN === "number"` and `typeof Infinity === "number"`, and the
    // handlers used exactly that check before passing the value to setSize.
    expect(isFiniteWindowNumber(Number.NaN)).toBe(false);
    expect(isFiniteWindowNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteWindowNumber(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("accepts ordinary pixel values, including negative origins", () => {
    expect(isFiniteWindowNumber(0)).toBe(true);
    expect(isFiniteWindowNumber(1200)).toBe(true);
    expect(isFiniteWindowNumber(-1920)).toBe(true);
    expect(isFiniteWindowNumber(880.5)).toBe(true);
  });

  it("rejects values that are not numbers at all", () => {
    expect(isFiniteWindowNumber("1200")).toBe(false);
    expect(isFiniteWindowNumber(null)).toBe(false);
    expect(isFiniteWindowNumber(undefined)).toBe(false);
    expect(isFiniteWindowNumber({ valueOf: () => 1200 })).toBe(false);
  });
});

describe("clampWindowSizeToWorkArea", () => {
  it("keeps a window larger than its display recoverable", () => {
    // Nothing persists main-window bounds, so a size past the display was only
    // recoverable by quitting and relaunching.
    expect(
      clampWindowSizeToWorkArea(
        { width: 100_000, height: 100_000 },
        LAPTOP_WORK_AREA,
        MAIN_WINDOW_MINIMUM,
      ),
    ).toEqual({ width: 1512, height: 944 });
  });

  it("leaves an ordinary size alone", () => {
    expect(
      clampWindowSizeToWorkArea(
        { width: 1200, height: 800 },
        LAPTOP_WORK_AREA,
        MAIN_WINDOW_MINIMUM,
      ),
    ).toEqual({ width: 1200, height: 800 });
  });

  it("never returns a size below the window's own minimum", () => {
    expect(
      clampWindowSizeToWorkArea(
        { width: 1, height: -400 },
        LAPTOP_WORK_AREA,
        MAIN_WINDOW_MINIMUM,
      ),
    ).toEqual(MAIN_WINDOW_MINIMUM);
  });

  it("lets the minimum win on a display smaller than it, as Electron does", () => {
    const smallPanel = { x: 0, y: 25, width: 800, height: 400 };
    expect(
      clampWindowSizeToWorkArea(
        { width: 5000, height: 5000 },
        smallPanel,
        MAIN_WINDOW_MINIMUM,
      ),
    ).toEqual(MAIN_WINDOW_MINIMUM);
  });

  it("rounds to whole pixels", () => {
    expect(
      clampWindowSizeToWorkArea(
        { width: 1200.6, height: 800.4 },
        LAPTOP_WORK_AREA,
        MAIN_WINDOW_MINIMUM,
      ),
    ).toEqual({ width: 1201, height: 800 });
  });
});

describe("renderer window geometry commands", () => {
  it("clamps a main-window resize to the display it is actually on", () => {
    const handler = localCommandHandler();
    // getDisplayMatching, not getPrimaryDisplay: the window may be on an
    // external monitor.
    expect(handler).toContain("screen.getDisplayMatching(senderWindow.getBounds())");
    expect(handler).toContain("clampWindowSizeToWorkArea(size, workArea,");
    expect(handler).not.toMatch(
      /senderWindow\.setSize\(Math\.round\(size\.width\)/,
    );
  });

  it("refuses to move any window that is not an overlay", () => {
    const handler = localCommandHandler();
    const start = handler.indexOf('case "__window_set_position__"');
    const body = handler.slice(start, handler.indexOf('case "__window_hide__"', start));

    expect(body).toContain("if (!senderWindow || !overlayKind)");
    // Overlay moves go through the shared bottom-anchored work-area clamp, not
    // a raw setPosition.
    expect(body).toContain("applyOverlayBounds(");
    expect(body).toContain("resolveOverlayBounds({");
    expect(body).not.toContain("senderWindow.setPosition(");
  });

  it("rejects non-finite geometry on both commands", () => {
    const handler = localCommandHandler();
    expect(handler).toContain("!isFiniteWindowNumber(payload.width)");
    expect(handler).toContain("!isFiniteWindowNumber(payload.height)");
    expect(handler).toContain("!isFiniteWindowNumber(payload.x)");
    expect(handler).toContain("!isFiniteWindowNumber(payload.y)");
    // The old guard accepted NaN and Infinity.
    expect(handler).not.toContain('typeof payload.width === "number"');
    expect(handler).not.toContain('typeof payload.x === "number"');
  });
});
