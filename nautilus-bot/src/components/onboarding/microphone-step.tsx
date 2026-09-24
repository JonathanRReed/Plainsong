import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OptionSelect } from "@/components/settings/option-select";
import { CheckCircle2, Loader2, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MicLevelMeter } from "@/components/onboarding/mic-level-meter";
import {
  micErrorMessage,
  useMicLevel,
  type MicErrorKind,
} from "@/hooks/use-mic-level";
import {
  listAudioInputDevices,
  type AudioInputDeviceInfo,
} from "@/lib/backend/recordings";
import { getSettings, saveSettings } from "@/lib/backend/settings";
import type { Settings } from "@/types/settings";

type DevicePreference = Settings["audio"]["preferredInputDevice"];

/** How long to wait in silence before suggesting the reader check the mic. */
const QUIET_HINT_AFTER_MS = 6000;

const ERROR_TITLES: Record<MicErrorKind, string> = {
  denied: "Microphone access is off",
  "no-device": "No microphone found",
  busy: "In use by another app",
  unavailable: "The microphone did not start",
};

/**
 * Dictation listens through the whole-app microphone unless Settings has a
 * dictation-only override switched on. The picker here writes whichever of
 * the two dictation will actually use, the same fields the Settings pickers
 * write, so the two screens never disagree.
 */
function dictationDevice(settings: Settings): DevicePreference {
  return settings.audio.dictationInputOverrideEnabled
    ? settings.audio.dictationInputDevice ?? null
    : settings.audio.preferredInputDevice ?? null;
}

function toPreference(device: AudioInputDeviceInfo | undefined): DevicePreference {
  return device
    ? {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        transportType: device.transportType ?? null,
      }
    : null;
}

/**
 * The live microphone check: bars that rise as the reader talks, a picker to
 * switch microphones, and a named reason when the mic cannot open.
 *
 * It measures in the renderer only. Nothing is recorded or kept, and the
 * device is released as soon as the reader leaves this step.
 */
export function MicrophoneStep({
  onHeard,
  onOpenMicrophoneSettings,
}: {
  /** Called once the reader has been heard, with the microphone's name. */
  onHeard(deviceName: string | null): void;
  onOpenMicrophoneSettings(): void;
}) {
  const pickerId = useId();
  const mic = useMicLevel();
  const { start, state, level, heard, error } = mic;
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [selected, setSelected] = useState<DevicePreference>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  const selectedRef = useRef<DevicePreference>(null);
  selectedRef.current = selected;

  // Settings first, then the device list: the meter opens on the microphone
  // dictation will really use, not whatever the system default happens to be.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [settings, inventory] = await Promise.all([
        getSettings().catch(() => null),
        listAudioInputDevices().catch(() => null),
      ]);
      if (!active) {
        return;
      }
      const available = inventory?.devices.filter((device) => device.isAvailable !== false) ?? [];
      setDevices(available);
      const configured = settings ? dictationDevice(settings) : null;
      // A saved microphone that is unplugged now falls back to the default,
      // which is what dictation itself does.
      const current =
        configured && available.some((device) => device.deviceId === configured.deviceId)
          ? configured
          : null;
      setSelected(current);
      setLoaded(true);
      void start(current);
    })();
    return () => {
      active = false;
    };
  }, [start]);

  const defaultDevice = devices.find((device) => device.isDefault);
  const listeningName = selected?.deviceName ?? defaultDevice?.deviceName ?? null;

  useEffect(() => {
    if (heard) {
      onHeard(listeningName);
    }
    // Report the device the reader was heard on, once, when it happens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard]);

  useEffect(() => {
    setQuiet(false);
    if (state !== "live" || heard) {
      return;
    }
    const timer = window.setTimeout(() => setQuiet(true), QUIET_HINT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [heard, state]);

  const chooseDevice = useCallback(
    async (deviceId: string) => {
      const next = toPreference(devices.find((device) => device.deviceId === deviceId));
      setSelected(next);
      setSaveError(null);
      void start(next);
      try {
        // Read fresh and change only the one field: saveSettings replaces the
        // whole struct, and other steps save while this one is open.
        const settings = await getSettings();
        if (settings.audio.dictationInputOverrideEnabled) {
          settings.audio.dictationInputDevice = next;
        } else {
          settings.audio.preferredInputDevice = next;
        }
        await saveSettings(settings);
      } catch (caught) {
        setSaveError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [devices, start],
  );

  const retry = useCallback(() => {
    void start(selectedRef.current);
  }, [start]);

  return (
    <div className="space-y-5">
      <p className="max-w-xl text-sm text-muted-foreground">
        Say a few words, like you would to a colleague. The bars should rise
        while you talk. Nothing is recorded on this step.
      </p>

      <div
        className={`rounded-xl border p-6 transition-colors motion-reduce:transition-none ${
          heard ? "border-gold/40 bg-gold/5" : "border-border bg-muted/20"
        }`}
      >
        <MicLevelMeter level={level} active={state === "live"} />

        <div className="mt-4 flex min-h-12 flex-col items-center text-center" role="status" aria-live="polite">
          {state === "error" && error ? (
            <>
              <p className="flex items-center gap-2 font-serif text-lg font-semibold text-rust">
                <MicOff className="h-4 w-4" aria-hidden="true" />
                {ERROR_TITLES[error]}
              </p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {micErrorMessage(error)}
              </p>
            </>
          ) : heard ? (
            <>
              <p className="flex items-center gap-2 font-serif text-lg font-semibold text-gold-text">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                We hear you
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {listeningName
                  ? `${listeningName} is working. Continue when you are ready.`
                  : "Your microphone is working. Continue when you are ready."}
              </p>
            </>
          ) : state === "live" ? (
            <>
              <p className="font-serif text-lg font-semibold">Listening</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {quiet
                  ? "Nothing yet. Check that the right microphone is selected below and that it is not muted."
                  : listeningName
                    ? `Using ${listeningName}.`
                    : "Using the system default microphone."}
              </p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Opening the microphone. macOS may ask for permission.
            </p>
          )}
        </div>

        {state === "error" ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
            {error === "denied" ? (
              <Button size="sm" variant="outline" onClick={onOpenMicrophoneSettings}>
                Open System Settings
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <label htmlFor={pickerId} className="text-sm font-medium">
          Microphone
        </label>
        <OptionSelect
          id={pickerId}
          value={selected?.deviceId ?? ""}
          disabled={!loaded}
          onValueChange={(value) => void chooseDevice(value)}
        >
          <option value="">
            {defaultDevice
              ? `System default (${defaultDevice.deviceName})`
              : "System default"}
          </option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.deviceName}
            </option>
          ))}
          {/* A saved microphone that is unplugged still reads as chosen,
              rather than as an empty box. */}
          {selected && !devices.some((device) => device.deviceId === selected.deviceId) ? (
            <option value={selected.deviceId}>{`${selected.deviceName} (not connected)`}</option>
          ) : null}
        </OptionSelect>
        <p className="text-xs text-muted-foreground">
          Dictation uses this microphone. You can change it later in Settings.
        </p>
        {saveError ? (
          <p className="text-xs text-destructive" role="alert">
            Couldn&apos;t save the microphone choice: {saveError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
