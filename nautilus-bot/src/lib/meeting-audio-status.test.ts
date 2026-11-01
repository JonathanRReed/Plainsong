import { describe, expect, it } from "vitest";
import type { SystemAudioCapability } from "@/lib/backend/recordings";
import { meterFill } from "@/components/meetings/meeting-source-levels";
import {
  describeMeetingAudio,
  isMeetingAudioReady,
  MEETING_AUDIO_EXPLAINER,
} from "@/lib/meeting-audio-status";

function capability(overrides: Partial<SystemAudioCapability> = {}): SystemAudioCapability {
  return {
    backend: "core_audio_process_tap",
    nativeOsSupported: true,
    nativeOsEnabled: true,
    routeDevice: "Sound playing on this Mac",
    routeId: "system-output:all-apps",
    nativeSampleRate: 48000,
    nativeChannels: 2,
    readiness: "unverified",
    ready: false,
    reason: null,
    actionableReason: null,
    permission: "not_determined",
    ...overrides,
  };
}

const JARGON = /core audio|process tap|loopback|aggregate|tcc|duplex/i;

describe("describeMeetingAudio", () => {
  it("says the built-in route works with headphones once ready", () => {
    const status = describeMeetingAudio(
      capability({ ready: true, readiness: "ready", permission: "granted" }),
    );
    expect(status.state).toBe("ready");
    expect(status.action).toBeNull();
    expect(status.sentence).toMatch(/with or without headphones/);
    expect(MEETING_AUDIO_EXPLAINER).toMatch(/works with headphones/);
    // The choice itself says that everything the Mac plays is recorded, in
    // one sentence, as PRIVACY.md does.
    expect(MEETING_AUDIO_EXPLAINER).toMatch(/every sound this Mac plays during the meeting/);
    expect(MEETING_AUDIO_EXPLAINER).toMatch(/music, videos and notifications/);
    expect(MEETING_AUDIO_EXPLAINER.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });

  it("offers Allow before macOS has asked, and never a settings detour", () => {
    for (const permission of ["not_determined", "unknown", null] as const) {
      const status = describeMeetingAudio(capability({ permission }));
      expect(status.state).toBe("needs_permission");
      expect(status.action).toBe("allow");
      expect(status.actionLabel).toBe("Allow meeting audio");
    }
  });

  it("sends a denied permission to System Settings with the pane named", () => {
    for (const overrides of [
      { permission: "denied" as const },
      { permission: "unknown" as const, reason: "permission_denied" as const },
    ]) {
      const status = describeMeetingAudio(capability(overrides));
      expect(status.state).toBe("denied");
      expect(status.action).toBe("open_settings");
      expect(status.actionLabel).toBe("Open System Settings");
      expect(status.sentence).toContain("Screen & System Audio Recording");
    }
  });

  it("offers a re-check after another failure and shows the sidecar's plain reason", () => {
    const status = describeMeetingAudio(
      capability({
        permission: "granted",
        reason: "silent_stream",
        actionableReason: "Plainsong couldn't hear the sound playing on this Mac.",
      }),
    );
    expect(status.state).toBe("needs_check");
    expect(status.action).toBe("check");
    expect(status.sentence).toBe("Plainsong couldn't hear the sound playing on this Mac.");
  });

  it("names a reader's own routing app only when they set one up", () => {
    const status = describeMeetingAudio(
      capability({ backend: "virtual_loopback", routeDevice: "BlackHole 2ch", permission: null }),
    );
    expect(status.state).toBe("needs_check");
    expect(status.sentence).toContain("BlackHole 2ch");
    expect(
      describeMeetingAudio(
        capability({ backend: "virtual_loopback", routeDevice: "BlackHole 2ch", ready: true, readiness: "ready" }),
      ).sentence,
    ).toBe("Ready. Plainsong hears the meeting through BlackHole 2ch.");
  });

  it("keeps Me + Them unavailable without a route and never claims readiness from a stray flag", () => {
    expect(describeMeetingAudio(capability({ backend: "none", ready: true, readiness: "ready" })).state).toBe(
      "unavailable",
    );
    expect(isMeetingAudioReady(capability({ ready: true, readiness: "unverified" }))).toBe(false);
    expect(describeMeetingAudio(null).state).toBe("checking");
  });

  it("keeps mechanism jargon out of every sentence it writes", () => {
    const cases: Array<SystemAudioCapability | null> = [
      null,
      capability(),
      capability({ permission: "denied" }),
      capability({ ready: true, readiness: "ready" }),
      capability({ reason: "silent_stream" }),
      capability({ backend: "virtual_loopback", routeDevice: null }),
      capability({ backend: "none", actionableReason: null }),
    ];
    for (const value of cases) {
      const status = describeMeetingAudio(value);
      expect(status.sentence).not.toMatch(JARGON);
      expect(status.label).not.toMatch(JARGON);
    }
  });
});

describe("meterFill", () => {
  it("maps RMS onto a decibel meter that speech can move", () => {
    expect(meterFill(0)).toBe(0);
    expect(meterFill(null)).toBe(0);
    expect(meterFill(Number.NaN)).toBe(0);
    expect(meterFill(0.001)).toBe(0); // -60 dB: the floor
    expect(meterFill(0.3)).toBe(1); // above -12 dB: full
    const speech = meterFill(0.03); // about -30 dB
    expect(speech).toBeGreaterThan(0.4);
    expect(speech).toBeLessThan(0.8);
  });
});
