import {
  explicitUpdaterInstallStrategy,
  prepareUpdaterForExplicitInstall,
  resetUpdaterAfterExplicitInstallFailure,
} from "./updater-channel";

type ExplicitInstallUpdater = {
  autoInstallOnAppQuit: boolean;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
  once: (event: "update-downloaded", listener: () => void) => unknown;
  removeListener: (event: "update-downloaded", listener: () => void) => unknown;
};

type ExplicitUpdaterInstallFlowOptions = {
  platform?: NodeJS.Platform;
  updater: ExplicitInstallUpdater;
  updateReadyToInstall: boolean;
  setDownloading: () => void;
  setInstalling: () => void;
  waitForMacosStaging?: () => Promise<unknown>;
  launchMacosRelauncher?: () => Promise<unknown>;
  quitApp?: () => void;
  onFailure: (error: unknown) => void;
};

/**
 * The user-consented install state machine. Keeping this outside Electron's
 * bootstrap module makes every failure boundary executable in unit tests.
 */
export async function runExplicitUpdaterInstallFlow(
  options: ExplicitUpdaterInstallFlowOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform;

  try {
    if (!options.updateReadyToInstall) {
      options.setDownloading();
      if (platform === "darwin") {
        // MacUpdater checks autoInstallOnAppQuit synchronously after emitting
        // update-downloaded. Arm it for only that turn so Squirrel begins
        // staging, then disarm it while staging is validated. A normal quit in
        // the download/staging window must never install the update.
        const beginStaging = () => {
          prepareUpdaterForExplicitInstall(options.updater, platform);
          queueMicrotask(() => {
            resetUpdaterAfterExplicitInstallFailure(options.updater, platform);
          });
        };
        options.updater.once("update-downloaded", beginStaging);
        try {
          await options.updater.downloadUpdate();
        } finally {
          options.updater.removeListener("update-downloaded", beginStaging);
          resetUpdaterAfterExplicitInstallFailure(options.updater, platform);
        }
      } else {
        await options.updater.downloadUpdate();
      }
    }
    options.setInstalling();

    if (explicitUpdaterInstallStrategy(platform) === "managed_macos_relaunch") {
      if (
        !options.waitForMacosStaging ||
        !options.launchMacosRelauncher ||
        !options.quitApp
      ) {
        throw new Error("macOS updater install handoff is not configured");
      }
      await options.waitForMacosStaging();
      await options.launchMacosRelauncher();
      prepareUpdaterForExplicitInstall(options.updater, platform);
      options.quitApp();
      return;
    }

    prepareUpdaterForExplicitInstall(options.updater, platform);
    options.updater.quitAndInstall();
  } catch (error) {
    resetUpdaterAfterExplicitInstallFailure(options.updater, platform);
    options.onFailure(error);
    throw error;
  }
}
