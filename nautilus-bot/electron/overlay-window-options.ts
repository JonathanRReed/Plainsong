import type { BrowserWindowConstructorOptions } from "electron";
import { OVERLAY_BASE_SIZE, type OverlayKind } from "./overlay-placement";

/**
 * Window options for the dictation pill and the meeting chip, minus the
 * renderer wiring (preload path, locale argv) that needs Electron at runtime.
 *
 * Kept pure so the activation policy below can be tested without a window
 * server: it is the property that decides whether clicking Stop keeps the
 * user's words headed for the field they were dictating into.
 *
 * `focusable: false` stops the overlay becoming the key window, but on macOS
 * that alone does not stop a click on it from ACTIVATING Plainsong: AppKit
 * activates the owning app on mouse-down in any ordinary window. Activation
 * brings the main window forward and takes the frontmost-app slot from the app
 * the user was typing in, so the insertion that follows the Stop click found
 * Plainsong in front, refused to paste into the wrong app, and left the words
 * only inside the popup.
 *
 * `type: "panel"` makes Electron build the window as an NSPanel with
 * `NSWindowStyleMaskNonactivatingPanel`: clicks are delivered without
 * activating the app, so the target app stays frontmost and its field keeps
 * focus. `acceptFirstMouse` delivers that first click to the button instead of
 * spending it on bringing the window forward.
 */
export function overlayWindowOptions(
  kind: OverlayKind,
  platform: NodeJS.Platform,
): BrowserWindowConstructorOptions {
  const size = OVERLAY_BASE_SIZE[kind];
  return {
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    ...(platform === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
  };
}
