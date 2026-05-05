import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/sidebar";

vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => ({
    isRecording: false,
    formattedDuration: "0:00",
    recordingMode: "dictation",
  }),
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: vi.fn(async () => ({
    privacy: {
      llmProvider: "ollama",
      remoteProcessingEnabled: false,
    },
  })),
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button aria-label="Toggle theme" />,
}));

describe("Sidebar collapsed layout", () => {
  it("renders a stable icon rail with accessible controls", async () => {
    render(
      <Sidebar
        activeView="dashboard"
        isCollapsed
        onToggleCollapse={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dictation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Meetings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Projects" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exports" })).toBeInTheDocument();
    expect(screen.getByText("Voice workspace").closest("div")).toHaveClass(
      "hidden",
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Toggle theme")).toBeInTheDocument();
    });
  });
});
