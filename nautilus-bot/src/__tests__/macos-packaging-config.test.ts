import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeBundleBuildVersion } from "../../scripts/lib/bundle-build-version.mjs";

const repoRoot = process.cwd();

function builderConfig(): string {
  return readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
}

function packageVersion(): string {
  return (
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
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

describe("scripts/build-dmg.mjs", () => {
  it("says at runtime that its output must not be distributed", () => {
    // The comment at the top of the file existed and the beta.2 DMG still went
    // out unnotarized. Whoever runs the script reads its OUTPUT.
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/build-dmg.mjs")],
      { cwd: repoRoot, encoding: "utf8" },
    );

    // No built app is present in a test checkout, so it exits on that — after
    // printing the banner, which is the point.
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
