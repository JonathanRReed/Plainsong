import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppCommandPalette } from "@/components/app-command-palette";
import { ToastProvider } from "@/components/toast";

const { requestMainView, transformSelectedText } = vi.hoisted(() => ({
  requestMainView: vi.fn(),
  transformSelectedText: vi.fn(),
}));

vi.mock("@/lib/navigation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/navigation")>(
    "@/lib/navigation",
  );
  return {
    ...actual,
    requestMainView,
  };
});

vi.mock("@/lib/backend", () => ({
  transformSelectedText,
}));

function renderPalette(open = true) {
  const onOpenChange = vi.fn();
  render(
    <ToastProvider>
      <AppCommandPalette open={open} onOpenChange={onOpenChange} />
    </ToastProvider>,
  );
  return { onOpenChange };
}

describe("AppCommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens and shows navigation and text-action entries", () => {
    renderPalette(true);

    expect(screen.getByPlaceholderText(/jump to a view/i)).toBeInTheDocument();
    expect(screen.getByText("Dictation")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Fix Spelling and Grammar")).toBeInTheDocument();
  });

  it("filters entries by search input", () => {
    renderPalette(true);

    const input = screen.getByPlaceholderText(/jump to a view/i);
    fireEvent.change(input, { target: { value: "Bulletize" } });

    expect(screen.getByText("Bulletize Selected Text")).toBeInTheDocument();
    expect(screen.queryByText("Meetings")).not.toBeInTheDocument();
  });

  it("navigates and closes the palette when a navigation entry is selected", () => {
    const { onOpenChange } = renderPalette(true);

    fireEvent.click(screen.getByText("Meetings"));

    expect(requestMainView).toHaveBeenCalledWith("recordings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs a selected-text action and shows a success toast", async () => {
    transformSelectedText.mockResolvedValue({
      commandKey: "bulletize_selection",
      inputText: "one two three",
      outputText: "- one\n- two\n- three",
      targetScope: "selection",
      pasted: true,
      confirmed: true,
      copied: false,
      usedAi: true,
    });

    renderPalette(true);

    fireEvent.click(screen.getByText("Bulletize Selected Text"));

    await waitFor(() => {
      expect(transformSelectedText).toHaveBeenCalledWith("bulletize_selection");
    });

    expect(await screen.findByText(/Bulletized selected text/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { hidden: true })).toHaveClass("border-l-gold");
  });

  it.each([false, undefined])(
    "shows an info toast for an unconfirmed Quick Fix: %s",
    async (confirmed) => {
      transformSelectedText.mockResolvedValue({
        commandKey: "proofread_text",
        inputText: "teh text",
        outputText: "the text",
        targetScope: "selection",
        pasted: true,
        confirmed,
        copied: false,
        usedAi: true,
      });
      renderPalette(true);
      fireEvent.click(screen.getByText("Fix Spelling and Grammar"));

      expect(await screen.findByText(
        "Quick Fix sent to selected text. Check the target to confirm the change.",
      )).toBeInTheDocument();
      expect(screen.getByRole("status", { hidden: true })).toHaveClass("border-l-muted");
      expect(screen.getByRole("status", { hidden: true })).not.toHaveClass("border-l-gold");
    },
  );

  it("shows copied recovery in an info toast for an unconfirmed Quick Fix", async () => {
    transformSelectedText.mockResolvedValue({
      commandKey: "proofread_text",
      inputText: "teh text",
      outputText: "the text",
      targetScope: "focused_field",
      pasted: true,
      confirmed: false,
      copied: true,
      usedAi: true,
    });
    renderPalette(true);
    fireEvent.click(screen.getByText("Fix Spelling and Grammar"));

    expect(await screen.findByText(
      "Quick Fix sent to focused field. Check the target to confirm the change. Result is on the clipboard; paste it manually if needed.",
    )).toBeInTheDocument();
    expect(screen.getByRole("status", { hidden: true })).toHaveClass("border-l-muted");
  });

  it("shows an error toast when the action fails", async () => {
    transformSelectedText.mockRejectedValue(new Error("backend unavailable"));

    renderPalette(true);

    fireEvent.click(screen.getByText("Fix Spelling and Grammar"));

    expect(
      await screen.findByText(/Could not run action: backend unavailable/i),
    ).toBeInTheDocument();
  });
});
