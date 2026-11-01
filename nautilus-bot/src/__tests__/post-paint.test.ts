import { describe, expect, it } from "vitest";
import { scheduleAfterPaint } from "@/lib/post-paint";

describe("scheduleAfterPaint", () => {
  it("waits for two animation frames and the following task", () => {
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<() => void> = [];
    const calls: string[] = [];

    scheduleAfterPaint(
      () => calls.push("reported"),
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      (callback) => {
        tasks.push(callback);
        return tasks.length;
      },
    );

    expect(calls).toEqual([]);
    frames.shift()?.(1);
    expect(calls).toEqual([]);
    frames.shift()?.(2);
    expect(calls).toEqual([]);
    tasks.shift()?.();
    expect(calls).toEqual(["reported"]);
  });

  it.each([0, 1, 2])("cancels work after scheduling stage %s", (stage) => {
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<() => void> = [];
    const calls: string[] = [];
    const cancel = scheduleAfterPaint(
      () => calls.push("reported"),
      (callback) => { frames.push(callback); return frames.length; },
      (callback) => { tasks.push(callback); return tasks.length; },
    );
    for (let frame = 0; frame < stage; frame++) frames.shift()?.(frame);
    cancel();
    while (frames.length) frames.shift()?.(3);
    for (const task of tasks) task();
    expect(calls).toEqual([]);
  });

  it("binds the browser frame scheduler when using the default", () => {
    const frames: FrameRequestCallback[] = [];
    const fakeWindow = {
      requestAnimationFrame(this: unknown, callback: FrameRequestCallback) {
        expect(this).toBe(fakeWindow);
        frames.push(callback);
        return frames.length;
      },
      setTimeout,
    };
    const original = globalThis.window;
    Object.assign(globalThis, { window: fakeWindow });
    fakeWindow.requestAnimationFrame = function (callback) {
      expect(this).toBe(fakeWindow);
      frames.push(callback);
      return frames.length;
    };
    try {
      scheduleAfterPaint(() => undefined);
      expect(frames).toHaveLength(1);
    } finally {
      Object.assign(globalThis, { window: original });
    }
  });
});
