import { readFileSync } from "node:fs";
import path from "path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRendererUrl,
  rendererUrl,
  resolveRendererAssetPath,
} from "../../electron/renderer-protocol";

describe("packaged renderer protocol", () => {
  const rendererRoot = path.resolve("/Applications/Plainsong.app/Contents/Resources/app.asar/dist");

  it("builds the main and overlay URLs on the isolated app origin", () => {
    expect(rendererUrl()).toBe("plainsong://bundle/index.html");
    expect(rendererUrl({ overlay: "dictation" })).toBe(
      "plainsong://bundle/index.html?overlay=dictation"
    );
  });

  it("recognizes only the packaged renderer host", () => {
    expect(isRendererUrl("plainsong://bundle/index.html")).toBe(true);
    expect(isRendererUrl("plainsong://attacker/index.html")).toBe(false);
    expect(isRendererUrl("file:///tmp/index.html")).toBe(false);
    expect(isRendererUrl("https://example.com")).toBe(false);
  });

  it("resolves renderer assets inside the packaged dist directory", () => {
    expect(
      resolveRendererAssetPath(rendererRoot, "plainsong://bundle/assets/index.js")
    ).toBe(path.join(rendererRoot, "assets/index.js"));
  });

  it("rejects malformed, cross-origin, and traversal paths", () => {
    expect(() =>
      resolveRendererAssetPath(rendererRoot, "plainsong://other/index.html")
    ).toThrow();
    expect(() =>
      resolveRendererAssetPath(rendererRoot, "plainsong://bundle/%00index.html")
    ).toThrow();
    expect(() =>
      resolveRendererAssetPath(
        rendererRoot,
        "plainsong://bundle/%2e%2e%2f%2e%2e%2fsecret"
      )
    ).toThrow();
  });
});

describe("packaged renderer trust boundary", () => {
  const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

  it("derives development mode from packaging alone", () => {
    // This was `NODE_ENV === "development" || !app.isPackaged`. Because it was
    // an OR, an ambient NODE_ENV could put a signed packaged build into dev
    // mode and, with the renderer overrides, load an arbitrary URL into every
    // privileged window.
    expect(mainSource).toMatch(/const isDev = !app\.isPackaged;/);
    expect(mainSource).not.toMatch(/const isDev =[^;]*NODE_ENV/);
  });

  it("only reads renderer overrides when unpackaged", () => {
    expect(mainSource).toMatch(
      /const devServerUrl = isDev[\s\S]{0,160}PLAINSONG_DEV_SERVER_URL/,
    );
    expect(mainSource).toMatch(
      /const rendererMode = isDev \? \(process\.env\.PLAINSONG_RENDERER_MODE \?\? "file"\) : "file";/,
    );
  });

  it("restricts the dev server to a loopback origin", () => {
    expect(mainSource).toMatch(/function isLoopbackDevServerUrl/);
    expect(mainSource).toMatch(
      /const devServerUrlIsUsable = isDev && rendererMode === "server" && isLoopbackDevServerUrl\(devServerUrl\)/,
    );
  });

  it("installs renderer permission handlers", () => {
    // Electron approves permission requests by default, and Plainsong's
    // renderers inherit the app's microphone entitlement.
    expect(mainSource).toMatch(/setPermissionRequestHandler/);
    expect(mainSource).toMatch(/setPermissionCheckHandler/);
    expect(mainSource).toMatch(/installRendererPermissionHandlers\(\);/);
  });

  it("validates the IPC sender origin", () => {
    expect(mainSource).toMatch(/ipcBridge\.onValidateSender\(isTrustedRendererOrigin\)/);
  });
});
