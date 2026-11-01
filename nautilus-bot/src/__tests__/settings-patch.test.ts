import { describe, expect, it } from "vitest";
import { applySettingsPatch, diffSettings, editSettings, mergeSettingsPatches } from "@/lib/settings-patch";

describe("settings changes", () => {
  it("records equal-value assignments and deletions while preserving concurrent clean fields", () => {
    const before = { keep: false, route: { model: null }, names: ["en"] };
    const changes = editSettings(before, (draft) => {
      draft.keep = false;
      draft.route.model = null;
      draft.names.push("fr");
    });
    const concurrent = { keep: true, route: { model: "other", provider: "local" }, names: ["en"], theme: "dark" };
    expect(applySettingsPatch(concurrent, changes)).toEqual({
      keep: false, route: { model: null, provider: "local" }, names: ["en", "fr"], theme: "dark",
    });
    expect(before).toEqual({ keep: false, route: { model: null }, names: ["en"] });
    const map: Record<string, string> = {};
    const remove = editSettings({ map }, (draft) => { delete draft.map.old; });
    expect(applySettingsPatch({ map: { old: "late", new: "keep" } }, remove)).toEqual({ map: { new: "keep" } });
  });

  it("records the final value of a replaced parent without invalid child operations", () => {
    const initial: { route: { model: string } | null } = { route: null };
    const changes = editSettings(initial, (draft) => {
      draft.route = { model: "initial" };
      draft.route.model = "new";
      draft.route = null;
    });
    expect(changes.operations).toEqual([{ op: "set", path: ["route"], value: null }]);
    expect(applySettingsPatch({ route: { model: "concurrent" } }, changes)).toEqual({ route: null });
  });

  it("rebases only edited fields and retains false, null, removals and arrays", () => {
    const before = { keepAudio: true, language: "en", models: { old: "model" }, languages: ["en"] };
    const after = { keepAudio: false, language: null, models: {}, languages: ["fr", "de"] };
    const current = { ...before, unrelated: "newer", models: { ...before.models, recent: "latest" } };
    expect(applySettingsPatch(current, diffSettings(before, after))).toEqual({
      ...after, unrelated: "newer", models: { recent: "latest" },
    });
    expect(current).toEqual({ ...before, unrelated: "newer", models: { old: "model", recent: "latest" } });
  });

  it("keeps the final off action when the saved baseline was also off", () => {
    const off = { audio: { keep: false }, theme: "light" };
    const on = { ...off, audio: { keep: true } };
    const changes = mergeSettingsPatches(diffSettings(off, on), diffSettings(on, off));
    expect(applySettingsPatch({ ...on, theme: "dark" }, changes)).toEqual({
      audio: { keep: false }, theme: "dark",
    });
    expect(changes.operations).toHaveLength(1);
  });

  it("retains parent initialization before child edits and drops overwritten children", () => {
    const initialized = { route: { provider: "local", model: "old" } };
    const changed = { route: { provider: "local", model: "new" } };
    const changes = mergeSettingsPatches(diffSettings({}, initialized), diffSettings(initialized, changed));
    expect(applySettingsPatch({}, changes)).toEqual(changed);
    const cleared = mergeSettingsPatches(changes, diffSettings(changed, { route: null }));
    expect(applySettingsPatch({}, cleared)).toEqual({ route: null });
    expect(cleared.operations).toHaveLength(1);
  });

  it("removes absent fields repeatedly without traversing inherited properties", () => {
    const removal = diffSettings({ nested: { old: true } }, { nested: {} });
    expect(applySettingsPatch({}, removal)).toEqual({});
    const first = applySettingsPatch({ nested: { old: true } }, removal);
    expect(applySettingsPatch(first, removal)).toEqual({ nested: {} });
    const unsafe: object = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"bad":true}}');
    const updated = applySettingsPatch({}, diffSettings({}, unsafe));
    expect(Object.getPrototypeOf(updated)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.keys(updated)).toEqual(["__proto__", "constructor"]);
  });

  it("freezes source values and treats undefined as an omitted JSON key", () => {
    const after = { active: ["en"], omitted: undefined };
    const changes = diffSettings({}, after);
    after.active.push("fr");
    expect(applySettingsPatch({}, changes)).toEqual({ active: ["en"] });
    const target = { active: ["de"], omitted: true };
    expect(applySettingsPatch(target, diffSettings(target, after))).toEqual({ active: ["en", "fr"] });
  });

  it("fails atomically when the new canonical parent is no longer an object", () => {
    const changes = diffSettings({ theme: "light", route: { model: "old" } }, { theme: "dark", route: { model: "new" } });
    const current = { theme: "light", route: null };
    expect(() => applySettingsPatch(current, changes)).toThrow("parent must be an object");
    expect(current).toEqual({ theme: "light", route: null });
  });
});
