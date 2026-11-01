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
      maxRecordingMinutes: 0,
      rememberVoices: false,
      autoApplyConfidentVoices: false,
      preferProviderDiarization: true,
      calendarDisconnected: false,
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
          maxRecordingMinutes: 0,
          rememberVoices: true,
          autoApplyConfidentVoices: true,
          preferProviderDiarization: false,
          calendarDisconnected: true,
        },
      }),
    ).toEqual({
      callDetectionEnabled: false,
      autoStopWhenCallAppQuits: false,
      autoStopAfterSilenceMinutes: 0,
      maxRecordingMinutes: 0,
      rememberVoices: true,
      autoApplyConfidentVoices: true,
      preferProviderDiarization: false,
      calendarDisconnected: true,
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

  it.each([
    [undefined, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0],
    ["30", 0], [-4, 0], [0, 0], [1.4, 1], [1.5, 2], [240, 240], [9999, 240],
  ])("normalizes maximum captured minutes %s to %s", (input, expected) => {
    const resolved = resolveMeetingsSettings({ meetings: { maxRecordingMinutes: input, autoStopAfterSilenceMinutes: 9, callDetectionEnabled: false } as never });
    expect(resolved.maxRecordingMinutes).toBe(expected);
    expect(resolved.autoStopAfterSilenceMinutes).toBe(9);
    expect(resolved.callDetectionEnabled).toBe(false);
  });

  // Voiceprints are opt-in, so a settings file written before they existed —
  // every settings file on every machine today — must resolve to both off.
  it("leaves voiceprints off for a settings file written before they existed", () => {
    const resolved = resolveMeetingsSettings({
      meetings: { callDetectionEnabled: true } as never,
    });
    expect(resolved.rememberVoices).toBe(false);
    expect(resolved.autoApplyConfidentVoices).toBe(false);
  });

  // Mirrors `normalize_loaded_meetings_settings` in settings.rs: auto-apply
  // refines remembering and cannot outlive it.
  it("turns auto-apply off when remembering voices is off", () => {
    expect(
      resolveMeetingsSettings({
        meetings: {
          rememberVoices: false,
          autoApplyConfidentVoices: true,
        } as never,
      }).autoApplyConfidentVoices,
    ).toBe(false);
    expect(
      resolveMeetingsSettings({
        meetings: {
          rememberVoices: true,
          autoApplyConfidentVoices: true,
        } as never,
      }).autoApplyConfidentVoices,
    ).toBe(true);
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
