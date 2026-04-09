import { describe, expect, it } from "vitest";
import {
  resolveDictationShortcutBehavior,
  resolveDictationShortcutDecision,
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
});
