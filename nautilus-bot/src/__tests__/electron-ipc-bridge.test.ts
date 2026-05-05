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
      NAUTILUS_DATA_DIR: "/tmp/nautilus",
    });

    expect(env).toMatchObject({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      RUST_LOG: "info",
      NAUTILUS_DATA_DIR: "/tmp/nautilus",
      OPENAI_API_KEY: "sk-test-secret",
      ELEVENLABS_API_KEY: "xi-test-secret",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("getCommandTimeoutMs", () => {
  it("uses shorter timeouts for quick reads and longer windows for heavy work", () => {
    expect(getCommandTimeoutMs("get_settings")).toBeLessThan(getCommandTimeoutMs("save_settings"));
    expect(getCommandTimeoutMs("download_asr_models")).toBeGreaterThan(
      getCommandTimeoutMs("save_settings"),
    );
    expect(getCommandTimeoutMs("stop_dictation")).toBeGreaterThan(getCommandTimeoutMs("get_settings"));
  });
});
