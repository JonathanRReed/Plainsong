import type { Session, WebRequest } from "electron";

/** Check the spelling before URL normalizes alternate IPv4 forms to 127.0.0.1. */
export function parseQaUpdateFeedUrl(raw: string | undefined): string | null {
  if (!raw || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw) ||
      /[\\\s]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Call once at main-process launch. Never read settings or renderer input. */
export function resolveQaUpdateFeedUrl(
  raw: string | undefined,
  warn: (message: string) => void,
): string | null {
  const url = parseQaUpdateFeedUrl(raw);
  if (raw !== undefined && url === null) {
    // Do not print the input, which could contain credentials.
    warn("[updater] ignoring invalid PLAINSONG_QA_UPDATE_FEED_URL; expected an http(s) loopback URL without userinfo");
  }
  return url;
}

/** electron-updater uses this session for manifests, ZIPs and blockmaps. */
export async function restrictQaUpdateSession(
  netSession: Pick<Session, "setProxy"> & {
    webRequest: {
      onBeforeRequest(listener: Parameters<WebRequest["onBeforeRequest"]>[0]): void;
      onHeadersReceived(listener: Parameters<WebRequest["onHeadersReceived"]>[0]): void;
    };
  },
): Promise<void> {
  // App-local policy only. Do not use the machine's proxy for a local QA feed.
  await netSession.setProxy({ mode: "direct" });
  netSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: parseQaUpdateFeedUrl(details.url) === null });
  });
  // ElectronHttpExecutor follows redirects by creating another request. Stop
  // all redirects before that step, including normalized alternate IP forms.
  netSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ cancel: details.statusCode >= 300 && details.statusCode < 400 });
  });
}
