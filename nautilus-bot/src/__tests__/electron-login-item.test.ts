import { describe, expect, it } from "vitest";
import { describeLoginItem } from "../../electron/login-item";

describe("describeLoginItem", () => {
  it("shows what macOS reports, not a remembered preference", () => {
    expect(describeLoginItem({ openAtLogin: false, status: "not-registered" })).toEqual({
      checked: false,
      label: "Open at Login",
    });
    expect(describeLoginItem({ openAtLogin: true, status: "enabled" }).checked).toBe(true);
    // macOS 13+ can report the service as enabled while openAtLogin lags.
    expect(describeLoginItem({ openAtLogin: false, status: "enabled" }).checked).toBe(true);
  });

  it("says when macOS is waiting for the reader to allow it", () => {
    expect(describeLoginItem({ openAtLogin: false, status: "requires-approval" })).toEqual({
      checked: true,
      label: "Open at Login (allow in System Settings)",
    });
  });

  it("starts unchecked before anything was read", () => {
    expect(describeLoginItem(null)).toEqual({ checked: false, label: "Open at Login" });
  });
});
