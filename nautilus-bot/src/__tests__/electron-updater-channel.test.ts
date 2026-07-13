import { describe, expect, it } from "vitest";
import {
  resolveUpdaterChannel,
  updaterChannelManifestFilename,
} from "../../electron/updater-channel";

describe("resolveUpdaterChannel", () => {
  it("maps stable to electron-updater's default latest channel", () => {
    // electron-builder never publishes stable-mac.yml; a "stable" channel
    // would 404 with no fallback (allowPrerelease is false on stable).
    expect(resolveUpdaterChannel("stable")).toBe("latest");
  });

  it("keeps beta as a custom channel", () => {
    expect(resolveUpdaterChannel("beta")).toBe("beta");
  });
});

describe("updaterChannelManifestFilename", () => {
  it("stable on macOS requests latest-mac.yml, which electron-builder publishes", () => {
    expect(updaterChannelManifestFilename("stable", "darwin")).toBe("latest-mac.yml");
  });

  it("beta on macOS requests beta-mac.yml", () => {
    expect(updaterChannelManifestFilename("beta", "darwin")).toBe("beta-mac.yml");
  });

  it("stable on Windows requests latest.yml", () => {
    expect(updaterChannelManifestFilename("stable", "win32")).toBe("latest.yml");
  });
});
