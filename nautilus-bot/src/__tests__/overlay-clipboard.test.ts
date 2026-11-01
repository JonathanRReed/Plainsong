import { describe, expect, it, vi } from "vitest";
import { copyOverlayText, OVERLAY_CLIPBOARD_MAX_BYTES } from "../../electron/overlay-clipboard";

describe("overlay clipboard", () => {
  it("preserves exact text and acknowledges only after the write completes", async () => {
    let finish!: () => void;
    const writer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const text = "  Résumé 🎵\nSecond line  ";
    let acknowledged = false;
    const copy = copyOverlayText({ text }, true, writer).then((result) => {
      acknowledged = true;
      return result;
    });
    expect(writer).toHaveBeenCalledWith(text);
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    expect(await copy).toBeNull();
  });

  it("rejects a different window before inspecting or writing text", async () => {
    const writer = vi.fn(async () => {});
    await expect(copyOverlayText({ text: "private text" }, false, writer)).rejects.toThrow("requires an active");
    expect(writer).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], "text", { text: 1 }, {}, { text: "  \n\t" },
    { text: "text", html: "extra" }, new Date()])("rejects invalid payload %# without writing", async (args) => {
    const writer = vi.fn(async () => {});
    await expect(copyOverlayText(args, true, writer)).rejects.toThrow();
    expect(writer).not.toHaveBeenCalled();
  });

  it("enforces the UTF8 byte boundary for unicode text", async () => {
    const writer = vi.fn(async () => {});
    const boundary = "🎵".repeat(OVERLAY_CLIPBOARD_MAX_BYTES / 4);
    expect(await copyOverlayText({ text: boundary }, true, writer)).toBeNull();
    await expect(copyOverlayText({ text: boundary + "é" }, true, writer)).rejects.toThrow("size limit");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed asynchronous write without echoing transcript text", async () => {
    const text = "private transcript";
    const writer = vi.fn(async () => { throw new Error(text); });
    await expect(copyOverlayText({ text }, true, writer)).rejects.toThrow("Could not copy text to the clipboard.");
  });
});
