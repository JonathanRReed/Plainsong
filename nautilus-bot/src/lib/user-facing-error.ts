import { stripTransportPrefix } from "@/lib/meeting-start-error";

const TECHNICAL_DETAILS = [
  /\b(?:GPU|CPU|processor|GGUF|ONNX|CoreML|ANE|quantiz\w*|runtime|upstream|transducer|embedder|admission|headroom|loopback|panicked|sidecar)\b/i,
  /graphics chip|embedding extractor|process tap|core ?audio|\bos error\b|\bstatus -?\d{3,}\b/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|cannot read propert|is not a function|is not defined/i,
  /traceback \(most recent call last\)|(?:^|\n)\s*at\s+\S+/i,
  /\/(?:Users|private|var|tmp|Volumes|home)\/|\b[A-Z]:\\/i,
];

export function containsTechnicalDetails(message: string | null | undefined): boolean {
  return Boolean(message && TECHNICAL_DETAILS.some((pattern) => pattern.test(message)));
}

export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = stripTransportPrefix(raw).trim();
  return message && !containsTechnicalDetails(message) ? message : fallback;
}
