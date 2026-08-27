/**
 * Who is allowed to reach an `ipcMain` handler.
 *
 * Two gaps this closes:
 *
 * 1. `IpcBridge.isTrustedSender` validated the sender FRAME's URL but never
 *    required that frame to be the top-level one. A subframe carries the same
 *    preload and the same `window.electronAPI`, so an iframe whose URL happened
 *    to satisfy the origin predicate reached the sidecar exactly as the app's
 *    own page does. `will-attach-webview` is blocked and the CSP sets
 *    `frame-src 'none'`, but neither is the check that should be load-bearing
 *    here — the handler's own admission is.
 *
 * 2. `window:get-label` had no sender validation at all. It was the one
 *    `ipcMain` handler that ran the origin check on nothing.
 *
 * The frame URL is returned rather than a boolean so callers apply their own
 * origin predicate to it (main.ts owns renderer-origin trust; the bridge is
 * handed that predicate).
 */

export type TrustedSenderCandidate = {
  sender?: { mainFrame?: unknown } | null;
  senderFrame?: { url?: unknown } | null;
};

/**
 * The URL of `event`'s sender frame, or `null` when the request must not be
 * trusted at all.
 *
 * Returns `null` when:
 * - reading `senderFrame` or `sender.mainFrame` throws, which Electron does
 *   once the frame has been disposed mid-call;
 * - there is no sender frame, or it is not the WebContents' top-level frame;
 * - the frame reports no usable URL.
 *
 * Everything here fails closed: an event shape this function does not
 * recognize is untrusted, not exempt.
 */
export function trustedSenderFrameUrl(event: TrustedSenderCandidate): string | null {
  let senderFrame: unknown;
  let mainFrame: unknown;
  try {
    senderFrame = event.senderFrame;
    mainFrame = event.sender?.mainFrame;
  } catch {
    return null;
  }

  if (!senderFrame || !mainFrame || senderFrame !== mainFrame) {
    return null;
  }

  const url = (senderFrame as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}
