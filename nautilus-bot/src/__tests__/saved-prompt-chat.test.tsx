import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSavedPromptChat } from "@/components/prompts/use-saved-prompt-chat";
import { BUILTIN_SAVED_PROMPTS } from "@/lib/saved-prompts";
import type { SavedPrompt } from "@/lib/saved-prompts";
import type { Settings } from "@/types/settings";

const backendMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSavedPrompts: vi.fn<(prompts: readonly SavedPrompt[]) => Promise<SavedPrompt[]>>(),
}));

vi.mock("@/lib/backend", () => ({
  getSettings: backendMocks.getSettings,
  setSavedPrompts: backendMocks.setSavedPrompts,
}));

function settingsWith(savedPrompts: Settings["ai"] extends undefined ? never : NonNullable<Settings["ai"]>["savedPrompts"]) {
  return { ai: { savedPrompts } } as unknown as Settings;
}

/**
 * A stand-in for either chat box: an input plus whatever the hook renders.
 * The two real surfaces differ only in scope and in the send button.
 */
function ChatHarness({ scope }: { scope: "meeting" | "memory" }) {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const chat = useSavedPromptChat({
    scope,
    inputValue: value,
    onPickPrompt: setValue,
    label: "Saved prompts",
  });

  return (
    <div>
      {chat.manager}
      <input
        aria-label="Ask"
        {...chat.inputProps}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          chat.onInputKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") setSent((current) => [...current, value]);
        }}
      />
      {chat.picker}
      {/* Both real surfaces refuse to send while the picker is open --
          `ai-analysis-panel.tsx` and `dashboard-view.tsx` both return early on
          `pickerOpen` -- so the harness has to as well, or it cannot show the
          bug where a question starting with a path could not be sent. */}
      <button
        type="button"
        onClick={() => {
          if (chat.pickerOpen) return;
          setSent((current) => [...current, value]);
        }}
      >
        Send
      </button>
      <button type="button" onClick={() => chat.saveTextAsPrompt("Who owns the migration?")}>
        Save as prompt
      </button>
      <p data-testid="sent">{sent.join("|")}</p>
    </div>
  );
}

describe("the saved prompt picker in a chat box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendMocks.getSettings.mockResolvedValue(
      settingsWith([
        {
          id: "meeting-only",
          name: "Follow-up draft",
          prompt: "Draft the follow-up.",
          scope: "meeting",
        },
        {
          id: "memory-only",
          name: "Budget asks",
          prompt: "Who asked for money?",
          scope: "memory",
        },
      ]),
    );
    backendMocks.setSavedPrompts.mockImplementation(async (prompts) => [...prompts]);
  });

  it("stays closed until the reader types a leading slash", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());

    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Ask"), {
      target: { value: "what was the 50/50 split" },
    });
    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/" } });
    expect(screen.getByRole("group", { name: "Saved prompts" })).toBeTruthy();
  });

  it("offers only the prompts scoped to this surface", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/" } });

    const picker = screen.getByRole("group", { name: "Saved prompts" });
    expect(within(picker).getByText("Follow-up draft")).toBeTruthy();
    expect(within(picker).queryByText("Budget asks")).toBeNull();
    // Both-scoped starters are still offered.
    expect(within(picker).getByText("Decisions made")).toBeTruthy();
  });

  it("filters as the reader keeps typing after the slash", async () => {
    render(<ChatHarness scope="memory" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/budget" } });

    const picker = screen.getByRole("group", { name: "Saved prompts" });
    expect(within(picker).getByText("Budget asks")).toBeTruthy();
    expect(within(picker).queryByText("Decisions made")).toBeNull();
  });

  it("fills the input with the chosen prompt instead of sending the slash query", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    const input = screen.getByLabelText("Ask") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "/follow" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("Draft the follow-up.");
    expect(screen.getByTestId("sent").textContent).toBe("");
    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();
  });

  it("closes on Escape and leaves the typed text alone", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    const input = screen.getByLabelText("Ask") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "/dec" } });
    expect(screen.getByRole("group", { name: "Saved prompts" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();
    expect(input.value).toBe("/dec");
  });

  /**
   * The trigger is any leading "/", which is also how a path is written. This
   * used to leave the reader unable to ask the question at all: the picker
   * stayed open over an empty list, Enter chose nothing, and both surfaces
   * refuse to send while it is open.
   */
  it("closes and unblocks Send when nothing matches what was typed", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    const input = screen.getByLabelText("Ask") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("group", { name: "Saved prompts" })).toBeTruthy();

    fireEvent.change(input, {
      target: { value: "/Users/me/notes.txt is failing to import" },
    });
    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("sent").textContent).toBe(
      "/Users/me/notes.txt is failing to import",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("sent").textContent).toBe(
      "/Users/me/notes.txt is failing to import|/Users/me/notes.txt is failing to import",
    );
  });

  it("reopens when the reader backspaces to something that does match", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    const input = screen.getByLabelText("Ask") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "/follow-up-xyz" } });
    expect(screen.queryByRole("group", { name: "Saved prompts" })).toBeNull();

    fireEvent.change(input, { target: { value: "/follow" } });
    expect(screen.getByRole("group", { name: "Saved prompts" })).toBeTruthy();
  });

  it("tells the reader how to close it", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/" } });

    const picker = screen.getByRole("group", { name: "Saved prompts" });
    expect(within(picker).getByText(/Esc closes this/)).toBeTruthy();
  });

  it.each(["delayed load", "failed load and retry"])("preserves the saved library and seeded prompt after %s", async (mode) => {
    let finishLoad = (_settings: Settings) => {};
    const pending = new Promise<Settings>((resolve) => { finishLoad = resolve; });
    if (mode === "failed load and retry") {
      backendMocks.getSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
      backendMocks.getSettings.mockReturnValueOnce(pending);
    } else {
      backendMocks.getSettings.mockReturnValueOnce(pending);
    }
    render(<ChatHarness scope="meeting" />);
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/" } });
    const starter = BUILTIN_SAVED_PROMPTS.find((prompt) => prompt.scope !== "memory");
    if (!starter) throw new Error("Expected a meeting starter");
    fireEvent.click(screen.getByText(starter.name));
    expect(screen.getByLabelText("Ask")).toHaveValue(starter.prompt);
    fireEvent.click(screen.getByRole("button", { name: "Save as prompt" }));
    if (mode === "failed load and retry") {
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load saved prompts.");
      expect(screen.queryByRole("button", { name: "Save prompt" })).not.toBeInTheDocument();
      expect(backendMocks.setSavedPrompts).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    }
    expect(await screen.findByRole("status")).toHaveTextContent("Loading saved prompts…");
    expect(screen.queryByRole("button", { name: "Save prompt" })).not.toBeInTheDocument();
    expect(backendMocks.setSavedPrompts).not.toHaveBeenCalled();
    const existing: SavedPrompt = { id: "existing", name: "My saved question", prompt: "What remains open?", scope: "both" };
    await act(async () => { finishLoad(settingsWith([existing])); });
    expect(await screen.findByLabelText("Name")).toHaveValue("Who owns the migration?");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Who owns the migration?");
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(backendMocks.setSavedPrompts).toHaveBeenCalledOnce());
    expect(backendMocks.setSavedPrompts.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining(existing),
      expect.objectContaining({ name: "Who owns the migration?", prompt: "Who owns the migration?", scope: "meeting" }),
      ...BUILTIN_SAVED_PROMPTS.map((prompt) => expect.objectContaining({ id: prompt.id })),
    ]));
  });

  it("opens the manage dialog on a new prompt seeded from a sent message", async () => {
    render(<ChatHarness scope="meeting" />);
    await waitFor(() => expect(backendMocks.getSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Save as prompt" }));

    const nameField = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(nameField.value).toBe("Who owns the migration?");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Who owns the migration?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() => expect(backendMocks.setSavedPrompts).toHaveBeenCalledOnce());
    const saved = backendMocks.setSavedPrompts.mock.calls[0][0];
    expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "Who owns the migration?",
      prompt: "Who owns the migration?",
      scope: "meeting",
      builtIn: false,
    })]));
    // Every starter is written back too, because order is now a stored fact.
    for (const builtin of BUILTIN_SAVED_PROMPTS) {
      expect(saved.some((prompt) => prompt.id === builtin.id)).toBe(true);
    }
  });
});

it("announces arrow selection through the question combobox and opens Manage by keyboard", async () => {
  backendMocks.getSettings.mockResolvedValue(settingsWith([...BUILTIN_SAVED_PROMPTS]));
  render(<ChatHarness scope="meeting" />);
  fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "/" } });
  const input = await screen.findByRole("combobox");
  const list = await screen.findByRole("listbox", { name: "Saved prompts" });
  expect(input).toHaveAttribute("aria-controls", list.id);
  const before = input.getAttribute("aria-activedescendant");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const after = input.getAttribute("aria-activedescendant");
  expect(after).not.toBe(before);
  expect(document.getElementById(after!)).toHaveAttribute("aria-selected", "true");
  screen.getByRole("button", { name: "Manage" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
