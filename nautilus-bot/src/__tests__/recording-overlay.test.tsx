import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentDialog } from "@/components/recording-overlay";
import type { SystemAudioCapability } from "@/lib/backend/recordings";

const backendMocks = vi.hoisted(() => ({
  getMeetingConsentNoticeStatus: vi.fn(),
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
    backendMocks.getMeetingConsentNoticeStatus.mockResolvedValue({
      message: "Copy the notice into the meeting chat.",
      noticeText: "This meeting is being recorded and transcribed.",
    });
  });

  it("keeps the start controls visible while the long setup body scrolls", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());

    render(
      <ConsentDialog open onOpenChange={vi.fn()} onStart={vi.fn()} />,
    );

    await waitFor(() => {
      expect(backendMocks.getSystemAudioCapability).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[calc(100vh-2rem)]",
      "max-w-2xl",
      "overflow-hidden",
    );
    expect(screen.getByTestId("meeting-start-dialog-body")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
    );
    expect(screen.getByRole("button", { name: "Start Meeting" })).toBeVisible();
  });

  it("announces selection state for capture modes and meeting templates", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());

    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={vi.fn()} />);

    const micOnly = screen.getByRole("button", { name: /Mic only/ });
    const meAndThem = screen.getByRole("button", { name: /Me \+ Them/ });
    await waitFor(() => {
      expect(meAndThem).toHaveAttribute("aria-pressed", "true");
    });
    expect(micOnly).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(micOnly);
    expect(micOnly).toHaveAttribute("aria-pressed", "true");
    expect(meAndThem).toHaveAttribute("aria-pressed", "false");

    const autoTemplate = screen.getByRole("button", { name: "Auto" });
    const standupTemplate = screen.getByRole("button", { name: "Standup" });
    expect(autoTemplate).toHaveAttribute("aria-pressed", "true");
    expect(standupTemplate).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(standupTemplate);
    expect(autoTemplate).toHaveAttribute("aria-pressed", "false");
    expect(standupTemplate).toHaveAttribute("aria-pressed", "true");
  });

  it("lists user-saved templates alongside the built-ins, labeled as theirs", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());
    const onStart = vi.fn(async () => {});

    render(
      <ConsentDialog
        open
        onOpenChange={vi.fn()}
        onStart={onStart}
        customTemplates={[
          {
            id: "custom-board-update",
            name: "Board Update",
            summaryPrompt: "Summarize board sentiment.",
            notesOutline: ["Sentiment", "Asks"],
          },
        ]}
      />,
    );

    const customButton = screen.getByRole("button", { name: /Board Update/ });
    expect(customButton).toHaveTextContent("Yours");
    // A built-in stays unlabeled.
    expect(screen.getByRole("button", { name: "Standup" })).not.toHaveTextContent(
      "Yours",
    );

    fireEvent.click(customButton);
    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ template: "custom-board-update" }),
      );
    });
  });

  it("announces asynchronous system-audio capability changes", async () => {
    const pendingCapability = deferred<SystemAudioCapability>();
    backendMocks.getSystemAudioCapability.mockReturnValueOnce(
      pendingCapability.promise,
    );

    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={vi.fn()} />);

    const status = screen.getByRole("status", {
      name: "System audio capability",
    });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(
      "Checking the current system-audio capability...",
    );

    await act(async () => {
      pendingCapability.resolve(capability());
      await pendingCapability.promise;
    });

    expect(status).toHaveTextContent("Verified via MacBook Pro Speakers.");
  });

  it("returns focus to the control that opened the dialog", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open meeting setup
          </button>
          <ConsentDialog
            open={open}
            onOpenChange={setOpen}
            onStart={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {
      name: "Open meeting setup",
    });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(trigger).toHaveFocus();
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
