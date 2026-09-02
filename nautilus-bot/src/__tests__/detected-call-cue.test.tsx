import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetectedCallCue } from "@/components/meetings/detected-call-cue";
import type { DetectedCall, MeetingCallStatus } from "@/lib/backend/recordings";

const getMeetingCallStatus = vi.fn();
const dismissDetectedCall = vi.fn();

vi.mock("@/lib/backend/recordings", () => ({
  getMeetingCallStatus: (...args: unknown[]) => getMeetingCallStatus(...args),
  dismissDetectedCall: (...args: unknown[]) => dismissDetectedCall(...args),
}));

// 14:05 local time.
const DETECTED_AT = new Date(2026, 8, 2, 14, 5, 0).getTime();

function activeCall(overrides: Partial<DetectedCall> = {}): DetectedCall {
  return {
    callId: 1,
    app: "zoom",
    appLabel: "Zoom",
    videoService: "zoom",
    bundleId: "us.zoom.xos",
    hasCallWindow: true,
    confidence: "high",
    detectedAtMs: DETECTED_AT,
    detectedAt: new Date(DETECTED_AT).toISOString(),
    dismissed: false,
    ...overrides,
  };
}

function status(overrides: Partial<MeetingCallStatus> = {}): MeetingCallStatus {
  return {
    supported: true,
    enabled: true,
    accessibilityGranted: true,
    activeCall: null,
    ...overrides,
  };
}

beforeEach(() => {
  getMeetingCallStatus.mockReset();
  dismissDetectedCall.mockReset();
});

describe("DetectedCallCue", () => {
  it("renders nothing when no call is detected", async () => {
    getMeetingCallStatus.mockResolvedValue(status());
    const { container } = render(
      <DetectedCallCue captureInProgress={false} onStartCapture={vi.fn()} />,
    );
    await waitFor(() => expect(getMeetingCallStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the call and hands the view a prefill named after it", async () => {
    getMeetingCallStatus.mockResolvedValue(status({ activeCall: activeCall() }));
    const onStartCapture = vi.fn();
    render(<DetectedCallCue captureInProgress={false} onStartCapture={onStartCapture} />);

    expect(await screen.findByText("Zoom call in progress")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Call in progress" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));
    expect(onStartCapture).toHaveBeenCalledWith({
      callId: 1,
      title: "Zoom call, 14:05",
      videoService: "zoom",
    });
    // The cue itself never touches the backend to start anything.
    expect(dismissDetectedCall).not.toHaveBeenCalled();
  });

  it("dismisses this one call by id and hides at once", async () => {
    getMeetingCallStatus.mockResolvedValue(status({ activeCall: activeCall({ callId: 9 }) }));
    dismissDetectedCall.mockResolvedValue(
      status({ activeCall: activeCall({ callId: 9, dismissed: true }) }),
    );
    render(<DetectedCallCue captureInProgress={false} onStartCapture={vi.fn()} />);

    await screen.findByText("Zoom call in progress");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissDetectedCall).toHaveBeenCalledWith(9);
    await waitFor(() => {
      expect(screen.queryByText("Zoom call in progress")).not.toBeInTheDocument();
    });
  });

  it("stays hidden for a dismissed call and while a meeting is recording", async () => {
    getMeetingCallStatus.mockResolvedValue(
      status({ activeCall: activeCall({ dismissed: true }) }),
    );
    const { container, rerender } = render(
      <DetectedCallCue captureInProgress={false} onStartCapture={vi.fn()} />,
    );
    await waitFor(() => expect(getMeetingCallStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();

    getMeetingCallStatus.mockResolvedValue(status({ activeCall: activeCall() }));
    rerender(<DetectedCallCue captureInProgress onStartCapture={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
