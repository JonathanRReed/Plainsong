import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { getCommandTimeoutMs, getCommandWorkKey } from "../../electron/ipc-command-policy";
import {
  isExpectedSidecarStdinClose,
  MICROPHONE_RECOVERY_MESSAGE,
  retryOnceAfterMicrophonePreparationTimeout,
  SIDECAR_SHUTDOWN_MESSAGE,
  shouldRecycleSidecarAfterCommandError,
} from "../../electron/sidecar-recovery-policy";
import { buildSidecarEnv } from "../../electron/sidecar-env";
import { isRendererCommandAllowed } from "../../electron/ipc-bridge";
import { parseCloudLocationRequest } from "../../electron/privileged-storage-locations";
import {
  CaptureAdmissionController,
  observeCaptureAdmissionForWindow,
} from "../../electron/capture-admission";

describe("privileged storage command admission", () => {
  it("allows native picker requests but never raw privileged approval commands", () => {
    expect(isRendererCommandAllowed("select_export_location")).toBe(true);
    expect(isRendererCommandAllowed("select_backup_location")).toBe(true);
    expect(isRendererCommandAllowed("select_cloud_backup_location")).toBe(true);

    expect(isRendererCommandAllowed("approve_export_location_privileged")).toBe(false);
    expect(isRendererCommandAllowed("approve_backup_location_privileged")).toBe(false);
    expect(isRendererCommandAllowed("approve_cloud_backup_location_privileged")).toBe(false);
  });

  it("rejects renderer path traversal and command injection before confirmation", () => {
    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive;rm",
        folder: "PlainsongBackups",
      }),
    ).toThrow("valid rclone remote");
    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive",
        folder: "../outside",
      }),
    ).toThrow("safe relative path");
    expect(
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive:",
        folder: "PlainsongBackups",
      }),
    ).toEqual({
      provider: "google_drive",
      remoteName: "gdrive",
      folder: "PlainsongBackups",
    });
  });
});

describe("Apple Speech language install admission", () => {
  it("deduplicates equivalent hyphenated and underscored locales", () => {
    const hyphenated = getCommandWorkKey("install_apple_speech_language", {
      locale: "en-US",
    });
    const underscored = getCommandWorkKey("install_apple_speech_language", {
      locale: "en_US",
    });

    expect(hyphenated).toBe("install_apple_speech_language:en_us");
    expect(underscored).toBe(hyphenated);
    expect(getCommandWorkKey("install_apple_speech_language", { locale: "fr_FR" })).toBe(
      "install_apple_speech_language:fr_fr",
    );
  });
});

describe("meeting capture admission", () => {
  it("requires a recent route-bound user input and consumes it once", () => {
    let now = 10_000;
    const admission = new CaptureAdmissionController({
      maxAgeMs: 1_000,
      now: () => now,
    });

    expect(() => admission.consume(7, "plainsong://app/meetings")).toThrow(
      "recent click or key press",
    );

    admission.observe(7, "plainsong://app/meetings");
    const granted = admission.consume(7, "plainsong://app/meetings");
    expect(granted.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => admission.consume(7, "plainsong://app/meetings")).toThrow(
      "recent click or key press",
    );

    admission.observe(7, "plainsong://app/meetings");
    expect(() => admission.consume(8, "plainsong://app/meetings")).toThrow(
      "recent click or key press",
    );
    expect(() => admission.consume(7, "plainsong://app/settings")).toThrow(
      "same page",
    );

    admission.observe(7, "plainsong://app/meetings");
    now += 1_001;
    expect(() => admission.consume(7, "plainsong://app/meetings")).toThrow(
      "recent click or key press",
    );
  });

  it("observes real Electron keyboard and mouse events and clears on destroy", () => {
    const admission = new CaptureAdmissionController();
    const webContents = new EventEmitter() as EventEmitter & {
      getURL: () => string;
    };
    webContents.getURL = () => "plainsong://app/meetings";
    const win = { id: 7, webContents } as unknown as BrowserWindow;

    observeCaptureAdmissionForWindow(win, admission);

    webContents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
    expect(admission.consume(7, webContents.getURL()).windowId).toBe(7);

    webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(admission.consume(7, webContents.getURL()).route).toBe(
      "plainsong://app/meetings",
    );

    webContents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: true });
    expect(() => admission.consume(7, webContents.getURL())).toThrow(
      "recent click or key press",
    );

    webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    webContents.emit("destroyed");
    expect(() => admission.consume(7, webContents.getURL())).toThrow(
      "recent click or key press",
    );
  });

  it("keeps raw start and stop commands outside renderer admission", () => {
    expect(isRendererCommandAllowed("begin_meeting_capture")).toBe(true);
    expect(isRendererCommandAllowed("end_meeting_capture")).toBe(true);
    expect(isRendererCommandAllowed("start_recording")).toBe(false);
    expect(isRendererCommandAllowed("stop_recording")).toBe(false);
  });
});

describe("buildSidecarEnv", () => {
  it("passes only runtime variables needed by the sidecar", () => {
    const env = buildSidecarEnv({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      RUST_LOG: "info",
      OPENAI_API_KEY: "sk-test-secret",
      ELEVENLABS_API_KEY: "xi-test-secret",
      MISTRAL_API_KEY: "mistral-test-secret",
      ANTHROPIC_API_KEY: "anthropic-test-secret",
      GEMINI_API_KEY: "gemini-test-secret",
      DEEPSEEK_API_KEY: "deepseek-test-secret",
      GROQ_API_KEY: "groq-test-secret",
      CO_API_KEY: "cohere-test-secret",
      OLLAMA_CLOUD_API_KEY: "ollama-test-secret",
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
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.CO_API_KEY).toBeUndefined();
    expect(env.OLLAMA_CLOUD_API_KEY).toBeUndefined();
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
  it("keeps main-routed pause and resume on the fast sidecar timeout", () => {
    expect(getCommandTimeoutMs("pause_recording")).toBe(
      getCommandTimeoutMs("pause_meeting_capture"),
    );
    expect(getCommandTimeoutMs("resume_recording")).toBe(
      getCommandTimeoutMs("resume_meeting_capture"),
    );
  });

  it("uses shorter timeouts for quick reads and longer windows for heavy work", () => {
    expect(getCommandTimeoutMs("get_settings")).toBeLessThan(getCommandTimeoutMs("save_settings"));
    expect(getCommandTimeoutMs("download_asr_models")).toBeGreaterThan(
      getCommandTimeoutMs("save_settings"),
    );
    expect(getCommandTimeoutMs("download_bundled_cleanup_model")).toBe(
      getCommandTimeoutMs("download_asr_models"),
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
  it("does not apply the microphone recovery budget to model downloads", async () => {
    const attempt = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("downloaded"), 20)),
    );
    const recover = vi.fn<(remainingMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryOnceAfterMicrophonePreparationTimeout(
        "download_asr_models",
        attempt,
        recover,
        5,
      ),
    ).resolves.toBe("downloaded");
    expect(attempt).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

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
    const recover = vi.fn<(remainingMs: number) => Promise<void>>().mockResolvedValue(undefined);

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
    const recover = vi.fn<(remainingMs: number) => Promise<void>>().mockResolvedValue(undefined);

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

  it("recycles only once after a second stall and does not attempt a third start", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new Error("Timed out waiting for microphone stream preparation"),
      );
    const recover = vi.fn<(remainingMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryOnceAfterMicrophonePreparationTimeout(
        "start_recording",
        attempt,
        recover,
      ),
    ).rejects.toThrow(MICROPHONE_RECOVERY_MESSAGE);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("bounds a stalled process replacement inside the combined recovery budget", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new Error("Timed out waiting for microphone stream preparation"),
      );
    const recover = vi.fn<(remainingMs: number) => Promise<void>>(
      () => new Promise(() => {}),
    );

    const recovery = retryOnceAfterMicrophonePreparationTimeout(
      "start_recording",
      attempt,
      recover,
      25,
    );

    await expect(recovery).rejects.toThrow(MICROPHONE_RECOVERY_MESSAGE);
    expect(attempt).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
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
