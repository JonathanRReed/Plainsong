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

    expect(await screen.findByText("Update Available")).toBeInTheDocument();
    expect(screen.getByText("Version 1.2.3 is available")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /install update/i }));

    await waitFor(() => {
      expect(updates.installUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces a failed update check in the error panel instead of failing silently", async () => {
    updates.checkForUpdates.mockRejectedValue(new Error("network unreachable"));

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Up to Date")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(screen.getByText("network unreachable")).toBeInTheDocument();
  });

  it("renders download progress pushed via update-status-changed events", async () => {
    let pushStatus;
    electron.listen.mockImplementation(async (event, handler) => {
      expect(event).toBe("update-status-changed");
      pushStatus = (payload) => handler({ event, payload, id: 1 });
      return () => {};
    });

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Up to Date")).toBeInTheDocument();
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

    expect(await screen.findByText("Downloading...")).toBeInTheDocument();
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

    expect(await screen.findByText("Update Available")).toBeInTheDocument();
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

    const betaSwitch = await screen.findByRole("switch", { name: "Beta Channel" });
    expect(betaSwitch).not.toBeDisabled();
    expect(betaSwitch).not.toBeChecked();

    fireEvent.click(betaSwitch);

    await waitFor(() => {
      expect(updates.setUpdateChannel).toHaveBeenCalledWith("beta");
    });
  });
});
