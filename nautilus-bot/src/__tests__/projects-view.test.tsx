import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectsView } from "@/components/views/projects-view";

const navigationMocks = vi.hoisted(() => ({
  requestMainView: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [
      {
        id: "project-1",
        name: "Client calls",
        description: "Discovery and follow-up conversations",
        createdAt: "2026-03-01T10:00:00.000Z",
        updatedAt: "2026-03-01T10:00:00.000Z",
        encrypted: false,
      },
    ],
    isLoading: false,
    error: null,
    createProject: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings: [
      {
        id: "rec-1",
        projectId: "project-1",
      },
    ],
  }),
}));

vi.mock("@/lib/navigation", () => navigationMocks);

describe("ProjectsView", () => {
  it("uses a real action instead of a dead interactive project card", () => {
    render(<ProjectsView />);

    expect(screen.getByText("Client calls")).toBeInTheDocument();
    expect(screen.queryByText("View recordings")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open meetings/i }));

    expect(navigationMocks.requestMainView).toHaveBeenCalledWith("recordings");
  });
});
