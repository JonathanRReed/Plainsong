import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrophoneStep } from "@/components/onboarding/microphone-step";

type TestSettings = {
  audio: {
    preferredInputDevice: { deviceId: string; deviceName: string } | null;
    dictationInputOverrideEnabled?: boolean;
    dictationInputDevice?: { deviceId: string; deviceName: string } | null;
  };
};

let currentSettings: TestSettings;

vi.mock("@/lib/backend/settings", () => ({
  getSettings: vi.fn(async () => structuredClone(currentSettings)),
  saveSettings: vi.fn(async (next: TestSettings) => {
    currentSettings = structuredClone(next);
  }),
}));

vi.mock("@/lib/backend/recordings", () => ({
  listAudioInputDevices: vi.fn(async () => ({
    devices: [
      {
        deviceId: "BuiltInMicrophoneDevice",
        deviceName: "MacBook Pro Microphone",
        transportType: "builtin",
        isDefault: true,
        isAvailable: true,
        isBluetoothLike: false,
      },
      {
        deviceId: "usb-podcast-mic",
        deviceName: "Podcast Mic",
        transportType: "usb",
        isDefault: false,
        isAvailable: true,
        isBluetoothLike: false,
      },
    ],
    dictationOverrideEnabled: false,
    meetingOverrideEnabled: false,
  })),
}));

const stopTrack = vi.fn();
const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

/** An analyser that always reads a steady tone at `amplitude`. */
function installFakeAudio(amplitude: number) {
  class FakeAudioContext {
    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData(samples: Float32Array) {
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = index % 2 === 0 ? amplitude : -amplitude;
          }
        },
      };
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

beforeEach(() => {
  currentSettings = { audio: { preferredInputDevice: null } };
  stopTrack.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: stopTrack, addEventListener: () => {} }],
  });
  enumerateDevices.mockReset();
  enumerateDevices.mockResolvedValue([]);
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: { getUserMedia, enumerateDevices },
  });
  let clock = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => {
      clock += 50;
      callback(clock);
    }, 5),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  installFakeAudio(0.2);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MicrophoneStep", () => {
  it("lists the microphones and says so once it hears the reader", async () => {
    const onHeardChange = vi.fn();
    render(<MicrophoneStep onHeardChange={onHeardChange} onOpenMicrophoneSettings={vi.fn()} />);

    const picker = await screen.findByLabelText("Microphone");
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: "System default (MacBook Pro Microphone)" }),
    ).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Podcast Mic" })).toBeInTheDocument();
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.getByRole("meter", { name: "Microphone level" })).toBeInTheDocument();

    expect(await screen.findByText("We hear you")).toBeInTheDocument();
    expect(onHeardChange).toHaveBeenLastCalledWith({ deviceName: "MacBook Pro Microphone" });
  });

  it("saves the chosen microphone where Settings keeps it and reopens on it", async () => {
    enumerateDevices.mockResolvedValue([
      { deviceId: "browser-podcast", kind: "audioinput", label: "Podcast Mic (USB)" },
    ]);
    render(<MicrophoneStep onHeardChange={vi.fn()} onOpenMicrophoneSettings={vi.fn()} />);

    const picker = await screen.findByLabelText("Microphone");
    await waitFor(() => expect(picker).toBeEnabled());
    await act(async () => {
      fireEvent.click(picker);
      const listbox = await screen.findByRole("listbox");
      fireEvent.click(within(listbox).getByRole("option", { name: "Podcast Mic" }));
    });

    await waitFor(() => {
      expect(currentSettings.audio.preferredInputDevice).toEqual({
        deviceId: "usb-podcast-mic",
        deviceName: "Podcast Mic",
        transportType: "usb",
      });
    });
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "browser-podcast" } },
      video: false,
    });
    expect(screen.queryByText(/can't be checked here/)).not.toBeInTheDocument();
    // The first stream was released before the second one opened.
    expect(stopTrack).toHaveBeenCalled();
  });

  it("takes back a heard check when the reader switches to a silent microphone", async () => {
    enumerateDevices.mockResolvedValue([
      { deviceId: "browser-podcast", kind: "audioinput", label: "Podcast Mic (USB)" },
    ]);
    const onHeardChange = vi.fn();
    render(<MicrophoneStep onHeardChange={onHeardChange} onOpenMicrophoneSettings={vi.fn()} />);
    expect(await screen.findByText("We hear you")).toBeInTheDocument();
    expect(onHeardChange).toHaveBeenLastCalledWith({ deviceName: "MacBook Pro Microphone" });

    installFakeAudio(0);
    const picker = screen.getByLabelText("Microphone");
    await act(async () => {
      fireEvent.click(picker);
      const listbox = await screen.findByRole("listbox");
      fireEvent.click(within(listbox).getByRole("option", { name: "Podcast Mic" }));
    });

    await waitFor(() => expect(onHeardChange).toHaveBeenLastCalledWith(null));
    expect(await screen.findByText("Using Podcast Mic.")).toBeInTheDocument();
    expect(screen.queryByText("We hear you")).not.toBeInTheDocument();
  });

  it("names the default, not the chosen microphone, when it can only open the default", async () => {
    const onHeardChange = vi.fn();
    render(<MicrophoneStep onHeardChange={onHeardChange} onOpenMicrophoneSettings={vi.fn()} />);
    await screen.findByText("We hear you");

    const picker = screen.getByLabelText("Microphone");
    await act(async () => {
      fireEvent.click(picker);
      const listbox = await screen.findByRole("listbox");
      fireEvent.click(within(listbox).getByRole("option", { name: "Podcast Mic" }));
    });

    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false });
    expect(
      await screen.findByText(/Podcast Mic can't be checked here, so this is the system default/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(onHeardChange).toHaveBeenLastCalledWith({ deviceName: "MacBook Pro Microphone" }),
    );
    expect(onHeardChange).not.toHaveBeenCalledWith({ deviceName: "Podcast Mic" });
  });

  it("writes the dictation-only microphone when that override is on", async () => {
    currentSettings = {
      audio: {
        preferredInputDevice: null,
        dictationInputOverrideEnabled: true,
        dictationInputDevice: null,
      },
    };
    render(<MicrophoneStep onHeardChange={vi.fn()} onOpenMicrophoneSettings={vi.fn()} />);

    const picker = await screen.findByLabelText("Microphone");
    await waitFor(() => expect(picker).toBeEnabled());
    await act(async () => {
      fireEvent.click(picker);
      const listbox = await screen.findByRole("listbox");
      fireEvent.click(within(listbox).getByRole("option", { name: "Podcast Mic" }));
    });

    await waitFor(() => {
      expect(currentSettings.audio.dictationInputDevice?.deviceId).toBe("usb-podcast-mic");
    });
    expect(currentSettings.audio.preferredInputDevice).toBeNull();
  });

  it.each([
    ["NotAllowedError", "Microphone access is off", /Privacy & Security > Microphone/],
    ["NotFoundError", "No microphone found", /Connect one or choose another microphone/],
    ["NotReadableError", "In use by another app", /in use by another app/],
  ])("names a %s failure", async (errorName, title, detail) => {
    getUserMedia.mockRejectedValue(new DOMException("failed", errorName));
    const onOpenMicrophoneSettings = vi.fn();
    render(
      <MicrophoneStep onHeardChange={vi.fn()} onOpenMicrophoneSettings={onOpenMicrophoneSettings} />,
    );

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    const settingsButton = screen.queryByRole("button", { name: "Open System Settings" });
    if (errorName === "NotAllowedError") {
      fireEvent.click(settingsButton!);
      expect(onOpenMicrophoneSettings).toHaveBeenCalledTimes(1);
    } else {
      expect(settingsButton).not.toBeInTheDocument();
    }
  });

  it("releases the microphone when the reader leaves the step", async () => {
    installFakeAudio(0);
    const { unmount } = render(
      <MicrophoneStep onHeardChange={vi.fn()} onOpenMicrophoneSettings={vi.fn()} />,
    );
    await screen.findByText("Listening");
    unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
});
