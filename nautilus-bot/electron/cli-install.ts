/**
 * Installing the `plainsong` command: a symlink from `/usr/local/bin` to the
 * packaged binary, the way VS Code's "Install 'code' command" and
 * Superwhisper's CLI install work.
 *
 * The decision is pure so it is testable; main.ts does the filesystem work.
 * The one thing this never does is escalate: `/usr/local/bin` is root-owned
 * on a stock macOS, and an admin-password prompt with Plainsong's name on it
 * is a worse trade than one line the user pastes into a terminal. When the
 * link cannot be written the app shows that line and a Copy button instead.
 */

export const CLI_LINK_PATH = "/usr/local/bin/plainsong";

export type ExistingLinkPath =
  | null
  | { kind: "symlink"; target: string }
  | { kind: "file" }
  | { kind: "directory" };

export type CliInstallPlan =
  | { action: "link" }
  | { action: "replace_link"; previousTarget: string }
  | { action: "already_installed" }
  | { action: "refuse"; reason: "unsupported_platform" | "binary_missing" | "path_occupied" };

export function planCliInstall(input: {
  platform: NodeJS.Platform;
  binaryPath: string;
  binaryExists: boolean;
  existing: ExistingLinkPath;
}): CliInstallPlan {
  if (input.platform !== "darwin" && input.platform !== "linux") {
    return { action: "refuse", reason: "unsupported_platform" };
  }
  if (!input.binaryExists) {
    return { action: "refuse", reason: "binary_missing" };
  }
  if (input.existing === null) {
    return { action: "link" };
  }
  if (input.existing.kind === "symlink") {
    if (input.existing.target === input.binaryPath) {
      return { action: "already_installed" };
    }
    // A link we (or a previous version) made, now pointing at an old bundle.
    return { action: "replace_link", previousTarget: input.existing.target };
  }
  // A real file or directory is somebody else's; never delete it.
  return { action: "refuse", reason: "path_occupied" };
}

/** POSIX single-quote shell escaping. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command a user can paste when the app cannot write the link itself. */
export function manualInstallCommand(binaryPath: string): string {
  return `sudo ln -sfn ${shellQuote(binaryPath)} ${CLI_LINK_PATH}`;
}

export type CliToolStatus = {
  /** Where the packaged `plainsong-cli` binary lives (or should). */
  binaryPath: string;
  binaryPresent: boolean;
  linkPath: string;
  /** `/usr/local/bin/plainsong` resolves to this build's binary. */
  installed: boolean;
  /** The link exists but points somewhere else (an older install). */
  stale: boolean;
  /** The link path is a real file or directory we will not touch. */
  occupied: boolean;
  manualCommand: string;
};

export function describeCliToolStatus(input: {
  binaryPath: string;
  binaryExists: boolean;
  existing: ExistingLinkPath;
}): CliToolStatus {
  const installed =
    input.existing?.kind === "symlink" && input.existing.target === input.binaryPath;
  return {
    binaryPath: input.binaryPath,
    binaryPresent: input.binaryExists,
    linkPath: CLI_LINK_PATH,
    installed,
    stale: input.existing?.kind === "symlink" && !installed,
    occupied: input.existing !== null && input.existing.kind !== "symlink",
    manualCommand: manualInstallCommand(input.binaryPath),
  };
}

export type CliInstallResult =
  | { status: "installed"; linkPath: string }
  | { status: "manual"; reason: string; command: string }
  | { status: "unavailable"; reason: string };
