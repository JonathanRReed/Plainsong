import { invoke } from "@/lib/electron";

/**
 * Names from Contacts for dictation spelling.
 *
 * `getContactsAccessStatus` reads the stored macOS answer and cannot prompt.
 * `requestContactsAccess` is the only call that can, and the main process
 * refuses it unless a real click in the main window preceded it. The names
 * themselves never reach the renderer: the main process reads them and hands
 * them to the sidecar, and only a count comes back.
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

export interface ContactsAccessStatus {
  authorization: ContactsAuthorization;
  nameCount: number;
}

function normalizeStatus(value: unknown): ContactsAccessStatus {
  if (!value || typeof value !== "object") {
    return { authorization: "unknown", nameCount: 0 };
  }
  const status = value as Partial<ContactsAccessStatus>;
  return {
    authorization: status.authorization ?? "unknown",
    nameCount: typeof status.nameCount === "number" ? status.nameCount : 0,
  };
}

export function contactsAccessGranted(authorization: ContactsAuthorization): boolean {
  return authorization === "authorized" || authorization === "limited";
}

export async function getContactsAccessStatus(): Promise<ContactsAccessStatus> {
  return normalizeStatus(await invoke("get_contacts_access_status"));
}

/** Ask macOS for Contacts access. Call this ONLY from a click handler. */
export async function requestContactsAccess(): Promise<ContactsAccessStatus> {
  return normalizeStatus(await invoke("request_contacts_access"));
}
