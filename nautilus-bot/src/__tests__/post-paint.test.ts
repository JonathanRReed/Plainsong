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
});
