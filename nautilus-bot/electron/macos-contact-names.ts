/// <reference types="node" />
import { execFile } from "child_process";
import { existsSync } from "fs";
import { cleanLocalNames } from "./local-name-hints";

/**
 * Names from Contacts for dictation spelling, behind the user's switch.
 *
 * The calendar helper reads them (`--contact-names`: given names, family
 * names and nicknames only, as one de-duplicated list) and this module hands
 * the list to the sidecar, which holds it in memory for the vocabulary step.
 * The names are never written to disk, settings, history or logs here: only
 * their count and the authorization state are ever reported.
 *
 * Only `requestAccess` can raise the macOS prompt. Everything else reads the
 * stored authorization and, if it is already granted, the names.
 */

export type ContactsAuthorization =
  | "authorized"
  | "limited"
  | "denied"
  | "restricted"
  | "not_determined"
  | "unknown"
  | "unsupported_platform"
  | "helper_unavailable";

export interface ContactNamesStatus {
  authorization: ContactsAuthorization;
  /** How many names the sidecar holds now; never the names themselves. */
  nameCount: number;
}

export type ContactsHelperExec = (
  helperPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

const READ_TIMEOUT_MS = 10_000;
/** The prompt waits on a person; matches the calendar request. */
const REQUEST_TIMEOUT_MS = 70_000;
/** Contacts change; a fresh copy at most this often while the switch is on. */
export const CONTACT_NAMES_REFRESH_MS = 30 * 60 * 1000;

const KNOWN_AUTHORIZATIONS = new Set<ContactsAuthorization>([
  "authorized",
  "limited",
  "denied",
  "restricted",
  "not_determined",
]);

function contactsCanRead(authorization: ContactsAuthorization): boolean {
  return authorization === "authorized" || authorization === "limited";
}

/**
 * The helper's last JSON line. Anything unexpected reads as `unknown` with no
 * names, the same as a missing helper.
 */
export function parseContactsHelperOutput(stdout: string): {
  authorization: ContactsAuthorization;
  names: string[];
} {
  const lines = stdout
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  if (!line) return { authorization: "unknown", names: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return { authorization: "unknown", names: [] };
  }
  if (!payload || typeof payload !== "object") {
    return { authorization: "unknown", names: [] };
  }
  const record = payload as { authorization?: unknown; names?: unknown; type?: unknown };
  const authorization = KNOWN_AUTHORIZATIONS.has(record.authorization as ContactsAuthorization)
    ? (record.authorization as ContactsAuthorization)
    : "unknown";
  const names =
    record.type === "contact_names" && contactsCanRead(authorization) && Array.isArray(record.names)
      ? cleanLocalNames(record.names)
      : [];
  return { authorization, names };
}

const defaultExec: ContactsHelperExec = (helperPath, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      helperPath,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      // stdout is the contract, as for the calendar modes: typed refusals
      // exit non-zero and still print a payload.
      (_error, stdout) => resolve({ stdout: String(stdout ?? "") }),
    );
  });

export interface ContactNamesSync {
  /** The stored authorization and the count held. Never prompts. */
  status(): Promise<ContactNamesStatus>;
  /** THE ONLY PROMPTING PATH. Reached from one gesture-gated command. */
  requestAccess(): Promise<ContactNamesStatus>;
  /**
   * Send the sidecar the current names, or an empty list when the switch is
   * off or macOS says no. `force` resends even an unchanged empty list, for a
   * restarted sidecar.
   */
  sync(options?: { force?: boolean }): Promise<void>;
}

export function createContactNamesSync(input: {
  platform: NodeJS.Platform;
  helperPath: string;
  isEnabled: () => boolean;
  sendNames: (names: string[]) => Promise<void>;
  exec?: ContactsHelperExec;
  helperExists?: (helperPath: string) => boolean;
  now?: () => number;
}): ContactNamesSync {
  const exec = input.exec ?? defaultExec;
  const helperExists = input.helperExists ?? existsSync;
  const now = input.now ?? Date.now;

  let heldCount = 0;
  let lastReadAt: number | null = null;
  // One sync at a time, so a quick off-on-off ends in the last state.
  let queue: Promise<void> = Promise.resolve();

  const unavailable = (): ContactsAuthorization | null => {
    if (input.platform !== "darwin") return "unsupported_platform";
    if (!input.helperPath || !helperExists(input.helperPath)) return "helper_unavailable";
    return null;
  };

  const send = async (names: string[]): Promise<void> => {
    await input.sendNames(names);
    heldCount = names.length;
  };

  const runSync = async (force: boolean): Promise<void> => {
    if (!input.isEnabled() || unavailable()) {
      lastReadAt = null;
      if (heldCount > 0 || force) await send([]);
      return;
    }
    if (!force && lastReadAt !== null && now() - lastReadAt < CONTACT_NAMES_REFRESH_MS) {
      return;
    }
    const { names } = parseContactsHelperOutput(
      (await exec(input.helperPath, ["--contact-names"], READ_TIMEOUT_MS)).stdout,
    );
    // The switch may have gone off while the helper ran.
    if (!input.isEnabled()) {
      lastReadAt = null;
      await send([]);
      return;
    }
    lastReadAt = now();
    await send(names);
  };

  const sync = (options?: { force?: boolean }): Promise<void> => {
    const next = queue.then(() => runSync(options?.force === true));
    queue = next.catch(() => undefined);
    return next;
  };

  const probe = async (args: string[], timeoutMs: number): Promise<ContactsAuthorization> => {
    const missing = unavailable();
    if (missing) return missing;
    return parseContactsHelperOutput((await exec(input.helperPath, args, timeoutMs)).stdout)
      .authorization;
  };

  const clear = async (): Promise<void> => {
    const next = queue.then(async () => { lastReadAt = null; await send([]); });
    queue = next.catch(() => undefined);
    await next;
  };
  return {
    status: async () => {
      let authorization: ContactsAuthorization = "unknown";
      const next = queue.then(async () => {
        authorization = await probe(["--contacts-probe"], READ_TIMEOUT_MS);
        if (!contactsCanRead(authorization) && heldCount > 0) {
          lastReadAt = null;
          await send([]);
        }
      });
      queue = next.catch(() => undefined);
      await next;
      return { authorization, nameCount: heldCount };
    },
    requestAccess: async () => {
      const authorization = await probe(["--contacts-request-access"], REQUEST_TIMEOUT_MS);
      if (contactsCanRead(authorization)) {
        lastReadAt = null;
        await sync({ force: true }).catch(() => undefined);
      }
      if (!contactsCanRead(authorization) && heldCount > 0) await clear();
      return { authorization, nameCount: heldCount };
    },
    sync,
  };
}
