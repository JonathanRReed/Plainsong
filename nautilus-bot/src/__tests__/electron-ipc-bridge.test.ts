import { describe, expect, it } from "vitest";
import { getCommandTimeoutMs } from "../../electron/ipc-command-policy";
import { buildSidecarEnv } from "../../electron/sidecar-env";

describe("buildSidecarEnv", () => {
  it("passes only runtime variables needed by the sidecar", () => {
    const env = buildSidecarEnv({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      RUST_LOG: "info",
      OPENAI_API_KEY: "sk-test-secret",
      ELEVENLABS_API_KEY: "xi-test-secret",
      GITHUB_TOKEN: "ghp_secret",
      PLAINSONG_DATA_DIR: "/tmp/nautilus",
      PLAINSONG_MACOS_SPEECH_HELPER_PATH: "/tmp/untrusted-helper",
    });

    expect(env).toMatchObject({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      RUST_LOG: "info",
      PLAINSONG_DATA_DIR: "/tmp/nautilus",
      OPENAI_API_KEY: "sk-test-secret",
      ELEVENLABS_API_KEY: "xi-test-secret",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PLAINSONG_MACOS_SPEECH_HELPER_PATH).toBeUndefined();
  });
});

describe("getCommandTimeoutMs", () => {
  it("uses shorter timeouts for quick reads and longer windows for heavy work", () => {
    expect(getCommandTimeoutMs("get_settings")).toBeLessThan(getCommandTimeoutMs("save_settings"));
    expect(getCommandTimeoutMs("download_asr_models")).toBeGreaterThan(
      getCommandTimeoutMs("save_settings"),
    );
    expect(getCommandTimeoutMs("stop_dictation")).toBeGreaterThan(getCommandTimeoutMs("get_settings"));
    expect(getCommandTimeoutMs("extract_action_items_grounded")).toBe(
      getCommandTimeoutMs("summarize_recording_grounded"),
    );
    expect(getCommandTimeoutMs("summarize_recording_grounded")).toBeGreaterThan(
      getCommandTimeoutMs("download_asr_models"),
    );
  });
});
