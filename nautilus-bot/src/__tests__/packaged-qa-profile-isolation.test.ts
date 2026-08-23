import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const unsafePackagedLaunchers = [
  "capture-packaged-macos-app-matrix-insertion.mjs",
  "capture-packaged-macos-backup-restore.mjs",
  "capture-packaged-macos-dictation-hotkey.mjs",
  "capture-packaged-macos-exports.mjs",
  "capture-packaged-macos-idle-cpu.mjs",
  "capture-packaged-macos-meeting-mic.mjs",
  "capture-packaged-macos-meeting-soak.mjs",
  "capture-packaged-macos-ollama-analysis.mjs",
  "capture-packaged-macos-recovery-shortcuts.mjs",
  "capture-packaged-macos-retention.mjs",
  "capture-packaged-macos-system-audio-test.mjs",
  "capture-packaged-macos-whisper-transcription.mjs",
] as const;

describe("packaged QA profile isolation", () => {
  it("routes every packaged app or sidecar launcher through the isolated profile helper", () => {
    for (const filename of unsafePackagedLaunchers) {
      const source = fs.readFileSync(path.join(repoRoot, "scripts", filename), "utf8");
      expect(source, filename).toContain("createPackagedQaProfile");
      expect(source, filename).toContain("...qaProfile.env");
    }
  });

  it("creates a disposable profile with settings, models, and a data-free schema clone", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-qa-profile-test-"));
    const sourceProfileDir = path.join(fixtureRoot, "source", "Plainsong");
    const sourceDb = path.join(sourceProfileDir, "plainsong.db");
    fs.mkdirSync(path.join(sourceProfileDir, "models", "whisper"), { recursive: true });
    fs.writeFileSync(path.join(sourceProfileDir, "settings.json"), '{"local":true}\n');
    fs.writeFileSync(path.join(sourceProfileDir, "models", "whisper", "model.bin"), "model");

    execFileSync("sqlite3", [
      sourceDb,
      "CREATE TABLE recordings(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); " +
      "INSERT INTO recordings(value) VALUES ('private-row'); " +
      "CREATE VIRTUAL TABLE transcript_fts USING fts5(full_text); " +
      "INSERT INTO transcript_fts(full_text) VALUES ('private transcript');",
    ]);

    const { createPackagedQaProfile } = await import(
      "../../scripts/lib/packaged-qa-profile.mjs"
    );
    const qaProfile = createPackagedQaProfile({
      args: [],
      prefix: "plainsong-qa-profile-unit-",
      sourceProfileDir,
      registerCleanup: false,
    });

    try {
      expect(qaProfile.ownsProfileRoot).toBe(true);
      expect(qaProfile.env).toMatchObject({
        PLAINSONG_QA_MODE: "1",
        PLAINSONG_CONFIG_DIR: qaProfile.configRoot,
        PLAINSONG_DATA_DIR: qaProfile.dataRoot,
      });
      expect(qaProfile.appArgs).toEqual([
        `--user-data-dir=${path.join(qaProfile.profileRoot ?? "", "electron-user-data")}`,
      ]);
      expect(
        fs.readFileSync(path.join(qaProfile.configRoot, "Plainsong", "settings.json"), "utf8"),
      ).toBe('{"local":true}\n');
      expect(
        fs.readFileSync(
          path.join(qaProfile.dataRoot, "Plainsong", "models", "whisper", "model.bin"),
          "utf8",
        ),
      ).toBe("model");

      const rows = execFileSync(
        "sqlite3",
        [
        path.join(qaProfile.dataRoot, "Plainsong", "plainsong.db"),
        "SELECT COUNT(*) FROM recordings;",
        ],
        { encoding: "utf8" },
      );
      expect(rows.trim()).toBe("0");

      const ftsRows = execFileSync(
        "sqlite3",
        [
          path.join(qaProfile.dataRoot, "Plainsong", "plainsong.db"),
          "SELECT COUNT(*) FROM transcript_fts;",
        ],
        { encoding: "utf8" },
      );
      expect(ftsRows.trim()).toBe("0");
    } finally {
      qaProfile.cleanup();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }

    expect(qaProfile.profileRoot).not.toBeNull();
    expect(fs.existsSync(qaProfile.profileRoot ?? "")).toBe(false);
  });

  it("passes the disposable Electron user-data directory to every packaged app launcher", () => {
    for (const filename of [
      "capture-packaged-macos-dictation-hotkey.mjs",
      "capture-packaged-macos-idle-cpu.mjs",
      "capture-packaged-macos-recovery-shortcuts.mjs",
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, "scripts", filename), "utf8");
      expect(source, filename).toContain("spawn(appExecutablePath, qaProfile.appArgs");
    }
  });

  it("removes an owned profile when fixture preparation fails", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-qa-profile-fail-"));
    const sourceProfileDir = path.join(fixtureRoot, "source", "Plainsong");
    const modelDir = path.join(sourceProfileDir, "models");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.symlinkSync("/private/tmp", path.join(modelDir, "unsafe-link"));

    const prefix = "plainsong-qa-profile-cleanup-unit-";
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)));
    const { createPackagedQaProfile } = await import(
      "../../scripts/lib/packaged-qa-profile.mjs"
    );

    expect(() =>
      createPackagedQaProfile({
        args: [],
        prefix,
        sourceProfileDir,
        registerCleanup: false,
      }),
    ).toThrow("Refusing to clone a symlinked packaged QA fixture");

    const after = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)));
    expect(after).toEqual(before);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("rejects an explicit profile root that traverses a symlink", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-qa-profile-link-"));
    const outsideRoot = path.join(fixtureRoot, "outside");
    const linkedProfileRoot = path.join(fixtureRoot, "linked-profile");
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, linkedProfileRoot);
    const { createPackagedQaProfile } = await import(
      "../../scripts/lib/packaged-qa-profile.mjs"
    );

    try {
      expect(() =>
        createPackagedQaProfile({
          args: ["--profile-root", linkedProfileRoot],
          sourceProfileDir: path.join(fixtureRoot, "missing-source"),
          registerCleanup: false,
        }),
      ).toThrow("Refusing to use a symlinked packaged QA profile destination");
      expect(fs.existsSync(path.join(outsideRoot, "config"))).toBe(false);
      expect(fs.existsSync(path.join(outsideRoot, "data"))).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects the live Application Support directory as an explicit profile root", async () => {
    const { createPackagedQaProfile } = await import(
      "../../scripts/lib/packaged-qa-profile.mjs"
    );

    expect(() =>
      createPackagedQaProfile({
        args: [
          "--profile-root",
          path.join(os.homedir(), "Library", "Application Support"),
        ],
        sourceProfileDir: path.join(os.tmpdir(), "missing-plainsong-profile"),
        registerCleanup: false,
      }),
    ).toThrow("Refusing to run packaged QA against the live Plainsong Application Support profile");
  });

  (process.platform === "darwin" ? it : it.skip)(
    "accepts the root-owned macOS tmp alias for an explicit profile",
    async () => {
      const fixtureRoot = fs.mkdtempSync("/tmp/plainsong-qa-profile-alias-");
      const profileRoot = path.join(fixtureRoot, "profile");
      const { createPackagedQaProfile } = await import(
        "../../scripts/lib/packaged-qa-profile.mjs"
      );

      try {
        const qaProfile = createPackagedQaProfile({
          args: ["--profile-root", profileRoot],
          sourceProfileDir: path.join(fixtureRoot, "missing-source"),
          registerCleanup: false,
        });
        expect(qaProfile.profileRoot).toBe(profileRoot);
        for (const destination of [
          qaProfile.configDir,
          qaProfile.dataDir,
          qaProfile.electronUserDataDir,
        ]) {
          expect(fs.realpathSync.native(destination)).toBe(`/private${destination}`);
        }
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("falls back to a regular fixture copy when filesystem cloning is unsupported", async () => {
    const { copyPackagedQaFixtureFile } = await import(
      "../../scripts/lib/packaged-qa-profile.mjs"
    );
    const calls: Array<number | undefined> = [];
    const copyFileSync = (_source: string, _destination: string, mode?: number) => {
      calls.push(mode);
      if (calls.length === 1) {
        throw Object.assign(new Error("clone unsupported"), { code: "EXDEV" });
      }
    };

    copyPackagedQaFixtureFile("source", "destination", copyFileSync);

    expect(calls).toEqual([fs.constants.COPYFILE_FICLONE, undefined]);
  });
});
