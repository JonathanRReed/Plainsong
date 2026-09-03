/**
 * The packaged bundle ships only Chromium's English locale, and Chromium seeds
 * ICU's default locale from the resource bundle it loaded — so inside the
 * packaged app the default locale is `en-US` however the Mac is set, and any
 * bare `toLocaleString()` prints US dates to a German user. Measured on
 * 2026-09-02 against this repo's own Electron 43.4.0 with the `.lproj`
 * directories removed from both places electron-builder sweeps; the numbers are
 * in `electron/app-locale.ts` and `artifacts/qa/shell-size-receipt-2026-09-02.md`.
 *
 * These tests hold the three pieces of the replacement together: the main
 * process supplies the locale, the preload hands the same string to the
 * renderer, and no file in `src/` formats without it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_LOCALE_ARGUMENT_PREFIX,
  FALLBACK_APP_LOCALE,
  appLocaleArgument,
  readAppLocaleArgument,
  resolveAppLocale,
} from "../../electron/app-locale";
import {
  compareStrings,
  formatDate,
  formatDateTime,
  formatTime,
} from "@/lib/format-locale";

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function setAppLocale(locale: string | undefined): void {
  if (locale === undefined) {
    delete (window as { electronAPI?: unknown }).electronAPI;
    return;
  }
  (window as unknown as { electronAPI: { appLocale: string } }).electronAPI = {
    appLocale: locale,
  };
}

afterEach(() => {
  setAppLocale(undefined);
});

describe("resolveAppLocale", () => {
  it("takes the Mac's first preferred language", () => {
    expect(resolveAppLocale(["de-DE", "en-US"])).toBe("de-DE");
    expect(resolveAppLocale(["fr-FR"])).toBe("fr-FR");
    expect(resolveAppLocale(["is-IS"])).toBe("is-IS");
  });

  it("canonicalizes what the system reports", () => {
    expect(resolveAppLocale(["de_de"])).toBe("de-DE");
    expect(resolveAppLocale(["  ja-JP  "])).toBe("ja-JP");
  });

  it("skips entries it cannot use instead of throwing", () => {
    // The value ends up in an `Intl` constructor: a throw here would take the
    // window down, and every row of every list with it.
    expect(resolveAppLocale(["not a locale", "de-DE"])).toBe("de-DE");
    expect(resolveAppLocale(["", "  ", "pt-BR"])).toBe("pt-BR");
    expect(resolveAppLocale([])).toBe(FALLBACK_APP_LOCALE);
    expect(resolveAppLocale(["!!!"])).toBe(FALLBACK_APP_LOCALE);
  });
});

describe("the argument the main process passes to every renderer", () => {
  it("round-trips through argv", () => {
    const argv = ["Electron Helper", "--type=renderer", appLocaleArgument("de-DE")];
    expect(readAppLocaleArgument(argv)).toBe("de-DE");
  });

  it("falls back rather than trusting an argument it cannot parse", () => {
    expect(readAppLocaleArgument([`${APP_LOCALE_ARGUMENT_PREFIX}nonsense!`])).toBe(
      FALLBACK_APP_LOCALE,
    );
    expect(readAppLocaleArgument(["--type=renderer"])).toBe(FALLBACK_APP_LOCALE);
  });

  it("is on the main window and on both overlays", () => {
    // A dictation overlay that formats differently from the main window is the
    // failure this catches.
    const windows = source("electron/windows.ts");
    const main = source("electron/main.ts");
    expect(
      [...windows.matchAll(/additionalArguments:/g)].length,
      "both overlay windows must carry the locale",
    ).toBe(2);
    expect(main).toContain("additionalArguments: [...rendererAdditionalArguments()]");
  });

  it("is resolved in the main process from the pak-independent source", () => {
    // `app.getLocale()` is the resource-bundle locale — `en-US` in the packaged
    // app — and `app.getSystemLocale()` splices the region onto it ("en-DE").
    // `getPreferredSystemLanguages()` reads macOS' own AppleLanguages and is the
    // only one of the three that survives the locale trim.
    const windows = source("electron/windows.ts");
    expect(windows).toContain("app.getPreferredSystemLanguages()");
    expect(windows).not.toContain("app.getSystemLocale()");
    expect(windows).not.toContain("app.getLocale()");
  });
});

describe("the preload copy of the bridge", () => {
  // The preload runs sandboxed, where `require` resolves only Electron's own
  // modules, so it cannot import electron/app-locale.ts. These two literals are
  // the duplication that buys that, and this is what stops them drifting.
  const preload = source("electron/preload.ts");

  it("reads the same argument name the main process writes", () => {
    expect(preload).toContain(
      `const APP_LOCALE_ARGUMENT_PREFIX = "${APP_LOCALE_ARGUMENT_PREFIX}";`,
    );
    expect(preload).toContain(
      `const FALLBACK_APP_LOCALE = "${FALLBACK_APP_LOCALE}";`,
    );
  });

  it("exposes the locale as a value, not another IPC round trip", () => {
    expect(preload).toContain("appLocale: appLocaleFromArgv(),");
    expect(preload).not.toMatch(/appLocale:\s*\(\)/);
  });

  it("has no relative import that a sandboxed preload could not resolve", () => {
    expect(preload).not.toMatch(/^\s*import[^\n]*from\s*["']\.\.?\//m);
  });
});

describe("format-locale uses the locale the bridge supplies", () => {
  it("formats dates in the injected locale, not the ambient one", () => {
    const when = new Date(Date.UTC(2026, 2, 4, 12, 0, 0));

    setAppLocale("en-US");
    const american = formatDate(when);
    setAppLocale("de-DE");
    const german = formatDate(when);

    expect(american).not.toBe(german);
    expect(american).toContain("/");
    expect(german).toContain(".");
  });

  it("keeps the four-digit year `toLocaleDateString()` used to print", () => {
    // dateStyle: "short" would have quietly turned 3/4/2026 into 3/4/26 for
    // every existing user. This change is about WHICH locale, not how much of
    // the date shows.
    setAppLocale("en-US");
    expect(formatDate(new Date(Date.UTC(2026, 2, 4, 12, 0, 0)))).toMatch(/2026$/);
  });

  it("formats times and date-times in the injected locale", () => {
    const when = new Date(Date.UTC(2026, 2, 4, 20, 5, 6));

    setAppLocale("en-US");
    const americanTime = formatTime(when);
    const americanDateTime = formatDateTime(when);
    setAppLocale("de-DE");

    expect(americanTime).not.toBe(formatTime(when));
    expect(americanDateTime).not.toBe(formatDateTime(when));
    expect(americanDateTime).toContain(americanTime);
  });

  it("sorts in the injected locale", () => {
    // Swedish sorts ö after z; German sorts it with o. Same two strings, two
    // different answers — which is the whole reason the locale has to travel.
    setAppLocale("de-DE");
    expect(compareStrings("öl", "zebra")).toBeLessThan(0);
    setAppLocale("sv-SE");
    expect(compareStrings("öl", "zebra")).toBeGreaterThan(0);
  });

  it("falls back to en-US when the bridge is absent", () => {
    // A dev server in a plain browser tab, or a test that never set it.
    setAppLocale(undefined);
    expect(formatDate(new Date(Date.UTC(2026, 2, 4, 12, 0, 0)))).toBe(
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).format(new Date(Date.UTC(2026, 2, 4, 12, 0, 0))),
    );
  });

  it("renders an unusable timestamp as nothing rather than 'Invalid Date'", () => {
    setAppLocale("en-US");
    expect(formatDateTime("not a date")).toBe("");
    expect(formatDate(Number.NaN)).toBe("");
  });
});

describe("nothing in src/ formats without a locale", () => {
  const allowed = new Set([
    "src/lib/format-locale.ts",
    "src/__tests__/renderer-locale-bridge.test.ts",
  ]);

  function sourceFiles(): string[] {
    const found: string[] = [];
    const directories = [path.join(repoRoot, "src")];
    while (directories.length > 0) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(entryPath);
        else if (/\.tsx?$/.test(entry.name)) found.push(entryPath);
      }
    }
    return found;
  }

  it("has no bare toLocale*() call outside the helper", () => {
    // Bare = no locale argument, so it follows ICU's default, which inside the
    // packaged app is en-US for everybody.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const relative = path.relative(repoRoot, file);
      if (allowed.has(relative)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(
        /\.toLocale[A-Za-z]*\(\s*\)/g,
      )) {
        offenders.push(`${relative}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      "use src/lib/format-locale.ts, or pass an explicit locale",
    ).toEqual([]);
  });

  it("has no localeCompare() outside the helper", () => {
    // localeCompare's first argument is the string being compared, so a call
    // that looks argument-ful is still locale-less. compareStrings() is the
    // only spelling that carries one.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const relative = path.relative(repoRoot, file);
      if (allowed.has(relative)) continue;
      if (readFileSync(file, "utf8").includes(".localeCompare(")) {
        offenders.push(relative);
      }
    }
    expect(offenders, "use compareStrings() from src/lib/format-locale.ts").toEqual(
      [],
    );
  });

  it("still finds the call sites it is guarding", () => {
    // A scan that matches nothing passes for the wrong reason. The helper's own
    // file is where every one of these now lives.
    const helper = source("src/lib/format-locale.ts");
    expect(helper).toContain("Intl.DateTimeFormat");
    expect(helper).toContain("Intl.Collator");
    expect(sourceFiles().length).toBeGreaterThan(100);
  });
});
