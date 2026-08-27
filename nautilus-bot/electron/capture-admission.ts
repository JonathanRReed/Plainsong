import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";

type Observation = { observedAt: number; route: string };

type CaptureAdmissionOptions = {
  maxAgeMs?: number;
  now?: () => number;
};

export type CaptureAdmissionGrant = {
  nonce: string;
  windowId: number;
  route: string;
};

function normalizeRoute(rawRoute: string): string {
  try {
    const url = new URL(rawRoute);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawRoute.trim();
  }
}

/**
 * Proof that a privileged action was asked for by the user, in this window, on
 * this page, just now.
 *
 * Named for its first caller (meeting capture, which also carries the grant's
 * nonce to the sidecar), but the gesture requirement is what the native folder
 * and cloud-destination dialogs need too: a modal parented to a window is a
 * thing the user must have asked for, or it is an unprompted dialog with the
 * app's name on it. The messages below are therefore action-neutral.
 */
export class CaptureAdmissionController {
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly observations = new Map<number, Observation>();

  constructor(options: CaptureAdmissionOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 1_500;
    this.now = options.now ?? Date.now;
  }

  observe(windowId: number, route: string): void {
    this.observations.set(windowId, {
      observedAt: this.now(),
      route: normalizeRoute(route),
    });
  }

  consume(windowId: number, route: string): CaptureAdmissionGrant {
    const observation = this.observations.get(windowId);
    if (!observation || this.now() - observation.observedAt > this.maxAgeMs) {
      this.observations.delete(windowId);
      throw new Error("This action requires a recent click or key press");
    }
    const normalizedRoute = normalizeRoute(route);
    if (observation.route !== normalizedRoute) {
      throw new Error("This action must be requested from the same page as the user action");
    }
    this.observations.delete(windowId);
    return { nonce: randomUUID(), windowId, route: normalizedRoute };
  }

  clear(windowId: number): void {
    this.observations.delete(windowId);
  }
}

export function observeCaptureAdmissionForWindow(
  win: BrowserWindow,
  controller: CaptureAdmissionController,
): void {
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat) {
      controller.observe(win.id, win.webContents.getURL());
    }
  });
  win.webContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") {
      controller.observe(win.id, win.webContents.getURL());
    }
  });
  win.webContents.once("destroyed", () => {
    controller.clear(win.id);
  });
}
