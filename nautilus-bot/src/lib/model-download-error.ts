/**
 * One plain sentence for a failed model download.
 *
 * The sidecar's download errors are written for logs: they carry the release
 * URL, the absolute path on disk, both SHA-256 digests, or reqwest's own
 * wording ("error sending request for url (…)"), and Electron prefixes every
 * one of them with "Error invoking remote method 'sidecar:invoke': Error:".
 * Shown as they are, someone whose Wi-Fi dropped reads a GitHub URL and no
 * advice. This keeps what the reader can act on (offline, out of space and by
 * how much, a bad copy, a busy server) and drops the rest. The raw text still
 * reaches the log through the sidecar.
 */

import { containsTechnicalDetails } from "@/lib/user-facing-error";

const IPC_PREFIX = /^(?:(?:Error invoking remote method ['"][^'"]+['"]:\s*)|(?:Error:\s*))+/i;

const OFFLINE =
  /error sending request|dns error|failed to lookup address|nodename nor servname|connection refused|network is unreachable|network is down|no route to host|connection reset|connection closed before|tcp connect error|internet connection appears to be offline|error decoding response body|operation timed out|timed out reading|request or response body error/i;

const NOT_ENOUGH_SPACE = /not enough disk space\b.*?:\s*need\s+(.+?)\s+free,\s+only\s+(.+?)\s+available/i;
const RAN_OUT_OF_SPACE = /ran out of space|no space left on device|os error 28|ENOSPC/i;
// A fresh download whose bytes did not match the pin; the sidecar deletes it.
const INTEGRITY = /integrity verification failed/i;
// A model already on disk that this session hashed and found wrong. It is
// kept until a new download replaces it.
const INSTALLED_MISMATCH = /failed its integrity check/i;
const INCOMPLETE = /download of .* is incomplete|stopped before it finished/i;
const HTTP_STATUS = /\bHTTP\s+(\d{3})\b/i;
const IPC_TIMEOUT = /^Command timed out after \d+ms: download_/i;
const DUPLICATE = /^SIDECAR_DUPLICATE:/;
const BUSY = /^SIDECAR_BUSY: model download/;
const SIZE_LIMIT = /^SIDECAR_SIZE_LIMIT:/;

const URL_IN_TEXT = /\s*(?:\b(?:for|from)\s+)?\(?https?:\/\/[^\s)]+?\)?(?=[.,:;]?(?:\s|$))/gi;
const PATH_IN_TEXT = /\s*(?:\b(?:for|at)\s+)?\/(?:Users|private|var|tmp|Volumes)\/[^\s]+?(?=[.,:;]?(?:\s|$))/g;

/** Electron's wrapper removed; the sidecar's own words, unchanged. */
function rawMessage(error: unknown): string {
  const text =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.trim().replace(IPC_PREFIX, "").trim();
}

export function describeModelDownloadError(error: unknown): string {
  const message = rawMessage(error);
  if (!message) {
    return "The download did not finish. Try again.";
  }
  if (DUPLICATE.test(message)) {
    return "This model is already downloading. Wait for that download to finish.";
  }
  if (BUSY.test(message)) {
    return "Two other downloads are already running. Try again when one of them finishes.";
  }
  const space = NOT_ENOUGH_SPACE.exec(message);
  if (space) {
    return `There isn't enough free disk space. The download needs ${space[1]} free, and this Mac has ${space[2]}. Free up space, then try again.`;
  }
  if (RAN_OUT_OF_SPACE.test(message)) {
    return "The disk ran out of space during the download. Free up space, then try again.";
  }
  if (INTEGRITY.test(message)) {
    return "The downloaded file didn't match the expected copy, so Plainsong discarded it. Try again.";
  }
  if (INSTALLED_MISMATCH.test(message)) {
    return "A model file on this Mac didn't match the expected copy, so Plainsong won't use it. Download it again to replace it.";
  }
  if (INCOMPLETE.test(message) || IPC_TIMEOUT.test(message)) {
    return "The download stopped before it finished. Try again; it picks up where it left off.";
  }
  if (SIZE_LIMIT.test(message)) {
    return "The download server sent a file larger than expected, so Plainsong stopped. Try again later.";
  }
  if (/model release doesn't have this file yet/i.test(message)) {
    return "Plainsong's model release doesn't have this file yet. Try again later.";
  }
  // Only the sidecar's raw transfer errors: a sentence that already names a
  // status for the reader ("…isn't available to download yet") stays as is.
  const status = /https?:\/\/|^Download failed\b/i.test(message) ? HTTP_STATUS.exec(message) : null;
  if (status) {
    const code = Number(status[1]);
    if (code === 404 || code === 410) {
      return "The model file isn't available from the download server right now. Try again later.";
    }
    if (code === 429 || code >= 500) {
      return "The download server is busy. Try again in a few minutes.";
    }
    return "The download server refused the request. Try again later.";
  }
  if (OFFLINE.test(message)) {
    return "Plainsong couldn't reach the download server. Check your internet connection, then try again.";
  }
  // Something already written for people (a refusal, a check that failed):
  // keep it, minus any URL or path it carries.
  const withoutLocations = message.replace(URL_IN_TEXT, "").replace(PATH_IN_TEXT, "");
  const cleaned = withoutLocations.replace(/\s{2,}/g, " ").trim();
  if (!cleaned || containsTechnicalDetails(withoutLocations)) {
    return "The download did not finish. Try again.";
  }
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}
