import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

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
      {
        id: "rec-2",
        title: "Quarterly planning",
        projectId: "project-1",
        duration: 1200,
        createdAt: "2026-03-11T15:00:00.000Z",
        updatedAt: "2026-03-11T15:00:00.000Z",
        sourceType: "meeting",
        audioPath: "/tmp/rec-2.wav",
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

  async function selectRecording(title = "ACME pricing review") {
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: title }));
  }

  it("shows known gaps and subtitle limits for the current recording", async () => {
    Object.assign(recordingsMock.recordings[0], {
      transcriptComplete: true,
      captureDegradedSummary: "System audio was not captured for 240 seconds.",
    });
    const view = render(<ExportsView />);
    expect(screen.queryByText(/Part of this meeting was not captured/)).not.toBeInTheDocument();

    await selectRecording();
    expect(screen.getByText(/Part of this meeting was not captured/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Subtitles (SRT)" }));
    expect(screen.getByText(/This warning isn't included in the file/)).toBeInTheDocument();

    await selectRecording("Quarterly planning");
    expect(screen.queryByText(/Part of this meeting was not captured/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This warning isn't included in the file/)).not.toBeInTheDocument();

    Object.assign(recordingsMock.recordings[1], { transcriptComplete: false });
    view.rerender(<ExportsView />);
    expect(screen.getByText(/This transcript is incomplete/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Subtitles (WebVTT)" }));
    expect(screen.getByText(/This warning isn't included in the file/)).toBeInTheDocument();

    Object.assign(recordingsMock.recordings[1], { transcriptComplete: undefined });
    view.rerender(<ExportsView />);
    expect(screen.queryByText(/This transcript is incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This warning isn't included in the file/)).not.toBeInTheDocument();
  });

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

  it("ignores a delayed recording preview after the recording changes", async () => {
    const pendingPreview = deferred<{
      format: "markdown";
      redactionLevel: "basic";
      preview: true;
      exportPath: null;
      content: string;
    }>();
    exportsMocks.exportRecordingV2.mockReturnValueOnce(pendingPreview.promise);

    render(<ExportsView />);

    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await selectRecording("Quarterly planning");

    pendingPreview.resolve({
      format: "markdown",
      redactionLevel: "basic",
      preview: true,
      exportPath: null,
      content: "Preview from the old recording",
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    });
    expect(screen.queryByText("Preview from the old recording")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing previewed yet.")).toBeInTheDocument();
  });

  it("ignores a delayed preview error after the redaction level changes", async () => {
    const pendingPreview = deferred<never>();
    exportsMocks.exportRecordingV2.mockReturnValueOnce(pendingPreview.promise);

    render(<ExportsView />);

    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getAllByRole("combobox")[2]);
    fireEvent.click(await screen.findByRole("option", { name: "Strict" }));

    pendingPreview.reject(new Error("Preview from the old redaction failed"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    });
    expect(screen.queryByText("Preview from the old redaction failed")).not.toBeInTheDocument();
  });

  it("ignores a delayed template preview after the template changes", async () => {
    exportsMocks.listExportTemplates.mockResolvedValueOnce([
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
      {
        id: "template-2",
        name: "Decision log",
        description: "Decisions only",
        format: "markdown",
        template: "{{decisions}}",
        includeSpeakers: false,
        includeTimestamps: false,
        includeConfidence: false,
        customFields: {},
      },
    ]);
    const pendingPreview = deferred<{
      templateId: string;
      preview: true;
      exportPath: null;
      content: string;
    }>();
    exportsMocks.exportWithTemplate.mockReturnValueOnce(pendingPreview.promise);

    render(<ExportsView />);

    await selectRecording();
    expect(await screen.findByText("Follow-up memo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Render Preview" }));
    fireEvent.click(screen.getAllByRole("combobox")[3]);
    fireEvent.click(await screen.findByRole("option", { name: "Decision log" }));

    pendingPreview.resolve({
      templateId: "template-1",
      preview: true,
      exportPath: null,
      content: "Preview from the old template",
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Render Preview" })).toBeEnabled();
    });
    expect(screen.queryByText("Preview from the old template")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing rendered yet.")).toBeInTheDocument();
  });

  it("clears standard and template export paths when the recording changes", async () => {
    exportsMocks.exportRecordingV2.mockResolvedValueOnce({
      format: "markdown",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/old-recording.md",
      content: null,
    });
    exportsMocks.exportWithTemplate.mockResolvedValueOnce({
      templateId: "template-1",
      preview: false,
      exportPath: "/tmp/old-template.md",
      content: null,
    });

    render(<ExportsView />);

    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText("/tmp/old-recording.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export Template" }));
    expect(await screen.findByText("/tmp/old-template.md")).toBeInTheDocument();

    await selectRecording("Quarterly planning");

    expect(screen.queryByText("/tmp/old-recording.md")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/old-template.md")).not.toBeInTheDocument();
  });

  it("clears only the matching export path when a destination changes", async () => {
    exportsMocks.exportRecordingV2.mockResolvedValueOnce({
      format: "markdown",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/standard-export.md",
      content: null,
    });
    exportsMocks.exportWithTemplate.mockResolvedValueOnce({
      templateId: "template-1",
      preview: false,
      exportPath: "/tmp/template-export.md",
      content: null,
    });

    render(<ExportsView />);

    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText("/tmp/standard-export.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export Template" }));
    expect(await screen.findByText("/tmp/template-export.md")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Save to (optional)", { selector: "#export-path" }), {
      target: { value: "/tmp/new-standard.md" },
    });

    expect(screen.queryByText("/tmp/standard-export.md")).not.toBeInTheDocument();
    expect(screen.getByText("/tmp/template-export.md")).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Save to (optional)", { selector: "#template-export-path" }),
      { target: { value: "/tmp/new-template.md" } }
    );

    expect(screen.queryByText("/tmp/template-export.md")).not.toBeInTheDocument();
  });

  it("clears previews and file links when the selected recording content changes", async () => {
    const view = render(<ExportsView />);
    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/Redacted preview/);
    fireEvent.click(screen.getByRole("button", { name: "Render Preview" }));
    await screen.findByText("Follow-up memo preview");
    exportsMocks.exportRecordingV2.mockResolvedValueOnce({
      format: "markdown", redactionLevel: "basic", preview: false,
      exportPath: "/tmp/old-source.md", content: null,
    });
    exportsMocks.exportWithTemplate.mockResolvedValueOnce({
      templateId: "template-1", preview: false,
      exportPath: "/tmp/old-source-template.md", content: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("/tmp/old-source.md");
    fireEvent.click(screen.getByRole("button", { name: "Export Template" }));
    await screen.findByText("/tmp/old-source-template.md");
    recordingsMock.recordings = recordingsMock.recordings.map((recording) => recording.id === "rec-1"
      ? { ...recording, meetingNotes: "Updated notes from another window." }
      : recording);
    view.rerender(<ExportsView />);
    expect(screen.queryByText(/Redacted preview/)).not.toBeInTheDocument();
    expect(screen.queryByText("Follow-up memo preview")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/old-source.md")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/old-source-template.md")).not.toBeInTheDocument();
  });

  it.each([
    { button: "Preview", request: exportsMocks.exportRecordingV2,
      reply: { format: "markdown", redactionLevel: "basic", preview: true, exportPath: null, content: "Old source preview" } },
    { button: "Export", request: exportsMocks.exportRecordingV2,
      reply: { format: "markdown", redactionLevel: "basic", preview: false, exportPath: "/tmp/old-source-late.md", content: null } },
    { button: "Render Preview", request: exportsMocks.exportWithTemplate,
      reply: { templateId: "template-1", preview: true, exportPath: null, content: "Old source preview" } },
    { button: "Export Template", request: exportsMocks.exportWithTemplate,
      reply: { templateId: "template-1", preview: false, exportPath: "/tmp/old-source-late.md", content: null } },
  ])("ignores a late $button result after selected recording content changes", async ({ button, request, reply }) => {
    const pending = deferred<typeof reply>();
    request.mockReturnValueOnce(pending.promise);
    const view = render(<ExportsView />);
    await selectRecording();
    await screen.findByText("Follow-up memo");
    fireEvent.click(screen.getByRole("button", { name: button }));
    recordingsMock.recordings = recordingsMock.recordings.map((recording) => recording.id === "rec-1"
      ? { ...recording, title: "Updated pricing review", updatedAt: "2026-03-10T15:01:00.000Z" }
      : recording);
    view.rerender(<ExportsView />);
    await act(async () => { pending.resolve(reply); await pending.promise; });
    await waitFor(() => expect(screen.getByRole("button", { name: button })).toBeEnabled());
    expect(screen.queryByText("Old source preview")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/old-source-late.md")).not.toBeInTheDocument();
  });

  it("retains a preview when refreshed recording content is unchanged", async () => {
    const view = render(<ExportsView />);
    await selectRecording();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/Redacted preview/);
    recordingsMock.recordings = recordingsMock.recordings.map((recording) => ({ ...recording }));
    view.rerender(<ExportsView />);
    expect(screen.getByText(/Redacted preview/)).toBeInTheDocument();
  });

  it("keeps one export in flight until the pending request settles", async () => {
    const pendingExport = deferred<{
      format: "markdown";
      redactionLevel: "basic";
      preview: false;
      exportPath: string;
      content: null;
    }>();
    exportsMocks.exportRecordingV2.mockReturnValueOnce(pendingExport.promise);

    render(<ExportsView />);

    await selectRecording();
    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);

    expect(exportsMocks.exportRecordingV2).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export Template" })).toBeDisabled();

    pendingExport.resolve({
      format: "markdown",
      redactionLevel: "basic",
      preview: false,
      exportPath: "/tmp/single-export.md",
      content: null,
    });

    expect(await screen.findByText("/tmp/single-export.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });
});
