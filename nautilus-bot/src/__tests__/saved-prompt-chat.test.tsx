import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSavedPromptChat } from "@/components/prompts/use-saved-prompt-chat";
import { BUILTIN_SAVED_PROMPTS } from "@/lib/saved-prompts";
import type { Settings } from "@/types/settings";

const backendMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getSettings: backendMocks.getSettings,
  saveSettings: backendMocks.saveSettings,
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
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          chat.onInputKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") setSent((current) => [...current, value]);
        }}
      />
      {chat.picker}
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
    backendMocks.saveSettings.mockResolvedValue(undefined);
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

    await waitFor(() => expect(backendMocks.saveSettings).toHaveBeenCalled());
    const written = backendMocks.saveSettings.mock.calls[0][0] as Settings;
    const saved = written.ai?.savedPrompts ?? [];
    expect(
      saved.some((prompt) => prompt.prompt === "Who owns the migration?"),
    ).toBe(true);
    // Every starter is written back too, because order is now a stored fact.
    for (const builtin of BUILTIN_SAVED_PROMPTS) {
      expect(saved.some((prompt) => prompt.id === builtin.id)).toBe(true);
    }
  });
});
