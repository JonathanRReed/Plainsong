import { describe, expect, it, vi } from "vitest";
import { settingsSaveErrorMessage } from "@/components/settings/settings-error-message";

describe("settings storage failure advice", () => {
  it.each(["create settings directory", "create temp settings file", "write temp settings file", "sync temp settings file", "commit settings file"])(
    "keeps storage recovery advice for %s without exposing a path", (operation) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(settingsSaveErrorMessage(new Error(
          `Error invoking remote method 'sidecar:invoke': Error: Failed to ${operation}: /Users/test/settings.json: No space left on device (os error 28)`,
        ))).toBe("Couldn't save your settings. Check available storage and folder access, then retry.");
      } finally { log.mockRestore(); }
    },
  );
});
