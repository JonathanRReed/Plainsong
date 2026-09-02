import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRendererCommandAllowed } from "../../electron/ipc-bridge";
import { getCommandTimeoutMs } from "../../electron/ipc-command-policy";
import { buildPlaybackResponse, parseRangeHeader } from "../../electron/playback-range";
import {
  parsePreparedPlayback,
  PlaybackTokenMap,
  isPlaybackToken,
} from "../../electron/playback-tokens";
import { playbackTokenFromUrl, playbackUrl } from "../../electron/renderer-protocol";

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("playback tokens", () => {
  it("accepts only the sidecar's 32-hex shape", () => {
    expect(isPlaybackToken(TOKEN)).toBe(true);
    expect(isPlaybackToken(TOKEN.toUpperCase())).toBe(false);
    expect(isPlaybackToken(TOKEN.slice(1))).toBe(false);
    expect(isPlaybackToken(`${TOKEN}0`)).toBe(false);
    expect(isPlaybackToken("../../etc/passwd")).toBe(false);
    expect(isPlaybackToken(null)).toBe(false);
    expect(isPlaybackToken(42)).toBe(false);
  });

  it("resolves only registered tokens and forgets them on release", () => {
    const map = new PlaybackTokenMap();
    map.register(TOKEN, {
      path: "/data/runtime/decrypted-audio/a.wav",
      recordingId: "rec-1",
      protection: "decrypted",
    });
    expect(map.size).toBe(1);
    expect(map.resolve(TOKEN)).toEqual({
      path: "/data/runtime/decrypted-audio/a.wav",
      recordingId: "rec-1",
      protection: "decrypted",
    });
    expect(map.resolve(OTHER)).toBeNull();
    expect(map.resolve("not a token")).toBeNull();

    expect(map.release(TOKEN)?.recordingId).toBe("rec-1");
    expect(map.resolve(TOKEN)).toBeNull();
    expect(map.release(TOKEN)).toBeNull();
    expect(map.size).toBe(0);
  });

  it("refuses malformed and duplicate registrations", () => {
    const map = new PlaybackTokenMap();
    expect(() =>
      map.register("short", { path: "/a", recordingId: "r", protection: "plaintext" }),
    ).toThrow(/malformed/);
    map.register(TOKEN, { path: "/a", recordingId: "r", protection: "plaintext" });
    expect(() =>
      map.register(TOKEN, { path: "/b", recordingId: "r", protection: "plaintext" }),
    ).toThrow(/already registered/);
    // The first registration is untouched.
    expect(map.resolve(TOKEN)?.path).toBe("/a");
  });

  it("drains every token so the sidecar side can be released", () => {
    const map = new PlaybackTokenMap();
    map.register(TOKEN, { path: "/a", recordingId: "r1", protection: "plaintext" });
    map.register(OTHER, { path: "/b", recordingId: "r2", protection: "decrypted" });
    const drained = map.drain();
    expect(drained.map((item) => item.token).sort()).toEqual([TOKEN, OTHER].sort());
    expect(map.size).toBe(0);
  });

  it("validates the sidecar's prepare answer field by field", () => {
    expect(
      parsePreparedPlayback({
        token: TOKEN,
        path: "/data/a.wav",
        recordingId: "rec-1",
        protection: "plaintext",
        durationSeconds: 12.5,
      }),
    ).toEqual({
      token: TOKEN,
      path: "/data/a.wav",
      recordingId: "rec-1",
      protection: "plaintext",
      durationSeconds: 12.5,
    });
    expect(() => parsePreparedPlayback(null)).toThrow(/no result/);
    expect(() =>
      parsePreparedPlayback({ token: "bad", path: "/a", recordingId: "r", protection: "plaintext" }),
    ).toThrow(/invalid token/);
    expect(() =>
      parsePreparedPlayback({ token: TOKEN, path: "", recordingId: "r", protection: "plaintext" }),
    ).toThrow(/invalid path/);
    expect(() =>
      parsePreparedPlayback({ token: TOKEN, path: "/a", recordingId: "r", protection: "open" }),
    ).toThrow(/protection/);
    // A missing duration is zero, not NaN.
    expect(
      parsePreparedPlayback({ token: TOKEN, path: "/a", recordingId: "r", protection: "decrypted" })
        .durationSeconds,
    ).toBe(0);
  });
});

describe("playback URLs", () => {
  it("builds and parses the token route exactly", () => {
    expect(playbackUrl(TOKEN)).toBe(`plainsong://playback/${TOKEN}`);
    expect(playbackTokenFromUrl(`plainsong://playback/${TOKEN}`)).toBe(TOKEN);
  });

  it("refuses anything that is not exactly the token route", () => {
    expect(playbackTokenFromUrl(`plainsong://bundle/${TOKEN}`)).toBeNull();
    expect(playbackTokenFromUrl(`plainsong://playback/${TOKEN}/extra`)).toBeNull();
    expect(playbackTokenFromUrl(`plainsong://playback/${TOKEN}?x=1`)).toBeNull();
    expect(playbackTokenFromUrl(`plainsong://playback/${TOKEN}#f`)).toBeNull();
    expect(playbackTokenFromUrl("plainsong://playback/")).toBeNull();
    expect(playbackTokenFromUrl("plainsong://playback/../index.html")).toBeNull();
    expect(playbackTokenFromUrl(`https://playback/${TOKEN}`)).toBeNull();
    expect(playbackTokenFromUrl("not a url")).toBeNull();
  });
});

describe("Range parsing", () => {
  it("treats a missing or malformed header as the whole file", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader(null, 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("items=0-10", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=0-10,20-30", 100)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=-", 100)).toEqual({ kind: "full" });
  });

  it("parses explicit, open-ended, and suffix ranges, clamped to the file", () => {
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ kind: "range", start: 50, end: 99 });
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseRangeHeader(" Bytes = 5 - 6 ", 100)).toEqual({ kind: "range", start: 5, end: 6 });
  });

  it("marks ranges past the end or inverted as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=200-300", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=10-5", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("playback responses", () => {
  function streamOf(windows: Array<[number, number]>) {
    return (start: number, end: number) => {
      windows.push([start, end]);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(end - start + 1));
          controller.close();
        },
      });
    };
  }

  it("answers a plain GET with 200, the full length, and Accept-Ranges", async () => {
    const windows: Array<[number, number]> = [];
    const response = buildPlaybackResponse({
      method: "GET",
      rangeHeader: null,
      size: 1000,
      contentType: "audio/wav",
      openStream: streamOf(windows),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-range")).toBeNull();
    expect(windows).toEqual([[0, 999]]);
    expect((await response.arrayBuffer()).byteLength).toBe(1000);
  });

  it("answers a Range GET with 206 and the exact byte window", async () => {
    const windows: Array<[number, number]> = [];
    const response = buildPlaybackResponse({
      method: "GET",
      rangeHeader: "bytes=100-199",
      size: 1000,
      contentType: "audio/wav",
      openStream: streamOf(windows),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(windows).toEqual([[100, 199]]);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it("answers an open-ended Range from the start offset to the end", () => {
    const windows: Array<[number, number]> = [];
    const response = buildPlaybackResponse({
      method: "GET",
      rangeHeader: "bytes=900-",
      size: 1000,
      contentType: "audio/wav",
      openStream: streamOf(windows),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(windows).toEqual([[900, 999]]);
  });

  it("answers an unsatisfiable Range with 416 and opens no stream", () => {
    const windows: Array<[number, number]> = [];
    const response = buildPlaybackResponse({
      method: "GET",
      rangeHeader: "bytes=5000-",
      size: 1000,
      contentType: "audio/wav",
      openStream: streamOf(windows),
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
    expect(windows).toEqual([]);
  });

  it("answers HEAD with headers only", () => {
    const windows: Array<[number, number]> = [];
    const response = buildPlaybackResponse({
      method: "HEAD",
      rangeHeader: "bytes=0-9",
      size: 1000,
      contentType: "audio/wav",
      openStream: streamOf(windows),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.body).toBeNull();
    expect(windows).toEqual([]);
  });
});

describe("playback IPC contract", () => {
  it("admits the two playback commands and nothing path-shaped", () => {
    expect(isRendererCommandAllowed("prepare_recording_playback")).toBe(true);
    expect(isRendererCommandAllowed("release_recording_playback")).toBe(true);
  });

  it("gives preparation the long budget a whole-file decrypt needs", () => {
    expect(getCommandTimeoutMs("prepare_recording_playback")).toBe(5 * 60_000);
    expect(getCommandTimeoutMs("release_recording_playback")).toBe(60_000);
  });
});

function mainSource(): string {
  return readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
}

describe("orphaned playback tokens", () => {
  it("releases every token when the renderer that holds them goes away", () => {
    // A reload or an in-app navigation replaces the renderer: it can no longer
    // release its tokens, and the decrypted audio behind them stayed on disk
    // until the vault locked. Both handlers must also be registered for real
    // builds, not only inside the dev-only block they used to sit in.
    const source = mainSource();
    const createMainWindow = source.slice(source.indexOf("function createMainWindow"));
    const alwaysRegistered = createMainWindow.slice(0, createMainWindow.indexOf("if (isDev) {"));
    expect(alwaysRegistered).toContain('win.webContents.on("did-start-navigation"');
    expect(alwaysRegistered).toContain('releaseAllPlayback("renderer navigated", true)');
    expect(alwaysRegistered).toContain('win.webContents.on("render-process-gone"');
    expect(alwaysRegistered).toContain('releaseAllPlayback("renderer process gone", true)');
    // A same-document navigation is the same renderer; it keeps its tokens.
    expect(alwaysRegistered).toContain("details.isSameDocument");
    expect(alwaysRegistered).toContain("details.isMainFrame");
  });

  it("releases a preparation that failed after the sidecar minted its token", () => {
    // `prepare_recording_playback` has a five-minute budget. A decrypt that
    // runs past it rejects here while the sidecar goes on to register a token
    // whose id nobody ever learns, so the release has to name the recording.
    const source = mainSource();
    const prepareCase = source.slice(
      source.indexOf('case "prepare_recording_playback": {'),
      source.indexOf('case "release_recording_playback": {'),
    );
    expect(prepareCase).toContain("} catch (error) {");
    expect(prepareCase).toContain('invokeSidecar("release_recording_playback"');
    expect(prepareCase).toContain("recordingId: payload.recordingId");
    expect(prepareCase).toContain("throw error;");
  });
});
