import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldShowNag } from "@/components/nag-modal";

const DISMISS_KEY = "nautilus_nag_dismissed_at";
const TRIAL_EXPIRED_KEY = "nautilus_trial_expired_at";
const NOW = new Date("2026-05-02T12:00:00Z");
const storage = new Map<string, string>();

function resetNagStorage() {
  storage.clear();
}

describe("shouldShowNag", () => {
  const originalLocalStorage = global.localStorage;
  const originalDateNow = Date.now;

  beforeEach(() => {
    resetNagStorage();
    global.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      length: 0,
      key: () => null,
    } as Storage;
    Date.now = () => NOW.getTime();
  });

  afterEach(() => {
    resetNagStorage();
    global.localStorage = originalLocalStorage;
    Date.now = originalDateNow;
  });

  it("shows immediately when the expired trial has never been dismissed", () => {
    expect(shouldShowNag()).toBe(true);
    expect(localStorage.getItem(TRIAL_EXPIRED_KEY)).toBe(String(NOW.getTime()));
  });

  it("snoozes for 24 hours during the first expired week", () => {
    localStorage.setItem(TRIAL_EXPIRED_KEY, String(NOW.getTime()));
    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 23 * 3_600_000));

    expect(shouldShowNag()).toBe(false);

    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 24 * 3_600_000));
    expect(shouldShowNag()).toBe(true);
  });

  it("snoozes for 12 hours after seven expired days", () => {
    localStorage.setItem(TRIAL_EXPIRED_KEY, String(NOW.getTime() - 7 * 86_400_000));
    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 11 * 3_600_000));

    expect(shouldShowNag()).toBe(false);

    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 12 * 3_600_000));
    expect(shouldShowNag()).toBe(true);
  });

  it("snoozes for 4 hours after fourteen expired days", () => {
    localStorage.setItem(TRIAL_EXPIRED_KEY, String(NOW.getTime() - 14 * 86_400_000));
    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 3 * 3_600_000));

    expect(shouldShowNag()).toBe(false);

    localStorage.setItem(DISMISS_KEY, String(NOW.getTime() - 4 * 3_600_000));
    expect(shouldShowNag()).toBe(true);
  });
});
