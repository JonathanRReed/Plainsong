import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentDialog } from "@/components/recording-overlay";
import type { SystemAudioCapability } from "@/lib/backend/recordings";

const backendMocks = vi.hoisted(() => ({
  getMeetingConsentNoticeStatus: vi.fn(),
  getSystemAudioCapability: vi.fn(),
  testSystemAudioCapture: vi.fn(),
}));
const settingsMocks = vi.hoisted(() => ({
  openPermissionSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/backend/recordings", () => backendMocks);
vi.mock("@/lib/backend/settings", () => settingsMocks);

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
    routeDevice: "Sound playing on this Mac",
    routeId: "system-output:all-apps",
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

  it("names the combined calendar action and conference service before consent", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());
    const onStart = vi.fn();
    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={onStart} joinServiceLabel="Zoom" />);
    expect(screen.getByRole("heading", { name: "Join and capture" })).toBeInTheDocument();
    expect(screen.getByText(/After you confirm, capture starts and Zoom opens in your browser/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join and capture" })).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
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
      name: "Meeting audio",
    });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(
      "Checking whether Plainsong can hear the meeting audio on this Mac…",
    );

    await act(async () => {
      pendingCapability.resolve(capability());
      await pendingCapability.promise;
    });

    expect(status).toHaveTextContent(
      "Ready. Records all audio playing on this Mac, including other apps and notification sounds, with or without headphones.",
    );
    expect(
      screen.getByText(
        "Plainsong records your microphone and every sound this Mac plays during the meeting, music, videos and notifications included, and it works with headphones.",
      ),
    ).toBeInTheDocument();
  });

  it("asks macOS only when the reader chooses Allow meeting audio, then selects Me + Them", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(
      capability({ readiness: "unverified", ready: false, permission: "not_determined" }),
    );
    backendMocks.testSystemAudioCapture.mockResolvedValue({
      capability: capability({ permission: "granted" }),
      callbacks: 10,
      capturedFrames: 48000,
      nonSilentFrames: 4800,
      peak: 0.04,
      expectedToneHz: 997,
      detectedToneAmplitude: 0.03,
      verificationMethod: "known_tone",
    });
    const onStart = vi.fn(async () => {});

    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={onStart} />);

    const allow = await screen.findByRole("button", { name: "Allow meeting audio" });
    expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeDisabled();
    expect(backendMocks.testSystemAudioCapture).not.toHaveBeenCalled();

    fireEvent.click(allow);

    await waitFor(() => {
      expect(backendMocks.testSystemAudioCapture).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith({ mic: true, systemAudio: true, template: undefined });
    });
  });

  it("explains a denied permission and opens System Settings", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(
      capability({
        readiness: "unverified",
        ready: false,
        reason: "permission_denied",
        permission: "denied",
      }),
    );

    render(<ConsentDialog open onOpenChange={vi.fn()} onStart={vi.fn()} />);

    const open = await screen.findByRole("button", { name: "Open System Settings" });
    expect(
      screen.getByRole("status", { name: "Meeting audio" }),
    ).toHaveTextContent(/macOS is blocking Plainsong from recording meeting audio/);
    fireEvent.click(open);
    await waitFor(() => {
      expect(settingsMocks.openPermissionSettings).toHaveBeenCalledWith("system_audio");
    });
    expect(backendMocks.testSystemAudioCapture).not.toHaveBeenCalled();

    backendMocks.getSystemAudioCapability.mockResolvedValue(capability({ permission: "granted" }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeEnabled();
    });
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
      expect(screen.getByText(/needs your OK to record the meeting audio/i)).toBeInTheDocument();
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
        screen.getByText("Checking whether Plainsong can hear the meeting audio on this Mac…")
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

  it("shows a parent start failure without losing choices and allows retry", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());
    const onStart = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    const view = render(
      <ConsentDialog open onOpenChange={onOpenChange} onStart={onStart} />,
    );
    const micOnly = screen.getByRole("button", { name: /Mic only/ });
    const standup = screen.getByRole("button", { name: "Standup" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Me \+ Them/ })).toBeEnabled(),
    );
    fireEvent.click(micOnly);
    fireEvent.click(standup);
    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));

    view.rerender(
      <ConsentDialog
        open
        onOpenChange={onOpenChange}
        onStart={onStart}
        startFailureMessage="Plainsong could not start this meeting. Try again."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Plainsong could not start this meeting. Try again.",
    );
    expect(micOnly).toHaveAttribute("aria-pressed", "true");
    expect(standup).toHaveAttribute("aria-pressed", "true");
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));
    expect(onStart).toHaveBeenLastCalledWith({
      mic: true,
      systemAudio: false,
      template: "standup",
    });
  });

  it("offers the failure's own fix inside the dialog", async () => {
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());
    const onSelect = vi.fn();
    render(
      <ConsentDialog
        open
        onOpenChange={vi.fn()}
        onStart={vi.fn()}
        startFailureMessage="Plainsong does not have microphone access, so there is nothing to record."
        startFailureAction={{ label: "Open Microphone settings", onSelect }}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("microphone access");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open Microphone settings" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("meeting dictation separation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendMocks.getSystemAudioCapability.mockResolvedValue(capability());
    backendMocks.getMeetingConsentNoticeStatus.mockResolvedValue({
      message: "Copy the notice into the meeting chat.",
      noticeText: "This meeting is being recorded and transcribed.",
    });
  });

  it("blocks click and Enter submission while showing the active dictation reason", async () => {
    const onStart = vi.fn(async () => {});
    const reason = "Dictation is active. Finish it before starting a meeting.";
    render(
      <ConsentDialog
        open
        onOpenChange={vi.fn()}
        onStart={onStart}
        startBlockedReason={reason}
      />,
    );

    expect(await screen.findByText(reason)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start Meeting" });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    fireEvent.submit(start.closest("form")!);

    expect(onStart).not.toHaveBeenCalled();
  });

  it("invalidates controls captured before dictation became active", async () => {
    const onStart = vi.fn(async () => {});
    const reason = "Dictation is active. Finish it before starting a meeting.";
    const view = render(
      <ConsentDialog open onOpenChange={vi.fn()} onStart={onStart} />,
    );
    const staleStart = screen.getByRole("button", { name: "Start Meeting" });
    const staleForm = staleStart.closest("form")!;

    view.rerender(
      <ConsentDialog
        open
        onOpenChange={vi.fn()}
        onStart={onStart}
        startBlockedReason={reason}
      />,
    );
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Meeting" })).toBeDisabled();

    fireEvent.click(staleStart);
    fireEvent.submit(staleForm);
    expect(onStart).not.toHaveBeenCalled();
  });
});
