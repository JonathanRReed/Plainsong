/**
 * A live microphone level, measured in the renderer.
 *
 * The onboarding microphone step and the Settings microphone test both open
 * the mic with getUserMedia and read its loudness through an AnalyserNode.
 * This is that measurement, once: it never records or transcribes, and it
 * releases the device the moment the caller stops it or unmounts.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Why the microphone could not be opened, in terms the reader can act on. */
export type MicErrorKind = "denied" | "no-device" | "busy" | "unavailable";

/** The level (0..1) that counts as someone speaking rather than room noise. */
export const MIC_HEARD_LEVEL = 0.35;
/** How long, in total, the level has to stay above that before we say so. */
export const MIC_HEARD_AFTER_MS = 300;

// The meter spans the useful range of speech: -60 dBFS (a quiet room) reads
// as empty, 0 dBFS as full.
const FLOOR_DB = -60;

/** Loudness of one analyser frame, as 0..1 on a decibel scale. */
export function levelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  const rms = Math.sqrt(sum / samples.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Rise fast and fall slowly, like a VU meter. Without it the bars flicker
 * between syllables and the reader cannot tell whether they are being heard.
 */
export function smoothLevel(previous: number, next: number): number {
  const rate = next > previous ? 0.55 : 0.12;
  return previous + (next - previous) * rate;
}

/** Add this frame's time to the running total of time spent above the line. */
export function accumulateHeardMs(total: number, level: number, elapsedMs: number): number {
  return level >= MIC_HEARD_LEVEL ? total + Math.max(0, elapsedMs) : total;
}

/**
 * Map a getUserMedia failure to what the reader can do about it.
 *
 * Chromium names these errors after the spec; older builds and Electron's
 * own paths still use the legacy names, so both are accepted.
 */
export function classifyMicError(error: unknown): MicErrorKind {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "unavailable";
  }
}

/** One sentence per failure: what happened, then what to do. */
export function micErrorMessage(kind: MicErrorKind): string {
  switch (kind) {
    case "denied":
      return "Plainsong is not allowed to use the microphone. Turn it on in System Settings > Privacy & Security > Microphone, then try again.";
    case "no-device":
      return "No microphone found. Connect one or choose another microphone, then try again.";
    case "busy":
      return "The microphone is in use by another app. Quit that app or choose another microphone, then try again.";
    default:
      return "The microphone could not start. Check that it is connected, then try again.";
  }
}

/** A microphone as Plainsong's settings name it. */
export type MicDevicePreference = {
  deviceId: string;
  deviceName?: string | null;
};

/**
 * Find the browser's id for a microphone the settings chose.
 *
 * Settings store the Core Audio device id, which the browser does not share.
 * Once the reader has granted access the browser exposes device labels, so
 * the name is matched instead; before that, the stored id is passed as a
 * hint and the system default answers.
 */
async function resolveCaptureDeviceId(
  preference: MicDevicePreference | null | undefined,
): Promise<string | null> {
  if (!preference?.deviceId) {
    return null;
  }
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput",
    );
    const name = preference.deviceName?.trim().toLowerCase();
    const match =
      inputs.find((device) => device.deviceId === preference.deviceId) ??
      (name
        ? inputs.find((device) => device.label.trim().toLowerCase().startsWith(name))
        : undefined);
    return match?.deviceId ?? preference.deviceId;
  } catch {
    return preference.deviceId;
  }
}

export type MicLevelState = "idle" | "starting" | "live" | "error";

export function useMicLevel() {
  const [state, setState] = useState<MicLevelState>("idle");
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [error, setError] = useState<MicErrorKind | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  // Bumped by every start and stop, so a getUserMedia that resolves after the
  // reader moved on releases its stream instead of reviving the meter.
  const generationRef = useRef(0);

  const release = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    release();
    setState("idle");
    setLevel(0);
  }, [release]);

  const start = useCallback(
    async (device?: MicDevicePreference | null) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      release();
      setState("starting");
      setError(null);
      setLevel(0);
      setHeard(false);
      try {
        const deviceId = await resolveCaptureDeviceId(device);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
          video: false,
        });
        if (generation !== generationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const context = new AudioContext();
        contextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);

        let smoothed = 0;
        let shown = -1;
        let heardMs = 0;
        let latched = false;
        let lastTime = performance.now();
        const tick = (now: number) => {
          analyser.getFloatTimeDomainData(samples);
          const raw = levelFromSamples(samples);
          smoothed = smoothLevel(smoothed, raw);
          heardMs = accumulateHeardMs(heardMs, raw, now - lastTime);
          lastTime = now;
          // Only re-render when the meter would visibly change.
          const rounded = Math.round(smoothed * 100);
          if (rounded !== shown) {
            shown = rounded;
            setLevel(rounded / 100);
          }
          if (!latched && heardMs >= MIC_HEARD_AFTER_MS) {
            latched = true;
            setHeard(true);
          }
          frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
        setState("live");
      } catch (caught) {
        if (generation !== generationRef.current) {
          return;
        }
        release();
        setError(classifyMicError(caught));
        setState("error");
      }
    },
    [release],
  );

  useEffect(
    () => () => {
      generationRef.current += 1;
      release();
    },
    [release],
  );

  const getStream = useCallback(() => streamRef.current, []);

  return { state, level, heard, error, start, stop, getStream };
}
