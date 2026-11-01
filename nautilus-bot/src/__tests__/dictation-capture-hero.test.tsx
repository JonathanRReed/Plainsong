import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DictationCaptureHero } from "@/components/views/dictation/dictation-capture-hero";

vi.mock("@/hooks/use-dictation-level", () => ({ useDictationLevel: () => 0 }));
const props: ComponentProps<typeof DictationCaptureHero> = {
  compact: true, phase: "idle", phaseTitle: "Ready", phaseDetail: "Start dictation.",
  phaseTone: "idle", isCaptureLive: false, isBusy: false, isAvailable: true,
  unavailableTitle: "Checking setup", unavailableDetail: "Checking the selected model.",
  unavailableActionLabel: "Re-check", unavailableActionBusy: false, unavailableRole: "status",
  formattedDuration: "0:00", hotkeyInstruction: "Press the shortcut.", hotkeyPressed: false,
  livePreview: null, activeProfileTitle: "General", resolvedModeLabel: null,
  smartContextSummary: "Current app", isReadingSelectedText: false,
  onStart: vi.fn(), onStop: vi.fn(), onReadSelectedText: vi.fn(), onUnavailableAction: vi.fn(),
};

describe("capture readiness refresh layout", () => {
  it("keeps returning users compact while checking and disables capture", () => {
    const view = render(<DictationCaptureHero {...props} />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(hero).toHaveAttribute("data-layout", "compact");
    view.rerender(<DictationCaptureHero {...props} isAvailable={false} />);
    expect(screen.getByTestId("dictation-capture-hero")).toBe(hero);
    expect(hero).toHaveAttribute("data-layout", "compact");
    expect(hero).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(hero).not.toHaveClass("border-rust/30");
    view.rerender(<DictationCaptureHero {...props} />);
    expect(hero).toHaveAttribute("data-layout", "compact");
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeEnabled();
  });

  it("keeps a setup blocker compact and actionable", () => {
    render(<DictationCaptureHero {...props} isAvailable={false} unavailableRole="alert" unavailableTitle="Microphone permission needed" unavailableDetail="Allow microphone access in System Settings." unavailableActionLabel="Open permissions" />);
    const hero = screen.getByTestId("dictation-capture-hero");
    expect(hero).toHaveAttribute("data-layout", "compact");
    expect(hero).toHaveAttribute("role", "alert");
    expect(hero).toHaveClass("border-rust/30");
    expect(screen.getByText("Allow microphone access in System Settings.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open permissions" })).toBeEnabled();
  });

  it("keeps a missing model compact with its download action", () => {
    const download = vi.fn();
    render(<DictationCaptureHero {...props} compact={false} isAvailable={false} unavailableRole="alert" unavailableTitle="Speech model needed" unavailableDetail="Download a speech model to dictate." unavailableActionLabel="Download model" onUnavailableAction={download} />);
    expect(screen.getByRole("alert")).toHaveAttribute("data-layout", "compact");
    expect(screen.getByText("Download a speech model to dictate.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Download model" }));
    expect(download).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: "recording" as const, isCaptureLive: true, isBusy: false, phaseTone: "active" as const },
    { phase: "transcribing" as const, isCaptureLive: false, isBusy: true, phaseTone: "active" as const },
    { phase: "delivering" as const, isCaptureLive: false, isBusy: true, phaseTone: "active" as const },
    { phase: "error" as const, isCaptureLive: false, isBusy: false, phaseTone: "error" as const },
  ])("keeps $phase expanded", (state) => {
    render(<DictationCaptureHero {...props} {...state} isAvailable={false} />);
    expect(screen.getByTestId("dictation-capture-hero")).toHaveAttribute("data-layout", "full");
  });

  it("keeps initial setup checks compact before the first dictation", () => {
    render(<DictationCaptureHero {...props} compact={false} isAvailable={false} />);
    expect(screen.getByTestId("dictation-capture-hero")).toHaveAttribute("data-layout", "compact");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});


describe("speech model access", () => {
  it("opens model selection from a ready capture panel", () => {
    const choose = vi.fn();
    render(<DictationCaptureHero {...props} speechModelLabel="Parakeet" onChooseSpeechModel={choose} />);
    fireEvent.click(screen.getByRole("button", { name: "Change speech model" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "recording" as const, isCaptureLive: true, isBusy: false },
    { phase: "transcribing" as const, isCaptureLive: false, isBusy: true },
  ])("prevents changing the model during $phase", (state) => {
    const choose = vi.fn();
    render(<DictationCaptureHero {...props} {...state} speechModelLabel="Parakeet" onChooseSpeechModel={choose} />);
    const button = screen.getByRole("button", { name: "Change speech model" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(choose).not.toHaveBeenCalled();
  });
});

describe("processing cancellation", () => {
  it("keeps the existing disabled processing control when no cancel callback is provided", () => {
    render(
      <DictationCaptureHero
        {...props}
        phase="transcribing"
        phaseTitle="Transcribing"
        phaseDetail="Turning speech into text."
        phaseTone="active"
        isBusy
      />,
    );

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel dictation" })).not.toBeInTheDocument();
  });

  it.each(["stopping", "transcribing"] as const)(
    "allows the current %s work to be cancelled",
    (phase) => {
      const cancel = vi.fn();
      render(
        <DictationCaptureHero
          {...props}
          phase={phase}
          phaseTitle={phase === "stopping" ? "Stopping capture" : "Transcribing"}
          phaseDetail="Finishing the current dictation."
          phaseTone="active"
          isBusy
          onCancelProcessing={cancel}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("disables the cancel control while cancellation is pending and shows a failure", () => {
    const cancel = vi.fn();
    render(
      <DictationCaptureHero
        {...props}
        phase="transcribing"
        phaseTitle="Transcribing"
        phaseDetail="Turning speech into text."
        phaseTone="active"
        isBusy
        onCancelProcessing={cancel}
        processingCancelling
        processingCancelError="Could not cancel this dictation. Try again."
      />,
    );

    const button = screen.getByRole("button", { name: "Cancelling…" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not cancel this dictation. Try again.",
    );
  });

  it("keeps delivery non-cancellable", () => {
    const cancel = vi.fn();
    render(
      <DictationCaptureHero
        {...props}
        phase="delivering"
        phaseTitle="Inserting"
        phaseDetail="Inserting the result."
        phaseTone="active"
        isBusy
        onCancelProcessing={cancel}
      />,
    );

    expect(screen.getByRole("button", { name: "Inserting…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel dictation" })).not.toBeInTheDocument();
  });
});

describe("dictation meeting separation", () => {
  it.each(["idle", "done", "error"] as const)(
    "shows a disabled meeting-owned control during %s",
    (phase) => {
      const start = vi.fn();
      render(
        <DictationCaptureHero
          {...props}
          phase={phase}
          phaseTone={phase === "error" ? "error" : "idle"}
          onStart={start}
          startBlockedReason="Stop the meeting before starting dictation."
        />,
      );

      const blocked = screen.getByRole("button", { name: "Meeting in progress" });
      expect(blocked).toBeDisabled();
      expect(blocked).toHaveAttribute(
        "title",
        "Stop the meeting before starting dictation.",
      );
      fireEvent.click(blocked);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("suppresses the unavailable setup action while a meeting owns capture", () => {
    const setup = vi.fn();
    render(
      <DictationCaptureHero
        {...props}
        isAvailable={false}
        unavailableRole="alert"
        unavailableActionLabel="Open permissions"
        onUnavailableAction={setup}
        startBlockedReason="Stop the meeting before starting dictation."
      />,
    );

    expect(screen.queryByRole("button", { name: "Open permissions" })).not.toBeInTheDocument();
    const blocked = screen.getByRole("button", { name: "Meeting in progress" });
    expect(blocked).toBeDisabled();
    fireEvent.click(blocked);
    expect(setup).not.toHaveBeenCalled();
  });
});

describe("capture phase announcements", () => {
  it("announces the phase title politely but keeps the running timer out of it", () => {
    const view = render(<DictationCaptureHero {...props} phase="recording" phaseTitle="Listening" phaseTone="active"
      isCaptureLive formattedDuration="0:07" />);
    const title = screen.getByText("Listening");
    expect(title).toHaveAttribute("aria-live", "polite");
    expect(title).toHaveAttribute("aria-atomic", "true");
    expect(title).not.toHaveTextContent("0:07");
    view.rerender(<DictationCaptureHero {...props} phase="transcribing" phaseTitle="Transcribing" phaseTone="active"
      isBusy />);
    expect(screen.getByText("Transcribing")).toBe(title);
  });
});
