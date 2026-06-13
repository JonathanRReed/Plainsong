// @ts-nocheck - Vitest mock types don't align with TypeScript
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetaChannelToggle, UpdateStatusWidget } from "@/components/update";
import * as updates from "@/lib/backend/updates";

vi.mock("@/lib/backend/updates", () => ({
  checkForUpdates: vi.fn(async () => null) as any,
  getUpdateChannel: vi.fn(async () => "stable") as any,
  getUpdateStatus: vi.fn(async () => ({ status: "upToDate" })) as any,
  installUpdate: vi.fn(async () => {}) as any,
  setUpdateChannel: vi.fn(async () => {}) as any,
}));

describe("update components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.checkForUpdates.mockResolvedValue(null);
    updates.getUpdateChannel.mockResolvedValue("stable");
    updates.getUpdateStatus.mockResolvedValue({ status: "upToDate" });
    updates.installUpdate.mockResolvedValue(undefined);
    updates.setUpdateChannel.mockResolvedValue(undefined);
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
