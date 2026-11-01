vi.unmock("@/lib/electron");
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accumulateHeardMs,
  classifyMicError,
  levelFromSamples,
  MIC_HEARD_AFTER_MS,
  MIC_HEARD_LEVEL,
  micErrorMessage,
  smoothLevel,
  useMicLevel,
} from "@/hooks/use-mic-level";

function tone(amplitude: number, length = 1024): Float32Array {
  return Float32Array.from({ length }, (_, index) =>
    amplitude * Math.sin((index / length) * Math.PI * 16),
  );
}

describe("levelFromSamples", () => {
  it("reads silence and an empty frame as zero", () => {
    expect(levelFromSamples(new Float32Array(512))).toBe(0);
    expect(levelFromSamples([])).toBe(0);
  });

  it("maps loudness onto a -60..0 dBFS scale", () => {
    // A full-scale square wave is 0 dBFS; one hundredth of it is -40 dBFS.
    expect(levelFromSamples(new Float32Array(256).fill(1))).toBeCloseTo(1, 5);
    expect(levelFromSamples(new Float32Array(256).fill(0.01))).toBeCloseTo(1 / 3, 5);
    expect(levelFromSamples(new Float32Array(256).fill(0.001))).toBeCloseTo(0, 5);
  });

  it("puts normal speech above the heard line and room noise below it", () => {
    // Speech peaks around -20 dBFS; a quiet room sits near -55 dBFS.
    expect(levelFromSamples(tone(0.14))).toBeGreaterThan(MIC_HEARD_LEVEL);
    expect(levelFromSamples(tone(0.0025))).toBeLessThan(MIC_HEARD_LEVEL);
  });

  it("never leaves 0..1, even for clipped input", () => {
    expect(levelFromSamples(new Float32Array(64).fill(4))).toBe(1);
  });
});

describe("smoothLevel", () => {
  it("rises faster than it falls", () => {
    const rise = smoothLevel(0.2, 0.8) - 0.2;
    const fall = 0.8 - smoothLevel(0.8, 0.2);
    expect(rise).toBeGreaterThan(fall);
  });

  it("settles on a steady input", () => {
    let level = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      level = smoothLevel(level, 0.6);
    }
    expect(level).toBeCloseTo(0.6, 3);
  });
});

describe("accumulateHeardMs", () => {
  it("counts only time spent above the line", () => {
    let total = 0;
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL + 0.1, 100);
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL - 0.1, 400);
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL, 50);
    expect(total).toBe(150);
  });

  it("needs a moment of speech, not a single click, to count as heard", () => {
    expect(accumulateHeardMs(0, 1, 16)).toBeLessThan(MIC_HEARD_AFTER_MS);
  });

  it("ignores a clock that ran backwards", () => {
    expect(accumulateHeardMs(100, 1, -30)).toBe(100);
  });
});

describe("classifyMicError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no-device"],
    ["DevicesNotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "busy"],
    ["TrackStartError", "busy"],
    ["AbortError", "busy"],
    ["TypeError", "unavailable"],
  ] as const)("maps %s to %s", (name, kind) => {
    expect(classifyMicError(new DOMException("failed", name))).toBe(kind);
  });

  it("treats anything without a name as unavailable", () => {
    expect(classifyMicError("boom")).toBe("unavailable");
    expect(classifyMicError(null)).toBe("unavailable");
  });

  it("names the failure and what to do about it", () => {
    expect(micErrorMessage("denied")).toMatch(/Privacy & Security > Microphone/);
    expect(micErrorMessage("no-device")).toMatch(/^No microphone found/);
    expect(micErrorMessage("busy")).toMatch(/in use by another app/);
  });
});

describe("useMicLevel", () => {
  type FakeTrack = { stop: ReturnType<typeof vi.fn>; end(): void };
  let tracks: FakeTrack[];
  const getUserMedia = vi.fn();
  const enumerateDevices = vi.fn();
  const cancelFrame = vi.fn();

  /** A stream whose one track can be ended, as unplugging a mic does. */
  function fakeStream() {
    const listeners: Array<() => void> = [];
    const track = {
      stop: vi.fn(),
      addEventListener: (type: string, listener: () => void) => {
        if (type === "ended") listeners.push(listener);
      },
      end: () => listeners.forEach((listener) => listener()),
    };
    tracks.push(track);
    return { getTracks: () => [track] };
  }

  const podcastMic = { deviceId: "usb-podcast-mic", deviceName: "Podcast Mic" };
  const browserPodcastMic = {
    deviceId: "browser-podcast",
    kind: "audioinput",
    label: "Podcast Mic (USB)",
  };

  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined });
    tracks = [];
    getUserMedia.mockReset();
    getUserMedia.mockImplementation(async () => fakeStream());
    enumerateDevices.mockReset();
    enumerateDevices.mockResolvedValue([]);
    cancelFrame.mockReset();
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia, enumerateDevices },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        createAnalyser() {
          return { fftSize: 1024, getFloatTimeDomainData: () => {} };
        }
        createMediaStreamSource() {
          return { connect: () => {} };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refuses a retained start callback after disposal", async () => {
    const { result, unmount } = renderHook(() => useMicLevel());
    const start = result.current.start;
    unmount();
    await act(() => start());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("waits for native permission before device enumeration or capture", async () => {
    const permission = deferred<boolean>();
    const requestMicrophoneAccess = vi.fn(() => permission.promise);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { requestMicrophoneAccess } });
    const { result } = renderHook(() => useMicLevel());
    await act(async () => { void result.current.start(podcastMic); });
    expect(requestMicrophoneAccess).toHaveBeenCalledOnce();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => { permission.resolve(true); });
    expect(result.current.state).toBe("live");
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it.each([false, "rejected"])("reports native permission %s without opening capture", async (permission) => {
    const requestMicrophoneAccess = vi.fn(() => permission === false ? Promise.resolve(false) : Promise.reject(Error("native")));
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { requestMicrophoneAccess } });
    const { result } = renderHook(() => useMicLevel());
    await act(() => result.current.start(podcastMic));
    expect(result.current.error).toBe(permission === false ? "denied" : "unavailable");
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["stop", "unmount", "timeout"])("does not open capture after late native permission following %s", async (action) => {
    vi.useFakeTimers();
    const permission = deferred<boolean>();
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { requestMicrophoneAccess: () => permission.promise } });
    const { result, unmount } = renderHook(() => useMicLevel());
    await act(async () => { void result.current.start(podcastMic); });
    if (action === "stop") act(() => result.current.stop());
    if (action === "unmount") unmount();
    if (action === "timeout") await act(() => vi.advanceTimersByTimeAsync(30_000));
    await act(async () => { permission.resolve(true); });
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    if (action === "timeout") expect(result.current.error).toBe("timeout");
  });

  it("keeps one deadline across native permission and capture", async () => {
    vi.useFakeTimers();
    const permission = deferred<boolean>();
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { requestMicrophoneAccess: () => permission.promise } });
    getUserMedia.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useMicLevel());
    await act(async () => { void result.current.start(); });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => { permission.resolve(true); });
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.error).toBe("timeout");
  });

  it("ignores an older native grant after restart", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const requestMicrophoneAccess = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { requestMicrophoneAccess } });
    const { result } = renderHook(() => useMicLevel());
    await act(async () => { void result.current.start(); });
    await act(async () => { void result.current.start(); });
    await act(async () => { first.resolve(true); });
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => { second.resolve(true); });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("live");
  });

  it("opens the chosen microphone exactly once the browser can name it", async () => {
    enumerateDevices.mockResolvedValue([browserPodcastMic]);
    const { result } = renderHook(() => useMicLevel());

    await act(() => result.current.start(podcastMic));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "browser-podcast" } },
      video: false,
    });
    expect(result.current.state).toBe("live");
    expect(result.current.usingSystemDefault).toBe(false);
  });

  it("says it is reading the system default when the chosen microphone has no match", async () => {
    const { result } = renderHook(() => useMicLevel());

    await act(() => result.current.start(podcastMic));

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(result.current.state).toBe("live");
    expect(result.current.usingSystemDefault).toBe(true);
  });

  it("looks again once the first open reveals device labels", async () => {
    enumerateDevices
      .mockResolvedValueOnce([{ ...browserPodcastMic, label: "" }])
      .mockResolvedValueOnce([browserPodcastMic]);
    const { result } = renderHook(() => useMicLevel());

    await act(() => result.current.start(podcastMic));

    expect(getUserMedia).toHaveBeenNthCalledWith(1, { audio: true, video: false });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: { deviceId: { exact: "browser-podcast" } },
      video: false,
    });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(result.current.usingSystemDefault).toBe(false);
  });

  it("does not claim the default is a chosen microphone when none was chosen", async () => {
    const { result } = renderHook(() => useMicLevel());

    await act(() => result.current.start(null));

    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(result.current.usingSystemDefault).toBe(false);
  });

  it("stops and reports a missing microphone when the device goes away mid-check", async () => {
    const { result } = renderHook(() => useMicLevel());
    await act(() => result.current.start(null));
    expect(result.current.state).toBe("live");

    act(() => tracks[0].end());

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toBe("no-device");
    expect(result.current.level).toBe(0);
    expect(cancelFrame).toHaveBeenCalled();
    expect(result.current.getStream()).toBeNull();
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("uses one 30-second deadline across device lookup and capture, then allows retry", async () => {
    vi.useFakeTimers();
    const devices = deferred<MediaDeviceInfo[]>();
    const capture = deferred<ReturnType<typeof fakeStream>>();
    enumerateDevices.mockReturnValueOnce(devices.promise);
    getUserMedia.mockReturnValueOnce(capture.promise);
    const { result } = renderHook(() => useMicLevel());
    act(() => { void result.current.start(podcastMic); });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => { devices.resolve([]); });
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(result.current.state).toBe("starting");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("timeout");
    const late = fakeStream();
    await act(async () => { capture.resolve(late); });
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(result.current.getStream()).toBeNull();
    await act(() => result.current.start());
    expect(result.current.state).toBe("live");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.state).toBe("live");
  });

  it.each(["stop", "unmount", "timeout", "restart"] as const)(
    "does not open capture after a late device lookup following %s",
    async (action) => {
      vi.useFakeTimers();
      const devices = deferred<MediaDeviceInfo[]>();
      enumerateDevices.mockReturnValueOnce(devices.promise);
      const { result, unmount } = renderHook(() => useMicLevel());
      act(() => { void result.current.start(podcastMic); });
      if (action === "stop") act(() => result.current.stop());
      if (action === "unmount") unmount();
      if (action === "timeout") await act(() => vi.advanceTimersByTimeAsync(30_000));
      if (action === "restart") await act(() => result.current.start());
      const calls = getUserMedia.mock.calls.length;
      await act(async () => { devices.resolve([]); });
      expect(getUserMedia).toHaveBeenCalledTimes(calls);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      if (action === "restart") expect(result.current.state).toBe("live");
      if (action === "stop") expect(result.current.state).toBe("idle");
    },
  );

  it("releases the first stream if the second device lookup times out", async () => {
    vi.useFakeTimers();
    const devices = deferred<MediaDeviceInfo[]>();
    enumerateDevices.mockResolvedValueOnce([]).mockReturnValueOnce(devices.promise);
    const { result } = renderHook(() => useMicLevel());
    await act(async () => { void result.current.start(podcastMic); });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.error).toBe("timeout");
    expect(tracks[0].stop).toHaveBeenCalled();
    await act(async () => { devices.resolve([]); });
    expect(result.current.state).toBe("error");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "unmount", "restart"] as const)(
    "stops a late capture after %s without changing the current generation",
    async (action) => {
      vi.useFakeTimers();
      const capture = deferred<ReturnType<typeof fakeStream>>();
      getUserMedia.mockReturnValueOnce(capture.promise);
      const { result, unmount } = renderHook(() => useMicLevel());
      await act(async () => { void result.current.start(); });
      if (action === "stop") act(() => result.current.stop());
      if (action === "unmount") unmount();
      if (action === "restart") {
        getUserMedia.mockReturnValueOnce(new Promise(() => {}));
        await act(async () => { void result.current.start(); });
      }
      const late = fakeStream();
      await act(async () => { capture.resolve(late); });
      expect(tracks[0].stop).toHaveBeenCalledOnce();
      expect(result.current.getStream()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      if (action === "restart") expect(result.current.error).toBe("timeout");
      if (action === "stop") expect(result.current.state).toBe("idle");
    },
  );

  it("releases capture when AudioContext construction throws", async () => {
    vi.stubGlobal("AudioContext", class {
      constructor() { throw new Error("Audio unavailable"); }
    });
    const { result } = renderHook(() => useMicLevel());
    await act(() => result.current.start());
    expect(result.current.error).toBe("unavailable");
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(result.current.getStream()).toBeNull();
  });

});
