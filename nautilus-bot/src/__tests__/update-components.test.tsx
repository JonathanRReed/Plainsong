// @ts-nocheck - Vitest mock types don't align with TypeScript
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetaChannelToggle, UpdateStatusWidget } from "@/components/update";
import * as updates from "@/lib/backend/updates";
import * as electron from "@/lib/electron";

vi.mock("@/lib/backend/updates", () => ({
  checkForUpdates: vi.fn(async () => null) as any,
  getUpdateChannel: vi.fn(async () => "stable") as any,
  getUpdateStatus: vi.fn(async () => ({ status: "upToDate" })) as any,
  installUpdate: vi.fn(async () => {}) as any,
  setUpdateChannel: vi.fn(async () => {}) as any,
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async () => () => {}) as any,
}));

describe("update components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.checkForUpdates.mockResolvedValue(null);
    updates.getUpdateChannel.mockResolvedValue("stable");
    updates.getUpdateStatus.mockResolvedValue({ status: "upToDate" });
    updates.installUpdate.mockResolvedValue(undefined);
    updates.setUpdateChannel.mockResolvedValue(undefined);
    electron.listen.mockResolvedValue(() => {});
  });

  it("offers install when an update is available", async () => {
    updates.getUpdateStatus.mockResolvedValue({
      status: "updateAvailable",
      info: {
        version: "1.2.3",
        notes: "Stability fixes",
        pubDate: "2026-05-02T00:00:00Z",
        isBeta: false,
      },
    });

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("Version 1.2.3 is available.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /install update/i }));

    await waitFor(() => {
      expect(updates.installUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces a failed update check in the error panel instead of failing silently", async () => {
    updates.checkForUpdates.mockRejectedValue(new Error("network unreachable"));

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Up to date")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Plainsong couldn't reach the update server. Check your internet connection, then try again.",
      ),
    ).toBeInTheDocument();
  });

  it("drops Electron's wrapper from an error it can't name", async () => {
    updates.checkForUpdates.mockRejectedValue(
      new Error(
        "Error invoking remote method 'sidecar:invoke': Error: Finish the active meeting before installing the update.",
      ),
    );
    render(<UpdateStatusWidget />);
    await screen.findByText("Up to date");
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(
      await screen.findByText("Finish the active meeting before installing the update."),
    ).toBeInTheDocument();
  });

  it("shows no status badge before anything was checked", async () => {
    updates.getUpdateStatus.mockResolvedValue({ status: "unknown" });
    render(<UpdateStatusWidget />);
    await screen.findByRole("button", { name: /check for updates/i });
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("offers the same update again after an install fails, and no new check while downloading", async () => {
    let pushStatus;
    electron.listen.mockImplementation(async (event, handler) => {
      pushStatus = (payload) => handler({ event, payload, id: 1 });
      return () => {};
    });
    render(<UpdateStatusWidget />);
    await screen.findByText("Up to date");
    await waitFor(() => expect(pushStatus).toBeDefined());
    const info = { version: "1.2.3", notes: "", pubDate: "", isBeta: false };

    act(() => pushStatus({ status: "downloading", info, progress: 10 }));
    expect(await screen.findByRole("button", { name: /check for updates/i })).toBeDisabled();

    act(() =>
      pushStatus({
        status: "error",
        info,
        error: "The update is prepared. Save failed. Retry installation when ready.",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /try installing again/i }));
    await waitFor(() => expect(updates.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("renders download progress pushed via update-status-changed events", async () => {
    let pushStatus;
    electron.listen.mockImplementation(async (event, handler) => {
      expect(event).toBe("update-status-changed");
      pushStatus = (payload) => handler({ event, payload, id: 1 });
      return () => {};
    });

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    await waitFor(() => {
      expect(pushStatus).toBeDefined();
    });

    act(() => {
      pushStatus({
        status: "downloading",
        info: { version: "1.2.3", notes: "", pubDate: "", isBeta: false },
        progress: 42.4,
      });
    });

    expect(await screen.findByText("Downloading…")).toBeInTheDocument();
    expect(screen.getByText("Downloading update… 42%")).toBeInTheDocument();

    act(() => {
      pushStatus({ status: "error", error: "Download failed" });
    });

    expect(await screen.findByText("Download failed")).toBeInTheDocument();
  });

  it("offers a GitHub download instead of install when the build cannot self-update", async () => {
    updates.getUpdateStatus.mockResolvedValue({
      status: "updateAvailable",
      info: {
        version: "1.2.3",
        notes: "Stability fixes",
        pubDate: "2026-05-02T00:00:00Z",
        isBeta: false,
      },
      installBlockedReason: "unsigned",
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install update/i })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /download from github/i }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/JonathanRReed/Plainsong/releases"
    );
    openSpy.mockRestore();
  });

  it("lets anyone enable the beta channel", async () => {
    render(<BetaChannelToggle />);

    const betaSwitch = await screen.findByRole("switch", { name: "Beta updates" });
    expect(betaSwitch).not.toBeDisabled();
    expect(betaSwitch).not.toBeChecked();

    fireEvent.click(betaSwitch);

    await waitFor(() => {
      expect(updates.setUpdateChannel).toHaveBeenCalledWith("beta");
    });
  });
});
