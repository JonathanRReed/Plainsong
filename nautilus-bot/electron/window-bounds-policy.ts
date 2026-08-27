/**
 * Bounds the main window will accept from a renderer.
 *
 * `__window_set_size__` and `__window_set_position__` used to pass the
 * renderer's numbers straight to `setSize` / `setPosition`. Nothing checked
 * that they were finite, nothing clamped them to a display, and Plainsong does
 * not persist main-window bounds — so a window moved or grown off-screen stayed
 * off-screen, and the only recovery was to quit and relaunch. The overlays are
 * already reposition-clamped through `resolveOverlayBounds`; the main window
 * had no equivalent.
 */

export type WindowWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowSize = { width: number; height: number };

/**
 * Whether a value from a renderer payload can be used as a pixel dimension.
 *
 * `typeof value === "number"` was the only check, and it accepts NaN and both
 * infinities. Electron turns a NaN width into an undefined-behavior resize
 * rather than an error.
 */
export function isFiniteWindowNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Clamp a renderer-requested main-window size into `workArea`, never below
 * `minimum` (the window's own minWidth/minHeight, which Electron would enforce
 * anyway — applied here so the returned value is the size that will actually be
 * used).
 *
 * When the work area is smaller than the minimum — a very small external panel
 * — the minimum wins, matching Electron's own behavior, and the window is
 * simply larger than the display.
 */
export function clampWindowSizeToWorkArea(
  size: WindowSize,
  workArea: WindowWorkArea,
  minimum: WindowSize,
): WindowSize {
  return {
    width: clampDimension(size.width, workArea.width, minimum.width),
    height: clampDimension(size.height, workArea.height, minimum.height),
  };
}

function clampDimension(value: number, max: number, minimum: number): number {
  return Math.max(Math.min(Math.round(value), Math.round(max)), Math.round(minimum));
}
