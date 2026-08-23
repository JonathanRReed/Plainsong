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
      throw new Error("Starting or stopping capture requires a recent click or key press");
    }
    const normalizedRoute = normalizeRoute(route);
    if (observation.route !== normalizedRoute) {
      throw new Error("Capture must be requested from the same page as the user action");
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
