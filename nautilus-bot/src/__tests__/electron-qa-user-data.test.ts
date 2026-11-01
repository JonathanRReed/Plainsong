import { describe, expect, it, vi } from "vitest";
import { resolveQaUserData } from "../../electron/qa-user-data";

function options() {
  return {
    env: { PLAINSONG_QA_MODE: "1" },
    argv: ["Plainsong", "--user-data-dir=/tmp/qa/electron"],
    tmpdir: "/tmp",
    realpath: vi.fn((directory: string) => directory.replace(/^\/tmp(?=\/|$)/, "/private/tmp")),
    isDirectory: vi.fn(() => true),
  };
}

describe("QA Electron user data", () => {
  it("refuses a QA-only build without its launcher before filesystem access", () => {
    const deps = options();
    expect(() => resolveQaUserData({ ...deps, required: true, env: {} }))
      .toThrow("temporary-profile launcher");
    expect(deps.realpath).not.toHaveBeenCalled();
    expect(resolveQaUserData({ ...deps, required: true })).toBe("/private/tmp/qa/electron");
  });
  it("ignores all QA profile overrides in normal mode without reading the filesystem", () => {
    const deps = options();
    for (const mode of [undefined, "0", "true"]) {
      expect(resolveQaUserData({ ...deps, env: {
        PLAINSONG_QA_MODE: mode,
        PLAINSONG_QA_ELECTRON_PROFILE: "/live/profile",
      } })).toBeNull();
    }
    expect(deps.realpath).not.toHaveBeenCalled();
    expect(deps.isDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ["--user-data-dir=/tmp/qa/electron"],
    ["--user-data-dir", "/tmp/qa/electron"],
  ])("accepts the launcher argv form %j", (...argv) => {
    expect(resolveQaUserData({ ...options(), argv })).toBe("/private/tmp/qa/electron");
  });

  it("prefers the environment profile over argv", () => {
    expect(resolveQaUserData({ ...options(), env: {
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_QA_ELECTRON_PROFILE: "/tmp/env/electron",
    } })).toBe("/private/tmp/env/electron");
  });

  it.each([[], ["--user-data-dir"], ["--user-data-dir="], ["--user-data-dir", "--other"]])(
    "fails closed for absent or malformed argv %j", (...argv) => {
      expect(() => resolveQaUserData({ ...options(), argv })).toThrow();
    },
  );

  it("rejects an empty environment override even when argv is valid", () => {
    expect(() => resolveQaUserData({ ...options(), env: {
      PLAINSONG_QA_MODE: "1", PLAINSONG_QA_ELECTRON_PROFILE: " ",
    } })).toThrow();
  });

  it.each(["/tmp", "/tmp/../live", "/tmp-other/qa", "/live/profile"])(
    "rejects a canonical path outside or equal to the temporary root: %s", (profile) => {
      const deps = options();
      expect(() => resolveQaUserData({ ...deps, argv: [], env: {
        PLAINSONG_QA_MODE: "1", PLAINSONG_QA_ELECTRON_PROFILE: profile,
      } })).toThrow();
    },
  );

  it("rejects a symlink escaping the temporary root", () => {
    expect(() => resolveQaUserData({ ...options(), realpath: (directory) =>
      directory === "/tmp" ? "/private/tmp" : "/live/profile",
    })).toThrow();
  });

  it("rejects files and missing directories", () => {
    expect(() => resolveQaUserData({ ...options(), isDirectory: () => false })).toThrow();
    expect(() => resolveQaUserData({ ...options(), realpath: () => {
      throw new Error("ENOENT");
    } })).toThrow("ENOENT");
  });
});
