import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer, type AudioPlayerHandle } from "@/components/meetings/audio-player";

const TOKEN = "0123456789abcdef0123456789abcdef";

const backendMocks = vi.hoisted(() => ({
  prepareRecordingPlayback: vi.fn(),
  releaseRecordingPlayback: vi.fn(async () => {}),
}));

vi.mock("@/lib/backend/recordings", () => backendMocks);

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => void>(),
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    eventMocks.listeners.set(eventName, handler);
    return () => {
      eventMocks.listeners.delete(eventName);
    };
  }),
  invoke: vi.fn(),
}));

vi.mock("@/components/waveform-visualizer", () => ({
  WaveformVisualizer: () => <div data-testid="waveform" />,
}));

function prepared(recordingId: string) {
  return {
    token: TOKEN,
    url: `plainsong://playback/${TOKEN}`,
    recordingId,
    protection: "plaintext" as const,
    durationSeconds: 90,
  };
}

describe("AudioPlayer", () => {
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    backendMocks.prepareRecordingPlayback.mockReset();
    backendMocks.releaseRecordingPlayback.mockClear();
    eventMocks.listeners.clear();
    // jsdom has no media pipeline: play/pause are stubbed to fire the events a
    // real element would, which is what the player's state follows.
    playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play(
      this: HTMLMediaElement
    ) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function pause(
      this: HTMLMediaElement
    ) {
      this.dispatchEvent(new Event("pause"));
    });
  });

  afterEach(() => {
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });

  it("prepares a token on mount, points the element at its URL, and releases on unmount", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    const { unmount } = render(<AudioPlayer recordingId="rec-1" waveform={[]} />);

    expect(backendMocks.prepareRecordingPlayback).toHaveBeenCalledWith("rec-1");
    const audio = (await screen.findByTestId("meeting-audio")) as HTMLAudioElement;
    await waitFor(() => {
      expect(audio.getAttribute("src")).toBe(`plainsong://playback/${TOKEN}`);
    });
    // Duration comes from the prepare answer until the element reports its own.
    expect(screen.getByText("0:00 / 1:30")).toBeInTheDocument();

    unmount();
    expect(backendMocks.releaseRecordingPlayback).toHaveBeenCalledWith(TOKEN);
  });

  it("releases the old token and prepares the new one when the meeting changes", async () => {
    backendMocks.prepareRecordingPlayback
      .mockResolvedValueOnce(prepared("rec-1"))
      .mockResolvedValueOnce({ ...prepared("rec-2"), token: TOKEN.replace(/0/g, "9") });
    const { rerender } = render(<AudioPlayer recordingId="rec-1" waveform={[]} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });

    rerender(<AudioPlayer recordingId="rec-2" waveform={[]} />);
    expect(backendMocks.releaseRecordingPlayback).toHaveBeenCalledWith(TOKEN);
    await waitFor(() => {
      expect(backendMocks.prepareRecordingPlayback).toHaveBeenLastCalledWith("rec-2");
    });
  });

  it("reports the sidecar's refusal verbatim and issues no token", async () => {
    backendMocks.prepareRecordingPlayback.mockRejectedValue(
      new Error("Vault is locked. Unlock vault before opening encrypted recordings.")
    );
    const onError = vi.fn();
    const { unmount } = render(
      <AudioPlayer recordingId="rec-1" waveform={[]} onError={onError} />
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        "Vault is locked. Unlock vault before opening encrypted recordings."
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("Vault is locked.");
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    unmount();
    // Nothing to release: no token was ever issued.
    expect(backendMocks.releaseRecordingPlayback).not.toHaveBeenCalled();
  });

  it("toggles play and pause from the button and from Space over the player", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    render(<AudioPlayer recordingId="rec-1" waveform={[]} />);
    const play = await screen.findByRole("button", { name: "Play" });
    await waitFor(() => expect(play).toBeEnabled());

    fireEvent.click(play);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Pause" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.keyDown(screen.getByRole("group", { name: "Audio player" }), { key: " " });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("seeks from the transcript through the handle and reports the new time", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    const onTimeUpdate = vi.fn();
    const ref = createRef<AudioPlayerHandle>();
    render(
      <AudioPlayer ref={ref} recordingId="rec-1" waveform={[]} onTimeUpdate={onTimeUpdate} />
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;

    act(() => {
      ref.current?.seekTo(42.5);
    });
    expect(audio.currentTime).toBe(42.5);
    expect(screen.getByText("0:42 / 1:30")).toBeInTheDocument();
    // The transcript learns the position from the element's own event, the
    // way a real browser reports a seek, not from the seek call.
    expect(onTimeUpdate).not.toHaveBeenCalled();
    fireEvent.timeUpdate(audio);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(42.5);

    act(() => {
      ref.current?.seekBy(-5);
    });
    expect(audio.currentTime).toBe(37.5);

    // Past the end clamps to the duration; before the start clamps to zero.
    act(() => {
      ref.current?.seekTo(500);
    });
    expect(audio.currentTime).toBe(90);
    act(() => {
      ref.current?.seekTo(-10);
    });
    expect(audio.currentTime).toBe(0);
  });

  it("cycles the speed 1× → 1.5× → 2× and applies it to the element", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    render(<AudioPlayer recordingId="rec-1" waveform={[]} />);
    const speed = await screen.findByRole("button", { name: "Playback speed 1 times" });
    await waitFor(() => expect(speed).toBeEnabled());
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;

    fireEvent.click(speed);
    expect(screen.getByRole("button", { name: "Playback speed 1.5 times" })).toHaveTextContent(
      "1.5×"
    );
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1.5 times" }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 2 times" }));
    expect(audio.playbackRate).toBe(1);
  });

  it("stops and explains when the sidecar revokes the token", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    const onError = vi.fn();
    render(<AudioPlayer recordingId="rec-1" waveform={[]} onError={onError} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByRole("button", { name: "Pause" });

    const revoke = eventMocks.listeners.get("recording-playback-revoked");
    expect(revoke).toBeDefined();
    act(() => {
      revoke!({ payload: { token: "not-this-one", reason: "vault_locked" } });
    });
    // A revoke for some other token is not ours.
    expect(onError).not.toHaveBeenCalled();

    act(() => {
      revoke!({ payload: { token: TOKEN, recordingId: "rec-1", reason: "vault_locked" } });
    });
    expect(pauseSpy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("vault was locked"));
    expect(screen.getByRole("status")).toHaveTextContent("vault was locked");
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });
});
