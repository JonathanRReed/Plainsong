/**
 * The hand-off from a clicked "Zoom call started" notification to the
 * Meetings view's consent dialog.
 *
 * The main process answers the click by focusing the window and broadcasting
 * `meeting-call-capture-requested`. `App` switches to the Meetings view and
 * publishes the request here; the view, whenever it mounts, takes the one
 * that is waiting. A plain event alone would be lost when the click lands
 * while the view is not on screen yet, which is the common case.
 */

import type { DetectedCallSummary } from "@/lib/detected-call";

const CALL_CAPTURE_REQUEST_EVENT = "plainsong:call-capture-requested";

let pending: DetectedCallSummary | null = null;

export function normalizeCallCaptureRequest(value: unknown): DetectedCallSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.callId !== "number" || typeof record.appLabel !== "string") {
    return null;
  }
  return {
    callId: record.callId,
    app: typeof record.app === "string" ? record.app : "",
    appLabel: record.appLabel,
    videoService: typeof record.videoService === "string" ? record.videoService : null,
    detectedAtMs:
      typeof record.detectedAtMs === "number" && Number.isFinite(record.detectedAtMs)
        ? record.detectedAtMs
        : Date.now(),
  };
}

/** Park a request and tell any mounted listener about it. */
export function publishCallCaptureRequest(request: DetectedCallSummary): void {
  pending = request;
  window.dispatchEvent(
    new CustomEvent<DetectedCallSummary>(CALL_CAPTURE_REQUEST_EVENT, { detail: request }),
  );
}

/** Take the parked request, if any, so it is consumed exactly once. */
export function consumePendingCallCaptureRequest(): DetectedCallSummary | null {
  const request = pending;
  pending = null;
  return request;
}

/**
 * Subscribe a mounted view. The parked request, if any, is delivered at
 * once; later ones arrive as they are published. Returns the unsubscribe.
 */
export function subscribeCallCaptureRequests(
  handler: (request: DetectedCallSummary) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DetectedCallSummary>).detail;
    // Delivered live, so the parked copy must not be delivered again on the
    // next mount.
    pending = null;
    handler(detail);
  };
  window.addEventListener(CALL_CAPTURE_REQUEST_EVENT, listener);
  const parked = consumePendingCallCaptureRequest();
  if (parked) {
    handler(parked);
  }
  return () => {
    window.removeEventListener(CALL_CAPTURE_REQUEST_EVENT, listener);
  };
}
