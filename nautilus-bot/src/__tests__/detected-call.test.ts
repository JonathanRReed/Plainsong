import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDetectedCallCapturePrefill,
  describeDetectedCall,
  detectedCallIsOfferable,
  formatDetectedCallClock,
} from "@/lib/detected-call";
import {
  consumePendingCallCaptureRequest,
  normalizeCallCaptureRequest,
  publishCallCaptureRequest,
  subscribeCallCaptureRequests,
} from "@/lib/call-capture-request";

// 14:05 local time, whatever the zone.
const DETECTED_AT = new Date(2026, 8, 2, 14, 5, 30).getTime();

const call = {
  callId: 4,
  app: "zoom",
  appLabel: "Zoom",
  videoService: "zoom",
  detectedAtMs: DETECTED_AT,
};

describe("buildDetectedCallCapturePrefill", () => {
  it("names the recording after the app and the time it was noticed", () => {
    expect(buildDetectedCallCapturePrefill(call)).toEqual({
      callId: 4,
      title: "Zoom call, 14:05",
      videoService: "zoom",
    });
    expect(formatDetectedCallClock(new Date(2026, 0, 1, 9, 7).getTime())).toBe("09:07");
    expect(formatDetectedCallClock(Number.NaN)).toBe("");
  });

  it("drops a video service the calendar prefill does not know, and an empty label", () => {
    expect(
      buildDetectedCallCapturePrefill({ ...call, appLabel: "FaceTime", videoService: null })
        ?.videoService,
    ).toBeNull();
    expect(
      buildDetectedCallCapturePrefill({ ...call, videoService: "carrier_pigeon" })?.videoService,
    ).toBeNull();
    expect(buildDetectedCallCapturePrefill({ ...call, appLabel: "  " })).toBeNull();
    expect(
      buildDetectedCallCapturePrefill({ ...call, appLabel: "Microsoft  Teams" })?.title,
    ).toBe("Microsoft Teams call, 14:05");
  });

  it("describes the cue line and the offer rule", () => {
    expect(describeDetectedCall({ appLabel: "Google Meet" })).toBe("Google Meet call in progress");
    expect(detectedCallIsOfferable({ dismissed: false }, false)).toBe(true);
    expect(detectedCallIsOfferable({ dismissed: true }, false)).toBe(false);
    expect(detectedCallIsOfferable({ dismissed: false }, true)).toBe(false);
    expect(detectedCallIsOfferable(null, false)).toBe(false);
  });
});

describe("call capture requests", () => {
  afterEach(() => {
    consumePendingCallCaptureRequest();
  });

  it("normalizes the main process payload and rejects a malformed one", () => {
    expect(normalizeCallCaptureRequest(call)).toEqual(call);
    expect(normalizeCallCaptureRequest({ app: "zoom" })).toBeNull();
    expect(normalizeCallCaptureRequest(null)).toBeNull();
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(
      normalizeCallCaptureRequest({ callId: 1, appLabel: "Zoom" })?.detectedAtMs,
    ).toBe(now);
    vi.restoreAllMocks();
  });

  it("parks a request for a view that mounts later, and delivers it exactly once", () => {
    publishCallCaptureRequest(call);
    const handler = vi.fn();
    const unsubscribe = subscribeCallCaptureRequests(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(call);

    // A second subscriber does not get the consumed request again.
    const second = vi.fn();
    const unsubscribeSecond = subscribeCallCaptureRequests(second);
    expect(second).not.toHaveBeenCalled();

    // Live delivery reaches every mounted listener, and leaves nothing parked.
    const live = { ...call, callId: 5 };
    publishCallCaptureRequest(live);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(live);
    expect(second).toHaveBeenCalledWith(live);
    expect(consumePendingCallCaptureRequest()).toBeNull();

    unsubscribe();
    unsubscribeSecond();
    publishCallCaptureRequest({ ...call, callId: 6 });
    expect(handler).toHaveBeenCalledTimes(2);
    // Nobody was listening, so it waits for the next mount.
    expect(consumePendingCallCaptureRequest()?.callId).toBe(6);
  });
});
