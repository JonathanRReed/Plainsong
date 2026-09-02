import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportsView } from "@/components/views/exports-view";

const exportsMocks = vi.hoisted(() => ({
  exportRecordingV2: vi.fn(),
  exportWithTemplate: vi.fn(),
  listExportTemplates: vi.fn(),
  openExportPath: vi.fn(),
}));

const recordingsMock = vi.hoisted(() => ({
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
  isLoading: false,
  error: null as string | null,
}));

const navigationMocks = vi.hoisted(() => ({
  requestMainView: vi.fn(),
}));

vi.mock("@/hooks/use-recordings", () => ({
  useRecordings: () => recordingsMock,
}));

vi.mock("@/lib/backend/exports", () => exportsMocks);
vi.mock("@/lib/navigation", () => navigationMocks);

describe("ExportsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingsMock.recordings = [
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
    recordingsMock.isLoading = false;
    recordingsMock.error = null;
    exportsMocks.listExportTemplates.mockResolvedValue([
      {
        id: "template-1",
        name: "Follow-up memo",
        description: "Meeting follow-up",
        format: "markdown",
        template: "{{summary}}",
        includeSpeakers: true,
        includeTimestamps: true,
        includeConfidence: false,
        customFields: {},
      },
    ]);
    exportsMocks.exportRecordingV2.mockResolvedValue({
      format: "markdown",
      redactionLevel: "basic",
      preview: true,
      exportPath: null,
      content: "# ACME pricing review\n\nRedacted preview",
    });
    exportsMocks.exportWithTemplate.mockResolvedValue({
      templateId: "template-1",
      preview: true,
      exportPath: null,
      content: "Follow-up memo preview",
    });
    exportsMocks.openExportPath.mockResolvedValue(undefined);
  });

  async function selectRecording() {
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByText("ACME pricing review"));
  }

  it("previews and exports a recording with clear next steps", async () => {
    render(<ExportsView />);

    expect(screen.getByText("Select a recording before previewing or exporting.")).toBeInTheDocument();

    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText(/Redacted preview/)).toBeInTheDocument();
    expect(exportsMocks.exportRecordingV2).toHaveBeenCalledWith("rec-1", "markdown", {
      redactionLevel: "basic",
      preview: true,
    });

    exportsMocks.exportRecordingV2.mockResolvedValueOnce({
      format: "markdown",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/acme-pricing-review.md",
      content: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(await screen.findByText(/Export written to:/)).toBeInTheDocument();
    expect(screen.getByText("/tmp/acme-pricing-review.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open export" }));

    await waitFor(() => {
      expect(exportsMocks.openExportPath).toHaveBeenCalledWith("/tmp/acme-pricing-review.md");
    });
  });

  it("renders template previews, exports templates, and opens the exported file", async () => {
    render(<ExportsView />);

    await selectRecording();
    expect(await screen.findByText("Follow-up memo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Render Preview" }));

    expect(await screen.findByText("Follow-up memo preview")).toBeInTheDocument();
    expect(exportsMocks.exportWithTemplate).toHaveBeenCalledWith("rec-1", "template-1", {
      preview: true,
      redactionLevel: "basic",
    });

    exportsMocks.exportWithTemplate.mockResolvedValueOnce({
      templateId: "template-1",
      preview: false,
      exportPath: "/tmp/follow-up-memo.md",
      content: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Export Template" }));

    const templateExportStatus = await screen.findByText(/Template exported to/);
    expect(within(templateExportStatus.parentElement as HTMLElement).getByText("/tmp/follow-up-memo.md")).toBeInTheDocument();

    fireEvent.click(within(templateExportStatus.parentElement as HTMLElement).getByRole("button", { name: "Open export" }));

    await waitFor(() => {
      expect(exportsMocks.openExportPath).toHaveBeenCalledWith("/tmp/follow-up-memo.md");
    });
  });

  it("offers the subtitle and Word formats and says what each one writes", async () => {
    render(<ExportsView />);

    await selectRecording();
    // The format dropdown is the second combobox on the page.
    fireEvent.click(screen.getAllByRole("combobox")[1]);

    for (const label of [
      "Markdown (.md)",
      "Word document (.docx)",
      "Plain text (.txt)",
      "JSON (.json)",
      "Subtitles (SRT)",
      "Subtitles (WebVTT)",
    ]) {
      expect(await screen.findByRole("option", { name: label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("option", { name: "Subtitles (SRT)" }));
    expect(
      await screen.findByText(/One cue per transcript segment\. Needs a transcript\./)
    ).toBeInTheDocument();

    exportsMocks.exportRecordingV2.mockResolvedValueOnce({
      format: "srt",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/acme-pricing-review.srt",
      content: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportsMocks.exportRecordingV2).toHaveBeenCalledWith("rec-1", "srt", {
        redactionLevel: "basic",
        target: undefined,
        preview: false,
      });
    });
    expect(await screen.findByText("/tmp/acme-pricing-review.srt")).toBeInTheDocument();
  });

  it("says a Word preview shows the Markdown the file is built from", async () => {
    render(<ExportsView />);

    await selectRecording();
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Word document (.docx)" }));

    expect(
      await screen.findByText(/preview below shows the Markdown it is built from/)
    ).toBeInTheDocument();
  });

  it("routes users to meetings when there are no recordings to export", async () => {
    recordingsMock.recordings = [];

    render(<ExportsView />);

    expect(screen.getByText("No recordings to export")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open meetings" }));

    expect(navigationMocks.requestMainView).toHaveBeenCalledWith("recordings");
  });

  it("shows template load failures and retries loading templates", async () => {
    exportsMocks.listExportTemplates
      .mockRejectedValueOnce(new Error("Template directory is unavailable"))
      .mockResolvedValueOnce([
        {
          id: "template-1",
          name: "Follow-up memo",
          description: "Meeting follow-up",
          format: "markdown",
          template: "{{summary}}",
          includeSpeakers: true,
          includeTimestamps: true,
          includeConfidence: false,
          customFields: {},
        },
      ]);

    render(<ExportsView />);

    expect(await screen.findByText("Template directory is unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Follow-up memo")).toBeInTheDocument();
    expect(exportsMocks.listExportTemplates).toHaveBeenCalledTimes(2);
  });
});
