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

vi.mock("electron/main", () => ({
  ipcMain: { handle: vi.fn() },
}));

describe("privileged storage command admission", () => {
  it("rejects path-based ASR benchmarks while admitting audio bytes", () => {
    expect(isRendererCommandAllowed("benchmark_asr_providers")).toBe(false);
    expect(isRendererCommandAllowed("benchmark_asr_providers_bytes")).toBe(true);
  });
  it("allows explicit correction consent with the ordinary settings timeout", () => {
    expect(isRendererCommandAllowed("set_dictation_external_correction_learning")).toBe(true);
    expect(getCommandTimeoutMs("set_dictation_external_correction_learning")).toBe(getCommandTimeoutMs("save_settings"));
  });
  it("allows dedicated saved-prompt writes with the ordinary settings timeout", () => {
    expect(isRendererCommandAllowed("set_saved_prompts")).toBe(true);
    expect(getCommandTimeoutMs("set_saved_prompts")).toBe(getCommandTimeoutMs("save_settings"));
  });
  it("never exposes instance pressure injection to the renderer", () => {
    for (const command of ["qa_pressure", "simulate_memory_pressure", "set_memory_pressure", "PLAINSONG_QA_PRESSURE_FILE"]) {
      expect(isRendererCommandAllowed(command)).toBe(false);
    }
  });

  it("does not expose the system-wide insertion smoke test to the renderer", () => {
    expect(isRendererCommandAllowed("smoke_test_cursor_insert")).toBe(false);
    expect(isRendererCommandAllowed("qa_smoke_test_cursor_insert")).toBe(false);
  });

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

  it.each([
    { name: "null bytes", folder: "Backups\u0000/secret" },
    { name: "Windows drive prefixes", folder: "C:Backups" },
  ])("rejects $name in cloud backup folders", ({ folder }) => {
    for (const provider of ["i_cloud", "google_drive"]) {
      expect(() =>
        parseCloudLocationRequest({ provider, remoteName: "gdrive", folder }),
      ).toThrow("safe relative path");
    }
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
  it("passes ephemeral credentials only in explicit QA mode", () => {
    for (const qaMode of [undefined, "0", "true"]) {
      expect(buildSidecarEnv({
        PLAINSONG_QA_MODE: qaMode,
        PLAINSONG_QA_EPHEMERAL_SECRETS: "1",
      }).PLAINSONG_QA_EPHEMERAL_SECRETS).toBeUndefined();
    }
    expect(buildSidecarEnv({
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_QA_EPHEMERAL_SECRETS: "1",
    }).PLAINSONG_QA_EPHEMERAL_SECRETS).toBe("1");
  });

  it("passes the instance pressure file only in explicit QA mode", () => {
    for (const qaMode of [undefined, "0", "true"]) {
      expect(buildSidecarEnv({
        PLAINSONG_QA_MODE: qaMode,
        PLAINSONG_QA_PRESSURE_FILE: "/tmp/owned-qa/pressure",
      }).PLAINSONG_QA_PRESSURE_FILE).toBeUndefined();
    }
    expect(buildSidecarEnv({
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_QA_PRESSURE_FILE: "/tmp/owned-qa/pressure",
    }).PLAINSONG_QA_PRESSURE_FILE).toBe("/tmp/owned-qa/pressure");
  });

  it("lets only QA mode make the sidecar plan for a smaller Mac", () => {
    expect(buildSidecarEnv({
      PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB: "8",
    }).PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB).toBeUndefined();
    expect(buildSidecarEnv({
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB: "8",
    }).PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB).toBe("8");
  });

  it("lets only QA mode simulate the memory other apps leave free", () => {
    const outsideQa = buildSidecarEnv({
      PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB: "8",
      PLAINSONG_SIMULATE_AVAILABLE_GB: "2.5",
      PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES: "1",
    });
    expect(outsideQa.PLAINSONG_SIMULATE_AVAILABLE_GB).toBeUndefined();
    expect(outsideQa.PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES).toBeUndefined();
    const qa = buildSidecarEnv({
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB: "8",
      PLAINSONG_SIMULATE_AVAILABLE_GB: "2.5",
      PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES: "1",
    });
    expect(qa.PLAINSONG_SIMULATE_AVAILABLE_GB).toBe("2.5");
    // The baseline is the sidecar's own, passed only to its helpers.
    expect(qa.PLAINSONG_SIMULATE_AVAILABLE_BASELINE_BYTES).toBeUndefined();
  });

  it("passes only runtime variables needed by the sidecar", () => {
    const env = buildSidecarEnv({
      HOME: "/Users/test",
      PATH: "/tmp/hostile-bin:/usr/bin",
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
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
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

    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
    expect(env.PLAINSONG_CONFIG_DIR).toBeUndefined();
    expect(env.PLAINSONG_DATA_DIR).toBeUndefined();
  });

  it("does not pass a hostile inherited PATH to the privileged sidecar", () => {
    const env = buildSidecarEnv({ PATH: "/tmp/hostile-bin:/usr/bin" }, "darwin");

    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
    expect(env.PATH).not.toContain("/tmp/hostile-bin");
  });

  it("preserves Windows PATH for platform-provided helper lookup", () => {
    const windowsPath = "C:\\Program Files\\rclone;C:\\Windows\\System32";
    const env = buildSidecarEnv({ PATH: windowsPath }, "win32");

    expect(env.PATH).toBe(windowsPath);
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
    expect(getCommandTimeoutMs("install_ollama_model")).toBe(
      getCommandTimeoutMs("download_asr_models"),
    );
    expect(getCommandTimeoutMs("stop_dictation")).toBeGreaterThan(getCommandTimeoutMs("get_settings"));
    expect(getCommandTimeoutMs("extract_action_items_grounded")).toBe(
      getCommandTimeoutMs("summarize_recording_grounded"),
    );
    expect(getCommandTimeoutMs("summarize_recording_grounded")).toBeGreaterThan(
      getCommandTimeoutMs("save_settings"),
    );
  });

  it("lets every model download outlast a slow connection", () => {
    // The sidecar stops a stalled transfer on its own; the bridge only has to
    // outlast a large download on a slow link. The 1.1 GB cleanup model at
    // 2 Mbit/s is ~75 min.
    for (const command of [
      "download_asr_models",
      "download_bundled_cleanup_model",
      "download_diarization_model",
      "download_embedding_model",
      "download_live_preview_engine_model",
      "download_native_text_model",
      "download_silero_vad_model",
      "download_whisper_model",
      "install_ollama_model",
    ]) {
      expect(getCommandTimeoutMs(command), command).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    }
  });

  it("treats meeting briefs as event-scoped analysis work", () => {
    expect(getCommandTimeoutMs("prepare_meeting_brief")).toBe(
      getCommandTimeoutMs("summarize_recording_grounded"),
    );
    expect(getCommandWorkKey("prepare_meeting_brief", { eventId: " event-1 " })).toBe(
      "prepare_meeting_brief:event-1",
    );
  });
});

describe("sidecar fault recovery policy", () => {
  it("does not reject a healthy start while the capture operation remains live", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn(() => new Promise<string>(resolve => {
        setTimeout(() => resolve("recording-active"), 20);
      }));
      const recover = vi.fn().mockResolvedValue(undefined);
      let settled = false;
      const result = retryOnceAfterMicrophonePreparationTimeout("start_recording", attempt, recover, 5)
        .then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toBe("recording-active");
      expect(recover).not.toHaveBeenCalled();
      expect(attempt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits the retry result after recovery instead of leaving a live capture behind a timeout", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("Timed out waiting for microphone stream preparation"))
        .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve("recording-recovered"), 20)));
      const recover = vi.fn().mockResolvedValue(undefined);
      const result = retryOnceAfterMicrophonePreparationTimeout("start_recording", attempt, recover, 5);
      await vi.advanceTimersByTimeAsync(20);
      await expect(result).resolves.toBe("recording-recovered");
      expect(recover).toHaveBeenCalledOnce();
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
