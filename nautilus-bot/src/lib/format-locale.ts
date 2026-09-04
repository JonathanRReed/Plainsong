/**
 * Every locale-aware format and comparison in the renderer goes through here.
 *
 * The packaged bundle ships only Chromium's English locale (`electronLanguages`
 * in electron-builder.yml, 46 MB saved), and Chromium seeds ICU's default
 * locale from the resource bundle it loaded. Inside the packaged app that
 * default is `en-US` however the Mac is set, so a bare `toLocaleString()`
 * prints `3/4/2026, 9:30:00 AM` to a German user who should see
 * `4.3.2026, 09:30:00`. `icudtl.dat` is whole, so passing the locale
 * explicitly still formats correctly — which is what these helpers do.
 *
 * The locale itself comes from `app.getPreferredSystemLanguages()` in the main
 * process (macOS' own `AppleLanguages`, independent of which paks shipped),
 * over `webPreferences.additionalArguments` into the preload, and out as
 * `window.electronAPI.appLocale`. See `electron/app-locale.ts`.
 *
 * `src/__tests__/renderer-locale-bridge.test.ts` fails the build if any other
 * file under `src/` calls a bare `toLocale*()` or any `localeCompare()`.
 */

/** What we format in when the bridge is absent — a browser tab, or a test. */
const FALLBACK_APP_LOCALE = "en-US";

/**
 * Read from the bridge on each call rather than captured at module load: the
 * preload may not have run when this module is first evaluated, and the read is
 * a property lookup. The expensive part — building the `Intl` objects — is what
 * is cached below.
 */
function appLocale(): string {
  if (typeof window === "undefined") {
    return FALLBACK_APP_LOCALE;
  }
  const value = window.electronAPI?.appLocale;
  return typeof value === "string" && value.length > 0
    ? value
    : FALLBACK_APP_LOCALE;
}

/**
 * The components `toLocaleDateString()` and `toLocaleTimeString()` pick when
 * they are called with no options, spelled out. Not `dateStyle: "short"`, which
 * would silently shorten `3/4/2026` to `3/4/26` for every existing user: this
 * change is about which locale is used, not about how much of the date shows.
 */
const DATE_PARTS = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

const TIME_PARTS = {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const collators = new Map<string, Intl.Collator>();

function cached<T>(cache: Map<string, T>, locale: string, build: () => T): T {
  const existing = cache.get(locale);
  if (existing !== undefined) {
    return existing;
  }
  const created = build();
  cache.set(locale, created);
  return created;
}

/**
 * An invalid date formats as "Invalid Date" through `Intl` in some engines and
 * throws in others. Every caller here is rendering a stored timestamp, so
 * refuse rather than render a crash: an empty string reads as "no date", which
 * is what a missing timestamp means.
 */
function asDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The date alone, in the user's own locale. Replaces `toLocaleDateString()`. */
export function formatDate(value: Date | string | number): string {
  const date = asDate(value);
  if (!date) return "";
  const locale = appLocale();
  return cached(dateFormatters, locale, () =>
    new Intl.DateTimeFormat(locale, DATE_PARTS),
  ).format(date);
}

/** The time alone, in the user's own locale. Replaces `toLocaleTimeString()`. */
export function formatTime(value: Date | string | number): string {
  const date = asDate(value);
  if (!date) return "";
  const locale = appLocale();
  return cached(timeFormatters, locale, () =>
    new Intl.DateTimeFormat(locale, TIME_PARTS),
  ).format(date);
}

/** Date and time, in the user's own locale. Replaces `toLocaleString()`. */
export function formatDateTime(value: Date | string | number): string {
  const date = asDate(value);
  if (!date) return "";
  const locale = appLocale();
  return cached(dateTimeFormatters, locale, () =>
    new Intl.DateTimeFormat(locale, { ...DATE_PARTS, ...TIME_PARTS }),
  ).format(date);
}

/** A number in the user's own locale. Replaces `Number.toLocaleString()`. */
export function formatNumber(value: number): string {
  const locale = appLocale();
  return cached(
    numberFormatters,
    locale,
    () => new Intl.NumberFormat(locale),
  ).format(value);
}

/**
 * Sort order for text the user reads, in the user's own locale. Replaces
 * `localeCompare()`, which sorts by ICU's default locale — `en-US` inside the
 * packaged app — and so put Ä after Z for an Austrian and ö in the wrong half
 * of a Swedish list.
 */
export function compareStrings(left: string, right: string): number {
  const locale = appLocale();
  return cached(collators, locale, () => new Intl.Collator(locale)).compare(
    left,
    right,
  );
}
