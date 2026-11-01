import { afterEach, describe, expect, it, vi } from "vitest";
import { createMainWindowIdleController } from "../../electron/main-window-idle";
import { mainViewCanSuspend, rememberMainView, restoredMainView, registerMainWindowIdleGuard } from "@/lib/main-window-idle";

afterEach(() => { vi.useRealTimers(); localStorage.clear(); document.body.innerHTML = ""; });

function controller() {
  vi.useFakeTimers();
  const callbacks = {
    eligible: vi.fn(() => true),
    execute: vi.fn(async () => true),
    flushRendererDrafts: vi.fn(async () => true),
    destroy: vi.fn(),
    timeoutMs: 100,
  };
  return { callbacks, idle: createMainWindowIdleController(callbacks) };
}

describe("main window idle destruction", () => {
  it("waits the full hidden interval, checks safety twice and flushes before destroying", async () => {
    const { callbacks, idle } = controller();
    idle.hidden();
    await vi.advanceTimersByTimeAsync(99);
    expect(callbacks.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.execute).toHaveBeenCalledTimes(2);
    expect(callbacks.flushRendererDrafts).toHaveBeenCalledOnce();
    expect(callbacks.destroy).toHaveBeenCalledOnce();
    expect(callbacks.flushRendererDrafts.mock.invocationCallOrder[0]).toBeLessThan(callbacks.destroy.mock.invocationCallOrder[0]!);
    idle.cancel();
  });

  it.each(["unsafe", "failed-save", "changed-during-save", "busy", "missing-hook"])("retains the window when %s", async (reason) => {
    const { callbacks, idle } = controller();
    if (reason === "unsafe" || reason === "missing-hook") callbacks.execute.mockResolvedValue(false);
    if (reason === "failed-save") callbacks.flushRendererDrafts.mockResolvedValue(false);
    if (reason === "changed-during-save") callbacks.execute.mockResolvedValueOnce(true).mockResolvedValue(false);
    if (reason === "busy") callbacks.eligible.mockReturnValue(false);
    idle.hidden();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.destroy).not.toHaveBeenCalled();
    idle.cancel();
  });

  it("cancels a pending flush on show, even after another hide", async () => {
    const { callbacks, idle } = controller();
    let finish!: (value: boolean) => void;
    callbacks.flushRendererDrafts.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    idle.hidden();
    await vi.advanceTimersByTimeAsync(100);
    idle.cancel();
    idle.hidden();
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.destroy).toHaveBeenCalledOnce();
    idle.cancel();
  });

  it("retries a veto without focusing or discarding the hidden window", async () => {
    const { callbacks, idle } = controller();
    callbacks.execute.mockResolvedValueOnce(false);
    idle.hidden();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.destroy).toHaveBeenCalledOnce();
    idle.cancel();
  });

  it("requires the draft flush hook even when the idle hook says ready", async () => {
    const { callbacks, idle } = controller();
    callbacks.execute.mockImplementation(async (script?: string) =>
      new Function("window", `return (${script})`)({ __plainsongCanSuspend: () => true }));
    idle.hidden();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.flushRendererDrafts).not.toHaveBeenCalled();
    expect(callbacks.destroy).not.toHaveBeenCalled();
    idle.cancel();
  });
});

describe("renderer suspension safety", () => {
  it("restores only a known navigation view", () => {
    expect(rememberMainView("exports")).toBe(true);
    expect(restoredMainView()).toBe("exports");
    localStorage.setItem("plainsong-main-view", "unknown");
    expect(restoredMainView()).toBe("dictation");
  });

  it("keeps meeting editors, settings, projects and setup mounted", () => {
    document.body.innerHTML = '<div class="app-shell"><button aria-current="page"></button></div>';
    for (const view of ["recordings", "settings", "projects", "setup", "exports"] as const) expect(mainViewCanSuspend(view, document)).toBe(false);
    expect(mainViewCanSuspend("dictation", document)).toBe(true);
  });

  it("keeps a background operation mounted until its guard allows suspension", () => {
    document.body.innerHTML = '<div class="app-shell"><button aria-current="page"></button></div>';
    let busy = true;
    const unregister = registerMainWindowIdleGuard(() => !busy);
    try {
      expect(mainViewCanSuspend("dictation", document)).toBe(false);
      busy = false;
      expect(mainViewCanSuspend("dictation", document)).toBe(true);
    } finally { unregister(); }
  });

  it("keeps a focused text editor mounted", () => {
    document.body.innerHTML = '<div class="app-shell"><button aria-current="page"></button><textarea>Saved result</textarea></div>';
    document.querySelector("textarea")!.focus();
    expect(mainViewCanSuspend("dictation", document)).toBe(false);
  });

  it.each(['<div role="dialog"></div>', '<div role="alertdialog"></div>', '<div contenteditable="true"></div>', '<div aria-busy="true"></div>'])("retains an open editor or flow: %s", (html) => {
    document.body.innerHTML = '<div class="app-shell"><button aria-current="page"></button></div>' + html;
    expect(mainViewCanSuspend("dictation", document)).toBe(false);
  });
});
