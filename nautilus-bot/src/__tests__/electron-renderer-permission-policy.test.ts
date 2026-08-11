import { describe, expect, it } from "vitest";
import { rendererPermissionAllowed } from "../../electron/renderer-permission-policy";

const isTrusted = (origin: string) => origin.startsWith("plainsong://app/");

describe("renderer permission policy", () => {
  it("allows supported permissions only for the trusted main frame", () => {
    expect(
      rendererPermissionAllowed(
        "media",
        { requestingOrigin: "plainsong://app/meetings", isMainFrame: true },
        isTrusted,
      ),
    ).toBe(true);
    expect(
      rendererPermissionAllowed(
        "notifications",
        { requestingOrigin: "plainsong://app/meetings", isMainFrame: true },
        isTrusted,
      ),
    ).toBe(false);
  });

  it("denies an untrusted subframe even when its top-level window is trusted", () => {
    expect(
      rendererPermissionAllowed(
        "media",
        { requestingOrigin: "https://untrusted.example/frame", isMainFrame: false },
        isTrusted,
      ),
    ).toBe(false);
  });
});
