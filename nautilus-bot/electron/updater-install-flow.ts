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
  prepareToQuit: () => Promise<boolean>;
  waitForMacosStaging?: () => Promise<unknown>;
  launchMacosRelauncher?: () => Promise<() => void>;
  quitApp?: () => Promise<void>;
  onFailure: (error: unknown, state: { downloaded: boolean; staged: boolean }) => void;
};

const pendingInstalls = new WeakMap<ExplicitInstallUpdater, Promise<void>>();

export function runExplicitUpdaterInstallFlow(
  options: ExplicitUpdaterInstallFlowOptions,
): Promise<void> {
  const pending = pendingInstalls.get(options.updater);
  if (pending) return pending;
  const work = executeInstall(options);
  pendingInstalls.set(options.updater, work);
  const clear = () => pendingInstalls.delete(options.updater);
  void work.then(clear, clear);
  return work;
}

async function executeInstall(options: ExplicitUpdaterInstallFlowOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  let downloaded = options.updateReadyToInstall;
  let staged = false;
  let cancelRelauncher: (() => void) | undefined;
  const prepare = async () => {
    if (!(await options.prepareToQuit())) {
      throw new Error("Save open drafts before installing the update.");
    }
  };

  try {
    await prepare();
    if (!options.updateReadyToInstall) {
      options.setDownloading();
      if (platform === "darwin") {
        // MacUpdater checks autoInstallOnAppQuit synchronously after emitting
        // update-downloaded. Arm it for only that turn so Squirrel begins
        // staging, then disarm the JavaScript updater while staging is validated.
        // Resetting this flag does not undo native Squirrel staging.
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
      downloaded = true;
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
      staged = true;
      await prepare();
      cancelRelauncher = await options.launchMacosRelauncher();
      prepareUpdaterForExplicitInstall(options.updater, platform);
      await options.quitApp();
      return;
    }

    await prepare();
    prepareUpdaterForExplicitInstall(options.updater, platform);
    options.updater.quitAndInstall();
  } catch (error) {
    resetUpdaterAfterExplicitInstallFailure(options.updater, platform);
    let failure = error;
    try {
      cancelRelauncher?.();
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], "Update installation stopped, but its relaunch helper could not be stopped.");
    }
    options.onFailure(failure, { downloaded, staged });
    throw failure;
  }
}
