import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingMicrophoneFallback } from "@/components/meetings/microphone-fallback";
import { INITIAL_MEETING_LIFECYCLE_STATE, reduceMeetingLifecycleState } from "@/features/meetings/runtime";
import { parseMeetingMicrophoneInput } from "@/lib/meeting-microphone-input";
import { invoke } from "@/lib/electron";
vi.mock("@/lib/electron", () => ({ invoke: vi.fn(async () => null) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const input = { requestedName: "Desk microphone", resolvedName: "Built-in Microphone", usedFallback: true, advisory: "Fallback" };
const live = () => reduceMeetingLifecycleState(INITIAL_MEETING_LIFECYCLE_STATE, { phase: "recording", recordingId: "a", microphoneInput: input });

describe("meeting microphone fallback", () => {
  it("retains the actual name beyond toast expiry and settings leaves capture alone", async () => {
    vi.useFakeTimers(); const settings = vi.fn();
    render(<MeetingMicrophoneFallback recordingId="a" input={input} active onSettings={settings} />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText("Using Built-in Microphone.")).toBeInTheDocument();
    expect(screen.getByText(/Desk microphone is unavailable/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Settings" })); });
    expect(settings).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves route and dismissal through pause and clears terminal state", () => {
    let state = live(); const original = state.microphoneInput;
    state = reduceMeetingLifecycleState(state, { phase: "recording", recordingId: "a", paused: true });
    expect(state.microphoneInput).toBe(original);
    state = reduceMeetingLifecycleState(state, { phase: "recording", recordingId: "a", microphoneInput: { ...input }, microphoneWarningDismissed: true });
    expect(state.microphoneInput).toBe(original);
    expect(state.microphoneWarningDismissed).toBe(true);
    state = reduceMeetingLifecycleState(state, { phase: "recording", recordingId: "a", paused: false });
    expect(state.microphoneWarningDismissed).toBe(true);
    for (const phase of ["stopping", "error", "ready", "preparing"] as const) {
      expect(reduceMeetingLifecycleState(state, { phase, recordingId: "a" }).microphoneInput).toBeNull();
    }
  });
  it("rejects foreign metadata and resets when another meeting starts", () => {
    const state = live();
    expect(reduceMeetingLifecycleState(state, { phase: "recording", recordingId: "b", microphoneInput: input })).toBe(state);
    const unscoped = reduceMeetingLifecycleState(state, { phase: "recording", microphoneInput: { ...input, resolvedName: "Wrong mic" } });
    expect(unscoped.microphoneInput).toBe(state.microphoneInput);
    const ended = reduceMeetingLifecycleState(state, { phase: "ready", recordingId: "a" });
    expect(reduceMeetingLifecycleState(ended, { phase: "recording", recordingId: "b" }).microphoneInput).toBeNull();
    expect(parseMeetingMicrophoneInput({ resolvedName: "", usedFallback: true })).toBeNull();
  });
  it("does not invent a warning for old sidecars, disabled capture or normal input", () => {
    const view = render(<MeetingMicrophoneFallback recordingId="a" input={undefined} active onSettings={() => {}} />);
    expect(screen.queryByRole("region", { name: "Meeting microphone" })).not.toBeInTheDocument();
    view.rerender(<MeetingMicrophoneFallback recordingId="a" input={{ ...input, usedFallback: false }} active onSettings={() => {}} />);
    expect(screen.queryByText(/Using/)).not.toBeInTheDocument();
    view.rerender(<MeetingMicrophoneFallback recordingId="a" input={input} active={false} onSettings={() => {}} />);
    expect(screen.queryByText(/Using/)).not.toBeInTheDocument();
  });
  it("keeps failed dismissal retryable and suppresses duplicate requests", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("failed"));
    render(<MeetingMicrophoneFallback recordingId="a" input={input} active onSettings={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" })); });
    expect(invoke).toHaveBeenLastCalledWith("dismiss_meeting_microphone_warning", { recordingId: "a" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("handles rejected settings navigation without an unhandled promise", async () => {
    render(<MeetingMicrophoneFallback recordingId="a" input={input} active onSettings={async () => { throw new Error("failed"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open settings");
  });

});
