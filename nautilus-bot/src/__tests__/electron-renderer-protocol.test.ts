import path from "path";
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
