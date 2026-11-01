import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PARAKEET_UPGRADE_NOTICE,
  useParakeetUpgradeNotice,
} from "@/hooks/use-parakeet-upgrade-notice";

const settings = vi.hoisted(() => ({
  current: { transcription: { parakeetUpgradeNoticePending: true } } as {
    transcription: { parakeetUpgradeNoticePending?: boolean };
  },
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: vi.fn(async () => structuredClone(settings.current)),
  updateSettings: vi.fn(async (mutate: (draft: typeof settings.current) => void) => {
    const next = structuredClone(settings.current);
    mutate(next);
    settings.current = next;
  }),
}));

describe("the Parakeet v3 upgrade notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says once that Plainsong moved to the faster Parakeet v3, then clears the flag", async () => {
    settings.current = { transcription: { parakeetUpgradeNoticePending: true } };
    const toast = vi.fn();
    renderHook(() => useParakeetUpgradeNotice(toast));
    await waitFor(() => expect(settings.current.transcription.parakeetUpgradeNoticePending).toBe(false));
    expect(toast).toHaveBeenCalledExactlyOnceWith(PARAKEET_UPGRADE_NOTICE, "info");
    expect(PARAKEET_UPGRADE_NOTICE).toBe("Plainsong now uses the faster version of Parakeet v3.");

    // The next launch says nothing.
    const again = vi.fn();
    renderHook(() => useParakeetUpgradeNotice(again));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(again).not.toHaveBeenCalled();
  });

  it("says nothing when nothing moved", async () => {
    settings.current = { transcription: {} };
    const toast = vi.fn();
    renderHook(() => useParakeetUpgradeNotice(toast));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast).not.toHaveBeenCalled();
  });
});
