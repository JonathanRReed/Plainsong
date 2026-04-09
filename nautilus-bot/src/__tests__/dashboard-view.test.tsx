import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "@/components/views/dashboard-view";

const { askMemory, getRelationshipMemory } = vi.hoisted(() => ({
  askMemory: vi.fn(),
  getRelationshipMemory: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [
      {
        id: "project-1",
        name: "Default",
        createdAt: "2026-03-01T10:00:00.000Z",
        updatedAt: "2026-03-01T10:00:00.000Z",
        encrypted: false,
      },
    ],
  }),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => ({
    recordings: [
      {
        id: "rec-1",
        title: "ACME pricing review",
        projectId: "project-1",
        duration: 1800,
        createdAt: "2026-03-10T15:00:00.000Z",
        updatedAt: "2026-03-10T15:00:00.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/rec-1.wav",
        status: "completed",
      },
    ],
  }),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => ({
    dictationReady: true,
    meetingReady: true,
    loading: false,
  }),
}));

vi.mock("@/hooks/use-license-features", () => ({
  deriveEntitlement: () => ({
    proEnabled: true,
  }),
}));

vi.mock("@/lib/navigation", () => ({
  requestMainView: vi.fn(),
}));

vi.mock("@/lib/onboarding", () => ({
  requestOnboarding: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  analyzeRecordings: vi.fn(),
  askMemory,
  getRelationshipMemory,
  searchTranscripts: vi.fn(),
  validateLicense: vi.fn(async () => ({
    tier: "pro",
    valid: true,
    lsStatus: "active",
    activationsLimit: 1,
    activationsUsage: 1,
    lastValidatedAt: "2026-03-12T11:00:00.000Z",
    trialDaysRemaining: 0,
    nagRequired: false,
    trialActive: false,
  })),
}));

describe("DashboardView memory chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRelationshipMemory.mockResolvedValue({
      people: [
        {
          id: "person-1",
          name: "Jonathan Reed",
          recordingCount: 2,
          lastSeenAt: "2026-03-10T15:00:00.000Z",
          relatedCompanies: ["ACME"],
          recentMeetings: [
            {
              recordingId: "rec-1",
              recordingTitle: "ACME pricing review",
              createdAt: "2026-03-10T15:00:00.000Z",
              snippet: "Jonathan Reed pushed to keep pricing flat through Q3.",
            },
          ],
        },
      ],
      companies: [
        {
          id: "company-1",
          name: "ACME",
          recordingCount: 1,
          lastSeenAt: "2026-03-10T15:00:00.000Z",
          relatedPeople: ["Jonathan Reed"],
          recentMeetings: [
            {
              recordingId: "rec-1",
              recordingTitle: "ACME pricing review",
              createdAt: "2026-03-10T15:00:00.000Z",
              snippet: "ACME wants to hold pricing flat through Q3.",
            },
          ],
        },
      ],
    });
  });

  it("keeps follow-up memory questions in a local cross-meeting thread", async () => {
    askMemory
      .mockResolvedValueOnce({
        response: "You agreed to hold pricing at the current plan for Q3.",
        citations: [
          {
            recordingId: "rec-1",
            startTime: 32,
            endTime: 45,
            text: "Let's keep pricing flat through Q3 and revisit in October.",
          },
        ],
      })
      .mockResolvedValueOnce({
        response: "The open question was whether support should be bundled or sold separately.",
        citations: [
          {
            recordingId: "rec-1",
            startTime: 48,
            endTime: 60,
            text: "We still need to decide if premium support is included.",
          },
        ],
      });

    render(<DashboardView />);

    const memoryInput = await screen.findByPlaceholderText("Ask about your meetings...");
    fireEvent.change(memoryInput, { target: { value: "What did we decide about pricing?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("You agreed to hold pricing at the current plan for Q3.");
    expect(askMemory).toHaveBeenNthCalledWith(1, "What did we decide about pricing?");

    fireEvent.change(screen.getByPlaceholderText("Ask about your meetings..."), {
      target: { value: "What was still unresolved?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("The open question was whether support should be bundled or sold separately.");

    await waitFor(() => {
      expect(askMemory).toHaveBeenCalledTimes(2);
    });

    const secondPrompt = askMemory.mock.calls[1][0] as string;
    expect(secondPrompt).toContain("Conversation so far:");
    expect(secondPrompt).toContain("User: What did we decide about pricing?");
    expect(secondPrompt).toContain("Assistant: You agreed to hold pricing at the current plan for Q3.");
    expect(secondPrompt).toContain("New user question: What was still unresolved?");
    expect(screen.getByRole("button", { name: "Clear thread" })).toBeInTheDocument();
    expect(screen.getByText("Relationship Memory")).toBeInTheDocument();
    expect(screen.getByText("Jonathan Reed")).toBeInTheDocument();
    expect(screen.getByText("ACME")).toBeInTheDocument();
  });

  it("runs targeted memory prompts from relationship cards", async () => {
    askMemory.mockResolvedValue({
      response: "ACME cares about holding pricing flat while support packaging remains open.",
      citations: [],
    });

    render(<DashboardView />);

    await screen.findByText("Relationship Memory");
    fireEvent.click(screen.getAllByRole("button", { name: "Ask" })[1]);

    await waitFor(() => {
      expect(askMemory).toHaveBeenCalledTimes(1);
    });

    expect((askMemory.mock.calls[0][0] as string)).toContain("What have we learned about ACME across recent meetings?");
  });
});
