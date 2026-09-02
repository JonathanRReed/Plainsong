import path from "path";
import { PLAYBACK_TOKEN_PATTERN } from "./playback-tokens";

export const RENDERER_SCHEME = "plainsong";
export const RENDERER_HOST = "bundle";

/**
 * Host of the in-app audio playback route, `plainsong://playback/<token>`.
 *
 * Deliberately not `bundle`: playback is not an asset of the renderer but a
 * token-gated stream the main process resolves per request. Its own origin
 * means `media-src` has to name it explicitly (below), and nothing under the
 * bundle host can ever be mistaken for a playback route.
 */
const PLAYBACK_HOST = "playback";

/**
 * The renderer's Content-Security-Policy, exactly as index.html carries it.
 *
 * Kept here so the meta tag and the response header cannot drift: the test
 * beside this module reads index.html and asserts the two agree.
 *
 * `media-src` names `plainsong://playback` on purpose: the in-app player
 * streams from that origin, which is not `'self'` for a document served from
 * `plainsong://bundle` (nor for the dev server). Nothing else may be a media
 * source.
 */
export const RENDERER_CSP_META_DIRECTIVES =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "media-src 'self' plainsong://playback data: blob:; object-src 'none'; base-uri 'self'; " +
  "frame-src 'none'; form-action 'self'";

/**
 * The policy served as a header, which is the same set plus `frame-ancestors`.
 *
 * `frame-ancestors` is ignored in a `<meta>` tag — it only has effect delivered
 * as a header — which is exactly why the CSP could not live in index.html
 * alone. `frame-src 'none'` stops this page embedding others; `frame-ancestors
 * 'none'` stops anything embedding this page.
 */
export const RENDERER_CSP_HEADER = `${RENDERER_CSP_META_DIRECTIVES}; frame-ancestors 'none'`;

/**
 * Security headers attached to every `plainsong://bundle` response.
 *
 * The CSP previously existed only as an index.html meta tag, and the protocol
 * handler returned `net.fetch` responses verbatim. A meta tag is parsed by the
 * document that carries it, so it covers index.html and nothing else: any other
 * asset the handler served — and any document reached without that head being
 * parsed — ran with no policy at all. The header is the authoritative copy and
 * the meta tag stays as a redundant second layer.
 *
 * `nosniff` matters because assets are served from a file read whose
 * `Content-Type` comes from `net.fetch`'s guess; `no-referrer` keeps the
 * bundle's internal paths out of any request the page manages to make.
 */
export const RENDERER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": RENDERER_CSP_HEADER,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// A body on any of these is a TypeError in the Response constructor.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Re-emit `response` with {@link RENDERER_SECURITY_HEADERS} applied.
 *
 * The body is passed through unread, so a large asset still streams. Existing
 * headers are preserved except where a security header replaces one, which is
 * deliberate: the upstream must not be able to weaken the policy.
 */
export function withRendererSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(RENDERER_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  const body = NULL_BODY_STATUSES.has(response.status) ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function rendererUrl(query?: Record<string, string>): string {
  const url = new URL(`${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${RENDERER_SCHEME}:` && url.host === RENDERER_HOST;
  } catch {
    return false;
  }
}

export function resolveRendererAssetPath(rendererRoot: string, rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!isRendererUrl(rawUrl)) {
    throw new Error("Renderer URL must use the packaged renderer origin");
  }

  const relativeAssetPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relativeAssetPath || relativeAssetPath.includes("\0")) {
    throw new Error("Renderer asset path is invalid");
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const resolvedAsset = path.resolve(resolvedRoot, relativeAssetPath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedAsset);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Renderer asset path escapes the packaged renderer root");
  }

  return resolvedAsset;
}

export function playbackUrl(token: string): string {
  return `${RENDERER_SCHEME}://${PLAYBACK_HOST}/${token}`;
}

/**
 * The token a playback URL names, or null unless the URL is exactly
 * `plainsong://playback/<32 hex characters>`: no query, no fragment, no
 * extra path. Anything looser is refused before it reaches the token map.
 */
export function playbackTokenFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== PLAYBACK_HOST) {
    return null;
  }
  if (url.search || url.hash) {
    return null;
  }
  const token = url.pathname.replace(/^\/+/, "");
  return PLAYBACK_TOKEN_PATTERN.test(token) ? token : null;
}
