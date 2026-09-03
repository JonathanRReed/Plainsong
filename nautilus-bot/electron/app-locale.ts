/**
 * The locale the renderer formats dates, times and numbers in.
 *
 * Why this exists at all: `electronLanguages: [en, en-US]` in
 * electron-builder.yml deletes every non-English `.lproj` from the packaged
 * bundle, and Chromium seeds ICU's DEFAULT LOCALE from whichever
 * resource-bundle locale it managed to load. With only `en.lproj` present that
 * resolution lands on `en-US` no matter what the Mac is set to, so inside the
 * packaged app `navigator.language` is `en-US` and a bare
 * `new Date().toLocaleString()` prints `3/4/2026, 9:30:00 AM` on a German Mac
 * that should see `4.3.2026, 09:30:00`.
 *
 * Measured on 2026-09-02 with this repo's own Electron 43.4.0, after removing
 * the `.lproj` directories from BOTH places electron-builder's
 * `removeUnusedLanguagesIfNeeded` sweeps (`Contents/Resources` and the
 * framework's `Resources`) and launching with the system language set through
 * NSUserDefaults:
 *
 *   system language | before the trim              | after the trim
 *   de-DE           | 4.3.2026, 09:30:00           | 3/4/2026, 9:30:00 AM
 *   fr-FR           | 04/03/2026 09:30:00          | 3/4/2026, 9:30:00 AM
 *   ja-JP           | 2026/3/4 9:30:00             | 3/4/2026, 9:30:00 AM
 *
 * `icudtl.dat` is untouched, so passing a locale EXPLICITLY still formats
 * correctly (`toLocaleString("de-DE")` printed `4.3.2026, 09:30:00` in every
 * one of those runs). That is the whole fix: keep the 46 MB saving, and never
 * rely on the default locale again.
 *
 * The value comes from `app.getPreferredSystemLanguages()`, which reads macOS'
 * own `AppleLanguages` preference and is therefore independent of which paks
 * shipped — it returned `["de-DE"]` in the trimmed runs above while
 * `app.getLocale()` returned `"en-US"`. `app.getSystemLocale()` is NOT usable
 * here: it splices the region onto the resource-bundle language, so the same
 * runs reported `"en-DE"`.
 *
 * This module is deliberately free of any `electron` import so the resolution
 * rule can be tested without a running app.
 */

/**
 * What the renderer formats in when the system reports nothing we can parse.
 * The same locale Chromium falls back to, so this is not a behaviour change.
 */
export const FALLBACK_APP_LOCALE = "en-US";

/**
 * The renderer receives the locale as a command-line argument rather than over
 * IPC: `webPreferences.additionalArguments` puts it in the renderer's
 * `process.argv`, where the sandboxed preload can read it synchronously at
 * bootstrap. An IPC round trip would have to be awaited, and a formatter that
 * has to be awaited is a formatter that gets called before it is ready.
 */
export const APP_LOCALE_ARGUMENT_PREFIX = "--plainsong-app-locale=";

/**
 * The first tag in `preferredSystemLanguages` that is a well-formed language
 * tag, canonicalized. Malformed entries are skipped rather than trusted: the
 * value ends up in a command-line argument and in `Intl` constructors, and a
 * throw from either would take the window down.
 *
 * A tag can be well-formed and still have no ICU data (`qya-AA`); `Intl` then
 * falls back on its own, which is exactly the behaviour that shipped before.
 */
export function resolveAppLocale(
  preferredSystemLanguages: readonly string[],
): string {
  for (const candidate of preferredSystemLanguages) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed.length === 0) {
      continue;
    }
    // macOS reports BCP-47 (`de-DE`), but a POSIX-shaped `de_DE` reaching here
    // through an environment variable would otherwise throw and be discarded
    // in favour of en-US — the exact wrong answer for a German user.
    const tag = trimmed.replace(/_/g, "-");
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical) {
        return canonical;
      }
    } catch {
      // Structurally invalid tag. Try the next preference.
    }
  }
  return FALLBACK_APP_LOCALE;
}

/** The `additionalArguments` entry that carries `locale` to a renderer. */
export function appLocaleArgument(locale: string): string {
  return `${APP_LOCALE_ARGUMENT_PREFIX}${resolveAppLocale([locale])}`;
}

/**
 * The locale a renderer was started with, read back out of its `process.argv`.
 * The last occurrence wins, so a value appended by Plainsong is not shadowed by
 * anything earlier on the command line.
 */
export function readAppLocaleArgument(argv: readonly string[]): string {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (typeof argument !== "string") {
      continue;
    }
    if (!argument.startsWith(APP_LOCALE_ARGUMENT_PREFIX)) {
      continue;
    }
    return resolveAppLocale([argument.slice(APP_LOCALE_ARGUMENT_PREFIX.length)]);
  }
  return FALLBACK_APP_LOCALE;
}
