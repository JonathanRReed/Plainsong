import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SavedPromptManagerDialog } from "@/components/prompts/saved-prompt-manager-dialog";
import {
  BUILTIN_SAVED_PROMPTS,
  resolveSavedPrompts,
  type SavedPrompt,
} from "@/lib/saved-prompts";

function renderDialog(stored: SavedPrompt[] = []) {
  const onPersist = vi.fn().mockReturnValue(true);
  const prompts = resolveSavedPrompts(stored);
  render(
    <SavedPromptManagerDialog
      open
      onOpenChange={() => {}}
      prompts={prompts}
      onPersist={onPersist}
    />,
  );
  return { onPersist, prompts };
}

const FIRST_BUILTIN = BUILTIN_SAVED_PROMPTS[0];

describe("SavedPromptManagerDialog", () => {
  it("lists the starters and marks them built in", () => {
    renderDialog();
    expect(screen.getByText(FIRST_BUILTIN.name)).toBeTruthy();
    expect(screen.getAllByText(/built in/).length).toBe(
      BUILTIN_SAVED_PROMPTS.length,
    );
  });

  it("offers hide but never delete on a built-in prompt", () => {
    renderDialog();
    expect(screen.getByLabelText(`Hide ${FIRST_BUILTIN.name}`)).toBeTruthy();
    expect(screen.queryByLabelText(`Delete ${FIRST_BUILTIN.name}`)).toBeNull();
  });

  it("hides a built-in rather than removing it, and can bring it back", async () => {
    const { onPersist } = renderDialog();
    fireEvent.click(screen.getByLabelText(`Hide ${FIRST_BUILTIN.name}`));

    await waitFor(() => expect(onPersist).toHaveBeenCalled());
    const written = onPersist.mock.calls[0][0] as SavedPrompt[];
    const hidden = written.find((prompt) => prompt.id === FIRST_BUILTIN.id);
    expect(hidden?.hidden).toBe(true);
    expect(written).toHaveLength(BUILTIN_SAVED_PROMPTS.length);
  });

  it("adds a new prompt through the editor", async () => {
    const { onPersist } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /New prompt/ }));

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Budget asks" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Who asked for money?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() => expect(onPersist).toHaveBeenCalled());
    const written = onPersist.mock.calls[0][0] as SavedPrompt[];
    const added = written.find((prompt) => prompt.name === "Budget asks");
    expect(added?.prompt).toBe("Who asked for money?");
    expect(added?.builtIn).toBe(false);
  });

  it("edits a built-in in place, keeping its id so it stays an override", async () => {
    const { onPersist } = renderDialog();
    fireEvent.click(screen.getByLabelText(`Edit ${FIRST_BUILTIN.name}`));

    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Only the decisions I made." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() => expect(onPersist).toHaveBeenCalled());
    const written = onPersist.mock.calls[0][0] as SavedPrompt[];
    const edited = written.find((prompt) => prompt.id === FIRST_BUILTIN.id);
    expect(edited?.prompt).toBe("Only the decisions I made.");
    expect(edited?.builtIn).toBe(true);
    expect(written).toHaveLength(BUILTIN_SAVED_PROMPTS.length);
  });

  it("deletes a user prompt only after the confirmation step", async () => {
    const mine: SavedPrompt = {
      id: "mine-1",
      name: "Budget asks",
      prompt: "Who asked for money?",
      scope: "memory",
    };
    const { onPersist } = renderDialog([mine]);

    fireEvent.click(screen.getByLabelText("Delete Budget asks"));
    expect(onPersist).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(onPersist).toHaveBeenCalled());
    const written = onPersist.mock.calls[0][0] as SavedPrompt[];
    expect(written.some((prompt) => prompt.id === "mine-1")).toBe(false);
  });

  it("reorders by writing the whole list back, starters included", async () => {
    const mine: SavedPrompt = {
      id: "mine-1",
      name: "Budget asks",
      prompt: "Who asked for money?",
      scope: "memory",
    };
    const { onPersist } = renderDialog([mine]);

    fireEvent.click(screen.getByLabelText("Move Budget asks down"));
    await waitFor(() => expect(onPersist).toHaveBeenCalled());
    const written = onPersist.mock.calls[0][0] as SavedPrompt[];
    expect(written[0].id).toBe(FIRST_BUILTIN.id);
    expect(written[1].id).toBe("mine-1");
    expect(written).toHaveLength(BUILTIN_SAVED_PROMPTS.length + 1);
  });
});
