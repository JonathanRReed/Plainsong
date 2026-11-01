import { expect, it, vi } from "vitest";
import { selectNotePublishLocation } from "@/lib/backend/publishing";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/electron", () => ({ invoke }));
it("requests notes-only approval from the native picker without a renderer path", async () => {
  invoke.mockResolvedValue({ id: "approved", label: "Notes", approved: true });
  await selectNotePublishLocation();
  expect(invoke).toHaveBeenCalledWith("select_export_location", { forNotes: true });
});
