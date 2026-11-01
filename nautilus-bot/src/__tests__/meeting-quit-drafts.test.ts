import { describe, expect, it, vi } from "vitest";
import { createMeetingQuitDraftCoordinator } from "../../electron/meeting-quit-drafts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(overrides: Partial<Parameters<typeof createMeetingQuitDraftCoordinator>[0]> = {}) {
  const callbacks = {
    flushRendererDrafts: vi.fn(async () => true),
    finalizeMeeting: vi.fn(async () => ({ status: "confirmed" as const })),
    reissueQuit: vi.fn(),
    setQuitPending: vi.fn(),
    onFinalizationFailure: vi.fn(),
    onQuitCancelled: vi.fn(),
    ...overrides,
  };
  return { callbacks, coordinator: createMeetingQuitDraftCoordinator(callbacks) };
}

describe("meeting quit draft coordinator", () => {
  it("keeps capture open after a finalization timeout and allows a later confirmed retry", async () => {
    const finalizeMeeting = vi.fn<() => Promise<{ status: "timed_out" } | { status: "confirmed" }>>()
      .mockResolvedValueOnce({ status: "timed_out" })
      .mockResolvedValueOnce({ status: "confirmed" });
    const { callbacks, coordinator } = setup({ finalizeMeeting });
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(callbacks.reissueQuit).not.toHaveBeenCalled();
    expect(callbacks.onQuitCancelled).toHaveBeenCalledOnce();
    expect(callbacks.setQuitPending).toHaveBeenLastCalledWith(false);
    expect(callbacks.onFinalizationFailure).toHaveBeenCalledWith({ status: "failed", error: expect.any(Error) });
    expect(coordinator.isFinalShutdownStarted()).toBe(false);
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(finalizeMeeting).toHaveBeenCalledTimes(2);
    expect(callbacks.reissueQuit).toHaveBeenCalledOnce();
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(true);
  });

  it("flushes late renderer edits again after meeting finalization", async () => {
    const order: string[] = [];
    const { callbacks, coordinator } = setup({
      flushRendererDrafts: vi.fn(async () => { order.push("flush"); return true; }),
      finalizeMeeting: vi.fn(async () => { order.push("finalize"); return { status: "confirmed" as const }; }),
      reissueQuit: vi.fn(() => order.push("quit")),
    });

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: true })).toBe(false);
    await settle();
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: true })).toBe(false);
    await settle();
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: true })).toBe(false);
    await settle();
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: true })).toBe(true);

    expect(order).toEqual(["flush", "quit", "finalize", "quit", "flush", "quit"]);
    expect(callbacks.flushRendererDrafts).toHaveBeenCalledTimes(2);
  });

  it("keeps the app running when meeting finalization fails", async () => {
    const failure = { status: "failed" as const, error: new Error("stop failed") };
    const { callbacks, coordinator } = setup({ finalizeMeeting: vi.fn(async () => failure) });

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();

    expect(callbacks.reissueQuit).not.toHaveBeenCalled();
    expect(callbacks.onFinalizationFailure).toHaveBeenCalledWith(failure);
    expect(callbacks.onQuitCancelled).toHaveBeenCalledWith(failure.error);
    expect(callbacks.setQuitPending).toHaveBeenLastCalledWith(false);
    expect(callbacks.onQuitCancelled).toHaveBeenCalledOnce();
    expect(coordinator.isFinalShutdownStarted()).toBe(false);

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(callbacks.finalizeMeeting).toHaveBeenCalledTimes(2);
  });

  it("deduplicates quit requests while meeting finalization is pending", async () => {
    const finalization = deferred<{ status: "confirmed" }>();
    const { callbacks, coordinator } = setup({ finalizeMeeting: vi.fn(() => finalization.promise) });

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    expect(callbacks.finalizeMeeting).toHaveBeenCalledOnce();

    finalization.resolve({ status: "confirmed" });
    await settle();
    expect(callbacks.reissueQuit).toHaveBeenCalledOnce();
  });

  it("does not finalize the same meeting again on the reissued quit", async () => {
    const { callbacks, coordinator } = setup();

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(true);

    expect(callbacks.finalizeMeeting).toHaveBeenCalledOnce();
  });

  it("clears quit-pending state when a renderer flush is cancelled", async () => {
    const flushRendererDrafts = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { callbacks, coordinator } = setup({ flushRendererDrafts });

    expect(coordinator.beforeQuit({ activeMeetingId: null, needsRendererFlush: true })).toBe(false);
    await settle();
    expect(callbacks.setQuitPending).toHaveBeenLastCalledWith(false);
    expect(callbacks.onQuitCancelled).toHaveBeenCalledOnce();
    expect(coordinator.isFinalShutdownStarted()).toBe(false);

    expect(coordinator.beforeQuit({ activeMeetingId: null, needsRendererFlush: true })).toBe(false);
    await settle();
    expect(callbacks.reissueQuit).toHaveBeenCalledOnce();
  });

  it("clears quit-pending state when finalization rejects and allows a retry", async () => {
    const error = new Error("unexpected stop failure");
    const finalizeMeeting = vi
      .fn<() => Promise<{ status: "confirmed" }>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: "confirmed" });
    const { callbacks, coordinator } = setup({ finalizeMeeting });

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(callbacks.setQuitPending).toHaveBeenLastCalledWith(false);
    expect(callbacks.onFinalizationFailure).toHaveBeenCalledWith({ status: "failed", error });
    expect(coordinator.isFinalShutdownStarted()).toBe(false);

    expect(coordinator.beforeQuit({ activeMeetingId: "meeting-1", needsRendererFlush: false })).toBe(false);
    await settle();
    expect(finalizeMeeting).toHaveBeenCalledTimes(2);
    expect(callbacks.reissueQuit).toHaveBeenCalledOnce();
  });
});
