import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetaChannelToggle, UpdateStatusWidget } from "@/components/update";

const updateMocks = vi.hoisted(() => ({
  canUseBetaChannel: vi.fn(),
  checkForUpdates: vi.fn(),
  getUpdateChannel: vi.fn(),
  getUpdateLockReason: vi.fn(),
  getUpdateStatus: vi.fn(),
  installUpdate: vi.fn(),
  setUpdateChannel: vi.fn(),
}));

const licenseMocks = vi.hoisted(() => ({
  validateLicense: vi.fn(),
}));

vi.mock("@/lib/backend/updates", () => updateMocks);
vi.mock("@/lib/backend/license", () => licenseMocks);

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
    licenseMocks.validateLicense.mockResolvedValue(activeLicense);
    updateMocks.canUseBetaChannel.mockResolvedValue(false);
    updateMocks.checkForUpdates.mockResolvedValue(null);
    updateMocks.getUpdateChannel.mockResolvedValue("stable");
    updateMocks.getUpdateLockReason.mockResolvedValue(null);
    updateMocks.getUpdateStatus.mockResolvedValue({ status: "upToDate" });
    updateMocks.installUpdate.mockResolvedValue(undefined);
    updateMocks.setUpdateChannel.mockResolvedValue(undefined);
  });

  it("shows locked update messaging when the license and trial are inactive", async () => {
    licenseMocks.validateLicense.mockResolvedValue({
      ...activeLicense,
      tier: "none",
      valid: false,
      lsStatus: "",
      trialActive: false,
      trialDaysRemaining: 0,
    });
    updateMocks.getUpdateLockReason.mockResolvedValue(
      "Updates require a license or active trial."
    );

    render(<UpdateStatusWidget />);

    expect(await screen.findByText("Updates Locked")).toBeInTheDocument();
    expect(screen.getByText("Updates require a license or active trial.")).toBeInTheDocument();
    expect(updateMocks.getUpdateLockReason).toHaveBeenCalledTimes(1);
  });

  it("offers install when an update is available", async () => {
    updateMocks.getUpdateStatus.mockResolvedValue({
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
      expect(updateMocks.installUpdate).toHaveBeenCalledTimes(1);
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
    updateMocks.canUseBetaChannel.mockResolvedValue(true);

    render(<BetaChannelToggle />);

    const betaSwitch = await screen.findByRole("switch", { name: "Beta Channel" });
    expect(betaSwitch).not.toBeDisabled();

    fireEvent.click(betaSwitch);

    await waitFor(() => {
      expect(updateMocks.setUpdateChannel).toHaveBeenCalledWith("beta");
    });
  });
});
