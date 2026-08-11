import { describe, expect, it, vi } from "vitest";
import {
  awaitMacosUpdateRelauncherReadiness,
  macosShipItStatePath,
  waitForMacosUpdateStaging,
} from "../../electron/macos-updater-staging";
import { EventEmitter } from "events";

describe("macOS updater staging", () => {
  it("derives the exact ShipIt state path from the app cache and bundle identifier", () => {
    expect(
      macosShipItStatePath(
        "/Users/Ada/Library/Caches",
        "com.plainsong.app",
      ),
    ).toBe(
      "/Users/Ada/Library/Caches/com.plainsong.app.ShipIt/ShipItState.plist",
    );
  });

  it("rejects a bundle identifier that could escape the cache directory", () => {
    expect(() =>
      macosShipItStatePath("/Users/Ada/Library/Caches", "../other.app"),
    ).toThrow(/bundle identifier/i);
    expect(() =>
      macosShipItStatePath("/Users/Ada/Library/Caches", "com/example/app"),
    ).toThrow(/bundle identifier/i);
  });

  it("waits through stale state until the exact update bundle is staged", async () => {
    let now = 1_000;
    const snapshots = [
      null,
      {
        targetBundleUrl: "file:///Applications/Plainsong.app/",
        updateBundleUrl:
          "file:///Users/Ada/Library/Caches/com.plainsong.app.ShipIt/update.old/Plainsong.app/",
        updateBundleVersion: "0.9.0-beta.1",
      },
      {
        targetBundleUrl: "file:///Applications/Plainsong.app/",
        updateBundleUrl:
          "file:///Users/Ada/Library/Caches/com.plainsong.app.ShipIt/update.new/Plainsong.app/",
        updateBundleVersion: "0.9.0-beta.2",
      },
    ];
    const readSnapshot = vi.fn(async () => snapshots.shift() ?? null);
    const sleep = vi.fn(async (durationMs: number) => {
      now += durationMs;
    });

    const result = await waitForMacosUpdateStaging({
      appBundlePath: "/Applications/Plainsong.app",
      expectedVersion: "0.9.0-beta.2",
      cachePath: "/Users/Ada/Library/Caches",
      timeoutMs: 5_000,
      pollIntervalMs: 250,
      readBundleIdentifier: async () => "com.plainsong.app",
      readSnapshot,
      now: () => now,
      sleep,
    });

    expect(result.updateBundleVersion).toBe("0.9.0-beta.2");
    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails safely when ShipIt never stages the expected version", async () => {
    let now = 1_000;
    const sleep = async (durationMs: number) => {
      now += durationMs;
    };

    await expect(
      waitForMacosUpdateStaging({
        appBundlePath: "/Applications/Plainsong.app",
        expectedVersion: "0.9.0-beta.2",
        cachePath: "/Users/Ada/Library/Caches",
        timeoutMs: 500,
        pollIntervalMs: 250,
        readBundleIdentifier: async () => "com.plainsong.app",
        readSnapshot: async () => null,
        now: () => now,
        sleep,
      }),
    ).rejects.toThrow(/did not stage.*0\.9\.0-beta\.2/i);
  });

  it("requires the detached relauncher to signal readiness before handoff", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
    };
    child.exitCode = null;
    let ready = false;
    let now = 1_000;
    const result = awaitMacosUpdateRelauncherReadiness({
      child,
      readyFilePath: "/tmp/plainsong-ready",
      timeoutMs: 500,
      pollIntervalMs: 25,
      readyFileExists: () => ready,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
        ready = true;
      },
    });

    await expect(result).resolves.toBeUndefined();
  });

  it("rejects an immediate relauncher exit instead of quitting the app", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
    };
    child.exitCode = null;
    let now = 1_000;
    const result = awaitMacosUpdateRelauncherReadiness({
      child,
      readyFilePath: "/tmp/plainsong-ready",
      timeoutMs: 500,
      pollIntervalMs: 25,
      readyFileExists: () => false,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
        child.exitCode = 1;
        child.emit("exit", 1, null);
      },
    });

    await expect(result).rejects.toThrow(/exited before signaling readiness/i);
  });
});
