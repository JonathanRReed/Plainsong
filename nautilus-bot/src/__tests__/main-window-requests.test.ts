import { describe, expect, it, vi } from "vitest";
import { createMainWindowRequests } from "../../electron/main-window-requests";

describe("requests while the main window mounts", () => {
  it("delivers the latest destination once the renderer is interactive", () => {
    const send = vi.fn();
    const requests = createMainWindowRequests(send);
    requests.request("main-view-requested", { view: "settings" });
    const call = { appName: "Fixture call" };
    requests.request("meeting-call-capture-requested", call);
    expect(send).not.toHaveBeenCalled();
    requests.ready();
    requests.ready();
    expect(send).toHaveBeenCalledExactlyOnceWith("meeting-call-capture-requested", call);
    requests.request("main-view-requested", { view: "dictation" });
    expect(send).toHaveBeenLastCalledWith("main-view-requested", { view: "dictation" });
  });

  it("waits for the recovered renderer after a reload or crash", () => {
    const send = vi.fn();
    const requests = createMainWindowRequests(send);
    requests.ready();
    requests.reset();
    requests.request("main-view-requested", { view: "settings" });
    expect(send).not.toHaveBeenCalled();
    requests.ready();
    expect(send).toHaveBeenCalledExactlyOnceWith("main-view-requested", { view: "settings" });
  });
});
