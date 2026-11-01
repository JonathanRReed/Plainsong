import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/electron", () => ({ invoke }));
import { startRecording } from "@/lib/backend";

const options = { mic: true, systemAudio: false, projectId: "default" };
beforeEach(() => invoke.mockReset());
describe("calendar join capture admission", () => {
  it("keeps the captured recording when opening fails", async () => {
    invoke.mockResolvedValue({ recordingId: "captured", joinOpened: false });
    const onJoinFailure = vi.fn();
    expect(await startRecording({ ...options, joinConferenceUrl: "https://zoom.us/j/123", onJoinFailure })).toBe("captured");
    expect(onJoinFailure).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("begin_calendar_meeting_capture", { options, conferenceUrl: "https://zoom.us/j/123" });
  });
  it("uses normal capture when the next request has no join intent", async () => {
    invoke.mockResolvedValue("next");
    expect(await startRecording(options)).toBe("next");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("begin_meeting_capture", { options });
  });
});
