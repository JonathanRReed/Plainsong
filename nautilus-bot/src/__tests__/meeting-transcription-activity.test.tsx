import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeMeetingTranscriptionActivity,
  emptyMeetingTranscriptionActivity,
  reduceMeetingTranscriptionProgress,
  reduceMeetingTranscriptionStatus,
  scopeMeetingTranscriptionActivity,
} from "@/lib/meeting-transcription-activity";
import { TranscriptionActivity } from "@/components/meetings/transcription-activity";
import { useMeetingTranscriptionActivity } from "@/hooks/use-meeting-transcription-activity";

const mocks = vi.hoisted(() => ({ listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(), cleanups: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock("@/lib/electron", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
  mocks.listeners.set(name, [...(mocks.listeners.get(name) ?? []), callback]);
  const cleanup = vi.fn(() => mocks.listeners.set(name, (mocks.listeners.get(name) ?? []).filter((value) => value !== callback)));
  mocks.cleanups.push(cleanup);
  return cleanup;
}) }));
afterEach(() => { vi.useRealTimers(); mocks.listeners.clear(); mocks.cleanups = []; });
const progress = (recordingId = "a", percent = 0, stage?: string) => ({ recordingId, chunkIndex: 1, progress: percent, ...(stage ? { stage } : {}) });
const emit = (name: string, payload: unknown) => mocks.listeners.get(name)?.forEach((callback) => callback({ payload }));

describe("meeting transcription activity", () => {
  it("keeps mid-run timing unknown until a real event arrives", () => {
    const current = emptyMeetingTranscriptionActivity("a", true);
    expect(describeMeetingTranscriptionActivity(current, 100000)).toBe("Waiting for a transcription update.");
    expect(current.receivedAt).toBeNull();
  });

  it("rejects foreign and malformed activity instead of resetting the timer", () => {
    const current = reduceMeetingTranscriptionProgress(emptyMeetingTranscriptionActivity("a", true), progress("a", 0.5, "chunk_started"), 1000);
    for (const payload of [progress("b"), progress("a", NaN), { ...progress(), chunkIndex: -1 }, progress("a", 0.5, "invented_stage"), null]) {
      expect(reduceMeetingTranscriptionProgress(current, payload, 2000)).toBe(current);
    }
    expect(describeMeetingTranscriptionActivity(current, 9000)).toBe("Last update 8 seconds ago.");
  });

  it("uses each source pass as activity without treating 100 percent as meeting completion", () => {
    let current = emptyMeetingTranscriptionActivity("a", true);
    current = reduceMeetingTranscriptionProgress(current, progress("a", 1), 1000);
    expect(current.active).toBe(true);
    current = reduceMeetingTranscriptionProgress(current, progress("a", 0, "chunk_started"), 2000);
    expect(current.active).toBe(true);
    expect(current.stage).toBe("Transcribing an audio segment");
    render(<TranscriptionActivity activity={current} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/100%|complete/i)).not.toBeInTheDocument();
  });

  it("clears terminal activity and ignores old processing status on a retry boundary", () => {
    let current = reduceMeetingTranscriptionStatus(emptyMeetingTranscriptionActivity("a", true), { recordingId: "a", status: "completed", updatedAt: "2026-10-12T12:00:00Z" }, 1000);
    expect(current.active).toBe(false);
    expect(reduceMeetingTranscriptionProgress(current, progress(), 2000)).toBe(current);
    current = scopeMeetingTranscriptionActivity(current, "a", true);
    expect(current.receivedAt).toBeNull();
    expect(reduceMeetingTranscriptionStatus(current, { recordingId: "a", status: "processing", updatedAt: "2026-10-12T11:59:59Z" }, 2000)).toBe(current);
    const next = reduceMeetingTranscriptionStatus(current, { recordingId: "a", status: "processing", message: "Processing transcript", updatedAt: "2026-10-12T12:01:00Z" }, 3000);
    expect(next.receivedAt).toBe(3000);
    expect(scopeMeetingTranscriptionActivity(next, "b", true).receivedAt).toBeNull();
  });

  it("stops showing active transcription when memory retries leave it pending", () => {
    const active = reduceMeetingTranscriptionStatus(emptyMeetingTranscriptionActivity("a", true),
      { recordingId: "a", status: "processing", message: "Waiting for memory to free up" }, 1000);
    const pending = reduceMeetingTranscriptionStatus(active, { recordingId: "a", status: "pending" }, 2000);
    expect(pending.active).toBe(false);
    expect(reduceMeetingTranscriptionProgress(pending, progress(), 3000)).toBe(pending);
  });

  it("keeps whole-file processing indeterminate and rejects percentage messages", () => {
    let current = reduceMeetingTranscriptionStatus(emptyMeetingTranscriptionActivity("a", true), { recordingId: "a", status: "processing", message: "Processing transcript", progress: 0 }, 1000);
    expect(current.stage).toBe("Processing transcript");
    current = reduceMeetingTranscriptionStatus(current, { recordingId: "a", status: "processing", message: "Meeting 100% complete", progress: 1 }, 2000);
    expect(current.stage).toBe("Processing transcript");
    expect(current.active).toBe(true);
  });

  it("updates time since receipt without announcing every clock tick and resets on activity", () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const activity = reduceMeetingTranscriptionProgress(emptyMeetingTranscriptionActivity("a", true), progress(), 10000);
    const { rerender } = render(<TranscriptionActivity activity={activity} />);
    expect(screen.getByText("Last update just now.")).toHaveAttribute("aria-live", "off");
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText("Last update 8 seconds ago.")).toBeInTheDocument();
    rerender(<TranscriptionActivity activity={{ ...activity, receivedAt: Date.now() }} />);
    expect(screen.getByText("Last update just now.")).toBeInTheDocument();
    rerender(<TranscriptionActivity activity={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scopes the live hook to selection and resets before retry", async () => {
    const { result, rerender, unmount } = renderHook(({ id, active }) => useMeetingTranscriptionActivity(id, active), { initialProps: { id: "a", active: true } });
    await act(async () => {});
    act(() => emit("recording-transcription-progress", progress("a", 0.5, "chunk_started")));
    expect(result.current.activity?.receivedAt).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.activity?.receivedAt).toBeNull();
    rerender({ id: "b", active: true });
    act(() => emit("recording-transcription-progress", progress("a")));
    expect(result.current.activity?.recordingId).toBe("b");
    expect(result.current.activity?.receivedAt).toBeNull();
    act(() => emit("recording-transcription-progress", progress("b")));
    act(() => emit("recording-status-changed", { recordingId: "b", status: "error" }));
    expect(result.current.activity).toBeNull();
    unmount();
    await act(async () => {});
    expect(mocks.cleanups.every((cleanup) => cleanup.mock.calls.length > 0)).toBe(true);
  });
});
