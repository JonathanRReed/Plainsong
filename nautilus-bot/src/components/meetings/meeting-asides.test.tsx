import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingAsides } from "./meeting-asides";
import { deleteRecordingAside, exportRecordingAudio } from "@/lib/backend/meeting-asides";

vi.mock("@/lib/backend/meeting-asides", () => ({
  deleteRecordingAside: vi.fn(),
  exportRecordingAudio: vi.fn(),
}));
const asides = [{ asideId: "aside", startTime: 12, endTime: 18, rows: [{ id: "row", startTime: 12, endTime: 18, text: "Private canary", confidence: 1 }] }];

describe("MeetingAsides", () => {
  beforeEach(() => vi.resetAllMocks());
  it("hides text until requested and seeks the selected aside", () => {
    const onSeek = vi.fn();
    render(<MeetingAsides recordingId="meeting" asides={asides} onSeek={onSeek} onDelete={vi.fn()} />);
    expect(screen.queryByText("Private canary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show asides (1)" }));
    fireEvent.click(screen.getByText("Private canary"));
    expect(onSeek).toHaveBeenCalledWith(12);
    fireEvent.click(screen.getByRole("button", { name: "Hide asides (1)" }));
    expect(screen.queryByText("Private canary")).not.toBeInTheDocument();
  });
  it("removes text only after deletion succeeds", async () => {
    const onDelete = vi.fn();
    vi.mocked(deleteRecordingAside).mockRejectedValueOnce(new Error("disk"));
    render(<MeetingAsides recordingId="meeting" asides={asides} onSeek={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Show asides (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete aside at/ }));
    await screen.findByText("Could not delete this aside. Try again.");
    expect(onDelete).not.toHaveBeenCalled();
    vi.mocked(deleteRecordingAside).mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: /Delete aside at/ }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("aside"));
    expect(deleteRecordingAside).toHaveBeenLastCalledWith("meeting", "aside");
  });
  it("exports the selected meeting through the masked audio command", async () => {
    vi.mocked(exportRecordingAudio).mockResolvedValue({ exportPath: "/qa/meeting.wav" });
    render(<MeetingAsides recordingId="meeting" asides={asides} onSeek={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export audio" }));
    await screen.findByText("Audio saved to /qa/meeting.wav");
    expect(exportRecordingAudio).toHaveBeenCalledWith("meeting");
  });
});
