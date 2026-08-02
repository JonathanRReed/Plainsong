import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_MAIN_VIEW_EVENT,
  OPEN_SETTINGS_TAB_EVENT,
  consumePendingSettingsTab,
  requestReadinessDestination,
} from "@/lib/navigation";

describe("readiness navigation", () => {
  afterEach(() => {
    consumePendingSettingsTab();
  });

  it("opens the exact model settings destination and parks it for lazy loading", () => {
    const mainViewListener = vi.fn();
    const settingsTabListener = vi.fn();
    window.addEventListener(OPEN_MAIN_VIEW_EVENT, mainViewListener);
    window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settingsTabListener);

    requestReadinessDestination("models");

    expect(mainViewListener).toHaveBeenCalledTimes(1);
    expect(
      (mainViewListener.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toEqual({ view: "settings" });
    expect(
      (settingsTabListener.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toEqual({ tab: "models" });
    expect(consumePendingSettingsTab()).toBe("models");
    expect(consumePendingSettingsTab()).toBeNull();

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, mainViewListener);
    window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settingsTabListener);
  });

  it("opens guided setup directly for permission repair", () => {
    const mainViewListener = vi.fn();
    window.addEventListener(OPEN_MAIN_VIEW_EVENT, mainViewListener);

    requestReadinessDestination("setup");

    expect(
      (mainViewListener.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toEqual({ view: "setup" });
    expect(consumePendingSettingsTab()).toBeNull();

    window.removeEventListener(OPEN_MAIN_VIEW_EVENT, mainViewListener);
  });
});
