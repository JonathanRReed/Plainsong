import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "@/components/views/dashboard-view";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";

const {
  analyzeRecordings,
  askMemory,
  getRelationshipMemory,
  searchTranscripts,
  requestMainView,
  requestRecordingWorkspace,
  requestOnboarding,
  getSettings,
  dashboardState,
} = vi.hoisted(() => ({
  getSettings: vi.fn(),
  askMemory: vi.fn(),
  getRelationshipMemory: vi.fn(),
  analyzeRecordings: vi.fn(),
  searchTranscripts: vi.fn(),
  requestMainView: vi.fn(),
  requestRecordingWorkspace: vi.fn(),
  requestOnboarding: vi.fn(),
  dashboardState: {
    setupStatus: {
      dictationReady: true as boolean,
      meetingReady: true as boolean,
      fullCaptureReady: true as boolean,
      loading: false as boolean,
      productReadiness: {
        evidenceObservedAt: 1,
        dictation: { domain: "dictation", state: "ready", cause: null },
        meetings: { domain: "meetings", state: "ready", cause: null },
        meetingsCapture: {
          domain: "meetings_capture",
          state: "ready",
          cause: null,
        },
        fullCapture: { domain: "full_capture", state: "ready", cause: null },
        overall: { domain: "overall", state: "ready", cause: null },
      } as ProductReadinessSnapshot,
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

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => dashboardState.setupStatus,
}));

vi.mock("@/lib/navigation", () => ({
  requestMainView,
  requestRecordingWorkspace,
}));

vi.mock("@/lib/onboarding", () => ({
  requestOnboarding,
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings,
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
      fullCaptureReady: true,
      loading: false,
      productReadiness: {
        evidenceObservedAt: 1,
        dictation: { domain: "dictation", state: "ready", cause: null },
        meetings: { domain: "meetings", state: "ready", cause: null },
        meetingsCapture: {
          domain: "meetings_capture",
          state: "ready",
          cause: null,
        },
        fullCapture: { domain: "full_capture", state: "ready", cause: null },
        overall: { domain: "overall", state: "ready", cause: null },
      },
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
    getSettings.mockResolvedValue({
      shortcuts: { toggleDictation: "Alt+Space" },
      transcription: { dictationPushToTalk: true, dictationHandsFreeEnabled: false },
    });
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
    expect(screen.getByText("Stored on this Mac")).toBeInTheDocument();
    expect(screen.getByText("30 min")).toBeInTheDocument();
    // Everything is ready, so there is no setup nudge to repeat the sidebar.
    expect(screen.queryByRole("button", { name: "Finish setup" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Open meetings" }));

    expect(requestMainView).toHaveBeenNthCalledWith(1, "dictation");
    expect(requestMainView).toHaveBeenNthCalledWith(2, "recordings");
  });

  it("invites the first dictation with the user's own hotkey instead of showing zeros", async () => {
    dashboardState.recordings = [];

    render(<DashboardView />);

    expect(await screen.findByText("Alt + Space")).toBeInTheDocument();
    expect(screen.getByText("Your first dictation")).toBeInTheDocument();
    expect(
      screen.getByText(/Hold Alt \+ Space to record, release to transcribe and paste\./)
    ).toBeInTheDocument();
    expect(screen.queryByText("Stored on this Mac")).not.toBeInTheDocument();
  });

  it("opens meetings for mic-only-ready users instead of restarting onboarding", async () => {
    dashboardState.setupStatus = {
      dictationReady: true,
      meetingReady: true,
      fullCaptureReady: false,
      loading: false,
      productReadiness: {
        evidenceObservedAt: 2,
        dictation: { domain: "dictation", state: "ready", cause: null },
        meetings: { domain: "meetings", state: "ready", cause: null },
        meetingsCapture: {
          domain: "meetings_capture",
          state: "ready",
          cause: null,
        },
        fullCapture: {
          domain: "full_capture",
          state: "degraded",
          cause: {
            id: "system_audio_unavailable",
            message: "Mic-only meetings are ready.",
            action: {
              id: "configure_system_audio",
              label: "Set up system audio",
              destination: "transcription",
            },
          },
        },
        overall: {
          domain: "overall",
          state: "degraded",
          cause: {
            id: "system_audio_unavailable",
            message: "Mic-only meetings are ready.",
            action: {
              id: "configure_system_audio",
              label: "Set up system audio",
              destination: "transcription",
            },
          },
        },
      },
    };

    render(<DashboardView />);

    expect(
      await screen.findByText("Dictation and mic-only meetings are ready")
    ).toBeInTheDocument();
    expect(screen.getByText("Mic-only ready")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open meetings" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(requestMainView).toHaveBeenNthCalledWith(1, "recordings");
    expect(requestMainView).toHaveBeenNthCalledWith(2, "setup");
    expect(requestOnboarding).not.toHaveBeenCalled();
  });

  it("sends readiness cards to onboarding when setup is incomplete", async () => {
    dashboardState.setupStatus = {
      dictationReady: false,
      meetingReady: false,
      fullCaptureReady: false,
      loading: false,
      productReadiness: {
        evidenceObservedAt: 3,
        dictation: {
          domain: "dictation",
          state: "blocked",
          cause: {
            id: "dictation_route",
            message: "Choose a dictation model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
        meetings: {
          domain: "meetings",
          state: "blocked",
          cause: {
            id: "meeting_route",
            message: "Choose a meeting model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
        meetingsCapture: {
          domain: "meetings_capture",
          state: "blocked",
          cause: {
            id: "meeting_route",
            message: "Choose a meeting model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
        fullCapture: {
          domain: "full_capture",
          state: "blocked",
          cause: {
            id: "meeting_route",
            message: "Choose a meeting model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
        overall: {
          domain: "overall",
          state: "blocked",
          cause: {
            id: "dictation_route",
            message: "Choose a dictation model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
      },
    };

    render(<DashboardView />);

    expect(await screen.findByText("Finish setup to unlock the full solo workflow")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set up dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up meetings" }));

    expect(requestOnboarding).toHaveBeenNthCalledWith(1, "dictation");
    expect(requestOnboarding).toHaveBeenNthCalledWith(2, "meetings");
  });

  it("uses the canonical snapshot when legacy readiness booleans disagree", async () => {
    dashboardState.setupStatus = {
      dictationReady: true,
      meetingReady: true,
      fullCaptureReady: true,
      loading: false,
      productReadiness: {
        evidenceObservedAt: 4,
        dictation: {
          domain: "dictation",
          state: "blocked",
          cause: {
            id: "dictation_route",
            message: "Download the dictation model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
        meetings: { domain: "meetings", state: "ready", cause: null },
        meetingsCapture: {
          domain: "meetings_capture",
          state: "ready",
          cause: null,
        },
        fullCapture: {
          domain: "full_capture",
          state: "degraded",
          cause: {
            id: "system_audio_unavailable",
            message: "Mic-only meetings are ready.",
            action: {
              id: "configure_system_audio",
              label: "Set up system audio",
              destination: "transcription",
            },
          },
        },
        overall: {
          domain: "overall",
          state: "blocked",
          cause: {
            id: "dictation_route",
            message: "Download the dictation model.",
            action: {
              id: "open_models",
              label: "Review models",
              destination: "models",
            },
          },
        },
      },
    };

    render(<DashboardView />);

    expect(
      await screen.findByText(
        "Mic-only meetings are ready. Dictation needs one more pass",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start dictation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Review dictation setup" }),
    );
    expect(requestMainView).toHaveBeenCalledWith("dictation");
    fireEvent.click(screen.getByRole("button", { name: "Set up dictation" }));
    expect(requestOnboarding).toHaveBeenCalledWith("dictation");
  });

  it("opens a recent meeting in its own workspace", async () => {
    render(<DashboardView />);

    const recentRecording = await screen.findByRole("button", { name: /ACME pricing review/ });
    expect(recentRecording).toHaveTextContent("30:00");
    expect(recentRecording).toHaveTextContent("Meeting");

    fireEvent.click(recentRecording);

    expect(requestRecordingWorkspace).toHaveBeenCalledWith({ recordingId: "rec-1" });
    expect(requestMainView).not.toHaveBeenCalled();
  });

  it("lists recent items newest first and sends dictations to the Dictation view", async () => {
    const now = Date.now();
    const base = dashboardState.recordings[0];
    dashboardState.recordings = [
      { ...base, id: "old", title: "Older meeting", createdAt: new Date(now - 3 * 86_400_000).toISOString() },
      {
        ...base,
        id: "dict-1",
        title: "Reply to Dana about the launch",
        sourceType: "dictation",
        duration: 12,
        createdAt: new Date(now).toISOString(),
      },
    ];

    render(<DashboardView />);

    const rows = await screen.findAllByRole("button", { name: /Older meeting|Reply to Dana/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Reply to Dana"),
      expect.stringContaining("Older meeting"),
    ]);
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Dictation");

    fireEvent.click(rows[0]);

    expect(requestMainView).toHaveBeenCalledWith("dictation");
    expect(requestRecordingWorkspace).not.toHaveBeenCalled();
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

  it("opens the meeting at the matched moment from a transcript hit", async () => {
    searchTranscripts.mockResolvedValue([
      {
        recordingId: "rec-1",
        recordingTitle: "ACME pricing review",
        projectId: "project-1",
        segmentId: "seg-9",
        text: "Let's keep pricing flat through Q3.",
        startTime: 92,
        endTime: 98,
        score: -4.1,
      },
    ]);

    render(<DashboardView />);

    const searchInput = await screen.findByPlaceholderText(/Search every transcript/);
    fireEvent.change(searchInput, { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const hit = await screen.findByText("Let's keep pricing flat through Q3.");
    fireEvent.click(hit);

    expect(requestRecordingWorkspace).toHaveBeenCalledWith({
      recordingId: "rec-1",
      focusSegmentTime: 92,
      highlightQuery: "pricing",
    });
  });

  it("keeps analysis selection separate from opening a hit", async () => {
    searchTranscripts.mockResolvedValue([
      {
        recordingId: "rec-1",
        recordingTitle: "ACME pricing review",
        projectId: "project-1",
        segmentId: "seg-9",
        text: "Let's keep pricing flat through Q3.",
        startTime: 92,
        endTime: 98,
        score: -4.1,
      },
    ]);

    render(<DashboardView />);

    fireEvent.change(await screen.findByPlaceholderText(/Search every transcript/), {
      target: { value: "pricing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const checkbox = await screen.findByRole("button", {
      name: "Include ACME pricing review in cross-meeting analysis",
    });
    expect(checkbox).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(checkbox);

    expect(checkbox).toHaveAttribute("aria-pressed", "false");
    expect(requestRecordingWorkspace).not.toHaveBeenCalled();
  });
});
