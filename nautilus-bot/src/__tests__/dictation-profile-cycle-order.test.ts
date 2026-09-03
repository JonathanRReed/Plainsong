import { describe, expect, it } from "vitest";
import {
  cycleDictationMode,
  dictationModeCycleOrder,
  DICTATION_MODE_CYCLE_ORDER,
  DICTATION_READY_MADE_STYLE_IDS,
} from "../../electron/dictation-bindings";
import {
  CODING_PROFILE_STYLE_ID,
  DICTATION_PROFILE_TILES,
  QUIET_PROFILE_STYLE_ID,
} from "@/lib/dictation-profiles";

/**
 * "Next profile" has to land on the row the user is looking at. The cycle
 * order lives in `electron/dictation-bindings.ts` (the main process cannot
 * import from `src/` — `tsconfig.electron.json` sets `rootDir: "electron"`),
 * and the tiles live in `src/lib/dictation-profiles.ts`. This file is the
 * seam: it can see both, so it is where drift gets caught.
 */
describe("the cycle order matches the visible profile tiles", () => {
  // The "Custom" tile is the builder for a new profile, not somewhere the
  // cycle can put you.
  const cycleableTiles = DICTATION_PROFILE_TILES.filter((tile) => tile.id !== "custom");

  it("walks every tile a user can be switched to, in tile order", () => {
    const expected = cycleableTiles.map((tile) =>
      tile.kind === "mode" ? tile.modeId : tile.styleId,
    );
    expect([...DICTATION_MODE_CYCLE_ORDER, ...DICTATION_READY_MADE_STYLE_IDS]).toEqual(
      expected,
    );
  });

  it("pins the ready-made style ids to the ones the tiles install", () => {
    expect([...DICTATION_READY_MADE_STYLE_IDS]).toEqual([
      CODING_PROFILE_STYLE_ID,
      QUIET_PROFILE_STYLE_ID,
    ]);
  });
});

describe("dictationModeCycleOrder", () => {
  const coding = { id: CODING_PROFILE_STYLE_ID, name: "Coding" };
  const quiet = { id: QUIET_PROFILE_STYLE_ID, name: "Quiet" };
  const mine = { id: "mine", name: "Standup Notes" };

  it("puts the ready-made styles where their tiles sit, not where they were saved", () => {
    // Saved list deliberately in the wrong order: a hand-rolled profile
    // first, then Quiet, then Coding.
    const order = dictationModeCycleOrder([mine, quiet, coding]);
    expect(order.map((entry) => entry.label)).toEqual([
      "General",
      "Slack & Chat",
      "Writing",
      "Notes",
      "Meeting Follow-up",
      "Coding",
      "Quiet",
      "Standup Notes",
    ]);
  });

  it("skips a ready-made style the user never installed", () => {
    expect(dictationModeCycleOrder([mine]).map((entry) => entry.label)).toEqual([
      "General",
      "Slack & Chat",
      "Writing",
      "Notes",
      "Meeting Follow-up",
      "Standup Notes",
    ]);
  });

  it("is exactly the walk cycleDictationMode takes, wrapping at the end", () => {
    const customModes = [mine, quiet, coding];
    const order = dictationModeCycleOrder(customModes);
    let current = { modePreset: order[0].modePreset, selectedCustomModeId: null as string | null };
    const walked = [order[0].label];
    for (let step = 1; step < order.length; step += 1) {
      const next = cycleDictationMode(current, customModes);
      walked.push(next.label);
      current = {
        modePreset: next.modePreset,
        selectedCustomModeId: next.selectedCustomModeId,
      };
    }
    expect(walked).toEqual(order.map((entry) => entry.label));
    // ...and one more step wraps to the first tile.
    expect(cycleDictationMode(current, customModes).label).toBe(order[0].label);
  });
});
