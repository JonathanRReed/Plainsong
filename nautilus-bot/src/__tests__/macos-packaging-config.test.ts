import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeBundleBuildVersion } from "../../scripts/lib/bundle-build-version.mjs";

const repoRoot = process.cwd();

function builderConfig(): string {
  return readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
}

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function packageManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

function packageVersion(): string {
  return packageManifest().version;
}

/** The `electronLanguages:` list, in order. */
function electronLanguages(): string[] {
  const config = builderConfig();
  const block = /^electronLanguages:\n((?:\s+- \S+\n)+)/m.exec(config);
  expect(block, "electron-builder.yml no longer pins electronLanguages").not.toBe(
    null,
  );
  return [...block![1].matchAll(/^\s+- (\S+)$/gm)].map(([, value]) => value);
}

describe("encodeBundleBuildVersion", () => {
  it("produces a purely numeric CFBundleVersion", () => {
    // electron-builder defaults buildVersion to `version`, so a prerelease
    // shipped CFBundleVersion="0.9.0-beta.2" — which Apple defines as one to
    // three period-separated integers, not a string with a word in it.
    expect(String(encodeBundleBuildVersion("0.9.0-beta.2"))).toMatch(/^\d+$/);
    expect(String(encodeBundleBuildVersion("1.2.3"))).toMatch(/^\d+$/);
  });

  it("ranks a prerelease below the release it precedes", () => {
    // The property every downstream comparison depends on.
    const order = [
      "0.9.0-beta.2",
      "0.9.0-beta.3",
      "0.9.0",
      "0.9.1-beta.1",
      "0.9.1",
      "1.0.0-alpha.1",
      "1.0.0-beta.1",
      "1.0.0-rc.1",
      "1.0.0",
    ].map(encodeBundleBuildVersion);

    for (let index = 1; index < order.length; index += 1) {
      expect(order[index]).toBeGreaterThan(order[index - 1]);
    }
  });

  it("orders alpha below beta below rc within one version", () => {
    expect(encodeBundleBuildVersion("1.0.0-alpha.9")).toBeLessThan(
      encodeBundleBuildVersion("1.0.0-beta.1"),
    );
    expect(encodeBundleBuildVersion("1.0.0-beta.9")).toBeLessThan(
      encodeBundleBuildVersion("1.0.0-rc.1"),
    );
  });

  it("refuses a version it cannot order rather than guessing", () => {
    // A silently wrong build number is worse than a build that does not start.
    expect(() => encodeBundleBuildVersion("0.9")).toThrow(/semantic version/);
    expect(() => encodeBundleBuildVersion("0.9.0-nightly.1")).toThrow(
      /Unrankable prerelease tag/,
    );
    expect(() => encodeBundleBuildVersion("0.9.0-beta.500")).toThrow(
      /Prerelease sequence/,
    );
    expect(() => encodeBundleBuildVersion("0.100.0")).toThrow(/below 100/);
  });
});

describe("electron-builder macOS packaging", () => {
  it("pins buildVersion to the encoding of package.json's version", () => {
    // electron-builder.yml is static YAML, so the number is applied by hand. A
    // version bump that forgets it fails here rather than in a shipped bundle.
    const expected = encodeBundleBuildVersion(packageVersion());
    expect(builderConfig()).toContain(`buildVersion: "${expected}"`);
  });

  it("gives the DMG an explicit install layout", () => {
    // Without one, electron-builder opens a default-sized window with both
    // items wherever the Finder puts them — on the one screen every user sees
    // before the app has run once.
    const config = builderConfig();
    const dmg = config.slice(config.indexOf("\ndmg:"), config.indexOf("\npublish:"));

    expect(dmg).toMatch(/window:\s*\n\s+width: \d+\s*\n\s+height: \d+/);
    expect(dmg).toContain("contents:");
    expect(dmg).toContain("type: file");
    expect(dmg).toContain("type: link");
    expect(dmg).toContain("path: /Applications");
    // Both items on one baseline, app left of /Applications.
    const xs = [...dmg.matchAll(/^\s+- x: (\d+)\n\s+y: (\d+)/gm)].map(
      ([, x, y]) => ({ x: Number(x), y: Number(y) }),
    );
    expect(xs).toHaveLength(2);
    expect(xs[0].y).toBe(xs[1].y);
    expect(xs[0].x).toBeLessThan(xs[1].x);
  });

  it("keeps the DMG signed and out of the update manifest", () => {
    const config = builderConfig();
    const dmg = config.slice(config.indexOf("\ndmg:"), config.indexOf("\npublish:"));

    expect(dmg).toContain("sign: true");
    expect(dmg).toContain("writeUpdateInfo: false");
  });
});

describe("what the packaged bundle is allowed to contain", () => {
  it("ships Chromium's English locale and nothing else", () => {
    // 46 MB of the installed application was Chromium UI strings for 54
    // languages Plainsong itself has never been translated into. The list is
    // pinned rather than merely non-empty: adding a language here is a claim
    // that something in the product is written in it.
    expect(electronLanguages()).toEqual(["en", "en-US"]);
  });

  it("has nothing in the renderer that would need another Chromium locale", () => {
    // The premise of the line above. If an i18n runtime ever arrives, this
    // fails and whoever added it has to decide which locales ship.
    const manifest = packageManifest();
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    const localizationRuntimes = declared.filter((name) =>
      /^(i18next|react-i18next|react-intl|@formatjs\/|@lingui\/|vue-i18n|polyglot|intl-messageformat)/.test(
        name,
      ),
    );
    expect(localizationRuntimes).toEqual([]);
  });
});

describe("scripts/build-dmg.mjs", () => {
  it("says at runtime that its output must not be distributed", () => {
    // The comment at the top of the file existed and the beta.2 DMG still went
    // out unnotarized. Whoever runs the script reads its OUTPUT.
    //
    // PLAINSONG_RELEASE_DIR points at an empty directory so the script exits
    // on the missing app right after the banner: on a machine whose real
    // release/ holds a built app, this test must never start (or overwrite)
    // an actual DMG build.
    const emptyReleaseDir = mkdtempSync(path.join(os.tmpdir(), "plainsong-banner-test-"));
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/build-dmg.mjs")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PLAINSONG_RELEASE_DIR: emptyReleaseDir },
      },
    );

    // The app cannot exist in the empty override dir, so the script exits on
    // that — after printing the banner, which is the point.
    const stderr = result.stderr ?? "";
    expect(stderr).toContain("NOT A RELEASE ARTIFACT");
    expect(stderr).toContain("DO NOT DISTRIBUTE");
    expect(stderr).toContain("does NOT notarize");
    expect(stderr).toContain("bun run release:mac");
  });

  it("prints the warning before it can fail on a missing app", () => {
    const source = readFileSync(path.join(repoRoot, "scripts/build-dmg.mjs"), "utf8");
    expect(source.indexOf("warnNotForRelease();")).toBeLessThan(
      source.indexOf("Signed app not found"),
    );
    // And again at the end, next to the path someone is about to copy.
    expect(source).toContain("warnNotForRelease(`  Built: ${dmgPath}`)");
    expect(source).toContain("releaseArtifact: false");
  });
});
