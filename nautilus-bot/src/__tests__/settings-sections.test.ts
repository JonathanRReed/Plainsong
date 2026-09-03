import { describe, expect, it } from "vitest";
import {
  MEETING_AUTO_STOP_SILENCE_MINUTES_MAX,
  resolveMeetingsSettings,
  resolveNotificationsSettings,
} from "@/lib/settings-sections";

describe("resolveMeetingsSettings", () => {
  it("matches the Rust defaults when the section is missing", () => {
    expect(resolveMeetingsSettings(null)).toEqual({
      callDetectionEnabled: true,
      autoStopWhenCallAppQuits: true,
      autoStopAfterSilenceMinutes: 15,
      preferProviderDiarization: true,
    });
    expect(resolveMeetingsSettings({})).toEqual(resolveMeetingsSettings(undefined));
  });

  it("keeps explicit values and clamps the silence minutes like the sidecar does", () => {
    expect(
      resolveMeetingsSettings({
        meetings: {
          callDetectionEnabled: false,
          autoStopWhenCallAppQuits: false,
          autoStopAfterSilenceMinutes: 0,
          preferProviderDiarization: false,
        },
      }),
    ).toEqual({
      callDetectionEnabled: false,
      autoStopWhenCallAppQuits: false,
      autoStopAfterSilenceMinutes: 0,
      preferProviderDiarization: false,
    });
    const partial = resolveMeetingsSettings({
      meetings: { autoStopAfterSilenceMinutes: 9_999 } as never,
    });
    expect(partial.autoStopAfterSilenceMinutes).toBe(MEETING_AUTO_STOP_SILENCE_MINUTES_MAX);
    expect(partial.callDetectionEnabled).toBe(true);
    // A settings file written before provider diarization existed is not a
    // user who opted out of it.
    expect(partial.preferProviderDiarization).toBe(true);
    expect(
      resolveMeetingsSettings({
        meetings: { autoStopAfterSilenceMinutes: -4 } as never,
      }).autoStopAfterSilenceMinutes,
    ).toBe(0);
    expect(
      resolveMeetingsSettings({
        meetings: { autoStopAfterSilenceMinutes: Number.NaN } as never,
      }).autoStopAfterSilenceMinutes,
    ).toBe(15);
  });
});

describe("resolveNotificationsSettings", () => {
  it("defaults both classes to on and honours an explicit off", () => {
    expect(resolveNotificationsSettings(null)).toEqual({
      meetingEvents: true,
      dictationFailures: true,
    });
    expect(
      resolveNotificationsSettings({ notifications: { meetingEvents: false } as never }),
    ).toEqual({ meetingEvents: false, dictationFailures: true });
  });
});
