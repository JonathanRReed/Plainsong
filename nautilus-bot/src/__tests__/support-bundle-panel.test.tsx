import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupportBundlePanel } from "@/components/settings/support-bundle-panel";

const backend = vi.hoisted(() => ({
  previewSupportBundle: vi.fn(),
  createSupportBundle: vi.fn(),
}));

vi.mock("@/lib/backend/settings", () => backend);

const preview = {
  schemaVersion: 1,
  sections: [
    { file: "settings-redacted.json", description: "Your settings, redacted." },
    { file: "logs-redacted.txt", description: "The last log lines." },
  ],
  redactionRules: ["Email addresses are removed wherever they appear."],
  excludedByDesign: ["transcripts, dictated text, and anything inserted"],
  auditEntryCount: 12,
  modelArtifactCount: 7,
  maxLogLines: 400,
  logLineCount: 138,
  suggestedFileName: "plainsong-support-bundle-2026-09-02-19-00-00.zip",
};

describe("SupportBundlePanel", () => {
  beforeEach(() => {
    backend.previewSupportBundle.mockReset().mockResolvedValue(preview);
    backend.createSupportBundle.mockReset().mockResolvedValue(null);
  });

  it("says what the bundle would hold before anything is written", async () => {
    render(<SupportBundlePanel />);
    await waitFor(() => {
      expect(
        screen.getByText(/This bundle would hold 2 files/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/138 log lines/)).toBeInTheDocument();
    expect(screen.getByText(/12 audit entries/)).toBeInTheDocument();
    expect(screen.getByText(/7 model files/)).toBeInTheDocument();
    expect(backend.createSupportBundle).not.toHaveBeenCalled();
  });

  it("shows the file list, the rules, and the exclusions on request", async () => {
    render(<SupportBundlePanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Show what is included/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Show what is included/ }));

    expect(screen.getByText("settings-redacted.json")).toBeInTheDocument();
    expect(screen.getByText("logs-redacted.txt")).toBeInTheDocument();
    expect(
      screen.getByText("Email addresses are removed wherever they appear."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("transcripts, dictated text, and anything inserted"),
    ).toBeInTheDocument();
  });

  it("reports the saved file after a successful write", async () => {
    backend.createSupportBundle.mockResolvedValue({
      fileName: "plainsong-support-bundle-2026-09-02-19-00-00.zip",
      bytes: 20480,
      fileCount: 9,
      generatedAt: "2026-09-02T19:00:00Z",
    });
    render(<SupportBundlePanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create support bundle/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Create support bundle/ }));

    await waitFor(() => {
      expect(
        screen.getByText(/Saved plainsong-support-bundle-2026-09-02-19-00-00\.zip/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/20 KB, 9 files/)).toBeInTheDocument();
  });

  it("says nothing at all when the reader cancels the save dialog", async () => {
    render(<SupportBundlePanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create support bundle/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Create support bundle/ }));

    await waitFor(() => expect(backend.createSupportBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Saved /)).not.toBeInTheDocument();
    expect(screen.queryByText(/was not written/)).not.toBeInTheDocument();
  });

  it("says nothing was saved when the write fails", async () => {
    backend.createSupportBundle.mockRejectedValue(
      new Error("Support bundle was not written: logs-redacted.txt still contained a path"),
    );
    render(<SupportBundlePanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create support bundle/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Create support bundle/ }));

    await waitFor(() => {
      expect(screen.getByText(/Nothing was saved\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/still contained a path/)).toBeInTheDocument();
  });
});
