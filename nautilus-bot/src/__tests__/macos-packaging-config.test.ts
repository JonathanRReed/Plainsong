import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * The packages `files:` still allows into app.asar, read out of the
 * "everything except these" exclusion pattern.
 */
function asarNodeModuleAllowList(): Set<string> {
  const config = builderConfig();
  const pattern = /"!node_modules\/!\(([^)]+)\)\/\*\*"/.exec(config);
  expect(
    pattern,
    "electron-builder.yml no longer excludes renderer-only packages from app.asar",
  ).not.toBe(null);
  return new Set(pattern![1].split("|"));
}

function manifestOf(packageName: string): PackageManifest | null {
  try {
    return JSON.parse(
      readFileSync(
        path.join(repoRoot, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    ) as PackageManifest;
  } catch {
    return null;
  }
}

/** Every package reachable from `roots` through `dependencies`, roots included. */
function dependencyClosure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    const manifest = manifestOf(name);
    expect(manifest, `${name} is not installed`).not.toBe(null);
    seen.add(name);
    pending.push(...Object.keys(manifest!.dependencies ?? {}));
  }
  return seen;
}

/**
 * The npm packages the main process imports, read from `electron/`. Electron's
 * own module and Node's built-ins are not npm packages and are not listed.
 */
function mainProcessPackages(): string[] {
  const electronDirectory = path.join(repoRoot, "electron");
  const sources: string[] = [];
  const directories = [electronDirectory];
  // Recursive: `electron/` is flat today, and a subdirectory added later must
  // not silently drop out of a check the packaged bundle depends on.
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".ts")) sources.push(entryPath);
    }
  }
  expect(sources.length, "no main-process sources found").toBeGreaterThan(0);

  const found = new Set<string>();
  for (const sourcePath of sources) {
    const source = readFileSync(sourcePath, "utf8");
    // Only real module specifiers: an `import`/`export ... from` clause that
    // ends a statement, or a `require(...)` call. Prose in a comment that
    // happens to contain the word "from" is not one.
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map(([, specifier]) => specifier);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) continue;
      if (specifier === "electron" || specifier.startsWith("electron/")) continue;
      if (specifier.startsWith("node:")) continue;
      // Node's built-ins are importable without the `node:` prefix too.
      if (
        [
          "child_process",
          "crypto",
          "events",
          "fs",
          "fs/promises",
          "http",
          "https",
          "net",
          "os",
          "path",
          "readline",
          "stream",
          "timers",
          "url",
          "util",
          "zlib",
        ].includes(specifier)
      ) {
        continue;
      }
      found.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return [...found].sort();
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

  it("compresses the DMG with a format every supported Mac can mount", () => {
    // LZMA is 26% smaller than electron-builder's zlib default on this
    // payload. macOS has mounted ULMO since 10.15; the pairing with
    // minimumSystemVersion is the part worth pinning, because raising the
    // compression above what the support floor can open would produce a
    // download that fails at the Finder rather than at the build.
    const config = builderConfig();
    const dmg = config.slice(config.indexOf("\ndmg:"), config.indexOf("\npublish:"));

    expect(dmg).toMatch(/^ {2}format: (ULMO|ULFO|UDZO|UDBZ)$/m);
    const format = /^ {2}format: (\w+)$/m.exec(dmg)![1];
    const floor = /minimumSystemVersion: "(\d+)\.(\d+)"/.exec(config)!;
    const [major, minor] = [Number(floor[1]), Number(floor[2])];
    const introducedIn: Record<string, [number, number]> = {
      UDZO: [10, 1],
      UDBZ: [10, 4],
      ULFO: [10, 11],
      ULMO: [10, 15],
    };
    const [needMajor, needMinor] = introducedIn[format];
    expect(
      major > needMajor || (major === needMajor && minor >= needMinor),
      `dmg.format ${format} needs macOS ${needMajor}.${needMinor}, floor is ${major}.${minor}`,
    ).toBe(true);
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

  it("keeps out of app.asar every npm package the packaged app cannot load", () => {
    // Everything the renderer imports is compiled into dist/ by Vite, so the
    // second copy under node_modules/ was 39 MB of React, Radix, Base UI and
    // Lucide that no packaged code path ever required. The exclusion is
    // written as "everything except this list", so the list has to be exactly
    // the runtime closure — too small and the app breaks, too large and the
    // dead weight comes back.
    const kept = asarNodeModuleAllowList();
    const required = dependencyClosure(mainProcessPackages());
    expect([...kept].sort()).toEqual([...required].sort());
  });

  it("names electron-updater as the only npm package the main process loads", () => {
    // The premise of the line above, read from the main-process source rather
    // than assumed: a new `import` of a real package in electron/ fails here
    // until it is added to the allow-list it now depends on.
    expect(mainProcessPackages()).toEqual(["electron-updater"]);
  });

  it("still drops the renderer's own packages, not just their leaves", () => {
    // A guard against an allow-list that has quietly grown to cover
    // everything: the packages Vite bundles must not be in app.asar.
    const kept = asarNodeModuleAllowList();
    for (const name of ["react", "react-dom", "lucide-react", "@base-ui/react"]) {
      expect(kept.has(name), `${name} should not be packed into app.asar`).toBe(
        false,
      );
    }
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
