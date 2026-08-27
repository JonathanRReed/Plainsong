import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trustedSenderFrameUrl } from "../../electron/trusted-sender";

function topLevel(url: string) {
  const mainFrame = { url };
  return { sender: { mainFrame }, senderFrame: mainFrame };
}

describe("trustedSenderFrameUrl", () => {
  it("returns the URL of a top-level frame", () => {
    expect(trustedSenderFrameUrl(topLevel("plainsong://bundle/index.html"))).toBe(
      "plainsong://bundle/index.html",
    );
  });

  it("refuses a subframe even at the same URL as the top-level frame", () => {
    // The gap: the frame URL was validated, but nothing required that frame to
    // be the top-level one, and a subframe carries the same preload.
    const url = "plainsong://bundle/index.html";
    expect(
      trustedSenderFrameUrl({
        sender: { mainFrame: { url } },
        senderFrame: { url },
      }),
    ).toBeNull();
  });

  it("refuses an event with no sender or no frame", () => {
    expect(trustedSenderFrameUrl({})).toBeNull();
    expect(trustedSenderFrameUrl({ senderFrame: { url: "plainsong://bundle/" } })).toBeNull();
    expect(trustedSenderFrameUrl({ sender: { mainFrame: { url: "x" } } })).toBeNull();
    expect(
      trustedSenderFrameUrl({ sender: { mainFrame: undefined }, senderFrame: undefined }),
    ).toBeNull();
    expect(trustedSenderFrameUrl({ sender: null, senderFrame: null })).toBeNull();
  });

  it("refuses a frame that reports no usable URL", () => {
    expect(trustedSenderFrameUrl(topLevel(""))).toBeNull();
    const mainFrame = { url: 42 };
    expect(
      trustedSenderFrameUrl({ sender: { mainFrame }, senderFrame: mainFrame }),
    ).toBeNull();
  });

  it("refuses a frame disposed mid-call rather than throwing", () => {
    // Electron throws on `senderFrame` once the frame is gone; the handler must
    // treat that as untrusted, not propagate it.
    expect(
      trustedSenderFrameUrl({
        get sender(): never {
          throw new Error("Object has been destroyed");
        },
        get senderFrame(): never {
          throw new Error("Object has been destroyed");
        },
      }),
    ).toBeNull();
  });
});

describe("ipcMain handler admission", () => {
  it("validates the sender on window:get-label", () => {
    // It was the one ipcMain handler with no sender check at all.
    const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const start = source.indexOf('ipcMain.handle("window:get-label"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("async function bootstrap", start));

    expect(handler).toContain("trustedSenderFrameUrl(event)");
    expect(handler).toContain("isTrustedRendererOrigin(frameUrl)");
    expect(handler).toContain("return null;");
  });

  it("routes the bridge's own check through the same helper", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "electron/ipc-bridge.ts"),
      "utf8",
    );
    expect(source).toContain("const frameUrl = trustedSenderFrameUrl(event);");
    // The old inline read did not require the top-level frame.
    expect(source).not.toContain("frameUrl = event.senderFrame?.url");
  });
});
