// @ts-nocheck - Vitest mock types don't align with TypeScript
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetaChannelToggle, UpdateStatusWidget } from "@/components/update";
import * as updates from "@/lib/backend/updates";
import * as license from "@/lib/backend/license";

vi.mock("@/lib/backend/updates", () => ({
  canUseBetaChannel: vi.fn(async () => false) as any,
  checkForUpdates: vi.fn(async () => null) as any,
  getUpdateChannel: vi.fn(async () => "stable") as any,
  getUpdateLockReason: vi.fn(async () => null) as any,
  getUpdateStatus: vi.fn(async () => ({ status: "upToDate" })) as any,
  installUpdate: vi.fn(async () => {}) as any,
  setUpdateChannel: vi.fn(async () => {}) as any,
}));

vi.mock("@/lib/backend/license", () => ({
  validateLicense: vi.fn(async () => ({})) as any,
}));

const activeLicense = {
  tier: "pro",
  valid: true,
  lsStatus: "active",
  activationsLimit: 5,
  activationsUsage: 1,
  lastValidatedAt: "2026-05-02T00:00:00Z",
  trialDaysRemaining: 0,
  nagRequired: false,
  trialActive: false,
};

describe("update components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    license.validateLicense.mockResolvedValue(activeLicense);
    updates.canUseBetaChannel.mockResolvedValue(false);
    updates.checkForUpdates.mockResolvedValue(null);
    updates.getUpdateChannel.mockResolvedValue("stable");
    updates.getUpdateLockReason.mockResolvedValue(null);
    updates.getUpdateStatus.mockResolvedValue({ status: "upToDate" });
    updates.installUpdate.mockResolvedValue(undefined);
    updates.setUpdateChannel.mockResolvedValue(undefined);
  });

  it("shows locked update messaging when the license and trial are inactive", async () => {
    license.validateLicense.mockResolvedValue({
      ...activeLicense,
      tier: "none",
      valid: false,
      lsStatus: "",
      trialActive: false,
      trialDaysRemaining: 0,
    });
    updates.getUpdateLockReason.mockResolvedValue(
      "Updates require a license or active trial."
    );

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Updates Locked")).toBeInTheDocument();
    expect(screen.getByText("Updates require a license or active trial.")).toBeInTheDocument();
    expect(updates.getUpdateLockReason).toHaveBeenCalledTimes(1);
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

  it("keeps beta disabled when the user is not entitled", async () => {
    render(<BetaChannelToggle />);

    const betaSwitch = await screen.findByRole("switch", { name: "Beta Channel" });
    expect(betaSwitch).toBeDisabled();
    expect(betaSwitch).not.toBeChecked();
    expect(screen.getByText("Friends Club")).toBeInTheDocument();
  });

  it("sets the beta channel for entitled users", async () => {
    updates.canUseBetaChannel.mockResolvedValue(true);

    render(<BetaChannelToggle />);

    const betaSwitch = await screen.findByRole("switch", { name: "Beta Channel" });
    expect(betaSwitch).not.toBeDisabled();

    fireEvent.click(betaSwitch);

    await waitFor(() => {
      expect(updates.setUpdateChannel).toHaveBeenCalledWith("beta");
    });
  });
});
