// Settings shows caught errors in a banner. Backend errors are written for the
// reader ("That password does not unlock the vault"), but a renderer bug
// surfaces as engine text like "Cannot read properties of null (reading
// 'token')", which tells the reader nothing they can act on. Those, and
// anything that is not an Error at all, become the caller's plain fallback;
// the original goes to the console so the detail is not lost.

import { containsTechnicalDetails } from "@/lib/user-facing-error";
import { stripTransportPrefix } from "@/lib/meeting-start-error";

const RUNTIME_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError];

const RUNTIME_ERROR_TEXT =
  /cannot read propert|cannot set propert|is not a function|is not defined|is not iterable|is not an object|undefined is not|null is not|unexpected token|maximum call stack/i;

export function settingsErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error
    ? error.message.trim().replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    : "";
  const isRuntimeFailure =
    RUNTIME_ERROR_TYPES.some((type) => error instanceof type) ||
    RUNTIME_ERROR_TEXT.test(message) || containsTechnicalDetails(message);
  if (message && !isRuntimeFailure) {
    return message;
  }
  console.error(`[settings] ${fallback}:`, error);
  return fallback;
}

const SETTINGS_WRITE_FAILURE = /^Failed to (?:create settings directory|create temp settings file|write temp settings file|sync temp settings file|commit settings file)(?::|$)/;

export function settingsSaveErrorMessage(error: unknown): string {
  if (error instanceof Error && SETTINGS_WRITE_FAILURE.test(stripTransportPrefix(error.message))) {
    console.error("[settings] Settings storage write failed:", error);
    return "Couldn't save your settings. Check available storage and folder access, then retry.";
  }
  return settingsErrorMessage(error, "Couldn't save your settings. Please retry.");
}
