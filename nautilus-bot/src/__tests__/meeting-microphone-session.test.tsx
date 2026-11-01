import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>() }));
vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async (command: string) => command === "get_recording_overlay_state" ? {
    phase: "recording", recordingId: "a", startedAtMs: Date.now(),
    microphoneInput: { requestedName: "Desk mic", resolvedName: "Built-in mic", usedFallback: true, advisory: null },
  } : { phase: "idle" }),
  listen: vi.fn(async (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
    mocks.listeners.set(name, callback); return () => mocks.listeners.delete(name);
  }),
}));
import { RecordingProvider, useRecordingSession } from "@/hooks/use-recording";
function Host() {
  const state = useRecordingSession();
  return <output data-testid="session">{JSON.stringify({ id: state.recordingId, phase: state.meetingPhase,
    input: state.meetingMicrophoneInput, dismissed: state.meetingMicrophoneWarningDismissed, paused: state.meetingPaused })}</output>;
}
describe("meeting microphone fallback session propagation", () => {
  it("hydrates the resolver route and retains it through pause/dismissal until stop", async () => {
    await act(async () => { render(<RecordingProvider><Host /></RecordingProvider>); });
    expect(screen.getByTestId("session")).toHaveTextContent("Built-in mic");
    await act(async () => { mocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "recording", recordingId: "a", paused: true, microphoneWarningDismissed: true } }); });
    expect(JSON.parse(screen.getByTestId("session").textContent ?? "{}")).toMatchObject({ id: "a", paused: true, dismissed: true, input: { resolvedName: "Built-in mic" } });
    await act(async () => { mocks.listeners.get("meeting-recording-state-changed")?.({ payload: { phase: "stopping", recordingId: "a" } }); });
    expect(JSON.parse(screen.getByTestId("session").textContent ?? "{}").input).toBeNull();
  });
});
