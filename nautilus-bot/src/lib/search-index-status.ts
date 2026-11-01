import { isDictationMemoryAdmissionRefusal } from "@/lib/dictation-ui-message";

/**
 * One sentence for why background indexing is not running.
 *
 * The indexer reports pauses ("Paused in Low Power Mode.") and failures in the
 * same field. A pause reads as written; a memory refusal arrives in the local
 * model loader's words ("Not enough verified memory headroom for native
 * inference working buffers…"), and any other failure is a database or task
 * error nobody can act on from Settings, so it says only that indexing will
 * try again.
 */
export function describeSearchIndexWait(lastError: string | null | undefined): string | null {
  const message = lastError?.trim();
  if (!message) {
    return null;
  }
  if (/^paused\b/i.test(message)) {
    return `Indexing ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
  }
  if (isDictationMemoryAdmissionRefusal(message) || /memory headroom/i.test(message)) {
    return "Indexing is waiting for free memory and will continue on its own.";
  }
  return "Indexing stopped on an error and will try again on its own.";
}
