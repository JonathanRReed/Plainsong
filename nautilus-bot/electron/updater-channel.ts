// Maps the app's update channel to the channel name electron-updater should
// request. Kept as a standalone module so unit tests and the packaged-build
// verification script can assert against the exact rule the shipped app uses.

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
