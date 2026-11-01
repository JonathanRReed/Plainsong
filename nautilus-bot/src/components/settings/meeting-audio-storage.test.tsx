import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAudioStorage } from "./meeting-audio-storage";
import { freeMeetingAudio, getAudioStorageStatus } from "@/lib/backend/audio-storage";
import type { ComponentProps } from "react";

vi.mock("@/lib/backend/audio-storage", () => ({
  getAudioStorageStatus: vi.fn().mockResolvedValue({ audioBytes: 1024 ** 3, bytesSaved: 2 * 1024 ** 3, pendingTracks: 0 }),
  freeMeetingAudio: vi.fn().mockResolvedValue({ deletedAudioFiles: 3, audioPathsCleared: 1 }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const transcription = { meetingRetentionPreset: "3m", meetingRetentionConfirmed: false } satisfies ComponentProps<typeof MeetingAudioStorage>["transcription"];

describe("Meeting audio storage", () => {
  it("shows usage and requires confirmation before enabling the default policy", async () => {
    const change = vi.fn(); const confirm = vi.spyOn(window,"confirm").mockReturnValue(false);
    render(<MeetingAudioStorage transcription={transcription} onChange={change} />);
    expect(await screen.findByText("1 GB used. 2 GB saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Enable auto-delete"})); expect(change).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button",{name:"Enable auto-delete"}));
    expect(change).toHaveBeenCalledWith({ meetingRetentionConfirmed:true });
  });
  it("refreshes storage after a background conversion", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(getAudioStorageStatus)
      .mockResolvedValueOnce({ audioBytes: 3 * 1024 ** 3, bytesSaved: 0, pendingTracks: 1 })
      .mockResolvedValueOnce({ audioBytes: 1024 ** 3, bytesSaved: 2 * 1024 ** 3, pendingTracks: 0 });
    render(<MeetingAudioStorage transcription={transcription} onChange={vi.fn()} />);
    expect(await screen.findByText("3 GB used. 0 MB saved.")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(await screen.findByText("1 GB used. 2 GB saved.")).toBeInTheDocument();
    expect(screen.getByText("Audio storage")).toBeInTheDocument();
  });
  it("supports one week and keeps transcripts by default", async () => {
    const change = vi.fn(); vi.spyOn(window,"confirm").mockReturnValue(true);
    render(<MeetingAudioStorage transcription={transcription} onChange={change} />);
    fireEvent.click(screen.getByRole("combobox", {name:"Delete meeting audio after"}));
    fireEvent.click(await screen.findByRole("option", {name:"1 week"}));
    expect(change).toHaveBeenCalledWith({meetingRetentionPreset:"1w",meetingRetentionConfirmed:true});
    expect(screen.getByText("Keeps transcripts and notes.")).toBeInTheDocument();
  });
  it("can free transcript-only audio even when age-based expiry is never", async () => {
    vi.spyOn(window,"confirm").mockReturnValue(true);
    render(<MeetingAudioStorage transcription={{...transcription,meetingRetentionPreset:"never",meetingAudioStorageMode:"transcript_only"}} onChange={vi.fn()} />);
    const button = screen.getByRole("button",{name:"Free up space now"});
    expect(button).toBeEnabled(); fireEvent.click(button);
    expect(await screen.findByText("Removed audio from 1 meeting.")).toBeInTheDocument();
    expect(freeMeetingAudio).toHaveBeenCalledWith("never",1,"transcript_only");
  });
  it("cleans audio only after confirmation and refreshes actual storage", async () => {
    vi.spyOn(window,"confirm").mockReturnValue(true);
    render(<MeetingAudioStorage transcription={transcription} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button",{name:"Free up space now"}));
    expect(await screen.findByText("Removed audio from 1 meeting.")).toBeInTheDocument();
    expect(freeMeetingAudio).toHaveBeenCalledWith("3m",1,"always");
    await waitFor(() => expect(getAudioStorageStatus).toHaveBeenCalled());
  });
});
