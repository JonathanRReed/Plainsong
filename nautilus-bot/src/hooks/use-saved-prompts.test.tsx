import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSavedPrompts } from "./use-saved-prompts";
import type { SavedPrompt } from "@/lib/saved-prompts";

const transport = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSavedPrompts: vi.fn(),
}));

vi.mock("@/lib/backend/settings", () => transport);

beforeEach(() => vi.resetAllMocks());

it("refuses a write until the existing library has loaded", async () => {
  const existing: SavedPrompt = { id: "existing", name: "Prior", prompt: "Prior text", scope: "both" };
  let finishLoad = () => {};
  transport.getSettings.mockReturnValueOnce(new Promise((resolve) => {
    finishLoad = () => resolve({ ai: { savedPrompts: [existing] } });
  }));
  const { result } = renderHook(() => useSavedPrompts());
  await act(async () => { expect(await result.current.persist([])).toBe(false); });
  expect(transport.setSavedPrompts).not.toHaveBeenCalled();
  expect(result.current.saveError).toBe("Load your saved prompts before making changes.");
  await act(async () => { finishLoad(); });
  expect(result.current.loaded).toBe(true);
  expect(result.current.prompts[0]).toEqual({ ...existing, builtIn: false, hidden: false });
  transport.setSavedPrompts.mockResolvedValueOnce([existing]);
  await act(async () => { expect(await result.current.persist([existing])).toBe(true); });
  expect(transport.setSavedPrompts).toHaveBeenCalledExactlyOnceWith([existing]);
});

it("keeps a saved prompt when an older reload finishes", async () => {
  const saved: SavedPrompt = { id: "mine", name: "Decisions", prompt: "What did we decide?", scope: "meeting" };
  transport.getSettings.mockResolvedValue({ ai: { savedPrompts: [] } });
  const { result } = renderHook(() => useSavedPrompts());
  await waitFor(() => expect(result.current.loaded).toBe(true));
  let finishSave = () => {};
  transport.setSavedPrompts.mockReturnValueOnce(new Promise((resolve) => {
    finishSave = () => resolve([saved]);
  }));
  let saving: Promise<boolean> = Promise.resolve(false);
  act(() => { saving = result.current.persist([saved]); });
  let finishLoad = () => {};
  transport.getSettings.mockReturnValueOnce(new Promise((resolve) => {
    finishLoad = () => resolve({ ai: { savedPrompts: [] } });
  }));
  let reloading: Promise<void> | undefined;
  act(() => { reloading = result.current.reload(); });
  await act(async () => { finishSave(); expect(await saving).toBe(true); });
  expect(result.current.prompts[0]).toEqual({ ...saved, builtIn: false, hidden: false });
  await act(async () => { finishLoad(); await reloading; });
  expect(result.current.prompts[0]).toEqual({ ...saved, builtIn: false, hidden: false });
  expect(result.current.loaded).toBe(true);
});

it("uses the canonical setter result and retains the library on failure", async () => {
  const prior: SavedPrompt = { id: "prior", name: "Prior", prompt: "Prior text", scope: "both" };
  transport.getSettings.mockResolvedValue({ ai: { savedPrompts: [prior] } });
  const { result } = renderHook(() => useSavedPrompts());
  await waitFor(() => expect(result.current.loaded).toBe(true));
  transport.setSavedPrompts.mockResolvedValueOnce([{ ...prior, name: "Canonical" }]);
  await act(async () => { expect(await result.current.persist([prior])).toBe(true); });
  expect(result.current.prompts[0].name).toBe("Canonical");
  transport.setSavedPrompts.mockRejectedValueOnce(new Error("Read only"));
  await act(async () => { expect(await result.current.persist([])).toBe(false); });
  expect(result.current.prompts[0].name).toBe("Canonical");
  expect(result.current.saveError).toBe("Read only");
  expect(transport.getSettings).toHaveBeenCalledOnce();
});
