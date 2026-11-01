import { describe, expect, it, vi } from "vitest";
import { rendererPermissionAllowed } from "../../electron/renderer-permission-policy";
import { checkMicrophonePermission, createMicrophoneAccessRequest, createMicrophonePermissionHandler } from "../../electron/microphone-permission";

function setup(status = "not-determined", platform = "darwin") {
  let settle!: (value: boolean) => void;
  const native = new Promise<boolean>((resolve) => { settle = resolve; });
  const getStatus = vi.fn(() => status);
  const ask = vi.fn(() => native);
  const handle = createMicrophonePermissionHandler({ platform, getStatus, ask });
  const callback = vi.fn();
  const isCurrent = vi.fn(() => true);
  const request = { allowed: true, permission: "media", mediaTypes: ["audio"], isCurrent, callback };
  return { handle, request, callback, getStatus, ask, settle, isCurrent };
}

async function flush() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

describe("native microphone permission boundary", () => {
  it.each(["untrusted", "subframe"])("denies %s before native APIs", (kind) => {
    const s = setup();
    const allowed = rendererPermissionAllowed("media", {
      requestingOrigin: kind === "untrusted" ? "https://untrusted.example" : "plainsong://app/",
      isMainFrame: kind !== "subframe",
    }, (origin) => origin === "plainsong://app/");
    s.handle({ ...s.request, allowed });
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(s.getStatus).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
  });
  it.each([undefined, [], ["video"], ["audio", "video"], ["audio", "audio"]])("preserves other media handling for %j", (mediaTypes) => {
    const s = setup(); s.handle({ ...s.request, mediaTypes });
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.getStatus).not.toHaveBeenCalled();
  });
  it.each(["linux", "win32"])("preserves %s handling", (platform) => {
    const s = setup("not-determined", platform); s.handle(s.request);
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.getStatus).not.toHaveBeenCalled();
  });
  it("preserves other admitted permissions", () => {
    const s = setup(); s.handle({ ...s.request, permission: "clipboard-sanitized-write" });
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.getStatus).not.toHaveBeenCalled();
  });
  it.each(["granted", "denied", "restricted", "unknown", "unexpected"])("handles status %s without prompting", (status) => {
    const s = setup(status); s.handle(s.request);
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(status === "granted");
    expect(s.ask).not.toHaveBeenCalled();
  });
  it.each([true, false])("passes native result %s once", async (result) => {
    const s = setup(); s.handle(s.request); s.settle(result); await flush();
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(result);
  });
  it("shares one pending native request and clears it after settlement", async () => {
    const s = setup(); const second = vi.fn();
    s.handle(s.request); s.handle({ ...s.request, callback: second });
    expect(s.ask).toHaveBeenCalledTimes(1);
    s.settle(true); await flush();
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
    s.handle({ ...s.request, callback: vi.fn() });
    expect(s.ask).toHaveBeenCalledTimes(2);
    await flush();
  });
  it.each(["stale", "destroyed"])("denies a %s requester after completion", async () => {
    const s = setup(); s.handle(s.request); s.isCurrent.mockReturnValue(false);
    s.settle(true); await flush();
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("denies a synchronous native request error", () => {
    const s = setup(); s.ask.mockImplementation(() => { throw Error("request"); });
    s.handle(s.request);
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(["status", "request", "recheck"])("denies %s errors once", async (stage) => {
    const s = setup();
    if (stage === "status") s.getStatus.mockImplementation(() => { throw Error("status"); });
    if (stage === "request") s.ask.mockReturnValue(Promise.reject(Error("request")));
    if (stage === "recheck") s.isCurrent.mockImplementation(() => { throw Error("destroyed"); });
    s.handle(s.request); s.settle(true); await flush();
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(false);
  });
});


describe("microphone permission check before request", () => {
  it("routes a cold macOS microphone check to the native request", async () => {
    const s = setup();
    const checked = checkMicrophonePermission({ platform: "darwin", getStatus: s.getStatus },
      { allowed: true, permission: "media", mediaType: "audio" });
    if (!checked) s.handle(s.request);
    expect(checked).toBe(false);
    expect(s.ask).toHaveBeenCalledTimes(1);
    s.settle(true); await flush();
    expect(s.callback).toHaveBeenCalledExactlyOnceWith(true);
    s.getStatus.mockReturnValue("granted");
    expect(checkMicrophonePermission({ platform: "darwin", getStatus: s.getStatus },
      { allowed: true, permission: "media", mediaType: "audio" })).toBe(true);
  });
  it.each(["not-determined", "denied", "restricted", "unknown", "unexpected"])("does not preapprove OS status %s", (status) => {
    const s = setup(status);
    expect(checkMicrophonePermission({ platform: "darwin", getStatus: s.getStatus },
      { allowed: true, permission: "media", mediaType: "audio" })).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it("denies untrusted or subframe checks before reading OS permission", () => {
    const s = setup("granted");
    for (const isMainFrame of [true, false]) {
      const allowed = rendererPermissionAllowed("media", {
        requestingOrigin: isMainFrame ? "https://untrusted.example" : "plainsong://app/", isMainFrame,
      }, (origin) => origin === "plainsong://app/");
      expect(checkMicrophonePermission({ platform: "darwin", getStatus: s.getStatus },
        { allowed, permission: "media", mediaType: "audio" })).toBe(false);
    }
    expect(s.getStatus).not.toHaveBeenCalled();
  });
  it("denies OS status errors without prompting", () => {
    const s = setup(); s.getStatus.mockImplementation(() => { throw Error("status"); });
    expect(checkMicrophonePermission({ platform: "darwin", getStatus: s.getStatus },
      { allowed: true, permission: "media", mediaType: "audio" })).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it.each([
    ["linux", "media", "audio"], ["win32", "media", "audio"],
    ["darwin", "clipboard-sanitized-write", "audio"],
    ["darwin", "media", "video"], ["darwin", "media", "unknown"], ["darwin", "media", undefined],
  ] satisfies [string, string, string | undefined][])("preserves %s %s %s checks", (platform, permission, mediaType) => {
    const s = setup();
    expect(checkMicrophonePermission({ platform, getStatus: s.getStatus },
      { allowed: true, permission, mediaType })).toBe(true);
    expect(s.getStatus).not.toHaveBeenCalled();
  });
});


describe("direct native microphone request", () => {
  it("shares a pending prompt with renderer media requests", async () => {
    const s = setup();
    const requestAccess = createMicrophoneAccessRequest(s.handle);
    s.handle(s.request);
    const access = requestAccess({ allowed: true, isCurrent: s.isCurrent });
    expect(s.ask).toHaveBeenCalledOnce();
    s.settle(true);
    await expect(access).resolves.toBe(true);
  });
  it.each(["untrusted", "disposed"])("denies %s before native access", async (kind) => {
    const s = setup();
    const requestAccess = createMicrophoneAccessRequest(s.handle);
    await expect(requestAccess({ allowed: kind !== "untrusted", isCurrent: () => kind !== "disposed" })).resolves.toBe(false);
    expect(s.getStatus).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
  });
  it("denies a document replaced while the prompt is pending", async () => {
    const s = setup();
    const access = createMicrophoneAccessRequest(s.handle)({ allowed: true, isCurrent: s.isCurrent });
    s.isCurrent.mockReturnValue(false);
    s.settle(true);
    await expect(access).resolves.toBe(false);
  });
});
