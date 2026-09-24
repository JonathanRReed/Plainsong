// Settings shows caught errors in a banner. Backend errors are written for the
// reader ("That password does not unlock the vault"), but a renderer bug
// surfaces as engine text like "Cannot read properties of null (reading
// 'token')", which tells the reader nothing they can act on. Those, and
// anything that is not an Error at all, become the caller's plain fallback;
// the original goes to the console so the detail is not lost.

const RUNTIME_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError];

const RUNTIME_ERROR_TEXT =
  /cannot read propert|cannot set propert|is not a function|is not defined|is not iterable|is not an object|undefined is not|null is not|unexpected token|maximum call stack/i;

export function settingsErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  const isRuntimeFailure =
    RUNTIME_ERROR_TYPES.some((type) => error instanceof type) ||
    RUNTIME_ERROR_TEXT.test(message);
  if (message && !isRuntimeFailure) {
    return message;
  }
  console.error(`[settings] ${fallback}:`, error);
  return fallback;
}
