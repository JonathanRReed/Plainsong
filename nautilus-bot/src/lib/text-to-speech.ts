interface SpeakTextOptions {
  onEnd?: () => void;
  onError?: () => void;
  rate?: number;
  pitch?: number;
  lang?: string;
}

type SpeechSynthesisLike = Pick<SpeechSynthesis, "cancel" | "speak">;
type SpeechSynthesisUtteranceCtor = new (text?: string) => SpeechSynthesisUtterance;

function getSpeechSynthesisApi(): SpeechSynthesisLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  const synth = window.speechSynthesis;
  if (!synth || typeof synth.speak !== "function" || typeof synth.cancel !== "function") {
    return null;
  }

  return synth;
}

function getUtteranceConstructor(): SpeechSynthesisUtteranceCtor | null {
  if (typeof window !== "undefined" && "SpeechSynthesisUtterance" in window) {
    return window.SpeechSynthesisUtterance as SpeechSynthesisUtteranceCtor;
  }

  if (typeof globalThis !== "undefined" && "SpeechSynthesisUtterance" in globalThis) {
    return globalThis.SpeechSynthesisUtterance as SpeechSynthesisUtteranceCtor;
  }

  return null;
}

export function canSpeakTextAloud() {
  return !!getSpeechSynthesisApi() && !!getUtteranceConstructor();
}

export function stopSpeakingText() {
  const synth = getSpeechSynthesisApi();
  synth?.cancel();
}

export function speakTextAloud(text: string, options: SpeakTextOptions = {}) {
  const trimmed = text.trim();
  const synth = getSpeechSynthesisApi();
  const Utterance = getUtteranceConstructor();
  if (!trimmed || !synth || !Utterance) {
    return false;
  }

  const utterance = new Utterance(trimmed);
  utterance.rate = options.rate ?? 1;
  utterance.pitch = options.pitch ?? 1;
  if (options.lang) {
    utterance.lang = options.lang;
  }

  utterance.onend = () => {
    options.onEnd?.();
  };
  utterance.onerror = () => {
    options.onError?.();
    options.onEnd?.();
  };

  synth.cancel();
  synth.speak(utterance);
  return true;
}
