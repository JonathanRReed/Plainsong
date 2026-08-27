export type OverlayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverlaySize = { width: number; height: number };
export type OverlayBounds = OverlaySize & { x: number; y: number };

export type OverlayKind = "dictation" | "recording";

/**
 * What is remembered per overlay across restarts.
 *
 * `bottom`/`left` are optional and are written by exactly one thing: the user
 * dragging the window. A placement can therefore exist with only a
 * `displayMode` — see {@link withOverlayDisplayMode}.
 */
export type OverlayPlacement = {
  bottom?: number;
  left?: number;
  displayMode?: string;
};

// Gap between the pill's bottom edge and the bottom of the work area. The
// dictation HUD sits a little higher because it is the surface the user reads
// while speaking; the recording chip tucks into the corner.
const OVERLAY_BOTTOM_MARGIN: Record<OverlayKind, number> = {
  dictation: 40,
  recording: 20,
};
const OVERLAY_SIDE_MARGIN = 20;

/**
 * The size each overlay window is created at (see windows.ts). Also the size a
 * malformed resize request falls back to, so a NaN estimate leaves the pill
 * looking exactly as it does at rest instead of collapsing or filling the
 * screen.
 */
export const OVERLAY_BASE_SIZE: Record<OverlayKind, OverlaySize> = {
  dictation: { width: 420, height: 120 },
  recording: { width: 320, height: 80 },
};

/**
 * The largest each overlay may be resized to from the renderer.
 *
 * These windows are always-on-top, `visibleOnFullScreen`, frameless and
 * transparent. `__window_set_size__` used to pass the renderer's numbers to
 * `resolveOverlayBounds`, which clamps only to the full work area — so a
 * renderer asking for 5000x5000 got an always-on-top window covering the whole
 * display. Paired with `__window_set_ignore_mouse_events__ {ignore:false}` and
 * `__window_show__` that is a full-screen click-capture primitive, built
 * entirely out of commands the renderer is allowed to send.
 *
 * The caps are headroom over what the renderer ACTUALLY asks for, not round
 * numbers. The binding cases are:
 *
 * - dictation: `getPopupSize` (src/lib/dictation-popup-layout.ts) tops out at
 *   432x396 — the full-mode processing card with a six-line message and a
 *   four-line preview.
 * - recording: 470x228, the expanded chip in recording-popup.tsx.
 *
 * Clamping BELOW those would clip the card rather than contain an attack, and
 * the layout module is explicit that a short estimate cuts off the live-text
 * box first — the one thing the user is reading while speaking. A test pins
 * these caps against both real maxima, so a layout change that outgrows them
 * fails there instead of silently truncating the HUD.
 */
export const OVERLAY_MAX_SIZE: Record<OverlayKind, OverlaySize> = {
  dictation: { width: 720, height: 480 },
  recording: { width: 560, height: 320 },
};

/** Below this an overlay is invisible but still hit-testable. */
const OVERLAY_MIN_DIMENSION = 1;

function clampDimension(value: number, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), OVERLAY_MIN_DIMENSION), max);
}

/**
 * Bound a renderer-requested overlay size to {@link OVERLAY_MAX_SIZE}.
 *
 * Non-finite dimensions (NaN, Infinity — both of which pass a `typeof x ===
 * "number"` guard) fall back to that overlay's base size rather than being
 * rejected, so a bad estimate mid-sentence resets the pill instead of leaving
 * it at whatever it last was.
 */
export function clampOverlaySize(kind: OverlayKind, size: OverlaySize): OverlaySize {
  const max = OVERLAY_MAX_SIZE[kind];
  const base = OVERLAY_BASE_SIZE[kind];
  return {
    width: clampDimension(size.width, base.width, max.width),
    height: clampDimension(size.height, base.height, max.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  // `min` wins when the range is inverted (a window wider/taller than the work
  // area); callers clamp the size first so that can't normally happen.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where the overlay's bottom edge and left edge should sit when it is first
 * shown on a display: bottom-anchored inside the work area (which already
 * excludes the menu bar and the notch safe area), horizontally centered for the
 * dictation HUD and right-aligned for the recording chip.
 */
export function resolveInitialOverlayAnchor(options: {
  workArea: OverlayWorkArea;
  size: OverlaySize;
  kind: OverlayKind;
}): { bottom: number; left: number } {
  const { workArea, size, kind } = options;
  const bottom = workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN[kind];
  const left =
    kind === "recording"
      ? workArea.x + workArea.width - size.width - OVERLAY_SIDE_MARGIN
      : workArea.x + Math.round(workArea.width / 2 - size.width / 2);
  return { bottom, left };
}

/**
 * Resolve the bounds an overlay window should take for `size`, keeping its
 * BOTTOM edge pinned to `anchor.bottom`.
 *
 * The HUD is resized from the renderer on every live partial (~700ms while the
 * user speaks). Setting only the size grows the window downward from a fixed
 * top-left, which walks the pill off the bottom of the screen mid-sentence, so
 * every size change has to be paired with a reposition. The returned bounds are
 * always fully inside `workArea`: the size is clamped to the work area first so
 * the bottom-anchor and the "never past the bottom edge" guarantee can both
 * hold even for an over-tall estimate.
 */
export function resolveOverlayBounds(options: {
  workArea: OverlayWorkArea;
  size: OverlaySize;
  anchor: { bottom: number; left: number };
}): OverlayBounds {
  const { workArea, size, anchor } = options;
  const width = Math.min(Math.round(size.width), workArea.width);
  const height = Math.min(Math.round(size.height), workArea.height);
  const y = clamp(
    Math.round(anchor.bottom) - height,
    workArea.y,
    workArea.y + workArea.height - height,
  );
  const x = clamp(
    Math.round(anchor.left),
    workArea.x,
    workArea.x + workArea.width - width,
  );
  return { x, y, width, height };
}

/**
 * Whether an anchor the user dragged the overlay to is still usable — i.e. its
 * bottom-left corner lands inside one of the current work areas. A saved anchor
 * that fails this (an external display that is no longer connected, a
 * resolution change) is discarded and the overlay falls back to the default
 * anchor for the active display.
 */
export function isOverlayAnchorOnScreen(
  anchor: { bottom: number; left: number } | null | undefined,
  workAreas: OverlayWorkArea[],
): boolean {
  if (!anchor) {
    return false;
  }
  if (!Number.isFinite(anchor.bottom) || !Number.isFinite(anchor.left)) {
    return false;
  }
  return workAreas.some(
    (workArea) =>
      anchor.left >= workArea.x &&
      anchor.left <= workArea.x + workArea.width - OVERLAY_SIDE_MARGIN &&
      anchor.bottom >= workArea.y + OVERLAY_SIDE_MARGIN &&
      anchor.bottom <= workArea.y + workArea.height,
  );
}

/**
 * The usable anchor a saved placement records, or `null` when it records none.
 *
 * A placement that only carries a `displayMode` is NOT a dragged position, and
 * callers must fall back to the default anchor for the active display. Treating
 * it as one is how a cosmetic Compact/Expand toggle used to pin the HUD to
 * whichever display it happened to be on.
 */
export function resolveSavedOverlayAnchor(
  placement: OverlayPlacement | null | undefined,
  workAreas: OverlayWorkArea[],
): { bottom: number; left: number } | null {
  if (
    !placement ||
    typeof placement.bottom !== "number" ||
    typeof placement.left !== "number"
  ) {
    return null;
  }
  const anchor = { bottom: placement.bottom, left: placement.left };
  return isOverlayAnchorOnScreen(anchor, workAreas) ? anchor : null;
}

/**
 * Record the display mode the user picked, leaving the anchor exactly as it
 * was.
 *
 * Deliberately does not synthesise `bottom`/`left` from the window's current
 * bounds: the toggle is cosmetic, and an anchor invented here is
 * indistinguishable from a drag afterwards — it always passes
 * {@link isOverlayAnchorOnScreen} (the default anchor is on-screen by
 * construction), so the HUD would stop following the cursor onto other
 * displays for good. It would also be the *previous* mode's left edge, so the
 * narrower compact card and minimal pill would render off-centre from then on.
 */
export function withOverlayDisplayMode(
  placement: OverlayPlacement | null | undefined,
  displayMode: string,
): OverlayPlacement {
  return { ...(placement ?? {}), displayMode };
}
