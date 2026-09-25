/**
 * Offering to install Plainsong when it was opened straight from its disk
 * image.
 *
 * A copy running from /Volumes is the one macOS attaches Microphone and
 * Accessibility grants to, and it disappears when the disk image is ejected,
 * taking those grants and the Dock icon with it. The usual Mac answer is to
 * offer the move on launch, which Electron supports natively: the move copies
 * the bundle into /Applications (replacing an older copy that is not running)
 * and relaunches from there.
 */

export interface MoveToApplicationsDeps {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** The running .app bundle, e.g. /Volumes/Plainsong/Plainsong.app. */
  bundlePath: string | null;
  isInApplicationsFolder: () => boolean;
  /** Resolves with the index of the button the reader chose. */
  ask: (options: {
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }) => Promise<number>;
  /** Electron's app.moveToApplicationsFolder: relaunches on success. */
  move: () => boolean;
  log?: (message: string, error?: unknown) => void;
}

const MOVE = 0;

export function runningFromDiskImage(deps: Pick<MoveToApplicationsDeps, "isPackaged" | "platform" | "bundlePath">): boolean {
  return (
    deps.isPackaged &&
    deps.platform === "darwin" &&
    typeof deps.bundlePath === "string" &&
    deps.bundlePath.startsWith("/Volumes/")
  );
}

/**
 * Returns true when the app is moving (and about to relaunch from
 * /Applications), so the caller stops starting up this copy.
 */
export async function offerMoveToApplications(deps: MoveToApplicationsDeps): Promise<boolean> {
  if (!runningFromDiskImage(deps) || deps.isInApplicationsFolder()) {
    return false;
  }
  const choice = await deps.ask({
    message: "Move Plainsong to your Applications folder?",
    detail:
      "You opened Plainsong from its disk image. From Applications it keeps its microphone and Accessibility permissions, and it is still there after you eject the disk image.",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: MOVE,
    cancelId: 1,
  });
  if (choice !== MOVE) {
    return false;
  }
  try {
    return deps.move();
  } catch (error) {
    // Most often a copy in /Applications that is running and cannot be
    // replaced. Keep going from the disk image rather than quitting.
    deps.log?.("[move-to-applications] could not move the app", error);
    return false;
  }
}
