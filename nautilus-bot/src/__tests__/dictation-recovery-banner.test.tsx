import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DictationRecoveryBanner,
  describePendingDictationRecovery,
} from "@/components/dictation-recovery-banner";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({ invoke: mocks.invoke, listen: mocks.listen }));

const pending = { stage: "recognized" as const, savedAtMs: Date.UTC(2026, 9, 21, 15, 4), bytes: 64_000 };

describe("Recover last dictation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockResolvedValue(() => {});
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  });

  it("shows nothing when no dictation was left unfinished", async () => {
    mocks.invoke.mockResolvedValue(null);
    await act(async () => {
      render(<DictationRecoveryBanner />);
    });
    expect(screen.queryByText("Recover last dictation")).not.toBeInTheDocument();
  });

  it("offers a failed live dictation immediately without restarting", async () => {
    mocks.invoke.mockResolvedValue(null);
    await act(async () => { render(<DictationRecoveryBanner />); });
    expect(screen.queryByText("Recover last dictation")).not.toBeInTheDocument();
    mocks.invoke.mockResolvedValue({ ...pending, stage: "stopped" });
    await act(async () => { mocks.listen.mock.calls[0][1]({ payload: {} }); });
    expect(await screen.findByRole("button", { name: "Recover last dictation" })).toBeInTheDocument();
    expect(screen.getByText(/could not finish a dictation/)).toHaveTextContent("not inserted anywhere");
  });

  it("re-transcribes on request and offers Copy and Discard, never inserting", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_pending_dictation_recovery") return pending;
      if (command === "recover_pending_dictation") return { text: "Meet at 3, not 4.", stage: "recognized", savedAtMs: pending.savedAtMs };
      return null;
    });
    await act(async () => {
      render(<DictationRecoveryBanner />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Recover last dictation" }));
    expect(await screen.findByLabelText("Recovered words")).toHaveTextContent("Meet at 3, not 4.");
    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain("repaste_dictation_result");
    expect(commands.some((command) => /paste|insert/.test(String(command)))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Meet at 3, not 4."));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_pending_dictation_recovery"));
    expect(await screen.findByText("Recovered dictation copied")).toBeInTheDocument();
  });

  it("discards without transcribing", async () => {
    let saved = true;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "discard_pending_dictation_recovery") saved = false;
      return command === "get_pending_dictation_recovery" && saved ? pending : null;
    });
    await act(async () => {
      render(<DictationRecoveryBanner />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("Recover last dictation")).not.toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("discard_pending_dictation_recovery");
    expect(mocks.invoke).not.toHaveBeenCalledWith("recover_pending_dictation");
  });

  it("offers the next saved dictation after discarding one", async () => {
    let saved = 2;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "discard_pending_dictation_recovery") saved -= 1;
      return command === "get_pending_dictation_recovery" && saved ? pending : null;
    });
    await act(async () => { render(<DictationRecoveryBanner />); });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(saved).toBe(1));
    expect(screen.getByRole("button", { name: "Recover last dictation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("Recover last dictation")).not.toBeInTheDocument());
  });

  it("warns that a dictation killed after a delivery attempt may already be in the app", () => {
    expect(describePendingDictationRecovery({ ...pending, stage: "delivering" })).toMatch(/may already have been inserted/);
    expect(describePendingDictationRecovery(pending)).toMatch(/not inserted anywhere/);
  });
});
