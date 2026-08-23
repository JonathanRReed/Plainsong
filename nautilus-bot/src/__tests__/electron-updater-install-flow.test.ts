import { describe, expect, it, vi } from "vitest";
import { runExplicitUpdaterInstallFlow } from "../../electron/updater-install-flow";

function updater() {
  let updateDownloadedListener: (() => void) | null = null;
  return {
    autoInstallOnAppQuit: false,
    downloadUpdate: vi.fn(async () => {
      updateDownloadedListener?.();
    }),
    quitAndInstall: vi.fn(),
    once: vi.fn((_event: "update-downloaded", listener: () => void) => {
      updateDownloadedListener = listener;
    }),
    removeListener: vi.fn((_event: "update-downloaded", listener: () => void) => {
      if (updateDownloadedListener === listener) updateDownloadedListener = null;
    }),
    emitUpdateDownloaded: () => updateDownloadedListener?.(),
  };
}

function macFlow(overrides: Record<string, unknown> = {}) {
  const value = updater();
  const quitApp = vi.fn();
  const waitForMacosStaging = vi.fn(async () => undefined);
  const launchMacosRelauncher = vi.fn(async () => undefined);
  const onFailure = vi.fn();
  return {
    updater: value,
    quitApp,
    waitForMacosStaging,
    launchMacosRelauncher,
    onFailure,
    options: {
      platform: "darwin" as const,
      updater: value,
      updateReadyToInstall: false,
      setDownloading: vi.fn(),
      setInstalling: vi.fn(),
      waitForMacosStaging,
      launchMacosRelauncher,
      quitApp,
      onFailure,
      ...overrides,
    },
  };
}

describe("explicit updater install flow", () => {
  it("does not arm install-on-quit while a requested update is still downloading", async () => {
    const flow = macFlow();
    let finishDownload: (() => void) | undefined;
    flow.updater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );

    const install = runExplicitUpdaterInstallFlow(flow.options);
    await vi.waitFor(() => {
      expect(flow.updater.downloadUpdate).toHaveBeenCalledOnce();
    });

    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    flow.updater.emitUpdateDownloaded();
    finishDownload?.();
    await install;
    expect(flow.updater.autoInstallOnAppQuit).toBe(true);
  });

  it("downloads, binds staging, launches the helper, and only then quits", async () => {
    const flow = macFlow();

    await runExplicitUpdaterInstallFlow(flow.options);

    expect(flow.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(flow.waitForMacosStaging).toHaveBeenCalledOnce();
    expect(flow.launchMacosRelauncher).toHaveBeenCalledOnce();
    expect(flow.quitApp).toHaveBeenCalledOnce();
    expect(flow.updater.autoInstallOnAppQuit).toBe(true);
    expect(flow.onFailure).not.toHaveBeenCalled();
  });

  it("disarms install-on-quit and does not quit after download failure", async () => {
    const flow = macFlow();
    flow.updater.downloadUpdate.mockRejectedValueOnce(new Error("download failed"));

    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow(
      "download failed",
    );

    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.waitForMacosStaging).not.toHaveBeenCalled();
    expect(flow.launchMacosRelauncher).not.toHaveBeenCalled();
    expect(flow.quitApp).not.toHaveBeenCalled();
    expect(flow.onFailure).toHaveBeenCalledOnce();
  });

  it("disarms install-on-quit and does not quit after staging timeout", async () => {
    const flow = macFlow();
    flow.waitForMacosStaging.mockRejectedValueOnce(new Error("staging timeout"));

    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow(
      "staging timeout",
    );

    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.launchMacosRelauncher).not.toHaveBeenCalled();
    expect(flow.quitApp).not.toHaveBeenCalled();
  });

  it("disarms install-on-quit and does not quit after relauncher handoff failure", async () => {
    const flow = macFlow();
    flow.launchMacosRelauncher.mockRejectedValueOnce(
      new Error("relauncher exited"),
    );

    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow(
      "relauncher exited",
    );

    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.quitApp).not.toHaveBeenCalled();
  });
});
