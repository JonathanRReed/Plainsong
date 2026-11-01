import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const levels = vi.hoisted(() => ({
  getMeetingSourceLevels: vi.fn(),
}));

vi.mock("@/lib/backend/recordings", () => ({
  getMeetingSourceLevels: levels.getMeetingSourceLevels,
}));

import { MeetingSourceLevelMeters } from "@/components/meetings/meeting-source-levels";

describe("MeetingSourceLevelMeters", () => {
  beforeEach(() => {
    levels.getMeetingSourceLevels.mockReset();
  });

  it("marks meeting audio unverified until it has carried any sound", async () => {
    levels.getMeetingSourceLevels.mockResolvedValue({
      mic: 0.05,
      system: 0,
      systemUnverified: true,
    });
    render(<MeetingSourceLevelMeters recordingId="r1" active />);

    expect(await screen.findByText("Unverified: no sound yet")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Meeting audio level" })).toBeInTheDocument();
  });

  it("shows a quiet but verified source without the note", async () => {
    levels.getMeetingSourceLevels.mockResolvedValue({
      mic: 0.05,
      system: 0,
      systemUnverified: false,
    });
    render(<MeetingSourceLevelMeters recordingId="r1" active />);

    expect(await screen.findByRole("meter", { name: "Meeting audio level" })).toBeInTheDocument();
    expect(screen.queryByText(/Unverified/)).not.toBeInTheDocument();
  });
});
