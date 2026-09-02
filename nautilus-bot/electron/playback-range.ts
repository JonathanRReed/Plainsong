/**
 * HTTP Range handling for `plainsong://playback/<token>`.
 *
 * `<audio>` seeks by issuing Range requests, so a handler that only ever
 * answers 200 with the whole file makes the scrubber wait for the download
 * to reach the target. This module turns a Range header into a byte window
 * and builds the 200 / 206 / 416 response around a stream the caller opens
 * for exactly that window. It never touches the filesystem itself, which is
 * what keeps it unit-testable and keeps path handling in one place (main.ts).
 */

export type RangeParse =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * Parse a single-range `bytes=` header against a file of `size` bytes.
 *
 * - No header, a malformed header, or a multi-range header: `full` (200 with
 *   everything; Chromium never sends multi-range for media).
 * - `bytes=a-b`, `bytes=a-`, `bytes=-n`: the inclusive window, clamped to the
 *   file. A window that starts past the end is `unsatisfiable` (416).
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeParse {
  if (!header || !Number.isFinite(size) || size < 0) {
    return { kind: "full" };
  }
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) {
    return { kind: "full" };
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return { kind: "full" };
  }
  if (size === 0) {
    return { kind: "unsatisfiable" };
  }

  if (rawStart === "") {
    // Suffix range: the last n bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    const start = Math.max(0, size - suffix);
    return { kind: "range", start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) {
    return { kind: "unsatisfiable" };
  }
  let end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) {
    return { kind: "unsatisfiable" };
  }
  end = Math.min(end, size - 1);
  return { kind: "range", start, end };
}

export interface PlaybackResponseOptions {
  method: string;
  rangeHeader: string | null | undefined;
  size: number;
  contentType: string;
  /** Open a byte stream for the inclusive window; called at most once. */
  openStream: (start: number, end: number) => ReadableStream<Uint8Array>;
}

/**
 * Headers every playback response carries. `no-store` matters most for a
 * decrypted recording: the bytes exist on disk only for the life of the token
 * and must not be copied into a browser cache that outlives it.
 */
const PLAYBACK_COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function buildPlaybackResponse(options: PlaybackResponseOptions): Response {
  const { method, rangeHeader, size, contentType, openStream } = options;
  const isHead = method.toUpperCase() === "HEAD";
  const parsed = parseRangeHeader(rangeHeader, size);

  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        ...PLAYBACK_COMMON_HEADERS,
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  const start = parsed.kind === "range" ? parsed.start : 0;
  const end = parsed.kind === "range" ? parsed.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  const headers: Record<string, string> = {
    ...PLAYBACK_COMMON_HEADERS,
    "Content-Type": contentType,
    "Content-Length": String(length),
  };
  if (parsed.kind === "range") {
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  const body = isHead || length === 0 ? null : openStream(start, end);
  return new Response(body, {
    status: parsed.kind === "range" ? 206 : 200,
    headers,
  });
}
