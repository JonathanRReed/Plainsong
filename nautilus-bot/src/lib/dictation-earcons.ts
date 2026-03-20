type DictationEarcon = "start" | "success" | "error";

type EarconNote = {
  frequency: number;
  durationMs: number;
  gain: number;
  delayMs?: number;
};

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext ?? (window as Window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  if (!AudioContextCtor) {
    return null;
  }

  if (!sharedContext) {
    sharedContext = new AudioContextCtor();
  }

  return sharedContext;
}

function notesForEarcon(type: DictationEarcon): EarconNote[] {
  switch (type) {
    case "start":
      return [
        { frequency: 540, durationMs: 38, gain: 0.018 },
        { frequency: 720, durationMs: 52, gain: 0.022, delayMs: 36 },
      ];
    case "success":
      return [
        { frequency: 660, durationMs: 44, gain: 0.02 },
        { frequency: 930, durationMs: 70, gain: 0.024, delayMs: 44 },
      ];
    case "error":
      return [
        { frequency: 420, durationMs: 64, gain: 0.018 },
        { frequency: 300, durationMs: 96, gain: 0.015, delayMs: 52 },
      ];
  }
}

export async function playDictationEarcon(type: DictationEarcon): Promise<boolean> {
  const context = getAudioContext();
  if (!context) {
    return false;
  }

  try {
    if (context.state === "suspended") {
      await context.resume();
    }

    const startAt = context.currentTime + 0.01;
    const masterGain = context.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(context.destination);

    for (const note of notesForEarcon(type)) {
      const oscillator = context.createOscillator();
      const gainNode = context.createGain();
      const noteStart = startAt + (note.delayMs ?? 0) / 1000;
      const noteEnd = noteStart + note.durationMs / 1000;

      oscillator.type = type === "error" ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);

      gainNode.gain.setValueAtTime(0.0001, noteStart);
      gainNode.gain.exponentialRampToValueAtTime(note.gain, noteStart + 0.012);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

      oscillator.connect(gainNode);
      gainNode.connect(masterGain);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.02);
    }

    return true;
  } catch {
    return false;
  }
}
