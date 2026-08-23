// Maps the app's update channel to the channel name electron-updater should
// request. Kept as a standalone module so unit tests and the packaged-build
// verification script can assert against the exact rule the shipped app uses.

import path from "path";
import { fileURLToPath } from "url";

export type UpdateChannel = "stable" | "beta";

/**
 * electron-builder only publishes `latest-mac.yml` / `latest.yml` for
 * non-prerelease versions — there is no `stable-mac.yml`. Setting
 * `autoUpdater.channel = "stable"` would make the GitHub provider request
 * `stable-mac.yml` and fail every check with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND
 * (the 404 fallback to latest only runs when allowPrerelease is true). So the
 * stable channel maps to electron-updater's default `latest` channel. Beta
 * keeps custom-channel semantics: `beta-mac.yml`, falling back to
 * `latest-mac.yml` because allowPrerelease is enabled on that channel.
 */
export function resolveUpdaterChannel(channel: UpdateChannel): "latest" | "beta" {
  return channel === "beta" ? "beta" : "latest";
}

export function allowUpdaterDowngrade(_channel: UpdateChannel): boolean {
  return false;
}

export function updaterResultHasAvailableUpdate(result: {
  isUpdateAvailable?: boolean | null;
  updateInfo?: unknown;
} | null | undefined): boolean {
  return result?.isUpdateAvailable === true;
}

/**
 * An updater handoff quits the app. Keep that path separate from meeting
 * finalization so a failed meeting stop cannot leave a detached updater helper
 * waiting to install on some later, unrelated quit.
 */
export function updaterInstallBlockedByActiveMeeting(
  activeMeetingRecordingId: string | null | undefined,
): boolean {
  return Boolean(activeMeetingRecordingId?.trim());
}

/**
 * Squirrel.Mac stages a downloaded update only when install-on-quit is enabled.
 * Keep that disabled while checking so an update can never install without
 * consent, then enable it at the start of the explicit Install action.
 */
export function prepareUpdaterForExplicitInstall(
  updater: { autoInstallOnAppQuit: boolean },
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    updater.autoInstallOnAppQuit = true;
  }
}

export function resetUpdaterAfterExplicitInstallFailure(
  updater: { autoInstallOnAppQuit: boolean },
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    updater.autoInstallOnAppQuit = false;
  }
}

export type MacosShipItStateSnapshot = {
  targetBundleUrl: string;
  updateBundleUrl: string;
  updateBundleVersion: string;
};

function normalizedFileUrlPath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") {
      return null;
    }
    return path.resolve(fileURLToPath(url));
  } catch {
    return null;
  }
}

/**
 * ShipIt state can survive an interrupted or earlier update. Do not quit the
 * app until the state names this exact installation target and the staged
 * bundle itself reports the version the user chose to install.
 */
export function macosShipItStateTargetsExpectedUpdate(
  state: MacosShipItStateSnapshot | null | undefined,
  appBundlePath: string,
  expectedVersion: string,
  shipItDirectory: string,
): state is MacosShipItStateSnapshot {
  if (!state || state.updateBundleVersion !== expectedVersion) {
    return false;
  }

  const targetBundlePath = normalizedFileUrlPath(state.targetBundleUrl);
  const updateBundlePath = normalizedFileUrlPath(state.updateBundleUrl);
  if (!targetBundlePath || !updateBundlePath) {
    return false;
  }
  const relativeUpdatePath = path.relative(
    path.resolve(shipItDirectory),
    updateBundlePath,
  );
  const relativeParts = relativeUpdatePath.split(path.sep);
  const updateIsThisShipItPayload =
    relativeParts.length === 2 &&
    /^update\.[^/\\]+$/.test(relativeParts[0]) &&
    relativeParts[1].toLowerCase().endsWith(".app") &&
    !path.isAbsolute(relativeUpdatePath) &&
    !relativeUpdatePath.startsWith(`..${path.sep}`);
  return (
    targetBundlePath === path.resolve(appBundlePath) &&
    updateIsThisShipItPayload
  );
}

export function explicitUpdaterInstallStrategy(
  platform: NodeJS.Platform = process.platform,
): "managed_macos_relaunch" | "updater_quit_and_install" {
  return platform === "darwin"
    ? "managed_macos_relaunch"
    : "updater_quit_and_install";
}

/**
 * Electron 43 can hand a verified archive to ShipIt without emitting the
 * native readiness event that electron-updater's macOS quitAndInstall path
 * waits for. The detached helper survives the normal app quit, waits until
 * ShipIt replaces the exact bundle with the expected version, opens it once,
 * and then exits. Dynamic values are positional arguments, never shell source.
 */
export function macosUpdateRelauncherArgs(
  appBundlePath: string,
  expectedVersion: string,
  readyFilePath: string,
): string[] {
  const script = [
    'target="$1";',
    'expected="$2";',
    'ready="$3";',
    '/usr/bin/touch "$ready" || exit 1;',
    "count=0;",
    'while [ "$count" -lt 120 ]; do',
    'version=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist" 2>/dev/null || true);',
    'if [ "$version" = "$expected" ]; then',
    '/usr/bin/open "$target";',
    "exit $?;",
    "fi;",
    "/bin/sleep 0.5;",
    "count=$((count + 1));",
    "done;",
    "exit 1",
  ].join(" ");

  return [
    "-c",
    script,
    "plainsong-update-relauncher",
    appBundlePath,
    expectedVersion,
    readyFilePath,
  ];
}

/**
 * The channel manifest filename electron-updater requests for a channel on the
 * given platform (mirrors Provider.getChannelFilePrefix + getChannelFilename
 * in electron-updater).
 */
export function updaterChannelManifestFilename(
  channel: UpdateChannel,
  platform: NodeJS.Platform = process.platform
): string {
  const suffix = platform === "darwin" ? "-mac" : platform === "linux" ? "-linux" : "";
  return `${resolveUpdaterChannel(channel)}${suffix}.yml`;
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(version: string): ParsedVersion | null {
  const match = version
    .trim()
    .match(
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) return null;
  const [, major, minor, patch, prerelease = ""] = match;
  const numeric = [major, minor, patch].map(Number);
  if (numeric.some((part) => !Number.isSafeInteger(part))) return null;
  const prereleaseParts = prerelease ? prerelease.split(".") : [];
  if (prereleaseParts.some((part) => !part)) return null;
  return {
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease: prereleaseParts,
  };
}

/**
 * A prerelease build must remain on the feed that can advance that prerelease,
 * even when an older settings file still contains the historical stable
 * default. Stable builds continue to respect the selected channel.
 */
export function effectiveUpdaterChannel(
  configuredChannel: UpdateChannel,
  runningVersion: string,
): UpdateChannel {
  const parsed = parseVersion(runningVersion);
  return parsed?.prerelease[0] === "beta" ? "beta" : configuredChannel;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function compareUpdaterVersions(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] > parsedRight[key] ? 1 : -1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function isMonotonicUpdateCandidate(
  runningVersion: string,
  candidateVersion: string,
): boolean {
  return compareUpdaterVersions(candidateVersion, runningVersion) === 1;
}
