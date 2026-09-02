import { describe, expect, it } from "vitest";
import {
  CLI_LINK_PATH,
  describeCliToolStatus,
  manualInstallCommand,
  planCliInstall,
  shellQuote,
} from "../../electron/cli-install";

const binaryPath = "/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli";

describe("planCliInstall", () => {
  it("links when nothing is at the path", () => {
    expect(
      planCliInstall({ platform: "darwin", binaryPath, binaryExists: true, existing: null }),
    ).toEqual({ action: "link" });
  });

  it("is a no-op when the link already points at this binary", () => {
    expect(
      planCliInstall({
        platform: "darwin",
        binaryPath,
        binaryExists: true,
        existing: { kind: "symlink", target: binaryPath },
      }),
    ).toEqual({ action: "already_installed" });
  });

  it("replaces a stale link from an older bundle", () => {
    expect(
      planCliInstall({
        platform: "darwin",
        binaryPath,
        binaryExists: true,
        existing: { kind: "symlink", target: "/old/Plainsong.app/plainsong-cli" },
      }),
    ).toEqual({ action: "replace_link", previousTarget: "/old/Plainsong.app/plainsong-cli" });
  });

  it("never touches a real file or directory at the path", () => {
    expect(
      planCliInstall({
        platform: "darwin",
        binaryPath,
        binaryExists: true,
        existing: { kind: "file" },
      }),
    ).toEqual({ action: "refuse", reason: "path_occupied" });
    expect(
      planCliInstall({
        platform: "darwin",
        binaryPath,
        binaryExists: true,
        existing: { kind: "directory" },
      }),
    ).toEqual({ action: "refuse", reason: "path_occupied" });
  });

  it("refuses when the binary is missing or the platform has no /usr/local/bin", () => {
    expect(
      planCliInstall({ platform: "darwin", binaryPath, binaryExists: false, existing: null }),
    ).toEqual({ action: "refuse", reason: "binary_missing" });
    expect(
      planCliInstall({ platform: "win32", binaryPath, binaryExists: true, existing: null }),
    ).toEqual({ action: "refuse", reason: "unsupported_platform" });
  });
});

describe("manual command", () => {
  it("quotes the path for a shell and targets /usr/local/bin/plainsong", () => {
    expect(manualInstallCommand("/Applications/My Apps/Plainsong.app/x")).toBe(
      `sudo ln -sfn '/Applications/My Apps/Plainsong.app/x' ${CLI_LINK_PATH}`,
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("describeCliToolStatus", () => {
  it("reports installed, stale and occupied states distinctly", () => {
    expect(
      describeCliToolStatus({
        binaryPath,
        binaryExists: true,
        existing: { kind: "symlink", target: binaryPath },
      }),
    ).toMatchObject({ installed: true, stale: false, occupied: false, binaryPresent: true });
    expect(
      describeCliToolStatus({
        binaryPath,
        binaryExists: true,
        existing: { kind: "symlink", target: "/elsewhere" },
      }),
    ).toMatchObject({ installed: false, stale: true, occupied: false });
    expect(
      describeCliToolStatus({ binaryPath, binaryExists: false, existing: { kind: "file" } }),
    ).toMatchObject({ installed: false, stale: false, occupied: true, binaryPresent: false });
    expect(describeCliToolStatus({ binaryPath, binaryExists: true, existing: null })).toMatchObject({
      installed: false,
      manualCommand: `sudo ln -sfn '${binaryPath}' ${CLI_LINK_PATH}`,
    });
  });
});
