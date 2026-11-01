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

type FlowOptions = Parameters<typeof runExplicitUpdaterInstallFlow>[0];

function macFlow(overrides: Partial<FlowOptions> = {}) {
  const value = updater();
  const quitApp = vi.fn(async () => undefined);
  const prepareToQuit = vi.fn(async () => true);
  const cancelRelauncher = vi.fn();
  const waitForMacosStaging = vi.fn(async () => undefined);
  const launchMacosRelauncher = vi.fn(async () => cancelRelauncher);
  const onFailure = vi.fn();
  return {
    updater: value,
    quitApp,
    prepareToQuit,
    cancelRelauncher,
    waitForMacosStaging,
    launchMacosRelauncher,
    onFailure,
    options: {
      platform: "darwin",
      updater: value,
      updateReadyToInstall: false,
      setDownloading: vi.fn(),
      setInstalling: vi.fn(),
      waitForMacosStaging,
      launchMacosRelauncher,
      quitApp,
      prepareToQuit,
      onFailure,
      ...overrides,
    } satisfies FlowOptions,
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


describe("updater quit preparation", () => {
  it("rejects initial preparation before downloading or launching a helper", async () => {
    const flow = macFlow();
    flow.prepareToQuit.mockResolvedValue(false);
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(flow.launchMacosRelauncher).not.toHaveBeenCalled();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.onFailure).toHaveBeenCalledWith(expect.any(Error), { downloaded: false, staged: false });
  });

  it("reports preparation exceptions and leaves download untouched", async () => {
    const flow = macFlow();
    flow.prepareToQuit.mockRejectedValue(new Error("draft save failed"));
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow("draft save failed");
    expect(flow.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(flow.onFailure).toHaveBeenCalledOnce();
  });

  it("rechecks preparation after staging and preserves that failure context", async () => {
    const flow = macFlow();
    flow.prepareToQuit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.waitForMacosStaging).toHaveBeenCalledOnce();
    expect(flow.launchMacosRelauncher).not.toHaveBeenCalled();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.onFailure).toHaveBeenCalledWith(expect.any(Error), { downloaded: true, staged: true });
  });

  it("cancels its helper when the final quit rejects and permits retry", async () => {
    const flow = macFlow({ updateReadyToInstall: true });
    flow.quitApp.mockRejectedValueOnce(new Error("quit cancelled"));
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow("quit cancelled");
    expect(flow.cancelRelauncher).toHaveBeenCalledOnce();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.onFailure).toHaveBeenCalledWith(expect.any(Error), { downloaded: true, staged: true });
    await runExplicitUpdaterInstallFlow(flow.options);
    expect(flow.quitApp).toHaveBeenCalledTimes(2);
    expect(flow.cancelRelauncher).toHaveBeenCalledOnce();
  });

  it("reports both quit and helper cleanup failures and permits retry", async () => {
    const flow = macFlow({ updateReadyToInstall: true });
    const quitError = new Error("quit cancelled");
    const cleanupError = new Error("helper could not stop");
    flow.quitApp.mockRejectedValueOnce(quitError);
    flow.cancelRelauncher.mockImplementationOnce(() => { throw cleanupError; });

    const failure = await runExplicitUpdaterInstallFlow(flow.options).then(
      () => { throw new Error("Expected installation to reject"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors).toEqual([quitError, cleanupError]);
    expect(flow.onFailure).toHaveBeenCalledWith(failure, { downloaded: true, staged: true });
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.cancelRelauncher).toHaveBeenCalledOnce();

    await runExplicitUpdaterInstallFlow(flow.options);
    expect(flow.quitApp).toHaveBeenCalledTimes(2);
    expect(flow.cancelRelauncher).toHaveBeenCalledOnce();
    expect(flow.onFailure).toHaveBeenCalledOnce();
  });

  it("rejects incomplete macOS handoff configuration", async () => {
    const flow = macFlow({ launchMacosRelauncher: undefined });
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.quitApp).not.toHaveBeenCalled();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("blocks non-macOS installation when preparation refuses", async () => {
    const flow = macFlow({ platform: "win32", prepareToQuit: async () => false });
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(flow.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous install requests for the same updater", async () => {
    const flow = macFlow();
    let finishPreparation: (allowed: boolean) => void = () => { throw new Error("preparation not started"); };
    flow.prepareToQuit.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishPreparation = resolve; }));
    const first = runExplicitUpdaterInstallFlow(flow.options);
    const second = runExplicitUpdaterInstallFlow(flow.options);
    finishPreparation(true);
    await Promise.all([first, second]);
    expect(flow.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(flow.launchMacosRelauncher).toHaveBeenCalledOnce();
    expect(flow.quitApp).toHaveBeenCalledOnce();
    expect(flow.cancelRelauncher).not.toHaveBeenCalled();
  });
});
