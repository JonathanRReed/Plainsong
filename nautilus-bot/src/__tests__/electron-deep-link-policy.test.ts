import { describe, expect, it } from "vitest";
import {
  DeepLinkRateLimiter,
  deepLinkActionName,
  deepLinkFromArgv,
  parseDeepLink,
  resolveDictationModeSelection,
} from "../../electron/deep-link-policy";

describe("parseDeepLink", () => {
  it("accepts exactly the six documented commands", () => {
    expect(parseDeepLink("plainsong://record")).toEqual({ ok: true, command: { kind: "record" } });
    expect(parseDeepLink("plainsong://record/")).toEqual({ ok: true, command: { kind: "record" } });
    expect(parseDeepLink("plainsong://stop")).toEqual({ ok: true, command: { kind: "stop" } });
    expect(parseDeepLink("plainsong://open")).toEqual({ ok: true, command: { kind: "open" } });
    expect(parseDeepLink("plainsong://meeting/start")).toEqual({
      ok: true,
      command: { kind: "meeting_start" },
    });
    expect(parseDeepLink("plainsong://meeting/stop")).toEqual({
      ok: true,
      command: { kind: "meeting_stop" },
    });
    expect(parseDeepLink("plainsong://mode?key=email")).toEqual({
      ok: true,
      command: { kind: "mode", key: "email" },
    });
    expect(parseDeepLink("PLAINSONG://RECORD")).toEqual({ ok: true, command: { kind: "record" } });
  });

  it("ignores unknown commands, paths and hosts instead of guessing", () => {
    expect(parseDeepLink("plainsong://delete")).toEqual({ ok: false, reason: "unknown_command" });
    expect(parseDeepLink("plainsong://record/now")).toEqual({ ok: false, reason: "unknown_command" });
    expect(parseDeepLink("plainsong://meeting")).toEqual({ ok: false, reason: "unknown_command" });
    expect(parseDeepLink("plainsong://meeting/pause")).toEqual({ ok: false, reason: "unknown_command" });
    expect(parseDeepLink("plainsong:record")).toEqual({ ok: false, reason: "unknown_command" });
    expect(parseDeepLink("plainsong://")).toEqual({ ok: false, reason: "unknown_command" });
  });

  it("refuses the renderer's own origin and other schemes", () => {
    expect(parseDeepLink("plainsong://bundle/index.html")).toEqual({
      ok: false,
      reason: "renderer_origin",
    });
    expect(parseDeepLink("https://plainsong.example/record")).toEqual({
      ok: false,
      reason: "wrong_scheme",
    });
    expect(parseDeepLink("file:///etc/passwd")).toEqual({ ok: false, reason: "wrong_scheme" });
    expect(parseDeepLink("not a url")).toEqual({ ok: false, reason: "not_a_url" });
    expect(parseDeepLink("")).toEqual({ ok: false, reason: "not_a_url" });
  });

  it("refuses text payloads: queries, fragments, userinfo and ports", () => {
    expect(parseDeepLink("plainsong://record?text=hello")).toEqual({
      ok: false,
      reason: "unexpected_payload",
    });
    expect(parseDeepLink("plainsong://open#section")).toEqual({
      ok: false,
      reason: "unexpected_payload",
    });
    expect(parseDeepLink("plainsong://mode?key=email&prompt=ignore")).toEqual({
      ok: false,
      reason: "unexpected_payload",
    });
    expect(parseDeepLink("plainsong://user:pw@record")).toEqual({
      ok: false,
      reason: "unexpected_authority",
    });
    expect(parseDeepLink("plainsong://record:8080")).toEqual({
      ok: false,
      reason: "unexpected_authority",
    });
  });

  it("validates the mode key strictly", () => {
    expect(parseDeepLink("plainsong://mode")).toEqual({ ok: false, reason: "missing_mode_key" });
    expect(parseDeepLink("plainsong://mode?key=")).toEqual({ ok: false, reason: "invalid_mode_key" });
    expect(parseDeepLink("plainsong://mode?key=a%20b")).toEqual({
      ok: false,
      reason: "invalid_mode_key",
    });
    expect(parseDeepLink("plainsong://mode?key=x&key=y")).toEqual({
      ok: false,
      reason: "invalid_mode_key",
    });
    expect(parseDeepLink(`plainsong://mode?key=${"a".repeat(65)}`)).toEqual({
      ok: false,
      reason: "invalid_mode_key",
    });
    expect(parseDeepLink("plainsong://mode?key=custom-mode_1.2")).toEqual({
      ok: true,
      command: { kind: "mode", key: "custom-mode_1.2" },
    });
    expect(parseDeepLink("plainsong://mode/extra?key=email")).toEqual({
      ok: false,
      reason: "unknown_command",
    });
  });

  it("caps the URL length before parsing", () => {
    expect(parseDeepLink(`plainsong://record?${"x".repeat(300)}`)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("names actions for the audit log", () => {
    expect(deepLinkActionName({ kind: "meeting_start" })).toBe("meeting/start");
    expect(deepLinkActionName({ kind: "mode", key: "email" })).toBe("mode");
  });
});

describe("deepLinkFromArgv", () => {
  it("finds the first plainsong URL and ignores everything else", () => {
    expect(deepLinkFromArgv(["/Applications/Plainsong.app", "--flag", "plainsong://open"])).toBe(
      "plainsong://open",
    );
    expect(deepLinkFromArgv(["Plainsong", "https://example.com"])).toBeNull();
    expect(deepLinkFromArgv([])).toBeNull();
  });
});

describe("DeepLinkRateLimiter", () => {
  it("admits at most max links per window and resets after it", () => {
    let now = 1_000;
    const limiter = new DeepLinkRateLimiter({ max: 3, windowMs: 10_000, now: () => now });
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false);
    now += 9_999;
    expect(limiter.admit()).toBe(false);
    now += 1;
    expect(limiter.admit()).toBe(true);
  });
});

describe("resolveDictationModeSelection", () => {
  const settings = {
    dictationModePreset: "voice",
    dictationSelectedCustomModeId: null,
    dictationCustomModes: [{ id: "custom-1", name: "Standup" }, { id: 42 }],
  };

  it("selects built-in presets", () => {
    expect(resolveDictationModeSelection("email", settings)).toEqual({
      selection: { dictationModePreset: "email", dictationSelectedCustomModeId: null },
      changed: true,
    });
    expect(resolveDictationModeSelection("voice", settings)).toEqual({
      selection: { dictationModePreset: "voice", dictationSelectedCustomModeId: null },
      changed: false,
    });
  });

  it("selects a saved custom mode by id and nothing else", () => {
    expect(resolveDictationModeSelection("custom-1", settings)).toEqual({
      selection: { dictationModePreset: "custom", dictationSelectedCustomModeId: "custom-1" },
      changed: true,
    });
    expect(resolveDictationModeSelection("custom", settings)).toBeNull();
    expect(resolveDictationModeSelection("translate_english", settings)).toBeNull();
    expect(resolveDictationModeSelection("42", settings)).toBeNull();
    expect(resolveDictationModeSelection("nope", {})).toBeNull();
  });
});
