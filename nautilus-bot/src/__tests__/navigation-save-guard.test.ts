import { describe, expect, it, vi } from "vitest";
import { canLeaveMainView, registerViewLeaveGuard } from "@/lib/navigation";

describe("workspace save guards", () => {
  it("waits for a save and unregisters with its editor", async () => {
    let finish!: (saved: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const unregister = registerViewLeaveGuard("recordings", guard);
    try {
      let settled = false;
      const leaving = canLeaveMainView("recordings").then((allowed) => { settled = true; return allowed; });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish(true);
      expect(await leaving).toBe(true);
    } finally { unregister(); }
    expect(await canLeaveMainView("recordings")).toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed draft in its workspace without blocking other views", async () => {
    const unregister = registerViewLeaveGuard("recordings", async () => false);
    try {
      expect(await canLeaveMainView("recordings")).toBe(false);
      expect(await canLeaveMainView("dictation")).toBe(true);
    } finally { unregister(); }
  });
});
