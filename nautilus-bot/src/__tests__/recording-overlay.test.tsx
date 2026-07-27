import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentDialog } from "@/components/recording-overlay";
import type { SystemAudioCapability } from "@/lib/backend/recordings";

const backendMocks = vi.hoisted(() => ({
  getMeetingConsentAutomationStatus: vi.fn(),
  getSystemAudioCapability: vi.fn(),
}));

vi.mock("@/lib/backend/recordings", () => backendMocks);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function capability(
  overrides: Partial<SystemAudioCapability> = {}
): SystemAudioCapability {
  return {
    backend: "core_audio_process_tap",
    nativeOsSupported: true,
    nativeOsEnabled: true,
    routeDevice: "MacBook Pro Speakers",
    routeId: "coreaudio:BuiltInSpeakerDevice",
    nativeSampleRate: 48000,
    nativeChannels: 2,
    readiness: "ready",
    ready: true,
    reason: null,
    actionableReason: null,
    ...overrides,
  };
}

describe("ConsentDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendMocks.getMeetingConsentAutomationStatus.mockResolvedValue({
      mode: "manual_required",
      canAutomate: false,
      message: "Copy the notice into the meeting chat.",
      noticeText: "This meeting is being recorded and transcribed.",
    });
  });

  it("keeps an incoherent system-audio capability in mic-only mode", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(
      capability({ readiness: "unverified", ready: true })
    );
    const onStart = vi.fn(async () => {});

    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={onStart} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeDisabled();
      expect(screen.getByText(/callbacks are unverified/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith({
        mic: true,
        systemAudio: false,
        template: undefined,
      });
    });
  });

  it("resets stale capability state and stays mic-only until the reopened check completes", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValueOnce(capability());
    const onStart = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    const view = render(
      <ConsentDialog open onOpenChange={onOpenChange} onStart={onStart} />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeEnabled();
    });

    view.rerender(
      <ConsentDialog open={false} onOpenChange={onOpenChange} onStart={onStart} />
    );

    const reopenedCapability = deferred<SystemAudioCapability>();
    backendMocks.getSystemAudioCapability.mockReturnValueOnce(
      reopenedCapability.promise
    );
    view.rerender(
      <ConsentDialog open onOpenChange={onOpenChange} onStart={onStart} />
    );

    await waitFor(() => {
      expect(backendMocks.getSystemAudioCapability).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText("Checking the current system-audio capability...")
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith({
        mic: true,
        systemAudio: false,
        template: undefined,
      });
    });

    await act(async () => {
      reopenedCapability.resolve(capability());
      await reopenedCapability.promise;
    });
  });

  it("submits onStart once and disables launch controls while starting", async () => {
    const pendingCapability = deferred<SystemAudioCapability>();
    backendMocks.getSystemAudioCapability.mockReturnValueOnce(
      pendingCapability.promise
    );
    const start = deferred<void>();
    const onStart = vi.fn(() => start.promise);

    render(
      <ConsentDialog open onOpenChange={vi.fn()} onStart={onStart} />
    );

    const startButton = screen.getByRole("button", { name: "Start Meeting" });
    const form = startButton.closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Mic only/ })).toBeDisabled();

    await act(async () => {
      start.resolve();
      await start.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Meeting" })).toBeEnabled();
    });
  });
});
