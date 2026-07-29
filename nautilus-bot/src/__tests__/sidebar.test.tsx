import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      dictationAi: { provider: "ollama", modelId: null },
      meetingsAi: { provider: "ollama", modelId: null },
      remoteProcessingEnabled: false,
    },
  })),
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button aria-label="Toggle theme" />,
}));

describe("Sidebar collapsed layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes every primary, secondary, and more navigation item", async () => {
    const onViewChange = vi.fn();

    render(
      <Sidebar
        activeView="dashboard"
        onToggleCollapse={vi.fn()}
        onViewChange={onViewChange}
      />,
    );

    // jsdom reports a non-mac platform, so labels use Ctrl.
    fireEvent.click(screen.getByRole("button", { name: /Dictation.*Ctrl\+D/ }));
    fireEvent.click(screen.getByRole("button", { name: /Meetings.*Ctrl\+Shift\+M/ }));
    fireEvent.click(screen.getByRole("button", { name: /Projects.*Ctrl\+P/ }));
    fireEvent.click(screen.getByRole("button", { name: /Settings.*Ctrl\+,/ }));

    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exports" })).not.toBeInTheDocument();

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Exports" }));

    expect(onViewChange).toHaveBeenNthCalledWith(1, "dictation");
    expect(onViewChange).toHaveBeenNthCalledWith(2, "recordings");
    expect(onViewChange).toHaveBeenNthCalledWith(3, "projects");
    expect(onViewChange).toHaveBeenNthCalledWith(4, "settings");
    expect(onViewChange).toHaveBeenNthCalledWith(5, "setup");
    expect(onViewChange).toHaveBeenNthCalledWith(6, "exports");
  });

  it("uses a plain navigation surface and moves the semantic current state", async () => {
    const { container, rerender } = render(
      <Sidebar
        activeView="dictation"
        onToggleCollapse={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    const dictation = screen.getByRole("button", { name: "Dictation" });
    const settings = screen.getByRole("button", { name: /Settings.*Ctrl\+,/ });

    expect(dictation).toHaveAttribute("aria-current", "page");
    expect(settings).not.toHaveAttribute("aria-current");
    expect(container.querySelector(".staff-bg")).not.toBeInTheDocument();

    rerender(
      <Sidebar
        activeView="settings"
        onToggleCollapse={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Dictation.*Ctrl\+D/ }),
      ).not.toHaveAttribute("aria-current");
      expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });

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

  it("exposes collapse and expand controls with stable labels", () => {
    const onToggleCollapse = vi.fn();
    const { rerender } = render(
      <Sidebar
        activeView="dashboard"
        onToggleCollapse={onToggleCollapse}
        onViewChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    rerender(
      <Sidebar
        activeView="dashboard"
        isCollapsed
        onToggleCollapse={onToggleCollapse}
        onViewChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });

  it("opens keyboard shortcut help from the collapsed rail", async () => {
    render(
      <Sidebar
        activeView="dashboard"
        isCollapsed
        onToggleCollapse={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Start dictation")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Dictation")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("makes the local processing status keyboard reachable and actionable", async () => {
    const onViewChange = vi.fn();

    render(
      <Sidebar
        activeView="dashboard"
        onToggleCollapse={vi.fn()}
        onViewChange={onViewChange}
      />,
    );

    const localStatus = await screen.findByRole("button", {
      name: /Local only\. Remote processing is disabled by policy\./,
    });

    fireEvent.click(localStatus);

    expect(onViewChange).toHaveBeenCalledWith("settings");
  });
});
