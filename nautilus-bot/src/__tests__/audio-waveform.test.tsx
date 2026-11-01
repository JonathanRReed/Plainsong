import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioWaveform } from "@/components/ui/audio-waveform";

// Drive animation frames by hand so the test can count how long a loop runs.
function installFrameQueue() {
  let queue: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    queue = [];
  });
  return {
    run(frames: number) {
      let ran = 0;
      while (ran < frames && queue.length > 0) {
        const pending = queue;
        queue = [];
        for (const callback of pending) callback(performance.now());
        ran += 1;
      }
      return ran;
    },
    pending: () => queue.length,
  };
}

describe("AudioWaveform", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops drawing once an idle trace comes to rest", () => {
    const frames = installFrameQueue();
    render(<AudioWaveform levels={[0, 0, 0, 0, 0]} active={false} envelope={false} />);
    // The bars ease to their resting shape, then the loop ends by itself.
    expect(frames.run(2000)).toBeLessThan(2000);
    expect(frames.pending()).toBe(0);
  });

  it("keeps animating while recording", () => {
    const frames = installFrameQueue();
    render(<AudioWaveform levels={[0.4, 0.6, 0.5]} active envelope={false} />);
    expect(frames.run(500)).toBe(500);
    expect(frames.pending()).toBe(1);
  });
});
