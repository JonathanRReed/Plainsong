interface RendererEventWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    mainFrame: { detached: boolean } | null;
    send(channel: string, payload: unknown): void;
  };
}

/** A renderer can disappear between the availability check and send. */
export function sendRendererEvent(window: RendererEventWindow, channel: string, payload: unknown): boolean {
  try {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }
    const frame = window.webContents.mainFrame;
    if (!frame || frame.detached) {
      return false;
    }
    window.webContents.send(channel, payload);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/render frame (?:was disposed|is disposed|is detached)|object has been destroyed|no frame with routing id|main frame is not available/i.test(message)) {
      return false;
    }
    throw error;
  }
}

/** One automatic reload per window, including when that reload fails. */
export function createRendererRecoveryPolicy(): (reason: string) => boolean {
  let attempted = false;
  return (reason) => {
    if (attempted || (reason !== "crashed" && reason !== "killed")) return false;
    attempted = true;
    return true;
  };
}
