import { describe, expect, it, vi } from "vitest";
import { getCommandTimeoutMs } from "../../electron/ipc-command-policy";
import {
  isExpectedSidecarStdinClose,
  MICROPHONE_RECOVERY_MESSAGE,
  retryOnceAfterMicrophonePreparationTimeout,
  SIDECAR_SHUTDOWN_MESSAGE,
  shouldRecycleSidecarAfterCommandError,
} from "../../electron/sidecar-recovery-policy";
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
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_CONFIG_DIR: "/tmp/nautilus-config",
      PLAINSONG_DATA_DIR: "/tmp/nautilus",
      PLAINSONG_MACOS_SPEECH_HELPER_PATH: "/tmp/untrusted-helper",
    });

    expect(env).toMatchObject({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      RUST_LOG: "info",
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_CONFIG_DIR: "/tmp/nautilus-config",
      PLAINSONG_DATA_DIR: "/tmp/nautilus",
      OPENAI_API_KEY: "sk-test-secret",
      ELEVENLABS_API_KEY: "xi-test-secret",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PLAINSONG_MACOS_SPEECH_HELPER_PATH).toBeUndefined();
  });

  it("does not redirect sidecar storage outside explicit QA mode", () => {
    const env = buildSidecarEnv({
      PATH: "/usr/bin",
      PLAINSONG_CONFIG_DIR: "/tmp/nautilus-config",
      PLAINSONG_DATA_DIR: "/tmp/nautilus",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.PLAINSONG_CONFIG_DIR).toBeUndefined();
    expect(env.PLAINSONG_DATA_DIR).toBeUndefined();
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

describe("sidecar fault recovery policy", () => {
  it("recycles recording and dictation commands whose microphone preparation timed out", () => {
    const recordingTimeout = new Error(
      "Timed out waiting for microphone stream preparation. Plainsong is restarting audio capture automatically; retry in a moment.",
    );
    const dictationTimeout = new Error(
      "Timed out waiting for dictation microphone stream to start. Plainsong is restarting audio capture automatically; retry in a moment.",
    );

    expect(
      shouldRecycleSidecarAfterCommandError("start_recording", recordingTimeout),
    ).toBe(true);
    expect(
      shouldRecycleSidecarAfterCommandError("start_dictation", dictationTimeout),
    ).toBe(true);
    expect(
      shouldRecycleSidecarAfterCommandError("start_recording", dictationTimeout),
    ).toBe(false);
    expect(
      shouldRecycleSidecarAfterCommandError("start_dictation", recordingTimeout),
    ).toBe(false);
    expect(
      shouldRecycleSidecarAfterCommandError(
        "start_recording",
        new Error("Microphone permission is not ready"),
      ),
    ).toBe(false);
  });

  it("gives the user an actionable retry message after automatic recovery", () => {
    expect(MICROPHONE_RECOVERY_MESSAGE).toContain(
      "restarted audio capture automatically",
    );
    expect(MICROPHONE_RECOVERY_MESSAGE).toContain("Retry in a moment");
  });

  it("restarts the sidecar and retries one recoverable microphone start", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error("Timed out waiting for microphone stream preparation"),
      )
      .mockResolvedValueOnce("recording-recovered");
    const recover = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryOnceAfterMicrophonePreparationTimeout(
        "start_recording",
        attempt,
        recover,
      ),
    ).resolves.toBe("recording-recovered");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("never retries ordinary start failures", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("Microphone permission is not ready"));
    const recover = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryOnceAfterMicrophonePreparationTimeout(
        "start_recording",
        attempt,
        recover,
      ),
    ).rejects.toThrow("Microphone permission is not ready");
    expect(attempt).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it("recycles after a second stall but does not attempt a third start", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new Error("Timed out waiting for microphone stream preparation"),
      );
    const recover = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryOnceAfterMicrophonePreparationTimeout(
        "start_recording",
        attempt,
        recover,
      ),
    ).rejects.toThrow(MICROPHONE_RECOVERY_MESSAGE);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(2);
  });
});

describe("sidecar shutdown policy", () => {
  it("recognizes only the stream errors expected when the sidecar closes stdin", () => {
    expect(isExpectedSidecarStdinClose({ code: "EPIPE" })).toBe(true);
    expect(
      isExpectedSidecarStdinClose({ code: "ERR_STREAM_DESTROYED" })
    ).toBe(true);
    expect(isExpectedSidecarStdinClose({ code: "EACCES" })).toBe(false);
    expect(isExpectedSidecarStdinClose(new Error("write failed"))).toBe(false);
  });

  it("uses a stable shutdown rejection instead of sending new sidecar writes", () => {
    expect(SIDECAR_SHUTDOWN_MESSAGE).toBe("Plainsong is shutting down");
  });
});
