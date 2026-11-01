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
  let readyStateSpy: ReturnType<typeof vi.spyOn>;
  let durationSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    backendMocks.prepareRecordingPlayback.mockReset();
    backendMocks.releaseRecordingPlayback.mockClear();
    eventMocks.listeners.clear();
    readyStateSpy = vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
    durationSpy = vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(90);
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
    readyStateSpy.mockRestore();
    durationSpy.mockRestore();
  });

  it("prepares a token on mount, points the element at its URL, and releases on unmount", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    const { unmount } = render(<AudioPlayer recordingId="rec-1" waveform={[]} />);

    expect(backendMocks.prepareRecordingPlayback).toHaveBeenCalledWith("rec-1");
    await waitFor(() => {
      expect(screen.getByTestId("meeting-audio").getAttribute("src")).toBe(`plainsong://playback/${TOKEN}`);
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

  it("retries failed preparation only when requested and does not autoplay", async () => {
    backendMocks.prepareRecordingPlayback
      .mockRejectedValueOnce(new Error("Vault is locked."))
      .mockResolvedValueOnce(prepared("rec-1"));
    render(<AudioPlayer recordingId="rec-1" waveform={[]} />);
    const retry = await screen.findByRole("button", { name: "Retry audio" });
    expect(backendMocks.prepareRecordingPlayback).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeEnabled());
    expect(backendMocks.prepareRecordingPlayback).toHaveBeenCalledTimes(2);
    expect(backendMocks.prepareRecordingPlayback).toHaveBeenLastCalledWith("rec-1");
    expect(screen.queryByRole("button", { name: "Retry audio" })).not.toBeInTheDocument();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("releases revoked audio and isolates old media events during a retry of the same recording", async () => {
    let resolveRetry!: (value: ReturnType<typeof prepared>) => void;
    backendMocks.prepareRecordingPlayback
      .mockResolvedValueOnce(prepared("rec-1"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    readyStateSpy.mockReturnValue(0);
    const ref = createRef<AudioPlayerHandle>();
    const onTimeUpdate = vi.fn();
    const onError = vi.fn();
    render(<AudioPlayer ref={ref} recordingId="rec-1" waveform={[]} onTimeUpdate={onTimeUpdate} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeEnabled());
    const oldAudio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    act(() => ref.current?.seekTo(40));
    act(() => eventMocks.listeners.get("recording-playback-revoked")!({ payload: { token: TOKEN } }));
    onError.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry audio" }));
    expect(backendMocks.releaseRecordingPlayback).toHaveBeenCalledWith(TOKEN);
    oldAudio.currentTime = 40;
    fireEvent.timeUpdate(oldAudio);
    fireEvent.error(oldAudio);
    fireEvent.play(oldAudio);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    await act(async () => resolveRetry({ ...prepared("rec-1"), token: "retry", url: "plainsong://playback/retry" }));
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    readyStateSpy.mockReturnValue(1);
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    expect(playSpy).not.toHaveBeenCalled();
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

  it("keeps the latest transcript cue through preparation and clamps after metadata without playing", async () => {
    let resolvePrepare!: (value: ReturnType<typeof prepared>) => void;
    backendMocks.prepareRecordingPlayback.mockImplementation(() => new Promise((resolve) => {
      resolvePrepare = resolve;
    }));
    readyStateSpy.mockReturnValue(0);
    durationSpy.mockReturnValue(Number.NaN);
    const ref = createRef<AudioPlayerHandle>();
    render(<AudioPlayer ref={ref} recordingId="rec-1" waveform={[]} durationHint={20} />);
    act(() => {
      ref.current?.seekTo(15);
      ref.current?.seekTo(80);
      ref.current?.seekTo(Number.NaN);
    });
    await act(async () => resolvePrepare(prepared("rec-1")));
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(0);
    readyStateSpy.mockReturnValue(1);
    durationSpy.mockReturnValue(60);
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(60);
    expect(screen.getByText("1:00 / 1:00")).toBeInTheDocument();
    expect(playSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.currentTime).toBe(60);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("accumulates relative cues while metadata is loading without playing", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue({
      token: "relative-cue", url: "plainsong://playback/relative-cue", durationSeconds: 90,
    });
    readyStateSpy.mockReturnValue(0);
    const ref = createRef<AudioPlayerHandle>();
    const { container } = render(<AudioPlayer ref={ref} recordingId="r1" waveform={[]} />);
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const audio = container.querySelector("audio")!;
    act(() => {
      ref.current!.seekTo(20);
      ref.current!.seekBy(5);
      ref.current!.seekBy(-2);
    });
    expect(audio.currentTime).toBe(0);
    readyStateSpy.mockReturnValue(1);
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(23);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("applies a cue waiting for metadata without changing playback intent", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    const ref = createRef<AudioPlayerHandle>();
    render(<AudioPlayer ref={ref} recordingId="rec-1" waveform={[]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeEnabled());
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    readyStateSpy.mockReturnValue(0);
    act(() => ref.current?.seekTo(25));
    readyStateSpy.mockReturnValue(1);
    fireEvent.canPlay(audio);
    expect(audio.currentTime).toBe(25);
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    readyStateSpy.mockReturnValue(0);
    act(() => ref.current?.seekTo(35));
    readyStateSpy.mockReturnValue(1);
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(35);
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("drops a loading cue when the recording changes and ignores old audio events", async () => {
    backendMocks.prepareRecordingPlayback
      .mockResolvedValueOnce(prepared("rec-1"))
      .mockResolvedValueOnce({ ...prepared("rec-2"), token: "second", url: "plainsong://playback/second" });
    readyStateSpy.mockReturnValue(0);
    const ref = createRef<AudioPlayerHandle>();
    const onTimeUpdate = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(<AudioPlayer ref={ref} recordingId="rec-1" waveform={[]} onTimeUpdate={onTimeUpdate} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeEnabled());
    const oldAudio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    act(() => ref.current?.seekTo(42));
    rerender(<AudioPlayer ref={ref} recordingId="rec-2" waveform={[]} onTimeUpdate={onTimeUpdate} onError={onError} />);
    await waitFor(() => expect(screen.getByTestId("meeting-audio")).toHaveAttribute("src", "plainsong://playback/second"));
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    readyStateSpy.mockReturnValue(1);
    fireEvent.loadedMetadata(audio);
    oldAudio.currentTime = 42;
    fireEvent.timeUpdate(oldAudio);
    fireEvent.error(oldAudio);
    fireEvent.play(oldAudio);
    expect(audio.currentTime).toBe(0);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("handles each scrubber arrow key once and clamps at the endpoints", async () => {
    backendMocks.prepareRecordingPlayback.mockResolvedValue(prepared("rec-1"));
    render(<AudioPlayer recordingId="rec-1" waveform={[]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeEnabled());
    const slider = screen.getByRole("slider", { name: "Playback position" });
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(5);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(0);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(0);
    fireEvent.change(slider, { target: { value: "89" } });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(90);
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
