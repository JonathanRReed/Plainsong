import { describe, expect, it } from "vitest";
import {
  RENDERER_READY_LOG_MESSAGE,
  shouldForwardRendererConsoleMessage,
} from "../../electron/renderer-readiness";

describe("packaged renderer readiness logging", () => {
  it("forwards only the exact renderer-ready signal in production", () => {
    expect(
      shouldForwardRendererConsoleMessage(RENDERER_READY_LOG_MESSAGE, false)
    ).toBe(true);
    expect(
      shouldForwardRendererConsoleMessage("[main] App loaded", false)
    ).toBe(false);
    expect(
      shouldForwardRendererConsoleMessage("secret-looking renderer output", false)
    ).toBe(false);
  });

  it("keeps full renderer console forwarding in development", () => {
    expect(
      shouldForwardRendererConsoleMessage("development diagnostic", true)
    ).toBe(true);
  });
});
