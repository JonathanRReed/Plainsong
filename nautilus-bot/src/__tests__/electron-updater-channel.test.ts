import { describe, expect, it } from "vitest";
import {
  allowUpdaterDowngrade,
  compareUpdaterVersions,
  effectiveUpdaterChannel,
  explicitUpdaterInstallStrategy,
  isMonotonicUpdateCandidate,
  macosShipItStateTargetsExpectedUpdate,
  macosUpdateRelauncherArgs,
  updaterInstallBlockedByActiveMeeting,
  prepareUpdaterForExplicitInstall,
  resetUpdaterAfterExplicitInstallFailure,
  resolveUpdaterChannel,
  updaterResultHasAvailableUpdate,
  updaterChannelManifestFilename,
} from "../../electron/updater-channel";

describe("resolveUpdaterChannel", () => {
  it("maps stable to electron-updater's default latest channel", () => {
    // electron-builder never publishes stable-mac.yml; a "stable" channel
    // would 404 with no fallback (allowPrerelease is false on stable).
    expect(resolveUpdaterChannel("stable")).toBe("latest");
  });

  it("keeps beta as a custom channel", () => {
    expect(resolveUpdaterChannel("beta")).toBe("beta");
  });

  it("never enables signed rollback for normal channels", () => {
    expect(allowUpdaterDowngrade("stable")).toBe(false);
    expect(allowUpdaterDowngrade("beta")).toBe(false);
  });

  it("keeps a beta build on its credential-free beta feed", () => {
    expect(effectiveUpdaterChannel("stable", "0.9.0-beta.1")).toBe("beta");
    expect(effectiveUpdaterChannel("beta", "0.9.0-beta.1")).toBe("beta");
    expect(effectiveUpdaterChannel("stable", "0.9.0")).toBe("stable");
  });
});

describe("monotonic updater policy", () => {
  it("accepts a legitimate higher beta prerelease", () => {
    expect(isMonotonicUpdateCandidate("0.9.0-beta.1", "0.9.0-beta.2")).toBe(true);
    expect(compareUpdaterVersions("0.9.0-beta.10", "0.9.0-beta.2")).toBe(1);
  });

  it("refuses older stable and prerelease candidates", () => {
    expect(isMonotonicUpdateCandidate("0.9.0-beta.2", "0.8.9")).toBe(false);
    expect(isMonotonicUpdateCandidate("0.9.0-beta.2", "0.9.0-beta.1")).toBe(false);
    expect(isMonotonicUpdateCandidate("0.9.0-beta.2", "0.9.0-beta.2")).toBe(false);
  });

  it("preserves SemVer stable and prerelease ordering", () => {
    expect(isMonotonicUpdateCandidate("0.9.0-beta.2", "0.9.0")).toBe(true);
    expect(isMonotonicUpdateCandidate("0.9.0", "0.9.1-beta.1")).toBe(true);
    expect(isMonotonicUpdateCandidate("invalid", "0.9.1")).toBe(false);
  });
});

describe("updater result availability", () => {
  it("does not validate updateInfo returned by the up-to-date path", () => {
    expect(
      updaterResultHasAvailableUpdate({
        isUpdateAvailable: false,
        updateInfo: { version: "0.9.0-beta.1" },
      }),
    ).toBe(false);
    expect(
      updaterResultHasAvailableUpdate({
        isUpdateAvailable: true,
        updateInfo: { version: "0.9.0-beta.2" },
      }),
    ).toBe(true);
  });
});

describe("explicit updater installation", () => {
  it("blocks updater handoff while a meeting still needs finalization", () => {
    expect(updaterInstallBlockedByActiveMeeting("meeting-123")).toBe(true);
    expect(updaterInstallBlockedByActiveMeeting("  ")).toBe(false);
    expect(updaterInstallBlockedByActiveMeeting(null)).toBe(false);
  });

  it("enables macOS install-on-quit only after the user chooses Install", () => {
    const updater = { autoInstallOnAppQuit: false };

    prepareUpdaterForExplicitInstall(updater, "darwin");

    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("does not change the install-on-quit policy on other platforms", () => {
    const updater = { autoInstallOnAppQuit: false };

    prepareUpdaterForExplicitInstall(updater, "win32");

    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("disarms macOS install-on-quit after an explicit install failure", () => {
    const updater = { autoInstallOnAppQuit: true };

    resetUpdaterAfterExplicitInstallFailure(updater, "darwin");

    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("does not mutate another platform's install-on-quit policy during cleanup", () => {
    const updater = { autoInstallOnAppQuit: true };

    resetUpdaterAfterExplicitInstallFailure(updater, "win32");

    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("uses the staged relaunch strategy only on macOS", () => {
    expect(explicitUpdaterInstallStrategy("darwin")).toBe("managed_macos_relaunch");
    expect(explicitUpdaterInstallStrategy("win32")).toBe("updater_quit_and_install");
  });

  it("accepts ShipIt state only for the exact app path and expected version", () => {
    const appPath = "/Users/Ada/Applications/Plainsong Limited Beta.app";
    const state = {
      targetBundleUrl:
        "file:///Users/Ada/Applications/Plainsong%20Limited%20Beta.app/",
      updateBundleUrl:
        "file:///Users/Ada/Library/Caches/com.plainsong.app.ShipIt/update.123/Plainsong.app/",
      updateBundleVersion: "0.9.0-beta.2",
    };

    expect(
      macosShipItStateTargetsExpectedUpdate(
        state,
        appPath,
        "0.9.0-beta.2",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(true);
    expect(
      macosShipItStateTargetsExpectedUpdate(
        state,
        "/Applications/Plainsong.app",
        "0.9.0-beta.2",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(false);
    expect(
      macosShipItStateTargetsExpectedUpdate(
        state,
        appPath,
        "0.9.0-beta.3",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(false);
  });

  it("rejects an expected-version bundle outside this app's ShipIt staging directory", () => {
    expect(
      macosShipItStateTargetsExpectedUpdate(
        {
          targetBundleUrl: "file:///Applications/Plainsong.app/",
          updateBundleUrl:
            "file:///Users/Ada/Library/Caches/other.app.ShipIt/update.123/Plainsong.app/",
          updateBundleVersion: "0.9.0-beta.2",
        },
        "/Applications/Plainsong.app",
        "0.9.0-beta.2",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(false);
  });

  it("rejects malformed or non-file ShipIt bundle URLs", () => {
    const appPath = "/Applications/Plainsong.app";

    expect(
      macosShipItStateTargetsExpectedUpdate(
        {
          targetBundleUrl: "https://example.com/Plainsong.app",
          updateBundleUrl: "file:///tmp/Plainsong.app",
          updateBundleVersion: "0.9.0-beta.2",
        },
        appPath,
        "0.9.0-beta.2",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(false);
    expect(
      macosShipItStateTargetsExpectedUpdate(
        {
          targetBundleUrl: "not a URL",
          updateBundleUrl: "file:///tmp/Plainsong.app",
          updateBundleVersion: "0.9.0-beta.2",
        },
        appPath,
        "0.9.0-beta.2",
        "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt",
      ),
    ).toBe(false);
  });

  it("passes the app path and expected version as shell arguments, not shell source", () => {
    const appPath = "/Applications/Plainsong Limited Beta.app";
    const expectedVersion = "0.9.0-beta.2";
    const readyPath = "/tmp/plainsong updater ready";
    const args = macosUpdateRelauncherArgs(appPath, expectedVersion, readyPath);

    expect(args[0]).toBe("-c");
    expect(args.slice(2)).toEqual([
      "plainsong-update-relauncher",
      appPath,
      expectedVersion,
      readyPath,
    ]);
    expect(args[1]).not.toContain(appPath);
    expect(args[1]).not.toContain(expectedVersion);
    expect(args[1]).not.toContain(readyPath);
    expect(args[1]).toContain('target="$1"');
    expect(args[1]).toContain('expected="$2"');
    expect(args[1]).toContain('ready="$3"');
  });
});

describe("updaterChannelManifestFilename", () => {
  it("stable on macOS requests latest-mac.yml, which electron-builder publishes", () => {
    expect(updaterChannelManifestFilename("stable", "darwin")).toBe("latest-mac.yml");
  });

  it("beta on macOS requests beta-mac.yml", () => {
    expect(updaterChannelManifestFilename("beta", "darwin")).toBe("beta-mac.yml");
  });

  it("stable on Windows requests latest.yml", () => {
    expect(updaterChannelManifestFilename("stable", "win32")).toBe("latest.yml");
  });
});
