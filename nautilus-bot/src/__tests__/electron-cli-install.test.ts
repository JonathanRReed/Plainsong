import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  CLI_LINK_PATH,
  describeCliToolStatus,
  isPlainsongCliLink,
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

  it("never replaces a symlink that is not a Plainsong CLI link", () => {
    // "It is a symlink" used to be the whole test, so a link the user had
    // pointed at their own script was deleted and replaced without a word.
    for (const target of [
      "/usr/local/bin/my-script",
      "/Users/someone/bin/plainsong",
      "/opt/homebrew/bin/plainsong-cli-wrapper",
      "",
    ]) {
      expect(
        planCliInstall({
          platform: "darwin",
          binaryPath,
          binaryExists: true,
          existing: { kind: "symlink", target },
        }),
      ).toEqual({ action: "refuse", reason: "path_occupied" });
    }
  });

  it("recognizes a Plainsong link by the binary it points at", () => {
    expect(isPlainsongCliLink("/anywhere/plainsong-cli")).toBe(true);
    expect(isPlainsongCliLink("C:\\Program Files\\Plainsong\\plainsong-cli.exe")).toBe(true);
    expect(isPlainsongCliLink("/anywhere/plainsong")).toBe(false);
    expect(isPlainsongCliLink("/anywhere/plainsong-cli-old")).toBe(false);
    expect(isPlainsongCliLink("")).toBe(false);
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
        existing: { kind: "symlink", target: "/elsewhere/plainsong-cli" },
      }),
    ).toMatchObject({ installed: false, stale: true, occupied: false });
    // A symlink to something that is not our CLI reads as occupied, which is
    // the row that says Plainsong will leave it alone.
    expect(
      describeCliToolStatus({
        binaryPath,
        binaryExists: true,
        existing: { kind: "symlink", target: "/elsewhere/someone-elses-tool" },
      }),
    ).toMatchObject({ installed: false, stale: false, occupied: true });
    expect(
      describeCliToolStatus({ binaryPath, binaryExists: false, existing: { kind: "file" } }),
    ).toMatchObject({ installed: false, stale: false, occupied: true, binaryPresent: false });
    expect(describeCliToolStatus({ binaryPath, binaryExists: true, existing: null })).toMatchObject({
      installed: false,
      manualCommand: `sudo ln -sfn '${binaryPath}' ${CLI_LINK_PATH}`,
    });
  });
});

describe("installCliTool in electron/main.ts", () => {
  const main = readFileSync(path.resolve(__dirname, "../../electron/main.ts"), "utf8");

  it("stages the symlink and renames it into place instead of unlinking first", () => {
    // unlink-then-symlink leaves no `plainsong` command at all if the second
    // step fails, and the gap between the lstat that decided and the unlink
    // that acted is a TOCTOU window. rename(2) over a symlink is atomic and
    // operates on the link, not its target.
    expect(main).toContain("const stagingPath = `${CLI_LINK_PATH}.plainsong-install-${process.pid}`");
    expect(main).toContain("symlinkSync(binaryPath, stagingPath)");
    expect(main).toContain("renameSync(stagingPath, CLI_LINK_PATH)");
    expect(main).not.toContain("unlinkSync(CLI_LINK_PATH)");
    expect(main).not.toContain("symlinkSync(binaryPath, CLI_LINK_PATH)");
  });
});
