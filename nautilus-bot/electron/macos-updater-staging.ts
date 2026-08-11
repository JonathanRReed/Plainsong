import { execFile } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  macosShipItStateTargetsExpectedUpdate,
  type MacosShipItStateSnapshot,
} from "./updater-channel";

export const MACOS_UPDATE_STAGING_TIMEOUT_MS = 30_000;
export const MACOS_UPDATE_STAGING_POLL_MS = 250;

type ExecFileText = (
  file: string,
  args: readonly string[],
) => Promise<string>;

type WaitForMacosUpdateStagingOptions = {
  appBundlePath: string;
  expectedVersion: string;
  cachePath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readBundleIdentifier?: (appBundlePath: string) => Promise<string>;
  readSnapshot?: (
    statePath: string,
  ) => Promise<MacosShipItStateSnapshot | null>;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

type AwaitMacosUpdateRelauncherReadinessOptions = {
  child: {
    exitCode: number | null;
    signalCode?: NodeJS.Signals | null;
  };
  readyFilePath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readyFileExists?: (readyFilePath: string) => boolean;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function readPlistValue(
  plistPath: string,
  key: string,
  run: ExecFileText = execFileText,
): Promise<string> {
  return run("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
}

export async function readMacosAppBundleIdentifier(
  appBundlePath: string,
): Promise<string> {
  return readPlistValue(
    path.join(appBundlePath, "Contents", "Info.plist"),
    "CFBundleIdentifier",
  );
}

function updateBundlePathFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

export async function readMacosShipItStateSnapshot(
  statePath: string,
): Promise<MacosShipItStateSnapshot | null> {
  try {
    const [targetBundleUrl, updateBundleUrl] = await Promise.all([
      readPlistValue(statePath, "targetBundleURL"),
      readPlistValue(statePath, "updateBundleURL"),
    ]);
    const updateBundlePath = updateBundlePathFromUrl(updateBundleUrl);
    if (!targetBundleUrl || !updateBundleUrl || !updateBundlePath) {
      return null;
    }
    const updateBundleVersion = await readPlistValue(
      path.join(updateBundlePath, "Contents", "Info.plist"),
      "CFBundleShortVersionString",
    );
    return {
      targetBundleUrl,
      updateBundleUrl,
      updateBundleVersion,
    };
  } catch {
    // Missing state and a bundle still being moved into place both mean
    // "not ready yet". The bounded caller reports one actionable timeout.
    return null;
  }
}

export function macosShipItStatePath(
  cachePath: string,
  bundleIdentifier: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleIdentifier)) {
    throw new Error(`Invalid macOS bundle identifier: ${bundleIdentifier}`);
  }
  return path.join(
    cachePath,
    `${bundleIdentifier}.ShipIt`,
    "ShipItState.plist",
  );
}

export async function waitForMacosUpdateStaging(
  options: WaitForMacosUpdateStagingOptions,
): Promise<MacosShipItStateSnapshot> {
  const timeoutMs = options.timeoutMs ?? MACOS_UPDATE_STAGING_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? MACOS_UPDATE_STAGING_POLL_MS;
  if (timeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error("macOS update staging timeouts must be positive");
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const readBundleIdentifier =
    options.readBundleIdentifier ?? readMacosAppBundleIdentifier;
  const readSnapshot = options.readSnapshot ?? readMacosShipItStateSnapshot;
  const bundleIdentifier = await readBundleIdentifier(options.appBundlePath);
  const statePath = macosShipItStatePath(options.cachePath, bundleIdentifier);
  const shipItDirectory = path.dirname(statePath);
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    const state = await readSnapshot(statePath);
    if (
      macosShipItStateTargetsExpectedUpdate(
        state,
        options.appBundlePath,
        options.expectedVersion,
        shipItDirectory,
      )
    ) {
      return state;
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, deadline - now()));
  }

  throw new Error(
    `ShipIt did not stage Plainsong ${options.expectedVersion} for ${options.appBundlePath} within ${timeoutMs}ms. The app was not quit.`,
  );
}

export async function awaitMacosUpdateRelauncherReadiness(
  options: AwaitMacosUpdateRelauncherReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (timeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error("macOS update relauncher timeouts must be positive");
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const readyFileExists = options.readyFileExists ?? existsSync;
  const deadline = now() + timeoutMs;

  while (now() <= deadline) {
    if (options.child.exitCode !== null || options.child.signalCode) {
      throw new Error(
        `macOS update relauncher exited before signaling readiness (code ${String(options.child.exitCode)}, signal ${String(options.child.signalCode ?? "none")}).`,
      );
    }
    if (readyFileExists(options.readyFilePath)) {
      // Catch a shell that created the marker and then failed immediately.
      await sleep(Math.min(100, Math.max(0, deadline - now())));
      if (options.child.exitCode !== null || options.child.signalCode) {
        throw new Error(
          `macOS update relauncher exited immediately after signaling readiness (code ${String(options.child.exitCode)}, signal ${String(options.child.signalCode ?? "none")}).`,
        );
      }
      return;
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, deadline - now()));
  }

  throw new Error(
    `macOS update relauncher did not signal readiness within ${timeoutMs}ms. The app was not quit.`,
  );
}
