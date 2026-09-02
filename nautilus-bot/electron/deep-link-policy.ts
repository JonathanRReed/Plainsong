/**
 * `plainsong://` deep links: what the OS may ask the app to do, decided as
 * pure functions so the policy is testable without Electron.
 *
 * Why the renderer's own scheme is reused for OS deep links rather than a
 * second scheme: `plainsong:` is already registered as a privileged standard
 * scheme and served in-process by `protocol.handle` for the `bundle` host.
 * Chromium therefore routes every `plainsong:` navigation the renderer could
 * make (a link, `window.open`, `location.assign`) to that in-app handler,
 * which answers 404 for any host that is not `bundle` — the renderer cannot
 * reach the OS-level handler through its own scheme at all. A distinct
 * scheme would have been an unknown external scheme to Chromium, which is
 * exactly the kind of navigation that gets handed to the OS. Reusing the
 * scheme keeps deep-link dispatch reachable only from outside the app, and
 * the parser refuses the `bundle` host so the two namespaces never overlap.
 *
 * The grammar is deliberately small:
 *
 *   plainsong://record           toggle dictation (same as the hotkey)
 *   plainsong://stop             stop dictation if it is running
 *   plainsong://mode?key=<id>    switch the dictation mode
 *   plainsong://meeting/start    open the meeting consent sheet (never records)
 *   plainsong://meeting/stop     stop the running meeting
 *   plainsong://open             bring the main window forward
 *
 * No text payloads, no other query parameters, no fragments, no userinfo, no
 * port. Anything else is ignored, not guessed at.
 *
 * Who can send one: anybody who can get the OS to open a URL. That includes a
 * web page, because `app.setAsDefaultProtocolClient("plainsong")` registers
 * the scheme system-wide and a link or a redirect in any browser reaches it.
 * There is no source information in an `open-url` event — macOS does not say
 * which application asked — so the app cannot tell a Raycast script from a
 * page the user happened to load, and any check that claimed to would be
 * pretending.
 *
 * What is done about it instead, since the capability is the point of the
 * feature and refusing it would remove it:
 *
 * - Say so. The Settings switch and docs/automation.md both state plainly
 *   that a web page can trigger these links.
 * - Keep the blast radius at "a gesture the user could have made themselves".
 *   No link carries text, `mode` can only select a mode that already exists,
 *   `meeting/start` opens the consent sheet and never records, and everything
 *   is behind an off-by-default switch and a rate limit.
 * - Make `record` visible. A link-started dictation shows the HUD with
 *   [`LINK_RECORDING_NOTICE`] on it, so a recording that began without a
 *   keypress is never silent. It also runs through the same guarded
 *   `start_dictation` as the hotkey, so the secure-field refusal still applies.
 */

const DEEP_LINK_SCHEME = "plainsong";
/** The renderer's own origin host; never a deep-link command. */
const RENDERER_HOST = "bundle";
const MAX_URL_LENGTH = 256;
const MODE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type DeepLinkCommand =
  | { kind: "record" }
  | { kind: "stop" }
  | { kind: "mode"; key: string }
  | { kind: "meeting_start" }
  | { kind: "meeting_stop" }
  | { kind: "open" };

export type DeepLinkRejection =
  | "too_long"
  | "not_a_url"
  | "wrong_scheme"
  | "renderer_origin"
  | "unexpected_authority"
  | "unexpected_payload"
  | "missing_mode_key"
  | "invalid_mode_key"
  | "unknown_command";

export type DeepLinkParse =
  | { ok: true; command: DeepLinkCommand }
  | { ok: false; reason: DeepLinkRejection };

/**
 * What the HUD says when a link, not a keypress, started the dictation.
 *
 * Short enough to read at a glance and gone in a second: the point is that the
 * microphone opening is attributable, not that the user reads a paragraph.
 */
export const LINK_RECORDING_NOTICE = "Recording from a link";
/** How long that notice stays on the HUD. */
export const LINK_RECORDING_NOTICE_MS = 1000;

/**
 * Should this deep link announce itself on the dictation HUD?
 *
 * Only `record`, and only when it is starting rather than stopping: a link
 * that stops a running dictation removes the microphone rather than opening
 * it, and the HUD is already on screen saying so.
 */
export function deepLinkNeedsRecordingNotice(
  command: DeepLinkCommand,
  dictationLive: boolean,
): boolean {
  return command.kind === "record" && !dictationLive;
}

/** Human-readable name for logs and the audit trail. */
export function deepLinkActionName(command: DeepLinkCommand): string {
  switch (command.kind) {
    case "record":
      return "record";
    case "stop":
      return "stop";
    case "mode":
      return "mode";
    case "meeting_start":
      return "meeting/start";
    case "meeting_stop":
      return "meeting/stop";
    case "open":
      return "open";
  }
}

export function parseDeepLink(raw: string): DeepLinkParse {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return { ok: false, reason: "wrong_scheme" };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, reason: "unexpected_authority" };
  }
  const host = url.hostname.toLowerCase();
  if (host === RENDERER_HOST) {
    return { ok: false, reason: "renderer_origin" };
  }
  if (url.hash) {
    return { ok: false, reason: "unexpected_payload" };
  }
  // Only `mode` takes a query, and only `key`.
  const params = [...url.searchParams.keys()];
  const path = url.pathname.replace(/\/+$/, "");

  if (host === "mode") {
    if (path !== "") {
      return { ok: false, reason: "unknown_command" };
    }
    if (params.some((name) => name !== "key")) {
      return { ok: false, reason: "unexpected_payload" };
    }
    const keys = url.searchParams.getAll("key");
    if (keys.length === 0) {
      return { ok: false, reason: "missing_mode_key" };
    }
    if (keys.length !== 1 || !MODE_KEY_PATTERN.test(keys[0])) {
      return { ok: false, reason: "invalid_mode_key" };
    }
    return { ok: true, command: { kind: "mode", key: keys[0] } };
  }

  if (params.length > 0) {
    return { ok: false, reason: "unexpected_payload" };
  }

  switch (host) {
    case "record":
      return path === "" ? { ok: true, command: { kind: "record" } } : { ok: false, reason: "unknown_command" };
    case "stop":
      return path === "" ? { ok: true, command: { kind: "stop" } } : { ok: false, reason: "unknown_command" };
    case "open":
      return path === "" ? { ok: true, command: { kind: "open" } } : { ok: false, reason: "unknown_command" };
    case "meeting":
      if (path === "/start") {
        return { ok: true, command: { kind: "meeting_start" } };
      }
      if (path === "/stop") {
        return { ok: true, command: { kind: "meeting_stop" } };
      }
      return { ok: false, reason: "unknown_command" };
    default:
      return { ok: false, reason: "unknown_command" };
  }
}

/**
 * The deep link an OS launch handed us on the command line, if any. macOS
 * delivers `open-url`; Windows and Linux relaunch the app with the URL as an
 * argument, which `second-instance` forwards here. Only the first argument
 * that is a `plainsong:` URL counts; flags and paths are not URLs.
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) {
      return arg;
    }
  }
  return null;
}

/**
 * A fixed-window limiter: at most `max` accepted links per `windowMs`. A
 * shell loop or a misbehaving automation cannot toggle dictation hundreds of
 * times a second; the excess is dropped and logged, never queued.
 */
export class DeepLinkRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private windowStart = 0;
  private count = 0;

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.max = options.max ?? 5;
    this.windowMs = options.windowMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  admit(): boolean {
    const at = this.now();
    // A window starts on the first admitted link, not at construction.
    if (this.count === 0 || at - this.windowStart >= this.windowMs) {
      this.windowStart = at;
      this.count = 0;
    }
    if (this.count >= this.max) {
      return false;
    }
    this.count += 1;
    return true;
  }
}

const BUILTIN_DICTATION_MODE_PRESETS = [
  "voice",
  "messages",
  "email",
  "notes",
  "meeting_follow_up",
] as const;

export type DictationModeSelection = {
  dictationModePreset: string;
  dictationSelectedCustomModeId: string | null;
};

/**
 * Turn a deep-link mode key into the settings fields that select a mode:
 * a built-in preset name selects that preset; a saved custom mode's id
 * selects `custom` with that id. Anything else is `null` (ignored), so a
 * link cannot invent a mode.
 */
export function resolveDictationModeSelection(
  key: string,
  settings: {
    dictationModePreset?: string;
    dictationSelectedCustomModeId?: string | null;
    dictationCustomModes?: ReadonlyArray<{ id?: unknown }>;
  },
): { selection: DictationModeSelection; changed: boolean } | null {
  const builtin = (BUILTIN_DICTATION_MODE_PRESETS as readonly string[]).includes(key);
  if (builtin) {
    const selection = { dictationModePreset: key, dictationSelectedCustomModeId: null };
    const changed =
      settings.dictationModePreset !== key ||
      (settings.dictationSelectedCustomModeId ?? null) !== null;
    return { selection, changed };
  }
  const custom = (settings.dictationCustomModes ?? []).find(
    (mode) => typeof mode.id === "string" && mode.id === key,
  );
  if (!custom) {
    return null;
  }
  const selection = { dictationModePreset: "custom", dictationSelectedCustomModeId: key };
  const changed =
    settings.dictationModePreset !== "custom" ||
    (settings.dictationSelectedCustomModeId ?? null) !== key;
  return { selection, changed };
}
