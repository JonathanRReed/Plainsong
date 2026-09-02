import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  parseStoredActionItem,
  parseStoredActionItems,
} from "@/lib/action-items";
import { ActionItemList } from "@/components/views/meetings/action-item-list";

// These cases mirror the Rust suite in
// rust-sidecar/src/export/action_items.rs, which writes the same stored form.
describe("parseStoredActionItem", () => {
  it("reads an owner and a due date back out of the stored line", () => {
    const parsed = parseStoredActionItem(
      "Send the deck (Owner: Jane · Due: Friday)"
    );
    expect(parsed.task).toBe("Send the deck");
    expect(parsed.owner).toBe("Jane");
    expect(parsed.dueDate).toBe("Friday");
    expect(parsed.text).toBe("Send the deck (Owner: Jane · Due: Friday)");
  });

  it("reads the owner-only and due-only forms", () => {
    const ownerOnly = parseStoredActionItem("Book the room (Owner: Sam)");
    expect(ownerOnly.task).toBe("Book the room");
    expect(ownerOnly.owner).toBe("Sam");
    expect(ownerOnly.dueDate).toBeNull();

    const dueOnly = parseStoredActionItem("Book the room (Due: 2026-09-05)");
    expect(dueOnly.owner).toBeNull();
    expect(dueOnly.dueDate).toBe("2026-09-05");
  });

  it("keeps a person's own parenthetical inside the task", () => {
    for (const text of [
      "Review the plan (draft two)",
      "Call the vendor (Owner: )",
      "Ship it (Owner: Al · Owner: Bo)",
      "Ship it (Owner: Al · Note: soon)",
      "(Owner: Nobody)",
      "Plain task",
    ]) {
      const parsed = parseStoredActionItem(text);
      expect(parsed.task, text).toBe(text.trim());
      expect(parsed.owner, text).toBeNull();
      expect(parsed.dueDate, text).toBeNull();
    }
  });

  it("skips blank lines when reading a list", () => {
    const items = parseStoredActionItems([
      "Send the deck (Owner: Jane · Due: Friday)",
      "   ",
      "Plain task",
    ]);
    expect(items).toHaveLength(2);
    expect(items[1].task).toBe("Plain task");
  });
});

describe("ActionItemList", () => {
  it("shows the task with its owner and date beside it, not inside it", () => {
    render(
      <ActionItemList
        items={[
          "Send the deck (Owner: Jane · Due: Friday)",
          "Plain follow-up",
        ]}
      />
    );

    expect(screen.getByText("Send the deck")).toBeTruthy();
    expect(screen.getByText("Owner: Jane")).toBeTruthy();
    expect(screen.getByText("Due: Friday")).toBeTruthy();
    expect(screen.getByText("Plain follow-up")).toBeTruthy();
    // The raw stored suffix is never shown as part of the sentence.
    expect(screen.queryByText(/\(Owner: Jane/)).toBeNull();
  });

  it("renders nothing when there is nothing saved", () => {
    const { container } = render(<ActionItemList items={["  "]} />);
    expect(container.firstChild).toBeNull();
  });
});
