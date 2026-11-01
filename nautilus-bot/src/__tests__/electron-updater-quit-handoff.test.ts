import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingQuitDraftCoordinator } from "../../electron/meeting-quit-drafts";
import { prepareMainRendererQuit } from "../../electron/renderer-quit-guard";
import { runExplicitUpdaterInstallFlow } from "../../electron/updater-install-flow";
import { createUpdaterQuitHandoff } from "../../electron/updater-quit-handoff";

function harness() {
  const handoff = createUpdaterQuitHandoff();
  const flush = vi.fn(async () => true);
  const cancelHelper = vi.fn();
  const launchHelper = vi.fn(async () => cancelHelper);
  const updater = {
    autoInstallOnAppQuit: false,
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const onFailure = vi.fn();
  const coordinator = createMeetingQuitDraftCoordinator({
    flushRendererDrafts: flush,
    finalizeMeeting: async () => ({ status: "confirmed" }),
    reissueQuit: attemptQuit,
    setQuitPending: vi.fn(),
    onFinalizationFailure: vi.fn(),
    onQuitCancelled: (error) => handoff.cancelled(error),
  });
  function attemptQuit() {
    if (coordinator.beforeQuit({ activeMeetingId: null, needsRendererFlush: true })) {
      handoff.complete();
    }
  }
  const options = {
    platform: "darwin",
    updater,
    updateReadyToInstall: false,
    prepareToQuit: flush,
    setDownloading: vi.fn(),
    setInstalling: vi.fn(),
    waitForMacosStaging: vi.fn(async () => undefined),
    launchMacosRelauncher: launchHelper,
    quitApp: () => handoff.requestQuit(attemptQuit),
    onFailure,
  } satisfies Parameters<typeof runExplicitUpdaterInstallFlow>[0];
  return { handoff, flush, cancelHelper, launchHelper, updater, onFailure, options };
}

afterEach(() => vi.useRealTimers());

describe("updater quit handoff with renderer draft coordinator", () => {
  it("blocks initial failed draft flush before downloading or arming", async () => {
    const flow = harness();
    flow.flush.mockResolvedValue(false);
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(flow.launchHelper).not.toHaveBeenCalled();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.handoff.hasPending()).toBe(false);
  });

  it("blocks a renderer preparation timeout before downloading", async () => {
    vi.useFakeTimers();
    const flow = harness();
    flow.flush.mockImplementation(() => prepareMainRendererQuit(() => new Promise<unknown>(() => {}), 20));
    const result = expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(flow.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(flow.launchHelper).not.toHaveBeenCalled();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("cancels the owned helper when actual quit draft saving fails", async () => {
    const flow = harness();
    flow.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    expect(flow.cancelHelper).toHaveBeenCalledOnce();
    expect(flow.updater.autoInstallOnAppQuit).toBe(false);
    expect(flow.handoff.hasPending()).toBe(false);
    expect(flow.onFailure).toHaveBeenCalledWith(expect.any(Error), { downloaded: true, staged: true });
  });

  it("completes accepted quit without cancelling its helper", async () => {
    const flow = harness();
    await runExplicitUpdaterInstallFlow(flow.options);
    expect(flow.flush).toHaveBeenCalledTimes(3);
    expect(flow.launchHelper).toHaveBeenCalledOnce();
    expect(flow.cancelHelper).not.toHaveBeenCalled();
    expect(flow.onFailure).not.toHaveBeenCalled();
    expect(flow.handoff.hasPending()).toBe(false);
  });

  it("can retry the same updater after actual quit cancellation", async () => {
    const flow = harness();
    flow.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runExplicitUpdaterInstallFlow(flow.options)).rejects.toThrow();
    await runExplicitUpdaterInstallFlow({ ...flow.options, updateReadyToInstall: true });
    expect(flow.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(flow.launchHelper).toHaveBeenCalledTimes(2);
    expect(flow.cancelHelper).toHaveBeenCalledOnce();
    expect(flow.handoff.hasPending()).toBe(false);
  });
});

describe("updater quit handoff", () => {
  it("rejects a synchronous quit failure and clears ownership", async () => {
    const handoff = createUpdaterQuitHandoff();
    await expect(handoff.requestQuit(() => { throw new Error("quit failed"); })).rejects.toThrow("quit failed");
    expect(handoff.hasPending()).toBe(false);
  });

  it("rejects an overlapping request without stealing the original completion", async () => {
    const handoff = createUpdaterQuitHandoff();
    const originalQuit = vi.fn();
    const overlappingQuit = vi.fn();
    const original = handoff.requestQuit(originalQuit);

    await expect(handoff.requestQuit(overlappingQuit)).rejects.toThrow("already pending");
    expect(originalQuit).toHaveBeenCalledOnce();
    expect(overlappingQuit).not.toHaveBeenCalled();
    expect(handoff.hasPending()).toBe(true);

    handoff.complete();
    await original;
    expect(handoff.hasPending()).toBe(false);
  });

  it("settles cancellation once and accepts a subsequent request", async () => {
    const handoff = createUpdaterQuitHandoff();
    const first = handoff.requestQuit(() => undefined);
    expect(handoff.hasPending()).toBe(true);
    const failure = expect(first).rejects.toThrow();
    handoff.cancelled();
    handoff.cancelled();
    await failure;
    const next = handoff.requestQuit(() => handoff.complete());
    await next;
    expect(handoff.hasPending()).toBe(false);
  });
});
