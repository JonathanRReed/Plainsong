import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  findProfileProcessGroups,
  terminateProfileProcesses,
} from "../../scripts/lib/launch-process-cleanup.mjs";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("packaged launch process cleanup", () => {
  it("terminates a detached process group bound to one unique profile", async () => {
    const profileRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plainsong-cleanup-test-"),
    );
    const electronProfile = path.join(profileRoot, "electron-profile");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
        "--",
        `--user-data-dir=${electronProfile}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (findProfileProcessGroups(electronProfile).includes(child.pid!))
          break;
        await delay(25);
      }
      expect(findProfileProcessGroups(electronProfile)).toContain(child.pid!);
      await terminateProfileProcesses(electronProfile);
      expect(findProfileProcessGroups(electronProfile)).toEqual([]);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it("does not match a longer profile argument with the same prefix", async () => {
    const profileRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plainsong-cleanup-prefix-"),
    );
    const profile = path.join(profileRoot, "electron-profile");
    const other = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
        "--",
        `--user-data-dir=${profile}-other`,
      ],
      { detached: true, stdio: "ignore" },
    );
    other.unref();
    try {
      await delay(100);
      expect(findProfileProcessGroups(profile)).toEqual([]);
      expect(findProfileProcessGroups(`${profile}-other`)).toContain(
        other.pid!,
      );
    } finally {
      try {
        process.kill(-other.pid!, "SIGKILL");
      } catch {}
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  });
});
