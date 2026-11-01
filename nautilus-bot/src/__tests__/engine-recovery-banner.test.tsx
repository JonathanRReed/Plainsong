import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineRecoveryBanner } from "@/components/engine-recovery-banner";
import { describeSidecarLoss } from "@/lib/sidecar-runtime";
import { invoke } from "@/lib/electron";
vi.mock("@/lib/electron", () => ({ invoke: vi.fn() }));
const notice = describeSidecarLoss("credential_required");
describe("explicit credential recovery", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });
  it("waits for a click and prevents a second retry while approval is pending", async () => {
    vi.mocked(invoke).mockResolvedValue({ accepted: true });
    render(<EngineRecoveryBanner notice={notice} />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock and retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("retry_sidecar_with_credential_access"));
    const pending = screen.getByRole("button", { name: "Waiting for approval…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("allows another explicit click after rejection without retrying automatically", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("gesture expired"));
    render(<EngineRecoveryBanner notice={notice} />);
    fireEvent.click(screen.getByRole("button", { name: "Unlock and retry" }));
    await screen.findByText(/Couldn't retry/);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Unlock and retry" })).toBeEnabled();
  });
  it("resets pending state when a new credential failure arrives", async () => {
    vi.mocked(invoke).mockResolvedValue({ accepted: true });
    const view = render(<EngineRecoveryBanner notice={notice} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock and retry" })));
    view.rerender(<EngineRecoveryBanner notice={{ ...notice }} />);
    expect(screen.getByRole("button", { name: "Unlock and retry" })).toBeEnabled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
