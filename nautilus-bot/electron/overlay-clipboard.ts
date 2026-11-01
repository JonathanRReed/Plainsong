import { Buffer } from "node:buffer";

export const OVERLAY_CLIPBOARD_MAX_BYTES = 2 * 1024 * 1024;

export async function copyOverlayText(
  args: unknown,
  authorizedOverlay: boolean,
  writeText: (text: string) => Promise<void>,
): Promise<null> {
  if (!authorizedOverlay) {
    throw new Error("Clipboard copy requires an active Plainsong overlay.");
  }
  if (
    args === null || typeof args !== "object" || Array.isArray(args) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(args))
  ) {
    throw new Error("Clipboard copy requires a plain text payload.");
  }
  const payload = args as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, "text") || typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("Clipboard copy requires nonempty text.");
  }
  if (Buffer.byteLength(payload.text, "utf8") > OVERLAY_CLIPBOARD_MAX_BYTES) {
    throw new Error("Clipboard text exceeds the size limit.");
  }
  try {
    await writeText(payload.text);
  } catch {
    throw new Error("Could not copy text to the clipboard.");
  }
  return null;
}
