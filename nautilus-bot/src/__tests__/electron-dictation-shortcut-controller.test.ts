import { describe, expect, it } from "vitest";
import {
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
  resolveDictationShortcutDecision,
  shouldHandleDictationShortcutSource,
} from "../../electron/dictation-shortcut-controller";

describe("resolveDictationShortcutBehavior", () => {
  it("prefers hands-free when enabled", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: true,
        dictationHandsFreeEnabled: true,
      }),
    ).toBe("hands_free");
  });

  it("maps push-to-talk to hold-to-talk", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: true,
        dictationHandsFreeEnabled: false,
      }),
    ).toBe("hold_to_talk");
  });

  it("falls back to toggle", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: false,
        dictationHandsFreeEnabled: false,
      }),
    ).toBe("toggle");
  });
});

describe("resolveDictationShortcutDecision", () => {
  it("starts from idle on press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "idle",
        behavior: "hold_to_talk",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "start",
      usesPressOnlyFallback: true,
    });
  });

  it("stops on second press while recording in press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "toggle",
      usesPressOnlyFallback: true,
    });
  });

  it("ignores presses while transcribing in press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "transcribing",
        behavior: "toggle",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "ignore",
    });
  });

  it("supports release-to-stop when release events exist", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "released",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "release",
      usesPressOnlyFallback: false,
    });
  });

  it("uses hands-free specific stop reason", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hands_free",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "hands_free_toggle",
    });
  });

  it("cancels (discards) a recording session on a cancelled signal", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "cancelled",
      }),
    ).toMatchObject({
      action: "cancel",
      stopReason: "cancelled",
    });
  });

  it("ignores a cancelled signal outside of an active recording", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "idle",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "cancelled",
      }),
    ).toMatchObject({
      action: "ignore",
      stopReason: null,
    });
  });
});

describe("resolveDictationShortcutCapability", () => {
  it("reports press-and-release only when hold-to-talk is selected and the native helper is available", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "hold_to_talk",
      }),
    ).toBe("press_and_release");
  });

  it("falls back to press-only when the native helper is unavailable", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: false,
        behavior: "hold_to_talk",
      }),
    ).toBe("press_only");
  });

  it("stays press-only for toggle and hands-free behaviors even when the native helper is available", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "toggle",
      }),
    ).toBe("press_only");
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "hands_free",
      }),
    ).toBe("press_only");
  });
});

describe("shouldHandleDictationShortcutSource", () => {
  it("always handles native-sourced events", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "native",
        nativeShortcutAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldHandleDictationShortcutSource({
        source: "native",
        nativeShortcutAvailable: false,
      }),
    ).toBe(true);
  });

  it("ignores electron-sourced events once the native helper takes over", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "electron",
        nativeShortcutAvailable: true,
      }),
    ).toBe(false);
  });

  it("falls back to handling electron-sourced events when the native helper is unavailable", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "electron",
        nativeShortcutAvailable: false,
      }),
    ).toBe(true);
  });
});
