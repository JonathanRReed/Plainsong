import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "@/components/views/dashboard-view";

const {
  analyzeRecordings,
  askMemory,
  getRelationshipMemory,
  searchTranscripts,
  requestMainView,
  requestOnboarding,
  dashboardState,
} = vi.hoisted(() => ({
  askMemory: vi.fn(),
  getRelationshipMemory: vi.fn(),
  analyzeRecordings: vi.fn(),
  searchTranscripts: vi.fn(),
  requestMainView: vi.fn(),
  requestOnboarding: vi.fn(),
  dashboardState: {
    setupStatus: {
      dictationReady: true as boolean,
      meetingReady: true as boolean,
      loading: false as boolean,
    },
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
    ] as Array<{
      id: string;
      title: string;
      projectId: string;
      duration: number;
      createdAt: string;
      updatedAt: string;
      sourceType: string;
      audioPath: string;
      status: string;
    }>,
  },
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
    recordings: dashboardState.recordings,
  }),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => dashboardState.setupStatus,
}));

vi.mock("@/lib/navigation", () => ({
  requestMainView,
}));

vi.mock("@/lib/onboarding", () => ({
  requestOnboarding,
}));

vi.mock("@/lib/backend/ai", () => ({
  analyzeRecordings,
  askMemory,
  getRelationshipMemory,
  searchTranscripts,
}));

describe("DashboardView memory chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardState.setupStatus = {
      dictationReady: true,
      meetingReady: true,
      loading: false,
    };
    dashboardState.recordings = [
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
    ];
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

  it("summarizes readiness and routes Home quick actions", async () => {
    render(<DashboardView />);

    expect(await screen.findByText("Everything is ready")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("0h")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start Dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Open dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Open meetings" }));
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    fireEvent.click(screen.getByRole("button", { name: /Dictation\s*Open/ }));
    fireEvent.click(screen.getByRole("button", { name: /Meetings\s*Open/ }));
    fireEvent.click(screen.getByRole("button", { name: /Local memory\s*Open/ }));

    expect(requestMainView).toHaveBeenNthCalledWith(1, "dictation");
    expect(requestMainView).toHaveBeenNthCalledWith(2, "dictation");
    expect(requestMainView).toHaveBeenNthCalledWith(3, "recordings");
    expect(requestMainView).toHaveBeenNthCalledWith(4, "setup");
    expect(requestMainView).toHaveBeenNthCalledWith(5, "dictation");
    expect(requestMainView).toHaveBeenNthCalledWith(6, "recordings");
    expect(requestMainView).toHaveBeenNthCalledWith(7, "settings");
  });

  it("sends readiness cards to onboarding when setup is incomplete", async () => {
    dashboardState.setupStatus = {
      dictationReady: false,
      meetingReady: false,
      loading: false,
    };

    render(<DashboardView />);

    expect(await screen.findByText("Finish setup to unlock the full solo workflow")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Dictation\s*Review/ }));
    fireEvent.click(screen.getByRole("button", { name: /Meetings\s*Review/ }));

    expect(requestOnboarding).toHaveBeenNthCalledWith(1, "dictation");
    expect(requestOnboarding).toHaveBeenNthCalledWith(2, "meetings");
  });

  it("shows recent recordings and opens the meetings workspace from the timeline", async () => {
    render(<DashboardView />);

    const recentRecording = await screen.findByRole("button", { name: /ACME pricing review/ });
    expect(recentRecording).toHaveTextContent("30:00");

    fireEvent.click(recentRecording);

    expect(requestMainView).toHaveBeenCalledWith("recordings");
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

  it("explains empty transcript search results and disabled analysis", async () => {
    searchTranscripts.mockResolvedValue([]);

    render(<DashboardView />);

    const searchInput = await screen.findByPlaceholderText(/Search every transcript/);
    fireEvent.change(searchInput, { target: { value: "nonexistent phrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText(/No transcript matches for "nonexistent phrase"/)).toBeInTheDocument();
    expect(
      screen.getByText(/Search transcripts first, then select one or more matching meetings to analyze/i)
    ).toBeInTheDocument();
  });
});
