import { describe, expect, it, vi } from "vitest";
import {
  offerMoveToApplications,
  runningFromDiskImage,
  type MoveToApplicationsDeps,
} from "../../electron/move-to-applications";

function deps(overrides: Partial<MoveToApplicationsDeps> = {}): MoveToApplicationsDeps {
  return {
    isPackaged: true,
    platform: "darwin",
    bundlePath: "/Volumes/Plainsong/Plainsong.app",
    isInApplicationsFolder: () => false,
    ask: vi.fn(async () => 0),
    move: vi.fn(() => true),
    ...overrides,
  };
}

describe("move to Applications", () => {
  it("only applies to a packaged Mac app on a mounted disk image", () => {
    expect(runningFromDiskImage(deps())).toBe(true);
    expect(runningFromDiskImage(deps({ bundlePath: "/Applications/Plainsong.app" }))).toBe(false);
    expect(runningFromDiskImage(deps({ isPackaged: false }))).toBe(false);
    expect(runningFromDiskImage(deps({ platform: "win32" }))).toBe(false);
    expect(runningFromDiskImage(deps({ bundlePath: null }))).toBe(false);
  });

  it("moves when the reader accepts, and says the app is relaunching", async () => {
    const d = deps();
    await expect(offerMoveToApplications(d)).resolves.toBe(true);
    expect(d.ask).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ["Move to Applications", "Not Now"], cancelId: 1 }),
    );
    expect(d.move).toHaveBeenCalledTimes(1);
  });

  it("keeps running from the disk image on Not Now", async () => {
    const d = deps({ ask: vi.fn(async () => 1) });
    await expect(offerMoveToApplications(d)).resolves.toBe(false);
    expect(d.move).not.toHaveBeenCalled();
  });

  it("never asks from /Applications or outside a disk image", async () => {
    const installed = deps({ bundlePath: "/Applications/Plainsong.app" });
    await expect(offerMoveToApplications(installed)).resolves.toBe(false);
    expect(installed.ask).not.toHaveBeenCalled();
  });

  it("keeps going when the move fails, for example over a running copy", async () => {
    const log = vi.fn();
    const d = deps({
      move: vi.fn(() => {
        throw new Error("in use");
      }),
      log,
    });
    await expect(offerMoveToApplications(d)).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
