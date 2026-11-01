import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "@/components/views/meetings/markdown-text";

const RECAP = [
  "Topics: memory gate, export report.",
  "",
  "### Decisions",
  "- Priya (0:12): “We agreed to ship the beta on the 14th if the memory gate passes.”",
  "",
  "### Action items",
  "- Leo (1:02): “I'll send the export report by Tuesday after I rerun the 3 failing checks.”",
  "- 2:40: “I won't migrate any data until Ben approves the appendix.”",
].join("\n");

describe("MarkdownText quoted recap", () => {
  it("shows each source sentence as a quote with its speaker and time", () => {
    render(<MarkdownText value={RECAP} />);
    expect(screen.getByRole("heading", { name: "Decisions" })).toBeInTheDocument();
    const decision = screen.getByText(
      "“We agreed to ship the beta on the 14th if the memory gate passes.”",
    );
    expect(decision.tagName).toBe("BLOCKQUOTE");
    const item = decision.closest("li")!;
    expect(within(item).getByText("Priya")).toBeInTheDocument();
    expect(within(item).getByText("0:12")).toBeInTheDocument();
    // An unnamed speaker keeps the time alone.
    const unnamed = screen.getByText("“I won't migrate any data until Ben approves the appendix.”").closest("li")!;
    expect(within(unnamed).getByText("2:40")).toBeInTheDocument();
    expect(within(unnamed).queryByText("·", { exact: false })).toBeNull();
    expect(screen.getByText("Topics")).toBeInTheDocument();
    expect(screen.getByText("memory gate, export report.")).toBeInTheDocument();
  });

  it("keeps an ordinary bullet list as a list", () => {
    const { container } = render(<MarkdownText value={"- Ship the beta\n- Priya (0:12): “Quoted.”"} />);
    expect(screen.getByText("Ship the beta").closest("li")).not.toBeNull();
    expect(container.querySelector("blockquote")).toBeNull();
  });
});
