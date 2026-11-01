import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { prepareMainRendererQuit, PREPARE_MAIN_RENDERER_QUIT_SCRIPT, trackRendererQuitHealth } from "../../electron/renderer-quit-guard";

afterEach(() => vi.useRealTimers());
describe("renderer quit save check", () => {
  it("waits for a successful editor flush", async () => {
    let finish!: (value: boolean) => void;
    const execute = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    let settled = false;
    const result = prepareMainRendererQuit(execute).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(execute).toHaveBeenCalledWith(PREPARE_MAIN_RENDERER_QUIT_SCRIPT);
    finish(true);
    expect(await result).toBe(true);
  });
  it.each([false, null, "true"])("rejects an unconfirmed flush %s", async (value) => {
    expect(await prepareMainRendererQuit(async () => value)).toBe(false);
  });
  it("leaves the app open when the renderer fails", async () => {
    expect(await prepareMainRendererQuit(async () => { throw new Error("Renderer unavailable"); })).toBe(false);
  });
  it("allows quit after an observed renderer exit makes its frame unavailable", async () => {
    expect(await prepareMainRendererQuit(async () => {
      throw new Error("Render frame was disposed");
    }, 1000, () => true)).toBe(true);
  });
  it("keeps an explicit save refusal even after an observed renderer exit", async () => {
    expect(await prepareMainRendererQuit(async () => false, 1000, () => true)).toBe(false);
  });
  it("tracks main and recording popup exits independently and restores protection on dom-ready", async () => {
    const main = new EventEmitter();
    const recordingPopup = new EventEmitter();
    const mainGone = trackRendererQuitHealth(main);
    const popupGone = trackRendererQuitHealth(recordingPopup);
    const execute = async () => { throw new Error("Renderer unavailable"); };
    recordingPopup.emit("render-process-gone");
    expect(await prepareMainRendererQuit(execute, 1000, popupGone)).toBe(true);
    expect(await prepareMainRendererQuit(execute, 1000, mainGone)).toBe(false);
    main.emit("render-process-gone");
    expect(await prepareMainRendererQuit(execute, 1000, mainGone)).toBe(true);
    recordingPopup.emit("dom-ready");
    expect(await prepareMainRendererQuit(execute, 1000, popupGone)).toBe(false);
    expect(await prepareMainRendererQuit(async () => false, 1000, popupGone)).toBe(false);
    expect(await prepareMainRendererQuit(execute, 1000, mainGone)).toBe(true);
  });
  it("allows a stuck check only after its renderer is observed exiting", async () => {
    vi.useFakeTimers();
    let rendererGone = false;
    const result = prepareMainRendererQuit(() => new Promise(() => {}), 1000, () => rendererGone);
    rendererGone = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(true);
  });
  it("bounds a stuck renderer check", async () => {
    vi.useFakeTimers();
    const result = prepareMainRendererQuit(() => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false);
  });
});
